/**
 * A Durable Object that answers what its own SQLite storage can actually do.
 *
 * The version-1 schema is recognized through `PRAGMA application_id` and
 * `PRAGMA user_version`, and the vendored DOFS `Database` opens reentrant
 * transactions with `SAVEPOINT` through `sql.exec`. Cloudflare's own
 * documentation says `sql.exec()` cannot execute transaction statements and
 * says nothing about those two pragmas, so neither assumption can be settled
 * from prose — the owner either has the same recognition contract the Deno host
 * has, or it does not, and that decides how §4 is written rather than being a
 * detail inside it.
 *
 * So this object exists to be asked, on real workerd. It lives in test support
 * rather than in production source: it measures the runtime, and the answers it
 * gives are asserted by `storage-capabilities.vitest.ts` so a platform change
 * that moved any of them would fail rather than pass quietly.
 */

import { DurableObject } from "cloudflare:workers";
import { dofsStorage } from "../../../src/cloudflare/storage.ts";
import { Database as DofsDatabase } from "../../../vendor/cloudflare-computer-dofs/generated/storage.js";
import { initializeSchema as initializeDofsSchema } from "../../../vendor/cloudflare-computer-dofs/generated/schema/index.js";
import { mkdir as mkdirPath } from "../../../vendor/cloudflare-computer-dofs/generated/fs/mkdir.js";
import { writeFileSync } from "../../../vendor/cloudflare-computer-dofs/generated/fs/writeFile.js";

export interface StorageCapabilities {
  readonly applicationIdRead: string;
  readonly applicationIdWrite: string;
  readonly userVersionRead: string;
  readonly userVersionWrite: string;
  readonly schemaObjects: string;
  readonly outerTransaction: string;
  readonly nestedTransaction: string;
  readonly savepointDirect: string;
  readonly dofsSchema: string;
  readonly dofsFilesystem: string;
  readonly xmdTableDdl: string;
  readonly metadataTable: string;
  readonly filesystemInsideTransaction: string;
}

/** Run `body`, reporting what it answered or how it refused, never throwing. */
function attempt(body: () => unknown): string {
  try {
    const value = body();
    return `ok:${JSON.stringify(value ?? null)}`;
  } catch (error) {
    return `refused:${error instanceof Error ? error.message : String(error)}`;
  }
}

export class StorageProbeObject extends DurableObject {
  capabilities(): StorageCapabilities {
    const sql = this.ctx.storage.sql;
    const dofs = new DofsDatabase(dofsStorage(this.ctx.storage));
    return {
      applicationIdWrite: attempt(() => {
        sql.exec("PRAGMA application_id = 1701078349");
        return "written";
      }),
      applicationIdRead: attempt(() => sql.exec("PRAGMA application_id").toArray()),
      userVersionWrite: attempt(() => {
        sql.exec("PRAGMA user_version = 1");
        return "written";
      }),
      userVersionRead: attempt(() => sql.exec("PRAGMA user_version").toArray()),
      schemaObjects: attempt(() =>
        sql.exec("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").toArray(),
      ),
      outerTransaction: attempt(() => {
        dofs.transactionSync(() => {
          sql.exec("CREATE TABLE IF NOT EXISTS probe_outer (id INTEGER PRIMARY KEY)");
        });
        return "committed";
      }),
      // The one the documentation forbids: a reentrant transactionSync issues
      // SAVEPOINT through sql.exec while the outer transaction is open.
      nestedTransaction: attempt(() => {
        dofs.transactionSync(() => {
          dofs.transactionSync(() => {
            sql.exec("CREATE TABLE IF NOT EXISTS probe_nested (id INTEGER PRIMARY KEY)");
          });
        });
        return "committed";
      }),
      savepointDirect: attempt(() => {
        sql.exec("SAVEPOINT probe_sp");
        sql.exec("RELEASE probe_sp");
        return "accepted";
      }),
      // Does the vendored DOFS install its own schema against real storage,
      // and does doing so nest a transaction on the way?
      dofsSchema: attempt(() => {
        initializeDofsSchema(dofs, () => 0);
        return "initialized";
      }),
      // And does its filesystem work afterwards — the operation the owner would
      // perform for every Workspace mutation.
      dofsFilesystem: attempt(() => {
        mkdirPath(dofs, "/probe", { recursive: true }, () => 0);
        // The probe measures what this exact synchronous primitive does on real
        // storage, so the asynchronous alternative would answer a different
        // question than the one being asked.
        // oxlint-disable-next-line local/no-sync-filesystem
        writeFileSync(dofs, "/probe/one.txt", new TextEncoder().encode("hello"), {}, () => 0);
        return "written";
      }),
      // An ordinary XMD table, to show plain DDL is not what is refused.
      xmdTableDdl: attempt(() => {
        sql.exec("CREATE TABLE IF NOT EXISTS workflow_run (run_id TEXT PRIMARY KEY NOT NULL)");
        sql.exec("INSERT OR REPLACE INTO workflow_run (run_id) VALUES (?)", "probe");
        return sql.exec("SELECT run_id FROM workflow_run").toArray();
      }),
      // The exact shape §4 mandates for an owner commit: DOFS filesystem work
      // inside one `transactionSync`. If DOFS opens a transaction of its own on
      // that path it becomes a reentrant call, which the runtime refuses.
      filesystemInsideTransaction: attempt(() => {
        dofs.transactionSync(() => {
          mkdirPath(dofs, "/inside", { recursive: true }, () => 0);
          // oxlint-disable-next-line local/no-sync-filesystem
          writeFileSync(
            dofs,
            "/inside/two.txt",
            new TextEncoder().encode("committed"),
            {},
            () => 0,
          );
        });
        return "committed";
      }),
      // The shape a replacement for the pragmas would have to take.
      metadataTable: attempt(() => {
        sql.exec(
          "CREATE TABLE IF NOT EXISTS xmd_schema (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)",
        );
        sql.exec(
          "INSERT OR REPLACE INTO xmd_schema (key, value) VALUES ('application_id', ?)",
          1701078349,
        );
        return sql.exec("SELECT key, value FROM xmd_schema").toArray();
      }),
    };
  }
}
