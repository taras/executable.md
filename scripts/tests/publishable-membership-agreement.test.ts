/**
 * The three selectors that decide what a tag publishes, run over one workspace
 * they must all read the same way.
 *
 * `scripts/gen-publish-workflow.md` selects publish jobs on `deno.json`'s name
 * and `package.json`'s `private`. A gate that selected on `package.json`'s name
 * instead would admit a different set, and the half that disagreed would
 * publish alone — which is the partial release this whole arrangement exists to
 * prevent. The repository's own manifests agree about every name, so nothing
 * there can tell the two rules apart; these fixtures make them disagree on
 * purpose.
 *
 * Both the preflight and the generator are executed as the release runs them,
 * not reimplemented: the preflight's shell is lifted out of `release.yml`, and
 * the generator is the real document over a fixture workspace, because an eval
 * block's selection rule cannot be imported (#237).
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { fileURLToPath, pathToFileURL } from "node:url";

import { publishableMembers } from "../lib/publishable-members.ts";

const repoRoot = new URL("../../", import.meta.url);

/** One version for the whole fixture; these cases are about membership. */
const VERSION = "1.0.0";

/** A tag no fixture manifest declares, so the preflight reports every member it selected. */
const FOREIGN_TAG = "v9.9.9";

interface MemberSpec {
  dir: string;
  /** `deno.json`'s name; omitted writes no `deno.json` at all. */
  denoName?: string;
  /** `package.json`'s name; omitted writes no `package.json` at all. */
  packageName?: string;
  private?: boolean;
}

function* fixture(members: MemberSpec[]): Operation<URL> {
  const base = yield* useTempDirectory("membership-agreement-");
  const root = pathToFileURL(`${base}/`);

  yield* writeTextFile(
    new URL("deno.json", root),
    `${JSON.stringify({ workspace: ["packages/*"] }, null, 2)}\n`,
  );
  yield* ensureDir(new URL(".github/workflows/", root));

  for (const member of members) {
    yield* ensureDir(new URL(`packages/${member.dir}/`, root));
    if (member.denoName !== undefined) {
      yield* writeTextFile(
        new URL(`packages/${member.dir}/deno.json`, root),
        `${JSON.stringify(
          { name: member.denoName, version: VERSION, exports: "./mod.ts" },
          null,
          2,
        )}\n`,
      );
    }
    if (member.packageName !== undefined) {
      yield* writeTextFile(
        new URL(`packages/${member.dir}/package.json`, root),
        `${JSON.stringify(
          { name: member.packageName, version: VERSION, private: member.private },
          null,
          2,
        )}\n`,
      );
    }
  }

  return root;
}

/** The `run:` body of `release.yml`'s preflight step, dedented, with the tag substituted. */
function* preflightScript(tag: string): Operation<string> {
  const lines = (yield* readTextFile(new URL(".github/workflows/release.yml", repoRoot))).split(
    "\n",
  );
  const step = lines.findIndex((line) =>
    line.includes("name: Tag matches every publishable manifest"),
  );
  expect(step).toBeGreaterThan(-1);
  const opens = lines.findIndex((line, index) => index > step && line.trim() === "run: |");
  expect(opens).toBeGreaterThan(step);

  const indent = lines[opens].length - lines[opens].trimStart().length + 2;
  const body: string[] = [];
  for (const line of lines.slice(opens + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) {
      break;
    }
    body.push(line.slice(indent));
  }

  return body.join("\n").replace("${{ github.ref_name }}", tag);
}

/**
 * The members `release.yml`'s preflight selects, read back from the mismatches
 * it reports: against a tag no manifest declares, it names both manifests of
 * every member it looked at and nothing else.
 */
function* fromPreflight(root: URL): Operation<string[]> {
  const script = new URL("preflight.sh", root);
  yield* writeTextFile(script, `${yield* preflightScript(FOREIGN_TAG)}\n`);

  const run = yield* exec("sh", {
    arguments: [fileURLToPath(script)],
    cwd: fileURLToPath(root),
  }).join();

  const selected = new Set<string>();
  for (const [, path] of run.stdout.matchAll(/::error::(packages\/[^/]+)\/[^\s]+ declares/g)) {
    selected.add(path);
  }
  return [...selected].toSorted();
}

/** The members the real generator writes publish jobs for. */
function* fromGenerator(root: URL): Operation<string[]> {
  yield* exec(Deno.execPath(), {
    arguments: [
      "run",
      "--allow-all",
      // Without it Deno reads the fixture's own deno.json and no import resolves.
      "--config",
      fileURLToPath(new URL("deno.json", repoRoot)),
      fileURLToPath(new URL("packages/cli/src/deno.ts", repoRoot)),
      "run",
      fileURLToPath(new URL("scripts/gen-publish-workflow.md", repoRoot)),
    ],
    cwd: fileURLToPath(root),
  }).join();

  // Read rather than trust the exit status: a failing eval block writes an
  // ERROR comment and leaves the CLI reporting success (#237), so an absent or
  // empty workflow has to fail this here.
  const generated = yield* readTextFile(new URL(".github/workflows/publish-packages.yml", root));
  return [...generated.matchAll(/package: (packages\/\S+)/g)].map(([, dir]) => dir).toSorted();
}

function* fromLibrary(root: URL): Operation<string[]> {
  return (yield* publishableMembers(root)).map((member) => member.dir).toSorted();
}

describe("publishable membership", () => {
  /**
   * Every shape that can make the two manifest names disagree, in one
   * workspace. At the commit this test was written against, `by-package-name`
   * alone would have split the three: the generator published it, and both
   * gates ignored it.
   */
  it("is one set, whichever of the three selectors reads it", function* () {
    const root = yield* fixture([
      {
        dir: "ordinary",
        denoName: "@executablemd/ordinary",
        packageName: "@executablemd/ordinary",
      },
      { dir: "by-deno-name", denoName: "@executablemd/renamed", packageName: "renamed-on-npm" },
      {
        dir: "by-package-name",
        denoName: "local-tool",
        packageName: "@executablemd/looks-published",
      },
      {
        dir: "withheld",
        denoName: "@executablemd/withheld",
        packageName: "@executablemd/withheld",
        private: true,
      },
      { dir: "no-package-json", denoName: "@executablemd/half" },
      { dir: "no-deno-json", packageName: "@executablemd/half-again" },
    ]);

    const library = yield* fromLibrary(root);

    // The set every selector has to reach: identity from deno.json, exclusion
    // from package.json, and both manifests present.
    expect(library).toEqual(["packages/by-deno-name", "packages/ordinary"]);
    expect(yield* fromPreflight(root)).toEqual(library);
    expect(yield* fromGenerator(root)).toEqual(library);
  });

  /**
   * Non-vacuous: the three-way comparison above would also hold if every
   * selector returned nothing, which is what a fixture the generator refused to
   * read would produce.
   */
  it("selects nothing from a workspace whose members all publish nothing", function* () {
    const root = yield* fixture([
      { dir: "local", denoName: "local-tool", packageName: "local-tool" },
    ]);

    expect(yield* fromLibrary(root)).toEqual([]);
    expect(yield* fromPreflight(root)).toEqual([]);
    expect(yield* fromGenerator(root)).toEqual([]);
  });
});
