/**
 * Tier WRH — what the production runner sends, and what it keeps.
 *
 * The owner's half is proved on real workerd, where atomicity and hibernation
 * are real. This is the other half: whether the runner can build the command
 * the owner accepts, whether it sends one at all when the work did not finish,
 * and whether anything survives on disk that should not.
 *
 * The connection is a deterministic fake because what crosses it is arithmetic
 * over what the transaction decided. The filesystem is real, because a tree
 * that was supposed to be removed is not a claim a fake can settle.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { ensure, type Operation, scoped, sleep, spawn, until } from "effection";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { agentSessionKey } from "../src/storage/agent-session.ts";
import { cloudflareOwnerLink } from "../src/cloudflare/client.ts";
import { runnerFiles, useRunnerTrees } from "../src/deno/remote-files.ts";
import {
  type CommitIntent,
  createTransactionGate,
  transactRemotely,
} from "../src/remote/collector.ts";
import { useAttempt, useMaterialization } from "../src/remote/invocation.ts";
import { type OwnerSocket, type SocketListener, useOwnerConnection } from "../src/remote/client.ts";
import type {
  RemoteContent,
  RemoteContentRequest,
  RemoteFrontierSnapshot,
  RemoteReadLink,
} from "../src/remote/read.ts";
import { captureWorkspace, type CapturedWorkspace } from "../src/remote/materialize.ts";
import {
  parseWorkspaceRootManifest,
  WORKSPACE_ROOT_DOMAIN,
} from "../src/workspace/root-manifest.ts";
import { sha256Hex } from "../src/workspace/sha256.ts";
import { locatorFingerprintOf } from "../src/composition/locator.ts";
import type { RetainedMapping } from "../src/remote/publication.ts";

function reject(reason: string): never {
  throw new Error(reason);
}

function event(name: string) {
  return {
    type: "yield" as const,
    coroutineId: "root",
    description: { type: "test", name },
    result: { status: "ok" as const, value: name },
  };
}

const LOCATOR = "https://git.example.invalid/octo/app.git";

/** The Repository mapping these tests enlist. */
function repositoryMapping(): RetainedMapping {
  return {
    kind: "repository",
    locator: LOCATOR,
    record: {
      name: "app",
      locatorFingerprint: locatorFingerprintOf(LOCATOR),
      requestedBase: null,
      creationCommit: "9".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1",
      checkoutPath: "/docs",
    },
  };
}

