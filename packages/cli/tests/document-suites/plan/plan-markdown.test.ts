/**
 * Tier PMT — the checked-in Markdown suite for `<Plan>` under `<TestAgent>`,
 * launched once per runtime corpus.
 *
 * The row evidence lives in `Plan.test.md`; this wrapper asserts only that the
 * Markdown suite produced passing rows. What a document cannot observe about
 * itself — which provider the Plan invocation received, under what
 * restrictions, in which authorship root, and what an unconfigured child did
 * before it refused — is `../../testing-execution-host.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runMarkdownTier } from "../../support/run-markdown-tier.ts";

describe(
  "Tier PMT — checked-in Markdown suite",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("runs Plan.test.md once under the production run host", function* () {
      const run = yield* runMarkdownTier("packages/cli/tests/document-suites/plan/Plan.test.md");
      if (!run.completion.ok) {
        throw run.completion.error;
      }
      expect(run.results.length).toBeGreaterThan(0);
      for (const result of run.results) {
        expect(result.status).toBe("pass");
      }
    });
  },
);
