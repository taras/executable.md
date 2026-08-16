import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, until } from "effection";
import type { Operation } from "effection";
import { lstat, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { readlink } from "node:fs/promises";
import path from "node:path";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type ClientBuildResult,
  buildWebClient,
  OUTPUT_MODULE,
  outputModule,
  SIDE_EFFECT_FREE_MANIFESTS,
} from "../build-web-client.ts";
import { assertSideEffectFree, normalizeSideEffects } from "../lib/side-effect-free.ts";
import { byteLength } from "../lib/web-client-module.ts";
import { loadGeneratedModule } from "./generated-module.ts";

const REPO_ROOT = new URL("../../", import.meta.url);
const GENERATED_MODULE = OUTPUT_MODULE;

/** A directory of the calling operation's own, gone when that operation shuts down. */
function* scratchDirectory(prefix: string): Operation<string> {
  const base = yield* useTempDirectory(prefix);
  return base;
}

/**
 * A scratch copy of the manifest setup normalizes, as the package ships it.
 *
 * The normalization tests drive it through states the repository's own
 * dependency tree must never be left in, so they work on a copy. It is the
 * installed manifest's own bytes, so the name and version guards see what a
 * build sees, minus the fact setup already recorded — which is the shape
 * `normalizeSideEffects` is given on a fresh install.
 */
function* manifestCopy(): Operation<URL> {
  const base = yield* scratchDirectory("side-effect-free-");
  const copy = new URL("package.json", pathToFileURL(`${base}/`));
  const shipped = JSON.parse(yield* readTextFile(SIDE_EFFECT_FREE_MANIFESTS[1]!));
  delete shipped.sideEffects;
  yield* writeTextFile(copy, `${JSON.stringify(shipped, null, 2)}\n`);
  return copy;
}

function* linkTarget(entry: URL): Operation<string> {
  // @effectionx/fs has no readlink.
  const stats = yield* lstat(entry);
  return stats.isSymbolicLink() ? yield* until(readlink(entry)) : "";
}

/**
 * What every other check in the battery resolves through, in the shape it
 * resolves through: the names under `node_modules/` and where each one points.
 * A build that installed, pruned, or relinked anything moves this.
 */
function* dependencyLayout(): Operation<string[]> {
  const root = new URL("node_modules/", REPO_ROOT);
  const layout: string[] = [];
  for (const scope of (yield* readdir(root)).sort()) {
    if (scope.startsWith(".")) {
      continue;
    }
    const entry = new URL(scope, root);
    const target = yield* linkTarget(entry);
    if (target) {
      layout.push(`${scope} -> ${target}`);
      continue;
    }
    for (const name of (yield* readdir(entry)).sort()) {
      layout.push(`${scope}/${name} -> ${yield* linkTarget(new URL(`${scope}/${name}`, root))}`);
    }
  }
  return layout;
}

/**
 * Every installed copy: the bytes and the write. Identical bytes written again
 * are still a rewrite, so the modification time is part of the state, and both
 * copies are watched because either one is what a bundler may resolve.
 */
function* manifestState(): Operation<string> {
  const state: string[] = [];
  for (const manifest of SIDE_EFFECT_FREE_MANIFESTS) {
    const stats = yield* lstat(manifest);
    state.push(`${manifest.pathname} ${stats.mtimeMs} ${yield* readTextFile(manifest)}`);
  }
  return state.join("\n");
}

function* git(args: string[]): Operation<{ code?: number; stdout: string }> {
  return yield* exec("git", { arguments: args, cwd: fileURLToPath(REPO_ROOT) }).join();
}

/** The pinned Deno running this suite, so a task runs under the version CI runs. */
function* deno(args: string[]): Operation<void> {
  yield* exec(Deno.execPath(), { arguments: args, cwd: fileURLToPath(REPO_ROOT) }).expect();
}

