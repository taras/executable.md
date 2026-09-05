/**
 * A concrete owner, so admission and acquisition can be exercised end to end.
 *
 * It supplies the two things `WorkflowOwnerObject` leaves abstract — a policy
 * and a `perform` — and nothing else. `perform` answers with the command it was
 * given rather than doing durable work: what these tests are about is who is
 * allowed to send one, not what each one means.
 */

import { run } from "effection";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import { acquisitionHolders } from "../../../src/cloudflare/acquisition.ts";
import { WorkflowOwnerObject } from "../../../src/cloudflare/owner.ts";
import type { AdmissionRequest, OwnerConfiguration } from "../../../src/cloudflare/owner.ts";
import type { AdmissionPolicy } from "../../../src/cloudflare/admission.ts";
import type { TokenVerification, VerificationKey } from "../../../src/cloudflare/token.ts";
import { refusalOf } from "../../../src/cloudflare/owner.ts";
import { sha256Hex } from "../../../src/workspace/sha256.ts";
import { WORKSPACE_ROOT_DOMAIN } from "../../../src/workspace/root-manifest.ts";
import { COMMAND_TABLE, STAGING_TABLE } from "../../../src/cloudflare/private-schema.ts";
import { MARKER_TABLE } from "../../../src/cloudflare/marker.ts";

/** The identities this owner is configured to admit. */
export const POLICY: AdmissionPolicy = {
  issuer: "https://token.actions.githubusercontent.com",
  audience: "https://factory.example",
  repositoryId: "123456",
  repositoryOwnerId: "654321",
  eventName: "repository_dispatch",
  workflowRef: "octo/repo/.github/workflows/factory.yml@refs/heads/main",
  workflowSha: "0f2c9a1b3d4e5f60718293a4b5c6d7e8f9012345",
  jobWorkflowRef: "octo/repo/.github/workflows/factory.yml@refs/heads/main",
  release: "factory-2026.09.02-abcdef",
};

/** The claims a correctly issued token carries for the policy above. */
export const VALID_CLAIMS: Record<string, unknown> = {
  iss: POLICY.issuer,
  aud: POLICY.audience,
  repository_id: POLICY.repositoryId,
  repository_owner_id: POLICY.repositoryOwnerId,
  event_name: POLICY.eventName,
  workflow_ref: POLICY.workflowRef,
  workflow_sha: POLICY.workflowSha,
  job_workflow_ref: POLICY.jobWorkflowRef,
};

export const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
export const FILE_BYTES = new TextEncoder().encode("hello from the retained Workspace");
export const BLOB_ID = sha256Hex(FILE_BYTES);
export const DOFS_MANIFEST = JSON.stringify({
  version: 1,
  chunks: [{ hash: BLOB_ID, size: FILE_BYTES.length }],
});
export const MANIFEST_ID = sha256Hex(new TextEncoder().encode(DOFS_MANIFEST));
export const ROOT_MANIFEST = JSON.stringify({
  format: 1,
  entries: [
    { path: "/", kind: "directory", mode: 493, mtime: 0 },
    {
      path: "/README.md",
      kind: "file",
      mode: 420,
      mtime: 0,
      size: FILE_BYTES.length,
      manifest: MANIFEST_ID,
      hardlink: null,
    },
  ],
});
export const ROOT_ID = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${ROOT_MANIFEST}`);

/** A second root: the same tree with one more file, as a proposal would be. */
export const NEXT_BYTES = new TextEncoder().encode("published by the runner");
export const NEXT_BLOB_ID = sha256Hex(NEXT_BYTES);
export const NEXT_DOFS_MANIFEST = JSON.stringify({
  version: 1,
  chunks: [{ hash: NEXT_BLOB_ID, size: NEXT_BYTES.length }],
});
export const NEXT_MANIFEST_ID = sha256Hex(new TextEncoder().encode(NEXT_DOFS_MANIFEST));
export const NEXT_ROOT_MANIFEST = JSON.stringify({
  format: 1,
  entries: [
    { path: "/", kind: "directory", mode: 493, mtime: 0 },
    {
      path: "/NOTES.md",
      kind: "file",
      mode: 420,
      mtime: 0,
      size: NEXT_BYTES.length,
      manifest: NEXT_MANIFEST_ID,
      hardlink: null,
    },
    {
      path: "/README.md",
      kind: "file",
      mode: 420,
      mtime: 0,
      size: FILE_BYTES.length,
      manifest: MANIFEST_ID,
      hardlink: null,
    },
    // The checkout a Repository mapping claims, in canonical byte order — a
    // mapping whose directory the proposed root does not contain is a record
    // about files nobody wrote.
    { path: "/app", kind: "directory", mode: 493, mtime: 0 },
  ],
});
export const NEXT_ROOT_ID = sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${NEXT_ROOT_MANIFEST}`);

