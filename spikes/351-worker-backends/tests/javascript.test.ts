import { type Operation, run } from "effection";
import { exec } from "@effectionx/process";

const proof = new URL("../dist/proof", import.meta.url).pathname;

interface Outcome {
  code: number | undefined;
  payload: Record<string, unknown>;
}

function* proofRun(
  db: string,
  command: string,
  ...args: string[]
): Operation<Outcome> {
  const result = yield* exec(proof, { arguments: [db, command, ...args] })
    .join();
  let payload: Record<string, unknown> = {};
  if (result.code === 0) {
    const parsed: unknown = JSON.parse(
      result.stdout.trim().split("\n").at(-1) ?? "{}",
    );
    if (typeof parsed === "object" && parsed !== null) {
      payload = Object.fromEntries(Object.entries(parsed));
    }
  }
  return { code: result.code, payload };
}

function assertEquals(actual: unknown, expected: unknown, detail: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${detail}: expected ${right}, got ${left}`);
  }
}

function workspace(prefix: string): string {
  const dir = Deno.makeTempDirSync({ prefix });
  return `${dir}/ws.db`;
}

const ENTRY = [
  'import { greet } from "./dep.js";',
  "export default async () => {",
  '  await workspace.writeFile("/workspace/js.txt", greet("dofs"));',
  '  console.log("stdout line");',
  '  console.error("stderr line");',
  '  return { read: await workspace.readFile("/workspace/js.txt") };',
  "};",
].join("\n");

const DEPENDENCY = "dep.js=export const greet = (name) => `hello ${name}`;";

Deno.test("a module graph runs in an isolate, reaches the workspace, and reports stdout, stderr, and a result", () =>
  run(function* () {
    const db = workspace("spike351-js-");
    yield* proofRun(db, "fs-mkdir", "/workspace");

    const outcome = yield* proofRun(db, "js", ENTRY, "--dep", DEPENDENCY);
    assertEquals(outcome.payload.outcome, "exit", "run completes");
    assertEquals(outcome.payload.exitCode, 0, "exit code");
    assertEquals(outcome.payload.stdout, "stdout line\n", "stdout");
    assertEquals(outcome.payload.stderr, "stderr line\n", "stderr");
    assertEquals(
      outcome.payload.result,
      { read: "hello dofs" },
      "the entry's dependency ran and the workspace round-tripped",
    );

    const committed = yield* proofRun(db, "fs-read", "/workspace/js.txt");
    assertEquals(
      committed.payload.body,
      "hello dofs",
      "the isolate's write is committed to the database, readable by a later process",
    );
  }));

Deno.test("a thrown error is reported as stderr and a nonzero exit, not a host failure", () =>
  run(function* () {
    const db = workspace("spike351-js-throw-");
    const outcome = yield* proofRun(
      db,
      "js",
      'export default () => { throw new Error("boom"); };',
    );
    assertEquals(outcome.code, 0, "the host process itself succeeds");
    assertEquals(outcome.payload.exitCode, 1, "user code exit code");
    if (!String(outcome.payload.stderr).includes("boom")) {
      throw new Error(
        `stderr does not carry the thrown message: ${outcome.payload.stderr}`,
      );
    }
  }));

// The isolate receives exactly one capability: the workspace bridge. Everything
// the host process itself could do stays unreachable. Note this holds for the
// compiled artifact, whose module graph is frozen; a `deno run` host does not
// restrict `jsr:`/`npm:` imports (see evidence/EVIDENCE.md).
Deno.test("user code cannot reach host files or the environment", () =>
  run(function* () {
    const db = workspace("spike351-js-isolation-");

    const file = yield* proofRun(
      db,
      "js",
      'export default async () => await Deno.readTextFile("/etc/passwd");',
    );
    assertEquals(file.payload.exitCode, 1, "host file read is refused");
    if (!String(file.payload.stderr).includes("NotCapable")) {
      throw new Error(`unexpected failure: ${file.payload.stderr}`);
    }

    const environment = yield* proofRun(
      db,
      "js",
      'export default () => Deno.env.get("HOME");',
    );
    assertEquals(environment.payload.exitCode, 1, "env read is refused");
    if (!String(environment.payload.stderr).includes("NotCapable")) {
      throw new Error(`unexpected failure: ${environment.payload.stderr}`);
    }
  }));

// An operation the host does not offer must fail where it is called. Nothing
// falls back to host execution — the isolate has no path to one.
Deno.test("an unsupported workspace operation is refused explicitly, at both refusal points", () =>
  run(function* () {
    const db = workspace("spike351-js-unsupported-");

    // Exposed by the runner, deliberately not installed by this host.
    const uninstalled = yield* proofRun(
      db,
      "js",
      'export default async () => await workspace.symlink("/a", "/b");',
    );
    assertEquals(uninstalled.payload.exitCode, 1, "uninstalled op fails");
    if (
      !String(uninstalled.payload.stderr).includes(
        "unsupported filesystem op: symlink",
      )
    ) {
      throw new Error(
        `refusal does not name the operation: ${uninstalled.payload.stderr}`,
      );
    }

    // Not part of the capability surface at all.
    const unbound = yield* proofRun(
      db,
      "js",
      'export default async () => await workspace.chmod("/workspace", 493);',
    );
    assertEquals(unbound.payload.exitCode, 1, "unbound op fails");
    if (!String(unbound.payload.stderr).includes("not a function")) {
      throw new Error(
        `unbound op did not fail at the call: ${unbound.payload.stderr}`,
      );
    }
  }));
