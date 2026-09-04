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
import { once } from "@effectionx/node/events";
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { exec as execProcess } from "@effectionx/process";
import {
  call,
  ensure,
  type Operation,
  race,
  scoped,
  spawn,
  suspend,
  withResolvers,
} from "effection";
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
import { useGitHttpRemote } from "./support/git-http.ts";
import { useInvokingHome } from "./support/credential-home.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { denoGitAuthentication } from "../src/deno/composition/authentication.ts";
import { TEST_HELPER } from "./support/composition.ts";

/** What one backend child is carrying on the streams the fixture observes. */
function attached(child: ChildProcess): number[] {
  return [
    child.listenerCount("error"),
    child.listenerCount("close"),
    child.stdout?.listenerCount("data") ?? 0,
    child.stdout?.listenerCount("end") ?? 0,
    child.stdin?.listenerCount("error") ?? 0,
  ];
}

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

  /**
   * The same crash, through a remote that demands a credential.
   *
   * What this adds is the identity. The killed process acquired for its
   * Repository and again for its Push, published through a protected transport,
   * and died before its journal knew. The resumption stands in a different
   * invoking home entirely — a different credential chain, asked once — and
   * adopts the request the first one left rather than publishing a second time.
   */
  it("adopts a protected publication under authentication it acquired afresh", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    // Every backend the fixture spawns, with what its streams were carrying
    // before the request task attached anything — the runtime keeps listeners
    // of its own on a child's stdout, so the baseline is measured rather than
    // assumed to be nothing.
    const backends: { child: ChildProcess; before: number[] }[] = [];
    const served = yield* useGitHttpRemote({
      remote: bare,
      label: "protected",
      username: "crash-user",
      password: "crash-secret",
      observeBackend: (child) => backends.push({ child, before: attached(child) }),
    });
    const crashHome = yield* useInvokingHome([
      { host: served.host, path: "remote.git", username: "crash-user", password: "crash-secret" },
    ]);
    const resumeHome = yield* useInvokingHome([
      { host: served.host, path: "remote.git", username: "crash-user", password: "crash-secret" },
    ]);
    const helperModule = fileURLToPath(
      new URL("./support/credential-helper-entry.ts", import.meta.url),
    );
    const runId = "git-push-crash-protected";
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
          // Only the credential-free locator and two host paths cross this
          // boundary. What the child authenticates with is whatever its own
          // isolated home holds.
          served.locator,
          crashHome.home,
          helperModule,
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
      // Drained, so a child that died on its way to the handshake says why
      // rather than leaving this waiting on a line that is never coming.
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
            `the protected push crash child ended before its handshake ` +
              `(${JSON.stringify(status)}): ${err}`,
          );
        }),
      ]);

      // Read from outside the child, while it is still standing in its own
      // uncommitted transaction.
      const outside = committedTypes(path);
      process.kill(child.pid, "SIGKILL");
      const status = yield* child.join();
      return { announcement, outside, status };
    });

    // Killed, not asked. A signal performs no cleanup, no commit and no
    // rollback, which is the only way to produce the state under test.
    expect(during.status.signal).toBe("SIGKILL");
    expect(during.status.code ?? null).toBeNull();
    expect(during.announcement["pushed"]).toBe(true);

    // The two ends disagree, and they disagreed before the signal as well as
    // after it: the remote holds the branch and the run's own history has no
    // result for the push that put it there.
    expect(during.outside).not.toContain(GIT_HOST_EFFECT);

    // The crash process acquired twice: once for the Repository it created, and
    // once for the Push it performed. Its chain was asked nothing else.
    expect(yield* crashHome.operations()).toEqual(["get", "get"]);

    // Exactly one accepted publication reached the remote, and the journal knows
    // nothing about it.
    const accepted = served.requests.filter(
      (request) =>
        request.accepted && request.method === "POST" && request.path.endsWith("/git-receive-pack"),
    );
    expect(accepted).toHaveLength(1);
    expect(committedTypes(path)).not.toContain(GIT_HOST_EFFECT);

    const pushedCommit = remoteBranch(bare, PUSH_BRANCH);
    expect(pushedCommit).toBeDefined();

    yield* withStorage(root, function* () {
      const opened = yield* WorkflowRunStorage.operations.lookup(runId);
      if (!opened.ok) {
        throw opened.error;
      }
      const database = opened.value;
      const counting = countingHost(
        denoRepositoryHost({
          authentication: denoGitAuthentication({
            ambient: resumeHome.ambient,
            assembly: TEST_HELPER,
          }),
        }),
      );
      yield* runWorkflowDocument(database, pushDocument(served.locator), countingOptions(counting));

      // A different chain entirely, asked once — the Repository replays from
      // what the crash retained and acquires nothing, so the only acquisition
      // here is the Push's own.
      expect(yield* resumeHome.operations()).toEqual(["get"]);

      // It observed, recognized its own completion and adopted it. One remote
      // mutation across two processes, and no second publication.
      expect(subcommands(counting.counters).filter((name) => name === "ls-remote")).toHaveLength(1);
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(
        served.requests.filter(
          (request) =>
            request.accepted &&
            request.method === "POST" &&
            request.path.endsWith("/git-receive-pack"),
        ),
      ).toHaveLength(1);

      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const record = parseGitHostReconciliationRecord(outcome?.record);
      expect(record?.decision).toBe("adopted");
      expect(record?.preState).toEqual({ remoteCommit: pushedCommit });
      expect(Reflect.get(Object(record?.result), "sourceCommit")).toBe(pushedCommit);
      // One durable request, across both processes.
      expect(yield* gitHostEvents(database)).toHaveLength(1);

      expect(remoteBranch(bare, PUSH_BRANCH)).toBe(pushedCommit);
    });

    // Each backend belonged to the request task that spawned it, and that task
    // has ended. The counts are read before the events are replayed, because a
    // handler removed by its own event would leave the same counts behind as
    // one the task released.
    expect(backends.length).toBeGreaterThan(0);
    for (const { child, before } of backends) {
      expect(attached(child)).toEqual(before);
    }

    // And nothing the fixture kept can still be reached through them.
    const answered = served.requests.length;
    for (const { child } of backends) {
      child.emit("close", 0, null);
      child.stdout?.emit("data", Buffer.from("late"));
      child.stdout?.emit("end");
    }

    expect(served.requests.length).toBe(answered);
    for (const { child, before } of backends) {
      expect(attached(child)).toEqual(before);
    }
  });
  /**
   * A backend the fixture is still talking to belongs to the request task that
   * spawned it, and that task belongs to the server. Held open on the server
   * side rather than timed, so the teardown below lands while the child is
   * alive and every handler is attached: what it must prove is that the task
   * killed and reaped the child and released all five before the events are
   * replayed.
   */
  it("kills and releases a backend the server was still talking to", function* () {
    const bare = yield* useBareRemote(REMOTE);
    const held = withResolvers<void>();
    const backends: { child: ChildProcess; before: number[] }[] = [];
    let live: number[] = [];
    let answered = false;

    yield* scoped(function* () {
      const served = yield* useGitHttpRemote({
        remote: bare,
        label: "held",
        username: "held-user",
        password: "held-secret",
        observeBackend: (child) => backends.push({ child, before: attached(child) }),
        *holdBackend() {
          held.resolve();
          yield* suspend();
        },
      });

      const [host, port] = served.host.split(":");
      const name = served.locator.slice(served.locator.lastIndexOf("/") + 1);
      const socket = connect(Number(port), host ?? "127.0.0.1");
      const onError = (): void => {};
      const onData = (): void => {
        answered = true;
      };

      yield* ensure(() => {
        socket.off("error", onError);
        socket.off("data", onData);
        socket.destroy();
      });

      socket.on("error", onError);
      socket.on("data", onData);

      yield* once(socket, "connect");
      const authorization = Buffer.from("held-user:held-secret").toString("base64");
      socket.write(
        `GET /${name}/info/refs?service=git-upload-pack HTTP/1.1\r\n` +
          `Host: ${served.host}\r\nAuthorization: Basic ${authorization}\r\n` +
          `Connection: close\r\n\r\n`,
      );

      yield* held.operation;

      const observed = backends[0];
      if (!observed) {
        throw new Error("the fixture spawned no backend");
      }
      live = attached(observed.child);
    });

    const first = backends[0];
    if (!first) {
      throw new Error("the fixture spawned no backend");
    }

    // Five: `error` and `close` on the child, `data` and `end` on its stdout,
    // and `error` on its stdin — each on top of what the runtime already held.
    live.forEach((count, index) => {
      expect(count).toBeGreaterThanOrEqual(first.before[index] + 1);
    });

    // The task killed it and waited for it to be gone before letting go.
    expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true);
    const released = live.map((count) => count - 1);

    expect(attached(first.child)).toEqual(released);

    first.child.emit("close", 0, null);
    first.child.stdout?.emit("data", Buffer.from("after the server was torn down"));

    expect(attached(first.child)).toEqual(released);
    // And the client was never answered, because the request never finished.
    expect(answered).toBe(false);
  });
});
