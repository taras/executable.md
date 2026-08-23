/**
 * Tier EO — observing which build a command actually runs
 * (specs/native-agent-session-launch-spec.md §Executable binding).
 *
 * Real files and a real child, because every question here is about the host:
 * which file a name resolves to, whether a symlink and its target are one
 * build, what the bytes hash to, and what that exact path says when asked.
 *
 * The redaction cases matter as much as the observation ones. The canonical
 * path is live capability — it is spawned, and it reaches the matching ACP
 * child — and it must not be recoverable from anything this module hands to a
 * caller that will retain it.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, realpath, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { until } from "effection";
import {
  createDenoExecutableObserver,
  ExecutableObservationError,
  hasDenoExecutableObserver,
} from "@executablemd/runtime";
import type { ExecutableRefusal } from "@executablemd/runtime";

/** A directory this test owns, removed however the test ends. */
function* workspace(): Operation<string> {
  const root = path.join(os.tmpdir(), `xmd-eo-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * The path the host will canonicalize to.
 *
 * On macOS the temporary root reaches `/private/var` through a symlink, so a
 * test that compared the path it wrote against the path that was observed
 * would be asserting the absence of the canonicalization this module exists to
 * perform.
 */
function* canonical(target: string): Operation<string> {
  return yield* until(realpath(target));
}

/** A real executable that prints `version` and exits 0. */
function* script(root: string, name: string, version: string): Operation<string> {
  const file = path.join(root, name);
  yield* writeTextFile(file, `#!/bin/sh\necho "${version}"\n`);
  yield* until(chmod(file, 0o755));
  return file;
}

function* refusalOf(op: () => Operation<unknown>): Operation<ExecutableRefusal | "none"> {
  try {
    yield* op();
    return "none";
  } catch (error) {
    return error instanceof ExecutableObservationError ? error.refusal : "none";
  }
}

describe("Tier EO — executable observation", () => {
  it("EO1: only a host with the process surface builds an observer", function* () {
    const onDeno = typeof Reflect.get(globalThis, "Deno") === "object";
    expect(hasDenoExecutableObserver()).toBe(onDeno);
    expect(createDenoExecutableObserver() === undefined).toBe(!onDeno);
  });

  it("EO2: the digest is over the file's bytes, and the version comes from that same file", function* () {
    const root = yield* workspace();
    const file = yield* script(root, "claude", "2.1.235 (Claude Code)");
    const observer = createDenoExecutableObserver()!;

    const observed = yield* observer.observe(file);

    const bytes = `#!/bin/sh\necho "2.1.235 (Claude Code)"\n`;
    expect(observed.digest).toEqual({
      algorithm: "sha256",
      value: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(observed.versionOutput.trim()).toBe("2.1.235 (Claude Code)");
    expect(observed.path).toBe(yield* canonical(file));
  });

  it("EO3: a symlink and its target are one build", function* () {
    // The same build reached two ways has to produce one digest, or a launcher
    // shim would look like a different Claude every time it moved.
    const root = yield* workspace();
    const real = yield* script(root, "claude-real", "2.1.235");
    const shim = path.join(root, "claude-shim");
    yield* until(symlink(real, shim));
    const observer = createDenoExecutableObserver()!;

    const direct = yield* observer.observe(real);
    const viaShim = yield* observer.observe(shim);

    expect(viaShim.digest).toEqual(direct.digest);
    // Canonical, so both name the file that actually ran.
    expect(viaShim.path).toBe(direct.path);
  });

  it("EO4: two builds at one path are two observations", function* () {
    // The drift this whole mechanism exists for: the path is unchanged and the
    // build is not.
    const root = yield* workspace();
    const file = yield* script(root, "claude", "2.1.235");
    const observer = createDenoExecutableObserver()!;
    const before = yield* observer.observe(file);

    yield* script(root, "claude", "2.2.0");
    const after = yield* observer.observe(file);

    expect(after.path).toBe(before.path);
    expect(after.digest.value).not.toBe(before.digest.value);
    expect(after.versionOutput.trim()).toBe("2.2.0");
  });

  it("EO5: PATH search finds a bare name, from the observer's own environment", function* () {
    const root = yield* workspace();
    const bin = path.join(root, "bin");
    yield* ensureDir(bin);
    const file = yield* script(bin, "claude", "2.1.235");
    // Supplied to this observer, not exported into the process: nothing else
    // running here has its PATH moved.
    const observer = createDenoExecutableObserver({ path: bin })!;

    const observed = yield* observer.observe("claude");

    expect(observed.path).toBe(yield* canonical(file));
  });

  it("EO6: every way an observation can fail names its reason", function* () {
    const root = yield* workspace();
    const observer = createDenoExecutableObserver({ path: root })!;

    const directory = path.join(root, "adir");
    yield* ensureDir(directory);
    const unreadable = path.join(root, "plain");
    yield* writeTextFile(unreadable, "not a program\n");
    const broken = path.join(root, "broken");
    yield* writeTextFile(broken, "#!/bin/sh\nexit 3\n");
    yield* until(chmod(broken, 0o755));

    expect(yield* refusalOf(() => observer.observe(""))).toBe("not-found");
    expect(yield* refusalOf(() => observer.observe("absent-command"))).toBe("not-found");
    expect(yield* refusalOf(() => observer.observe(directory))).toBe("not-a-file");
    expect(yield* refusalOf(() => observer.observe(unreadable))).toBe("not-executable");
    // Present, executable, and unwilling to say what it is: a build that
    // cannot be identified is not one a session may be bound to.
    expect(yield* refusalOf(() => observer.observe(broken))).toBe("version-unavailable");
  });

  it("EO7: a refusal carries no path, and an observation retains none", function* () {
    // The canonical path is live capability. What a caller keeps is the digest
    // and the version; the path is spawned and forgotten.
    const root = yield* workspace();
    const secret = path.join(root, "secret-layout");
    yield* ensureDir(secret);
    const observer = createDenoExecutableObserver({ path: secret })!;

    let message = "";
    try {
      yield* observer.observe("absent-command");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("absent-command");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(root);

    // And the durable half of an observation is exactly two facts.
    const file = yield* script(secret, "claude", "2.1.235");
    const observed = yield* observer.observe(file);
    const retained = {
      schema: "executable-build.v1",
      reportedVersion: observed.versionOutput.trim(),
      executableDigest: observed.digest,
    };
    expect(JSON.stringify(retained)).not.toContain(root);
    expect(Object.keys(observed).sort()).toEqual(["digest", "path", "versionOutput"]);
  });
});
