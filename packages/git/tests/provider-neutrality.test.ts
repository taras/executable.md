/**
 * The half of this package that names no provider.
 *
 * Repository/Worktree composition and the shared Git-host boundary were
 * provider-neutral while they lived in `@executablemd/workflow`, and the move
 * changed their addresses rather than that property. The components a document
 * writes name no subprocess, no host filesystem and no runtime; the
 * external-effect boundary names no Git host, because it exists so that an
 * adapter can be written for any of them and the first adapter naming itself
 * in a shared contract is how a neutral surface quietly becomes one provider's.
 *
 * Only `src/deno/**` is allowed to know where it is running, and this proves
 * the scan reached past it rather than skipping everything.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  COMPUTED,
  forbiddenNames,
  moduleSpecifiers,
  parse,
} from "@executablemd/test-support/host-boundary";
import { readTextFile } from "@effectionx/fs";
import { glob } from "@executablemd/runtime";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));

describe("the Git package's provider-neutral surface", () => {
  it("names no host, no runtime, no storage engine and no Git host", function* () {
    // The scan has to be able to fail, or an empty report says nothing. These
    // modules explain in their own prose that they name no provider, so a
    // search of the whole file would find the explanation rather than a
    // crossing.
    expect(forbiddenNames(`import { DatabaseSync } from "node:sqlite";`)).toEqual([
      "DatabaseSync",
      "sqlite",
      "node:sqlite",
    ]);
    expect(forbiddenNames(`import { run } from "@effectionx/process";`)).toEqual([
      "@effectionx/process",
    ]);
    expect(forbiddenNames("const home = Deno.cwd();")).toEqual(["Deno"]);
    expect(forbiddenNames(`import "../deno/composition/host.ts";`)).toEqual([
      "../deno/composition/host.ts",
    ]);
    expect(forbiddenNames(`const target = adapter;\nawait import(target);`)).toEqual([COMPUTED]);

    // The sharpest control for this package: the first Git-host adapter is a
    // provider, and a shared contract that names it has chosen one.
    expect(forbiddenNames(`import { push } from "./GitHubAdapter.ts";`)).toEqual(["GitHub"]);
    expect(forbiddenNames(`type Request = { readonly githubRepository: string };`)).toEqual([
      "github",
    ]);
    // …while the domain noun these modules are actually about is not a
    // provider, and neither is prose.
    expect(forbiddenNames(`type Request = { readonly repository: string };`)).toEqual([]);
    expect(forbiddenNames("// the GitHub adapter implements this boundary")).toEqual([]);
    expect(forbiddenNames(`import { reconcile } from "./git-host/effect.ts";`)).toEqual([]);

    const found = (yield* glob({
      root: REPOSITORY,
      patterns: ["packages/git/mod.ts", "packages/git/src/**/*.ts"],
      // The whole package rather than named modules, so a boundary module
      // added later is covered without this list being remembered.
      exclude: ["packages/git/src/deno/**"],
    }))
      .map((entry) => entry.path)
      .sort();

    // A pattern that matched nothing would report a clean boundary, so the
    // surface this rule is about is named here.
    expect(found).toEqual(
      expect.arrayContaining([
        "packages/git/mod.ts",
        "packages/git/src/plugin.ts",
        "packages/git/src/identities.ts",
        "packages/git/src/composition/api.ts",
        "packages/git/src/composition/components/Dir.ts",
        "packages/git/src/composition/components/Repository.ts",
        "packages/git/src/composition/components/Worktree.ts",
        "packages/git/src/composition/context.ts",
        "packages/git/src/composition/errors.ts",
        "packages/git/src/composition/installation.ts",
        "packages/git/src/composition/records.ts",
        "packages/git/src/git-host/api.ts",
        "packages/git/src/git-host/effect.ts",
        "packages/git/src/git-host/errors.ts",
        "packages/git/src/git-host/records.ts",
      ]),
    );
    expect(found.some((path) => path.includes("/src/deno/"))).toBe(false);

    const crossings: Record<string, string[]> = {};
    const unread: string[] = [];
    for (const path of found) {
      const source = yield* readTextFile(join(REPOSITORY, path));
      // A parse that failed would report every file as clean. A module whose
      // text imports something must yield a specifier, or this scan is reading
      // nothing and saying so approvingly.
      if (/^import\s/m.test(source) && moduleSpecifiers(parse(source).file).length === 0) {
        unread.push(path);
      }
      const names = forbiddenNames(source);
      if (names.length > 0) {
        crossings[path] = names;
      }
    }
    expect(unread).toEqual([]);
    expect(crossings).toEqual({});
  });
});
