/**
 * The documents the CLI ships and executes itself.
 *
 * `xmd plan` runs a first-party Markdown program, so that program has to be
 * present and identical wherever the command is. This suite runs under Deno,
 * Node and Bun, which is what makes it evidence: the lookup is package-relative,
 * and a resolution that only works under the runtime the author happened to use
 * is the failure this catches.
 *
 * The compiled binary and the published npm package are proven where those
 * artifacts exist — `scripts/tests/cli-npm-bin.test.ts` for the package, and the
 * `dist/xmd` suites for the binary.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  packagedDocumentUrl,
  PLAN_COMMAND_DOCUMENT,
  PLAN_DOCUMENT,
  readPackagedDocument,
  UPGRADE_COMMAND_DOCUMENT,
} from "../src/packaged-document.ts";
import { useWorkingDirectory } from "./support/plan-harness.ts";

/**
 * The approved introduction, exactly.
 *
 * Pinned rather than sampled: this is the passage the product contract settled,
 * down to the typographic apostrophe in "coding agent’s plan". A paraphrase that
 * still contained the chosen sentences would pass a looser check while saying
 * something else, and an ASCII apostrophe here would quietly redefine the
 * approved wording around whatever the file happens to hold.
 */
const INTRODUCTION = [
  "# `xmd plan` turns steps into a program",
  "",
  "This document is a workflow that generates an executable Plan from a sequence of",
  "steps. It combines the original Prompt, which describes those steps, with the XMD",
  "components available to carry them out. A coding agent turns both into one",
  "document that explains and executes the sequence.",
  "",
  "The result is the XMD version of a coding agent’s plan. A conventional Markdown",
  "plan must be interpreted again before its steps can happen. An XMD Plan already",
  "contains those executable steps, so running it simply executes them.",
  "",
  "A draft remains text while this workflow reviews it. Nothing in it runs before",
  "you approve it. After approval, `xmd plan` validates the exact source again. By",
  "default it prints the approved XMD source. `--output` writes that source to a",
  "file instead, and `--run` executes the Plan. With both options, the command",
  "writes the source before running it.",
].join("\n");

/** What every turn that asks for a Plan has to say, on its own. */
const PLAN_REQUIREMENTS = [
  "Every Plan is complete on its own:",
  "",
  "- optional frontmatter, and then one descriptive level-one Markdown heading as",
  "  the first body content;",
  "- the Prompt's complete sequence, written as readable steps;",
  "- every outcome the Prompt asked for;",
  "- those steps in an order that makes sense; and",
  "- each XMD component beside the prose describing the action it performs.",
].join("\n");