/** A recording connection: every request it was sent, and canned answers. */
function wire(answer: (request: Record<string, unknown>) => Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, Set<SocketListener>>();
  let deliver = true;
  const socket: OwnerSocket = {
    send(data: string): void {
      const request = JSON.parse(data) as Record<string, unknown>;
      sent.push(request);
      if (!deliver) {
        return;
      }
      const response = answer(request);
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
  return {
    socket,
    sent,
    /** Stop answering, as a connection lost mid-request would. */
    silence(): void {
      deliver = false;
    },
    end(): void {
      for (const listener of listeners.get("close") ?? []) {
        listener({});
      }
    },
  };
}

/**
 * What a correct owner answers each private command with.
 *
 * The commit answer is derived from the request the way the owner derives it:
 * the root the proposal selected — proposed when there is a publication, the
 * unchanged expected one when there is not — and one minted identity for each
 * event. The runner checks the answer against what it asked, so an owner that
 * answered with something else would not be believed.
 *
 * `sizes` is what the owner measured after decoding staged bytes.
 */
function ownerAnswers(_rootId = "", _sizes: ReadonlyMap<string, number> = new Map()) {
  return (request: Record<string, unknown>): Record<string, unknown> => {
    if (request["command"] === "stage") {
      // The length the owner would have measured after decoding, computed from
      // the encoding itself so this answers about the bytes it was actually
      // sent rather than about a number a test remembered to set.
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
    const publication = request["publication"];
    const selected =
      publication === null || publication === undefined
        ? request["expectedWorkspaceRootId"]
        : (publication as Record<string, unknown>)["proposedWorkspaceRootId"];
    const events = Array.isArray(request["events"]) ? request["events"] : [];
    return {
      outcome: "performed",
      value: {
        workspaceRootId: selected,
        journalEventIds: events.map((_entry, index) => `event-${index}`),
      },
    };
  };
}

/** The final command a transaction sent, proved to be one. */
function lastCommit(sent: readonly Record<string, unknown>[]): Record<string, unknown> {
  const commit = sent.at(-1);
  if (commit === undefined || commit["command"] !== "commit") {
    throw new Error("expected the last request to be a commit");
  }
  return commit;
}

/** One object member, read rather than asserted into shape. */
function member(value: unknown, name: string): Record<string, unknown> {
  const found = value === null || typeof value !== "object" ? undefined : Object.entries(value);
  const entry = found?.find(([key]) => key === name)?.[1];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`expected ${name} to be an object`);
  }
  return Object.fromEntries(Object.entries(entry));
}

/** One text member, read rather than asserted. */
function text(value: Record<string, unknown>, name: string): string {
  const found = value[name];
  if (typeof found !== "string") {
    throw new Error(`expected ${name} to be text`);
  }
  return found;
}

/** One list member, read the same way. */
function memberList(value: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const entry = value[name];
  if (!Array.isArray(entry)) {
    throw new Error(`expected ${name} to be a list`);
  }
  return entry.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`expected every ${name} entry to be an object`);
    }
    return Object.fromEntries(Object.entries(item));
  });
}

function ids(): () => string {
  let id = 0;
  return () => `request-${(id += 1)}`;
}

/** An owner that answers frontier/root/content from one captured tree. */
function readsOf(captured: {
  root: { manifest: string; rootId: string };
  contents: ReadonlyMap<string, { manifestBytes: Uint8Array }>;
  blobs: ReadonlyMap<string, Uint8Array>;
}): RemoteReadLink {
  return {
    // deno-lint-ignore require-yield
    *frontier(): Operation<RemoteFrontierSnapshot> {
      return {
        record: {
          runId: "remote-run",
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
        },
        retrieval: undefined,
        workspaceRootId: captured.root.rootId,
        journalEventId: null,
        entries: [],
      };
    },
    // deno-lint-ignore require-yield
    *root(workspaceRootId: string) {
      if (workspaceRootId !== captured.root.rootId) {
        throw new Error("asked for a root this owner does not hold");
      }
      return parseWorkspaceRootManifest(captured.root.manifest, reject);
    },
    // deno-lint-ignore require-yield
    *content(_rootId: string, request: RemoteContentRequest): Operation<RemoteContent> {
      const bytes =
        request.kind === "manifest"
          ? captured.contents.get(request.digest)?.manifestBytes
          : captured.blobs.get(request.digest);
      if (bytes === undefined) {
        throw new Error("asked for content this owner does not hold");
      }
      return { kind: request.kind, digest: request.digest, bytes };
    },
  };
}

/** A small starting tree, captured so an owner can serve it. */
function* startingTree(): Operation<{ captured: CapturedWorkspace; reads: RemoteReadLink }> {
  const files = runnerFiles();
  const trees = yield* useRunnerTrees();
  const root = yield* trees.create("source");
  yield* until(writeFile(`${root}/README.md`, "starting\n", { mode: 0o644 }));
  yield* until(mkdir(`${root}/docs`, { mode: 0o755 }));
  const captured = yield* captureWorkspace(
    files,
    (logical) => (logical === "/" ? root : `${root}${logical}`),
    reject,
  );
  return { captured, reads: readsOf(captured) };
}

