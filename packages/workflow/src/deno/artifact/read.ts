/**
 * Opening one XMD artifact, completely, before anybody sees any of it.
 *
 * Ten gates, in order, and no caller receives a lifecycle snapshot, a history
 * row, a Workspace byte or a definition member until the last of them has
 * passed. That totality is the contract: an artifact arrives from somewhere
 * else, and a reader that answered "what is the status" from the first row it
 * could parse would be reporting on evidence whose later half it had never
 * looked at.
 *
 * Nothing here writes. The connection is opened read-only, no pragma that
 * writes is executed, no journal mode is set, and no schema is migrated — so
 * every refusal leaves the file byte- and mode-identical and creates no
 * `-journal`, `-wal`, `-shm` or lock beside it. A host that cannot open the
 * file read-only refuses rather than opening it any other way.
 *
 * The stored manifest is evidence, never authority. The inventory is
 * enumerated from the content rows themselves, every record is parsed, the
 * manifest is then rebuilt from what was accepted, and only then is the stored
 * copy compared with it. A reader that trusted the stored manifest would be
 * asking a tampered file to describe its own tampering.
 */

import { Buffer } from "node:buffer";
import type { Stats } from "node:fs";
import { extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lstat } from "@effectionx/fs";
import { Err, Ok, type Operation, type Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { WorkflowDefinition } from "../../storage/definition.ts";
import { type JsonObject, parseJsonValue } from "../../storage/members.ts";
import type { DocumentExecutionRecord, WorkflowRunRecord } from "../../storage/record.ts";
import type { RetainedAnswer } from "../answers.ts";
import type { RetainedBlob, RetainedManifest } from "../fork-source.ts";
import type { AgentSessionRecord } from "../workspace/agent-sessions.ts";
import type { StoredWorkspaceRoot } from "../workspace/manifest.ts";
import {
  WorkflowStorageError,
  XmdArtifactContentError,
  XmdArtifactIdentityMismatchError,
  XmdArtifactInventoryError,
  XmdArtifactManifestMismatchError,
  XmdArtifactPathError,
  XmdArtifactSchemaError,
  XmdArtifactUnreadableError,
} from "../../storage/errors.ts";
import { reading, readTransaction } from "../reading.ts";
import { buildXmdArtifactManifest, canonicalJsonText, sha256Hex } from "./manifest.ts";
import { decodeXmdArtifactInventory, verifyXmdArtifactSemantics } from "./records.ts";
import {
  artifactOpenFailure,
  checkXmdArtifactForeignKeys,
  translateArtifactSqliteError,
  recognizeXmdArtifactContainer,
  verifyXmdArtifactFormatVersion,
  verifyXmdArtifactStructure,
  XMD_ARTIFACT_EXTENSION,
} from "./schema.ts";
import {
  XMD_ARTIFACT_CONTENT_KINDS,
  type VerifiedXmdArtifact,
  type XmdArtifactContentEntry,
  type XmdArtifactContents,
  type XmdArtifactDefinitionClosure,
  type XmdArtifactEncoding,
  type XmdArtifactJournalRow,
} from "./types.ts";

const SELECT_HEADER_VERSION = "SELECT artifact_version FROM xmd_artifact_header WHERE id = 1";
const SELECT_HEADER =
  "SELECT id, artifact_version, container_version, manifest, identity FROM xmd_artifact_header";
const SELECT_CONTENT =
  "SELECT kind, identity, encoding, length, sha256, content FROM xmd_artifact_content";

const KINDS: ReadonlySet<string> = new Set(XMD_ARTIFACT_CONTENT_KINDS);

/** Whether a stored column names one of the three ways bytes may be read. */
function isXmdArtifactEncoding(value: unknown): value is XmdArtifactEncoding {
  return value === "canonical-json" || value === "utf8" || value === "bytes";
}

/**
 * Read one XMD artifact, or say categorically why it is not one.
 *
 * `path` is the caller's, and is the only thing this ever consults: an artifact
 * has no location derived from its source run id, so copying or renaming the
 * file changes nothing about what it is. The path does not travel into the
 * returned value, only into the diagnostics — a snapshot carrying where it was
 * read from would be a fact about this machine embedded in portable evidence.
 */
export function* readXmdArtifact(path: string): Operation<Result<VerifiedXmdArtifact>> {
  try {
    yield* admitPath(path);
    return Ok(openArtifact(path));
  } catch (error) {
    if (error instanceof WorkflowStorageError) {
      return Err(error);
    }
    throw error;
  }
}

function openArtifact(path: string): VerifiedXmdArtifact {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw artifactOpenFailure(error, path);
  }

  try {
    // Neither pragma writes. No journal mode is set and no migration is run:
    // a reader that could change the file would not be reading evidence.
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    return readTransaction(database, () => verified(database, path));
  } catch (error) {
    throw translateArtifactSqliteError(error, path);
  } finally {
    database.close();
  }
}

