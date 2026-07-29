/**
 * Runtime Context APIs — platform I/O operations with pluggable middleware.
 *
 * Five domain-specific context APIs built on `@effectionx/context-api`.
 * Each API provides default Node.js implementations. Use `.around()` to
 * install middleware (mocking, instrumentation, sandboxing) scoped to the
 * current Effection scope.
 *
 * ## Architecture
 *
 * Import operation functions for normal calls, and use `API` only when
 * installing middleware with `.around()`:
 *
 * ```typescript
 * import { readTextFile, stat, API } from "@executablemd/runtime";
 *
 * // normal calls
 * const file = yield* readTextFile("doc.md");
 *
 * // middleware
 * yield* API.Fs.around({
 *   *readTextFile([path], next) {
 *     return yield* next(path);
 *   },
 * });
 * ```
 *
 * ## Why four separate APIs?
 *
 * - **Process** — subprocess lifecycle has its own cancellation semantics
 *   (killing processes on scope teardown). Middleware targets exec only.
 * - **Fs** — reading, writing, and inspecting files form a cohesive file-IO
 *   surface used together for component resolution, replay guards, and the
 *   `<File>` component. Middleware installed here sees a document's own file
 *   access on the same terms as the engine's.
 * - **Fetch** — HTTP has distinct timeout/body/abort semantics. Merging
 *   with Fs or Process would blur cancellation boundaries.
 * - **Env** — the host itself: metadata (env vars, platform) plus the two
 *   capabilities only the entrypoint can supply, `command` (how to re-invoke
 *   this xmd) and `compile` (how this host loads a generated module). Tests
 *   use `.around()` to mock platform/env for deterministic replay; an
 *   entrypoint installs its `command` and `compile` with `{ at: "min" }` so
 *   ordinary middleware can wrap them.
 *
 * ## Middleware
 *
 * ```typescript
 * yield* API.Fs.around({
 *   *readTextFile([path], next) {
 *     return "mocked content";
 *   },
 * });
 * ```
 *
 * Middleware is **scoped** — it only affects operations within the
 * current Effection scope and its children. Install before calling
 * `execute()` or `durableRun()`.
 *
 * ## Test stubs
 *
 * Common stubs are provided by `@executablemd/runtime/test`:
 * `useStubFs(files)`, `useEchoExec()`, `useFailingExec(code, stderr)`.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { join } from "node:path";
import process from "node:process";
import { realpath as fsRealpath, rename as fsRename } from "node:fs/promises";
import { fetch as effectionFetch } from "@effectionx/fetch";
import {
  ensureDir as fsEnsureDir,
  FsApi,
  globToRegExp,
  readTextFile as fsReadTextFile,
  rm as fsRm,
  stat as fsStat,
  writeTextFile as fsWriteTextFile,
} from "@effectionx/fs";
import { exec as processExec } from "@effectionx/process";
import { race, sleep, until } from "effection";
import type { Operation } from "effection";
import { timeout as contextualTimeout } from "./config.ts";

/**
 * Result of a `stat` call.
 *
 * For missing paths `stat` returns `{ exists: false, isFile: false, isDirectory: false }`
 * instead of throwing — "does this exist?" has "no" as a valid answer.
 */
