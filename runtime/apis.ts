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
 * - **Fs** — readTextFile, stat, and glob form a cohesive file-IO surface
 *   used together for component resolution and replay guards.
 * - **Fetch** — HTTP has distinct timeout/body/abort semantics. Merging
 *   with Fs or Process would blur cancellation boundaries.
 * - **Env** — synchronous host metadata (env vars, platform). Kept as a
 *   context-api despite being sync because tests use `.around()` to mock
 *   platform/env for deterministic replay testing.
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
import { fetch as effectionFetch } from "@effectionx/fetch";
import { readTextFile as fsReadTextFile, stat as fsStat, globToRegExp, walk } from "@effectionx/fs";
import { exec as processExec } from "@effectionx/process";
import { each, race, sleep } from "effection";
import type { Operation } from "effection";

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

interface EnvHandler {
  cwd(): Operation<string>;
  env(name: string): Operation<string | undefined>;
  platform(): Operation<{ os: string; arch: string }>;
}

interface CompilerHandler {
  compile(
    source: string,
    options?: { imports: string[] },
  ): Operation<(env: Record<string, unknown>) => Generator<unknown, unknown, unknown>>;
}

export const API: {
  Process: Api<ProcessHandler>;
  Fs: Api<FsHandler>;
  Fetch: Api<FetchHandler>;
  Env: Api<EnvHandler>;
  Compiler: Api<CompilerHandler>;
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

      const result = yield* withTimeout(
        `exec(${cmd})`,
        timeout,
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
      const timeout = init?.timeout;
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
  }),

  /**
   * Block compilation.
   *
   * Default handler throws — platform-specific middleware must be
   * installed via `yield* API.Compiler.around(...)` before use.
   * See `core/src/deno-compiler.ts` for the Deno implementation.
   */
  Compiler: createApi("runtime.compiler", {
    // deno-lint-ignore require-yield
    *compile(
      _source: string,
      _options?: { imports: string[] },
    ): Operation<(env: Record<string, unknown>) => Generator<unknown, unknown, unknown>> {
      throw new Error(
        "compiler not installed — install platform-specific middleware via API.Compiler.around()",
      );
    },
  }),
};

export const exec: typeof API.Process.operations.exec = API.Process.operations.exec;

export const readTextFile: typeof API.Fs.operations.readTextFile = API.Fs.operations.readTextFile;

export const stat: typeof API.Fs.operations.stat = API.Fs.operations.stat;

export const glob: typeof API.Fs.operations.glob = API.Fs.operations.glob;

export const fetch: typeof API.Fetch.operations.fetch = API.Fetch.operations.fetch;

export const env: typeof API.Env.operations.env = API.Env.operations.env;

export const cwd: typeof API.Env.operations.cwd = API.Env.operations.cwd;

export const platform: typeof API.Env.operations.platform = API.Env.operations.platform;

export const compile: typeof API.Compiler.operations.compile = API.Compiler.operations.compile;
