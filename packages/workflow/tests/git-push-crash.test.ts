/**
 * Tier WF — a `<Git.Push>` across a process boundary.
 *
 * This is the gap the shared Git-host reconciliation exists for, produced for
 * real rather than described. At the kill point native Git has already told the
 * run that the remote accepted the exact commit, and nothing local has been
 * appended; `SIGKILL` then runs no application cleanup, so the remote holds the
 * branch and the run's database holds no result for it.
 *
 * What the next execution does with that is the whole claim: it reconstructs
 * the same request, observes the destination, recognizes its own completion and
 * adopts it. The remote is mutated once. A run that pushed again — or that
 * refused because the destination was no longer absent — would be the two
 * failures this design is built to avoid.
 *
 * The handshake is a line of JSON on standard output, never a sleep.
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
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import { remoteBranch, useBareRemote } from "./support/git-remotes.ts";
import {
  countingHost,
  countingOptions,
  gitHostEvents,
  gitHostOutcomes,
  headCommit,
  retainedRepositories,
  runWorkflowDocument,
  subcommands,
} from "./support/composition.ts";
import { PUSH_BRANCH, pushDocument } from "./support/git-crash-process.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const CRASH_CHILD = fileURLToPath(new URL("./support/git-crash-child.ts", import.meta.url));

const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "which.txt", content: "main\n" }] }],
} as const;

/** Every durable event type another connection can see of this run right now. */
function committedTypes(path: string): string[] {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    sqlite.exec("PRAGMA busy_timeout = 10000");
    return sqlite
      .prepare("SELECT record FROM journal_events ORDER BY sequence")
      .all()
      .map((row) => String(JSON.parse(String(row["record"])).description?.type));
  } finally {
    sqlite.close();
  }
}

describe("workflow Git.Push across a process boundary", () => {
  it("adopts the commit a killed process published, and pushes nothing again", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const runId = "git-push-crash";
    yield* withStorage(root, function* () {
      yield* createRun({ runId });
    });

    const path = runPath(root, runId);

    const during = yield* scoped(function* () {
      const child = yield* execProcess(process.execPath, {
        arguments: [
          "run",
          "--allow-all",
          "--frozen",
          CRASH_CHILD,
          "push",
          root,
          runId,
          remote.locator,
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
            `the push crash child ended before its handshake (${JSON.stringify(status)}): ${err}`,
          );
        }),
      ]);

      const outside = committedTypes(path);
      process.kill(child.pid, "SIGKILL");
      const status = yield* child.join();
      return { announcement, outside, status };
    });

    expect(during.status.signal).toBe("SIGKILL");
    expect(during.status.code ?? null).toBeNull();
    expect(during.announcement["pushed"]).toBe(true);

    // The two ends disagree, which is the state under test. The remote holds
    // the branch; the run's own history has no result for the push that put it
    // there, and never will — nothing ran after the signal.
    const pushedCommit = remoteBranch(remote, PUSH_BRANCH);
    expect(pushedCommit).toBeDefined();
    expect(during.outside).not.toContain(GIT_HOST_EFFECT);
    expect(committedTypes(path)).not.toContain(GIT_HOST_EFFECT);

    yield* withStorage(root, function* () {
      const opened = yield* WorkflowRunStorage.operations.lookup(runId);
      if (!opened.ok) {
        throw opened.error;
      }
      const database = opened.value;
      const counting = countingHost();
      yield* runWorkflowDocument(database, pushDocument(remote.locator), countingOptions(counting));

      // The continuation observed, recognized its own completion and adopted
      // it. One remote mutation across two executions.
      expect(subcommands(counting.counters).filter((name) => name === "ls-remote")).toHaveLength(1);
      expect(subcommands(counting.counters)).not.toContain("push");

      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const record = parseGitHostReconciliationRecord(outcome?.record);
      expect(record?.decision).toBe("adopted");
      expect(record?.preState).toEqual({ remoteCommit: pushedCommit });
      expect(Reflect.get(Object(record?.result), "sourceCommit")).toBe(pushedCommit);
      expect(yield* gitHostEvents(database)).toHaveLength(1);

      const head = yield* headCommit(
        database,
        (yield* retainedRepositories(database))[0]?.record.checkoutPath ?? "",
      );
      expect(head.commit).toBe(pushedCommit);
      expect(remoteBranch(remote, PUSH_BRANCH)).toBe(pushedCommit);
    });
  });
});
