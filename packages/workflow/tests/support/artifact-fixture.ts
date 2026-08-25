/**
 * One rich detached snapshot, and the pieces a test needs to damage it.
 *
 * Everything here is built the way the live provider builds it — real
 * content-addressed blobs, real DOFS manifests, real Workspace root manifests
 * whose identities are the hash of their own canonical bytes, real serialized
 * durable events, real Git blob identities over the embedded Markdown. Nothing
 * stands in for any of it, because a fixture whose hashes were made up could
 * not tell a working verifier from one that never looked.
 *
 * The snapshot is deliberately the awkward case rather than the small one: two
 * Workspace roots that share some content and not the rest, a hardlink group, a
 * symbolic link, a non-default file mode, sourced and inherited journal rows, a
 * prior fork lineage, both suspension-answer states, a Repository with a
 * Worktree, an Agent session mapping, a retained external effect, and one
 * declared component the run never expanded.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { SOURCE_POSITION_FIELD } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { SUSPENSION_ANSWER } from "../../src/suspension/answer.ts";
import { parseSuspensionRequest, suspensionRequestFingerprint } from "../../src/suspension/api.ts";
import { SUSPENSION_REQUEST, suspensionId } from "../../src/suspension/suspend.ts";
import { parseWorkflowDefinition } from "../../src/storage/definition.ts";
import type { GitWorkflowDefinitionV1 } from "../../src/storage/definition.ts";
import {
  compareUtf8,
  encodeWorkspaceManifest,
  workspaceRoot,
  type WorkspaceRootEntry,
} from "../../src/deno/workspace/manifest.ts";
import type { DetachedXmdArtifact } from "../../src/deno/artifact/mod.ts";

const encoder = new TextEncoder();

/** The commit every source in this fixture is pinned to. */
export const PINNED_COMMIT = "9fceb02d0ae598e95dc970b74767f19372d61af8";

/** The run every derived identity in this fixture belongs to. */
export const RUN_ID = "release-1.4";

/** The run this one was forked from, and whose history it inherited. */
export const SOURCE_RUN_ID = "release-1.3";

/**
 * One durable wait, as the two events a live run publishes for it.
 *
 * Built with the live descriptions rather than with hand-written objects, so a
 * fixture cannot drift from the shape the verifier authenticates against. The
 * request carries the wait's identity twice over and the schema an answer is
 * judged by; the publication is what makes an answer consumed rather than
 * pending, and carries the value that was retained.
 */
