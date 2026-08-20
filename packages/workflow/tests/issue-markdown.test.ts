/**
 * Tier WI — the `<Issue>` contract, as its own documents state it.
 *
 * The scenarios live in `tests/scenarios/*.test.md` and are the evidence: a
 * reviewer reads the Markdown, not a string a test assembled. This file is the
 * thin part — it reads each checked-in document, runs it against the fixture
 * host, and reports what each `<Test>` in it decided as a step of its own.
 *
 * What stays in TypeScript is what a document cannot construct: GitHub payload
 * parsing, pagination, marker reconciliation and serialization live in
 * `issue-github.test.ts`, and nothing there duplicates a scenario here.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { fileURLToPath } from "node:url";
import type { Operation } from "effection";
import { runScenario } from "./support/issue-fixture.ts";
import type { ScenarioRun } from "./support/issue-fixture.ts";

/** The scenarios, in the order a reader meets them. */
const SCENARIOS = [
  "Issue.test.md",
  "IssueRouting.test.md",
  "IssueDurability.test.md",
  "IssueRecovery.test.md",
] as const;

function pathOf(name: string): string {
  return fileURLToPath(new URL(`./scenarios/${name}`, import.meta.url));
}

/**
 * Every test in one document, or the reason there were none.
 *
 * A document that failed before its tests ran reports zero results, which is
 * indistinguishable from a document with no tests — so the count is asserted
 * rather than assumed, and the document's own failure is surfaced first.
 */
function* scenario(name: string): Operation<ScenarioRun> {
  const run = yield* runScenario(pathOf(name));
  if (run.thrown !== undefined) {
    throw run.thrown;
  }
  expect(run.results.length).toBeGreaterThan(0);
  return run;
}

describe("workflow Issue scenarios", () => {
  for (const name of SCENARIOS) {
    it(`${name} states a contract that holds`, function* () {
      const run = yield* scenario(name);
      // Named individually, so a failure says which scenario broke and where,
      // rather than how many did.
      const failed = run.results
        .filter((result) => result.status === "fail")
        .map((result) => `${result.name ?? result.location}: ${result.error?.message ?? ""}`);
      expect(failed).toEqual([]);
    });
  }
});