describe("what the production runner publishes", () => {
  it("sends one closed commit describing everything the transaction decided", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const sizes = new Map<string, number>();
    const transport = wire(ownerAnswers(captured.root.rootId, sizes));
    const connection = yield* useOwnerConnection(transport.socket);

    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );
    const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
    yield* until(writeFile(attempt.at("/NOTES.md"), "written by the effect\n", { mode: 0o644 }));
    const proposed = yield* attempt.capture();
    for (const [digest, content] of proposed.contents) {
      sizes.set(digest, content.manifestBytes.length);
    }
    for (const [digest, bytes] of proposed.blobs) {
      sizes.set(digest, bytes.length);
    }

    const link = cloudflareOwnerLink(connection, reads, ids());
    const committed = yield* transactRemotely(
      link,
      createTransactionGate(),
      function* (transaction, enlist) {
        yield* transaction.journal.append(event("published"));
        enlist(attempt, [repositoryMapping()]);
        return "done";
      },
    );
    expect(committed).toMatchObject({ ok: true });

    // The last request is one closed commit carrying the whole proposal.
    const commit = lastCommit(transport.sent);
    expect(commit["expectedWorkspaceRootId"]).toBe(captured.root.rootId);
    expect(commit["events"]).toEqual([serializeDurableEvent(event("published"))]);
    const publication = member(commit, "publication");
    expect(publication["proposedWorkspaceRootId"]).toBe(proposed.root.rootId);
    expect(sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${String(publication["proposedManifest"])}`)).toBe(
      proposed.root.rootId,
    );
    expect(text(memberList(commit, "mappings")[0] ?? {}, "locator")).toBe(LOCATOR);
    // Everything the proposal names was staged before the commit went out.
    const staged = transport.sent.filter((request) => request["command"] === "stage");
    expect(staged.length).toBe(proposed.root.manifests.length + proposed.root.blobs.length);
  });

  it("sends no commit and keeps no tree when the body does not finish", function* () {
    const files = runnerFiles();
    const outcomes: Record<string, () => Operation<unknown>> = {};
    for (const description of ["raises", "is cancelled"]) {
      let attemptPath = "";
      const transport = wire(ownerAnswers(""));
      yield* scoped(function* () {
        const trees = yield* useRunnerTrees();
        const { captured, reads } = yield* startingTree();
        const connection = yield* useOwnerConnection(transport.socket);
        const link = cloudflareOwnerLink(connection, reads, ids());
        const materialization = yield* useMaterialization(
          files,
          trees,
          reads,
          captured.root.rootId,
          reject,
        );
        let raised: unknown;
        yield* scoped(function* () {
          const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
          attemptPath = attempt.at("/");
          if (description === "raises") {
            try {
              yield* transactRemotely(link, createTransactionGate(), function* () {
                throw new Error("the effect failed");
              });
            } catch (error) {
              raised = error;
            }
            return;
          }
          const running = yield* spawn(() =>
            transactRemotely(link, createTransactionGate(), function* () {
              yield* sleep(10_000);
              return "never";
            }),
          );
          yield* sleep(0);
          yield* running.halt();
        });
        expect([description, description === "raises" ? raised instanceof Error : true]).toEqual([
          description,
          true,
        ]);
      });
      // No commit was sent, and the attempt tree is gone.
      expect([
        description,
        transport.sent.some((request) => request["command"] === "commit"),
      ]).toEqual([description, false]);
      let listed: unknown;
      try {
        listed = yield* until(readdir(attemptPath));
      } catch (error) {
        listed = error;
      }
      expect([description, listed instanceof Error]).toEqual([description, true]);
    }
    void outcomes;
  });

  it("transfers the attempt inside the transaction that the owner performed", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const sizes = new Map<string, number>();
    const transport = wire(ownerAnswers("", sizes));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );
    const acceptedBefore = materialization.at("/");

    let attemptRoot = "";
    let acceptedDuringBody = "";
    const committed = yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      attemptRoot = attempt.at("/");
      yield* until(writeFile(attempt.at("/NOTES.md"), "published\n", { mode: 0o644 }));
      const proposed = yield* attempt.capture();
      for (const [digest, content] of proposed.contents) {
        sizes.set(digest, content.manifestBytes.length);
      }
      for (const [digest, blob] of proposed.blobs) {
        sizes.set(digest, blob.length);
      }
      return yield* transactRemotely(link, createTransactionGate(), function* (_tx, enlist) {
        enlist(attempt);
        // Still the old Workspace while the answer is unknown.
        acceptedDuringBody = materialization.at("/");
        return "done";
      });
    });

    expect(committed).toMatchObject({ ok: true });
    expect(acceptedDuringBody).toBe(acceptedBefore);

    // By the time the transaction reported success the transfer had happened:
    // the accepted path is the attempt's tree and reads the attempted bytes.
    expect(materialization.at("/")).toBe(attemptRoot);
    expect(materialization.workspaceRootId).not.toBe(captured.root.rootId);
    expect(yield* until(readFile(materialization.at("/NOTES.md"), "utf8"))).toBe("published\n");

    // And the tree the run used to be at is gone.
    let listed: unknown;
    try {
      listed = yield* until(readdir(acceptedBefore));
    } catch (error) {
      listed = error;
    }
    expect(listed).toBeInstanceOf(Error);
  });

  it("offers no way to move the accepted Workspace without the owner", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );
    const accepted = materialization.at("/");

    yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      yield* until(writeFile(attempt.at("/NOTES.md"), "never published\n", { mode: 0o644 }));

      // Everything a caller can reach by name. Reading where the Workspace is,
      // reading what an attempt holds — and nothing that moves either.
      expect(Object.keys(materialization).toSorted()).toEqual(["at", "workspaceRootId"]);
      expect(Object.keys(attempt).toSorted()).toEqual(["at", "capture"]);
      const reachable = [
        ...Object.getOwnPropertyNames(attempt),
        ...Object.getOwnPropertyNames(materialization),
      ];
      for (const name of ["promote", "transfer", "replace", "accept", "propose", "seal"]) {
        expect(reachable).not.toContain(name);
      }

      // A caller can still capture. What it gets back is a description, and
      // there is nothing to hand it to: `enlist` takes an attempt, so a
      // publication that no live attempt owns cannot be expressed at all.
      const described = yield* attempt.capture();
      expect(described.root.rootId).not.toBe(captured.root.rootId);
    });

    expect(materialization.at("/")).toBe(accepted);
    expect(materialization.workspaceRootId).toBe(captured.root.rootId);
  });

  it("cannot be changed by a caller that kept its own copy", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(""));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );

    const mappings: RetainedMapping[] = [repositoryMapping()];
    yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
        enlist(attempt, mappings);
        // The caller still holds the array it passed and edits it afterwards.
        const first = mappings[0];
        if (first?.kind === "repository") {
          mappings[0] = { ...first, locator: "https://elsewhere.invalid/x.git" };
        }
        return "done";
      });
    });
    expect(text(memberList(lastCommit(transport.sent), "mappings")[0] ?? {}, "locator")).toBe(
      LOCATOR,
    );
  });

  it("sends a journal-only commit with no publication and stages nothing", function* () {
    const files = runnerFiles();
    yield* scoped(function* () {
      const trees = yield* useRunnerTrees();
      void trees;
      const { captured, reads } = yield* startingTree();
      const transport = wire(ownerAnswers(captured.root.rootId));
      const connection = yield* useOwnerConnection(transport.socket);
      const link = cloudflareOwnerLink(connection, reads, ids());
      const committed = yield* transactRemotely(
        link,
        createTransactionGate(),
        function* (transaction) {
          yield* transaction.journal.append(event("noted"));
          return "done";
        },
      );
      expect(committed).toMatchObject({ ok: true });

      const commit = lastCommit(transport.sent);
      // A transaction that only appended proposes nothing. Inventing a
      // Workspace change to make the shape uniform would publish a root nobody
      // asked for, so `publication` is null and nothing was staged.
      expect(commit["publication"]).toBe(null);
      expect(commit["mappings"]).toEqual([]);
      expect(transport.sent.some((request) => request["command"] === "stage")).toBe(false);
    });
    void files;
  });

  it("encodes every kind of retained mapping the owner accepts", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(""));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );
    yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
        enlist(attempt, [
          repositoryMapping(),
          {
            kind: "worktree",
            record: {
              repositoryName: "app",
              name: "feature",
              requestedBranch: "feature",
              requestedBase: null,
              creationCommit: "2".repeat(40),
              checkoutPath: "/docs",
            },
          },
          {
            kind: "agent-session",
            record: {
              provider: "acp",
              agentCommand: "/usr/bin/agent",
              sessionIdentity: "session-1",
              sessionKey: agentSessionKey({
                provider: "acp",
                agentCommand: "/usr/bin/agent",
                sessionIdentity: "session-1",
              }),
              policy: "strict",
              assertion: { kind: "acp-session", value: "abc" },
              createdAt: "2026-09-03T00:00:00.000Z",
            },
          },
        ]);
        return "done";
      });
    });
    const mappings = memberList(lastCommit(transport.sent), "mappings");
    expect(mappings.map((mapping) => mapping["kind"])).toEqual([
      "repository",
      "worktree",
      "agent-session",
    ]);
    // Only a Repository carries the locator; the other two are the record.
    expect(mappings.filter((mapping) => "locator" in mapping)).toHaveLength(1);
  });

  it("retries a lost answer with the same identity and the same bytes", function* () {
    // A retry happens on a new connection: the one that lost the answer is
    // gone, and a connection refuses to reuse a correlation id of its own. What
    // has to be stable is the identity across those two connections, because
    // that is what the owner recognizes the retry by.
    const sent: Record<string, unknown>[][] = [];
    let intent: CommitIntent | undefined;
    for (const attempt of [0, 1]) {
      yield* scoped(function* () {
        const { captured, reads } = yield* startingTree();
        const transport = wire(ownerAnswers(captured.root.rootId));
        sent.push(transport.sent);
        const connection = yield* useOwnerConnection(transport.socket);
        const link = cloudflareOwnerLink(connection, reads, ids());
        intent ??= {
          expectedWorkspaceRootId: captured.root.rootId,
          expectedJournalEventId: null,
          events: [],
          publication: null,
          mappings: [],
          bytes: new Map(),
        };
        const committed = yield* link.commit(intent);
        expect([attempt, committed.ok]).toEqual([attempt, true]);
      });
    }

    const first = sent[0]?.find((request) => request["command"] === "commit");
    const second = sent[1]?.find((request) => request["command"] === "commit");
    expect(first?.["id"]).toBe(second?.["id"]);
    // Byte-equivalent, so the owner sees the request it already decided.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("asks a different question for a different proposal", function* () {
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(captured.root.rootId));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const intent: CommitIntent = {
      expectedWorkspaceRootId: captured.root.rootId,
      expectedJournalEventId: null,
      events: [],
      publication: null,
      mappings: [],
      bytes: new Map(),
    };
    yield* link.commit(intent);
    yield* link.commit({ ...intent, events: [event("later")] });
    const commits = transport.sent.filter((request) => request["command"] === "commit");
    expect(commits).toHaveLength(2);
    expect(commits[0]?.["id"]).not.toBe(commits[1]?.["id"]);
  });

  it("promotes nothing and keeps no tree when the owner refuses", function* () {
    const files = runnerFiles();
    let attemptPath = "";
    yield* scoped(function* () {
      const trees = yield* useRunnerTrees();
      const { captured, reads } = yield* startingTree();
      const transport = wire(() => ({ outcome: "refused", refusal: "command:stale-root" }));
      const connection = yield* useOwnerConnection(transport.socket);
      const link = cloudflareOwnerLink(connection, reads, ids());
      const materialization = yield* useMaterialization(
        files,
        trees,
        reads,
        captured.root.rootId,
        reject,
      );
      yield* scoped(function* () {
        const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
        attemptPath = attempt.at("/");
        yield* until(writeFile(attempt.at("/NOTES.md"), "refused\n", { mode: 0o644 }));
        const committed = yield* transactRemotely(link, createTransactionGate(), function* () {
          return "done";
        });
        // A refusal is an answer, and the answer is no.
        expect(committed.ok).toBe(false);
      });
      expect(materialization.workspaceRootId).toBe(captured.root.rootId);
    });
    let listed: unknown;
    try {
      listed = yield* until(readdir(attemptPath));
    } catch (error) {
      listed = error;
    }
    expect(listed).toBeInstanceOf(Error);
  });

  it("promotes nothing when the answer is lost", function* () {
    const files = runnerFiles();
    yield* scoped(function* () {
      const trees = yield* useRunnerTrees();
      const { captured, reads } = yield* startingTree();
      const transport = wire(ownerAnswers(captured.root.rootId));
      const connection = yield* useOwnerConnection(transport.socket);
      const link = cloudflareOwnerLink(connection, reads, ids());
      const materialization = yield* useMaterialization(
        files,
        trees,
        reads,
        captured.root.rootId,
        reject,
      );
      yield* scoped(function* () {
        const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
        yield* until(writeFile(attempt.at("/NOTES.md"), "unanswered\n", { mode: 0o644 }));
        // The connection goes while the answer is in flight.
        transport.silence();
        const asking = yield* spawn(() =>
          transactRemotely(link, createTransactionGate(), function* () {
            return "done";
          }),
        );
        yield* sleep(0);
        transport.end();
        const committed = yield* asking;
        // Undecided, not failed — whether the owner committed cannot be known
        // from here. Either way nothing is promoted locally.
        expect(committed.ok).toBe(false);
      });
      expect(materialization.workspaceRootId).toBe(captured.root.rootId);
    });
  });

  it("sends nothing when a resource the body started fails to tear down", function* () {
    let sent: Record<string, unknown>[] = [];
    let raised: unknown;
    try {
      yield* scoped(function* () {
        const { captured, reads } = yield* startingTree();
        const transport = wire(ownerAnswers(captured.root.rootId));
        sent = transport.sent;
        const connection = yield* useOwnerConnection(transport.socket);
        const link = cloudflareOwnerLink(connection, reads, ids());
        yield* transactRemotely(link, createTransactionGate(), function* (transaction) {
          yield* transaction.journal.append(event("appended"));
          // A resource whose teardown fails. The body finished, but everything
          // it started did not, so the transaction has not finished either —
          // and the failure surfaces as the scope unwinds rather than inside it.
          yield* ensure(() => {
            throw new Error("teardown failed");
          });
          return "done";
        });
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Error);
    expect(sent.some((request) => request["command"] === "commit")).toBe(false);
  });

  it("sends nothing when the transaction exceeds a local bound", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(""));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );
    let raised: unknown;
    yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      try {
        yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
          // More retained mappings than one intent may carry.
          enlist(
            attempt,
            Array.from({ length: 300 }, () => repositoryMapping()),
          );
          return "done";
        });
      } catch (error) {
        raised = error;
      }
    });
    expect(raised).toBeInstanceOf(Error);
    expect(transport.sent.some((request) => request["command"] === "commit")).toBe(false);
    expect(materialization.workspaceRootId).toBe(captured.root.rootId);
  });

  it("refuses a performed answer that names a root this proposal did not select", function* () {
    const { captured, reads } = yield* startingTree();
    // An owner agreeing to something else is not an owner this runner can go
    // on talking to: believing it would promote a Workspace nobody proposed.
    const transport = wire(() => ({
      outcome: "performed",
      value: { workspaceRootId: "f".repeat(64), journalEventIds: [] },
    }));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const committed = yield* link.commit({
      expectedWorkspaceRootId: captured.root.rootId,
      expectedJournalEventId: null,
      events: [],
      publication: null,
      mappings: [],
      bytes: new Map(),
    });
    expect(committed.ok).toBe(false);
  });

  it("refuses a performed answer that loses an event it was given", function* () {
    const { captured, reads } = yield* startingTree();
    const transport = wire((request) => ({
      outcome: "performed",
      value: { workspaceRootId: request["expectedWorkspaceRootId"], journalEventIds: [] },
    }));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const committed = yield* link.commit({
      expectedWorkspaceRootId: captured.root.rootId,
      expectedJournalEventId: null,
      events: [event("appended")],
      publication: null,
      mappings: [],
      bytes: new Map(),
    });
    // One identity per event, or the two sides disagree about what history
    // this commit created.
    expect(committed.ok).toBe(false);
  });

  it("seals a nested mapping value against later mutation", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(""));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );

    const assertion = { kind: "acp-session", value: "admitted" };
    const identity = {
      provider: "acp",
      agentCommand: "/usr/bin/agent",
      sessionIdentity: "session-1",
    };
    yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
        enlist(attempt, [
          {
            kind: "agent-session",
            record: {
              ...identity,
              sessionKey: agentSessionKey(identity),
              policy: "strict",
              assertion,
              createdAt: "2026-09-03T00:00:00.000Z",
            },
          },
        ]);
        // The caller still holds the nested assertion object and edits it.
        assertion.value = "changed after admission";
        return "done";
      });
    });

    const mapping = memberList(lastCommit(transport.sent), "mappings")[0] ?? {};
    expect(text(member(member(mapping, "record"), "assertion"), "value")).toBe("admitted");
  });

  it("commits the tree as it finally is, not as it was when enlisted", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const sizes = new Map<string, number>();
    const transport = wire(ownerAnswers("", sizes));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );

    let atEnlistment = "";
    yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      yield* until(writeFile(attempt.at("/NOTES.md"), "first\n", { mode: 0o644 }));
      const committed = yield* transactRemotely(
        link,
        createTransactionGate(),
        function* (_transaction, enlist) {
          enlist(attempt);
          atEnlistment = (yield* attempt.capture()).root.rootId;
          // The body goes on working after designating the attempt. Sealing
          // happens after teardown, so this is what gets proposed.
          yield* until(writeFile(attempt.at("/NOTES.md"), "second\n", { mode: 0o644 }));
          const staged = yield* attempt.capture();
          for (const [digest, content] of staged.contents) {
            sizes.set(digest, content.manifestBytes.length);
          }
          for (const [digest, blob] of staged.blobs) {
            sizes.set(digest, blob.length);
          }
          return "done";
        },
      );
      expect(committed).toMatchObject({ ok: true });
    });

    // The root the owner was asked to publish is the final one, not the one the
    // tree held when the body enlisted it.
    const proposed = member(lastCommit(transport.sent), "publication");
    expect(proposed["proposedWorkspaceRootId"]).not.toBe(atEnlistment);
    // And the accepted tree recaptures to exactly the root that was committed.
    expect(materialization.workspaceRootId).toBe(proposed["proposedWorkspaceRootId"]);
    expect(yield* until(readFile(materialization.at("/NOTES.md"), "utf8"))).toBe("second\n");
  });

  it("refuses a second Workspace publication in one transaction", function* () {
    const files = runnerFiles();
    const trees = yield* useRunnerTrees();
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(""));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const materialization = yield* useMaterialization(
      files,
      trees,
      reads,
      captured.root.rootId,
      reject,
    );
    let raised: unknown;
    yield* scoped(function* () {
      const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
      try {
        yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
          enlist(attempt);
          enlist(attempt);
          return "done";
        });
      } catch (error) {
        raised = error;
      }
    });
    // Two Workspaces proposed for one commit is a choice nobody may make on the
    // run's behalf, so the transaction fails and nothing is sent.
    expect(raised).toBeInstanceOf(Error);
    expect(transport.sent.some((request) => request["command"] === "commit")).toBe(false);
  });
});