/**
 * Gate 1: a regular file whose name says what it is.
 *
 * `lstat` rather than `stat`, so a symbolic link is refused as itself rather
 * than followed. A path somebody else can replace between the check and the
 * open is a path that names a different file each time it is read, and an
 * artifact is supposed to be the same evidence wherever it is opened from.
 */
function* admitPath(path: string): Operation<void> {
  if (extname(path) !== XMD_ARTIFACT_EXTENSION) {
    throw new XmdArtifactPathError(path, `its name does not end in ${XMD_ARTIFACT_EXTENSION}`);
  }
  let stats: Stats;
  try {
    stats = yield* lstat(path);
  } catch {
    // The host's own message names the errno and repeats the path; the
    // categorical answer is that nothing here could be opened.
    throw new XmdArtifactUnreadableError(path, "nothing at that path could be examined");
  }
  if (stats.isSymbolicLink()) {
    throw new XmdArtifactPathError(path, "it is a symbolic link rather than a regular file");
  }
  if (stats.isDirectory()) {
    throw new XmdArtifactPathError(path, "it is a directory rather than a regular file");
  }
  if (!stats.isFile()) {
    throw new XmdArtifactPathError(path, "it is not a regular file");
  }
}

function verified(database: DatabaseSync, path: string): VerifiedXmdArtifact {
  // Gate 3 and the first half of gate 4: integrity, the family marker, and the
  // container schema version — all of which a container answers before any
  // question about what its rows mean.
  const container = recognizeXmdArtifactContainer(database, path);

  // The second half of gate 4, and it comes before the structural comparison
  // rather than after it. A build that changed the artifact format may have
  // changed the tables carrying it, so a file that declares a format this one
  // does not implement is an unsupported version whatever its schema looks
  // like. Read through a targeted statement: a header that is missing or is
  // not shaped to answer this is a schema failure, and says so.
  verifyXmdArtifactFormatVersion(declaredFormatVersion(database, path), path);

  // Gate 5: the complete declared schema, the declared references, and the
  // singleton the header is.
  verifyXmdArtifactStructure(database, path);
  checkXmdArtifactForeignKeys(database, path);
  const header = readHeader(database, path, container.containerVersion);

  // Gate 6: everything into detached memory, so nothing a caller can observe
  // outlives the connection.
  const entries = readContent(database, path);

  // Gate 8: the records themselves, and every reference between them.
  const contents = decodeXmdArtifactInventory(entries, path);
  verifyXmdArtifactSemantics(contents, path);

  // Gate 9: the manifest this content produces, against the one stored beside
  // it, and the identity that manifest derives against the stored identity.
  const rebuilt = buildXmdArtifactManifest(entries, (kind) => {
    throw new XmdArtifactInventoryError(
      path,
      `it holds more than one ${kind} record under one identity`,
    );
  });
  if (Buffer.compare(Buffer.from(rebuilt.bytes), Buffer.from(header.manifest)) !== 0) {
    throw new XmdArtifactManifestMismatchError(path);
  }
  if (rebuilt.identity !== header.identity) {
    throw new XmdArtifactIdentityMismatchError(path);
  }

  // Gate 10: one immutable value, without the path it was read from.
  return immutableArtifact(contents, rebuilt.identity);
}

/** The artifact format version the header declares, whatever the schema is. */
function declaredFormatVersion(database: DatabaseSync, path: string): number {
  let row: Record<string, unknown> | undefined;
  try {
    row = reading(database, SELECT_HEADER_VERSION).get();
  } catch {
    throw new XmdArtifactSchemaError(path, "it declares no artifact header");
  }
  if (row === undefined) {
    throw new XmdArtifactSchemaError(path, "its artifact header holds no row");
  }
  return count(row["artifact_version"], path, "artifact format version");
}

interface ArtifactHeader {
  readonly manifest: Uint8Array;
  readonly identity: string;
}

function readHeader(
  database: DatabaseSync,
  path: string,
  containerVersion: number,
): ArtifactHeader {
  const rows = reading(database, SELECT_HEADER).all();
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new XmdArtifactSchemaError(path, "it does not hold exactly one artifact header");
  }
  if (count(row["id"], path, "artifact header identity") !== 1) {
    throw new XmdArtifactSchemaError(path, "its artifact header is not the singleton row");
  }
  if (count(row["container_version"], path, "container version") !== containerVersion) {
    throw new XmdArtifactSchemaError(
      path,
      "its stored container version and the one in its header disagree",
    );
  }
  const manifest = row["manifest"];
  const identity = row["identity"];
  if (!(manifest instanceof Uint8Array)) {
    throw new XmdArtifactSchemaError(path, "its stored artifact manifest is not bytes");
  }
  if (typeof identity !== "string" || !/^[0-9a-f]{64}$/.test(identity)) {
    throw new XmdArtifactSchemaError(
      path,
      "its stored artifact identity is not a lowercase SHA-256",
    );
  }
  return Object.freeze({ manifest, identity });
}

