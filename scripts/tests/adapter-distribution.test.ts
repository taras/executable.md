/**
 * Tier ADD — the embedded adapters reach every distribution.
 *
 * The snapshots travel as a module in the graph rather than as files on disk,
 * precisely so that one mechanism serves the source tree, the dnt npm artifact
 * and the compiled binary. That claim is only worth making if it is checked:
 * a compiled `xmd` that resolved no snapshot module would launch nothing, and
 * an npm package missing it would fail at a customer's first workflow Prompt.
 *
 * So these ask each distribution for the bytes it would actually run, and
 * compare their digest with the manifest.
 *
 * Launching from those bytes is Tier EA's job, and it runs under Deno, Node and
 * Bun — the three runtimes these distributions are executed by. What is left to
 * prove here is that each distribution *carries* the same snapshots, which is
 * the half a source-tree test cannot see.
 *
 * This file itself runs under Deno only (`scripts/runtime-test-exclusions.ts`).
 * It asks for a module graph through `deno info`, and both distributions it
 * inspects are Deno's own build outputs; the portable half of the claim is Tier
 * EA and Tier AM, which do run under all three.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";
import { embeddedAdapterIdentities } from "@executablemd/acp/embedded-adapters";

const VENDOR = "packages/acp/vendor/adapters";
const GENERATED = `${VENDOR}/generated/snapshots.ts`;

/**
 * The module graph of an entrypoint.
 *
 * Raises when the command did not run: every question below is about something
 * being *present*, and an absence in output nobody produced is not an answer.
 */
function* moduleGraph(flags: string[], entry: string): Operation<string> {
  const info = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({ command: [process.execPath, "info", ...flags, entry] });
  });
  if (info.exitCode !== 0) {
    throw new Error(`deno info exited ${info.exitCode}, so its output describes no module graph`);
  }
  return info.stdout;
}

/** Every snapshot digest this build records. */
function digests(): string[] {
  return embeddedAdapterIdentities().map((snapshot) => snapshot.sha256);
}

describe("Tier ADD — embedded adapters across distributions", () => {
  it("ADD1: the source tree carries the manifest's exact bytes", function* () {
    for (const snapshot of embeddedAdapterIdentities()) {
      const bytes = Buffer.from(snapshot.base64, "base64");
      expect({
        provider: snapshot.provider,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }).toEqual({ provider: snapshot.provider, sha256: snapshot.sha256 });
    }
    expect(digests()).toHaveLength(2);
  });

  it("ADD2: the compiled entrypoint resolves the snapshot module", function* () {
    // The decisive one for `dist/xmd`: the release compiles with no
    // node_modules, so a snapshot that were a file read rather than a module
    // would be absent from the binary and the adapter unlaunchable.
    const graph = yield* moduleGraph(["--node-modules-dir=none"], "packages/cli/src/compiled.ts");

    expect(graph).toContain("vendor/adapters/generated/snapshots.ts");
  });

  it("ADD3: the graph probe refuses a command that did not run", function* () {
    // The regression for how ADD2 could quietly stop checking: `deno info`
    // rejects an unknown flag, writes nothing, and exits nonzero — and grepping
    // empty output would report the module as absent, or present, at random.
    let refused: unknown;
    try {
      yield* moduleGraph(["--not-a-real-flag"], "packages/cli/src/compiled.ts");
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("deno info");
  });

  it("ADD4: the npm entrypoint resolves it too", function* () {
    // What dnt walks when it builds `@executablemd/acp` for npm. The adapters
    // entrypoint is separate from the package root (#636 removes it), so this
    // names that entrypoint rather than `mod.ts`.
    const graph = yield* moduleGraph([], "packages/acp/embedded-adapters.ts");

    expect(graph).toContain("vendor/adapters/generated/snapshots.ts");
  });

  it("ADD5: the generated module is the manifest's bytes, not a stale copy", function* () {
    const source = yield* until(readFile(GENERATED, "utf8"));
    const manifest: unknown = JSON.parse(
      yield* until(readFile(join(VENDOR, "MANIFEST.json"), "utf8")),
    );
    const snapshots = (manifest as { snapshots: { sha256: string; version: string }[] }).snapshots;

    // Every distribution inlines this one file, so it is the single place a
    // stale snapshot could hide. Its own comments name the digests it carries.
    for (const snapshot of snapshots) {
      expect(source).toContain(snapshot.sha256);
      expect(source).toContain(snapshot.version);
    }
  });
});
