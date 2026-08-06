import { type Operation, run, sleep, until } from "effection";
import { exec, type Process } from "@effectionx/process";
import { when } from "@effectionx/converge";
import process from "node:process";

const proofBinary = new URL("../dist/proof", import.meta.url).pathname;

interface ProofOutcome {
  code: number | undefined;
  status: number | undefined;
  body: unknown;
  stderr: string;
}

function* proofDo(
  target: string,
  stateDir: string,
  flags: string[] = [],
): Operation<ProofOutcome> {
  const result = yield* exec(proofBinary, {
    arguments: ["do", target, "--state-dir", stateDir, ...flags],
  }).join();
  let status;
  let body;
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.code === 0) {
    const parsed = JSON.parse(lastLine);
    status = parsed.status;
    body = parsed.body;
  }
  return { code: result.code, status, body, stderr: result.stderr };
}

function assertEquals(actual: unknown, expected: unknown, detail: string) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${detail}: expected ${right}, got ${left}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

Deno.test("counter survives full restarts; state directory and identity isolate", () =>
  run(function* () {
    const dirA = Deno.makeTempDirSync({ prefix: "spike347-a-" });
    const dirB = Deno.makeTempDirSync({ prefix: "spike347-b-" });

    const first = yield* proofDo("/increment", dirA);
    assertEquals(first.body, { count: 1 }, "first increment in fresh state");
    const second = yield* proofDo("/increment", dirA);
    assertEquals(
      second.body,
      { count: 2 },
      "second increment after a complete stop and restart",
    );

    const otherDir = yield* proofDo("/increment", dirB);
    assertEquals(
      otherDir.body,
      { count: 1 },
      "a different state directory starts from zero",
    );

    const otherIdentity = yield* proofDo("/increment", dirA, [
      "--identity",
      "someone-else",
    ]);
    assertEquals(
      otherIdentity.body,
      { count: 1 },
      "a different identity in the same state directory is a different object",
    );

    const original = yield* proofDo("/count", dirA);
    assertEquals(
      original.body,
      { count: 2 },
      "the original identity still reads its own state",
    );
  }));

Deno.test("workspace filesystem frontier survives restarts including create/delete/create", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike347-fs-" });

    yield* proofDo("/fs/mkdir?path=/notes", dir);
    yield* proofDo("/fs/write?path=/notes/a.md&body=alpha", dir);
    const alpha = yield* proofDo("/fs/read?path=/notes/a.md", dir);
    assertEquals(alpha.body, { content: "alpha" }, "read after restart");

    yield* proofDo("/fs/write?path=/notes/b.md&body=beta", dir);
    yield* proofDo("/fs/rm?path=/notes/a.md", dir);
    const listing = yield* proofDo("/fs/ls?path=/notes", dir);
    assertEquals(
      listing.body,
      { entries: ["b.md"] },
      "deletion survives into the next process",
    );

    yield* proofDo("/fs/write?path=/f.txt&body=first", dir);
    yield* proofDo("/fs/rm?path=/f.txt", dir);
    yield* proofDo("/fs/write?path=/f.txt&body=second", dir);
    const recreated = yield* proofDo("/fs/read?path=/f.txt", dir);
    assertEquals(
      recreated.body,
      { content: "second" },
      "create/delete/create keeps the last content across restarts",
    );

    const gone = yield* proofDo("/fs/read?path=/notes/a.md", dir);
    assertEquals(gone.status, 500, "the deleted file stays deleted");
  }));

Deno.test("worker-shell and worker-javascript backends execute under the loader config", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike347-exec-" });

    const shell = yield* proofDo(
      "/exec?backend=worker-shell&source=echo+hello",
      dir,
      ["--backends"],
    );
    const shellResult = resultOf(shell.body);
    assertEquals(shellResult.status, "completed", "shell exec completes");
    assertEquals(shellResult.stdout, "hello\n", "shell stdout captured");

    yield* proofDo("/fs/mkdir?path=/workspace", dir);
    const moduleSource = encodeURIComponent(
      'import fs from "node:fs/promises";' +
        'export default async function run() {' +
        '  await fs.writeFile("/workspace/js.txt", "from-module");' +
        "  return 42;" +
        "}",
    );
    const module = yield* proofDo(
      `/exec?backend=worker-javascript&source=${moduleSource}`,
      dir,
      ["--backends"],
    );
    const moduleResult = resultOf(module.body);
    assertEquals(moduleResult.status, "completed", "module exec completes");
    assertEquals(moduleResult.value, 42, "module return value round-trips");

    const written = yield* proofDo("/fs/read?path=/workspace/js.txt", dir);
    assertEquals(
      written.body,
      { content: "from-module" },
      "a module write lands in the durable workspace",
    );
  }));