/**
 * Gate 7: every stored entry, held to what its own row declares.
 *
 * Kind, canonical identity, encoding, byte length and content hash, each
 * checked before the bytes are handed to a parser. An unknown kind is refused
 * rather than skipped: version 1's inventory is closed, so a record nobody
 * declared is an undeclared semantic record and therefore corruption.
 */
function readContent(database: DatabaseSync, path: string): XmdArtifactContentEntry[] {
  const entries: XmdArtifactContentEntry[] = [];
  for (const row of reading(database, SELECT_CONTENT).all()) {
    const kind = row["kind"];
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      throw new XmdArtifactInventoryError(
        path,
        "it holds a record of a kind this artifact version does not declare",
      );
    }
    const encoding = row["encoding"];
    if (!isXmdArtifactEncoding(encoding)) {
      throw new XmdArtifactContentError(path, kind, "encoding");
    }
    const content = row["content"];
    if (!(content instanceof Uint8Array)) {
      throw new XmdArtifactContentError(path, kind, "content, which is not bytes");
    }
    if (content.byteLength !== count(row["length"], path, "content length")) {
      throw new XmdArtifactContentError(path, kind, "byte length");
    }
    const declaredHash = row["sha256"];
    if (typeof declaredHash !== "string" || sha256Hex(content) !== declaredHash) {
      throw new XmdArtifactContentError(path, kind, "content hash");
    }
    entries.push(
      Object.freeze({
        kind,
        identity: identityOf(row["identity"], path, kind),
        encoding,
        content,
      }),
    );
  }
  return entries;
}

/**
 * The logical identity a stored row names.
 *
 * Held to canonical JSON, not merely to valid JSON: the manifest is rebuilt
 * from these identities, and two spellings of one identity would produce two
 * manifests for one artifact.
 */
function identityOf(value: unknown, path: string, kind: string): Json {
  if (typeof value !== "string") {
    throw new XmdArtifactInventoryError(path, `a ${kind} record carries no logical identity`);
  }
  let offered: unknown;
  try {
    offered = JSON.parse(value);
  } catch {
    throw new XmdArtifactInventoryError(path, `a ${kind} record's identity is not JSON`);
  }
  const identity = parseJsonValue(
    offered,
    "$",
    () => new XmdArtifactInventoryError(path, `a ${kind} record's identity is not a JSON value`),
  );
  if (canonicalJsonText(identity) !== value) {
    throw new XmdArtifactInventoryError(
      path,
      `a ${kind} record's identity is not canonically encoded`,
    );
  }
  return identity;
}

/** A stored integer, as a number JavaScript can hold. */
function count(value: unknown, path: string, label: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new XmdArtifactSchemaError(path, `its ${label} is not a whole number`);
  }
  return parsed;
}

/**
 * Gate 10, in full: one value whose every leaf refuses to be edited.
 *
 * Built member by member rather than by walking the decoded graph, because the
 * two halves of "immutable" need different mechanisms and a generic walk can
 * only apply one of them.
 *
 * Ordinary members are frozen. Byte-bearing members cannot be: `Object.freeze`
 * refuses a typed array that holds elements, and this runtime offers no
 * immutable `ArrayBuffer` to build one over — a write-refusing `Proxy` is not
 * an answer either, because one fails `ArrayBuffer.isView`, `Buffer.from` and
 * `TextDecoder.decode`, which would leave a caller holding bytes nothing can
 * hash, copy or read. So each byte leaf is a sealed original behind an accessor
 * that answers with a copy. Both routes a caller could take to edit the
 * evidence fail: replacing the member is refused by the frozen accessor, and
 * writing into what a read returned lands on a copy nobody else holds.
 *
 * The consequence is that a byte member is a fresh array on every read rather
 * than a stable reference. Nothing in this contract promised one, and buying
 * that back would mean handing out the sealed array itself.
 */
