import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { readdir, readTextFile } from "@effectionx/fs";

import { listWorkspacePaths } from "../lib/workspace.ts";

const RELEASE_WORKFLOW = new URL("../../.github/workflows/release.yml", import.meta.url);
const PUBLISH_ONE_WORKFLOW = new URL("../../.github/workflows/publish-one.yml", import.meta.url);

const SCOPE = "@executablemd/";
const repoRoot = new URL("../../", import.meta.url);

interface Member {
  dir: string;
  isPrivate: boolean;
  hasJsrIdentity: boolean;
}

/**
 * Every `@executablemd` workspace member, identified by `package.json` name —
 * the identity both npm and the generator key membership on — together with
 * whether it is private and whether its `deno.json` carries a JSR identity
 * (`name` and `exports`). A private member omits both `deno.json` fields rather
 * than declaring an `exports`-less `name`, so it never warns on `deno install`
 * and `deno publish` finds no entry to publish.
 */
function* members(): Operation<Member[]> {
  const root = JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot)));
  const found: Member[] = [];
  for (const dir of yield* listWorkspacePaths(root.workspace, repoRoot)) {
    let denoJson;
    let pkgJson;
    try {
      denoJson = JSON.parse(yield* readTextFile(new URL(`${dir}/deno.json`, repoRoot)));
      pkgJson = JSON.parse(yield* readTextFile(new URL(`${dir}/package.json`, repoRoot)));
    } catch {
      continue;
    }
    if (typeof pkgJson.name !== "string" || !pkgJson.name.startsWith(SCOPE)) {
      continue;
    }
    found.push({
      dir,
      isPrivate: pkgJson.private === true,
      hasJsrIdentity: typeof denoJson.name === "string" && denoJson.exports !== undefined,
    });
  }
  return found;
}

function* workflow(): Operation<string> {
  return yield* readTextFile(new URL(".github/workflows/publish-packages.yml", repoRoot));
}

/**
 * `deno compile` embeds the generated browser bundle by following its literal
 * dynamic import, and compiles without complaint when the file is absent —
 * producing a binary that runs, serves a page, and cannot load its client. The
 * order is asserted because nothing else reports it.
 */
describe("release.yml binary compilation", () => {
  it("builds the browser bundle before compiling", function* () {
    const workflow = yield* readTextFile(RELEASE_WORKFLOW);

    // Executable lines only: the comment beside the build step names
    // `deno compile` too, and matching prose would compare the wrong positions.
    const steps = workflow.split("\n").filter((line) => !line.trim().startsWith("#"));
    const build = steps.findIndex((line) => line.includes("deno task build:web"));
    const compile = steps.findIndex((line) => line.includes("deno compile"));

    expect(build).toBeGreaterThan(-1);
    expect(compile).toBeGreaterThan(-1);
    expect(build).toBeLessThan(compile);
  });

  /**
   * The compile that produces published binaries is invoked directly rather
   * than through `deno task build`, so it carries its own isolation. Without
   * it, a release could fetch a dependency the lock does not name and rewrite
   * the lock while doing it — at tag time, from a tagged commit.
   */
  it("compiles under the isolation flags, wherever a workflow compiles", function* () {
    const workflows = new URL("../../.github/workflows/", import.meta.url);
    const compiles: string[] = [];

    for (const entry of yield* readdir(workflows)) {
      // Executable lines only: several of these files name `deno compile` in a
      // comment, and a comment compiles nothing.
      const commands = (yield* readTextFile(new URL(entry, workflows)))
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      if (!commands.includes("deno compile")) {
        continue;
      }
      // Every compile in the file, not only the first: a workflow may compile
      // more than one entrypoint, and reading to a single named one would let
      // the first invocation's flags answer for all of them.
      //
      // A folded shell command: read from `deno compile` to the entrypoint that
      // ends it — the first `.ts` path after the flags — so line breaks and
      // continuations do not matter.
      for (const invocation of commands.split("deno compile").slice(1)) {
        const entrypoint = invocation.search(/\S+\.ts\b/);
        const flags = entrypoint === -1 ? invocation : invocation.slice(0, entrypoint);
        for (const flag of ["--node-modules-dir=none", "--cached-only", "--frozen"]) {
          if (!flags.includes(flag)) {
            compiles.push(`${entry} compiles without ${flag}`);
          }
        }
      }
    }

    expect(compiles).toEqual([]);
  });

  /**
   * A build installs nothing (AGENTS.md), so every workflow that builds on a
   * fresh checkout prepares first. Left out, the release fails at the preflight
   * rather than producing a bundle-less binary — but it fails at tag time,
   * which is the wrong moment to find out.
   */
  it("prepares dependencies before building, in every workflow that builds", function* () {
    for (const workflow of [RELEASE_WORKFLOW, PUBLISH_ONE_WORKFLOW]) {
      const steps = (yield* readTextFile(workflow))
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"));
      const deps = steps.findIndex((line) => line.includes("deno task deps"));
      const build = steps.findIndex((line) => line.includes("deno task build:web"));

      expect({ workflow: workflow.pathname, deps: deps > -1 && deps < build }).toEqual({
        workflow: workflow.pathname,
        deps: true,
      });
    }
  });
});

describe("publish-packages.yml membership", () => {
  it("publishes every non-private member to npm", function* () {
    const all = yield* members();
    const generated = yield* workflow();

    // Non-vacuous: the workspace always has publishable members.
    expect(all.filter((member) => !member.isPrivate).length).toBeGreaterThan(0);

    for (const member of all.filter((member) => !member.isPrivate)) {
      expect(generated).toContain(`package: ${member.dir}`);
    }
  });

  it("gives every non-private member a JSR identity and no private member one", function* () {
    for (const member of yield* members()) {
      expect({ dir: member.dir, jsr: member.hasJsrIdentity }).toEqual({
        dir: member.dir,
        jsr: !member.isPrivate,
      });
    }
  });

  /**
   * The exclusion itself is currently unexercised: `packages/web` was the one
   * private member, and it is published as of #195. The assertion is kept rather
   * than deleted because it costs nothing and starts working the moment a private
   * member exists again — but until one does, nothing here proves the generator
   * skips it, and the guarantee rests on §3 of the release spec alone.
   */
  it("withholds any private member from npm", function* () {
    const withheld = (yield* members()).filter((member) => member.isPrivate);
    const generated = yield* workflow();

    for (const member of withheld) {
      expect(generated).not.toContain(`package: ${member.dir}`);
    }
  });
});