export interface StatResult {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Minimal response headers interface.
 *
 * Uses a minimal interface instead of the global `Headers` type to avoid
 * requiring DOM lib types in tsconfig.
 */
export interface ResponseHeaders {
  get(key: string): string | null;
}

/**
 * Response shape returned by the fetch context API.
 *
 * Both the response object and `text()` are Operation-native — no Promises
 * cross the interface boundary.
 */
export interface RuntimeFetchResponse {
  status: number;
  headers: ResponseHeaders;
  /** Read the response body as text. */
  text(): Operation<string>;
}

/**
 * The `errno` string a failed filesystem call carries, when it carries one.
 *
 * Read rather than asserted: `catch` gives back `unknown`, and what arrives
 * there is only conventionally an `ErrnoException`. Narrowing says what is
 * actually known about the value instead of claiming a shape it may not have.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

function* withTimeout<T>(
  label: string,
  timeout: number | undefined,
  operation: Operation<T>,
): Operation<T> {
  if (timeout === undefined) {
    return yield* operation;
  }

  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error(`${label}: timeout must be a non-negative finite number`);
  }

  return (yield* race([
    operation,
    (function* (): Operation<T> {
      yield* sleep(timeout);
      throw new Error(`${label} timed out after ${timeout}ms`);
    })(),
  ])) as T;
}

interface ProcessHandler {
  exec(options: {
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }): Operation<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * A glob pattern as a matcher for relative POSIX paths.
 *
 * A pattern that cannot be compiled throws here — an unterminated character
 * class is a `SyntaxError` from `RegExp` — so it surfaces from `glob` itself
 * rather than silently matching nothing.
 */
function toRegExp(pattern: string): RegExp {
  return globToRegExp(pattern, { extended: true, globstar: true });
}

/**
 * A matcher for directories whose entire subtree an exclusion covers, when the
 * pattern is one that can prove it.
 *
 * Skipping a subtree is only sound if *every* path beneath it is excluded, and
 * matching the directory tells us nothing of the sort: `foo` does not match
 * `foo/deep/keep.md`, and `foo/*` matches `foo/direct.md` but stops at the next
 * separator. Testing the directory — or the directory with a trailing separator
 * — as a proxy for "all descendants" prunes more than the pattern selects.
 *
 * A trailing `/**` is the form that does prove it. It compiles to
 * `(?:[^/]*(?:/|$))*`, which matches any sequence of segments, so once the part
 * before it matches a directory the pattern matches every path under that
 * directory at any depth. `**` alone covers the whole tree the same way.
 *
 * Anything else returns `undefined` and the subtree is walked, with its files
 * filtered one at a time. That is the conservative direction: descending a
 * subtree whose files are all excluded costs reads, while skipping one that
 * holds a match loses the match.
 */
const SUBTREE = "/**";

function isRegExp(value: RegExp | undefined): value is RegExp {
  return value !== undefined;
}

function pruneMatcher(pattern: string): RegExp | undefined {
  if (pattern === "**") {
    return toRegExp("**");
  }
  if (!pattern.endsWith(SUBTREE)) {
    return undefined;
  }
  return toRegExp(pattern.slice(0, -SUBTREE.length));
}

interface Traversal {
  include: RegExp[];
  exclude: RegExp[];
  /** Directories whose whole subtree an exclusion provably covers. */
  prune: RegExp[];
  matched: Array<{ path: string; isFile: boolean }>;
}

/**
 * Collect matches under `directory`, whose path relative to the glob root is
 * `prefix`.
 *
 * A plain recursive generator rather than `@effectionx/fs`'s `walk()`, whose
 * producer runs in a spawned task: a `readdir` that fails there tears down the
 * surrounding scope instead of throwing at the call site, so no caller can
 * report it. Recursing here makes a failure `glob`'s own, and makes every
 * directory read a cancellation point.
 *
 * Paths are assembled from entry names with `/`, so what patterns match is the
 * relative POSIX path on every platform.
 *
 * Exclusion is decided per **candidate**: a file or symlink whose own path an
 * exclude pattern matches is not reported, which is what makes exclusions win.
 * A directory is not a candidate — it is never reported — so its own path is
 * not tested against exclusions at all. The only question a directory raises is
 * whether walking it can still produce something, and that is `pruneMatcher`'s.
 */
function* descend(directory: string, prefix: string, walk: Traversal): Operation<void> {
  for (const entry of yield* FsApi.operations.readdirDirents(directory)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    // Before the exclusion test, because a directory is not a candidate: an
    // exclusion matching its path says nothing about the files beneath it.
    // A symlink to a directory takes the branches below instead — `isDirectory`
    // is false for one — so traversal never follows it.
    if (entry.isDirectory()) {
      if (!walk.prune.some((re) => re.test(path))) {
        yield* descend(join(directory, entry.name), path, walk);
      }
      continue;
    }

    if (walk.exclude.some((re) => re.test(path))) {
      continue;
    }

    // A symlink is reported by its own path and never followed, so traversal
    // stays under the root and cannot cycle.
    if (entry.isSymbolicLink()) {
      if (walk.include.some((re) => re.test(path))) {
        walk.matched.push({ path, isFile: false });
      }
      continue;
    }

    if (entry.isFile() && walk.include.some((re) => re.test(path))) {
      walk.matched.push({ path, isFile: true });
    }
  }
}

interface FsHandler {
  readTextFile(path: string): Operation<string>;
  stat(path: string): Operation<StatResult>;
  /**
   * Files and symbolic links beneath `root` whose path relative to it matches
   * `patterns` and matches none of `exclude`. Paths come back relative and
   * POSIX-separated, which is what both pattern lists are matched against, so a
   * caller's patterns mean the same thing on every platform.
   *
   * Exclusion is per candidate: an entry is dropped when its own relative path
   * matches. Directories are not candidates and are not reported, so an
   * exclusion matching a directory does not remove what is beneath it — only a
   * pattern ending in `/**`, which provably covers every descendant, lets the
   * subtree be skipped rather than walked and filtered.
   *
   * Symbolic links are reported but never followed: a link's own path can
   * match, and a link to a directory is not descended into. Traversal
   * therefore stays inside `root` and cannot cycle.
   */
  glob(options: {
    patterns: string[];
    root: string;
    exclude?: string[];
  }): Operation<Array<{ path: string; isFile: boolean }>>;
  writeTextFile(path: string, content: string): Operation<void>;
  ensureDir(path: string): Operation<void>;
  rename(from: string, to: string): Operation<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Operation<void>;
  /**
   * The canonical path, with every symlink resolved, or `undefined` when the
   * path does not exist. Like `stat`, "it isn't there" is an answer rather
   * than a failure — a caller resolving a path it is about to create asks
   * about ancestors that may legitimately be missing.
   */
  realpath(path: string): Operation<string | undefined>;
}

interface FetchHandler {
  fetch(
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeout?: number;
    },
  ): Operation<RuntimeFetchResponse>;
}