describe("packaged documents", () => {
  it("reads the plan command document from beside its module, whatever the cwd is", function* () {
    // A temporary contextual cwd with no document in it. A lookup that reached
    // for the working directory would find nothing here, and one that reached
    // through the component search path would be answerable by a repository
    // file — neither may decide which program this command runs.
    const source = yield* useWorkingDirectory(function* (dir) {
      // A file of the same name, in the directory a person is standing in. A
      // lookup that resolved the working directory would read this one, and a
      // program a repository file can replace is not the program that shipped.
      yield* writeTextFile(join(dir, PLAN_COMMAND_DOCUMENT), "# not the shipped program\n");
      return yield* readPackagedDocument(PLAN_COMMAND_DOCUMENT);
    });

    const committed = yield* readTextFile(
      fileURLToPath(packagedDocumentUrl(PLAN_COMMAND_DOCUMENT)),
    );
    expect(source).toBe(committed);
    // It is the plan command document, not merely some file that exists.
    expect(source).toContain("returns:");
    // The approved introduction, pinned whole. It is what a reader meets first
    // and the only place the command explains itself, so its wording and its
    // punctuation are part of the contract rather than a paraphrase.
    expect(source).toContain(INTRODUCTION);
    // And it is an adapter rather than a second implementation: it hands the request to
    // `<Plan>` and returns what comes back. Every phase of authorship — the
    // turns, the checking, the review, the endings — is in the one Component the
    // next case reads, so a second copy of any of it here would be exactly the
    // drift having one Component source exists to prevent.
    expect(source).toContain('<Plan session={props.session} as="approved">{props.request}</Plan>');
    expect(source).toContain("<Return value={approved} />");
    for (const authored of [
      "<CheckDraft",
      "<Prompt",
      "<Elicit",
      "<Session",
      "<Loop",
      PLAN_REQUIREMENTS,
    ]) {
      expect(source).not.toContain(authored);
    }
  });

  it("reads the packaged <Plan> Component from beside its module, whatever the cwd is", function* () {
    const source = yield* useWorkingDirectory(function* (dir) {
      // The same substitution attempt as above, against the asset that now
      // holds the Component: a repository `Plan.md` beside the caller must not be
      // able to answer for the program this build ships.
      yield* writeTextFile(join(dir, PLAN_DOCUMENT), "# not the shipped Component\n");
      return yield* readPackagedDocument(PLAN_DOCUMENT);
    });

    const committed = yield* readTextFile(fileURLToPath(packagedDocumentUrl(PLAN_DOCUMENT)));
    expect(source).toBe(committed);

    // It is a Markdown text component a document invokes, not a root a command
    // runs: one optional `session` prop, no declared return, and one top-level
    // `<Output>` selecting the approved source as the whole of its rendering.
    expect(source).not.toContain("returns:");
    expect(source).toContain("session: { type: string, minLength: 1 }");
    expect(source).toContain("<Output>{admitted}</Output>");
    expect(source).not.toContain("<Return");
    expect(source).toContain("<CheckDraft");
    expect(source).toContain("<Fail");
    // The caller's Prompt is projected once, before anything is prepared.
    expect(source).toContain('<Let as="prompt"><Content /></Let>');
    // And it holds the authorship rule that makes what the coding agent returns
    // a Plan rather than a script — stated once per turn that asks for a Plan,
    // which is the initial draft, the repair and the revision.
    expect(source.split(PLAN_REQUIREMENTS).length - 1).toBe(3);
    // A replacement writes the title the Plan needs; it is not told to keep one.
    expect(
      source.split("Write the title the Plan needs rather than the one the last draft had").length -
        1,
    ).toBe(2);
    // The worked example is itself a titled Plan.
    expect(source).toContain("# Ask for and save your age");
    // A tenth draft that could not be repaired is not a review at all, and the
    // prose says why: there is no decision left to offer.
    expect(source).toContain(
      "there is no decision left for you to make, and\nthis workflow does not ask you to make one.",
    );
    // Every visible stage of the workflow is a heading somebody can audit.
    for (const heading of [
      "## Create the first draft",
      "## Check and repair the draft",
      "## Review the draft",
      "## Continue from your decision",
      "## Explain a tenth draft that could not be repaired",
      "## Produce the approved Plan source",
    ]) {
      expect(source).toContain(`${heading}\n`);
    }
    // It captures the serialized problems with `<Json as>` directly.
    expect(source).toContain('<Json value={check.diagnostics} as="problems" />');
    // Both surfaces' endings are here, in Markdown, and each is written once.
    // A branch decided in TypeScript would put half of what a person reads
    // somewhere a person reading the workflow cannot see it.
    expect(source).toContain(
      '<Let as="unresolved" value="xmd plan ended without an approved Plan. Nothing was output or run." />',
    );
    expect(source).toContain(
      '<Let as="unresolved" value="Plan authorship ended without an approved Plan. No Plan was returned." />',
    );
    // Twice, once per surface: the automatic explanation is the only ending
    // that says it. The authored exhaustion sentence went with the review a
    // tenth invalid draft no longer reaches.
    expect(source.split("reviewed ten drafts without an approved Plan").length - 1).toBe(2);
    // The closing branch is an unexpected-no-decision fallback, not a second
    // copy of exhaustion: exhaustion is decided inside review, and saying it
    // twice would make the two endings indistinguishable to a reader.
    expect(source).toContain("<Fail message={unresolved} />");
    // The choices are the words a person reads, with no internal spelling
    // behind them.
    expect(source).toContain('["Approve", "Request changes", "Stop"]');
    // A tenth draft that could not be repaired is explained automatically, so
    // there is no decision to offer and no question naming one.
    expect(source).not.toContain('"Explain what went wrong"');
    expect(source).not.toContain('"revise"');
    expect(source).not.toContain('"abort"');
    expect(source).not.toContain('<Let as="problems">');
  });

  it("reads the upgrade command document from beside its module too", function* () {
    // The same package-relative lookup, and the same thing it must refuse to
    // do: a file of this name in the directory a person is standing in must not
    // become the program that decides whether their binary is replaced.
    const source = yield* useWorkingDirectory(function* (dir) {
      yield* writeTextFile(
        join(dir, UPGRADE_COMMAND_DOCUMENT),
        "# not the shipped program\n<Return value={`replaced`} />\n",
      );
      return yield* readPackagedDocument(UPGRADE_COMMAND_DOCUMENT);
    });

    const committed = yield* readTextFile(
      fileURLToPath(packagedDocumentUrl(UPGRADE_COMMAND_DOCUMENT)),
    );
    expect(source).toBe(committed);

    // The command is an ordinary streaming text root: its rendered body is the
    // terminal experience, not a hidden program that synthesizes one string.
    for (const absent of ["<Return", "<Output", "\nreturns:"]) {
      expect({ absent, present: source.includes(absent) }).toEqual({ absent, present: false });
    }
    // The entrypoint matrix, in the words the product settled on. "Unix" was
    // ruled out as ambiguous, and the two named platforms are the contract.
    expect(source).not.toContain("Unix");
    // The four phases the private profile declares, and nothing else.
    expect([...source.matchAll(/<Upgrade\.[A-Za-z]+/g)].map((match) => match[0]).sort()).toEqual([
      "<Upgrade.Download",
      "<Upgrade.Releases",
      "<Upgrade.Replace",
      "<Upgrade.Verify",
    ]);
    // Precedence comes from the package, and the exact spelling policy stays
    // here: a handwritten numeric comparison is what this refuses to become.
    expect(source).toContain('from "semver"');
    expect(source).not.toContain("Number(");
    expect(source).not.toContain("parseInt");
    // Nothing in this program touches the caller's machine. Every act that
    // does belongs to the four phases above.
    for (const absent of ["```bash", "```sh", "<File", "<Fetch", "<Agent", "<Elicit"]) {
      expect({ absent, present: source.includes(absent) }).toEqual({ absent, present: false });
    }
  });

  it("says which build is missing a document rather than behaving differently", function* () {
    // The failure a forgotten `deno compile --include` or npm asset copy
    // produces. It names the path it looked at, because that is the difference
    // between the four builds and the only thing worth reporting.
    let failure: Error | undefined;
    try {
      yield* readPackagedDocument("no-such-document.md");
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    expect(failure?.message).toContain("no-such-document.md is missing from this build");
    expect(failure?.message).toContain("looked in");
  });
});
