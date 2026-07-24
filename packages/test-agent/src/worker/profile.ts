/**
 * Deterministic worker profile (specs/test-agent-spec.md §Deterministic
 * runtime): a capability policy, not a security sandbox. Process and
 * Fetch are denied, env() is undefined, cwd() is the virtual scenario
 * root, and the filesystem is limited to controller-backed reads and
 * stats. Reading a .ts component candidate raises the explicit
 * unsupported-TypeScript error before it could ever be materialized or
 * imported; stats stay honest so an earlier Name.md wins and a missing
 * Name.ts falls through to Name/index.md. Eval blocks are inline-only:
 * core strips static imports into options.imports before compiling, so
 * a non-empty list is rejected, and the transformed source is parsed
 * with acorn to reject dynamic import expressions before compilation.
 */

import type { Operation } from "effection";
import { parse } from "acorn";
import { API } from "@executablemd/runtime";
import type { StatResult } from "@executablemd/runtime";

export interface WorkerFilesystem {
  read(path: string): Operation<string | undefined>;
  stat(path: string): Operation<StatResult>;
}

function hasDynamicImport(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasDynamicImport);
  }
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "ImportExpression") {
    return true;
  }
  return Object.values(record).some(
    (value) => typeof value === "object" && value !== null && hasDynamicImport(value),
  );
}

export function* installWorkerProfile(filesystem: WorkerFilesystem): Operation<void> {
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec() {
      throw new Error("process access is denied in behavior documents");
    },
  });
  yield* API.Fetch.around({
    // deno-lint-ignore require-yield
    *fetch() {
      throw new Error("network access is denied in behavior documents");
    },
  });
  yield* API.Env.around({
    // deno-lint-ignore require-yield
    *cwd() {
      return "/";
    },
    // deno-lint-ignore require-yield
    *env() {
      return undefined;
    },
  });
  yield* API.Fs.around({
    *readTextFile([path]) {
      if (path.endsWith(".ts")) {
        throw new Error(`TypeScript components are not supported in behavior documents: ${path}`);
      }
      const source = yield* filesystem.read(path);
      if (source === undefined) {
        throw new Error(`ENOENT: no such file in the scenario filesystem: ${path}`);
      }
      return source;
    },
    *stat([path]) {
      return yield* filesystem.stat(path);
    },
    // deno-lint-ignore require-yield
    *glob() {
      throw new Error("filesystem globbing is denied in behavior documents");
    },
  });
  yield* API.Compiler.around({
    *compile([source, options], next) {
      const imports = options?.imports ?? [];
      if (imports.length > 0) {
        throw new Error(
          "eval blocks in behavior documents are inline-only — static imports are not allowed",
        );
      }
      const program = parse(`function* __evalBlock__() {${source}\n}`, {
        ecmaVersion: "latest",
        sourceType: "script",
      });
      if (hasDynamicImport(program.body)) {
        throw new Error(
          "eval blocks in behavior documents are inline-only — dynamic import() is not allowed",
        );
      }
      return yield* next(source, options);
    },
  });
}