/**
 * A compiled eval block accepts the document binding environment and returns
 * an Operation. Current compilers implement it with generated `function*`
 * modules, but callers do not depend on that representation.
 */
export type EvalBlock = (env: Record<string, unknown>) => Operation<unknown>;

interface EnvHandler {
  cwd(): Operation<string>;
  env(name: string): Operation<string | undefined>;
  platform(): Operation<{ os: string; arch: string }>;
  command(args?: string[]): Operation<string[]>;
  compile(source: string, options?: { imports: string[] }): Operation<EvalBlock>;
}

export const API: {
  Process: Api<ProcessHandler>;
  Fs: Api<FsHandler>;
  Fetch: Api<FetchHandler>;
  Env: Api<EnvHandler>;
} = {
  /**
   * Subprocess execution.
   *
   * Default implementation uses `@effectionx/process`.
   * Cancellation kills the process via Effection scope teardown.
   */
  Process: createApi("runtime.process", {
    *exec(options: {
      command: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    }): Operation<{ exitCode: number; stdout: string; stderr: string }> {
      const { command, cwd, env, timeout } = options;
      const [cmd, ...args] = command;

      if (!cmd) {
        throw new Error("exec: command array must not be empty");
      }

      const effectiveTimeout = timeout ?? (yield* contextualTimeout);
      const result = yield* withTimeout(
        `exec(${cmd})`,
        effectiveTimeout,
        processExec(cmd, {
          arguments: args,
          cwd,
          env,
        }).join(),
      );

      return {
        exitCode: result.code ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  }),

  /**
   * Filesystem operations.
   *
   * Default implementation uses `@effectionx/fs`.
   */
  Fs: createApi("runtime.fs", {
    *readTextFile(path: string): Operation<string> {
      return yield* fsReadTextFile(path);
    },

    *stat(path: string): Operation<StatResult> {
      try {
        const s = yield* fsStat(path);
        return {
          exists: true,
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
        };
      } catch (err: unknown) {
        if (errorCode(err) === "ENOENT") {
          return { exists: false, isFile: false, isDirectory: false };
        }
        throw err;
      }
    },

    *glob(options: {
      patterns: string[];
      root: string;
      exclude?: string[];
    }): Operation<Array<{ path: string; isFile: boolean }>> {
      const { patterns, root, exclude = [] } = options;

      const matched: Array<{ path: string; isFile: boolean }> = [];
      yield* descend(root, "", {
        include: patterns.map(toRegExp),
        exclude: exclude.map(toRegExp),
        prune: exclude.map(pruneMatcher).filter(isRegExp),
        matched,
      });
      return matched;
    },

    *writeTextFile(path: string, content: string): Operation<void> {
      yield* fsWriteTextFile(path, content);
    },

    *ensureDir(path: string): Operation<void> {
      yield* fsEnsureDir(path);
    },

    *rename(from: string, to: string): Operation<void> {
      yield* until(fsRename(from, to));
    },

    *remove(path: string, options?: { recursive?: boolean; force?: boolean }): Operation<void> {
      yield* fsRm(path, options);
    },

    *realpath(path: string): Operation<string | undefined> {
      try {
        return yield* until(fsRealpath(path));
      } catch (err: unknown) {
        const code = errorCode(err);
        if (code === "ENOENT" || code === "ENOTDIR") {
          return undefined;
        }
        throw err;
      }
    },
  }),

  /**
   * HTTP requests.
   *
   * Default implementation uses `@effectionx/fetch`.
   * Cancellation aborts the request via Effection scope teardown.
   */
  Fetch: createApi("runtime.fetch", {
    *fetch(
      input: string,
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeout?: number;
      },
    ): Operation<RuntimeFetchResponse> {
      const timeout = init?.timeout ?? (yield* contextualTimeout);
      const response = yield* withTimeout(
        `fetch(${input})`,
        timeout,
        effectionFetch(input, {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        }),
      );

      return {
        status: response.status,
        headers: response.headers,
        *text() {
          return yield* withTimeout(`fetch(${input}).text()`, timeout, response.text());
        },
      } as RuntimeFetchResponse;
    },
  }),

  /**
   * Environment variables and platform information.
   *
   * These are synchronous lookups wrapped as Operations to satisfy
   * context-api handler constraints.
   */
  Env: createApi("runtime.env", {
    // deno-lint-ignore require-yield
    *cwd(): Operation<string> {
      return process.cwd();
    },

    // deno-lint-ignore require-yield
    *env(name: string): Operation<string | undefined> {
      return process.env[name];
    },

    // deno-lint-ignore require-yield
    *platform(): Operation<{ os: string; arch: string }> {
      return {
        os: process.platform,
        arch: process.arch,
      };
    },

    /**
     * The default cannot be derived. `process.execPath` names the executable
     * but not how it was launched — `deno run --allow-all <entry>` and
     * `node <entry>` are not recoverable from "deno" or "node", and a
     * compiled binary takes no entry script at all. Only the entrypoint that
     * started this process knows.
     */
    // deno-lint-ignore require-yield
    *command(_args?: string[]): Operation<string[]> {
      throw new Error(
        "xmd command not installed — a runtime-named entrypoint must install it via API.Env.around()",
      );
    },

    /**
     * Compiling an eval block means loading a module the way this host
     * loads modules, so the implementation belongs with the entrypoint that
     * knows the host — beside `command`, installed in the same call.
     */
    // deno-lint-ignore require-yield
    *compile(_source: string, _options?: { imports: string[] }): Operation<EvalBlock> {
      throw new Error(
        "compiler not installed — install platform-specific middleware via API.Env.around()",
      );
    },
  }),
};

export const exec: typeof API.Process.operations.exec = API.Process.operations.exec;

export const readTextFile: typeof API.Fs.operations.readTextFile = API.Fs.operations.readTextFile;

export const stat: typeof API.Fs.operations.stat = API.Fs.operations.stat;

export const glob: typeof API.Fs.operations.glob = API.Fs.operations.glob;

export const writeTextFile: typeof API.Fs.operations.writeTextFile =
  API.Fs.operations.writeTextFile;

export const ensureDir: typeof API.Fs.operations.ensureDir = API.Fs.operations.ensureDir;

export const rename: typeof API.Fs.operations.rename = API.Fs.operations.rename;

export const remove: typeof API.Fs.operations.remove = API.Fs.operations.remove;

export const realpath: typeof API.Fs.operations.realpath = API.Fs.operations.realpath;

export const fetch: typeof API.Fetch.operations.fetch = API.Fetch.operations.fetch;

export const env: typeof API.Env.operations.env = API.Env.operations.env;

export const cwd: typeof API.Env.operations.cwd = API.Env.operations.cwd;

export const platform: typeof API.Env.operations.platform = API.Env.operations.platform;

export const command: typeof API.Env.operations.command = API.Env.operations.command;

export const compile: typeof API.Env.operations.compile = API.Env.operations.compile;
