/**
 * Tier WF — what a `<PullRequest>` retains, replays and refuses to guess.
 *
 * The claims here are about the run's database and the Git host together. A
 * replayed pull request must reach no host, read no credential and append no
 * second record; a retained record that no longer describes the invocation it
 * was recorded for must stop the run rather than be read around; a cancelled
 * creation must leave the journal exactly as it found it; and what public
 * routing middleware sees must be the frozen request and nothing that can
 * answer for it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { GitOperationProtocolError } from "../src/composition/errors.ts";
import { GitHost } from "../src/git-host/api.ts";
import type { GitHostCall } from "../src/git-host/api.ts";
import { GitHostProtocolError } from "../src/git-host/errors.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect.ts";
import { PULL_REQUEST } from "../src/composition/pull-request-records.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../src/deno/composition/github.ts";
import { createRun, runPath, tamper, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  gitHostEvents,
  gitHostOutcomes,
  raised,
  runWorkflowDocument,
} from "./support/composition.ts";
import { creations, mutations, respond } from "./support/github.ts";
import { dropRootClose } from "./support/replay.ts";
import {
  fixture,
  LOCATOR,
  numbered,
  published,
  pullRequest,
  stored,
  TITLE,
  REMOTE,
  TOKEN,
} from "./support/pull-requests.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";

const RUN = "release-1.4";

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
 * request. Reaching for any of the three fails the run here rather than
 * quietly succeeding against a host that happens to still hold the answer.
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

/**
 * Damage the one retained pull-request record, and refuse if it damaged none.
 *
 * A tamper that matched nothing leaves the run healthy, and a regression built
 * on one passes by replaying an undamaged record.
 */
function damageRecord(path: string, damage: (record: Record<string, unknown>) => void): void {
  let rewritten = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      const description = Object(Reflect.get(Object(parsed), "description"));
      if (Reflect.get(description, "type") !== GIT_HOST_EFFECT) {
        continue;
      }
      const value = Object(Object(Reflect.get(Object(parsed), "result")).value);
      if (Reflect.get(Object(Reflect.get(value, "request")), "kind") !== PULL_REQUEST) {
        continue;
      }
      damage(value);
      database
        .prepare("UPDATE journal_events SET record = ? WHERE sequence = ?")
        .run(JSON.stringify(parsed), row["sequence"]);
      rewritten += 1;
    }
  });
  if (rewritten !== 1) {
    throw new Error(`the journal holds ${rewritten} pull-request reconciliation records`);
  }
}

