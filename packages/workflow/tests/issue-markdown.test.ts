/**
 * Tier WI — the `<Issue>` contract, as its own documents state it.
 *
 * The scenarios live in `tests/scenarios/*.test.md` and are the evidence: a
 * reviewer reads the Markdown, not a string a test assembled. This file is the
 * thin part — it reads each checked-in document, runs it under a testing
 * session of its own, and reports what that session decided.
 *
 * What stays in TypeScript is what a document cannot construct: GitHub payload
 * parsing, pagination, marker reconciliation and serialization live in
 * `issue-github.test.ts`, and nothing there duplicates a scenario here.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { fileURLToPath } from "node:url";
import type { Operation } from "effection";
import { runScenario, useScenarioFixture } from "./support/issue-scenario.ts";
import type { ScenarioObservation } from "./support/issue-scenario.ts";

/** The scenarios, in the order a reader meets them. */
const SCENARIOS = ["IssueRead.test.md", "IssueUpsert.test.md", "IssueHttp.test.md"] as const;

function pathOf(name: string): string {
  return fileURLToPath(new URL(`./scenarios/${name}`, import.meta.url));
}

/** Which tests failed, named, so a failure says which rather than how many. */
function failures(observation: ScenarioObservation): string[] {
  return observation.results
    .filter((result) => result.status === "fail")
    .map((result) => `${result.name ?? result.location}: ${result.error?.message ?? ""}`);
}

/**
 * One document's outcome, checked against its own session.
 *
 * The execution outcome is the authority. A suite that failed a test settles
 * `Err`, and so does a suite that discovered none — so a document whose tests
 * never ran cannot pass here by having nothing to fail. The named failures are
 * asserted first only because they read better than the wrapped message.
 */
function* stated(observation: ScenarioObservation): Operation<ScenarioObservation> {
  expect(failures(observation)).toEqual([]);
  if (!observation.outcome.ok) {
    throw observation.outcome.error;
  }
  expect(observation.results.length).toBeGreaterThan(0);
  return observation;
}

describe("workflow Issue scenarios", () => {
  for (const name of SCENARIOS) {
    it(`${name} states a contract that holds`, function* () {
      yield* stated(yield* runScenario(pathOf(name)));
    });
  }

  it("IssueDurability.test.md states a contract that holds", function* () {
    const fixture = yield* useScenarioFixture();
    // Staged from the one checked-in attempt document, twice. The second is a
    // replay: same run, same document, same request — which is the only way to
    // put a run in the state this scenario is about.
    yield* fixture.stage("IssueDurability.attempt.stage.md");
    yield* fixture.stage("IssueDurability.attempt.stage.md");
    yield* stated(yield* fixture.observe(pathOf("IssueDurability.test.md")));
  });

  it("IssueReadDurability.test.md states a contract that holds", function* () {
    const fixture = yield* useScenarioFixture();
    yield* fixture.stage("IssueReadDurability.attempt.stage.md");
    yield* fixture.stage("IssueReadDurability.attempt.stage.md");
    yield* stated(yield* fixture.observe(pathOf("IssueReadDurability.test.md")));
  });

  // Each hazard is its own run. They cannot share one: a process that ended
  // after its create ended, so a second request in the same execution is a
  // request that could never have been made.
  for (const hazard of [
    "IssueRecoveryUnavailable",
    "IssueRecoveryDuplicated",
    "IssueRecoveryMoved",
    "IssueRecoveryClosed",
    "IssueRecoveryEdited",
  ]) {
    it(`${hazard}.test.md states a contract that holds`, function* () {
      const fixture = yield* useScenarioFixture();
      yield* fixture.stage(`${hazard}.attempt.stage.md`);
      yield* fixture.stage(`${hazard}.attempt.stage.md`);
      yield* stated(yield* fixture.observe(pathOf(`${hazard}.test.md`)));
    });
  }

  it("IssueRecovery.test.md states a contract that holds", function* () {
    const fixture = yield* useScenarioFixture();
    // The interrupted attempt first, then one that inherits what it left.
    yield* fixture.stage("IssueRecovery.attempt.stage.md");
    yield* fixture.stage("IssueRecovery.attempt.stage.md");
    yield* stated(yield* fixture.observe(pathOf("IssueRecovery.test.md")));
  });
});

/**
 * Tier WI-S — what one fixture shares between documents, and what it does not.
 *
 * The runner puts each execution in a child scope holding one complete
 * `useTesting()` session and one document, and keeps the tracker, the journals
 * and the provider middleware in the enclosing scope. These are the two halves
 * of that arrangement: state crosses between documents, results do not, and a
 * document whose assertion fails fails.
 */
describe("scenario sessions", () => {
  const sessions = (name: string) => pathOf(`sessions/${name}`);

  it("shares one tracker between documents that each get their own session", function* () {
    const fixture = yield* useScenarioFixture();

    const first = yield* fixture.observe(sessions("First.test.md"));
    const second = yield* fixture.observe(sessions("Second.test.md"));

    // Non-empty and disjoint: each document reports its own test and only
    // its own, which is what a session per execution buys. A cumulative
    // session would show the first document's result in the second's.
    expect(first.results.map((result) => result.name)).toEqual([
      "the first document sees the tracker it filed on",
    ]);
    expect(second.results.map((result) => result.name)).toEqual([
      "the second document meets the first document's tracker",
    ]);

    // Both passed, and the second's passing is the shared half: it asserted
    // on an issue the first document filed, so the fixture outlived the
    // scope the first session closed.
    expect(failures(first)).toEqual([]);
    expect(failures(second)).toEqual([]);
    expect(first.outcome.ok).toBe(true);
    expect(second.outcome.ok).toBe(true);
    expect(fixture.server.issues.map((issue) => issue.title)).toEqual([
      "Filed by the first document",
    ]);
  });

  it("fails the document whose assertion fails, and no other", function* () {
    const fixture = yield* useScenarioFixture();

    const failing = yield* fixture.observe(sessions("Failing.test.md"));
    expect(failing.results.map((result) => result.status)).toEqual(["fail"]);
    expect(failing.outcome.ok).toBe(false);

    // The next document is unharmed, which is the claim that matters: a
    // failure belongs to the session that recorded it, so a passing document
    // observed after a failing one still settles Ok with its own result.
    const after = yield* fixture.observe(sessions("Passing.test.md"));
    expect(after.results.map((result) => result.status)).toEqual(["pass"]);
    expect(after.outcome.ok).toBe(true);
  });

  it("fails a document that discovered no tests at all", function* () {
    const fixture = yield* useScenarioFixture();
    // The hazard this arrangement exists to remove: activation that did not
    // take renders a document full of passing assertion reports and collects
    // nothing. The session's completion policy is what makes that an `Err`
    // rather than a silent success. Tracked separately as
    // taras/executable.md#523 for the testing API itself.
    const empty = yield* fixture.observe(sessions("Untested.md"));
    expect(empty.results).toEqual([]);
    expect(empty.outcome.ok).toBe(false);
  });
});
