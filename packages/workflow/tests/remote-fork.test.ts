/**
 * Tier WRH — how a remote fork crosses from a source snapshot to a destination.
 *
 * That the destination commits whole or not at all, and that its copied prefix
 * outlives the source, are owner facts and are proved against a real Durable
 * Object in `tests/cloudflare/remote-fork.vitest.ts`. These are the runner's
 * half: that the source is read through the no-acquisition plane, that every
 * member of the snapshot is offered before anything is committed, and that what
 * the final command claims is what was actually offered.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, scoped, spawn, withResolvers } from "effection";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import type { ExecutorLock } from "../src/lifecycle/api.ts";
import type { WorkflowForkRequest } from "../src/lifecycle/execution.ts";
import type { WorkflowExecutionTransitions } from "../src/lifecycle/execution.ts";
import { useRemoteLifecycle } from "../src/remote/lifecycle.ts";
import type { RemoteForkSource } from "../src/remote/read.ts";
import type { RemoteForkCommit, RemoteForkPart } from "../src/remote/lifecycle-link.ts";
import { installedHost, RUN_ID, ROOT, type Script } from "./support/remote-lifecycle-host.ts";

const SOURCE_RUN_ID = "6dktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
const DESTINATION = "7ektgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

function event(name: string): string {
  return serializeDurableEvent({
    type: "yield",
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok", value: name },
  });
}

function source(): RemoteForkSource {
  return {
    sourceRunId: SOURCE_RUN_ID,
    anchor: "f".repeat(64),
    checkpointEventId: "event-work",
    checkpointWorkspaceRootId: ROOT,
    runRecordWorkspaceRootId: ROOT,
    rootImportWorkspaceRootId: ROOT,
    inherited: [
      { eventId: "event-a", record: event("a"), workspaceRootId: ROOT },
      { eventId: "event-b", record: event("b"), workspaceRootId: ROOT },
    ],
    roots: [
      {
        rootId: ROOT,
        formatVersion: 1,
        manifest: "{}",
        manifestHashes: ["b".repeat(64)],
        blobHashes: ["c".repeat(64)],
      },
    ],
    manifests: [{ hash: "b".repeat(64), size: 3, lastSeen: 0, encoded: new Uint8Array([1, 2, 3]) }],
    blobs: [{ hash: "c".repeat(64), size: 3, lastSeen: 0, content: new Uint8Array([1, 2, 3]) }],
    checkouts: [
      {
        kind: "repository",
        name: "alpha",
        locator: "https://git.example.invalid/alpha.git",
        locatorFingerprint: "d".repeat(64),
        requestedBase: null,
        creationCommit: "9".repeat(40),
        primaryBranch: "main",
        objectFormat: "sha1",
        checkoutPath: "/",
      },
    ],
  };
}

function request(runId = DESTINATION): WorkflowForkRequest {
  return {
    runId,
    selection: { sourceRunId: SOURCE_RUN_ID, checkpointEventId: "event-work" },
    creation: {
      definition: {
        version: 1,
        kind: "git",
        objectFormat: "sha1",
        objectId: "0".repeat(40),
        rootDocumentPath: "README.md",
      },
      base: "main",
      props: {},
    },
    rootImport: {
      type: "yield",
      coroutineId: "root",
      description: { type: "import_component", name: "__root__" },
      result: { status: "ok", value: { kind: "repository", path: "README.md", content: "# fork" } },
    },
  };
}

function* installed<T>(
  script: Script,
  body: (transitions: WorkflowExecutionTransitions) => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const transitions = yield* useRemoteLifecycle(installedHost(script));
    return yield* body(transitions);
  });
}

function* acquired(runId: string): Operation<ExecutorLock> {
  const taken = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
  if (!taken.ok) {
    throw taken.error;
  }
  if (taken.value.kind !== "acquired") {
    throw new Error("expected the executor lock to be acquired");
  }
  return taken.value.lock;
}

describe("a remote fork's destination", () => {
  it("offers the whole snapshot before it commits any of it", function* () {
    const asked: string[] = [];
    const staged: RemoteForkPart[] = [];
    const commits: RemoteForkCommit[] = [];
    const outcome = yield* installed(
      { asked, staged, commits, source: source() },
      function* (transitions) {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      },
    );

    expect([outcome.ok, outcome.ok === false && String(outcome.error)]).toEqual([true, false]);
    // Everything was offered, and the commit came last.
    expect(asked.at(-1)).toBe("fork");
    expect(asked.filter((command) => command === "fork-stage")).toHaveLength(6);
    expect(staged.map((part) => `${part.section}:${part.position}`)).toEqual([
      "roots:0",
      // The metadata a digest cannot stand for travels beside the content.
      "manifests:0",
      "blobs:0",
      "inherited:0",
      "inherited:1",
      "checkouts:0",
    ]);
    // What the final command claims is what was offered, and where it came
    // from is the selection that was read.
    expect(commits[0]?.counts).toEqual({
      inherited: 2,
      roots: 1,
      manifests: 1,
      blobs: 1,
      checkouts: 1,
    });
    expect(commits[0]?.origin).toEqual({
      sourceRunId: SOURCE_RUN_ID,
      checkpointEventId: "event-work",
      checkpointWorkspaceRootId: ROOT,
      runRecordWorkspaceRootId: ROOT,
      rootImportWorkspaceRootId: ROOT,
      anchor: "f".repeat(64),
    });
  });

  it("names every question of one fork distinctly, under the one identity", function* () {
    const commands: string[] = [];
    const parts: string[] = [];
    yield* installed({ commands, parts, source: source() }, function* (transitions) {
      const lock = yield* acquired(DESTINATION);
      return yield* transitions.fork(lock, request());
    });

    // One fork asks the destination eight questions: whether it already holds
    // this fork, six offers of the snapshot, and the commit.
    const asked = [...commands, ...parts];
    expect(asked).toHaveLength(8);
    // Each is its own command. An owner keys a retained decision by the
    // identity it was asked under, so two different requests sharing one
    // identity would meet each other's fingerprint and be refused as repeats
    // of something they are not.
    expect(new Set(asked).size).toBe(asked.length);
    // And all of them belong to the one call, so a retry spells each of them
    // exactly the way the first attempt did.
    expect(new Set(asked.map((command) => command.split(":")[0])).size).toBe(1);
  });

  it("carries the inherited records exactly as the source retained them", function* () {
    const staged: RemoteForkPart[] = [];
    yield* installed({ staged, source: source() }, function* (transitions) {
      const lock = yield* acquired(DESTINATION);
      return yield* transitions.fork(lock, request());
    });

    const inherited = staged.filter((part) => part.section === "inherited");
    expect(inherited.map((part) => part.part["record"])).toEqual([event("a"), event("b")]);
    expect(inherited.map((part) => part.part["eventId"])).toEqual(["event-a", "event-b"]);
  });

  it("writes the fork's own run record rather than the source's", function* () {
    const commits: RemoteForkCommit[] = [];
    yield* installed({ commits, source: source() }, function* (transitions) {
      const lock = yield* acquired(DESTINATION);
      return yield* transitions.fork(lock, request());
    });

    const head = commits[0];
    // Its own identity, and the root import its own definition produced.
    expect(JSON.stringify(head?.runRecord)).toContain(DESTINATION);
    expect(JSON.stringify(head?.runRecord)).not.toContain(SOURCE_RUN_ID);
    expect(head?.rootImport).toEqual(request().rootImport);
  });

  it("refuses a fork under a lock issued for another run, and reads nothing", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked, source: source() }, function* (transitions) {
      const lock = yield* acquired(RUN_ID);
      return yield* transitions.fork(lock, request());
    });

    expect(outcome.ok).toBe(false);
    // Not one part offered, and no source read: the lock was wrong before any
    // of that could matter.
    expect(asked).toEqual([]);
  });

  it("refuses a staged fork whose source it cannot read, and takes no acquisition", function* () {
    const opened: string[] = [];
    const outcome = yield* installed({ opened }, function* (transitions) {
      return yield* transitions.stageFork(request());
    });

    expect(outcome.ok).toBe(false);
    // Staging takes no destination acquisition at all, failure or not.
    expect(opened).toEqual([]);
  });

  it("stages a candidate without acquiring or committing anything", function* () {
    const asked: string[] = [];
    const opened: string[] = [];
    const outcome = yield* installed({ asked, opened, source: source() }, function* (transitions) {
      return yield* transitions.stageFork(request());
    });

    // This scripted host stages nothing, which is the point: what is proved
    // here is that nothing was acquired and nothing was committed on the way.
    expect(outcome.ok).toBe(false);
    expect(opened).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("continues a destination that already holds this fork, without its source", function* () {
    const asked: string[] = [];
    const sourced: string[] = [];
    const outcome = yield* installed(
      // No source at all: this host would fail if one were asked for.
      { asked, sourced, continues: true },
      function* (transitions) {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      },
    );

    expect([outcome.ok, outcome.ok === false && String(outcome.error)]).toEqual([true, false]);
    // The destination answered from what it retains. Nothing was read from the
    // source, and nothing was staged.
    expect(sourced).toEqual([]);
    expect(asked).toEqual(["fork-continue"]);
  });

  it("asks the source only when the destination holds no fork yet", function* () {
    const asked: string[] = [];
    const sourced: string[] = [];
    const outcome = yield* installed({ asked, sourced, source: source() }, function* (transitions) {
      const lock = yield* acquired(DESTINATION);
      return yield* transitions.fork(lock, request());
    });

    expect(outcome.ok).toBe(true);
    // Absent, so the source was read and staged, and the commit came last.
    expect(sourced).toEqual([SOURCE_RUN_ID]);
    expect(asked[0]).toBe("fork-continue");
    expect(asked.at(-1)).toBe("fork");
  });

  it("stays absent when the destination is pristine and the source cannot be read", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked }, function* (transitions) {
      const lock = yield* acquired(DESTINATION);
      return yield* transitions.fork(lock, request());
    });

    expect(outcome.ok).toBe(false);
    // It asked the destination, learned there was nothing, and stopped when
    // the source it needed was unavailable. Nothing was committed.
    expect(asked).toEqual(["fork-continue"]);
  });

  it("resends the command it already sent when its answer was lost", function* () {
    const asked: string[] = [];
    const sourced: string[] = [];
    const commands: string[] = [];
    const loseAnswer = new Set(["command-1:commit"]);
    const committed = new Map();
    const script: Script = {
      asked,
      sourced,
      commands,
      loseAnswer,
      committed,
      source: source(),
    };
    const outcome = yield* installed(script, function* (transitions) {
      const first = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      // The source is gone by the time the retry happens.
      const retried = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      return { first, retried, sourced: [...sourced], asked: [...asked] };
    });

    expect(outcome.first.ok).toBe(false);
    expect(outcome.retried.ok).toBe(true);
    // The retry resent the exact command before anything else, so the source
    // was read once — for the first attempt — and not again.
    expect(outcome.sourced).toEqual([SOURCE_RUN_ID]);
    expect(outcome.asked.at(-1)).toBe("fork");
    expect(commands.filter((id) => id === "command-1:commit").length).toBeGreaterThan(1);
  });

  it("sends only the command it already sent when its answer is lost twice", function* () {
    const asked: string[] = [];
    const sourced: string[] = [];
    const script: Script = {
      asked,
      sourced,
      loseAnswer: new Set(["command-1:commit"]),
      committed: new Map(),
      source: source(),
    };
    const outcome = yield* installed(script, function* (transitions) {
      const first = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      // Lost again on the resend.
      script.loseAnswer?.add("command-1:commit");
      const asking = asked.length;
      const second = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      return { first, second, sent: asked.slice(asking), sourced: [...sourced] };
    });

    expect(outcome.first.ok).toBe(false);
    expect(outcome.second.ok).toBe(false);
    // The second attempt sent the finalized command and nothing else: no
    // continuation, and no second source read.
    expect(outcome.sent).toEqual(["fork"]);
    expect(outcome.sourced).toEqual([SOURCE_RUN_ID]);
  });

  it("retires an invocation the owner definitively refused", function* () {
    const asked: string[] = [];
    const script: Script = {
      asked,
      forkRefuses: true,
      loseAnswer: new Set(["command-1:commit"]),
      committed: new Map(),
      source: source(),
    };
    const outcome = yield* installed(script, function* (transitions) {
      const first = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      const asking = asked.length;
      const second = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      return { first, second, sent: asked.slice(asking) };
    });

    expect(outcome.second.ok).toBe(false);
    // The resend was answered — with a conflict — so nothing followed it.
    expect(outcome.sent).toEqual(["fork"]);
  });

  it("restages under a second transfer's own identity when the destination needs one", function* () {
    const asked: string[] = [];
    const parts: string[] = [];
    const commits: RemoteForkCommit[] = [];
    const reused: string[] = [];
    const decided: string[] = [];
    const script: Script = {
      asked,
      parts,
      commits,
      reused,
      decided,
      loseAnswer: new Set(["command-1:commit"]),
      needsTransfer: new Set(["command-1:commit"]),
      committed: new Map(),
      source: source(),
    };
    const outcome = yield* installed(script, function* (transitions) {
      const first = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      const asking = asked.length;
      const staging = parts.length;
      const second = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      return {
        first,
        second,
        sent: asked.slice(asking),
        offered: parts.slice(0, staging),
        reoffered: parts.slice(staging),
      };
    });

    expect(outcome.first.ok).toBe(false);
    expect([
      outcome.second.ok,
      outcome.second.ok === false && String(outcome.second.error),
    ]).toEqual([true, false]);
    // The resend was told its transfer is not there, so the same logical fork
    // staged the snapshot again and committed. It never asked whether the
    // destination already holds the fork: the destination just said it holds
    // nothing and was offered nothing.
    expect(outcome.sent).toEqual([
      "fork",
      "fork-stage",
      "fork-stage",
      "fork-stage",
      "fork-stage",
      "fork-stage",
      "fork-stage",
      "fork",
    ]);
    // `needs-transfer` is an answer, so the identity it answered is finished.
    // Every command of the second transfer carries a name that has never been
    // answered — which is exactly what the link enforces.
    expect(commits.map((commit) => commit.commandId)).toEqual([
      "command-1:commit",
      "command-1:commit",
      "command-2:commit",
    ]);
    expect(new Set(outcome.offered).size).toBe(outcome.offered.length);
    expect(new Set(outcome.reoffered).size).toBe(outcome.reoffered.length);
    for (const offered of outcome.reoffered) {
      expect(outcome.offered).not.toContain(offered);
    }
    expect(reused).toEqual([]);
    // And exactly one destination execution was ever begun.
    expect(decided).toHaveLength(1);
    expect(outcome.second.ok && outcome.second.value.execution.executionId).toBe(decided[0]);
  });

  it("keeps the fork it was committing when it is cancelled, and commits it once", function* () {
    const asked: string[] = [];
    const commits: RemoteForkCommit[] = [];
    const decided: string[] = [];
    const retired: string[] = [];
    const reused: string[] = [];
    const sourced: string[] = [];
    const entered = withResolvers<void>();
    let held = 0;
    const script: Script = {
      asked,
      commits,
      decided,
      retired,
      reused,
      sourced,
      committed: new Map(),
      source: source(),
      commitGate: {
        *wait(): Operation<void> {
          held += 1;
          if (held > 1) {
            return;
          }
          entered.resolve();
          yield* withResolvers<void>().operation;
        },
      },
    };
    const outcome = yield* installed(script, function* (transitions) {
      yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        const sent = yield* spawn(() => transitions.fork(lock, request()));
        yield* entered.operation;
        // Interrupted with the destination's decision made and its answer in
        // flight — the one moment a fork is genuinely ambiguous.
        yield* sent.halt();
      });
      const asking = asked.length;
      const reads = sourced.length;
      const second = yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        return yield* transitions.fork(lock, request());
      });
      return { second, sent: asked.slice(asking), reads: sourced.length - reads };
    });

    // The interrupted acquisition gave up its connection rather than holding a
    // run nobody could reach.
    expect(retired).toEqual([DESTINATION]);
    // The replacement resent that exact command and nothing else, without
    // reading the source again.
    expect(outcome.sent).toEqual(["fork"]);
    expect(outcome.reads).toBe(0);
    expect(commits.map((commit) => commit.commandId)).toEqual([
      "command-1:commit",
      "command-1:commit",
    ]);
    // One fork was committed, and the replacement was handed that one.
    expect(decided).toHaveLength(1);
    expect([
      outcome.second.ok,
      outcome.second.ok === false && String(outcome.second.error),
    ]).toEqual([true, false]);
    expect(outcome.second.ok && outcome.second.value.execution.executionId).toBe(decided[0]);
    expect(reused).toEqual([]);
  });

  it("keeps no question when it is cancelled reading the source, and stays usable", function* () {
    const asked: string[] = [];
    const commands: string[] = [];
    const retired: string[] = [];
    const reused: string[] = [];
    const entered = withResolvers<void>();
    let held = 0;
    const script: Script = {
      asked,
      commands,
      retired,
      reused,
      committed: new Map(),
      source: source(),
      sourceGate: {
        *wait(): Operation<void> {
          held += 1;
          if (held > 1) {
            return;
          }
          entered.resolve();
          yield* withResolvers<void>().operation;
        },
      },
    };
    const outcome = yield* installed(script, function* (transitions) {
      return yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        const sent = yield* spawn(() => transitions.fork(lock, request()));
        yield* entered.operation;
        // The continuation was answered and nothing has been mutated. Reading
        // a source is not a mutation however it is interrupted.
        yield* sent.halt();
        const asking = asked.length;
        // The same acquisition, which was released rather than retired.
        const again = yield* transitions.fork(lock, request());
        return { again, sent: asked.slice(asking) };
      });
    });

    // Nothing was retired, because nothing was outstanding.
    expect(retired).toEqual([]);
    expect([outcome.again.ok, outcome.again.ok === false && String(outcome.again.error)]).toEqual([
      true,
      false,
    ]);
    // The second call is a new question under a new identity — no ambiguity
    // was retained for a mutation that never happened — and it asks the
    // destination the whole thing again.
    expect(outcome.sent[0]).toBe("fork-continue");
    expect(commands).toEqual(["command-1:continue", "command-2:continue", "command-2:commit"]);
    expect(reused).toEqual([]);
  });

  it("keeps no question when it is cancelled offering the snapshot", function* () {
    const asked: string[] = [];
    const commands: string[] = [];
    const parts: string[] = [];
    const retired: string[] = [];
    const reused: string[] = [];
    const entered = withResolvers<void>();
    let held = 0;
    const script: Script = {
      asked,
      commands,
      parts,
      retired,
      reused,
      committed: new Map(),
      source: source(),
      stageGate: {
        *wait(): Operation<void> {
          held += 1;
          if (held > 1) {
            return;
          }
          entered.resolve();
          yield* withResolvers<void>().operation;
        },
      },
    };
    const outcome = yield* installed(script, function* (transitions) {
      return yield* scoped(function* () {
        const lock = yield* acquired(DESTINATION);
        const sent = yield* spawn(() => transitions.fork(lock, request()));
        yield* entered.operation;
        // Offered parts are scratch until a final command claims them. An
        // offer interrupted halfway has mutated nothing.
        yield* sent.halt();
        const asking = asked.length;
        const again = yield* transitions.fork(lock, request());
        return { again, sent: asked.slice(asking) };
      });
    });

    expect(retired).toEqual([]);
    expect([outcome.again.ok, outcome.again.ok === false && String(outcome.again.error)]).toEqual([
      true,
      false,
    ]);
    // A whole second offer, under a second identity: no part and no commit
    // reaches for a name the first attempt already used.
    expect(outcome.sent.filter((command) => command === "fork-stage")).toHaveLength(6);
    expect(commands.at(-1)).toBe("command-2:commit");
    expect(new Set(parts).size).toBe(parts.length);
    expect(reused).toEqual([]);
  });

  it("resends only the second transfer's own command when its answer is lost", function* () {
    const asked: string[] = [];
    const sourced: string[] = [];
    const reused: string[] = [];
    const decided: string[] = [];
    const commits: RemoteForkCommit[] = [];
    const script: Script = {
      asked,
      sourced,
      reused,
      decided,
      commits,
      // The first transfer's commit is lost and never happened; the second
      // transfer's commit is lost after the owner made it.
      loseAnswer: new Set(["command-1:commit", "command-2:commit"]),
      needsTransfer: new Set(["command-1:commit"]),
      committed: new Map(),
      source: source(),
    };
    const outcome = yield* installed(script, function* (transitions) {
      const attempts = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const asking = asked.length;
        const reads = sourced.length;
        const attempted = yield* scoped(function* () {
          const lock = yield* acquired(DESTINATION);
          return yield* transitions.fork(lock, request());
        });
        attempts.push({
          outcome: attempted,
          sent: asked.slice(asking),
          reads: sourced.length - reads,
        });
      }
      return attempts;
    });

    expect(outcome.map((attempt) => attempt.outcome.ok)).toEqual([false, false, true]);
    // The third attempt resent one command — the second transfer's own final
    // command, verbatim — and read no source to build it.
    expect(outcome[2]?.sent).toEqual(["fork"]);
    expect(outcome[2]?.reads).toBe(0);
    expect(commits.map((commit) => commit.commandId)).toEqual([
      "command-1:commit",
      "command-1:commit",
      "command-2:commit",
      "command-2:commit",
    ]);
    // A retry reaches for the identity the second transfer already used rather
    // than for the answered one, and never for a fresh one.
    expect(reused).toEqual([]);
    expect(decided).toHaveLength(1);
  });
});
