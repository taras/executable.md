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
import { encodeBase64 } from "../src/cloudflare/encoding.ts";
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
import type { ProposedContent, RetainedMapping } from "../src/remote/publication.ts";

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

/** The exact closure a proposed root names, in canonical order. */
function inventoryOf(captured: CapturedWorkspace): ProposedContent[] {
  return [
    ...captured.root.manifests.map((digest) => ({
      kind: "manifest" as const,
      digest,
      size: captured.contents.get(digest)?.manifestBytes.length ?? 0,
    })),
    ...captured.root.blobs.map((digest) => ({
      kind: "blob" as const,
      digest,
      size: captured.blobs.get(digest)?.length ?? 0,
    })),
  ];
}

/** Every piece a capture can supply, by identity. */
function proposedBytes(captured: CapturedWorkspace): Map<string, Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  for (const [digest, content] of captured.contents) {
    bytes.set(digest, content.manifestBytes);
  }
  for (const [digest, blob] of captured.blobs) {
    bytes.set(digest, blob);
  }
  return bytes;
}

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
function ownerAnswers(_rootId: string, sizes: ReadonlyMap<string, number> = new Map()) {
  return (request: Record<string, unknown>): Record<string, unknown> => {
    if (request["command"] === "stage") {
      return {
        outcome: "performed",
        value: {
          kind: request["kind"],
          digest: request["digest"],
          size: sizes.get(String(request["digest"])) ?? 0,
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
        enlist({
          publication: {
            proposedWorkspaceRootId: proposed.root.rootId,
            proposedManifest: proposed.root.manifest,
            content: [
              ...proposed.root.manifests.map((digest) => ({
                kind: "manifest" as const,
                digest,
                size: proposed.contents.get(digest)?.manifestBytes.length ?? 0,
              })),
              ...proposed.root.blobs.map((digest) => ({
                kind: "blob" as const,
                digest,
                size: proposed.blobs.get(digest)?.length ?? 0,
              })),
            ],
          },
          mappings: [repositoryMapping()],
          bytes: proposedBytes(proposed),
        });
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

  it("promotes only with the owner's decision, and moves the tree with it", function* () {
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

    // A decision the owner did not give cannot promote.
    let raised: unknown;
    try {
      yield* attempt.promote({ workspaceRootId: captured.root.rootId, journalEventIds: [] });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Error);
    expect(materialization.workspaceRootId).toBe(captured.root.rootId);

    // The owner's own answer, naming the root this attempt captured.
    const committed = yield* link.commit({
      expectedWorkspaceRootId: captured.root.rootId,
      expectedJournalEventId: null,
      events: [],
      publication: {
        proposedWorkspaceRootId: proposed.root.rootId,
        proposedManifest: proposed.root.manifest,
        content: inventoryOf(proposed),
      },
      mappings: [],
      bytes: proposedBytes(proposed),
    });
    if (!committed.ok) {
      throw committed.error;
    }
    yield* attempt.promote(committed.value);

    // The accepted materialization is the promoted tree, not a relabelled
    // copy of the old one: the file the effect wrote is readable through it.
    expect(materialization.workspaceRootId).not.toBe(captured.root.rootId);
    expect(materialization.at("/")).toBe(attemptRoot);
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

  it("cannot be changed by a caller that kept its own copy", function* () {
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(captured.root.rootId));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const content: ProposedContent[] = [{ kind: "manifest", digest: "a".repeat(64), size: 1 }];
    const mappings: RetainedMapping[] = [
      {
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
      },
    ];
    yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
      enlist({
        publication: {
          proposedWorkspaceRootId: captured.root.rootId,
          proposedManifest: captured.root.manifest,
          content,
        },
        mappings,
        bytes: new Map(),
      });
      // The caller still holds both arrays and edits them after admission.
      content.push({ kind: "blob", digest: "b".repeat(64), size: 2 });
      const first = mappings[0];
      if (first?.kind === "repository") {
        mappings[0] = { ...first, locator: "https://elsewhere.invalid/x.git" };
      }
      return "done";
    });
    const commit = lastCommit(transport.sent);
    expect(memberList(member(commit, "publication"), "content")).toHaveLength(1);
    expect(text(memberList(commit, "mappings")[0] ?? {}, "locator")).toBe(LOCATOR);
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
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(captured.root.rootId));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
      enlist({
        publication: {
          proposedWorkspaceRootId: captured.root.rootId,
          proposedManifest: captured.root.manifest,
          content: [],
        },
        bytes: new Map(),
        mappings: [
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
        ],
      });
      return "done";
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
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(captured.root.rootId));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    let raised: unknown;
    try {
      yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
        enlist({
          publication: {
            proposedWorkspaceRootId: captured.root.rootId,
            proposedManifest: captured.root.manifest,
            content: [],
          },
          // More retained mappings than one intent may carry.
          mappings: Array.from({ length: 300 }, () => repositoryMapping()),
          bytes: new Map(),
        });
        return "done";
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Error);
    expect(transport.sent.some((request) => request["command"] === "commit")).toBe(false);
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

  it("seals nested mapping values and content bytes against later mutation", function* () {
    const { captured, reads } = yield* startingTree();
    const sizes = new Map<string, number>();
    const transport = wire(ownerAnswers("", sizes));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());

    const assertion = { kind: "acp-session", value: "admitted" };
    const identity = {
      provider: "acp",
      agentCommand: "/usr/bin/agent",
      sessionIdentity: "session-1",
    };
    const piece = new TextEncoder().encode("admitted bytes");
    const digest = sha256Hex(piece);
    sizes.set(digest, piece.length);
    const bytes = new Map([[digest, piece]]);

    yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
      enlist({
        publication: {
          proposedWorkspaceRootId: captured.root.rootId,
          proposedManifest: captured.root.manifest,
          content: [{ kind: "blob", digest, size: piece.length }],
        },
        mappings: [
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
        ],
        bytes,
      });
      // The caller still holds the assertion object and the byte buffer, and
      // edits both after the transaction admitted them.
      assertion.value = "changed after admission";
      piece.fill(0);
      bytes.set(digest, new TextEncoder().encode("substituted"));
      return "done";
    });

    // What was sent is what was admitted, not what the caller did afterwards.
    const mapping = memberList(lastCommit(transport.sent), "mappings")[0] ?? {};
    expect(text(member(member(mapping, "record"), "assertion"), "value")).toBe("admitted");
    const staged = transport.sent.find((request) => request["command"] === "stage");
    expect(staged?.["digest"]).toBe(digest);
    expect(staged?.["bytes"]).toBe(encodeBase64(new TextEncoder().encode("admitted bytes")));
  });

  it("refuses a second Workspace publication in one transaction", function* () {
    const { captured, reads } = yield* startingTree();
    const transport = wire(ownerAnswers(captured.root.rootId));
    const connection = yield* useOwnerConnection(transport.socket);
    const link = cloudflareOwnerLink(connection, reads, ids());
    const proposal = {
      publication: {
        proposedWorkspaceRootId: captured.root.rootId,
        proposedManifest: captured.root.manifest,
        content: [],
      },
      mappings: [],
      bytes: new Map<string, Uint8Array>(),
    };
    let raised: unknown;
    try {
      yield* transactRemotely(link, createTransactionGate(), function* (_transaction, enlist) {
        enlist(proposal);
        enlist(proposal);
        return "done";
      });
    } catch (error) {
      raised = error;
    }
    // Two Workspaces proposed for one commit is a choice nobody may make on
    // the run's behalf, so the transaction fails and nothing is sent.
    expect(raised).toBeInstanceOf(Error);
    expect(transport.sent.some((request) => request["command"] === "commit")).toBe(false);
  });
});
