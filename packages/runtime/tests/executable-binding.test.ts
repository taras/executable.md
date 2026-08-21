/**
 * Tier EB — observing which executable build a command runs
 * (specs/native-agent-session-launch-spec.md §Durable binding).
 *
 * These use real files, because every property under test is a property of a
 * filesystem: what PATH resolves to, what a symlink points at, which bits are
 * set, what bytes are there. A stubbed filesystem would prove the stub.
 *
 * The digest is the load-bearing value — it is what a later attachment
 * compares — so the cases that matter are the ones where two observations
 * should agree and the ones where they must not.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { until } from "effection";
import type { Operation } from "effection";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { API } from "@executablemd/runtime";
import { ExecutableBinding, ExecutableObservationError } from "@executablemd/runtime";
import type { ExecutableRefusal, LiveExecutable } from "@executablemd/runtime";

/** Install a PATH and working directory without moving this process's own. */
function* underHost(directory: string, search: string): Operation<void> {
  yield* API.Env.around({
    *env([name], next) {
      return name === "PATH" ? search : yield* next(name);
    },
    *cwd() {
      return directory;
    },
  });
}

/**
 * Write an executable and return the path an observation should report.
 *
 * That is the canonical one: temporary roots on macOS live under a symlinked
 * `/var`, so the path a test builds and the path a filesystem calls it are
 * routinely different, and only the second is what gets observed.
 */
function* writeExecutable(at: string, contents: string): Operation<string> {
  yield* until(mkdir(path.dirname(at), { recursive: true }));
  yield* until(writeFile(at, contents));
  yield* until(chmod(at, 0o755));
  return yield* until(realpath(at));
}

function* observe(command: string): Operation<LiveExecutable> {
  return yield* ExecutableBinding.operations.observe(command);
}

/** The refusal reason, or `null` when the observation unexpectedly succeeded. */
function* refusalOf(command: string): Operation<ExecutableRefusal | null> {
  try {
    yield* observe(command);
    return null;
  } catch (error) {
    if (error instanceof ExecutableObservationError) {
      return error.refusal;
    }
    throw error;
  }
}

describe("Tier EB — executable observation", () => {
  it("EB1: observes the canonical path and the digest of its bytes", function* () {
    const root = yield* useTempDirectory("xmd-eb-");
    const bin = path.join(root, "bin");
    const target = yield* writeExecutable(path.join(bin, "claude"), "#!/bin/sh\necho 1.0.0\n");
    yield* underHost(root, bin);

    const observed = yield* observe("claude");

    expect(observed.path).toBe(target);
    expect(observed.digest).toEqual({
      algorithm: "sha256",
      value: createHash("sha256").update("#!/bin/sh\necho 1.0.0\n").digest("hex"),
    });
  });

  it("EB2: the same build reached two ways observes as one build", function* () {
    // The property that makes relocation survivable: a launcher shim and the
    // version it points at are one build, and must not read as two.
    const root = yield* useTempDirectory("xmd-eb-");
    const versions = path.join(root, "versions");
    const bin = path.join(root, "bin");
    const real = yield* writeExecutable(path.join(versions, "2.1.235"), "#!/bin/sh\nexit 0\n");
    yield* until(mkdir(bin, { recursive: true }));
    yield* until(symlink(real, path.join(bin, "claude")));
    yield* underHost(root, bin);

    const viaPath = yield* observe("claude");
    const viaExactPath = yield* observe(real);

    expect(viaPath).toEqual(viaExactPath);
  });

  it("EB3: a different build at the same path observes differently", function* () {
    // The failure this whole mechanism exists to catch, reduced to its core:
    // nothing about where a build lives distinguishes it from another one.
    const root = yield* useTempDirectory("xmd-eb-");
    const bin = path.join(root, "bin");
    const at = path.join(bin, "claude");
    yield* writeExecutable(at, "#!/bin/sh\necho 2.1.235\n");
    yield* underHost(root, bin);
    const before = yield* observe("claude");

    yield* writeExecutable(at, "#!/bin/sh\necho 2.1.232\n");
    const after = yield* observe("claude");

    expect(before.path).toBe(after.path);
    expect(after.digest.value).not.toBe(before.digest.value);
  });

  it("EB4: resolution uses the contextual PATH, not this process's", function* () {
    const root = yield* useTempDirectory("xmd-eb-");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    yield* writeExecutable(path.join(first, "claude"), "#!/bin/sh\necho first\n");
    const shadowed = yield* writeExecutable(
      path.join(second, "claude"),
      "#!/bin/sh\necho second\n",
    );

    yield* underHost(root, [second, first].join(path.delimiter));

    expect((yield* observe("claude")).path).toBe(shadowed);
  });

  it("EB5: a relative command resolves against the contextual directory", function* () {
    const root = yield* useTempDirectory("xmd-eb-");
    const target = yield* writeExecutable(path.join(root, "tools", "claude"), "#!/bin/sh\n");
    yield* underHost(root, path.join(root, "empty"));

    expect((yield* observe("./tools/claude")).path).toBe(target);
  });

  it("EB6: every refusal names why", function* () {
    const root = yield* useTempDirectory("xmd-eb-");
    const bin = path.join(root, "bin");
    yield* until(mkdir(path.join(bin, "directory"), { recursive: true }));
    const unreadable = path.join(bin, "unexecutable");
    yield* until(writeFile(unreadable, "#!/bin/sh\n"));
    yield* until(chmod(unreadable, 0o644));
    yield* underHost(root, bin);

    // Discriminated rather than collapsed, because "cannot use this
    // executable" and "this is the wrong executable" call for different
    // answers from whoever asked.
    expect([
      yield* refusalOf("absent"),
      yield* refusalOf("directory"),
      yield* refusalOf("unexecutable"),
      yield* refusalOf(""),
    ]).toEqual(["not-found", "not-a-file", "not-executable", "not-found"]);
  });

  it("EB7: a test can substitute an observation without a filesystem", function* () {
    // Provider tests bind a build without owning one; this is the seam they
    // use, and it has to be the same seam production goes through.
    const substitute: LiveExecutable = {
      path: "/nowhere/claude",
      digest: { algorithm: "sha256", value: "a".repeat(64) },
    };
    yield* ExecutableBinding.around({
      *observe() {
        return substitute;
      },
    });

    expect(yield* observe("claude")).toEqual(substitute);
  });
});
