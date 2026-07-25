/**
 * Tier WP — worker profile tests (specs/test-agent-spec.md §Deterministic
 * runtime): the capability policy installed by installWorkerProfile. Process
 * and network are denied, cwd() is the virtual root and env() is undefined,
 * the filesystem is limited to controller-backed Markdown reads and honest
 * stats (.ts reads are rejected), globbing is denied, and eval blocks are
 * inline-only (static and dynamic imports rejected). These capabilities are
 * not reachable from behavior-document surface, so each is invoked directly
 * in a scope with the profile installed.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import type { Operation } from "effection";
import { compile, cwd, env, exec, fetch, glob, readTextFile, stat } from "@executablemd/runtime";
import { useDenoCompiler } from "@executablemd/core";
import { installWorkerProfile } from "../src/worker/profile.ts";
import type { WorkerFilesystem } from "../src/worker/profile.ts";

const files: Record<string, string> = { "Helper.md": "helper body\n" };
const fs: WorkerFilesystem = {
  *read(path) {
    return files[path];
  },
  *stat(path) {
    const exists = path in files;
    return { exists, isFile: exists, isDirectory: false };
  },
};

function* denied(op: () => Operation<unknown>): Operation<string> {
  try {
    yield* op();
    return "";
  } catch (error) {
    return String(error);
  }
}

describe("Tier WP — worker profile", () => {
  it("WP1: denies process and network access", function* () {
    yield* installWorkerProfile(fs);
    expect(yield* denied(() => exec({ command: ["echo", "hi"] }))).toContain(
      "process access is denied",
    );
    expect(yield* denied(() => fetch("https://example.test"))).toContain(
      "network access is denied",
    );
  });

  it("WP2: cwd is the virtual root and env is undefined", function* () {
    yield* installWorkerProfile(fs);
    expect(yield* cwd()).toBe("/");
    expect(yield* env("HOME")).toBe(undefined);
  });

  it("WP3: reads and stats are controller-backed", function* () {
    yield* installWorkerProfile(fs);
    expect(yield* readTextFile("Helper.md")).toBe("helper body\n");
    expect(yield* stat("Helper.md")).toEqual({
      exists: true,
      isFile: true,
      isDirectory: false,
    });
    expect(yield* stat("Missing.md")).toEqual({
      exists: false,
      isFile: false,
      isDirectory: false,
    });
    expect(yield* denied(() => readTextFile("Missing.md"))).toContain("ENOENT");
  });

  it("WP4: rejects TypeScript component reads", function* () {
    yield* installWorkerProfile(fs);
    expect(yield* denied(() => readTextFile("Widget.ts"))).toContain(
      "TypeScript components are not supported",
    );
  });

  it("WP5: denies filesystem globbing", function* () {
    yield* installWorkerProfile(fs);
    expect(yield* denied(() => glob({ patterns: ["*.md"], root: "/" }))).toContain(
      "globbing is denied",
    );
  });

  it("WP6: rejects static and dynamic imports but allows inline eval", function* () {
    // The profile is installed first so its Compiler.around wraps the base
    // compiler (production order), and a base compiler sits underneath so the
    // inline-eval passthrough reaches a real compiler, not the stub.
    yield* installWorkerProfile(fs);
    yield* useDenoCompiler();
    expect(yield* denied(() => compile("return 1;", { imports: ["m"] }))).toContain(
      "static imports are not allowed",
    );
    expect(yield* denied(() => compile("import('x');", { imports: [] }))).toContain(
      "dynamic import() is not allowed",
    );
    const factory = yield* compile("return 1;", { imports: [] });
    expect(typeof factory).toBe("function");
  });
});
