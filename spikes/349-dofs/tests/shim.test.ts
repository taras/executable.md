import { type Operation, run } from "effection";
import { exec } from "@effectionx/process";

const proofBinary = new URL("../dist/proof", import.meta.url).pathname;
const shimBinary = new URL("../dist/proof-shim", import.meta.url).pathname;

interface Outcome {
  code: number | undefined;
  payload: Record<string, unknown>;
  stderr: string;
}

function* invoke(binary: string, args: string[]): Operation<Outcome> {
  const result = yield* exec(binary, { arguments: args }).join();
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

// The mount path is part of the workspace namespace, so each scenario pins
// one absolute mount directory and reuses it for the database's lifetime.
Deno.test("a native subprocess reads and mutates the workspace through the userspace shim", () =>
  run(function* () {
    const root = Deno.makeTempDirSync({ prefix: "spike349-shim-" });
    const db = `${root}/ws.db`;
    const mount = `${root}/mount`;

    yield* invoke(proofBinary, [db, "mkdir", mount]);
    yield* invoke(proofBinary, [db, "write", `${mount}/api.txt`, "from-api"]);

    const execRun = yield* invoke(shimBinary, [
      db,
      mount,
      "exec",
      "cat api.txt > copy.txt && printf sub > sub.txt",
    ]);
    assertEquals(execRun.payload.code, 0, "subprocess exit code");

    const sub = yield* invoke(proofBinary, [db, "read", `${mount}/sub.txt`]);
    assertEquals(
      sub.payload.body,
      "sub",
      "a subprocess write lands in the SQLite workspace",
    );
    const copy = yield* invoke(proofBinary, [db, "read", `${mount}/copy.txt`]);
    assertEquals(
      copy.payload.body,
      "from-api",
      "the subprocess read an API-written file through the mount",
    );
  }));

Deno.test("the shim rematerializes the persisted frontier into an emptied mount directory", () =>
  run(function* () {
    const root = Deno.makeTempDirSync({ prefix: "spike349-shim-mat-" });
    const db = `${root}/ws.db`;
    const mount = `${root}/mount`;

    yield* invoke(proofBinary, [db, "mkdir", mount]);
    yield* invoke(proofBinary, [db, "write", `${mount}/keep.txt`, "durable"]);

    yield* invoke(shimBinary, [db, mount, "materialize"]);
    const first = Deno.readTextFileSync(`${mount}/keep.txt`);
    assertEquals(first, "durable", "boot materialization writes the file");

    Deno.removeSync(mount, { recursive: true });
    yield* invoke(shimBinary, [db, mount, "materialize"]);
    const again = Deno.readTextFileSync(`${mount}/keep.txt`);
    assertEquals(
      again,
      "durable",
      "an emptied mount directory is rebuilt from SQLite state",
    );
  }));
