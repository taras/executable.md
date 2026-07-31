import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createChannel, ensure, scoped, spawn, suspend, until } from "effection";
import type { Operation } from "effection";
import { copyFile, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type ClientBuildResult,
  SIDE_EFFECT_FREE_MANIFEST,
  buildWebClient,
  markSideEffectFree,
} from "../build-web-client.ts";
import { FileWrites } from "../lib/manifest-patch.ts";
import type { WriteFile } from "../lib/manifest-patch.ts";
import { byteLength } from "../lib/web-client-module.ts";
import { loadGeneratedModule } from "./generated-module.ts";

const REPO_ROOT = new URL("../../", import.meta.url);
const GENERATED_MODULE = "packages/web/generated/client-bundle.ts";

/**
 * A scratch copy of the manifest a build patches, removed when the calling
 * operation shuts down.
 *
 * The restoration tests drive `markSideEffectFree` through failure and
 * cancellation, so they patch a copy: a test that ends without restoring would
 * otherwise leave the repository's own `node_modules` rewritten. The copy is the
 * real manifest's bytes, so the name and version guards see what a build sees.
 */
function* manifestCopy(): Operation<URL> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "side-effect-free-"));
  yield* ensure(() => rm(base, { recursive: true, force: true }));

  const copy = new URL("package.json", pathToFileURL(`${base}/`));
  yield* copyFile(SIDE_EFFECT_FREE_MANIFEST, copy);
  return copy;
}

function* git(args: string[]): Operation<{ code?: number; stdout: string }> {
  return yield* exec("git", { arguments: args, cwd: fileURLToPath(REPO_ROOT) }).join();
}

/**
 * Both the vendored stylesheet's banner and the override's provenance header
 * name a URL in a comment. A comment is not a reference, so the external-URL
 * assertion reads the CSS without them.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}

/** A promise the test opens by hand, so a write can be started and left unsettled. */
function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

describe("build-web-client", () => {
  it("regenerates byte-identical output", function* () {
    const first = yield* buildWebClient();
    const second = yield* buildWebClient();

    expect(second).toEqual(first);
  });

  it("restores the patched manifest to its exact original bytes", function* () {
    const before = yield* readTextFile(SIDE_EFFECT_FREE_MANIFEST);

    yield* buildWebClient();

    const after = yield* readTextFile(SIDE_EFFECT_FREE_MANIFEST);
    expect(after).toEqual(before);
    expect(after.includes("sideEffects")).toBe(false);
  });
});

describe("markSideEffectFree", () => {
  it("restores the original bytes when the patched scope completes", function* () {
    const manifest = yield* manifestCopy();
    const before = yield* readTextFile(manifest);
    let patched = "";

    yield* scoped(function* () {
      yield* markSideEffectFree(manifest);
      patched = yield* readTextFile(manifest);
    });

    expect(JSON.parse(patched).sideEffects).toBe(false);
    expect(patched).not.toEqual(before);
    expect(yield* readTextFile(manifest)).toEqual(before);
  });

  it("restores the original bytes when work after the patch throws", function* () {
    const manifest = yield* manifestCopy();
    const before = yield* readTextFile(manifest);
    let patched = "";
    let failure: unknown;

    try {
      yield* scoped(function* () {
        yield* markSideEffectFree(manifest);
        patched = yield* readTextFile(manifest);
        throw new Error("bundling failed");
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(new Error("bundling failed"));
    expect(JSON.parse(patched).sideEffects).toBe(false);
    expect(yield* readTextFile(manifest)).toEqual(before);
  });

  it("restores the original bytes when the owning operation is halted", function* () {
    const manifest = yield* manifestCopy();
    const before = yield* readTextFile(manifest);
    const patches = createChannel<string, never>();
    const installed = yield* patches;

    const task = yield* spawn(function* () {
      yield* scoped(function* () {
        yield* markSideEffectFree(manifest);
        yield* patches.send(yield* readTextFile(manifest));
        yield* suspend();
      });
    });

    const patched = yield* installed.next();
    expect(JSON.parse(patched.value).sideEffects).toBe(false);
    expect(patched.value).not.toEqual(before);

    yield* task.halt();

    expect(yield* readTextFile(manifest)).toEqual(before);
  });

  /**
   * Halting stops Effection observing the patching write; it does not stop the
   * write. Cleanup must therefore wait for that write to settle before
   * restoring, or the patch lands after the restore and stays on disk. The
   * substituted writer performs the real write — it only holds it open long
   * enough for the halt to arrive first.
   */
  it("restores the original bytes when halted before the patching write settles", function* () {
    const manifest = yield* manifestCopy();
    const before = yield* readTextFile(manifest);

    const order: string[] = [];
    const patchStarted = gate();
    const patchHeld = gate();

    const writes: WriteFile = (path, contents) => {
      const label = contents === before ? "restore" : "patch";
      order.push(`${label}:start`);
      const held = label === "patch" ? patchHeld.promise : Promise.resolve();
      if (label === "patch") {
        patchStarted.open();
      }
      return held
        .then(() => writeFile(path, contents))
        .then(() => {
          order.push(`${label}:settle`);
        });
    };

    yield* FileWrites.with(writes, function* () {
      const task = yield* spawn(function* () {
        yield* scoped(function* () {
          yield* markSideEffectFree(manifest);
          yield* suspend();
        });
      });

      yield* until(patchStarted.promise);
      expect(order).toEqual(["patch:start"]);
      expect(yield* readTextFile(manifest)).toEqual(before);

      const halting = yield* spawn(() => task.halt());
      patchHeld.open();
      yield* halting;
    });

    expect(order).toEqual(["patch:start", "patch:settle", "restore:start", "restore:settle"]);
    expect(yield* readTextFile(manifest)).toEqual(before);
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

  it("generates a TypeScript module that returns the real assets unchanged", function* () {
    const module = yield* loadGeneratedModule(result.module, ".ts");

    expect(module.clientJs).toBe(result.clientJs);
    expect(module.themeCss).toBe(result.themeCss);
    expect(module.clientJsBytes).toBe(byteLength(result.clientJs));
    expect(module.themeCssBytes).toBe(byteLength(result.themeCss));
  });

  it("writes that exact module to the generated path and nowhere in the index", function* () {
    const generated = new URL(GENERATED_MODULE, REPO_ROOT);

    // The tree is left as it was found rather than emptied. The generated module
    // is a real build artifact other work depends on — `build-npm.ts` packages it
    // when a dependent is built — so a test that removed it would decide whether
    // an unrelated test passed by running before or after it.
    const before = (yield* exists(generated)) ? yield* readTextFile(generated) : undefined;
    yield* ensure(function* () {
      if (before === undefined) {
        yield* rm(generated, { force: true });
      } else {
        yield* writeTextFile(generated, before);
      }
    });

    yield* exec(Deno.execPath(), {
      arguments: ["task", "build:web"],
      cwd: fileURLToPath(REPO_ROOT),
    }).expect();

    expect(yield* readTextFile(generated)).toEqual(result.module);
    expect((yield* git(["check-ignore", GENERATED_MODULE])).code).toBe(0);
    expect((yield* git(["ls-files", "--", GENERATED_MODULE])).stdout).toBe("");
  });
});
