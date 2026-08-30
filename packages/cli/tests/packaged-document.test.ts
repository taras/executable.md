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
    // And it holds the authorship rule that makes what the coding agent returns
    // a Plan rather than a script: a title, readable steps, and the component
    // that carries each one out beside it.
    expect(source).toContain("Begin the Plan with one level-one Markdown title that describes it.");
    expect(source).toContain("Write the Plan as a sequence of readable steps.");
    expect(source).toContain("Follow each step with the XMD\ncomponent that carries it out.");
    // The worked example is itself a titled Plan.
    expect(source).toContain("# Ask for and save your age");
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