export function wait(
  id: string,
  request: Json,
  responseSchema: Json,
  coroutineId: string = "root",
) {
  const parsed = parseSuspensionRequest({ request, responseSchema });
  return {
    id,
    request: {
      type: "yield",
      coroutineId,
      description: {
        type: SUSPENSION_REQUEST,
        name: id,
        suspensionId: id,
        request: parsed.request,
        responseSchema: parsed.responseSchema,
      },
      result: { status: "ok", value: id },
    } satisfies DurableEvent,
    fingerprint: suspensionRequestFingerprint(parsed),
    publication(value: Json): DurableEvent {
      return {
        type: "yield",
        coroutineId,
        description: { type: SUSPENSION_ANSWER, name: id, suspensionId: id },
        result: { status: "ok", value },
      };
    },
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A Git blob identity, assembled from bytes so no NUL reaches this source. */
export function gitBlobId(content: string, format: "sha1" | "sha256" = "sha1"): string {
  const bytes = encoder.encode(content);
  return createHash(format)
    .update(encoder.encode(`blob ${bytes.byteLength}`))
    .update(new Uint8Array([0]))
    .update(bytes)
    .digest("hex");
}

interface Blob {
  readonly hash: Uint8Array;
  readonly size: number;
  readonly lastSeen: number;
  readonly content: Uint8Array;
}

interface Manifest {
  readonly hash: Uint8Array;
  readonly size: number;
  readonly encoded: Uint8Array;
  readonly lastSeen: number;
}

/** One stored file: its bytes as a single chunk, and the manifest naming it. */
interface StoredFile {
  readonly blob: Blob;
  readonly manifest: Manifest;
  readonly manifestHash: string;
  readonly size: number;
}

function storeFile(text: string): StoredFile {
  const content = encoder.encode(text);
  const blobHash = sha256Hex(content);
  const blob: Blob = {
    hash: new Uint8Array(Buffer.from(blobHash, "hex")),
    size: content.byteLength,
    lastSeen: 0,
    content,
  };
  // The DOFS manifest's canonical encoding: schema key order, no whitespace.
  const encoded = encoder.encode(
    JSON.stringify({ version: 1, chunks: [{ hash: blobHash, size: content.byteLength }] }),
  );
  const manifestHash = sha256Hex(encoded);
  return {
    blob,
    manifest: {
      hash: new Uint8Array(Buffer.from(manifestHash, "hex")),
      size: content.byteLength,
      encoded,
      lastSeen: 0,
    },
    manifestHash,
    size: content.byteLength,
  };
}

function directory(path: string, mode = 0o755): WorkspaceRootEntry {
  return { path, kind: "directory", mode, mtime: 0 };
}

function file(
  path: string,
  stored: StoredFile,
  mode = 0o644,
  hardlink: string | null = null,
): WorkspaceRootEntry {
  return {
    path,
    kind: "file",
    mode,
    mtime: 0,
    size: stored.size,
    manifest: stored.manifestHash,
    hardlink,
  };
}

function symlink(path: string, target: string): WorkspaceRootEntry {
  return { path, kind: "symlink", mode: 0o777, mtime: 0, target };
}

function rootOf(entries: readonly WorkspaceRootEntry[], files: readonly StoredFile[]) {
  // Canonical order is the manifest's, not the order a fixture happened to
  // list them in, so a test reads as the tree it describes.
  const ordered = [...entries].sort((left, right) => compareUtf8(left.path, right.path));
  const manifest = encodeWorkspaceManifest(ordered, "fixture");
  const used = new Set(
    entries.filter((entry) => entry.kind === "file").map((entry) => entry.manifest),
  );
  const selected = files.filter((stored) => used.has(stored.manifestHash));
  const manifestHashes = [...new Set(selected.map((stored) => stored.manifestHash))].sort();
  const blobHashes = [...new Set(selected.map((stored) => sha256Hex(stored.blob.content)))].sort();
  return workspaceRoot(manifest, manifestHashes, blobHashes);
}

function sourced(event: DurableEvent, line: number): DurableEvent {
  if (event.type !== "yield") {
    return event;
  }
  return {
    ...event,
    description: {
      ...event.description,
      [SOURCE_POSITION_FIELD]: { path: "workflows/release.md", offset: 0, line, column: 1 },
    },
  };
}

export function definitionOf(
  overrides: Partial<GitWorkflowDefinitionV1> = {},
): GitWorkflowDefinitionV1 {
  const parsed = parseWorkflowDefinition({
    version: 1,
    kind: "git",
    objectFormat: "sha1",
    objectId: PINNED_COMMIT,
    rootDocumentPath: "workflows/release.md",
    targetPath: "release-steps",
    components: [
      { name: "Checklist", path: "workflows/Checklist.md", sourceHash: gitBlobId(CHECKLIST) },
      { name: "Unused", path: "workflows/Unused.md", sourceHash: gitBlobId(UNUSED) },
    ],
    ...overrides,
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/**
 * The two waits this fixture's history is built from.
 *
 * Module-level so a test can name the same identities the snapshot retains,
 * rather than restating them and drifting. Derived the way a run derives them —
 * from the run and the durable position — so the fixture is a snapshot some
 * execution could actually have produced.
 */
export const SUSPENSIONS = {
  /**
   * A wait the *source* run answered, inherited whole.
   *
   * Its request and its publication are both copied by a fork; the retained
   * answer row behind them is not, because fork creation copies journal rows,
   * Workspace roots and checkout records and nothing else. So this pair is
   * present with no row of its own — which is a shape the verifier has to
   * accept, and the reason its identity is derived from the source run.
   */
  inherited: wait(
    suspensionId(SOURCE_RUN_ID, { coroutineId: "root", index: 4 }),
    { kind: "approval", release: "1.3" },
    { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
  ),
  /** A wait this run reached and answered itself. Its row is retained. */
  consumed: wait(
    suspensionId(RUN_ID, { coroutineId: "root", index: 3 }),
    { kind: "approval", release: "1.4" },
    { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
  ),
  /** The wait this run is suspended at. Delivered, not yet published. */
  pending: wait(
    suspensionId(RUN_ID, { coroutineId: "root", index: 5 }),
    { kind: "confirmation", question: "ship it?" },
    { type: "string" },
  ),
} as const;

const ROOT_DOCUMENT = "# Release\n\n<Checklist />\n";
const CHECKLIST = "- [ ] tag\n";
const UNUSED = "This component was declared and never expanded.\n";

/**
 * The whole snapshot, once.
 *
 * Built fresh on every call so a test that damages a copy cannot reach the one
 * the next test builds.
 */
export function richArtifact(): DetachedXmdArtifact {
  const shared = storeFile("shared between both roots\n");
  const early = storeFile("only the first root has this\n");
  const late = storeFile("only the second root has this\n");

  const first = rootOf(
    [
      directory("/"),
      directory("/workspace"),
      file("/workspace/shared.txt", shared),
      file("/workspace/early.txt", early),
    ],
    [shared, early],
  );

  // A hardlink group, a symbolic link, and a mode nothing defaults to, so the
  // metadata a Workspace can hold is round-tripped rather than assumed absent.
  const second = rootOf(
    [
      directory("/"),
      directory("/repo"),
      directory("/repo/worktrees"),
      directory("/workspace"),
      file("/workspace/link-a.txt", late, 0o600, "h0"),
      file("/workspace/link-b.txt", late, 0o600, "h0"),
      file("/workspace/shared.txt", shared, 0o755),
      symlink("/workspace/pointer", "shared.txt"),
    ],
    [shared, late],
  );

  // The history of a fork that reached a wait, answered it, and is now stopped
  // at a second one. Durable positions are per coroutine and count settled
  // yields, so `root` runs 0..5 and `root.0` runs 0..0 — which is what puts
  // each publication directly behind the request it answers.
  const events: readonly { event: DurableEvent; root: string; own: boolean }[] = [
    {
      // root/0 — the record this fork wrote for itself.
      event: sourced(
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "call", name: "workflow_run" },
          result: { status: "ok", value: { runId: RUN_ID } },
        },
        3,
      ),
      root: first.rootId,
      own: true,
    },
    // root/1 and root/2 — the source run's answered wait, copied whole.
    { event: SUSPENSIONS.inherited.request, root: first.rootId, own: false },
    {
      event: SUSPENSIONS.inherited.publication({ approved: true }),
      root: first.rootId,
      own: false,
    },
    {
      // root.0/0 — a retained external effect keeps its own journal record and
      // nothing else: the record is the evidence, not a second projection.
      event: sourced(
        {
          type: "yield",
          coroutineId: "root.0",
          description: { type: "git_effect", name: "push", branch: "release" },
          result: { status: "ok", value: { commit: PINNED_COMMIT } },
        },
        9,
      ),
      root: second.rootId,
      own: false,
    },
    {
      // A Close settles no durable operation, so it occupies no position.
      event: { type: "close", coroutineId: "root.0", result: { status: "ok", value: null } },
      root: second.rootId,
      own: true,
    },
    // root/3 and root/4 — the wait this run answered, and its publication.
    { event: sourced(SUSPENSIONS.consumed.request, 11), root: second.rootId, own: true },
    {
      event: SUSPENSIONS.consumed.publication({ approved: true }),
      root: second.rootId,
      own: true,
    },
    // root/5 — the wait this run is suspended at. Nothing published behind it.
    { event: sourced(SUSPENSIONS.pending.request, 14), root: second.rootId, own: true },
  ];

  const journal = events.map((each, index) => ({
    eventId: `event-${index}`,
    record: serializeDurableEvent(each.event),
    workspaceRootId: each.root,
    // Provenance marks exactly the rows a fork copies. A row this run wrote
    // carries none, and its absence is what says so — so a retained answer row,
    // which fork creation never copies, never sits behind an inherited request.
    ...(each.own
      ? {}
      : { inherited: { sourceRunId: SOURCE_RUN_ID, sourceEventId: `origin-${index}` } }),
  }));

  const definition = definitionOf();

  return {
    frontier: {
      sourceRunId: RUN_ID,
      finalEventId: "event-7",
      currentWorkspaceRootId: second.rootId,
    },
    run: {
      runId: RUN_ID,
      definition,
      base: "main",
      props: { channel: "stable", retries: 2 },
      status: "suspended",
      stopReason: { kind: "journal", eventId: "event-7" },
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:44:05.000Z",
    },
    executions: [
      {
        executionId: "execution-0",
        startedAt: "2026-01-02T03:04:05.000Z",
        stoppedAt: "2026-01-02T03:14:05.000Z",
        stopStatus: "interrupted",
        stopReason: { kind: "host", code: "host-lost" },
      },
      {
        executionId: "execution-1",
        startedAt: "2026-01-02T03:24:05.000Z",
        stoppedAt: "2026-01-02T03:44:05.000Z",
        stopStatus: "suspended",
        stopReason: { kind: "journal", eventId: "event-7" },
      },
    ],
    lineage: {
      sourceRunId: SOURCE_RUN_ID,
      checkpointEventId: "origin-2",
      checkpointWorkspaceRootId: first.rootId,
      createdAt: "2026-01-02T03:04:00.000Z",
    },
    journal,
    roots: [first, second],
    manifests: [shared.manifest, early.manifest, late.manifest],
    blobs: [shared.blob, early.blob, late.blob],
    repositories: [
      {
        name: "product",
        locator: "https://git.invalid/octo/product.git",
        locatorFingerprint: sha256Hex(encoder.encode("https://git.invalid/octo/product.git")),
        requestedBase: "main",
        creationCommit: PINNED_COMMIT,
        primaryBranch: "main",
        objectFormat: "sha1",
        checkoutPath: "/repo",
      },
    ],
    worktrees: [
      {
        repositoryName: "product",
        name: "release",
        requestedBranch: "release",
        requestedBase: null,
        creationCommit: PINNED_COMMIT,
        checkoutPath: "/repo/worktrees",
      },
    ],
    answers: [
      {
        suspensionId: SUSPENSIONS.consumed.id,
        requestEventId: "event-5",
        requestFingerprint: SUSPENSIONS.consumed.fingerprint,
        answer: { approved: true },
        state: "consumed",
        createdAt: "2026-01-02T03:20:00.000Z",
        consumedAt: "2026-01-02T03:24:00.000Z",
      },
      {
        suspensionId: SUSPENSIONS.pending.id,
        requestEventId: "event-7",
        requestFingerprint: SUSPENSIONS.pending.fingerprint,
        answer: "ship it",
        state: "pending",
        createdAt: "2026-01-02T03:40:00.000Z",
        consumedAt: undefined,
      },
    ],
    agentSessions: [agentSession()],
    definition: {
      root: {
        objectFormat: "sha1",
        pinnedCommit: PINNED_COMMIT,
        rootDocumentPath: "workflows/release.md",
        targetPath: "release-steps",
        blobId: gitBlobId(ROOT_DOCUMENT),
        content: ROOT_DOCUMENT,
      },
      components: [
        {
          name: "Checklist",
          path: "workflows/Checklist.md",
          blobId: gitBlobId(CHECKLIST),
          content: CHECKLIST,
        },
        { name: "Unused", path: "workflows/Unused.md", blobId: gitBlobId(UNUSED), content: UNUSED },
      ],
    },
  };
}

/** One Agent session mapping, retained under the key its identity derives. */
function agentSession() {
  const identity = {
    provider: "acp",
    agentCommand: "claude",
    sessionIdentity: "expansion:release/Agent[0]/Session[0]",
  };
  return {
    ...identity,
    sessionKey: [
      "xmd",
      "workflow",
      "v1",
      createHash("sha256").update(identity.sessionIdentity, "utf8").digest("hex").slice(0, 32),
    ].join(":"),
    policy: "deny-all",
    assertion: { kind: "acp/sessionId", value: "sess_01J" },
    createdAt: "2026-01-02T03:05:00.000Z",
  };
}
