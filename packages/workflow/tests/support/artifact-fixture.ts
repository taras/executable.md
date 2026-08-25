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

  const events: readonly { event: DurableEvent; root: string }[] = [
    {
      event: sourced(
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "call", name: "workflow_run" },
          result: { status: "ok", value: { runId: "release-1.4" } },
        },
        3,
      ),
      root: first.rootId,
    },
    {
      // A retained external effect keeps its own journal record and nothing
      // else: the record is the evidence, not a second projection of it.
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
    },
    {
      event: {
        type: "close",
        coroutineId: "root",
        result: { status: "err", error: { message: "the release step failed" } },
      },
      root: second.rootId,
    },
  ];

  const journal = events.map((each, index) => ({
    eventId: `event-${index}`,
    record: serializeDurableEvent(each.event),
    workspaceRootId: each.root,
    // The first two rows arrived from the run this one was forked from; the
    // last is one this run wrote itself, and its absence is what says so.
    ...(index < 2
      ? { inherited: { sourceRunId: "release-1.3", sourceEventId: `origin-${index}` } }
      : {}),
  }));

  const definition = definitionOf();

  return {
    frontier: {
      sourceRunId: "release-1.4",
      finalEventId: "event-2",
      currentWorkspaceRootId: second.rootId,
    },
    run: {
      runId: "release-1.4",
      definition,
      base: "main",
      props: { channel: "stable", retries: 2 },
      status: "failed",
      stopReason: { kind: "journal", eventId: "event-2" },
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
        stopStatus: "failed",
        stopReason: { kind: "journal", eventId: "event-2" },
      },
    ],
    lineage: {
      sourceRunId: "release-1.3",
      checkpointEventId: "origin-1",
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
        suspensionId: "suspension-0",
        requestEventId: "event-1",
        requestFingerprint: sha256Hex(encoder.encode("first question")),
        answer: { approved: true },
        state: "consumed",
        createdAt: "2026-01-02T03:20:00.000Z",
        consumedAt: "2026-01-02T03:24:00.000Z",
      },
      {
        suspensionId: "suspension-1",
        requestEventId: "event-2",
        requestFingerprint: sha256Hex(encoder.encode("second question")),
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
