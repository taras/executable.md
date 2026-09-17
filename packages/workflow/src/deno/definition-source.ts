/**
 * The exact bytes a version-2 run retains, written and read back whole.
 *
 * A source bundle's authoritative content lives in this database and nowhere
 * else. So writing it is one set of rows inside the creation transaction, and
 * reading it is a total re-derivation: every retained length, every source hash
 * and the bundle hash itself are recomputed from the BLOBs before anything is
 * handed back. A retained identity nobody can reproduce is not evidence of the
 * definition it claims.
 *
 * ## Missing and corrupt are different answers
 *
 * A manifest entry or a blob the store does not contain is absence: the run's
 * content is gone, and there is nothing here to repair. A path, a length, a
 * hash, a mapping or a bundle hash that disagrees is damage: what is retained
 * is there and no longer describes itself. Operators act on the two
 * differently, and neither is repaired by falling back to the original file,
 * the optional provenance, or the legacy Git reader.
 *
 * ## Hashing does not happen inside a transaction
 *
 * Recomputing a hash is an operation, and a lifecycle transaction body may not
 * suspend. So the rows are read synchronously inside the caller's transaction
 * and verified afterwards, still under the executor lock and still before any
 * lifecycle write.
 */

import type { DatabaseSync } from "node:sqlite";
import { Err, Ok, type Operation, type Result } from "effection";
import type {
  GitRetainedDefinitionSourcesV1,
  RetainedDefinitionSources,
  SourceBundleRetainedDefinitionSourcesV2,
  SourceBundleRetainedSourceV2,
} from "../lifecycle/source.ts";
import { definitionComponents, type GitWorkflowDefinitionV1 } from "../storage/definition.ts";
import {
  LegacyWorkflowSourceMismatchError,
  WorkflowDefinitionCorruptError,
  WorkflowDefinitionSourceMissingError,
  WorkflowRecordMalformedError,
} from "../storage/errors.ts";
import {
  type SourceBundleSnapshotEntryV2,
  sourceBundleHash,
  type SourceBundleWorkflowDefinitionV2,
  sourceContentHash,
} from "../storage/source-bundle.ts";
import { gitBlobIdentity } from "./artifact/source.ts";
import { reading } from "./reading.ts";

const INSERT_BLOB = `INSERT INTO workflow_definition_blob (source_hash, byte_length, content)
  VALUES (?, ?, ?)
  ON CONFLICT(source_hash) DO NOTHING`;
const INSERT_SOURCE = "INSERT INTO workflow_definition_source (path, source_hash) VALUES (?, ?)";
const SELECT_SOURCES = "SELECT path, source_hash FROM workflow_definition_source";
const SELECT_BLOBS = "SELECT source_hash, byte_length, content FROM workflow_definition_blob";

/**
 * Retain the descriptor's complete manifest and its de-duplicated content.
 *
 * Synchronous and inside the caller's transaction, on a snapshot whose paths,
 * lengths and hashes have already been checked against the descriptor. Two
 * logical paths holding identical bytes reference one blob, because content is
 * keyed by its own hash and a second copy would be a second answer to the same
 * question.
 */
export function writeDefinitionSources(
  database: DatabaseSync,
  definition: SourceBundleWorkflowDefinitionV2,
  snapshot: readonly SourceBundleSnapshotEntryV2[],
): void {
  const blob = database.prepare(INSERT_BLOB);
  const source = database.prepare(INSERT_SOURCE);
  for (let index = 0; index < definition.sources.length; index++) {
    const entry = definition.sources[index];
    const offered = snapshot[index];
    if (entry === undefined || offered === undefined) {
      throw new WorkflowDefinitionCorruptError("the snapshot is not the descriptor's manifest");
    }
    blob.run(entry.sourceHash, entry.byteLength, offered.bytes);
    source.run(entry.path, entry.sourceHash);
  }
}

/** One retained manifest row, as SQLite hands it back. */
interface ManifestRow {
  readonly path: string;
  readonly sourceHash: string;
}

/** One retained blob, as SQLite hands it back. */
interface BlobRow {
  readonly sourceHash: string;
  readonly byteLength: number;
  readonly content: Uint8Array;
}

/** Everything the source store holds, read inside the caller's transaction. */
export interface RetainedSourceRows {
  readonly manifest: readonly ManifestRow[];
  readonly blobs: readonly BlobRow[];
}

/** Read the whole source store, without deciding anything about it yet. */
export function readDefinitionSourceRows(database: DatabaseSync): RetainedSourceRows {
  return {
    manifest: reading(database, SELECT_SOURCES)
      .all()
      .map((row) => ({
        path: rowText(row, "workflow_definition_source.path"),
        sourceHash: rowText(row, "workflow_definition_source.source_hash", "source_hash"),
      })),
    blobs: reading(database, SELECT_BLOBS)
      .all()
      .map((row) => ({
        sourceHash: rowText(row, "workflow_definition_blob.source_hash", "source_hash"),
        byteLength: rowInteger(row, "workflow_definition_blob.byte_length", "byte_length"),
        content: rowBytes(row, "workflow_definition_blob.content", "content"),
      })),
  };
}

/**
 * The retained source this descriptor names, re-derived from what is stored.
 *
 * Every check the issue settles, in the order an operator can act on: the
 * manifest must be exactly the descriptor's entries, every referenced blob must
 * exist, both retained lengths must equal the content's own, recomputing each
 * blob's hash must produce its key, no blob may be unreferenced, and the bundle
 * hash must be what the retained manifest and mapping produce.
 *
 * Nothing partial is ever returned. A closure with one source missing is not a
 * smaller closure, it is a different definition.
 */