interface ExecResult {
  status: string;
  stdout: string;
  value?: unknown;
}

function resultOf(body: unknown): ExecResult {
  if (
    typeof body === "object" && body !== null && "result" in body &&
    typeof body.result === "object" && body.result !== null
  ) {
    const result = body.result;
    if ("status" in result && "stdout" in result) {
      return {
        status: String(result.status),
        stdout: String(result.stdout),
        value: "value" in result ? result.value : undefined,
      };
    }
  }
  throw new Error(`response has no exec result: ${JSON.stringify(body)}`);
}

interface Server {
  proofPid: number;
  workerdPid: number;
  port: number;
}

function* readServer(proc: Process): Operation<Server> {
  const decoder = new TextDecoder();
  let buffer = "";
  const subscription = yield* proc.stdout;
  let next = yield* subscription.next();
  while (!next.done) {
    buffer += decoder.decode(next.value, { stream: true });
    const line = buffer.split("\n").find((entry) => entry.includes('"ready"'));
    if (line !== undefined) {
      const ready = JSON.parse(line);
      return {
        proofPid: proc.pid,
        workerdPid: ready.workerdPid,
        port: ready.port,
      };
    }
    next = yield* subscription.next();
  }
  throw new Error(`proof exited before ready: ${buffer}`);
}

Deno.test("clean stop of the host tears the supervised workerd down", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike347-stop-" });
    const proc = yield* exec(proofBinary, {
      arguments: ["serve", "--state-dir", dir],
    });
    const server = yield* readServer(proc);

    const response = yield* until(
      fetch(`http://127.0.0.1:${server.port}/count`),
    );
    yield* until(response.text());
    assertEquals(response.status, 200, "served while supervised");
    assertEquals(alive(server.workerdPid), true, "workerd alive while serving");

    process.kill(server.proofPid, "SIGTERM");
    yield* proc.join();
    yield* when(function* () {
      if (alive(server.workerdPid)) {
        throw new Error(`workerd ${server.workerdPid} survived a clean stop`);
      }
    }, { timeout: 5000 });
  }));

Deno.test("SIGKILL of the host orphans workerd: supervision offers no kernel-backed tie", () =>
  run(function* () {
    const dir = Deno.makeTempDirSync({ prefix: "spike347-kill-" });
    const proc = yield* exec(proofBinary, {
      arguments: ["serve", "--state-dir", dir],
    });
    const server = yield* readServer(proc);

    process.kill(server.proofPid, "SIGKILL");
    yield* proc.join();
    yield* sleep(1500);
    assertEquals(
      alive(server.workerdPid),
      true,
      "workerd remains after SIGKILL of its supervisor (recorded limitation)",
    );
    process.kill(server.workerdPid, "SIGTERM");
    yield* when(function* () {
      if (alive(server.workerdPid)) {
        throw new Error("orphaned workerd did not exit after manual SIGTERM");
      }
    }, { timeout: 5000 });
  }));

Deno.test("the proof executable runs without Deno, Node, or Wrangler on PATH", () =>
  run(function* () {
    const home = Deno.makeTempDirSync({ prefix: "spike347-home-" });
    const dir = Deno.makeTempDirSync({ prefix: "spike347-bare-" });
    const result = yield* exec(proofBinary, {
      arguments: ["do", "/increment", "--state-dir", dir],
      env: { PATH: "/usr/bin:/bin", HOME: home },
    }).join();
    if (result.code !== 0) {
      throw new Error(
        `proof failed in a bare environment: ${result.stderr.slice(-500)}`,
      );
    }
    const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
    assertEquals(
      JSON.parse(lastLine).body,
      { count: 1 },
      "increment in a bare environment with a fresh materialization cache",
    );
    try {
      Deno.statSync(`${home}/.cache/xmd-spike-347`);
    } catch {
      throw new Error("materialization cache missing under the fresh HOME");
    }
  }));

Deno.test("startup failure surfaces workerd stderr and a nonzero exit", () =>
  run(function* () {
    const file = Deno.makeTempFileSync({ prefix: "spike347-notadir-" });
    const result = yield* exec(proofBinary, {
      arguments: ["do", "/count", "--state-dir", file],
    }).join();
    if (result.code === 0) {
      throw new Error("proof exited 0 with an unusable state directory");
    }
    if (result.stderr.length === 0) {
      throw new Error("failure produced no stderr diagnostics");
    }
  }));
