/**
 * A Durable Object that exercises the owner's storage paths on real workerd.
 *
 * It is deliberately thin: each method does one thing the owner does — create
 * the schema, recognize it again, commit a mixed change, or fail partway
 * through one — so a test can assert the outcome rather than a model of it.
 */

import { DurableObject } from "cloudflare:workers";
import { mkdir as mkdirPath } from "../../../vendor/cloudflare-computer-dofs/generated/fs/mkdir.js";
import { writeFileSync } from "../../../vendor/cloudflare-computer-dofs/generated/fs/writeFile.js";
import {
  initializeObject,
  recognizeObject,
  WorkflowObjectStorageError,
} from "../../../src/cloudflare/recognition.ts";
import { MARKER_TABLE } from "../../../src/cloudflare/marker.ts";
import { ownerTransaction } from "../../../src/cloudflare/owner-transaction.ts";

/** One run row, so initialization writes what a real run would. */
const RUN_ID = "run-under-test";

export class OwnerObject extends DurableObject {
  /** Create the schema, DOFS schema, an empty root and the run row, then mark it. */
  initialize(): string {
    try {
      initializeObject(this.ctx.storage, () => {
        this.ctx.storage.sql.exec(
          "INSERT INTO workflow_run (run_id, definition, base, props, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          RUN_ID,
          JSON.stringify({ version: 1 }),
          "main",
          "{}",
          "running",
          0,
          0,
        );
      });
      return "initialized";
    } catch (error) {
      return describe(error);
    }
  }

  /** Read the storage back as a version-1 workflow run. */
  recognize(): string {
    try {
      recognizeObject(this.ctx.storage);
      return "recognized";
    } catch (error) {
      return describe(error);
    }
  }

  /** What the marker holds right now. */
  marker(): Record<string, unknown>[] {
    return this.ctx.storage.sql
      .exec(`SELECT application_id, schema_version FROM ${MARKER_TABLE}`)
      .toArray();
  }

  /** Drop one declared object, so recognition sees a shape that disagrees. */
  damage(table: string): void {
    this.ctx.storage.sql.exec(`DROP TABLE ${table}`);
  }

  /** Write an unrelated object, so pristine detection sees a foreign store. */
  addForeignObject(): void {
    this.ctx.storage.sql.exec("CREATE TABLE somebody_elses (id INTEGER PRIMARY KEY)");
  }

  /** Replace the marker's identity with another application's. */
  rewriteMarker(applicationId: number, schemaVersion: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE ${MARKER_TABLE} SET application_id = ?, schema_version = ? WHERE id = 1`,
      applicationId,
      schemaVersion,
    );
  }

  /**
   * Change DOFS content and a WorkflowRun row in one transaction.
   *
   * `fail` throws after both have been changed, which is the case that decides
   * whether the two categories really share a transaction.
   */
  commitMixedChange(fail: boolean): string {
    try {
      ownerTransaction(this.ctx.storage, ({ dofs }) => {
        mkdirPath(dofs, "/published", { recursive: true }, () => 0);
        // oxlint-disable-next-line local/no-sync-filesystem
        writeFileSync(
          dofs,
          "/published/root.txt",
          new TextEncoder().encode("frontier"),
          {},
          () => 0,
        );
        this.ctx.storage.sql.exec(
          "UPDATE workflow_run SET status = ?, updated_at = ? WHERE run_id = ?",
          "suspended",
          1,
          RUN_ID,
        );
        if (fail) {
          throw new Error("forced failure after both categories changed");
        }
      });
      return "committed";
    } catch (error) {
      return describe(error);
    }
  }

  /** What the run row and the DOFS filesystem hold, read outside any transaction. */
  frontier(): { status: string; publishedPaths: number } {
    const runRows = this.ctx.storage.sql
      .exec("SELECT status FROM workflow_run WHERE run_id = ?", RUN_ID)
      .toArray();
    const first = runRows[0];
    const paths = this.ctx.storage.sql
      .exec("SELECT count(*) AS found FROM vfs_dirents WHERE name = ?", "root.txt")
      .toArray();
    const found = paths[0];
    return {
      status: first === undefined ? "absent" : String(first["status"]),
      publishedPaths: found === undefined ? -1 : Number(found["found"]),
    };
  }
}

function describe(error: unknown): string {
  if (error instanceof WorkflowObjectStorageError) {
    return `refused:${error.failure.kind}`;
  }
  return `threw:${error instanceof Error ? error.message : String(error)}`;
}
