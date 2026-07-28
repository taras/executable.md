import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { listWorkspacePaths } from "../lib/workspace.ts";

function* workspace(dirs: string[], files: string[] = []): Operation<URL> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "list-workspace-paths-"));
  yield* ensure(() => rm(base, { recursive: true, force: true }));

  const root = pathToFileURL(`${base}/`);
  for (const dir of dirs) {
    yield* ensureDir(new URL(dir, root));
  }
  for (const file of files) {
    yield* writeTextFile(new URL(file, root), "{}\n");
  }
  return root;
}

describe("listWorkspacePaths", () => {
  it("returns a literal entry unchanged", function* () {
    const root = yield* workspace([]);

    expect(yield* listWorkspacePaths(["site"], root)).toEqual(["site"]);
  });

  it("resolves a one-level glob to its members", function* () {
    const root = yield* workspace(["packages/core", "packages/runtime"]);

    expect(yield* listWorkspacePaths(["packages/*"], root)).toEqual([
      "packages/core",
      "packages/runtime",
    ]);
  });

  it("sorts a resolved glob and keeps the entry order around it", function* () {
    const root = yield* workspace(["packages/zeta", "packages/alpha", "packages/mid", "site"]);

    expect(yield* listWorkspacePaths(["packages/*", "site"], root)).toEqual([
      "packages/alpha",
      "packages/mid",
      "packages/zeta",
      "site",
    ]);
  });

  it("returns listed paths that carry no manifest", function* () {
    const root = yield* workspace(
      ["packages/core", "packages/test-support"],
      ["packages/core/deno.json", "packages/README.md"],
    );

    expect(yield* listWorkspacePaths(["packages/*"], root)).toEqual([
      "packages/README.md",
      "packages/core",
      "packages/test-support",
    ]);
  });
});
