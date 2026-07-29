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
import { relative, sep } from "node:path";
import process from "node:process";
import { realpath as fsRealpath, rename as fsRename } from "node:fs/promises";
import { fetch as effectionFetch } from "@effectionx/fetch";
import {
  ensureDir as fsEnsureDir,
  globToRegExp,
  readTextFile as fsReadTextFile,
  rm as fsRm,
  stat as fsStat,
  walk,
  writeTextFile as fsWriteTextFile,
} from "@effectionx/fs";
import { exec as processExec } from "@effectionx/process";
import { each, race, sleep, until } from "effection";
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

interface FsHandler {
  readTextFile(path: string): Operation<string>;
  stat(path: string): Operation<StatResult>;
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
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
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
      const results: Array<{ path: string; isFile: boolean }> = [];

      // Convert include/exclude patterns to RegExp for matching
      // against relative paths from root
      const includeRegexes = patterns.map((p) =>
        globToRegExp(p, { extended: true, globstar: true }),
      );
      const excludeRegexes = exclude.map((e) =>
        globToRegExp(e, { extended: true, globstar: true }),
      );

      // Walk the directory tree and match relative paths
      const stream = walk(root, {
        includeFiles: true,
        includeDirs: false,
        skip: excludeRegexes.length > 0 ? excludeRegexes : undefined,
      });

      for (const entry of yield* each(stream)) {
        // Normalize to POSIX separators for consistent matching across platforms
        const relPath = relative(root, entry.path).split(sep).join("/");
        const matches = includeRegexes.some((re) => re.test(relPath));
        if (matches) {
          results.push({ path: relPath, isFile: entry.isFile });
        }
        yield* each.next();
      }

      return results;
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
        const code = (err as NodeJS.ErrnoException).code;
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
