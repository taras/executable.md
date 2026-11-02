import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliCommand } from "@executablemd/test-support/launch";
import { ensure, race, sleep, withResolvers } from "effection";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { useHeadlessFixture } from "./support/headless-repl.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { platformDataRoot } from "../src/repl-assembly.ts";
import { ReplEntryHost } from "../src/repl-entry-installation.ts";
import { SubmitRecord } from "../src/sidekick-acp/protocol.ts";

function within<T>(operation: Operation<T>, evidence: () => unknown): Operation<T> {
  return race([
    operation,
    (function* (): Operation<never> {
      yield* sleep(15000);
      throw new Error(`The SIGINT subprocess wait timed out: ${JSON.stringify(evidence())}`);
    })(),
  ]);
}
function* subprocess(sessionId: string, home: string, observeInput = false) {
  const args = ["repl", "submit", "--attach", sessionId, "-"];
  const prefix = cliCommand([]);
  const entry = prefix.arguments.at(-1);
  if (entry === undefined) {
    throw new Error("The CLI launch supplied no runtime entrypoint.");
  }
  const launch = observeInput
    ? {
        command: prefix.command,
        arguments: [
          ...prefix.arguments.slice(0, -1),
          fileURLToPath(new URL("./fixtures/submit-input-ready.ts", import.meta.url)),
          ...args,
        ],
      }
    : cliCommand(args);
  let child: ChildProcess | undefined;
  let closed = false;
  let stdout = "";
  let stderr = "";
  let buffered = "";
  const records: SubmitRecord[] = [];
  const inputOwned = withResolvers<void>();
  const admitted = withResolvers<void>();
  const settled = withResolvers<{ code: number | null; signal: string | null }>();
  const onStdout = (chunk: Uint8Array) => {
    const text = new TextDecoder().decode(chunk);
    stdout += text;
    buffered += text;
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.length > 0) {
        const record = SubmitRecord.parse(JSON.parse(line));
        records.push(record);
        if (record.kind === "admitted") {
          admitted.resolve();
        }
      }
    }
  };
  const onStderr = (chunk: Uint8Array) => {
    stderr += new TextDecoder().decode(chunk);
    if (stderr.includes("xmd-submit-input-owned")) {
      inputOwned.resolve();
    }
  };
  const onClose = (code: number | null, signal: string | null) => {
    closed = true;
    settled.resolve({ code, signal });
  };
  const onError = (error: Error) => {
    stderr += error.message;
  };
  yield* ensure(function* () {
    if (child !== undefined) {
      try {
        if (!closed && child.pid !== undefined) {
          process.kill(child.pid, "SIGTERM");
        }
        yield* settled.operation;
      } finally {
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
        child.off("close", onClose);
        child.off("error", onError);
        child.stdin?.off("error", onError);
      }
    }
  });
  child = spawnChild(launch.command, launch.arguments, {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      DENO_DIR: process.env.DENO_DIR ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      XMD_TEST_SUBMIT_ENTRY: entry,
    },
    stdio: "pipe",
  });
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.on("close", onClose);
  child.on("error", onError);
  child.stdin?.on("error", onError);
  return {
    child,
    records,
    inputOwned: inputOwned.operation,
    admitted: admitted.operation,
    joined: settled.operation,
    get closed() {
      return closed;
    },
    output: () => ({ stdout, stderr }),
    interrupt() {
      if (child?.pid === undefined) {
        throw new Error("No owned child PID.");
      }
      process.kill(child.pid, "SIGINT");
    },
  };
}

const HOLD = '---\nreturns: {type: object}\n---\n<Return value={{status: "hold"}} />';
const QUESTION =
  '<Elicit as="answer" schema={{type:"object",properties:{decision:{type:"string"}},required:["decision"],additionalProperties:false}}>Continue?</Elicit>';

describe("first SIGINT at the submit host boundary", () => {
  it("G: joins a blocked stdin read on the first SIGINT while its writer stays open", function* () {
    const home = yield* useTemporary("xmd-submit-process-home-");
    const fixture = yield* useHeadlessFixture(
      undefined,
      undefined,
      platformDataRoot(process.platform, home, {}, sep),
    );
    const root = fixture.children[0];
    if (root === undefined) {
      throw new Error("The disposable child is unavailable.");
    }
    const call = yield* subprocess(fixture.reference.sessionId, home, true);
    call.child.stdin?.write('<File path="must-never-run">partial');
    yield* within(call.inputOwned, () => ({ waiting: "input ownership", ...call.output() }));
    expect(call.child.stdin?.writableEnded).toBe(false);
    call.interrupt();
    expect(
      yield* within(call.joined, () => ({ waiting: "blocked input exit", ...call.output() })),
    ).toEqual({ code: 130, signal: null });
    expect(call.records).toEqual([
      {
        kind: "finished",
        submission: null,
        joined: true,
        outcome: "interrupted",
        result: null,
        error: null,
        journal: null,
      },
    ]);
    expect(root.session.model.entries).toHaveLength(0);
    expect(fixture.host.fake.prompts).toHaveLength(0);
    const next = yield* subprocess(fixture.reference.sessionId, home);
    next.child.stdin?.end(HOLD);
    expect(
      yield* within(next.joined, () => ({ waiting: "successor exit", ...next.output() })),
    ).toEqual({ code: 0, signal: null });
    expect(next.records.at(-1)).toMatchObject({ kind: "finished", outcome: "completed" });
  });

  it("G: retains the socket through exact Stop and held cleanup, then exits with status 130", function* () {
    const home = yield* useTemporary("xmd-submit-process-stop-home-");
    const cleanup = withResolvers<void>();
    const released = withResolvers<void>();
    yield* ensure(released.resolve);
    let armed = false;
    yield* ReplEntryHost.set(function* () {
      const hold = armed;
      return {
        *install() {
          if (hold) {
            yield* ensure(function* () {
              cleanup.resolve();
              yield* released.operation;
            });
          }
        },
      };
    });
    const fixture = yield* useHeadlessFixture(
      undefined,
      undefined,
      platformDataRoot(process.platform, home, {}, sep),
    );
    armed = true;
    const call = yield* subprocess(fixture.reference.sessionId, home);
    call.child.stdin?.end(QUESTION);
    yield* within(call.admitted, () => ({ waiting: "admission", ...call.output() }));
    call.interrupt();
    yield* within(cleanup.operation, () => ({ waiting: "entry cleanup", ...call.output() }));
    expect(call.closed).toBe(false);
    expect(call.records.some((record) => record.kind === "finished")).toBe(false);
    released.resolve();
    expect(
      yield* within(call.joined, () => ({ waiting: "joined Stop", ...call.output() })),
    ).toEqual({ code: 130, signal: null });
    const admitted = call.records[0];
    const final = call.records.at(-1);
    expect(final).toMatchObject({
      kind: "finished",
      outcome: "interrupted",
      joined: true,
      journal: "cancelled",
    });
    expect(final?.submission).toEqual(admitted?.submission);
    armed = false;
    const next = yield* subprocess(fixture.reference.sessionId, home);
    next.child.stdin?.end(HOLD);
    expect(
      yield* within(next.joined, () => ({ waiting: "successor exit", ...next.output() })),
    ).toEqual({ code: 0, signal: null });
    expect(next.records.at(-1)).toMatchObject({
      kind: "finished",
      outcome: "completed",
      result: { value: { status: "hold" } },
    });
    expect(fixture.host.fake.prompts).toHaveLength(0);
  });
});
