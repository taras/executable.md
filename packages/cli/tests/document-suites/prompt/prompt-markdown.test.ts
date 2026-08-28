/**
 * Tier PR — the checked-in Markdown suite for the prompt prototype, launched
 * once per runtime corpus (quest #543, issue #583).
 *
 * Suite infrastructure, not a second proof of any row: the row evidence is in
 * `Prompt.test.md`, and this file asserts only that the one execution succeeded
 * and that its results are non-empty and all passing.
 *
 * The suite drives `packages/cli/src/prompt.md` as a real child execution, so
 * what it proves is the document `xmd run` would run rather than a
 * reconstruction of it. Determinism comes from the document's own side —
 * `<TestAgent>` scripts the Agent and `<Answers>` supplies the review decisions
 * — so nothing here installs a provider of its own.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runMarkdownTier } from "../../support/run-markdown-tier.ts";

describe("Tier PR — checked-in Markdown suite", () => {
  it("runs Prompt.test.md once under the production run host", function* () {
    const run = yield* runMarkdownTier("packages/cli/tests/document-suites/prompt/Prompt.test.md");
    if (!run.completion.ok) {
      throw run.completion.error;
    }
    expect(run.results.length).toBeGreaterThan(0);
    for (const result of run.results) {
      expect(result.status).toBe("pass");
    }
  });
});
