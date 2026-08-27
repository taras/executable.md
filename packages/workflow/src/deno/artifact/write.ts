/**
 * Sealing one XMD artifact, and proving it before reporting one.
 *
 * The whole snapshot is parsed and detached before the destination is created,
 * so a malformed input produces no file at all rather than a partial one
 * somebody would have to identify later. What is then written is written in one
 * transaction: the marker, both versions, every content row, the canonical
 * manifest and the derived identity appear together or not at all.
 *
 * ## Nothing is reported until it has been read back
 *
 * The finished file is reopened through the ordinary reader — the same gates a
 * stranger's copy passes — and its identity and semantics are required to be
 * the ones that were sealed. A writer that reported success from its own
 * in-memory arithmetic would be attesting to a file it had never recognized.
 *
 * ## The destination is staging, not publication
 *
 * This story writes one new file at the path it is given and refuses an
 * existing one. Publishing that file atomically at a user's requested target,
 * and owning the directory it was staged in, belongs to the export command.
 *
 * ## Cleanup
 *
 * An incomplete file is removed inside the operation's own `scoped()`
 * ownership boundary, so a failure and a cancellation are cleaned up the same
 * way. Cleanup that fails is reported and never reports a successful artifact:
 * a file nobody could finish writing is not evidence, and claiming one was
 * published would leave an operator with a path they believe is good.
 */

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { exists, rm } from "@effectionx/fs";
import {
  createContext,
  ensure,
  Err,
  Ok,
  type Operation,
  type Result,
  scoped,
  until,
} from "effection";
import {
  WorkflowStorageError,
  XmdArtifactCleanupError,
  XmdArtifactDestinationError,
  XmdArtifactInventoryError,
  XmdArtifactWriteVerificationError,
} from "../../storage/errors.ts";
import { buildXmdArtifactManifest, sha256Hex } from "./manifest.ts";
import { readXmdArtifact } from "./read.ts";
import {
  decodeXmdArtifactAgentEvidence,
  decodeXmdArtifactInventory,
  encodeXmdArtifactInventory,
  partitionXmdArtifactEntries,
  verifyXmdArtifactAgentEvidence,
  verifyXmdArtifactSemantics,
} from "./records.ts";
import {
  initializeXmdArtifactSchema,
  translateArtifactSqliteError,
  XMD_ARTIFACT_EXTENSION,
  XMD_ARTIFACT_FORMAT_VERSION,
  XMD_ARTIFACT_CONTAINER_VERSION,
} from "./schema.ts";
import type { DetachedXmdArtifact, VerifiedXmdArtifact, XmdArtifactWriteResult } from "./types.ts";

const INSERT_CONTENT = `INSERT INTO xmd_artifact_content
  (kind, identity, encoding, length, sha256, content) VALUES (?, ?, ?, ?, ?, ?)`;
const INSERT_HEADER = `INSERT INTO xmd_artifact_header
  (id, artifact_version, container_version, manifest, identity) VALUES (1, ?, ?, ?, ?)`;

/** The sidecars SQLite would put beside a database, none of which may survive. */
const SIDECARS = ["-journal", "-wal", "-shm"];

/**
 * Physical properties a container may differ in without being a different
 * artifact.
 *
 * Adapter-private, and installed only by this package's own suites. It exists
 * because "the identity ignores physical layout" is a claim about two files
 * that genuinely differ, and the only way to assert it is to produce two.
 */
export interface XmdArtifactLayout {
  /** The SQLite page size to create the container with. */
  readonly pageSize?: number;
  /** Whether to rewrite the file's pages once its content is committed. */
  readonly vacuum?: boolean;
}

/** Adapter-private observation seam for the physical-layout proof. */
export const XmdArtifactContainerLayout = createContext<XmdArtifactLayout>(
  "executablemd.workflow.deno.artifact.layout",
  {},
);

/**
 * Seal one complete detached snapshot into a new `.xmd` file.
 *
 * The caller keeps its own arrays: everything is copied before it is validated,
 * so nothing it does afterwards changes what was sealed, and nothing in the
 * returned value shares a byte with what it handed over.
 */
export function* writeXmdArtifact(
  path: string,
  contents: DetachedXmdArtifact,
): Operation<Result<XmdArtifactWriteResult>> {
  try {
    return Ok(yield* seal(path, contents));
  } catch (error) {
    if (error instanceof WorkflowStorageError) {
      return Err(error);
    }
    throw error;
  }
}