/**
 * The proposal that publishes `NEXT_ROOT_ID`.
 *
 * Its inventory is the exact closure of the proposed manifest: both file
 * manifests and both blobs, once each, in canonical order. One of each is
 * already authoritative, which is what proves the owner reuses retained content
 * by identity rather than requiring it to be sent again.
 */
export function nextPublication(): Record<string, unknown> {
  const content: { kind: string; digest: string; size: number }[] = [
    { kind: "blob", digest: BLOB_ID, size: FILE_BYTES.length },
    { kind: "blob", digest: NEXT_BLOB_ID, size: NEXT_BYTES.length },
    { kind: "manifest", digest: MANIFEST_ID, size: DOFS_MANIFEST.length },
    { kind: "manifest", digest: NEXT_MANIFEST_ID, size: NEXT_DOFS_MANIFEST.length },
  ];
  content.sort((left, right) =>
    `${left.kind}:${left.digest}` < `${right.kind}:${right.digest}` ? -1 : 1,
  );
  return {
    proposedWorkspaceRootId: NEXT_ROOT_ID,
    proposedManifest: NEXT_ROOT_MANIFEST,
    content,
  };
}
const CREATED_AT = "2026-09-03T00:00:00.000Z";

export class ExecutorObject extends WorkflowOwnerObject {
  /**
   * The verification material this owner is configured with.
   *
   * Installed by a test before it connects, exactly as a deployment would
   * install a fetched JWKS. It is closure state on the object, never something
   * an admission request can name.
   */
  #keys: VerificationKey[] = [];
  #now = 1_800_000_000;
  #skew = 0;

  configure(keys: VerificationKey[], now?: number, skew?: number): void {
    this.#keys = keys;
    if (now !== undefined) {
      this.#now = now;
    }
    if (skew !== undefined) {
      this.#skew = skew;
    }
  }

  protected configuration(): OwnerConfiguration {
    const verification: TokenVerification = {
      keys: this.#keys,
      skewSeconds: this.#skew,
      now: () => this.#now,
    };
    return { policy: POLICY, verification };
  }

