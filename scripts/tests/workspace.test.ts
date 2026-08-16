import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { pathToFileURL } from "node:url";

import { listWorkspacePaths } from "../lib/workspace.ts";

function* workspace(dirs: string[], files: string[] = []): Operation<URL> {
  const base = yield* useTempDirectory("list-workspace-paths-");

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
