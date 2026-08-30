/**
 * The documents the CLI ships and executes itself.
 *
 * `xmd prompt` runs a first-party Markdown program, so that program has to be
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
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";

import {
  packagedDocumentUrl,
  PROMPT_COMMAND_DOCUMENT,
  readPackagedDocument,
} from "../src/packaged-document.ts";
import { useWorkingDirectory } from "./support/prompt-harness.ts";

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
  "# `xmd prompt` turns steps into a program",
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
  "you approve it. After approval, `xmd prompt` validates the exact source again. By",
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
  it("reads the prompt command document from beside its module, whatever the cwd is", function* () {
    // A temporary contextual cwd with no document in it. A lookup that reached
    // for the working directory would find nothing here, and one that reached
    // through the component search path would be answerable by a repository
    // file — neither may decide which program this command runs.
    const source = yield* useWorkingDirectory(function* () {
      return yield* readPackagedDocument(PROMPT_COMMAND_DOCUMENT);
    });

    const committed = yield* readTextFile(
      fileURLToPath(packagedDocumentUrl(PROMPT_COMMAND_DOCUMENT)),
    );
    expect(source).toBe(committed);
    // It is the prompt command document, not merely some file that exists.
    expect(source).toContain("returns:");
    expect(source).toContain("<CheckDraft");
    expect(source).toContain("<Fail");
    // The approved introduction, pinned whole. It is what a reader meets first
    // and the only place the command explains itself, so its wording and its
    // punctuation are part of the contract rather than a paraphrase.
    expect(source).toContain(INTRODUCTION);
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
    // A final invalid review offers two ways out, and the prose says so.
    expect(source).toContain(
      "the two\nremaining choices are to ask the coding agent what went wrong, or to stop.",
    );
    // Every visible stage of the workflow is a heading somebody can audit.
    for (const heading of [
      "# `xmd prompt` turns steps into a program",
      "## Create the first draft",
      "## Check and repair the draft",
      "## Review the draft",
      "## Continue from your decision",
      "## Return the approved Plan",
    ]) {
      expect(source).toContain(`${heading}\n`);
    }
    // It captures the serialized problems with `<Json as>` directly. The
    // single-child `<Let>` wrapper existed only because the component refused a
    // literal `as`, and main supplies that now.
    expect(source).toContain('<Json value={check.diagnostics} as="problems" />');
    // The closing branch is an unexpected-no-decision fallback, not a second
    // copy of exhaustion: exhaustion is decided inside review, and saying it
    // twice would make the two endings indistinguishable to a reader.
    expect(source).toContain(
      '<Fail message="xmd prompt ended without an approved Plan. Nothing was output or run." />',
    );
    expect(source.split("reviewed ten drafts without an approved Plan").length - 1).toBe(2);
    // The choices are the words a person reads, with no internal spelling
    // behind them.
    expect(source).toContain('["Approve", "Request changes", "Stop"]');
    expect(source).toContain('["Explain what went wrong", "Stop"]');
    expect(source).not.toContain('"revise"');
    expect(source).not.toContain('"abort"');
    expect(source).not.toContain('<Let as="problems">');
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
