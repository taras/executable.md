/**
 * Tier IE — the checked-in Markdown suite, launched once per runtime corpus
 * (quest #543, issue #583).
 *
 * Suite infrastructure, not a second proof of any row: the row evidence is in
 * `Inline.test.md`, and this file asserts only that the one execution
 * succeeded and that its results are non-empty and all passing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runMarkdownTier } from "../../support/run-markdown-tier.ts";

describe("Tier IE — checked-in Markdown suite", () => {
  it("runs Inline.test.md once under the production run host", function* () {
    const run = yield* runMarkdownTier("packages/cli/tests/document-suites/inline/Inline.test.md");
    if (!run.completion.ok) {
      throw run.completion.error;
    }
    expect(run.results.length).toBeGreaterThan(0);
    for (const result of run.results) {
      expect(result.status).toBe("pass");
    }
  });
});
