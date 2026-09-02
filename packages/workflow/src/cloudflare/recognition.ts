/**
 * Whether this Durable Object's storage is a version-1 workflow run, and how it
 * becomes one.
 *
 * The conditions are the ones the Deno host distinguishes, because they are
 * what a caller acts on differently: storage nobody has written yet may be
 * initialized; storage belonging to something else, or claiming a version this
 * build does not implement, must be left alone; and storage that claims version
 * 1 and is not shaped like it is damaged. Collapsing them would leave a host
 * guessing whether to create, refuse, or report damage.
 *
 * What differs from Deno is only where the claim is written. The pragmas that
 * carry it in a file are refused here, so `_xmd_workflow_schema` carries it
 * instead. Nothing initializes, migrates, repairs or replaces storage this
 * module refuses.
 */

import { initializeSchema as initializeDofsSchema } from "../../vendor/cloudflare-computer-dofs/generated/schema/index.js";
import {
  APPLICATION_ID,
  declaredStructureFailure,
  hasAnyDeclaredObject,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  type SchemaObject,
} from "../sqlite/workflow-schema.ts";
import { isSchemaMarker, MARKER_SQL, MARKER_TABLE, readMarker } from "./marker.ts";
import { ownerTransaction } from "./owner-transaction.ts";
import type { OwnerStorage } from "./storage.ts";

/** Why storage could not be read as a version-1 workflow run. */
export type RecognitionFailure =
  | { readonly kind: "foreign"; readonly detail: string }
  | { readonly kind: "unsupported-version"; readonly schemaVersion: number }
  | { readonly kind: "corrupt"; readonly detail: string };

export class WorkflowObjectStorageError extends Error {
  override name = "WorkflowObjectStorageError";

  constructor(readonly failure: RecognitionFailure) {
    super(describeFailure(failure));
  }
}

function describeFailure(failure: RecognitionFailure): string {
  if (failure.kind === "foreign") {
    return `this Durable Object's storage is not a workflow run: ${failure.detail}`;
  }
  if (failure.kind === "unsupported-version") {
    return `this Durable Object's storage declares schema version ${failure.schemaVersion}, which this build does not implement`;
  }
  return `this Durable Object's storage is damaged: ${failure.detail}`;
}

/** Every object the storage declares, drained where the cursor is created. */
export function declaredObjects(storage: OwnerStorage): SchemaObject[] {
  const rows = storage.sql
    .exec("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .toArray();
  return rows.map((row) => ({
    type: String(row["type"]),
    name: String(row["name"]),
    sql: row["sql"] === null || row["sql"] === undefined ? "" : String(row["sql"]),
  }));
}

/**
 * Whether this storage holds nothing at all.
 *
 * Pristine means no object anybody created — not XMD's, not DOFS's, not the
 * marker's, and nothing unrelated. Storage carrying any object but no marker is
 * foreign or half-initialized, and is refused rather than written into.
 */
export function isPristine(objects: readonly SchemaObject[]): boolean {
  return objects.length === 0;
}

function markerRows(storage: OwnerStorage): Record<string, unknown>[] {
  return storage.sql.exec(`SELECT application_id, schema_version FROM ${MARKER_TABLE}`).toArray();
}

/**
 * Make pristine storage into a version-1 workflow run, in one transaction.
 *
 * The marker is written last. Atomicity means no observer could see the
 * ordering, so this is the code saying what the marker means: an identity claim
 * over a schema that is already complete.
 */
export function initializeObject(storage: OwnerStorage, initializeRun: () => void): void {
  const objects = declaredObjects(storage);
  if (!isPristine(objects)) {
    throw new WorkflowObjectStorageError({
      kind: "foreign",
      detail: "it already holds objects and carries no workflow schema marker",
    });
  }
  ownerTransaction(storage, ({ dofs }) => {
    storage.sql.exec(SCHEMA_SQL);
    initializeDofsSchema(dofs, () => 0);
    initializeRun();
    storage.sql.exec(MARKER_SQL);
    storage.sql.exec(
      `INSERT INTO ${MARKER_TABLE} (id, application_id, schema_version) VALUES (1, ?, ?)`,
      APPLICATION_ID,
      SCHEMA_VERSION,
    );
  });
}

/**
 * Refuse anything that is not a version-1 workflow run.
 *
 * Structure only. Whether the rows describe the run that was asked for is a
 * separate question, asked after this one succeeds.
 */
export function recognizeObject(storage: OwnerStorage): void {
  const objects = declaredObjects(storage);
  if (isPristine(objects)) {
    throw new WorkflowObjectStorageError({
      kind: "foreign",
      detail: "it holds nothing at all",
    });
  }

  const carriesMarker = objects.some((object) => object.name === MARKER_TABLE);
  if (!carriesMarker) {
    throw new WorkflowObjectStorageError({
      kind: "foreign",
      detail: hasAnyDeclaredObject(objects)
        ? "it declares workflow tables without the schema marker that identifies them"
        : "it belongs to something else",
    });
  }

  const marker = readMarker(markerRows(storage));
  if (!isSchemaMarker(marker)) {
    if (marker.kind === "unknown-version") {
      throw new WorkflowObjectStorageError({
        kind: "unsupported-version",
        schemaVersion: marker.schemaVersion,
      });
    }
    if (marker.kind === "foreign-application") {
      throw new WorkflowObjectStorageError({
        kind: "foreign",
        detail: "its schema marker carries another application's identity",
      });
    }
    throw new WorkflowObjectStorageError({
      kind: "corrupt",
      detail:
        marker.kind === "absent"
          ? "its schema marker table holds no identity row"
          : marker.kind === "duplicated"
            ? "its schema marker table holds more than one identity row"
            : "its schema marker row does not describe an identity",
    });
  }

  const declared = objects.filter((object) => object.name !== MARKER_TABLE);
  const failure = declaredStructureFailure(declared);
  if (failure === undefined) {
    return;
  }
  if (failure.kind === "incomplete-pre-release") {
    throw new WorkflowObjectStorageError({
      kind: "corrupt",
      detail: "it holds an incomplete pre-release of version 1",
    });
  }
  if (failure.kind === "undeclared-object") {
    throw new WorkflowObjectStorageError({
      kind: "corrupt",
      detail: `it declares an object that version ${SCHEMA_VERSION} does not`,
    });
  }
  if (failure.kind === "misshapen-object") {
    throw new WorkflowObjectStorageError({
      kind: "corrupt",
      detail: `its ${failure.name} object is not shaped the way version ${SCHEMA_VERSION} declares it`,
    });
  }
  throw new WorkflowObjectStorageError({
    kind: "corrupt",
    detail: `it is missing the table ${failure.names.join(", ")}`,
  });
}
