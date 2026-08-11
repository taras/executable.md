/**
 * Runtime Context APIs — platform I/O operations with pluggable middleware.
 *
 * Five host-backed domain APIs plus the provider-neutral Service Api, built on
 * `@effectionx/context-api`.
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
 * ## Why separate APIs?
 *
 * - **Process** — subprocess lifecycle has its own cancellation semantics
 *   (killing processes on scope teardown). Middleware targets exec only.
 * - **Fs** — the low-level host file surface: reading, writing, and inspecting
 *   paths the engine itself resolves, for component lookup, replay guards, and
 *   the root document. It is the host adapter's own dependency, not the
 *   boundary a document's paths cross.
 * - **Files** — document filesystem access, in whole semantic operations
 *   (`files.ts`). `<File>`, `<Glob>`, and `<TempDir>` speak only this Api, so
 *   the same document means the same thing whether its paths resolve in the
 *   caller's filesystem or in a run-owned logical one. Its terminal handler
 *   throws: an uninstalled provider must not silently reach the host.
 * - **Fetch** — HTTP has distinct timeout/body/abort semantics. Merging
 *   with Fs or Process would blur cancellation boundaries.
 * - **Env** — the host itself: metadata (env vars, platform) plus the two
 *   capabilities only the entrypoint can supply, `command` (how to re-invoke
 *   this xmd) and `compile` (how this host loads a generated module). Tests
 *   use `.around()` to mock platform/env for deterministic replay; an
 *   entrypoint installs its `command` and `compile` with `{ at: "min" }` so
 *   ordinary middleware can wrap them.
 * - **Service** — scoped service attachment. Its terminal handler requires an
 *   explicit host provider and never detects or imports a runtime.
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
 * `useStubFs(files)`, `useEchoExec()`, `useFailingExec(code, stderr)`,
 * `useStubService(endpoint)`.
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
import { exec as processExec, Stdio } from "@effectionx/process";
import { race, scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { timeoutFetch as contextualFetchTimeout } from "./config.ts";
import { Files } from "./files.ts";
import { Service } from "./service.ts";

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

/**
 * Record every byte a child writes, from before it exists.
 *
 * The adapter starts forwarding during acquisition and publishes its retained
 * observations through Signals, which drop a send nobody is subscribed to. So
 * retention cannot begin by subscribing to the process it is given — by then
 * the first chunks are gone. It begins here instead, on the display chain the
 * adapter calls for every chunk, installed before the child is acquired.
 */
export function* retaining(): Operation<{ stdout: () => string; stderr: () => string }> {
  let stdout = "";
  let stderr = "";
  // One decoder per channel: a code point split across chunks belongs to the
  // channel that split it, and sharing decoder state would let one channel
  // corrupt the other's partial character.
  const fromStdout = new TextDecoder();
  const fromStderr = new TextDecoder();
  yield* Stdio.around({
    *stdout([bytes], next) {
      stdout += fromStdout.decode(bytes, { stream: true });
      return yield* next(bytes);
    },
    *stderr([bytes], next) {
      stderr += fromStderr.decode(bytes, { stream: true });
      return yield* next(bytes);
    },
  });
  // Flushed once, when the process is done.
  return {
    stdout: () => stdout + fromStdout.decode(),
    stderr: () => stderr + fromStderr.decode(),
  };
}

/**
 * Run one child to completion and report what the caller asked to keep.
 *
 * Forwarding and retention are separate paths through the same process: the
 * `Stdio` chain displays every chunk whatever this decides, and a transient run
 * subscribes to nothing, so a command that writes a gigabyte costs a gigabyte
 * of nothing.
 */
function* run(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  retain: boolean;
}): Operation<ProcessOutcome> {
  return yield* scoped(function* () {
    // Before acquisition, so a chunk written while the child is being started
    // is retained rather than raced for.
    const kept = options.retain ? yield* retaining() : undefined;

    const child = yield* processExec(options.command, {
      arguments: options.args,
      cwd: options.cwd,
      env: options.env,
    });
    const status = yield* child.join();

    return {
      exitCode: status.code ?? 1,
      stdout: kept?.stdout(),
      stderr: kept?.stderr(),
    };
  });
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

/**
 * What a finished child process reports.
 *
 * `stdout` and `stderr` are the text a caller asked to be retained. A caller
 * that asked for none gets `undefined` rather than an empty string: nothing was
 * accumulated, and "no output" and "not retained" are different answers.
 */
export interface ProcessOutcome {
  exitCode: number;
  stdout: string | undefined;
  stderr: string | undefined;
}

export interface ProcessExecOptions {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /**
   * Retain the child's output in the outcome. Default `true`.
   *
   * Retention is the caller's explicit choice, never an inference: a run that
   * keeps no diagnostic record asks for `false` and the text is forwarded to
   * whatever is displaying it without ever being accumulated here.
   */
  retain?: boolean;
}

interface ProcessHandler {
  exec(options: ProcessExecOptions): Operation<ProcessOutcome>;
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
  Files: typeof Files;
  Fetch: Api<FetchHandler>;
  Env: Api<EnvHandler>;
  Service: typeof Service;
} = {
  /**
   * Subprocess execution.
   *
   * Default implementation uses `@effectionx/process`.
   * Cancellation kills the process via Effection scope teardown.
   */
  Process: createApi("runtime.process", {
    *exec(options: ProcessExecOptions): Operation<ProcessOutcome> {
      const { command, cwd, env, timeout, retain = true } = options;
      const [cmd, ...args] = command;

      if (!cmd) {
        throw new Error("exec: command array must not be empty");
      }

      // No contextual fallback: what bounds an exec block is resolved where the
      // block is, and arrives here as this option (spec §Config).
      return yield* withTimeout(
        `exec(${cmd})`,
        timeout,
        run({ command: cmd, args, cwd, env, retain }),
      );
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
      const timeout = init?.timeout ?? (yield* contextualFetchTimeout);
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
  Files,
  Service,
};

/**
 * Run a child process.
 *
 * A caller that says nothing about retention keeps the output, which is what
 * every caller with something to read wants and what callers have always had.
 * Asking for `retain: false` keeps the exit status alone, and the overloads say
 * so: there is no string to read on that path, and the type refuses to pretend
 * otherwise. Core, which decides retention per block, calls the Api operation
 * directly and handles both.
 */
export function exec(
  options: ProcessExecOptions & { retain: false },
): Operation<{ exitCode: number; stdout: undefined; stderr: undefined }>;
export function exec(
  options: ProcessExecOptions & { retain?: true },
): Operation<{ exitCode: number; stdout: string; stderr: string }>;
export function exec(options: ProcessExecOptions): Operation<ProcessOutcome> {
  return API.Process.operations.exec(options);
}

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

/**
 * Discard the standard output of subprocesses started in this scope.
 *
 * For a caller whose subprocess output is an *answer* rather than something to
 * show: a command whose stdout is parsed and returned would otherwise also
 * print itself into whatever the process was rendering. `stderr` is left alone,
 * because that is where a failing command explains itself and a diagnostic is
 * worth seeing.
 *
 * It lives here because reaching the process Api's stdio directly is host
 * behavior, and modules held to the runtime-neutral boundary may not import a
 * host process module of their own.
 */
export function useQuietProcessOutput(): Operation<void> {
  return Stdio.around({ *stdout() {} });
}
