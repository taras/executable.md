import { type Operation, run } from "effection";
import { exec } from "@effectionx/process";
import { DatabaseSync } from "node:sqlite";

const proofBinary = new URL("../dist/proof", import.meta.url).pathname;

interface ProofOutcome {
  code: number | undefined;
  payload: Record<string, unknown>;
  stderr: string;
}

function* proof(
  dbPath: string,
  op: string,
  ...args: string[]
): Operation<ProofOutcome> {
  const result = yield* exec(proofBinary, {
    arguments: [dbPath, op, ...args],
  }).join();
  let payload: Record<string, unknown> = {};
  if (result.code === 0) {
    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    const parsed: unknown = JSON.parse(lastLine);
    if (typeof parsed === "object" && parsed !== null) {
      payload = Object.fromEntries(Object.entries(parsed));
    }
  }
  return { code: result.code, payload, stderr: result.stderr };
}

function assertEquals(actual: unknown, expected: unknown, detail: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${detail}: expected ${right}, got ${left}`);
  }
}

Deno.test("filesystem frontier survives full process restarts, including create/delete/create", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike349-" });
    const db = `${dir}/ws.db`;

    yield* proof(db, "mkdir", "/notes");
    yield* proof(db, "write", "/notes/a.md", "alpha");
    const alpha = yield* proof(db, "read", "/notes/a.md");
    assertEquals(alpha.payload.body, "alpha", "read after restart");

    yield* proof(db, "write", "/notes/b.md", "beta");
    yield* proof(db, "rm", "/notes/a.md");
    const listing = yield* proof(db, "ls", "/notes");
    assertEquals(
      listing.payload.entries,
      ["b.md"],
      "deletion survives into the next process",
    );

    yield* proof(db, "write", "/f.txt", "v1");
    yield* proof(db, "rm", "/f.txt");
    yield* proof(db, "write", "/f.txt", "v2");
    const recreated = yield* proof(db, "read", "/f.txt");
    assertEquals(
      recreated.payload.body,
      "v2",
      "create/delete/create keeps the last content",
    );

    yield* proof(db, "rename", "/notes/b.md", "/notes/c.md");
    const renamed = yield* proof(db, "ls", "/notes");
    assertEquals(renamed.payload.entries, ["c.md"], "rename persists");

    yield* proof(db, "symlink", "/notes/c.md", "/link");
    const linkTarget = yield* proof(db, "readlink", "/link");
    assertEquals(linkTarget.payload.target, "/notes/c.md", "readlink");
    const throughLink = yield* proof(db, "read", "/link");
    assertEquals(
      throughLink.payload.body,
      "beta",
      "readFile follows symlinks across a restart",
    );

    const gone = yield* proof(db, "read", "/notes/a.md");
    if (gone.code === 0) {
      throw new Error("reading a deleted file succeeded");
    }
  }));

Deno.test("separate database paths are separate workspaces", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike349-iso-" });
    yield* proof(`${dir}/a.db`, "write", "/only-in-a.txt", "a");
    const other = yield* proof(`${dir}/b.db`, "ls", "/");
    assertEquals(other.payload.entries, [], "second database starts empty");
  }));

Deno.test("clean close leaves a single-file artifact (WAL checkpointed and removed)", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike349-wal-" });
    const db = `${dir}/ws.db`;
    yield* proof(db, "write", "/x.txt", "wal-check");
    const files = Array.from(Deno.readDirSync(dir)).map((entry) => entry.name)
      .sort();
    assertEquals(files, ["ws.db"], "no -wal/-shm files after close");
  }));

Deno.test("a newer on-disk schema version is refused loudly, not recreated", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike349-schema-" });
    const db = `${dir}/ws.db`;
    yield* proof(db, "write", "/keep.txt", "content");

    const raw = new DatabaseSync(db);
    raw.exec("UPDATE vfs_meta SET v = '99' WHERE k = 'schema_version'");
    raw.close();

    const refused = yield* proof(db, "read", "/keep.txt");
    if (refused.code === 0) {
      throw new Error("opening a future-schema database succeeded");
    }
    if (!refused.stderr.includes("schema version 99")) {
      throw new Error(
        `refusal does not name the schema version: ${refused.stderr.slice(-300)}`,
      );
    }
  }));
