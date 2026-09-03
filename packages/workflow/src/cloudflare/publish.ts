/**
 * Deciding one proposal, and applying all of it or none of it.
 *
 * This is where a remote run actually moves. Everything before it is reading
 * and staging; everything after it is history. The runner has done the work,
 * captured a root, and offered a description of what it wants published — and
 * none of that is authority. The owner recomputes every identity, resolves
 * every piece against content it already holds or bytes this exact acquisition
 * staged, and only then writes.
 *
 * The order is deliberate and each step exists because skipping it is a way to
 * publish something nobody proposed:
 *
 *  1. The frontier is re-read *here*, inside the transaction, and compared with
 *     what the runner said it started from — root and terminal event both,
 *     `null` included exactly. A frontier read before the transaction is a
 *     frontier that can move before the write.
 *  2. The proposed identity is recomputed from the manifest rather than
 *     believed. An identity is a digest, and a digest a caller supplies is a
 *     claim about bytes rather than a property of them.
 *  3. The inventory must be exactly the closure of that manifest — every
 *     manifest its file entries name, every blob those manifests name, once
 *     each, and nothing else. A missing piece is a root that cannot be
 *     materialized; an extra one is content the root does not account for.
 *  4. Each piece resolves from authoritative content or from this acquisition's
 *     staging. Staging supplies bytes and grants nothing: a digest another
 *     acquisition staged is not reachable, and a digest already authoritative
 *     under different bytes is a disagreement rather than an overwrite.
 *  5. Content, root, references, mappings, the current pointer and the journal
 *     rows are written together. The pointer moves by compare-and-set from the
 *     expected root, so two commits racing the same frontier cannot both win.
 *
 * Journal rows are associated with the root this commit selected: the proposed
 * root when there is a publication, the unchanged expected root when there is
 * not. That is the same rule the local host follows, and it is what makes
 * history readable against the Workspace it happened in.
 *
 * Nothing here awaits, yields, sends a frame or contacts the runner. It runs
 * inside one synchronous transaction and returns a value the caller serializes
 * afterwards.
 */

import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import {
  compareUtf8,
  parseWorkspaceRootManifest,
  WORKSPACE_ROOT_DOMAIN,
} from "../workspace/root-manifest.ts";
import { decodeContentManifest } from "../workspace/content-manifest.ts";
import { MAX_CONTENT_BYTES } from "./commands.ts";
import { sha256Hex } from "../workspace/sha256.ts";
import { CommandError, type CommitCommand, type ProposedMapping } from "./commands.ts";
import { validateRetainedRoot } from "./owner-reads.ts";
import { bytesOf } from "./encoding.ts";
import { STAGING_TABLE } from "./private-schema.ts";
import type { OwnerStorage } from "./storage.ts";

/** What the owner answers a performed commit with. */
export interface CommitValue {
  readonly workspaceRootId: string;
  readonly journalEventIds: readonly string[];
}

function corrupt(reason: string): never {
  throw new WorkflowRecordMalformedError("workflow owner storage", reason);
}

function rows(
  storage: OwnerStorage,
  sql: string,
  ...bindings: unknown[]
): Record<string, unknown>[] {
  return storage.sql.exec(sql, ...bindings).toArray();
}

/** Content identities in the canonical order references are written in. */
function sortedDigests(digests: Iterable<string>): string[] {
  const found = [...digests];
  found.sort(compareUtf8);
  return found;
}

