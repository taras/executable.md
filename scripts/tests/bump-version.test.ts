import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { bumpManifests } from "../lib/bump-version.ts";

/**
 * The install step of the review and analysis workflows, which resolve the
 * latest published release. A bump must leave it alone: pinning it to the
 * version being cut points CI at a release that does not exist yet (#160).
 */
const REVIEW_WORKFLOW = `      - name: Install xmd release binary
        run: |
          curl -fsSL https://executable.md/install.sh | sh
`;

/** A workspace with one @executablemd member, one outside the scope, and a workflow. */
function* workspace(): Operation<URL> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bump-manifests-"));
  yield* ensure(() => rm(base, { recursive: true, force: true }));
  const root = pathToFileURL(`${base}/`);

  yield* writeTextFile(
    new URL("deno.json", root),
    `${JSON.stringify({ workspace: ["packages/*"] }, null, 2)}\n`,
  );

  for (const [dir, name] of [
    ["scoped", "@executablemd/scoped"],
    ["outside", "outside-tool"],
  ]) {
    yield* ensureDir(new URL(`packages/${dir}/`, root));
    for (const manifest of ["deno.json", "package.json"]) {
      yield* writeTextFile(
        new URL(`packages/${dir}/${manifest}`, root),
        `${JSON.stringify({ name, version: "0.1.0" }, null, 2)}\n`,
      );
    }
  }

  yield* ensureDir(new URL(".github/workflows/", root));
  yield* writeTextFile(new URL(".github/workflows/review.yml", root), REVIEW_WORKFLOW);

  return root;
}

function* version(root: URL, manifest: string): Operation<string> {
  return JSON.parse(yield* readTextFile(new URL(manifest, root))).version;
}

describe("bumpManifests", () => {
  it("stamps both manifests of every @executablemd member", function* () {
    const root = yield* workspace();

    const stamped = yield* bumpManifests("2.0.0", root);

    expect(stamped).toEqual(["packages/scoped/deno.json", "packages/scoped/package.json"]);
    expect(yield* version(root, "packages/scoped/deno.json")).toEqual("2.0.0");
    expect(yield* version(root, "packages/scoped/package.json")).toEqual("2.0.0");
  });

  it("leaves a member outside the @executablemd scope alone", function* () {
    const root = yield* workspace();

    yield* bumpManifests("2.0.0", root);

    expect(yield* version(root, "packages/outside/deno.json")).toEqual("0.1.0");
    expect(yield* version(root, "packages/outside/package.json")).toEqual("0.1.0");
  });

  it("restamps the version a manifest already declares", function* () {
    const root = yield* workspace();

    expect(yield* bumpManifests("0.1.0", root)).toEqual([
      "packages/scoped/deno.json",
      "packages/scoped/package.json",
    ]);
    expect(yield* version(root, "packages/scoped/deno.json")).toEqual("0.1.0");
  });

  it("reports a manifest with no version field", function* () {
    const root = yield* workspace();
    yield* writeTextFile(
      new URL("packages/scoped/package.json", root),
      `${JSON.stringify({ name: "@executablemd/scoped" }, null, 2)}\n`,
    );

    let caught: unknown;
    try {
      yield* bumpManifests("2.0.0", root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "no version field found in packages/scoped/package.json",
    });
  });

  it("leaves the workflows alone", function* () {
    const root = yield* workspace();

    yield* bumpManifests("2.0.0", root);

    expect(yield* readTextFile(new URL(".github/workflows/review.yml", root))).toEqual(
      REVIEW_WORKFLOW,
    );
  });
});
