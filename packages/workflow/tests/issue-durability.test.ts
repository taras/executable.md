/**
 * Tier WF — what an `<Issue>` retains, replays and refuses to guess.
 *
 * The claims here are about the run's database and the Git host together. A
 * replayed issue must reach no host, read no credential and append no second
 * record; an issue an interrupted attempt already created must be adopted
 * rather than created twice; a retained record that no longer describes the
 * invocation it was recorded for must stop the run rather than be read around;
 * a cancelled creation must leave the journal exactly as it found it; and what
 * public routing middleware sees must be the frozen request and nothing that
 * can answer for it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, scoped, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { GitOperationProtocolError } from "../src/composition/errors.ts";
import { GitHost } from "../src/git-host/api.ts";
import type { GitHostCall } from "../src/git-host/api.ts";
import { GitHostProtocolError } from "../src/git-host/errors.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect.ts";
import { ISSUE } from "../src/composition/issue-records.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../src/deno/composition/github.ts";
import { runPath, tamper, useStorageRoot } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { causedBy, gitHostOutcomes, raised, runWorkflowDocument } from "./support/composition.ts";
import { issueCalls, issueCreations, issuePatches, respond } from "./support/github.ts";
import { dropRootClose } from "./support/replay.ts";
import { fixture, LOCATOR, REMOTE, TOKEN } from "./support/pull-requests.ts";
import {
  deferring,
  ISSUE_TITLE,
  RUN,
  recorded,
  attemptWorkflow,
  answer,
  waitOf,
} from "./support/issues.ts";

function isProtocolFailure(value: unknown): value is GitOperationProtocolError {
  return value instanceof GitOperationProtocolError;
}

function isHostProtocolFailure(value: unknown): value is GitHostProtocolError {
  return value instanceof GitHostProtocolError;
}

/**
 * A Git host that refuses to be reached at all.
 *
 * What a completed replay is claimed to need: no adapter, no credential and no
 * request. Reaching for any of the three fails the run here rather than quietly
 * succeeding against a host that happens to still hold the answer.
 */
function unreachable(): GitHubAccess {
  return {
    endpoint: "https://api.github.test",
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      throw new Error("a replay read a credential");
    },
    // deno-lint-ignore require-yield
    *send(): Operation<GitHubHttpResponse> {
      throw new Error("a replay reached the Git host");
    },
  };
}

/** Every journal row holding one issue reconciliation, and what it holds. */
function eachIssueRecord(
  path: string,
  visit: (record: Record<string, unknown>) => "keep" | "drop",
): number {
  let matched = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      const description = Object(Reflect.get(Object(parsed), "description"));
      if (Reflect.get(description, "type") !== GIT_HOST_EFFECT) {
        continue;
      }
      const value = Object(Object(Reflect.get(Object(parsed), "result")).value);
      if (Reflect.get(Object(Reflect.get(value, "request")), "kind") !== ISSUE) {
        continue;
      }
      matched += 1;
      if (visit(value) === "drop") {
        database.prepare("DELETE FROM journal_events WHERE sequence = ?").run(row["sequence"]);
      } else {
        database
          .prepare("UPDATE journal_events SET record = ? WHERE sequence = ?")
          .run(JSON.stringify(parsed), row["sequence"]);
      }
    }
  });
  return matched;
}

/**
 * Damage the one retained issue record, and refuse if it damaged none.
 *
 * A tamper that matched nothing leaves the run healthy, and a regression built
 * on one passes by replaying an undamaged record.
 */
function damageRecord(path: string, damage: (record: Record<string, unknown>) => void): void {
  const matched = eachIssueRecord(path, (record) => {
    damage(record);
    return "keep";
  });
  if (matched !== 1) {
    throw new Error(`the journal holds ${matched} issue reconciliation records`);
  }
}

/**
 * Take the issue's retained result away, leaving what the Git host holds.
 *
 * The state an interrupted attempt leaves: the issue exists at the host, and
 * this run's own history has no result for it. It is the gap the whole
 * reconciliation exists for, and the only way to reach it without killing a
 * process is to remove the record a completed one appended.
 */
function dropIssueRecord(path: string): void {
  const matched = eachIssueRecord(path, () => "drop");
  if (matched !== 1) {
    throw new Error(`the journal holds ${matched} issue reconciliation records`);
  }
}