function hexBytes(digest: string): Uint8Array {
  const bytes = new Uint8Array(digest.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The frontier as it is right now, read where the write will happen.
 *
 * The current root is proved complete by the same validator the read boundary
 * uses, not merely read out of the pointer. A commit accepts its starting root
 * as the run's frontier, and accepting one whose content graph cannot be
 * materialized would append history against a Workspace nothing can restore —
 * a proposal is not a licence to repair, so damage is refused here rather than
 * worked around.
 */
function frontier(storage: OwnerStorage): { rootId: string; journalEventId: string | null } {
  const state = rows(storage, "SELECT current_root_id FROM workspace_state WHERE singleton_id = 1");
  const current = state[0]?.["current_root_id"];
  if (state.length !== 1 || typeof current !== "string") {
    return corrupt("the Workspace has no single current root");
  }
  validateRetainedRoot(storage, current);
  const last = rows(
    storage,
    "SELECT event_id FROM journal_events ORDER BY sequence DESC LIMIT 1",
  )[0];
  const eventId = last?.["event_id"];
  if (last !== undefined && typeof eventId !== "string") {
    return corrupt("a journal row has no identity");
  }
  return { rootId: current, journalEventId: last === undefined ? null : String(eventId) };
}

/** Bytes for one proposed identity, from what is authoritative or what was staged. */
function resolve(
  storage: OwnerStorage,
  acquisitionId: string,
  kind: "manifest" | "blob",
  digest: string,
): { bytes: Uint8Array; authoritative: boolean } {
  const table = kind === "manifest" ? "vfs_manifests" : "vfs_blob_bytes";
  const column = kind === "manifest" ? "encoded" : "bytes";
  const authoritative = rows(
    storage,
    `SELECT ${column} AS content FROM ${table} WHERE lower(hex(hash)) = ?`,
    digest,
  );
  if (authoritative.length > 1) {
    return corrupt("retained content is stored more than once under one identity");
  }
  const held = authoritative[0];
  if (held !== undefined) {
    const bytes = bytesOf(held["content"]);
    if (bytes.length > MAX_CONTENT_BYTES || sha256Hex(bytes) !== digest) {
      return corrupt("retained content disagrees with the identity it is stored under");
    }
    // The companion row is part of the same fact. A size that disagrees with
    // the bytes is damage, and adopting a proposal over it would publish a root
    // whose content the read path refuses.
    confirmCompanion(storage, kind, digest, bytes);
    return { bytes, authoritative: true };
  }
  const staged = rows(
    storage,
    `SELECT bytes FROM ${STAGING_TABLE} WHERE acquisition_id = ? AND kind = ? AND digest = ?`,
    acquisitionId,
    kind,
    digest,
  )[0];
  if (staged === undefined) {
    // Either never offered, or offered by an acquisition that is not this one.
    // Both are the same refusal: this proposal names content this connection
    // has not supplied.
    throw new CommandError("malformed-member");
  }
  const bytes = bytesOf(staged["bytes"]);
  if (sha256Hex(bytes) !== digest) {
    return corrupt("staged content disagrees with the identity it was stored under");
  }
  return { bytes, authoritative: false };
}

/**
 * The metadata stored beside one content identity, confirmed rather than fixed.
 *
 * A manifest's recorded size must equal what its chunks add up to; a blob's
 * recorded size must equal its bytes; and a blob's byte row and its `vfs_blobs`
 * row must both exist. Any disagreement is existing damage, refused here rather
 * than silently repaired by an `ON CONFLICT DO NOTHING` that leaves the wrong
 * row in place.
 */
function confirmCompanion(
  storage: OwnerStorage,
  kind: "manifest" | "blob",
  digest: string,
  bytes: Uint8Array,
): void {
  if (kind === "manifest") {
    const row = rows(
      storage,
      "SELECT size FROM vfs_manifests WHERE lower(hex(hash)) = ?",
      digest,
    )[0];
    const decoded = decodeContentManifest(bytes, corrupt);
    if (row === undefined || Number(row["size"]) !== decoded.size) {
      return corrupt("a retained manifest disagrees with its recorded size");
    }
    return;
  }
  const row = rows(storage, "SELECT size FROM vfs_blobs WHERE lower(hex(hash)) = ?", digest)[0];
  if (row === undefined || Number(row["size"]) !== bytes.length) {
    return corrupt("a retained blob disagrees with its recorded size");
  }
}

/**
 * Apply one proposal, entirely, inside the caller's open transaction.
 *
 * The caller has already proved the acquisition twice and recognized the store.
 * What is left is deciding whether this proposal is true and writing it.
 */
export function applyCommit(
  storage: OwnerStorage,
  acquisitionId: string,
  command: CommitCommand,
  mintEventId: () => string,
): CommitValue {
  const now = frontier(storage);
  if (now.rootId !== command.expectedWorkspaceRootId) {
    throw new CommandError("stale-root");
  }
  if (now.journalEventId !== command.expectedJournalEventId) {
    throw new CommandError("stale-journal");
  }

  const selected =
    command.publication === null
      ? command.expectedWorkspaceRootId
      : publish(storage, acquisitionId, command);

  const named = new Set<string>();
  for (const mapping of command.mappings) {
    const identity =
      mapping.kind === "worktree"
        ? `worktree:${mapping.record.repositoryName}/${mapping.record.name}`
        : `${mapping.kind}:${mapping.kind === "repository" ? mapping.record.name : mapping.record.sessionKey}`;
    if (named.has(identity)) {
      // One proposal naming one mapping twice cannot be applied once and is not
      // two mappings either.
      throw new CommandError("mapping-conflict");
    }
    named.add(identity);
  }
  const selectedEntries = directoriesOf(
    command.publication === null ? undefined : command.publication.proposedManifest,
  );
  for (const mapping of command.mappings) {
    applyMapping(storage, mapping, selectedEntries);
  }

  const journalEventIds: string[] = [];
  for (const record of command.events) {
    const eventId = mintEventId();
    storage.sql.exec(
      "INSERT INTO journal_events (event_id, record, workspace_root_id) VALUES (?, ?, ?)",
      eventId,
      record,
      selected,
    );
    journalEventIds.push(eventId);
  }

  return { workspaceRootId: selected, journalEventIds };
}

/** Adopt the content and the root, and move the pointer to it. */
function publish(storage: OwnerStorage, acquisitionId: string, command: CommitCommand): string {
  const proposal = command.publication;
  if (proposal === null) {
    return command.expectedWorkspaceRootId;
  }
  if (
    sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${proposal.proposedManifest}`) !==
    proposal.proposedWorkspaceRootId
  ) {
    throw new CommandError("malformed-member");
  }
  const parsed = parseWorkspaceRootManifest(proposal.proposedManifest, () => {
    throw new CommandError("malformed-member");
  });

  // The closure the manifest actually names, derived here rather than taken
  // from the inventory the request supplied.
  const named = new Set(
    parsed.entries.flatMap((entry) => (entry.kind === "file" ? [entry.manifest] : [])),
  );
  const offered = new Map(
    proposal.content.map((piece) => [`${piece.kind}:${piece.digest}`, piece]),
  );

  const manifests = new Map<string, Uint8Array>();
  for (const digest of named) {
    const piece = offered.get(`manifest:${digest}`);
    if (piece === undefined) {
      throw new CommandError("malformed-member");
    }
    const { bytes } = resolve(storage, acquisitionId, "manifest", digest);
    if (bytes.length !== piece.size) {
      throw new CommandError("malformed-member");
    }
    manifests.set(digest, bytes);
  }

  const blobs = new Map<string, number>();
  for (const [digest, bytes] of manifests) {
    const decoded = decodeContentManifest(bytes, () => {
      throw new CommandError("malformed-member");
    });
    for (const entry of parsed.entries) {
      if (entry.kind === "file" && entry.manifest === digest && entry.size !== decoded.size) {
        throw new CommandError("malformed-member");
      }
    }
    for (const chunk of decoded.chunks) {
      const seen = blobs.get(chunk.hash);
      if (seen !== undefined && seen !== chunk.size) {
        throw new CommandError("malformed-member");
      }
      blobs.set(chunk.hash, chunk.size);
    }
  }

  // Exactly the closure: nothing missing, nothing extra.
  if (offered.size !== named.size + blobs.size) {
    throw new CommandError("malformed-member");
  }

  const blobBytes = new Map<string, Uint8Array>();
  for (const [digest, size] of blobs) {
    const piece = offered.get(`blob:${digest}`);
    if (piece === undefined || piece.size !== size) {
      throw new CommandError("malformed-member");
    }
    const { bytes } = resolve(storage, acquisitionId, "blob", digest);
    if (bytes.length !== size) {
      throw new CommandError("malformed-member");
    }
    blobBytes.set(digest, bytes);
  }

  for (const [digest, bytes] of blobBytes) {
    const hash = hexBytes(digest);
    storage.sql.exec(
      "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, 0) ON CONFLICT(hash) DO NOTHING",
      hash,
      bytes.length,
    );
    storage.sql.exec(
      "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING",
      hash,
      bytes,
    );
  }
  for (const [digest, bytes] of manifests) {
    storage.sql.exec(
      `INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (?, ?, ?, 0)
        ON CONFLICT(hash) DO NOTHING`,
      hexBytes(digest),
      decodeContentManifest(bytes, () => {
        throw new CommandError("malformed-member");
      }).size,
      bytes,
    );
  }

  // Immutable: a root already retained is confirmed rather than rewritten.
  const existing = rows(
    storage,
    "SELECT manifest FROM workspace_roots WHERE root_id = ?",
    proposal.proposedWorkspaceRootId,
  )[0];
  if (existing === undefined) {
    storage.sql.exec(
      "INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, 1, ?)",
      proposal.proposedWorkspaceRootId,
      proposal.proposedManifest,
    );
    for (const digest of sortedDigests(named)) {
      storage.sql.exec(
        "INSERT INTO workspace_root_manifest_refs (root_id, manifest_hash) VALUES (?, ?)",
        proposal.proposedWorkspaceRootId,
        hexBytes(digest),
      );
    }
    for (const digest of sortedDigests(blobs.keys())) {
      storage.sql.exec(
        "INSERT INTO workspace_root_blob_refs (root_id, blob_hash) VALUES (?, ?)",
        proposal.proposedWorkspaceRootId,
        hexBytes(digest),
      );
    }
  } else if (existing["manifest"] !== proposal.proposedManifest) {
    return corrupt("a retained Workspace root disagrees with the identity it is stored under");
  }

  // Whether it was just written or was already there, the root the pointer is
  // about to name is proved to be a complete materializable root — the same
  // proof the read boundary applies, so a root cannot be publishable by one
  // path and refused by the other.
  validateRetainedRoot(storage, proposal.proposedWorkspaceRootId);

  // Compare-and-set. Two commits racing one frontier cannot both move it.
  storage.sql.exec(
    "UPDATE workspace_state SET current_root_id = ? WHERE singleton_id = 1 AND current_root_id = ?",
    proposal.proposedWorkspaceRootId,
    command.expectedWorkspaceRootId,
  );
  const moved = rows(
    storage,
    "SELECT current_root_id FROM workspace_state WHERE singleton_id = 1",
  )[0];
  if (moved?.["current_root_id"] !== proposal.proposedWorkspaceRootId) {
    throw new CommandError("stale-root");
  }
  return proposal.proposedWorkspaceRootId;
}

/**
 * Where a mapping's checkout has to exist, for the mapping to be true.
 *
 * A Repository or Worktree row names a checkout path, and the row is only
 * meaningful if the Workspace this commit selects actually contains it. A
 * mapping-only commit that invented a checkout would retain a claim about a
 * directory nothing put there, and the next execution would find the claim and
 * not the files.
 */
function requirePlacement(
  mapping: ProposedMapping,
  selectedEntries: ReadonlySet<string> | undefined,
): void {
  if (mapping.kind === "agent-session") {
    return;
  }
  if (selectedEntries === undefined) {
    // No publication accompanies this commit, so nothing can have created the
    // checkout. An exact confirmation of an already-retained mapping is still
    // admissible — that is decided below, once the existing row is read.
    return;
  }
  if (!selectedEntries.has(mapping.record.checkoutPath)) {
    throw new CommandError("mapping-conflict");
  }
}

/** Every directory the selected root contains, for placement checks. */
function directoriesOf(manifest: string | undefined): ReadonlySet<string> | undefined {
  if (manifest === undefined) {
    return undefined;
  }
  const parsed = parseWorkspaceRootManifest(manifest, () => {
    throw new CommandError("malformed-member");
  });
  return new Set(
    parsed.entries.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])),
  );
}

function sameText(row: Record<string, unknown>, column: string, expected: string | null): boolean {
  const value = row[column];
  return expected === null ? value === null : value === expected;
}

/**
 * One retained mapping, inserted or confirmed in full.
 *
 * Creation identity is immutable, so an existing row is compared on every field
 * that establishes it — not on a convenient subset. A partial comparison would
 * report performed for a proposal that disagrees with what an earlier execution
 * established, and the disagreement would only surface later, as a checkout
 * that is not what its record says.
 */
function applyMapping(
  storage: OwnerStorage,
  mapping: ProposedMapping,
  selectedEntries: ReadonlySet<string> | undefined,
): void {
  if (mapping.kind === "repository") {
    const record = mapping.record;
    const held = rows(
      storage,
      `SELECT locator, locator_fingerprint, requested_base, creation_commit, primary_branch,
              object_format, checkout_path FROM workspace_repositories WHERE name = ?`,
      record.name,
    )[0];
    if (held === undefined) {
      requirePlacement(mapping, selectedEntries);
      if (selectedEntries === undefined) {
        // A new checkout mapping with no Workspace publication to create it.
        throw new CommandError("mapping-conflict");
      }
      storage.sql.exec(
        `INSERT INTO workspace_repositories
          (name, locator, locator_fingerprint, requested_base, creation_commit,
           primary_branch, object_format, checkout_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        record.name,
        mapping.locator,
        record.locatorFingerprint,
        record.requestedBase,
        record.creationCommit,
        record.primaryBranch,
        record.objectFormat,
        record.checkoutPath,
      );
      return;
    }
    if (
      held["locator"] !== mapping.locator ||
      held["locator_fingerprint"] !== record.locatorFingerprint ||
      !sameText(held, "requested_base", record.requestedBase) ||
      held["creation_commit"] !== record.creationCommit ||
      held["primary_branch"] !== record.primaryBranch ||
      held["object_format"] !== record.objectFormat ||
      held["checkout_path"] !== record.checkoutPath
    ) {
      throw new CommandError("mapping-conflict");
    }
    return;
  }

  if (mapping.kind === "worktree") {
    const record = mapping.record;
    const held = rows(
      storage,
      `SELECT requested_branch, requested_base, creation_commit, checkout_path
         FROM workspace_worktrees WHERE repository_name = ? AND name = ?`,
      record.repositoryName,
      record.name,
    )[0];
    if (held === undefined) {
      // A Worktree exists inside a Repository. One that named none would be a
      // checkout belonging to nothing.
      const repository = rows(
        storage,
        "SELECT name FROM workspace_repositories WHERE name = ?",
        record.repositoryName,
      )[0];
      if (repository === undefined) {
        throw new CommandError("mapping-conflict");
      }
      requirePlacement(mapping, selectedEntries);
      if (selectedEntries === undefined) {
        throw new CommandError("mapping-conflict");
      }
      storage.sql.exec(
        `INSERT INTO workspace_worktrees
          (repository_name, name, requested_branch, requested_base, creation_commit, checkout_path)
          VALUES (?, ?, ?, ?, ?, ?)`,
        record.repositoryName,
        record.name,
        record.requestedBranch,
        record.requestedBase,
        record.creationCommit,
        record.checkoutPath,
      );
      return;
    }
    if (
      held["requested_branch"] !== record.requestedBranch ||
      !sameText(held, "requested_base", record.requestedBase) ||
      held["creation_commit"] !== record.creationCommit ||
      held["checkout_path"] !== record.checkoutPath
    ) {
      throw new CommandError("mapping-conflict");
    }
    return;
  }

  const record = mapping.record;
  const held = rows(
    storage,
    `SELECT provider, agent_command, session_identity, policy,
            assertion_kind, assertion_value, created_at
       FROM agent_sessions WHERE session_key = ?`,
    record.sessionKey,
  )[0];
  if (held === undefined) {
    storage.sql.exec(
      `INSERT INTO agent_sessions
        (session_key, provider, agent_command, session_identity, policy,
         assertion_kind, assertion_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.sessionKey,
      record.provider,
      record.agentCommand,
      record.sessionIdentity,
      record.policy,
      record.assertion.kind,
      record.assertion.value,
      record.createdAt,
    );
    return;
  }
  if (
    held["provider"] !== record.provider ||
    held["agent_command"] !== record.agentCommand ||
    held["session_identity"] !== record.sessionIdentity ||
    held["policy"] !== record.policy ||
    held["assertion_kind"] !== record.assertion.kind ||
    held["assertion_value"] !== record.assertion.value ||
    held["created_at"] !== record.createdAt
  ) {
    throw new CommandError("mapping-conflict");
  }
}
