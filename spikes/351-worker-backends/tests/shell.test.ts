import { type Operation, run } from "effection";
import { exec } from "@effectionx/process";

const proof = new URL("../dist/proof", import.meta.url).pathname;

interface Outcome {
  code: number | undefined;
  payload: Record<string, unknown>;
}

// Every invocation is a separate process against the same database, so any
// state a later command observes has survived a full host restart.
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

Deno.test("a host filesystem write is visible to the shell, and a shell write is visible to the host", () =>
  run(function* () {
    const db = workspace("spike351-coherence-");
    yield* proofRun(db, "fs-mkdir", "/workspace");
    yield* proofRun(db, "fs-write", "/workspace/from-host.txt", "alpha");

    const read = yield* proofRun(db, "shell", "cat from-host.txt");
    assertEquals(
      read.payload.stdout,
      "alpha",
      "the shell reads a file the host wrote in an earlier process",
    );

    yield* proofRun(db, "shell", "echo from-shell > from-shell.txt");
    const back = yield* proofRun(db, "fs-read", "/workspace/from-shell.txt");
    assertEquals(
      back.payload.body,
      "from-shell\n",
      "the host reads a file the shell wrote in an earlier process",
    );
  }));

Deno.test("shell semantics: pipelines, redirection, exit status, environment, cwd", () =>
  run(function* () {
    const db = workspace("spike351-semantics-");
    yield* proofRun(db, "fs-mkdir", "/workspace");

    const pipeline = yield* proofRun(db, "shell", "echo hi | tr a-z A-Z");
    assertEquals(pipeline.payload.stdout, "HI\n", "pipeline");

    yield* proofRun(db, "shell", "echo one > f.txt; echo two >> f.txt");
    const appended = yield* proofRun(db, "shell", "cat f.txt");
    assertEquals(appended.payload.stdout, "one\ntwo\n", "redirection");

    const status = yield* proofRun(db, "shell", "false; echo $?");
    assertEquals(status.payload.stdout, "1\n", "exit status of a failed command");

    const failing = yield* proofRun(db, "shell", "exit 3");
    assertEquals(failing.payload.exitCode, 3, "explicit exit code");

    const environment = yield* proofRun(
      db,
      "shell",
      "echo $GREETING",
      "--env",
      "GREETING=hello",
    );
    assertEquals(environment.payload.stdout, "hello\n", "environment variable");

    const cwd = yield* proofRun(db, "shell", "pwd");
    assertEquals(cwd.payload.stdout, "/workspace\n", "default cwd");

    const missing = yield* proofRun(db, "shell", "definitely-not-a-command");
    if (missing.payload.exitCode === 0) {
      throw new Error("an unknown command reported success");
    }
    if (String(missing.payload.stderr).length === 0) {
      throw new Error("an unknown command produced no stderr");
    }
  }));

Deno.test("separate database paths are separate workspaces", () =>
  run(function* () {
    const first = workspace("spike351-identity-a-");
    const second = workspace("spike351-identity-b-");
    yield* proofRun(first, "fs-mkdir", "/workspace");
    yield* proofRun(first, "shell", "echo only-here > marker.txt");
    yield* proofRun(second, "fs-mkdir", "/workspace");

    const other = yield* proofRun(second, "shell", "ls");
    assertEquals(
      other.payload.stdout,
      "",
      "a second workspace does not see the first workspace's files",
    );
  }));

// just-bash is an interpreter, not a process launcher: there is no PATH lookup
// and no native executable can run. This is the boundary between what the shell
// backend offers and arbitrary native command execution.
Deno.test("the shell cannot launch a native executable", () =>
  run(function* () {
    const db = workspace("spike351-native-");
    yield* proofRun(db, "fs-mkdir", "/workspace");
    const attempt = yield* proofRun(db, "shell", "/bin/echo hello");
    if (attempt.payload.exitCode === 0) {
      throw new Error(
        "a native executable ran; the shell is not an interpreter-only boundary",
      );
    }
  }));

Deno.test("the shell cannot read a host file outside the workspace", () =>
  run(function* () {
    const db = workspace("spike351-hostfs-");
    yield* proofRun(db, "fs-mkdir", "/workspace");
    const attempt = yield* proofRun(db, "shell", "cat /etc/passwd");
    if (attempt.payload.exitCode === 0) {
      throw new Error("the shell read a host file outside the workspace");
    }
  }));