function* seal(path: string, contents: DetachedXmdArtifact): Operation<XmdArtifactWriteResult> {
  return yield* scoped(function* (): Operation<XmdArtifactWriteResult> {
    yield* admitDestination(path);

    // Everything the file will hold, produced and then read straight back
    // through the reader's own parser. A snapshot this build could not decode
    // is refused here, where there is still nothing on disk to remove.
    const entries = encodeXmdArtifactInventory(contents);
    const { base, agent } = partitionXmdArtifactEntries(entries);
    const detached = decodeXmdArtifactInventory(base, path);
    yield* verifyXmdArtifactSemantics(detached, path);
    const evidence = decodeXmdArtifactAgentEvidence(agent, path);
    if (evidence !== undefined) {
      verifyXmdArtifactAgentEvidence(detached, evidence, path);
    }
    const built = buildXmdArtifactManifest(entries, (kind) => {
      throw new XmdArtifactInventoryError(
        path,
        `the snapshot offers more than one ${kind} record under one identity`,
      );
    });

    let published = false;
    yield* ensure(function* () {
      if (!published) {
        yield* discard(path);
      }
    });

    const layout = (yield* XmdArtifactContainerLayout.get()) ?? {};
    create(path, built.bytes, built.identity, built.ordered, layout);
    yield* requireNoSidecar(path);

    const opened = yield* readXmdArtifact(path);
    if (!opened.ok) {
      throw new XmdArtifactWriteVerificationError(path, opened.error.message);
    }
    if (opened.value.identity !== built.identity) {
      throw new XmdArtifactWriteVerificationError(
        path,
        "it reads back under a different artifact identity",
      );
    }

    const fileSha256 = sha256Hex(yield* until(readFile(path)));
    published = true;
    return Object.freeze({
      identity: built.identity,
      fileSha256,
      artifact: opened.value,
    });
  });
}

/**
 * Gate the destination before anything is produced for it.
 *
 * Refused rather than replaced: an existing file at this path is somebody's,
 * and overwriting it would destroy evidence in the act of writing some.
 */
function* admitDestination(path: string): Operation<void> {
  if (!path.endsWith(XMD_ARTIFACT_EXTENSION)) {
    throw new XmdArtifactDestinationError(
      path,
      `an artifact's name ends in ${XMD_ARTIFACT_EXTENSION}`,
    );
  }
  if (yield* exists(path)) {
    throw new XmdArtifactDestinationError(path, "something is already there");
  }
  for (const suffix of SIDECARS) {
    if (yield* exists(`${path}${suffix}`)) {
      throw new XmdArtifactDestinationError(
        path,
        `a ${suffix} file is already beside it, so an earlier attempt is unfinished`,
      );
    }
  }
}

/**
 * Create the container and fill it in one transaction.
 *
 * A rollback journal rather than WAL. WAL leaves two more files beside the
 * database and makes the finished artifact depend on them; a sealed artifact is
 * one file, and one file is what a reader is required to be able to open alone.
 */
function create(
  path: string,
  manifest: Uint8Array,
  identity: string,
  entries: readonly { kind: string; identity: unknown; encoding: string; content: Uint8Array }[],
  layout: XmdArtifactLayout,
): void {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
  } catch (error) {
    throw translateArtifactSqliteError(error, path);
  }
  try {
    if (layout.pageSize !== undefined) {
      database.exec(`PRAGMA page_size = ${layout.pageSize}`);
    }
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("BEGIN IMMEDIATE");
    try {
      initializeXmdArtifactSchema(database);
      const insert = database.prepare(INSERT_CONTENT);
      for (const entry of entries) {
        insert.run(
          entry.kind,
          JSON.stringify(entry.identity),
          entry.encoding,
          entry.content.byteLength,
          sha256Hex(entry.content),
          entry.content,
        );
      }
      database
        .prepare(INSERT_HEADER)
        .run(XMD_ARTIFACT_FORMAT_VERSION, XMD_ARTIFACT_CONTAINER_VERSION, manifest, identity);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (layout.vacuum === true) {
      // Outside the transaction, because VACUUM cannot run inside one. It
      // rewrites where the pages sit and changes nothing the manifest names.
      database.exec("VACUUM");
    }
  } catch (error) {
    throw translateArtifactSqliteError(error, path);
  } finally {
    // Synchronous, so it belongs here: the connection has to be gone before
    // anything else looks at the file it was holding.
    database.close();
  }
}

/**
 * Prove the finished file stands alone.
 *
 * A sidecar left behind means the container still depends on state a reader on
 * another machine would never receive, so it is a failed seal rather than a
 * cosmetic leftover.
 */
function* requireNoSidecar(path: string): Operation<void> {
  for (const suffix of SIDECARS) {
    if (yield* exists(`${path}${suffix}`)) {
      throw new XmdArtifactWriteVerificationError(
        path,
        `SQLite left a ${suffix} file beside it, so it is not one self-contained file`,
      );
    }
  }
}

/** Remove the incomplete file and anything SQLite left beside it. */
function* discard(path: string): Operation<void> {
  for (const each of [path, ...SIDECARS.map((suffix) => `${path}${suffix}`)]) {
    try {
      yield* rm(each, { force: true });
    } catch {
      // The host's own message repeats the path and names an errno; what an
      // operator needs is the path and the fact that something is still there.
      throw new XmdArtifactCleanupError(each, "the host refused to remove it");
    }
  }
}