describe("workflow PullRequest durability", () => {
  it("replays without reaching a Git host or appending a second record", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, RUN);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: RUN });
      const run = fixture(remote);
      const first = String(
        yield* runWorkflowDocument(database, published(...pullRequest()), run.options),
      );
      const retained = yield* gitHostOutcomes(database);
      expect(retained).toHaveLength(2);

      dropRootClose(path);

      // The pull request this run created is closed and retitled, and the base
      // branch moves, after the record commits. Creation evidence is what the
      // run retained; none of this can change it.
      const created = run.store.pullRequests[0];
      if (created !== undefined) {
        created.state = "closed";
        created.title = "Something else entirely";
        created.baseSha = "0".repeat(40);
      }

      const replayed = String(
        yield* runWorkflowDocument(database, published(...pullRequest()), {
          composition: { host: run.counting.host },
          gitHubPullRequests: { access: gitHubSource(unreachable()) },
        }),
      );

      // The same evidence, from the journal, with no adapter selected, no
      // credential read and no request sent.
      expect(replayed).toBe(first);
      expect(yield* gitHostOutcomes(database)).toEqual(retained);
      expect(yield* gitHostEvents(database)).toHaveLength(2);
      expect(creations(run.store)).toBe(1);
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
      name: "claims a head this invocation did not ask for",
      damage: (record) => {
        Object(record.result).headSha = "0".repeat(40);
      },
    },
    {
      name: "disagrees with its own observations",
      damage: (record) => {
        Object(record.result).number = 99;
      },
    },
    {
      name: "observed a pull request the request does not describe",
      damage: (record) => {
        Object(Object(record.observations).pullRequest).title = "Something else";
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
        Object(Object(record.observations).pullRequest).state = "closed";
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

      yield* withStorage(root, function* () {
        const database = yield* createRun({ runId: RUN });
        const run = fixture(remote);
        yield* runWorkflowDocument(database, published(...pullRequest()), run.options);

        dropRootClose(path);
        damageRecord(path, damage);

        const replay = fixture(remote, run.store.pullRequests);
        const failure = yield* raised(
          runWorkflowDocument(database, published(...pullRequest()), replay.options),
        );

        expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
        // Nothing was re-observed or re-created to make up for the damage.
        expect(replay.store.requests).toHaveLength(0);
      });
    });
  }

  const REKEYED: Array<{ name: string; damage: (record: Record<string, unknown>) => void }> = [
    {
      name: "is keyed as an update it never was",
      damage: (record) => {
        Object(record.request).naturalKey = {
          mode: "update",
          repository: Object(Object(record.request).naturalKey).repository,
          number: Object(record.result).number,
        };
      },
    },
    {
      name: "is keyed under no mode this effect has",
      damage: (record) => {
        Object(Object(record.request).naturalKey).mode = "upsert";
      },
    },
  ];

  for (const { name, damage } of REKEYED) {
    it(`fails a replay whose retained record ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);
      const path = runPath(root, RUN);

      yield* withStorage(root, function* () {
        const database = yield* createRun({ runId: RUN });
        const run = fixture(remote);
        yield* runWorkflowDocument(database, published(...pullRequest()), run.options);

        dropRootClose(path);
        damageRecord(path, damage);

        const replay = fixture(remote, run.store.pullRequests);
        const failure = yield* raised(
          runWorkflowDocument(database, published(...pullRequest()), replay.options),
        );

        // The key is part of the request, so the shared engine refuses it
        // before this effect's own reader is reached at all.
        expect(causedBy(failure, isHostProtocolFailure)).toBeInstanceOf(GitHostProtocolError);
        expect(replay.store.requests).toHaveLength(0);
      });
    });
  }

  it("fails a replay whose retained record answers a different request", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, RUN);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: RUN });
      const run = fixture(remote);
      yield* runWorkflowDocument(database, published(...pullRequest()), run.options);

      dropRootClose(path);
      damageRecord(path, (record) => {
        Object(Object(Object(record.request).inputs)).baseBranch = "develop";
      });

      const replay = fixture(remote, run.store.pullRequests);
      const failure = yield* raised(
        runWorkflowDocument(database, published(...pullRequest()), replay.options),
      );

      expect(causedBy(failure, isHostProtocolFailure)).toBeInstanceOf(GitHostProtocolError);
      expect(replay.store.requests).toHaveLength(0);
    });
  });

  it("publishes nothing when a blocked creation is halted", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: RUN });
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
          if (request.method === "POST") {
            creating.resolve();
            yield* suspend();
          }
          return respond(run.store, request);
        },
      };

      yield* scoped(function* () {
        const task = yield* spawn(() =>
          runWorkflowDocument(database, published(...pullRequest()), {
            composition: { host: run.counting.host },
            gitHubPullRequests: { access: gitHubSource(blocking) },
          }),
        );
        yield* creating.operation;
        yield* task.halt();
      });

      // A cancelled attempt is not an outcome: no completion was invented, and
      // no failure was published for it either.
      const outcomes = yield* gitHostOutcomes(database);
      expect(outcomes).toHaveLength(1);
      expect(parseGitHostReconciliationRecord(outcomes[0]?.record)?.request.kind).toBe("git-push");
      expect(run.store.pullRequests).toHaveLength(0);
    });
  });

  it("fails a replay whose retained update had nothing to perform", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, RUN);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: RUN });
      const run = fixture(remote, [stored({ number: 12, title: "Draft title" })]);
      yield* runWorkflowDocument(database, published(...numbered(12)), run.options);

      dropRootClose(path);
      // The record keeps its performed decision while its pre-state is rewritten
      // to what the observation holds: an update that moved nothing.
      damageRecord(path, (record) => {
        Object(record).preState = { pullRequest: Object(record.observations).pullRequest };
      });

      const replay = fixture(remote, run.store.pullRequests);
      const failure = yield* raised(
        runWorkflowDocument(database, published(...numbered(12)), replay.options),
      );

      expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
      expect(replay.store.requests).toHaveLength(0);
    });
  });

  it("adopts an update that landed before the record could be appended", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: RUN });
      const run = fixture(remote, [stored({ number: 12, title: "Draft title" })]);
      const observing = withResolvers<void>();

      // The mutation lands, the observation that confirms it is answered, and
      // the process stops before anything local is appended. That is the gap
      // this reconciliation exists for, on the update side.
      const interrupted: GitHubAccess = {
        endpoint: "https://api.github.test",
        // deno-lint-ignore require-yield
        *token(): Operation<string | undefined> {
          return TOKEN;
        },
        *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
          const answer = respond(run.store, request);
          if (request.method === "PATCH") {
            observing.resolve();
            yield* suspend();
          }
          return answer;
        },
      };

      yield* scoped(function* () {
        const task = yield* spawn(() =>
          runWorkflowDocument(database, published(...numbered(12)), {
            composition: { host: run.counting.host },
            gitHubPullRequests: { access: gitHubSource(interrupted) },
          }),
        );
        yield* observing.operation;
        yield* task.halt();
      });

      // The host holds the update; this run's history holds no result for it.
      expect(run.store.pullRequests[0]?.title).toBe(TITLE);
      expect(yield* gitHostOutcomes(database)).toHaveLength(1);

      // The continuation observes, finds everything already as asked, and
      // records the no-op without mutating anything a second time.
      const resumed = fixture(remote, run.store.pullRequests);
      yield* runWorkflowDocument(database, published(...numbered(12)), resumed.options);

      expect(mutations(resumed.store)).toEqual([]);
      const outcomes = yield* gitHostOutcomes(database);
      const record = parseGitHostReconciliationRecord(outcomes[1]?.record);
      expect(record?.decision).toBe("adopted");
      expect(record?.preState).toEqual(record?.observations);
    });
  });

  it("shows routing middleware the frozen request and nothing that can answer it", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: RUN });
      const run = fixture(remote);
      const seen: GitHostCall[] = [];
      yield* runWorkflowDocument(database, published(...pullRequest()), run.options, (execute) =>
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

      // Two for the push, two for the pull request.
      expect(seen).toHaveLength(4);
      const requests = seen.filter(
        (call) => call.intent === "route" && call.request.kind === PULL_REQUEST,
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
      expect(parseGitHostReconciliationRecord(outcomes[1]?.record)?.decision).toBe("performed");
      expect(run.store.pullRequests).toHaveLength(1);
    });
  });

  it("publishes nothing when routing middleware refuses to delegate", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun({ runId: RUN });
      const run = fixture(remote);
      const failure = yield* raised(
        runWorkflowDocument(database, published(...pullRequest()), run.options, (execute) =>
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
      expect(run.store.pullRequests).toHaveLength(0);
    });
  });
});
