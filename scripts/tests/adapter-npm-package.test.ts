/**
 * Tier ANP — the produced npm package launches the embedded adapter.
 *
 * Tier EA runs the adapters out of the source tree, and Tier ADD proves the
 * bytes reach each distribution's module graph. Neither answers the question an
 * npm consumer actually has: does the package we publish, once built and
 * imported by Node, put the adapter on disk and get a checkpoint back.
 *
 * So this builds the real dnt artifact and consumes it the way npm consumers
 * do — a separate `node` process importing the emitted entrypoint, not the
 * source module — and asserts on the identity the exchange returns.
 *
 * The build is the repository's own `scripts/build-npm.ts`. Local siblings,
 * because `@executablemd/acp` depends on workspace packages whose released
 * versions do not carry this entrypoint yet; legacy peer resolution, because
 * `@executablemd/core` pins `marked@17` while `marked-terminal` still peers on
 * `<16`, and dnt installs that sibling on the way through.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { exists, rm } from "@effectionx/fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";

const PACKAGE = "packages/acp/npm";
const DRIVER = "packages/acp/tests/fixtures/npm-package-driver.mjs";
const FAKE_CODEX = "packages/acp/tests/fixtures/fake-codex-app-server.cjs";

/** This process's environment, with anything unset dropped. */
function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      environment[key] = value;
    }
  }
  return environment;
}

/**
 * Build the npm artifact from this checkout, and remove it afterwards.
 *
 * Forced, never reused. `packages/acp/npm` is shared generated output, so an
 * artifact left by another revision would otherwise be the thing under test —
 * a regression that passes because somebody built the package before the bug
 * was introduced proves nothing. The build happens here so the provenance is
 * this test's, not a preceding command's.
 *
 * Removed through `ensure`, so a failure partway leaves nothing behind for the
 * next run to mistake for its own.
 */
function useBuiltPackage(): Operation<string> {
  return resource(function* (provide) {
    const path = resolve(PACKAGE);
    yield* rm(path, { recursive: true, force: true });
    yield* ensure(() => rm(path, { recursive: true, force: true }));

    const built = yield* scoped(function* () {
      yield* useQuietProcessOutput();
      return yield* exec({
        command: [process.execPath, "run", "-A", "scripts/build-npm.ts", "packages/acp"],
        // Merged, not replaced: the build resolves through the caller's Deno
        // cache and npm configuration, and a bare pair would drop both.
        env: {
          ...inheritedEnvironment(),
          DNT_LOCAL_SIBLINGS: "1",
          npm_config_legacy_peer_deps: "true",
        },
      });
    });
    if (built.exitCode !== 0) {
      throw new Error(`building the npm package failed: ${built.stderr.trim()}`);
    }

    yield* provide(path);
  });
}

describe("Tier ANP — the produced npm package", () => {
  it("ANP1: Node materializes and launches the snapshot from the built package", function* () {
    // One build, and everything below is about that exact artifact.
    const path = yield* useBuiltPackage();

    const manifest: unknown = JSON.parse(
      yield* until(readFile(join(path, "package.json"), "utf8")),
    );
    const exported = Reflect.get(
      Object(Reflect.get(Object(manifest), "exports")),
      "./embedded-adapters",
    );
    // Its own entrypoint in the artifact too, so removing it under #636
    // withdraws nothing from the package root.
    expect(exported).toBeDefined();
    expect(
      yield* exists(join(path, "esm", "vendor", "adapters", "generated", "snapshots.js")),
    ).toBe(true);

    const driven = yield* scoped(function* () {
      yield* useQuietProcessOutput();
      return yield* exec({ command: ["node", DRIVER, path, resolve(FAKE_CODEX)] });
    });
    if (driven.exitCode !== 0) {
      throw new Error(`the npm package driver failed: ${driven.stderr.trim()}`);
    }

    // Materialized under the digest the package itself records — so the
    // artifact carries the snapshot rather than resolving one from elsewhere.
    expect(driven.stdout).toContain("MATERIALIZED true");
    // And the exchange completed against the real adapter the package wrote,
    // returning the identity the fake App Server emitted for that turn.
    expect(driven.stdout).toContain('CHECKPOINT {"turnId":"turn:thread-1:1"}');
  });
});
