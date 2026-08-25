/**
 * Tier WF — a `<PullRequest>` across a process boundary.
 *
 * This is the gap the shared Git-host reconciliation exists for, produced for
 * real rather than described. At the kill point GitHub has answered 201 and
 * nothing local has been appended; `SIGKILL` then runs no application cleanup,
 * so the pull request is open at the host and the run's database holds no
 * result for it.
 *
 * What the next execution does with that is the whole claim: it reconstructs
 * the same request, observes the branch pair, recognizes its own pull request
 * and adopts it. One pull request exists. A run that created another — or that
 * refused because one was already there — would be the two failures this design
 * is built to avoid.
 *
 * The GitHub the child talks to is a real HTTP listener over the same store the
 * test reads afterwards, because the child is a second process and cannot share
 * an object with it. The handshake is a line of JSON on standard output.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { exec as execProcess } from "@effectionx/process";
import { call, type Operation, race, scoped, spawn, withResolvers } from "effection";
import { WorkflowRunStorage } from "../mod.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import { PULL_REQUEST } from "../src/composition/pull-request-records.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import { remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import { gitHostEvents, gitHostOutcomes, runWorkflowDocument } from "./support/composition.ts";
import { creations, gitHubStore, useGitHubServer } from "./support/github.ts";
import { fakeGitHubAccess } from "./support/github.ts";
import {
  BRANCH,
  published,
  pullRequest,
  REMOTE,
  rewriting,
  TOKEN,
} from "./support/pull-requests.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const CRASH_CHILD = fileURLToPath(
  new URL("./support/pull-request-crash-child.ts", import.meta.url),
);

/** How many pull-request records another connection can see of this run now. */
function committedPullRequests(path: string): number {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    sqlite.exec("PRAGMA busy_timeout = 10000");
    return sqlite
      .prepare("SELECT record FROM journal_events ORDER BY sequence")
      .all()
      .map((row) => String(row["record"]))
      .filter(
        (record) => record.includes(GIT_HOST_EFFECT) && record.includes(`"kind":"${PULL_REQUEST}"`),
      ).length;
  } finally {
    sqlite.close();
  }
}

describe("workflow PullRequest across a process boundary", () => {
  it("adopts the pull request a killed process opened, and creates nothing again", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const runId = "pull-request-crash";
    yield* withStorage(root, function* () {
      yield* createRun({ runId });
    });

    const path = runPath(root, runId);
    const store = gitHubStore({ token: TOKEN });
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const endpoint = yield* useGitHubServer(store);

    const during = yield* scoped(function* () {
      const child = yield* execProcess(process.execPath, {
        arguments: [
          "run",
          "--allow-all",
          "--frozen",
          CRASH_CHILD,
          root,
          runId,
          remote.locator,
          endpoint,
          TOKEN,
        ],
        cwd: REPOSITORY,
      });
      const ready = withResolvers<Record<string, unknown>>();
      const decoder = new TextDecoder();
      let out = "";
      let err = "";
      yield* spawn(function* () {
        const subscription = yield* child.stdout;
        let next = yield* subscription.next();
        while (!next.done) {
          out += decoder.decode(next.value, { stream: true });
          const end = out.indexOf("\n");
          if (end >= 0) {
            ready.resolve(JSON.parse(out.slice(0, end)));
          }
          next = yield* subscription.next();
        }
      });
      yield* spawn(function* () {
        const subscription = yield* child.stderr;
        let next = yield* subscription.next();
        while (!next.done) {
          err += decoder.decode(next.value, { stream: true });
          next = yield* subscription.next();
        }
      });

      const announcement = yield* race([
        ready.operation,
        call(function* (): Operation<Record<string, unknown>> {
          const status = yield* child.join();
          throw new Error(
            `the pull-request crash child ended before its handshake ` +
              `(${JSON.stringify(status)}): ${err}`,
          );
        }),
      ]);

      const outside = committedPullRequests(path);
      process.kill(child.pid, "SIGKILL");
      const status = yield* child.join();
      return { announcement, outside, status };
    });

    expect(during.status.signal).toBe("SIGKILL");
    expect(during.status.code ?? null).toBeNull();
    expect(during.announcement["created"]).toBe(true);

    // The two ends disagree, which is the state under test. GitHub holds the
    // pull request; the run's own history has no result for the creation that
    // made it, and never will — nothing ran after the signal.
    expect(store.pullRequests).toHaveLength(1);
    expect(creations(store)).toBe(1);
    expect(during.outside).toBe(0);
    expect(committedPullRequests(path)).toBe(0);

    const opened = store.pullRequests[0];
    expect(opened?.headRef).toBe(BRANCH);

    yield* withStorage(root, function* () {
      const found = yield* WorkflowRunStorage.operations.lookup(runId);
      if (!found.ok) {
        throw found.error;
      }
      const database = found.value;
      yield* runWorkflowDocument(database, published(...pullRequest()), {
        composition: { host: rewriting(remote.locator) },
        gitHubPullRequests: { access: gitHubSource(fakeGitHubAccess(store)) },
      });

      // The continuation observed, recognized its own pull request and adopted
      // it. One creation across two executions.
      expect(creations(store)).toBe(1);
      expect(store.pullRequests).toHaveLength(1);

      const outcomes = yield* gitHostOutcomes(database);
      const record = parseGitHostReconciliationRecord(outcomes[1]?.record);
      expect(record?.decision).toBe("adopted");
      expect(Reflect.get(Object(record?.result), "number")).toBe(opened?.number);
      expect(Reflect.get(Object(record?.result), "headSha")).toBe(opened?.headSha);
      expect(Reflect.get(Object(record?.result), "baseSha")).toBe(opened?.baseSha);
      expect(yield* gitHostEvents(database)).toHaveLength(2);
    });
  });
});
