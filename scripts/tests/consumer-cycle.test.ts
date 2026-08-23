/**
 * What one consumer cycle refuses to accept.
 *
 * The cycle is the half of the interference proof that stands where the damage
 * would land, so what matters is not that it runs — it is that every way the
 * shared state could be broken makes it fail, immediately and by name. A cycle
 * that resolved a specifier and looked no further would pass against a link
 * pointing at nothing; one that imported the generated module and checked only
 * that it imported would pass against a stale or truncated build.
 *
 * The fixture is a minimal stand-in for the union of stores rather than the
 * real tree: breaking the real `node_modules` is exactly what these tests exist
 * to catch someone else doing.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";

import {
  checkGenerated,
  consume,
  cycle,
  cyclesOf,
  GENERATED,
  isRuntime,
  PRODUCING,
  readyPath,
  RUNTIMES,
  SETTLED,
  signalPath,
  STORES,
} from "../lib/consumer-cycle.ts";
import { generatedModule } from "../lib/web-client-module.ts";

const CLIENT_JS = "globalThis.mounted = true;";
const THEME_CSS = ":root { --x: 1px; }";

/**
 * The stores a temporary worktree can actually stand in for.
 *
 * `@executablemd/core` is deliberately absent: `tsx` resolves `@executablemd/*`
 * through `tsconfig.node.json`'s `paths`, so under Node it reaches the real
 * repository whatever a fixture plants — which is correct for the probe, whose
 * root *is* the repository, and impossible to fake here.
 *
 * Nor can this file assert the three together against the real repository. The
 * corpus runs in jobs whose dependency layout is deliberately partial —
 * `test-bun` runs `bun install` and nothing else, so the Deno store is simply
 * not there — and such a case would be asserting the job's layout rather than
 * this module's behaviour. All three stores are proven together by the live
 * probe, which runs where the union exists by construction.
 */
const FIXTURE_STORES: Record<string, string> = { pnpm: STORES.pnpm, deno: STORES.deno };

/** A tree with one package per store and one whole generated module. */
function* layout(): Operation<string> {
  const root = yield* useTempDirectory("xmd-consumer-");
  yield* plant(root);
  return root;
}

function* plant(root: string): Operation<void> {
  for (const specifier of Object.values(FIXTURE_STORES)) {
    const directory = join(root, "node_modules", ...specifier.split("/"));
    yield* ensureDir(directory);
    yield* writeTextFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name: specifier, version: "1.0.0", main: "index.js" })}\n`,
    );
    yield* writeTextFile(
      join(directory, "index.js"),
      `export const name = ${JSON.stringify(specifier)};\n`,
    );
  }
  yield* ensureDir(join(root, "packages", "web", "generated"));
  yield* writeTextFile(join(root, GENERATED), generatedModule(CLIENT_JS, THEME_CSS));
}

function entry(root: string, specifier: string): string {
  return join(root, "node_modules", ...specifier.split("/"), "index.js");
}

/** The message a cycle failed with, or `"passed"`. */
function* failure(
  root: string,
  sequence: number,
  stores: Record<string, string> = FIXTURE_STORES,
): Operation<string> {
  try {
    yield* cycle(root, sequence, stores);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "passed";
}

describe("CP2 — a cycle consumes every store and the generated bundle", () => {
  it("passes against a whole layout", function* () {
    expect(yield* failure(yield* layout(), 0)).toEqual("passed");
  });

  it("names the three stores and the runtimes that consume them", function* () {
    expect(Object.keys(STORES).toSorted()).toEqual(["deno", "pnpm", "workspace"]);
    expect(Object.values(STORES)).toEqual(["tsx", "@rjsf/shadcn", "@executablemd/core"]);
    expect([...RUNTIMES]).toEqual(["deno", "node", "bun"]);
    for (const runtime of RUNTIMES) {
      expect(isRuntime(runtime)).toBe(true);
    }
    expect(isRuntime("python")).toBe(false);
  });
});

describe("CP4 — a dependency-layout replacement fails the cycle", () => {
  for (const [store, specifier] of Object.entries(FIXTURE_STORES)) {
    /**
     * Asserted on the store and specifier rather than on one message: with the
     * package gone, resolution either fails outright or walks up out of the
     * worktree, and which one happens depends on the runtime and on what sits
     * above the fixture. Both are failures, and both have to name what broke.
     */
    it(`fails when the ${store} store's package is gone`, function* () {
      const root = yield* layout();
      yield* rm(join(root, "node_modules", ...specifier.split("/")), { recursive: true });

      const why = yield* failure(root, 0);
      expect(why).not.toEqual("passed");
      expect(why).toContain(`${store} store: ${specifier}`);
    });

    /**
     * The case resolution alone cannot see: the link is intact and the bytes
     * behind it are gone, which is what a half-replaced package looks like.
     */
    it(`fails when the ${store} store's entry has no bytes left`, function* () {
      const root = yield* layout();
      yield* writeTextFile(entry(root, specifier), "");

      expect(yield* failure(root, 0)).toContain(`resolved to an empty entry`);
    });
  }

  /**
   * The case CI found and every local run missed. Node resolution walks up out
   * of the fixture, so a deleted package can be satisfied by a copy the
   * producer never touches — and the consumer then proves nothing about the
   * layout it was pointed at. Here the parent directory holds that copy, which
   * is what the repository root is to a temporary worktree under `tsx`.
   */
  it("refuses a package it resolved from outside the worktree", function* () {
    const parent = yield* useTempDirectory("xmd-consumer-outer-");
    const root = join(parent, "inner");
    yield* ensureDir(root);
    yield* plant(root);

    const specifier = FIXTURE_STORES.deno;
    // The same package, one level up, exactly where resolution looks next.
    yield* ensureDir(join(parent, "node_modules", ...specifier.split("/")));
    yield* writeTextFile(
      join(parent, "node_modules", ...specifier.split("/"), "package.json"),
      `${JSON.stringify({ name: specifier, version: "1.0.0", main: "index.js" })}\n`,
    );
    yield* writeTextFile(
      join(parent, "node_modules", ...specifier.split("/"), "index.js"),
      "export const name = 'the copy nobody is proving';\n",
    );
    yield* rm(join(root, "node_modules", ...specifier.split("/")), { recursive: true });

    const why = yield* failure(root, 0);

    expect(why).toContain("resolved outside the worktree");
    expect(why).toContain(specifier);
  });

  /** Restoring it afterwards does not un-fail the cycle that already saw it. */
  it("stays failed after the layout is put back", function* () {
    const root = yield* layout();
    const path = entry(root, FIXTURE_STORES.deno);
    yield* writeTextFile(path, "");

    const broken = yield* failure(root, 0);
    yield* writeTextFile(path, "export const name = 'restored';\n");
    const recovered = yield* failure(root, 1);

    expect(broken).toContain("empty entry");
    expect(recovered).toEqual("passed");
  });
});

