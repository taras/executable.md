import { main, until } from "effection";
// @ts-types="./types/dofs.d.ts"
import {
  Database,
  initializeSchema,
  SCHEMA_VERSION,
  WorkspaceFilesystem,
} from "@cloudflare/dofs";
// @ts-types="./types/dofs-rename.d.ts"
import { rename } from "@cloudflare/dofs/fs/rename";
import { FileSQLiteStorage } from "./file-storage.ts";

function usage(): never {
  console.error(
    [
      "usage: proof <db-path> <op> [args...]",
      "ops: init | mkdir <p> | write <p> <body> | read <p> | ls <p> | rm <p> [-r]",
      "     stat <p> | lstat <p> | rename <a> <b> | symlink <target> <link>",
      "     readlink <p> | meta",
    ].join("\n"),
  );
  Deno.exit(2);
}

main(function* () {
  const started = performance.now();
  const [dbPath, op, ...args] = Deno.args;
  if (dbPath === undefined || op === undefined) {
    usage();
  }

  const storage = new FileSQLiteStorage(dbPath);
  const db = new Database(storage);
  initializeSchema(db, Date.now);
  const fs = new WorkspaceFilesystem(db);

  let result: Record<string, unknown>;
  switch (op) {
    case "init":
      result = { schemaVersion: SCHEMA_VERSION };
      break;
    case "mkdir":
      yield* until(fs.mkdir(args[0], { recursive: true }));
      result = { ok: true };
      break;
    case "write":
      yield* until(fs.writeFile(args[0], args[1]));
      result = { ok: true };
      break;
    case "read":
      result = { body: yield* until(fs.readFile(args[0], "utf8")) };
      break;
    case "ls": {
      const entries = yield* until(fs.readdir(args[0]));
      result = { entries: entries.map((entry) => entry.name).sort() };
      break;
    }
    case "rm":
      yield* until(fs.rm(args[0], { recursive: args.includes("-r") }));
      result = { ok: true };
      break;
    case "stat":
      result = { stat: yield* until(fs.stat(args[0])) };
      break;
    case "lstat":
      result = { lstat: yield* until(fs.lstat(args[0])) };
      break;
    case "rename":
      rename(db, args[0], args[1]);
      result = { ok: true };
      break;
    case "symlink":
      yield* until(fs.symlink(args[0], args[1]));
      result = { ok: true };
      break;
    case "readlink":
      result = { target: yield* until(fs.readlink(args[0])) };
      break;
    case "meta":
      result = {
        binarySchemaVersion: SCHEMA_VERSION,
        vfsMeta: db.all("SELECT k, v FROM vfs_meta ORDER BY k"),
      };
      break;
    default:
      usage();
  }

  storage.close();
  const ms = Math.round((performance.now() - started) * 100) / 100;
  console.log(JSON.stringify({ op, ...result, ms }));
});
