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
  verifyXmdArtifactContainer,
  verifyXmdArtifactFormatVersion,
  XMD_ARTIFACT_EXTENSION,
} from "./schema.ts";
import {
  XMD_ARTIFACT_CONTENT_KINDS,
  type XmdArtifactContentEntry,
  type XmdArtifactEncoding,
  type VerifiedXmdArtifact,
} from "./types.ts";

const SELECT_HEADER_VERSION = "SELECT artifact_version FROM xmd_artifact_header WHERE id = 1";
const SELECT_HEADER =
  "SELECT id, artifact_version, container_version, manifest, identity FROM xmd_artifact_header";
const SELECT_CONTENT =
  "SELECT kind, identity, encoding, length, sha256, content FROM xmd_artifact_content";

const KINDS: ReadonlySet<string> = new Set(XMD_ARTIFACT_CONTENT_KINDS);
const ENCODINGS: ReadonlySet<string> = new Set(["canonical-json", "utf8", "bytes"]);

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
  // Gates 3 and 4a: integrity, the family marker, and the container schema
  // version — all of which a container answers before it has any tables.
  const container = verifyXmdArtifactContainer(database, path);

  // Gate 4b: the artifact format version, read through a targeted statement so
  // a later format that also changed the container is reported as a version
  // this build does not implement rather than as a schema that disagrees with
  // itself. A missing header is that second thing, and says so.
  verifyXmdArtifactFormatVersion(declaredFormatVersion(database, path), path);

  // Gate 5: the complete declared schema, the declared references, and the
  // singleton the header is.
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
  return deepFreeze({ ...contents, identity: rebuilt.identity });
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
    if (typeof encoding !== "string" || !ENCODINGS.has(encoding)) {
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
        encoding: encoding as XmdArtifactEncoding,
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
  const identity = offered as Json;
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
 * Freeze the whole returned graph.
 *
 * Typed arrays are left alone because `Object.freeze` refuses one that holds
 * elements. Their contents are a copy of what the connection read and no longer
 * back anything: writing into one changes this value and nothing on disk, and
 * the next read produces a fresh copy from the file's own bytes.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) {
    return value;
  }
  for (const member of Object.values(value as Record<string, unknown>)) {
    deepFreeze(member);
  }
  return Object.freeze(value);
}