describe("workflow Issue durability", () => {
  it("replays without reaching a Git host or appending a second record", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, RUN);
    const run = fixture(remote);

    const { second } = yield* recorded(root, deferring(), run.options, {
      *after(database) {
        const retained = yield* gitHostOutcomes(database);
        expect(retained).toHaveLength(3);

        dropRootClose(path);

        // The issue this run created is closed and retitled after the record
        // commits. What the run retained is what it recorded; none of this can
        // change it.
        const created = run.store.issues[0];
        if (created !== undefined) {
          created.state = "closed";
          created.title = "Something else entirely";
        }

        const replayed = String(
          yield* runWorkflowDocument(database, deferring(), {
            composition: { host: run.counting.host, gitHub: unreachable() },
          }),
        );

        // The same evidence, from the journal, with no adapter selected, no
        // credential read and no request sent.
        expect(replayed).toContain(`recorded ${created?.number}`);
        expect(yield* gitHostOutcomes(database)).toEqual(retained);
        expect(issueCreations(run.store)).toBe(1);
      },
    });

    expect(second.thrown).toBeUndefined();
  });

  it("adopts the issue an interrupted attempt already created", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, RUN);
    const run = fixture(remote);

    yield* recorded(root, deferring(), run.options, {
      *after(database) {
        dropRootClose(path);
        dropIssueRecord(path);
        run.store.requests.length = 0;

        yield* runWorkflowDocument(database, deferring(), run.options);

        // Observed, recognized, and left exactly as it was: one listing and no
        // mutation at all.
        expect(issueCreations(run.store)).toBe(0);
        expect(issuePatches(run.store)).toBe(0);
        expect(issueCalls(run.store)).toEqual(["GET /repos/octo/project/issues"]);
        expect(run.store.issues).toHaveLength(1);

        const outcomes = yield* gitHostOutcomes(database);
        const record = parseGitHostReconciliationRecord(outcomes[2]?.record);
        expect(record?.decision).toBe("adopted");
        expect(record?.preState).toEqual(record?.observations);
      },
    });
  });

  it("brings an issue whose text somebody moved back to what this run decided", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, RUN);
    const run = fixture(remote);

    yield* recorded(root, deferring(), run.options, {
      *after(database) {
        dropRootClose(path);
        dropIssueRecord(path);
        run.store.requests.length = 0;
        const created = run.store.issues[0];
        if (created !== undefined) {
          created.title = "Something else entirely";
        }

        yield* runWorkflowDocument(database, deferring(), run.options);

        // One patch, one confirming observation, and no second issue.
        expect(issuePatches(run.store)).toBe(1);
        expect(issueCreations(run.store)).toBe(0);
        expect(run.store.issues).toHaveLength(1);
        expect(run.store.issues[0]?.title).toBe(ISSUE_TITLE);

        const outcomes = yield* gitHostOutcomes(database);
        const record = parseGitHostReconciliationRecord(outcomes[2]?.record);
        expect(record?.decision).toBe("performed");
        expect(Object(Object(record?.preState).issue).title).toBe("Something else entirely");
      },
    });
  });

  const DAMAGE: Array<{ name: string; damage: (record: Record<string, unknown>) => void }> = [
    {
      name: "names another Repository",
      damage: (record) => {
        Object(Object(record.result).repository).name = "ghost";
      },
    },
    {
      name: "names another finding",
      damage: (record) => {
        Object(record.result).finding = "F-99";
      },
    },
    {
      name: "names a pull request the request does not describe",
      damage: (record) => {
        Object(Object(record.result).pullRequest).number = 99;
      },
    },
    {
      name: "disagrees with its own observations",
      damage: (record) => {
        Object(record.result).number = 99;
      },
    },
    {
      name: "observed an issue the request does not describe",
      damage: (record) => {
        Object(Object(record.observations).issue).title = "Something else";
      },
    },
    {
      name: "claims a decision its pre-state cannot support",
      damage: (record) => {
        record.decision = "adopted";
      },
    },
    {
      name: "holds a state this effect never produces",
      damage: (record) => {
        Object(record.result).state = "closed";
        Object(Object(record.observations).issue).state = "closed";
      },
    },
    {
      name: "holds a number that is not one",
      damage: (record) => {
        Object(record.result).number = 0;
      },
    },
  ];

  for (const { name, damage } of DAMAGE) {
    it(`fails a replay whose retained record ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);
      const path = runPath(root, RUN);
      const run = fixture(remote);

      yield* recorded(root, deferring(), run.options, {
        *after(database) {
          dropRootClose(path);
          damageRecord(path, damage);
          run.store.requests.length = 0;

          const failure = yield* raised(runWorkflowDocument(database, deferring(), run.options));

          expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
          // Nothing was re-observed or re-created to make up for the damage.
          expect(run.store.requests).toHaveLength(0);
        },
      });
    });
  }

  const REKEYED: Array<{ name: string; damage: (record: Record<string, unknown>) => void }> = [
    {
      name: "is keyed under another pull request",
      damage: (record) => {
        Object(Object(record.request).naturalKey).pullRequestIdentity = "PR_node_other";
      },
    },
    {
      name: "asks for text this invocation never wrote",
      damage: (record) => {
        Object(Object(record.request).inputs).rationale = "for no reason at all";
      },
    },
  ];

  for (const { name, damage } of REKEYED) {
    it(`fails a replay whose retained record ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);
      const path = runPath(root, RUN);
      const run = fixture(remote);

      yield* recorded(root, deferring(), run.options, {
        *after(database) {
          dropRootClose(path);
          damageRecord(path, damage);
          run.store.requests.length = 0;

          const failure = yield* raised(runWorkflowDocument(database, deferring(), run.options));

          // The key and the inputs are part of the request, so the shared engine
          // refuses them before this effect's own reader is reached at all.
          expect(causedBy(failure, isHostProtocolFailure)).toBeInstanceOf(GitHostProtocolError);
          expect(run.store.requests).toHaveLength(0);
        },
      });
    });
  }

  it("publishes nothing when a blocked creation is halted", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);
    const creating = withResolvers<void>();

    // The creation that never answers: the request reaches the host and the
    // cancellation arrives before anything came back.
    const blocking: GitHubAccess = {
      endpoint: "https://api.github.test",
      // deno-lint-ignore require-yield
      *token(): Operation<string | undefined> {
        return TOKEN;
      },
      *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/issues")) {
          creating.resolve();
          yield* suspend();
        }
        return respond(run.store, request);
      },
    };

    const first = yield* attemptWorkflow(root, "start", deferring(), run.options);
    const delivered = yield* answer(root, waitOf(first).suspensionId, { approved: true });
    expect(delivered.ok).toBe(true);

    const second = yield* attemptWorkflow(
      root,
      "resume",
      deferring(),
      { composition: { host: run.counting.host, gitHub: blocking } },
      { interrupt: creating.operation },
    );

    // A cancelled attempt is not an outcome: no completion was invented, and no
    // failure was published for it either.
    expect(second.outcomes).toHaveLength(2);
    expect(run.store.issues).toHaveLength(0);
  });

  it("shows routing middleware the frozen request and nothing that can answer it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);
    const seen: GitHostCall[] = [];

    const first = yield* attemptWorkflow(root, "start", deferring(), run.options);
    const delivered = yield* answer(root, waitOf(first).suspensionId, { approved: true });
    expect(delivered.ok).toBe(true);

    yield* attemptWorkflow(root, "resume", deferring(), run.options, {
      *after(database) {
        dropRootClose(runPath(root, RUN));
        dropIssueRecord(runPath(root, RUN));
        run.store.requests.length = 0;
        run.store.issues.length = 0;

        yield* runWorkflowDocument(database, deferring(), run.options, (execute) =>
          scoped(function* () {
            yield* GitHost.around({
              *route([call], next): Operation<unknown> {
                seen.push(call);
                yield* next(call);
                // A return value is not evidence, and this one is discarded.
                return Ok({ observations: { forged: true }, result: { forged: true } });
              },
            });
            return yield* execute();
          }),
        );

        // Two for the issue: one observation, one performance. The push and the
        // pull request replayed, so they route nothing.
        const requests = seen.filter(
          (call) => call.intent === "route" && call.request.kind === ISSUE,
        );
        expect(requests).toHaveLength(2);

        for (const call of requests) {
          expect(Object.keys(call).sort()).toEqual(["intent", "phase", "request"]);
          const request = Reflect.get(call, "request");
          expect(Object.keys(Object(request)).sort()).toEqual([
            "identity",
            "inputs",
            "kind",
            "naturalKey",
          ]);
          expect(Object.isFrozen(call)).toBe(true);
          const described = JSON.stringify(call);
          expect(described).not.toContain(TOKEN);
          expect(described).not.toContain(LOCATOR);
          expect(described).not.toContain(remote.locator);
          expect(described).not.toContain("api.github");
          expect(described).not.toContain("/private/var");
          expect(described).not.toContain("/var/folders");
          // Nothing on it is a function, so there is nothing to invoke.
          for (const value of Object.values(Object(request))) {
            expect(typeof value).not.toBe("function");
          }
        }

        // What the middleware returned was ignored: the record is the provider's.
        const outcomes = yield* gitHostOutcomes(database);
        expect(parseGitHostReconciliationRecord(outcomes[2]?.record)?.decision).toBe("performed");
        expect(run.store.issues).toHaveLength(1);
      },
    });
  });

  it("publishes nothing when routing middleware refuses to delegate", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const run = fixture(remote);

    const first = yield* attemptWorkflow(root, "start", deferring(), run.options);
    const delivered = yield* answer(root, waitOf(first).suspensionId, { approved: true });
    expect(delivered.ok).toBe(true);

    yield* attemptWorkflow(root, "resume", deferring(), run.options, {
      *after(database) {
        dropRootClose(runPath(root, RUN));
        dropIssueRecord(runPath(root, RUN));
        run.store.requests.length = 0;
        run.store.issues.length = 0;

        const failure = yield* raised(
          runWorkflowDocument(database, deferring(), run.options, (execute) =>
            scoped(function* () {
              yield* GitHost.around({
                // deno-lint-ignore require-yield
                *route(): Operation<unknown> {
                  return Ok({ observations: {}, result: {} });
                },
              });
              return yield* execute();
            }),
          ),
        );

        expect(String(failure)).toContain("executed and published nothing");
        expect(run.store.requests).toHaveLength(0);
        expect(run.store.issues).toHaveLength(0);
      },
    });
  });
});
