/**
 * Tier WRH — the runner's Workspace coordinator, end to end.
 *
 * What this is about is ordering and authority, not arithmetic. The Files are
 * real: a documented failure has to leave a directory that recaptures to the
 * root it started from, and a fake cannot settle that. The owner is a scripted
 * connection, because what crosses it here is what the coordinator decided —
 * whether the atomic commit is really atomic is proved on real workerd, where
 * atomicity is real.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableStream } from "@executablemd/durable-streams";
import {
  durableRun,
  establishJournalProvenance,
  InMemoryStream,
  type DurableEvent,
  type Json,
  type JournalProvenance,
  type Workflow,
} from "@executablemd/durable-streams";
import { type Operation, scoped, sleep, spawn, until } from "effection";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { runnerFiles, useRunnerTrees } from "../src/deno/remote-files.ts";
import { encodeBase64 } from "../src/cloudflare/encoding.ts";
import { createRemoteWorkspaceFilesystem } from "../src/deno/remote-workspace-files.ts";
import { captureWorkspace, type CapturedWorkspace } from "../src/remote/materialize.ts";
import type { RemoteContent, RemoteContentRequest, RemoteReadLink } from "../src/remote/read.ts";
import type { RemoteFrontierSnapshot } from "../src/remote/read.ts";
import type { RemoteInvocationSnapshot } from "../src/remote/records.ts";
import { useRemoteRunDatabase } from "../src/remote/database.ts";
import { cloudflareRunLink, cloudflareReadLink } from "../src/cloudflare/client.ts";
import { type OwnerSocket, type SocketListener, useOwnerConnection } from "../src/remote/client.ts";
import type { WorkspaceFilesystem } from "../src/workspace/filesystem.ts";
import type { WorkspaceMetadata } from "../src/workspace/metadata.ts";
import {
  createRemoteWorkspaceEffect,
  type RemoteRun,
  type RemoteWorkspaceMutation,
  useRemoteRun,
  type RemoteWorkspaceRuntime,
  useRemoteWorkspaceEffects,
  withRemoteWorkspaceEffects,
} from "../src/remote/workspace.ts";
import { routeRemoteRunJournal } from "../src/remote/journal-route.ts";
import { createInvocationMappings } from "../src/remote/mappings.ts";
import { JournaledEffectFailure } from "../src/workspace/failure.ts";
import { parseWorkspaceRootManifest } from "../src/workspace/root-manifest.ts";
import { locatorFingerprintOf } from "../src/composition/locator.ts";
import { agentSessionKey, resolveAgentSession } from "../src/storage/agent-session.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";

const RUN_ID = "remote-run";
const LOCATOR = "https://git.example.invalid/octo/app.git";

function reject(reason: string): never {
  throw new Error(reason);
}

/** A refusal the effect publishes rather than raises, as a document's would be. */
class DocumentedFailure extends JournaledEffectFailure {
  override name = "DocumentedFailure";
}