export function* verifyRetainedSources(
  definition: SourceBundleWorkflowDefinitionV2,
  rows: RetainedSourceRows,
): Operation<Result<SourceBundleRetainedDefinitionSourcesV2>> {
  const stored = new Map(rows.manifest.map((row) => [row.path, row.sourceHash]));
  if (stored.size !== rows.manifest.length) {
    return Err(new WorkflowDefinitionCorruptError("it retains one logical path more than once"));
  }
  if (rows.manifest.length > definition.sources.length) {
    return Err(new WorkflowDefinitionCorruptError("it retains a source the descriptor does not"));
  }

  const blobs = new Map(rows.blobs.map((row) => [row.sourceHash, row]));
  if (blobs.size !== rows.blobs.length) {
    return Err(new WorkflowDefinitionCorruptError("it retains one content hash more than once"));
  }

  const referenced = new Set<string>();
  const sources: SourceBundleRetainedSourceV2[] = [];
  for (const entry of definition.sources) {
    const retainedHash = stored.get(entry.path);
    if (retainedHash === undefined) {
      return Err(new WorkflowDefinitionSourceMissingError());
    }
    if (retainedHash !== entry.sourceHash) {
      return Err(
        new WorkflowDefinitionCorruptError(
          "a retained source names content the descriptor does not",
        ),
      );
    }
    const blob = blobs.get(retainedHash);
    if (blob === undefined) {
      return Err(new WorkflowDefinitionSourceMissingError());
    }
    referenced.add(retainedHash);

    if (blob.byteLength !== entry.byteLength || blob.content.byteLength !== entry.byteLength) {
      return Err(
        new WorkflowDefinitionCorruptError("a retained source is not the length it declares"),
      );
    }
    const recomputed = yield* sourceContentHash(blob.content);
    if (recomputed !== entry.sourceHash) {
      return Err(
        new WorkflowDefinitionCorruptError("a retained source is not the content it names"),
      );
    }
    sources.push(Object.freeze({ path: entry.path, bytes: Uint8Array.from(blob.content) }));
  }

  // Unreferenced content is corruption rather than tolerated garbage: a blob no
  // manifest row names is bytes this run retains and cannot account for.
  if (referenced.size !== blobs.size) {
    return Err(new WorkflowDefinitionCorruptError("it retains content no source references"));
  }

  const bundleHash = yield* sourceBundleHash(definition);
  if (bundleHash !== definition.bundleHash) {
    return Err(
      new WorkflowDefinitionCorruptError("its bundle hash is not the one its manifest produces"),
    );
  }

  return Ok(
    Object.freeze({
      definitionVersion: 2,
      definition,
      sources: Object.freeze(sources),
    }),
  );
}

/**
 * Hold a legacy reader's answer to the version-1 definition it was asked about.
 *
 * The adapter fetched it; this decides whether what came back is this run's.
 * Every term the descriptor pins is compared — the object format, the pinned
 * commit, the repository-relative path, the exact target, and the declared
 * component set with its paths and blob identities — because a reader that
 * returned another commit's bytes has not obtained this source, and none of
 * what it returned may execute.
 */
export function validateLegacySources(
  definition: GitWorkflowDefinitionV1,
  answered: RetainedDefinitionSources,
): Result<GitRetainedDefinitionSourcesV1> {
  if (answered.definitionVersion !== 1) {
    return Err(
      new LegacyWorkflowSourceMismatchError("it describes a source bundle, not a Git object"),
    );
  }
  const { root, components } = answered.closure;
  if (
    root.objectFormat !== definition.objectFormat ||
    root.pinnedCommit !== definition.objectId ||
    root.rootDocumentPath !== definition.rootDocumentPath ||
    root.targetPath !== definition.targetPath
  ) {
    return Err(new LegacyWorkflowSourceMismatchError("its root is not the object this run pins"));
  }
  // The declared identity is not taken on the reader's word: the blob id is
  // recomputed from the bytes that came back, so a closure carrying one
  // document's identity beside another's content is refused rather than
  // executed.
  if (gitBlobIdentity(root.content, root.objectFormat) !== root.blobId) {
    return Err(
      new LegacyWorkflowSourceMismatchError("its root content is not the object it declares"),
    );
  }

  const declared = definitionComponents(definition);
  if (components.length !== declared.length) {
    return Err(
      new LegacyWorkflowSourceMismatchError(
        "it carries a different component set than this run declares",
      ),
    );
  }
  for (let index = 0; index < declared.length; index++) {
    const expected = declared[index];
    const supplied = components[index];
    if (
      expected === undefined ||
      supplied === undefined ||
      supplied.name !== expected.name ||
      supplied.path !== expected.path ||
      supplied.blobId !== expected.sourceHash
    ) {
      return Err(
        new LegacyWorkflowSourceMismatchError(
          "a component it carries is not one this run declares",
        ),
      );
    }
    if (gitBlobIdentity(supplied.content, definition.objectFormat) !== supplied.blobId) {
      return Err(
        new LegacyWorkflowSourceMismatchError(
          "a component's content is not the object it declares",
        ),
      );
    }
  }

  return Ok(Object.freeze({ definitionVersion: 1, definition, closure: answered.closure }));
}

function rowText(row: Record<string, unknown>, location: string, column = "path"): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new WorkflowRecordMalformedError(location, "expected text");
  }
  return value;
}

function rowInteger(row: Record<string, unknown>, location: string, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WorkflowRecordMalformedError(location, "expected a whole number of bytes");
    }
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new WorkflowRecordMalformedError(location, "expected a whole number of bytes");
}

function rowBytes(row: Record<string, unknown>, location: string, column: string): Uint8Array {
  const value = row[column];
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new WorkflowRecordMalformedError(location, "expected bytes");
}