/**
 * Both the vendored stylesheet's banner and the override's provenance header
 * name a URL in a comment. A comment is not a reference, so the external-URL
 * assertion reads the CSS without them.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("build-web-client", () => {
  /**
   * The whole battery reads this tree while a build runs (#279). A build that
   * installed, pruned, or relinked anything in it would take `@effectionx/*`
   * out from under the Node suite, `tsx` out from under its runner, and fail
   * checks that have nothing to do with the browser bundle.
   *
   * It runs first because it has to observe the tree `deno task setup` left,
   * not one an earlier build already rewrote — a build that installs destroys
   * this evidence once and then looks stable.
   */
  it("leaves the installed dependency tree exactly as it found it", function* () {
    const before = yield* dependencyLayout();

    yield* buildWebClient();

    expect(yield* dependencyLayout()).toEqual(before);
  });

  /**
   * The function above is only half the claim: `deno task build:web` is a
   * preflight plus a `deno run`, and `deno task build` adds a `deno compile` —
   * each its own process, each with its own node-modules mode. Automatic
   * management creates `node_modules/.deno` before a process reaches its own
   * code, so the flags on those tasks are the mechanism and this is what
   * measures them.
   *
   * `deno task build` writes `dist/xmd`, which nothing in the battery reads.
   */
  it("leaves the tree as it found it through the tasks, not only the function", function* () {
    const before = yield* dependencyLayout();

    yield* deno(["task", "build:web", "--out", path.join(yield* scratchDirectory("out-"), "b.ts")]);
    expect(yield* dependencyLayout()).toEqual(before);

    yield* deno(["task", "build"]);
    expect(yield* dependencyLayout()).toEqual(before);
  });

  /**
   * The reported failure, in one line: after a build, the packages only pnpm
   * installs still resolve from Node. A build that reinstalled would take
   * `tsx` — the Node suite's own runner — out of the tree.
   */
  it("leaves both dependency stores resolvable from Node", function* () {
    yield* deno(["task", "build:web", "--out", path.join(yield* scratchDirectory("out-"), "b.ts")]);

    const probe = yield* exec("node", {
      arguments: ["scripts/probe-resolution.mjs"],
      cwd: fileURLToPath(REPO_ROOT),
    }).join();

    expect({ code: probe.code, output: probe.stdout }).toEqual({
      code: 0,
      output: probe.stdout,
    });
    expect(probe.stdout).toContain("pnpm:");
    expect(probe.stdout).toContain("deno:");
  });

  it("regenerates byte-identical output", function* () {
    const first = yield* buildWebClient();
    const second = yield* buildWebClient();

    expect(second).toEqual(first);
  });

  /**
   * Reading the manifest afterwards would not see a build that rewrote it and
   * put it back. `tsc`, Bun, and the Node suite resolve through this file for
   * the whole length of a build, so the assertion has to hold *during* one —
   * and it is about the writing, not only the bytes: a build that rewrote the
   * same bytes still truncates a file the others are reading, so the
   * modification time is part of what is observed.
   */
  it("never rewrites the manifest other checks resolve through", function* () {
    const original = yield* manifestState();
    const observed = new Set<string>();

    const build = yield* spawn(() => buildWebClient());
    const watch = yield* spawn(function* () {
      while (true) {
        observed.add(yield* manifestState());
        yield* sleep(5);
      }
    });
    yield* build;
    yield* watch.halt();

    expect([...observed]).toEqual([original]);
  });

  it("leaves nothing behind when a build is halted mid-bundle", function* () {
    const scratch = yield* scratchDirectory("build-web-client-halt-");
    const layout = yield* dependencyLayout();

    const build = yield* spawn(() => buildWebClient({ scratch }));
    yield* sleep(50);
    yield* build.halt();

    expect(yield* readdir(scratch)).toEqual([]);
    expect(yield* dependencyLayout()).toEqual(layout);
  });

  it("leaves nothing behind when a build fails", function* () {
    const scratch = yield* scratchDirectory("build-web-client-fail-");
    let failure: unknown;

    try {
      yield* scoped(function* () {
        yield* spawn(function* () {
          yield* buildWebClient({ scratch });
        });
        yield* sleep(50);
        throw new Error("the check that started the build failed");
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(new Error("the check that started the build failed"));
    expect(yield* readdir(scratch)).toEqual([]);
  });
});

describe("side-effect-free", () => {
  it("records the fact and reports that it wrote", function* () {
    const manifest = yield* manifestCopy();

    expect(yield* normalizeSideEffects(manifest)).toBe(true);

    expect(JSON.parse(yield* readTextFile(manifest)).sideEffects).toBe(false);
    yield* assertSideEffectFree([manifest]);
  });

  it("writes nothing the second time", function* () {
    const manifest = yield* manifestCopy();
    yield* normalizeSideEffects(manifest);
    const recorded = yield* readTextFile(manifest);

    expect(yield* normalizeSideEffects(manifest)).toBe(false);

    expect(yield* readTextFile(manifest)).toEqual(recorded);
  });

  it("refuses to overwrite a declaration the package already carries", function* () {
    const manifest = yield* manifestCopy();
    const shipped = JSON.parse(yield* readTextFile(manifest));
    yield* writeTextFile(manifest, JSON.stringify({ ...shipped, sideEffects: ["./setup.js"] }));

    let failure: unknown;
    try {
      yield* normalizeSideEffects(manifest);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("already declares");
  });

  it("refuses a manifest that is not the pinned package", function* () {
    const manifest = yield* manifestCopy();
    const shipped = JSON.parse(yield* readTextFile(manifest));
    yield* writeTextFile(manifest, JSON.stringify({ ...shipped, version: "6.7.0" }));

    let failure: unknown;
    try {
      yield* normalizeSideEffects(manifest);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("expected @rjsf/validator-ajv8@6.7.1");
  });

  it("sends a build with nothing installed to setup", function* () {
    const base = yield* scratchDirectory("side-effect-free-missing-");
    const missing = new URL("package.json", pathToFileURL(`${base}/`));

    let failure: unknown;
    try {
      yield* assertSideEffectFree([missing]);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("deno task setup");
  });

  /**
   * The union tree carries two copies, and `--node-modules-dir=manual` resolves
   * the one in `packages/web/node_modules` — pnpm's — while `auto` resolves
   * Deno's. A build that checked only one would pass while bundling the
   * runtime validator and its `new Function` from the other.
   */
  it("refuses when any installed copy is missing the fact", function* () {
    const recorded = yield* manifestCopy();
    yield* normalizeSideEffects(recorded);
    const shipped = yield* manifestCopy();

    let failure: unknown;
    try {
      yield* assertSideEffectFree([recorded, shipped]);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain(shipped.pathname);
    expect(String(failure)).toContain("deno task setup");
  });

  /** Nearest first, because that is the order Node's resolution reaches them in. */
  it("names both installed copies, nearest first", function* () {
    expect(SIDE_EFFECT_FREE_MANIFESTS.map((url) => url.href)).toEqual([
      new URL("packages/web/node_modules/@rjsf/validator-ajv8/package.json", REPO_ROOT).href,
      new URL("node_modules/@rjsf/validator-ajv8/package.json", REPO_ROOT).href,
    ]);
  });
});

describe("client assets", () => {
  let result: ClientBuildResult;

  beforeAll(function* () {
    result = yield* buildWebClient();
  });

  it("carries no eval path (CSP: no unsafe-eval)", function* () {
    expect(result.clientJs.includes("new Function")).toBe(false);
    expect(/\beval\(/.test(result.clientJs)).toBe(false);
    expect(result.clientJs.includes(".eval(")).toBe(false);
  });

  it("loads no non-self asset", function* () {
    expect(result.clientJs.includes("importScripts")).toBe(false);
    expect(/src\s*=\s*["']https?:/.test(result.clientJs)).toBe(false);
    expect(/import\(["']https?:/.test(result.clientJs)).toBe(false);
    expect(/fetch\(["']https?:/.test(result.clientJs)).toBe(false);
    expect(result.clientJs.includes("document.write")).toBe(false);
  });

  it("loads the fixed same-origin validator.js", function* () {
    expect(result.clientJs).toContain('"validator.js"');
  });

  it("themes the shadcn stylesheet and embeds every font it names", function* () {
    expect(result.themeCss).toContain("tailwindcss");

    const faces = result.themeCss.match(/@font-face \{[^}]*\}/g) ?? [];
    expect(
      faces.map((face) => {
        const family = face.match(/font-family: "([^"]+)"/)?.[1];
        const weight = face.match(/font-weight: (\d+)/)?.[1];
        return `${family} ${weight}`;
      }),
    ).toEqual([
      "Montserrat 400",
      "Montserrat 500",
      "Montserrat 600",
      "Montserrat 700",
      "Space Mono 400",
      "Space Mono 700",
    ]);

    // Every reference, not just the ones inside a face: an external `url()`
    // anywhere would be a request the fixed policy has no directive for.
    const references = result.themeCss.match(/url\([^)]*\)/g) ?? [];
    expect(references).toHaveLength(6);
    expect(references.every((url) => url.startsWith("url(data:font/woff2;base64,"))).toBe(true);
    expect(/https?:\/\//.test(stripComments(result.themeCss))).toBe(false);
  });

  it("carries the MX-Brutalist palette, light and dark by OS preference", function* () {
    expect(result.themeCss).toContain("--background: oklch(0.9923 0.0104 91.4994)");
    expect(result.themeCss).toContain("color-scheme: light");
    expect(result.themeCss).toContain("--radius: 0px");
    expect(result.themeCss).toContain("--radius-xs: 0px");

    const dark = result.themeCss.match(/@media \(prefers-color-scheme: dark\) \{[\s\S]*$/)?.[0];
    expect(dark).toContain("color-scheme: dark");
    expect(dark).toContain("--background: oklch(0.1649 0.0308 162.2739)");
  });

  /**
   * The palette assertions above would still pass on a stylesheet that themed
   * the colours and left the page unstyled, which is what this project shipped
   * before. These literals exist only in the layout half of the override.
   */
  it("carries the page layout and the widget treatment, not only the palette", function* () {
    expect(result.themeCss).toContain("max-width: 720px");
    expect(result.themeCss).toContain('#status[data-outcome="accepted"]');
    expect(result.themeCss).toContain('#status[data-outcome="failed"]');
    expect(result.themeCss).toContain(".rjsf-field-required");
    expect(result.themeCss).toContain("box-shadow: 8px 8px 0 0 var(--foreground)");
  });

  /**
   * The page loads this as a classic script, so a single top-level `export`
   * makes the whole form a blank page — and nothing else here would notice,
   * because every other assertion reads the text rather than running it.
   */
  it("is a classic script the page can load", function* () {
    expect(/\bexport\b/.test(result.clientJs)).toBe(false);
  });

  it("generates a TypeScript module that returns the real assets unchanged", function* () {
    const module = yield* loadGeneratedModule(result.module, ".ts");

    expect(module.clientJs).toBe(result.clientJs);
    expect(module.themeCss).toBe(result.themeCss);
    expect(module.clientJsBytes).toBe(byteLength(result.clientJs));
    expect(module.themeCssBytes).toBe(byteLength(result.themeCss));
  });

  /**
   * The task, not the script behind it: `deno task build:web` is a preflight
   * plus a `deno run` carrying the modes that make a build unable to install,
   * and spawning the script bare would exercise a path production never takes.
   *
   * It is told to write somewhere of its own — the default path is the one
   * `deno check`, `deno test`, `check:jsr`, and `tsc` all read, and a test that
   * took a turn at writing it would be the shared-state race this design
   * removes (#279).
   */
  it("writes that exact module where the task is told to", function* () {
    const scratch = yield* scratchDirectory("build-web-client-out-");
    const output = path.join(scratch, "client-bundle.ts");

    yield* exec(Deno.execPath(), {
      arguments: ["task", "build:web", "--out", output],
      cwd: fileURLToPath(REPO_ROOT),
    }).expect();

    expect(yield* readTextFile(pathToFileURL(output))).toEqual(result.module);
  });

  it("defaults to a generated path that is ignored and untracked", function* () {
    expect(outputModule([], REPO_ROOT)).toEqual(new URL(GENERATED_MODULE, REPO_ROOT));
    expect((yield* git(["check-ignore", GENERATED_MODULE])).code).toBe(0);
    expect((yield* git(["ls-files", "--", GENERATED_MODULE])).stdout).toBe("");
  });
});