function immutableArtifact(contents: XmdArtifactContents, identity: string): VerifiedXmdArtifact {
  return Object.freeze({
    identity,
    frontier: Object.freeze({ ...contents.frontier }),
    run: frozenRun(contents.run),
    executions: Object.freeze(contents.executions.map(frozenExecution)),
    ...(contents.lineage === undefined ? {} : { lineage: Object.freeze({ ...contents.lineage }) }),
    journal: Object.freeze(contents.journal.map(frozenJournalRow)),
    roots: Object.freeze(contents.roots.map(frozenRoot)),
    manifests: Object.freeze(contents.manifests.map(frozenManifest)),
    blobs: Object.freeze(contents.blobs.map(frozenBlob)),
    repositories: Object.freeze(contents.repositories.map((each) => Object.freeze({ ...each }))),
    worktrees: Object.freeze(contents.worktrees.map((each) => Object.freeze({ ...each }))),
    answers: Object.freeze(contents.answers.map(frozenAnswer)),
    agentSessions: Object.freeze(contents.agentSessions.map(frozenAgentSession)),
    definition: frozenClosure(contents.definition),
  });
}

/**
 * A byte leaf nothing can edit, as the accessor that serves it.
 *
 * The sealed array is captured in the closure and never handed out; every read
 * is a copy of it, so a caller writing into what it received is writing into
 * something only that caller holds.
 */
function sealedBytes(bytes: Uint8Array): () => Uint8Array {
  const sealed = bytes.slice();
  return () => sealed.slice();
}

function frozenRun(run: WorkflowRunRecord): WorkflowRunRecord {
  return Object.freeze({
    runId: run.runId,
    definition: frozenDefinition(run.definition),
    base: run.base,
    props: frozenJsonObject(run.props),
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: Object.freeze({ ...run.stopReason }) }),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });
}

function frozenDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return Object.freeze({
    version: definition.version,
    kind: definition.kind,
    objectFormat: definition.objectFormat,
    objectId: definition.objectId,
    rootDocumentPath: definition.rootDocumentPath,
    ...(definition.targetPath === undefined ? {} : { targetPath: definition.targetPath }),
    ...(definition.components === undefined
      ? {}
      : {
          components: Object.freeze(
            definition.components.map((component) => Object.freeze({ ...component })),
          ),
        }),
  });
}

function frozenExecution(execution: DocumentExecutionRecord): DocumentExecutionRecord {
  return Object.freeze({
    ...execution,
    ...(execution.stopReason === undefined
      ? {}
      : { stopReason: Object.freeze({ ...execution.stopReason }) }),
  });
}

function frozenJournalRow(row: XmdArtifactJournalRow): XmdArtifactJournalRow {
  return Object.freeze({
    eventId: row.eventId,
    record: row.record,
    workspaceRootId: row.workspaceRootId,
    ...(row.inherited === undefined ? {} : { inherited: Object.freeze({ ...row.inherited }) }),
  });
}

function frozenRoot(root: StoredWorkspaceRoot): StoredWorkspaceRoot {
  return Object.freeze({
    rootId: root.rootId,
    manifest: root.manifest,
    manifestHashes: Object.freeze([...root.manifestHashes]),
    blobHashes: Object.freeze([...root.blobHashes]),
  });
}

function frozenManifest(manifest: RetainedManifest): RetainedManifest {
  const hash = sealedBytes(manifest.hash);
  const encoded = sealedBytes(manifest.encoded);
  return Object.freeze({
    get hash() {
      return hash();
    },
    size: manifest.size,
    get encoded() {
      return encoded();
    },
    lastSeen: manifest.lastSeen,
  });
}

function frozenBlob(blob: RetainedBlob): RetainedBlob {
  const hash = sealedBytes(blob.hash);
  const content = sealedBytes(blob.content);
  return Object.freeze({
    get hash() {
      return hash();
    },
    size: blob.size,
    lastSeen: blob.lastSeen,
    get content() {
      return content();
    },
  });
}

function frozenAnswer(answer: RetainedAnswer): RetainedAnswer {
  return Object.freeze({ ...answer, answer: frozenJson(answer.answer) });
}

function frozenAgentSession(session: AgentSessionRecord): AgentSessionRecord {
  return Object.freeze({ ...session, assertion: Object.freeze({ ...session.assertion }) });
}

function frozenClosure(closure: XmdArtifactDefinitionClosure): XmdArtifactDefinitionClosure {
  return Object.freeze({
    root: Object.freeze({ ...closure.root }),
    components: Object.freeze(closure.components.map((each) => Object.freeze({ ...each }))),
  });
}

/**
 * A JSON value whose every level is frozen.
 *
 * Members are defined rather than assigned: `object[key] = value` reaches
 * `Object.prototype`'s setter for `__proto__`, which one runtime honours and
 * another does not, so a retained value declaring that name would come back
 * differently depending on where it was read.
 */
function frozenJson(value: Json): Json {
  if (Array.isArray(value)) {
    const members: Json[] = value.map(frozenJson);
    Object.freeze(members);
    return members;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return frozenJsonObject(value);
}

function frozenJsonObject(value: JsonObject): JsonObject {
  const members: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    Object.defineProperty(members, key, { value: frozenJson(member), enumerable: true });
  }
  Object.freeze(members);
  return members;
}
