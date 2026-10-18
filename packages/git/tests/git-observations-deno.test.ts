/**
 * Tier GO9, the half that needs a runtime which operates repositories.
 *
 * One case, kept apart from `git-observations.test.ts` because its subject is a
 * *managed* selection: it clones a remote into a managed root and adds a
 * worktree, which this repository holds under a kernel-released exclusive
 * advisory lock taken through the Deno runtime. Node and Bun expose no
 * equivalent, so there the document cannot reach the checkout at all and the
 * case fails on the lock rather than on anything it asserts.
 *
 * Everything else about which checkout answers stays portable and stays in
 * `git-observations.test.ts`: the sibling checkouts distinguished by content,
 * and the foreign and edited selections refused before a host is reached. What
 * only this file can observe is that an ambient checkout, a lexical Repository,
 * a Worktree and a `<Dir>` inside one each answer from their own checkout.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Json } from "@executablemd/durable-streams";
import { capturingProbe, writeFixtureFile } from "./support/observations.ts";
import { runOrdinaryDocument, useHostCheckout, useManagedRoot } from "./support/run-composition.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { REMOTE } from "./support/run-composition-tier.ts";

/** The one bound value a case's document projected, as an object. */
function object(value: Json | undefined): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected one bound object, received ${JSON.stringify(value)}`);
  }
  return value;
}

function paths(value: Json | undefined): string[] {
  const listed = object(value).paths;
  if (!Array.isArray(listed)) {
    throw new Error(`expected a paths array, received ${JSON.stringify(listed)}`);
  }
  return listed.map((entry) => String(entry));
}

describe("GO9 — which checkout answers, through a managed selection", () => {
  it("reads the ambient checkout, a lexical Repository, a Worktree and a Dir inside one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const ambient = yield* useHostCheckout(remote.locator);
    yield* writeFixtureFile(ambient.root, "only-here.txt", "ambient\n");
    ambient.run("add", "--", "only-here.txt");
    ambient.run("commit", "-m", "ambient only");
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Files limit={100} as="here" />',
        "",
        "<Captured value={here} />",
        "",
        `<Repository name="project" url="${remote.locator}">`,
        "",
        '<Git.Files limit={100} as="managed" />',
        "",
        "<Captured value={managed} />",
        "",
        '<Worktree name="side" branch="side">',
        "",
        '<Git.Changes compare="unstaged" as="inSide" />',
        "",
        "<Captured value={inSide} />",
        "",
        '<Dir path="deeper">',
        "",
        '<Git.Files limit={100} as="fromDir" />',
        "",
        "<Captured value={fromDir} />",
        "",
        "</Dir>",
        "",
        "</Worktree>",
        "",
        "</Repository>",
        "",
      ].join("\n"),
      { root, cwd: ambient.root, components: [capturingProbe(seen)] },
    );

    // The ambient checkout holds a path the managed clone never received, which
    // is how a read that answered from the wrong one would say so.
    expect(paths(seen[0])).toContain("only-here.txt");
    expect(paths(seen[1])).toEqual(["which.txt"]);
    expect(object(seen[2]).changes).toEqual([]);
    // A `<Dir>` beneath a Worktree stays inside that checkout, and the answer
    // is still relative to its repository root.
    expect(paths(seen[3])).toEqual(["which.txt"]);
  });
});
