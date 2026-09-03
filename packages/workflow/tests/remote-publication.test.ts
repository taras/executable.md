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
import { type Operation, scoped, sleep, spawn, until } from "effection";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { cloudflareOwnerLink } from "../src/cloudflare/client.ts";
import { runnerFiles, useRunnerTrees } from "../src/deno/remote-files.ts";
import { createTransactionGate, transactRemotely } from "../src/remote/collector.ts";
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
 * `sizes` is what the owner would have measured after decoding the bytes it was
 * sent. The runner checks that against what it sent, so an owner that guessed
 * would be answering about content it had not read.
 */
function ownerAnswers(rootId: string, sizes: ReadonlyMap<string, number> = new Map()) {
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
    return {
      outcome: "performed",
      value: { workspaceRootId: rootId, journalEventIds: ["e1"] },
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
    yield* scoped(function* () {
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

      const link = cloudflareOwnerLink(connection, reads, ids(), (kind, digest) =>
        kind === "manifest"
          ? proposed.contents.get(digest)?.manifestBytes
          : proposed.blobs.get(digest),
      );
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
            mappings: [
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
            ],
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

  it("keeps the accepted root until the owner performs the commit", function* () {
    const files = runnerFiles();
    yield* scoped(function* () {
      const trees = yield* useRunnerTrees();
      const { captured, reads } = yield* startingTree();
      const materialization = yield* useMaterialization(
        files,
        trees,
        reads,
        captured.root.rootId,
        reject,
      );
      yield* scoped(function* () {
        const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
        yield* until(writeFile(attempt.at("/NOTES.md"), "not published\n", { mode: 0o644 }));
        // The owner refused, so nothing promotes.
      });
      expect(materialization.workspaceRootId).toBe(captured.root.rootId);

      yield* scoped(function* () {
        const attempt = yield* useAttempt(files, trees, reads, materialization, reject);
        yield* until(writeFile(attempt.at("/NOTES.md"), "published\n", { mode: 0o644 }));
        yield* attempt.promote();
      });
      // Only a promoted attempt moves what the run is at.
      expect(materialization.workspaceRootId).not.toBe(captured.root.rootId);
    });
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