function runRecord() {
  return {
    runId: RUN_ID,
    definition: {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: "0".repeat(40),
      rootDocumentPath: "README.md",
    },
    base: "main",
    props: {},
    status: "running",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function repository(name = "app") {
  return {
    record: {
      name,
      locatorFingerprint: locatorFingerprintOf(LOCATOR),
      requestedBase: null,
      creationCommit: "9".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1" as const,
      checkoutPath: `/${name}`,
    },
    locator: LOCATOR,
  };
}

function emptySnapshot(workspaceRootId: string): RemoteInvocationSnapshot {
  return {
    workspaceRootId,
    journalEventId: null,
    repositories: [],
    worktrees: [],
    agentSessions: [],
  };
}

/** A connection whose answers a test writes, and which records what it was sent. */
function wire(answer: (request: Record<string, unknown>) => Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, Set<SocketListener>>();
  const socket: OwnerSocket = {
    send(data: string): void {
      const request = JSON.parse(data) as Record<string, unknown>;
      sent.push(request);
      const response = answer(request);
      if (response["outcome"] === "lost") {
        // The connection went while the answer was in flight.
        for (const listener of listeners.get("close") ?? []) {
          listener({});
        }
        return;
      }
      for (const listener of listeners.get("message") ?? []) {
        listener({ data: JSON.stringify({ id: request["id"], ...response }) });
      }
    },
    close(): void {},
    addEventListener(type, listener): void {
      const found = listeners.get(type) ?? new Set<SocketListener>();
      found.add(listener);
      listeners.set(type, found);
    },
    removeEventListener(type, listener): void {
      listeners.get(type)?.delete(listener);
    },
  };
  return { socket, sent };
}

/** The owner's answers for one starting tree, and what it was asked to commit. */
function ownerOf(
  captured: CapturedWorkspace,
  snapshot: () => RemoteInvocationSnapshot | { refused: string },
) {
  const commits: Record<string, unknown>[] = [];
  let refusal: string | undefined;
  let lost = false;
  return {
    commits,
    refuse(reason: string): void {
      refusal = reason;
    },
    lose(): void {
      lost = true;
    },
    get lost(): boolean {
      return lost;
    },
    answer(request: Record<string, unknown>): Record<string, unknown> {
      const command = request["command"];
      if (command === "mappings") {
        const value = snapshot();
        return "refused" in value
          ? { outcome: "performed", value }
          : { outcome: "performed", value };
      }
      if (command === "frontier") {
        return {
          outcome: "performed",
          value: {
            record: runRecord(),
            retrieval: null,
            workspaceRootId: captured.root.rootId,
            journalEventId: null,
          },
        };
      }
      if (command === "root") {
        return {
          outcome: "performed",
          value: {
            workspaceRootId: captured.root.rootId,
            manifest: captured.root.manifest,
          },
        };
      }
      if (command === "content") {
        const digest = String(request["digest"]);
        const bytes =
          request["kind"] === "manifest"
            ? captured.contents.get(digest)?.manifestBytes
            : captured.blobs.get(digest);
        if (bytes === undefined) {
          throw new Error("asked for content this owner does not hold");
        }
        return {
          outcome: "performed",
          value: {
            kind: request["kind"],
            digest,
            size: bytes.length,
            bytes: encodeBase64(bytes),
          },
        };
      }
      if (command === "stage") {
        const encoded = String(request["bytes"] ?? "");
        const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
        return {
          outcome: "performed",
          value: {
            kind: request["kind"],
            digest: request["digest"],
            size: (encoded.length / 4) * 3 - padding,
          },
        };
      }
      commits.push(request);
      if (lost) {
        return { outcome: "lost" };
      }
      if (refusal !== undefined) {
        return { outcome: "refused", refusal };
      }
      const publication = request["publication"];
      const events = Array.isArray(request["events"]) ? request["events"] : [];
      return {
        outcome: "performed",
        value: {
          workspaceRootId:
            publication === null || publication === undefined
              ? request["expectedWorkspaceRootId"]
              : (publication as Record<string, unknown>)["proposedWorkspaceRootId"],
          journalEventIds: events.map((_entry, index) => `event-${index}`),
        },
      };
    },
  };
}

/** A small starting tree, captured so a scripted owner can serve it. */
function* startingTree(): Operation<CapturedWorkspace> {
  const files = runnerFiles();
  const trees = yield* useRunnerTrees();
  const root = yield* trees.create("source");
  yield* until(writeFile(`${root}/README.md`, "starting\n", { mode: 0o644 }));
  yield* until(mkdir(`${root}/docs`, { mode: 0o755 }));
  return yield* captureWorkspace(
    files,
    (logical) => (logical === "/" ? root : `${root}${logical}`),
    reject,
  );
}

interface Harness {
  readonly run: RemoteRun;
  readonly commits: Record<string, unknown>[];
  refuse(reason: string): void;
  lose(): void;
  readonly sent: Record<string, unknown>[];
  readonly captured: CapturedWorkspace;
}

/**
 * Everything one remote invocation needs, wired the way a host would wire it.
 *
 * Deliberately the production pieces: the real client over a scripted socket,
 * the real database handle, the real coordinator and the real native adapters.
 * A test that assembled a simpler stand-in would prove that the stand-in works.
 */
function* harness(
  snapshot: (rootId: string) => RemoteInvocationSnapshot | { refused: string } = emptySnapshot,
  shared?: CapturedWorkspace,
): Operation<Harness> {
  const captured = shared ?? (yield* startingTree());
  const owner = ownerOf(captured, () => snapshot(captured.root.rootId));
  const transport = wire((request) => owner.answer(request));
  const connection = yield* useOwnerConnection(transport.socket);
  let identifier = 0;
  const next = () => `request-${(identifier += 1)}`;
  const reads = cloudflareReadLink(connection, next, RUN_ID);
  // The production constructor: the handle, the routed journal and the
  // provenance are made together from this one link.
  const run = yield* useRemoteRun({
    link: cloudflareRunLink(connection, reads, next, RUN_ID),
    reads,
    files: runnerFiles(),
    trees: yield* useRunnerTrees(),
    createFilesystem: (at, authorize) => createRemoteWorkspaceFilesystem(at, authorize),
    journal: new InMemoryStream(),
  });
  return {
    run,
    commits: owner.commits,
    refuse: owner.refuse,
    lose: owner.lose,
    sent: transport.sent,
    captured,
  };
}

/**
 * One invocation, with its own journal and its own provenance.
 *
 * Separate per call because that is what a host does: a run's journal is
 * established once per live session, and an invocation that reused another
 * one's would be publishing into a journal it does not belong to. It also lets
 * a later invocation observe what an earlier one left — which is the only way
 * to see the accepted Workspace, since the coordinator owns its trees and
 * removes them when it is done.
 */
function* invocation<T extends Json>(
  held: Harness,
  name: string,
  mutate: RemoteWorkspaceMutation<T>,
): Operation<{ raised: unknown; events: DurableEvent[] }> {
  return yield* scoped(function* () {
    yield* useRemoteWorkspaceEffects(held.run);
    const effect = createRemoteWorkspaceEffect(held.run, { type: "workspace", name }, mutate);
    function* workflow(): Workflow<void> {
      yield effect;
    }
    const raised = yield* trapped(
      withRemoteWorkspaceEffects(held.run, durableRun(workflow, { stream: held.run.journal })),
    );
    return { raised, events: yield* held.run.journal.readAll() };
  });
}

/** A mutation that touches nothing: these tests are about who may run one. */
// deno-lint-ignore require-yield
function* own(): Operation<Json> {
  return "ran";
}

function yielded(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield");
}

describe("the runner's Workspace coordinator", () => {
  it("commits Files, one mapping and the filtered result as one intent", function* () {
    yield* scoped(function* () {
      const held = yield* harness();
      const { raised, events } = yield* invocation(
        held,
        "write",
        function* (filesystem, metadata): Operation<Json> {
          yield* filesystem.writeFile("/NOTES.md", "written by the effect\n", 0o644);
          yield* filesystem.mkdir("/app", { mode: 0o755 });
          metadata.insertRepository(repository());
          // Read-your-writes: its own insert, before anything is committed.
          return metadata.readRepository("app")?.record.checkoutPath ?? "missing";
        },
      );
      expect(raised).toBe(undefined);

      // Exactly one intent, carrying all three things together.
      expect(held.commits).toHaveLength(1);
      const intent = held.commits[0] ?? {};
      expect(intent["expectedWorkspaceRootId"]).toBe(held.captured.root.rootId);
      const mappings = intent["mappings"];
      expect(Array.isArray(mappings) && mappings).toHaveLength(1);
      expect((mappings as Record<string, unknown>[])[0]?.["kind"]).toBe("repository");
      expect(intent["publication"]).not.toBe(null);
      // The result travelled in this same intent rather than through the
      // ordinary journal, so nothing was written before the owner agreed.
      expect(Array.isArray(intent["events"]) && intent["events"]).toHaveLength(1);
      expect(yielded(events)).toHaveLength(0);
    });
  });

  it("journals a documented failure against the unchanged root, and keeps nothing", function* () {
    yield* scoped(function* () {
      const held = yield* harness();
      const { raised } = yield* invocation(
        held,
        "refuse",
        function* (filesystem, metadata): Operation<Json> {
          yield* filesystem.writeFile("/SCRATCH.md", "discarded\n", 0o644);
          yield* filesystem.remove("/README.md");
          metadata.insertRepository(repository());
          throw new DocumentedFailure("this Workspace effect refused");
        },
      );
      expect(String(raised)).toContain("this Workspace effect refused");

      // One commit, and it proposes nothing about the Workspace.
      expect(held.commits).toHaveLength(1);
      const intent = held.commits[0] ?? {};
      expect(intent["publication"]).toBe(null);
      expect(intent["mappings"]).toEqual([]);
      expect(intent["expectedWorkspaceRootId"]).toBe(held.captured.root.rootId);
      expect(Array.isArray(intent["events"]) && intent["events"]).toHaveLength(1);

      // That the owner still holds the starting root after this is a claim
      // about storage, and it is made against real owner storage in
      // `remote-workspace.vitest.ts`. What is settled here is that nothing was
      // proposed: no publication, no mapping, and the root this commit expected
      // is the one the invocation was admitted from.
    });
  });

  it("prevents the document from running when the admitted root is unreachable", function* () {
    yield* scoped(function* () {
      const held = yield* harness(() => emptySnapshot("f".repeat(64)));
      let executed = 0;
      // deno-lint-ignore require-yield
      yield* invocation(held, "unreachable", function* (): Operation<Json> {
        executed += 1;
        return "ran";
      });
      // Materialization is before the transaction, so this never reaches the
      // anchor check — and it must still leave the run exactly as it was.
      expect(executed).toBe(0);
      expect(held.commits).toEqual([]);
    });
  });

  it("refuses before the document runs when the run moved since admission", function* () {
    yield* scoped(function* () {
      // The root still materializes, so the invocation gets all the way to the
      // transaction; the journal anchor is what has moved. Nothing later could
      // notice on its own — both answers were true when they were given.
      const held = yield* harness((rootId) => ({
        ...emptySnapshot(rootId),
        journalEventId: "event-from-another-moment",
      }));
      let executed = 0;
      // deno-lint-ignore require-yield
      const { raised } = yield* invocation(held, "drifted", function* (): Operation<Json> {
        executed += 1;
        return "ran";
      });
      expect(String(raised)).toContain("moved past");
      expect(executed).toBe(0);
      expect(held.commits).toEqual([]);
    });
  });

  it("leaves the accepted Workspace alone when the owner refuses the commit", function* () {
    yield* scoped(function* () {
      const held = yield* harness();
      held.refuse("command:stale-root");
      const { raised } = yield* invocation(
        held,
        "refused",
        function* (filesystem): Operation<Json> {
          yield* filesystem.writeFile("/NOTES.md", "written by the effect\n", 0o644);
          return "ran";
        },
      );
      expect(raised).not.toBe(undefined);
      // The owner said no, so nothing is promoted and nothing private crossed.
      expect(String(raised)).not.toContain("command:");
      expect(held.commits).toHaveLength(1);
    });
  });

  it("cannot pair one run's handle with another run's link, journal or provenance", function* () {
    yield* scoped(function* () {
      // Two owners, deliberately begun from the same root and the same empty
      // journal. Every structural value they hold is equal; only the objects
      // differ, and only the objects decide.
      const tree = yield* startingTree();
      const a = yield* harness(emptySnapshot, tree);
      const b = yield* harness(emptySnapshot, tree);
      expect(a.run.database.record.runId).toBe(b.run.database.record.runId);

      // An effect made against A, coordinated under B.
      yield* scoped(function* () {
        yield* useRemoteWorkspaceEffects(b.run);
        const effect = createRemoteWorkspaceEffect(a.run, { type: "workspace", name: "a" }, own);
        function* workflow(): Workflow<void> {
          yield effect;
        }
        const raised = yield* trapped(
          withRemoteWorkspaceEffects(b.run, durableRun(workflow, { stream: b.run.journal })),
        );
        expect(String(raised)).toContain("foreign");
      });

      // A's coordinator installed, B's binding asked to use it.
      yield* scoped(function* () {
        yield* useRemoteWorkspaceEffects(a.run);
        const effect = createRemoteWorkspaceEffect(b.run, { type: "workspace", name: "b" }, own);
        function* workflow(): Workflow<void> {
          yield effect;
        }
        const raised = yield* trapped(
          withRemoteWorkspaceEffects(b.run, durableRun(workflow, { stream: b.run.journal })),
        );
        expect(String(raised)).toContain("no remote Workspace coordinator is installed");
      });

      // B throughout, running over A's journal. The provenance is A's.
      yield* scoped(function* () {
        yield* useRemoteWorkspaceEffects(b.run);
        const effect = createRemoteWorkspaceEffect(b.run, { type: "workspace", name: "c" }, own);
        function* workflow(): Workflow<void> {
          yield effect;
        }
        const raised = yield* trapped(
          withRemoteWorkspaceEffects(b.run, durableRun(workflow, { stream: a.run.journal })),
        );
        expect(String(raised)).toContain("provenance");
      });

      // A value shaped like a binding is not one.
      const forged = { database: b.run.database, journal: b.run.journal };
      expect(
        String(yield* trapped(useRemoteWorkspaceEffects(forged as unknown as RemoteRun))),
      ).toContain("not a remote run this build opened");

      // Neither owner was asked for anything, and neither journal moved.
      expect([a.commits, b.commits]).toEqual([[], []]);
      expect(yielded(yield* a.run.journal.readAll())).toEqual([]);
      expect(yielded(yield* b.run.journal.readAll())).toEqual([]);
    });
  });

  it("refuses before the split, not after: the other run's journal stays empty", function* () {
    yield* scoped(function* () {
      // The discriminator. Before this correction, B's transaction would enlist
      // the Workspace while the publication appended through A's journal, and a
      // refusal from B would leave A holding an event for a commit that never
      // happened. The refusal has to come first.
      const tree = yield* startingTree();
      const a = yield* harness(emptySnapshot, tree);
      const b = yield* harness(emptySnapshot, tree);
      b.refuse("command:stale-root");

      yield* scoped(function* () {
        yield* useRemoteWorkspaceEffects(b.run);
        const effect = createRemoteWorkspaceEffect(
          b.run,
          { type: "workspace", name: "split" },
          function* (filesystem): Operation<Json> {
            yield* filesystem.writeFile("/NOTES.md", "written by the effect\n", 0o644);
            return "ran";
          },
        );
        function* workflow(): Workflow<void> {
          yield effect;
        }
        const raised = yield* trapped(
          withRemoteWorkspaceEffects(b.run, durableRun(workflow, { stream: a.run.journal })),
        );
        expect(String(raised)).toContain("provenance");
      });

      // No commit reached either owner, and A holds no event for work that
      // happened somewhere else.
      expect([a.commits, b.commits]).toEqual([[], []]);
      expect(yielded(yield* a.run.journal.readAll())).toEqual([]);
    });
  });

  it("refuses a binding whose scope has closed", function* () {
    let retained: RemoteRun | undefined;
    yield* scoped(function* () {
      retained = (yield* harness()).run;
    });
    if (retained === undefined) {
      throw new Error("expected a binding");
    }
    // The value outlived the scope that opened it; what it names did not.
    const held = retained;
    expect((yield* held.database.replaceRetrievalMetadata({ a: 1 })).ok).toBe(false);
    const raised = yield* trapped(
      scoped(function* () {
        yield* useRemoteWorkspaceEffects(held);
        const effect = createRemoteWorkspaceEffect(held, { type: "workspace", name: "late" }, own);
        function* workflow(): Workflow<void> {
          yield effect;
        }
        return yield* withRemoteWorkspaceEffects(
          held,
          durableRun(workflow, { stream: held.journal }),
        );
      }),
    );
    expect(raised).not.toBe(undefined);
  });

  it("refuses a Files capability kept past the invocation that owned it", function* () {
    yield* scoped(function* () {
      const held = yield* harness();
      let escaped: WorkspaceFilesystem | undefined;
      let metadata: WorkspaceMetadata | undefined;
      // deno-lint-ignore require-yield
      yield* invocation(held, "captured", function* (filesystem, held): Operation<Json> {
        escaped = filesystem;
        metadata = held;
        return "ran";
      });
      const wrote = yield* trapped(escaped?.writeFile("/LATE.md", "too late") ?? sleep(0));
      expect(String(wrote)).toContain("stale");
      expect(() => metadata?.insertRepository(repository())).toThrow();
    });
  });

  it("authorizes only paths beneath the attempt this invocation owns", function* () {
    yield* scoped(function* () {
      const held = yield* harness();
      const refused: string[] = [];
      // deno-lint-ignore require-yield
      const { raised } = yield* invocation(held, "escape", function* (filesystem): Operation<Json> {
        return yield* (function* (): Operation<Json> {
          for (const path of ["/../escaped", "/docs/../../escaped"]) {
            const failure = yield* trapped(filesystem.writeFile(path, "outside"));
            refused.push(String(failure));
          }
          // Both ends of a rename: checking one would let the other leave.
          refused.push(String(yield* trapped(filesystem.rename("/README.md", "/../moved"))));
          // The Workspace root itself is a directory this invocation owns.
          const entries = yield* filesystem.readdir("/");
          return entries.map((entry) => entry.name).toSorted();
        })();
      });
      expect(raised).toBe(undefined);
      expect(refused).toHaveLength(3);
      for (const failure of refused) {
        expect(failure).toContain("outside the tree this invocation owns");
      }
    });
  });

  it("claims nothing when the answer to its commit is lost", function* () {
    yield* scoped(function* () {
      const held = yield* harness();
      held.lose();
      const { raised } = yield* invocation(held, "lost", function* (filesystem): Operation<Json> {
        yield* filesystem.writeFile("/NOTES.md", "written by the effect\n", 0o644);
        return "ran";
      });
      // Whether the owner committed is exactly what cannot be known from here.
      // What must not happen is claiming it did.
      expect(raised).not.toBe(undefined);
      expect(String(raised)).not.toContain("command:");
      expect(held.commits).toHaveLength(1);
    });
  });

  it("sends nothing and keeps nothing when the invocation is cancelled", function* () {
    yield* scoped(function* () {
      const held = yield* harness();
      yield* useRemoteWorkspaceEffects(held.run);
      const effect = createRemoteWorkspaceEffect(
        held.run,
        { type: "workspace", name: "cancelled" },
        function* (filesystem): Operation<Json> {
          yield* filesystem.writeFile("/SLOW.md", "in progress\n", 0o644);
          yield* sleep(10_000);
          return "never";
        },
      );
      function* workflow(): Workflow<void> {
        yield effect;
      }
      const task = yield* spawn(() =>
        withRemoteWorkspaceEffects(held.run, durableRun(workflow, { stream: held.run.journal })),
      );
      yield* sleep(0);
      yield* task.halt();
      // Cancellation is control flow: nothing was claimed, and nothing was sent.
      expect(held.commits).toEqual([]);
      expect(yielded(yield* held.run.journal.readAll())).toHaveLength(0);
    });
  });
});

describe("what one invocation retains", () => {
  function view(snapshot: RemoteInvocationSnapshot) {
    return createInvocationMappings(snapshot, () => {});
  }

  it("reconciles a compatible same-name Repository without staging it again", function* () {
    const mappings = view({ ...emptySnapshot("a".repeat(64)), repositories: [repository()] });
    // The retained row is what a same-name read answers with.
    expect(mappings.metadata.readRepository("app")?.locator).toBe(LOCATOR);
    mappings.metadata.insertRepository(repository());
    expect(mappings.deltas()).toEqual([]);
    yield* sleep(0);
  });

  it("refuses a same-name Repository that is not the same Repository", function* () {
    const mappings = view({ ...emptySnapshot("a".repeat(64)), repositories: [repository()] });
    const conflicting = repository();
    expect(() =>
      mappings.metadata.insertRepository({
        ...conflicting,
        record: { ...conflicting.record, creationCommit: "1".repeat(40) },
      }),
    ).toThrow();
    // A conflict never replaces what is already there.
    expect(mappings.metadata.readRepository("app")?.record.creationCommit).toBe("9".repeat(40));
    expect(mappings.deltas()).toEqual([]);
    yield* sleep(0);
  });

  it("shows an invocation its own inserts and stages each exactly once", function* () {
    const mappings = view(emptySnapshot("a".repeat(64)));
    mappings.metadata.insertRepository(repository());
    mappings.metadata.insertRepository(repository());
    expect(mappings.metadata.readRepository("app")?.record.name).toBe("app");
    mappings.metadata.insertWorktree({
      repositoryName: "app",
      name: "feature",
      requestedBranch: "feature",
      requestedBase: null,
      creationCommit: "9".repeat(40),
      checkoutPath: "/app-feature",
    });
    const deltas = mappings.deltas();
    // Parents before children, whatever order they were staged in.
    expect(deltas.map((delta) => delta.kind)).toEqual(["repository", "worktree"]);
    yield* sleep(0);
  });

  it("keeps a Repository locator out of every value the record carries", function* () {
    const mappings = view(emptySnapshot("a".repeat(64)));
    mappings.metadata.insertRepository(repository());
    const [delta] = mappings.deltas();
    expect(delta?.kind).toBe("repository");
    if (delta?.kind === "repository") {
      expect(delta.locator).toBe(LOCATOR);
      // The record names the fingerprint and never the bytes.
      expect(JSON.stringify(delta.record)).not.toContain("git.example.invalid");
    }
    yield* sleep(0);
  });

  it("refuses a Worktree with no Repository and a path this build does not admit", function* () {
    const mappings = view(emptySnapshot("a".repeat(64)));
    expect(() =>
      mappings.metadata.insertWorktree({
        repositoryName: "missing",
        name: "feature",
        requestedBranch: "feature",
        requestedBase: null,
        creationCommit: "9".repeat(40),
        checkoutPath: "/app-feature",
      }),
    ).toThrow();
    mappings.metadata.insertRepository(repository());
    expect(() =>
      mappings.metadata.insertWorktree({
        repositoryName: "app",
        name: "feature",
        requestedBranch: "feature",
        requestedBase: null,
        creationCommit: "9".repeat(40),
        checkoutPath: "not-a-workspace-path",
      }),
    ).toThrow();
    yield* sleep(0);
  });

  it("resolves an Agent session by the shared rules and stages it once", function* () {
    const identity = {
      provider: "claude",
      agentCommand: "claude",
      sessionIdentity: "expansion-1",
    };
    const mappings = view(emptySnapshot("a".repeat(64)));
    const sessionKey = agentSessionKey(identity);
    // Nothing retained and nothing asserted: this is a new conversation.
    expect(resolveAgentSession(undefined, "reattach", [], identity).kind).toBe("create");

    // The pre-commit window: exactly one canonical assertion reconciles it.
    const reconciled = resolveAgentSession(
      mappings.agentSessions.read(sessionKey),
      "reattach",
      [{ kind: "session-id", value: "abc" }],
      identity,
    );
    expect(reconciled.kind).toBe("reattach");
    if (reconciled.kind === "reattach") {
      mappings.agentSessions.commit(reconciled.record);
      mappings.agentSessions.commit(reconciled.record);
    }
    expect(mappings.deltas().map((delta) => delta.kind)).toEqual(["agent-session"]);

    // A retained mapping the provider now contradicts refuses rather than
    // starting a replacement conversation.
    const retained = mappings.agentSessions.read(sessionKey);
    expect(retained).not.toBe(undefined);
    expect(() =>
      resolveAgentSession(retained, "reattach", [{ kind: "session-id", value: "other" }], identity),
    ).toThrow();
    expect(() => resolveAgentSession(retained, "reattach", [], identity)).toThrow();
    yield* sleep(0);
  });

  it("refuses more mappings, and more mapping bytes, than one commit may carry", function* () {
    const byCount = view(emptySnapshot("a".repeat(64)));
    expect(() => {
      for (let index = 0; index < 512; index += 1) {
        byCount.metadata.insertRepository(repository(`app-${String(index).padStart(4, "0")}`));
      }
    }).toThrow();

    // Few enough to pass the count, large enough that no message could carry
    // them. Bounding one without the other would leave the other reachable.
    const byBytes = view(emptySnapshot("a".repeat(64)));
    expect(() => {
      for (let index = 0; index < 64; index += 1) {
        const wide = repository(`wide-${String(index).padStart(4, "0")}`);
        byBytes.metadata.insertRepository({
          ...wide,
          record: {
            ...wide.record,
            creationCommit: "9".repeat(40),
            primaryBranch: "b".repeat(8192),
          },
        });
      }
    }).toThrow();
    yield* sleep(0);
  });
});

function* trapped(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}