  initialize(): void {
    this.open(RUN_ID, () => {
      const blob = hexBytes(BLOB_ID);
      const manifest = hexBytes(MANIFEST_ID);
      this.ctx.storage.sql.exec(
        "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, 0)",
        blob,
        FILE_BYTES.length,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)",
        blob,
        new Uint8Array(FILE_BYTES),
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (?, ?, ?, 0)",
        manifest,
        FILE_BYTES.length,
        new TextEncoder().encode(DOFS_MANIFEST),
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, 1, ?)",
        ROOT_ID,
        ROOT_MANIFEST,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO workspace_root_manifest_refs (root_id, manifest_hash) VALUES (?, ?)",
        ROOT_ID,
        manifest,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO workspace_root_blob_refs (root_id, blob_hash) VALUES (?, ?)",
        ROOT_ID,
        blob,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO workspace_state (singleton_id, current_root_id) VALUES (1, ?)",
        ROOT_ID,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO workflow_run
          (id, run_id, definition, base, props, status, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?, 'running', ?, ?)`,
        RUN_ID,
        JSON.stringify({
          version: 1,
          kind: "git",
          objectFormat: "sha1",
          objectId: "0".repeat(40),
          rootDocumentPath: "README.md",
        }),
        "main",
        "{}",
        CREATED_AT,
        CREATED_AT,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO definition_retrieval (id, metadata, revision, updated_at) VALUES (1, ?, 1, ?)",
        JSON.stringify({ locator: "https://example.invalid/repository.git" }),
        CREATED_AT,
      );
    });
  }

  appendJournal(eventId: string, name: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO journal_events (event_id, record, workspace_root_id) VALUES (?, ?, ?)",
      eventId,
      serializeDurableEvent({
        type: "yield",
        coroutineId: "root",
        description: { type: "test", name },
        result: { status: "ok", value: name },
      }),
      ROOT_ID,
    );
  }

  scratch(): { commands: number; staged: number } {
    const commands = this.ctx.storage.sql
      .exec(`SELECT count(*) AS count FROM ${COMMAND_TABLE}`)
      .toArray()[0]?.["count"];
    const staged = this.ctx.storage.sql
      .exec(`SELECT count(*) AS count FROM ${STAGING_TABLE}`)
      .toArray()[0]?.["count"];
    return {
      commands: typeof commands === "number" ? commands : -1,
      staged: typeof staged === "number" ? staged : -1,
    };
  }

  /**
   * Everything this run authoritatively holds, as one comparable value.
   *
   * Row-for-row rather than a count: cleanup that deleted a journal event and
   * inserted another would keep every count identical, and the claim being
   * checked is that acquisition cleanup touched none of this.
   */
  authoritative(): string {
    const tables = [
      "SELECT id, run_id, definition, base, props, status, created_at, updated_at FROM workflow_run ORDER BY id",
      "SELECT root_id, format_version, manifest FROM workspace_roots ORDER BY root_id",
      "SELECT singleton_id, current_root_id FROM workspace_state ORDER BY singleton_id",
      "SELECT sequence, event_id, record, workspace_root_id FROM journal_events ORDER BY sequence",
      "SELECT root_id, lower(hex(manifest_hash)) AS h FROM workspace_root_manifest_refs ORDER BY root_id, h",
      "SELECT root_id, lower(hex(blob_hash)) AS h FROM workspace_root_blob_refs ORDER BY root_id, h",
      "SELECT lower(hex(hash)) AS h, lower(hex(bytes)) AS b FROM vfs_blob_bytes ORDER BY h",
      "SELECT lower(hex(hash)) AS h, size, lower(hex(encoded)) AS e FROM vfs_manifests ORDER BY h",
    ];
    return sha256Hex(
      JSON.stringify(tables.map((query) => this.ctx.storage.sql.exec(query).toArray())),
    );
  }

  /**
   * Fail inside the owner transaction, after every category has been written.
   *
   * Injected rather than simulated: the claim is that the runtime's own
   * transaction rolls content, roots, references, mappings, the pointer, the
   * journal and the retry decision back together, and only a real failure
   * inside a real `transactionSync()` can show that.
   */
  failAfterApply(raw: string): string {
    try {
      return String(
        this.transactions.run(this.ctx.storage, () => {
          const socket = this.ctx.getWebSockets("executor")[0];
          if (socket === undefined) {
            throw new Error("no live acquisition");
          }
          const answer = this.onRunnerMessage(socket, RUN_ID, raw);
          throw new Error(`forced failure after ${JSON.stringify(answer)}`);
        }),
      );
    } catch (error) {
      return error instanceof Error && error.message.startsWith("forced failure")
        ? "rolled-back"
        : `threw:${String(error)}`;
    }
  }

  /** Everything a reader could observe about the published frontier. */
  published(): Record<string, unknown> {
    const state = this.ctx.storage.sql
      .exec("SELECT current_root_id FROM workspace_state WHERE singleton_id = 1")
      .toArray()[0];
    const roots = this.ctx.storage.sql
      .exec("SELECT count(*) AS found FROM workspace_roots")
      .toArray()[0];
    const events = this.ctx.storage.sql
      .exec("SELECT event_id, workspace_root_id FROM journal_events ORDER BY sequence")
      .toArray();
    const repositories = this.ctx.storage.sql
      .exec("SELECT name, checkout_path FROM workspace_repositories ORDER BY name")
      .toArray();
    const blobs = this.ctx.storage.sql
      .exec("SELECT count(*) AS found FROM vfs_blob_bytes")
      .toArray()[0];
    const refs = this.ctx.storage.sql
      .exec("SELECT count(*) AS found FROM workspace_root_blob_refs")
      .toArray()[0];
    return {
      currentRootId: state?.["current_root_id"] ?? null,
      roots: Number(roots?.["found"] ?? -1),
      events,
      repositories,
      blobs: Number(blobs?.["found"] ?? -1),
      blobRefs: Number(refs?.["found"] ?? -1),
    };
  }

  /** The exact locator a retained Repository row holds. */
  repositoryLocator(name: string): string {
    const row = this.ctx.storage.sql
      .exec("SELECT locator FROM workspace_repositories WHERE name = ?", name)
      .toArray()[0];
    return row === undefined ? "" : String(row["locator"]);
  }

  /** A blob's metadata with no bytes beside it: a half-written identity. */
  removeBlobBytesOnly(digest: string, size: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, 0) ON CONFLICT(hash) DO NOTHING",
      hexBytes(digest),
      size,
    );
  }

  /** Begin one document execution, as a lifecycle transition would. */
  beginExecution(executionId: string, startedAt: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO document_executions (execution_id, started_at) VALUES (?, ?)",
      executionId,
      startedAt,
    );
  }

  /** Stop one document execution, as the matching transition would. */
  stopExecution(executionId: string, stoppedAt: string, status: string, code?: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE document_executions SET stopped_at = ?, stop_status = ?, stop_reason_kind = ?, stop_reason_code = ? WHERE execution_id = ?",
      stoppedAt,
      status,
      code === undefined ? null : "host",
      code ?? null,
      executionId,
    );
  }

  /** What the retrieval row holds right now. */
  retrieval(): Record<string, unknown> | null {
    const row = this.ctx.storage.sql
      .exec("SELECT metadata, revision, updated_at FROM definition_retrieval WHERE id = 1")
      .toArray()[0];
    return row === undefined ? null : row;
  }

  /** Retain more Repository rows than one admitted snapshot may carry. */
  fillRepositories(from: number, count: number): void {
    for (let index = from; index < from + count; index += 1) {
      const name = `repo-${String(index).padStart(4, "0")}`;
      this.ctx.storage.sql.exec(
        `INSERT INTO workspace_repositories (name, locator, locator_fingerprint, requested_base,
           creation_commit, primary_branch, object_format, checkout_path)
         VALUES (?, ?, ?, NULL, ?, 'main', 'sha1', ?)`,
        name,
        `https://git.example.invalid/${name}.git`,
        "a".repeat(64),
        "9".repeat(40),
        `/${name}`,
      );
    }
  }

  damageRetainedBlob(): void {
    this.ctx.storage.sql.exec(
      "UPDATE vfs_blob_bytes SET bytes = ?",
      new TextEncoder().encode("bad"),
    );
  }

  /**
   * Collect the DOFS manifest a retained file entry still names.
   *
   * The reference row goes first because the schema will not let it go second:
   * `ON DELETE RESTRICT` is what stops content vanishing from under a root that
   * references it. What this reproduces is the state that restriction cannot
   * prevent — a root whose manifest still names content the store no longer
   * keeps, with the reference collected alongside it.
   */
  removeManifestRow(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM workspace_root_manifest_refs WHERE lower(hex(manifest_hash)) = ?",
      MANIFEST_ID,
    );
    this.ctx.storage.sql.exec("DELETE FROM vfs_manifests WHERE lower(hex(hash)) = ?", MANIFEST_ID);
  }

  /** Keep the manifest row, change the bytes it is identified by. */
  damageManifestPayload(): void {
    this.ctx.storage.sql.exec(
      "UPDATE vfs_manifests SET encoded = ? WHERE lower(hex(hash)) = ?",
      new TextEncoder().encode('{"version":1,"chunks":[]}'),
      MANIFEST_ID,
    );
  }

  /** Keep identity and payload, disagree about how many bytes they describe. */
  damageManifestSize(): void {
    this.ctx.storage.sql.exec(
      "UPDATE vfs_manifests SET size = size + 1 WHERE lower(hex(hash)) = ?",
      MANIFEST_ID,
    );
  }

  /** Collect the blob a referenced manifest chunk still names, reference first. */
  removeBlobRow(): void {
    this.removeBlobReference();
    this.ctx.storage.sql.exec("DELETE FROM vfs_blob_bytes WHERE lower(hex(hash)) = ?", BLOB_ID);
    this.ctx.storage.sql.exec("DELETE FROM vfs_blobs WHERE lower(hex(hash)) = ?", BLOB_ID);
  }

  /** Keep the blob and its bytes, disagree about its recorded size. */
  damageBlobSize(): void {
    this.ctx.storage.sql.exec(
      "UPDATE vfs_blobs SET size = size + 1 WHERE lower(hex(hash)) = ?",
      BLOB_ID,
    );
  }

  /** Drop the root's reference to a blob its manifests still name. */
  removeBlobReference(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM workspace_root_blob_refs WHERE root_id = ? AND lower(hex(blob_hash)) = ?",
      ROOT_ID,
      BLOB_ID,
    );
  }

  /** Reference content from the root that none of its manifests names. */
  addExtraBlobReference(bytes: Uint8Array): string {
    const digest = this.addUnreferencedBlob(bytes);
    this.ctx.storage.sql.exec(
      "INSERT INTO workspace_root_blob_refs (root_id, blob_hash) VALUES (?, ?)",
      ROOT_ID,
      hexBytes(digest),
    );
    return digest;
  }

  makeForeign(): void {
    this.ctx.storage.sql.exec("CREATE TABLE foreign_state (id INTEGER PRIMARY KEY)");
  }

  rewriteMarker(applicationId: number, schemaVersion: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE ${MARKER_TABLE} SET application_id = ?, schema_version = ? WHERE id = 1`,
      applicationId,
      schemaVersion,
    );
  }

  dropTable(name: string): void {
    this.ctx.storage.sql.exec(`DROP TABLE ${name}`);
  }

  rewriteRunId(runId: string): void {
    this.ctx.storage.sql.exec("UPDATE workflow_run SET run_id = ? WHERE id = 1", runId);
  }

  removeWorkspaceState(): void {
    this.ctx.storage.sql.exec("DELETE FROM workspace_state");
  }

  addUnreferencedBlob(bytes: Uint8Array): string {
    const digest = sha256Hex(bytes);
    const hash = hexBytes(digest);
    this.ctx.storage.sql.exec(
      "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, 0)",
      hash,
      bytes.length,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)",
      hash,
      new Uint8Array(bytes),
    );
    return digest;
  }

  /**
   * Admit one connection, answering what happened rather than raising.
   *
   * The server half of the pair is what the object admitted. Verification is
   * asynchronous, so this drives the admission operation through one Effection
   * scope — the runtime callback boundary this host adapts at.
   */
  async admitConnection(request: Partial<AdmissionRequest>): Promise<string> {
    const pair = new WebSocketPair();
    const server = pair[1];
    const presented: AdmissionRequest = {
      runId: "runId" in request ? request.runId : RUN_ID,
      release: "release" in request ? request.release : POLICY.release,
      token: "token" in request ? request.token : undefined,
    };
    try {
      await run(() => this.admit(presented, server));
      return "admitted";
    } catch (error) {
      return refusalOf(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    try {
      await run(() =>
        this.admit(
          {
            runId: request.headers.get("x-run-id"),
            release: request.headers.get("x-release"),
            token: request.headers.get("authorization")?.replace(/^Bearer /, ""),
          },
          server,
        ),
      );
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      return new Response(refusalOf(error), { status: 403 });
    }
  }

  /** The correlation the live acquisition is partitioned by. */
  acquisitionId(): string {
    const held = acquisitionHolders(this.ctx)[0];
    return held === undefined ? "" : held.held.acquisitionId;
  }

  /** How many live connections currently hold this run's executor. */
  holders(): number {
    return acquisitionHolders(this.ctx).length;
  }

  /** Send one message as the connection admitted at `index` (1-based). */
  send(index: number, raw: string): unknown {
    const socket = this.ctx.getWebSockets("executor")[index - 1];
    if (socket === undefined) {
      return { id: "", outcome: "refused", refusal: "no-such-connection" };
    }
    return this.onRunnerMessage(socket, RUN_ID, raw);
  }

  /** Send as a socket this object never admitted. */
  sendAsStranger(raw: string): unknown {
    const pair = new WebSocketPair();
    return this.onRunnerMessage(pair[1], RUN_ID, raw);
  }

  sendWithCopiedAttachment(raw: string): unknown {
    const live = this.ctx.getWebSockets("executor")[0];
    if (live === undefined) {
      return { id: "", outcome: "refused", refusal: "no-such-connection" };
    }
    const pair = new WebSocketPair();
    pair[1].serializeAttachment(live.deserializeAttachment());
    return this.onRunnerMessage(pair[1], RUN_ID, raw);
  }

  /** Close the connection admitted at `index`, releasing its acquisition. */
  closeConnection(index: number): void {
    const socket = this.ctx.getWebSockets("executor")[index - 1];
    if (socket !== undefined) {
      socket.close(1000, "done");
      this.webSocketClose(socket);
    }
  }
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