describe("CP6 — a missing, partial or malformed generated module fails the cycle", () => {
  it("fails when the module is absent", function* () {
    const root = yield* layout();
    yield* rm(join(root, GENERATED));

    expect(yield* failure(root, 0)).toContain("did not import");
  });

  it("fails when the module was published half-written", function* () {
    const root = yield* layout();
    const whole = generatedModule(CLIENT_JS, THEME_CSS);
    yield* writeTextFile(join(root, GENERATED), whole.slice(0, Math.floor(whole.length / 2)));

    expect(yield* failure(root, 0)).not.toEqual("passed");
  });

  /**
   * The one a plain import cannot catch. This module is syntactically perfect
   * and evaluates cleanly; it is simply not the build that is on disk.
   */
  it("fails when the recorded byte counts do not describe the assets", function* () {
    const root = yield* layout();
    const stale = generatedModule(CLIENT_JS, THEME_CSS).replace(
      /export const clientJsBytes = \d+;/,
      "export const clientJsBytes = 999999;",
    );
    yield* writeTextFile(join(root, GENERATED), stale);

    expect(yield* failure(root, 0)).toContain("and records 999999");
  });

  it("rejects an empty asset, a missing count and a module that is not one", function* () {
    const whole = { clientJs: "x", clientJsBytes: 1, themeCss: "y", themeCssBytes: 1 };
    const refusals = [
      [{ ...whole, clientJs: "" }, "empty clientJs"],
      [{ ...whole, themeCssBytes: undefined }, "themeCssBytes as undefined"],
      [{ ...whole, clientJs: 7 }, "clientJs as number"],
      [null, "did not evaluate to a module"],
    ] as const;

    for (const [loaded, expected] of refusals) {
      let raised = "passed";
      try {
        checkGenerated(loaded, "the module");
      } catch (error) {
        raised = error instanceof Error ? error.message : String(error);
      }
      expect(raised).toContain(expected);
    }
    checkGenerated(whole, "the module");
  });
});

describe("CP2 — the loop records what it overlapped", () => {
  it("counts a cycle by the phase it began in, and stops one cycle after settlement", function* () {
    const root = yield* layout();
    const control = yield* useTempDirectory("xmd-consumer-control-");

    yield* writeTextFile(signalPath(control, PRODUCING), "producing\n");
    yield* writeTextFile(signalPath(control, SETTLED), "settled\n");

    const counted = yield* consume({ runtime: "deno", root, control, stores: FIXTURE_STORES });

    expect(counted).toEqual({ runtime: "deno", before: 0, during: 0, after: 1 });
    expect(yield* cyclesOf(control, "deno")).toEqual(counted);
  });

  it("signals readiness after its first cycle, and records what it did", function* () {
    const root = yield* layout();
    const control = yield* useTempDirectory("xmd-consumer-control-");

    // No settlement signal: the limit is what ends this loop, standing in for a
    // producer that keeps running.
    const counted = yield* consume({
      runtime: "bun",
      root,
      control,
      limit: 3,
      stores: FIXTURE_STORES,
    });

    expect(counted.before).toEqual(3);
    expect(counted.during + counted.after).toEqual(0);
    expect(yield* cyclesOf(control, "bun")).toEqual(counted);
    expect(readyPath(control, "bun")).toContain("bun.ready");
  });

  it("reports no cycles for a runtime that never wrote one", function* () {
    const control = yield* useTempDirectory("xmd-consumer-control-");

    expect(yield* cyclesOf(control, "node")).toEqual(undefined);
  });
});
