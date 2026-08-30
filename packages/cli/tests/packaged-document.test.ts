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
  PROMPT_PLAN,
  readPackagedDocument,
} from "../src/packaged-document.ts";
import { useWorkingDirectory } from "./support/prompt-harness.ts";

describe("packaged documents", () => {
  it("reads the plan program from beside its module, whatever the cwd is", function* () {
    // A temporary contextual cwd with no document in it. A lookup that reached
    // for the working directory would find nothing here, and one that reached
    // through the component search path would be answerable by a repository
    // file — neither may decide which program this command runs.
    const source = yield* useWorkingDirectory(function* () {
      return yield* readPackagedDocument(PROMPT_PLAN);
    });

    expect(source).toBe(yield* readTextFile(fileURLToPath(packagedDocumentUrl(PROMPT_PLAN))));
    // It is the plan program, not merely some file that exists.
    expect(source).toContain("returns:");
    expect(source).toContain("<ValidateCandidate");
    expect(source).toContain("<Fail");
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
