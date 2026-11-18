import { ensureDir, readTextFile, stat, writeTextFile } from "@effectionx/fs";
import { ensure, run, scoped, sleep, spawn, until } from "effection";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { denoCommand, root } from "../lib/run.ts";

const decoder = new TextDecoder();
const testName =
  "failed journeys keep evidence and reap the REPL and scripted Sidekick";
const journey = "examples/repl-bench/journeys/timeout-controls.md";
const sampleIntervalMs = 200;
const expectedFailures = [
  "test timed out after 8 seconds",
  'Timed out waiting for "only-in-draft-1248" in sidekick-composer',
  'Timed out waiting for "false-history-drawer" in history',
];
const scriptedFailures = [
  'Scripted Sidekick prompt "Unexpected prompt.": prompt did not match the active stage.',
  'Timed out waiting for "fail-with-a-pending-acp-question" in viewport',
  'Scripted Sidekick prompt "Unexpected path prompt.": prompt did not match the active stage.',
  'Timed out waiting for "fail-with-a-pending-path-question" in viewport',
];

/** One completed `ps` run: its window in ms since the invocation began, and the worker rows it matched. */
interface Sample {
  ordinal: number;
  startedAt: string;
  startedMs: number;
  endedMs: number;
  code: number;
  rows: { pid: number; ppid: number; line: string }[];
}

function* assertReaped(
  log: string,
  reason: string,
  workers: Map<number, Set<number>>,
) {
  const directory = log.slice(log.indexOf(reason)).match(/^Evidence: (.+)$/m)
    ?.[1];
  assert.ok(directory, `Missing evidence for ${reason}`);
  const pid = Number((yield* readTextFile(join(directory, "pid"))).trim());
  assert.ok(
    Number.isSafeInteger(pid) && pid > 0,
    `Invalid REPL PID in ${directory}`,
  );
  assert.ok((yield* stat(join(directory, "screen.txt"))).size > 0);
  assert.ok((yield* stat(join(directory, "terminal.ansi"))).size > 0);
  const closed = JSON.parse(
    yield* readTextFile(join(directory, "closed.json")),
  );
  assert.equal(closed.pid, pid);
  assert.throws(
    () => process.kill(pid, 0),
    { code: "ESRCH" },
    `REPL ${pid} survived`,
  );
  const children = workers.get(pid);
  assert.ok(
    children?.size,
    `No scripted Sidekick worker observed for REPL ${pid}`,
  );
  for (const worker of children) {
    assert.throws(
      () => process.kill(worker, 0),
      { code: "ESRCH" },
      `Worker ${worker} survived`,
    );
  }
}

function* sourceDigest(path: string) {
  const bytes = yield* until(readFile(join(root, path)));
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function describeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

/** Each worker pair's first and last sighting; sampling only bounds when the process lived. */
function sightings(samples: Sample[]) {
  const pairs = new Map<
    string,
    { ppid: number; pid: number; first: Sample; last: Sample }
  >();
  for (const sample of samples) {
    for (const { pid, ppid } of sample.rows) {
      const seen = pairs.get(`${ppid}:${pid}`);
      if (seen === undefined) {
        pairs.set(`${ppid}:${pid}`, { ppid, pid, first: sample, last: sample });
      } else {
        seen.last = sample;
      }
    }
  }
  const window = ({ ordinal, startedAt, startedMs, endedMs }: Sample) => ({
    sample: ordinal,
    startedAt,
    startedMs,
    endedMs,
  });
  return [...pairs.values()].map(({ ppid, pid, first, last }) => ({
    ppid,
    pid,
    firstSeen: window(first),
    lastSeen: window(last),
  }));
}

function* saveFailureBundle(
  directory: string,
  manifest: Record<string, unknown>,
  samples: Sample[],
  output: Deno.CommandOutput | undefined,
) {
  const written: string[] = [];
  try {
    yield* ensureDir(directory);
    if (output !== undefined) {
      yield* until(writeFile(join(directory, "stdout.bin"), output.stdout));
      written.push("stdout.bin");
      yield* until(writeFile(join(directory, "stderr.bin"), output.stderr));
      written.push("stderr.bin");
    }
    const observations = {
      sampleIntervalMs,
      samples,
      sightings: sightings(samples),
    };
    yield* writeTextFile(
      join(directory, "observations.json"),
      JSON.stringify(observations, null, 2),
    );
    written.push("observations.json");
    yield* writeTextFile(
      join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    process.stderr.write(`Teardown failure diagnostics: ${directory}\n`);
  } catch (error) {
    process.stderr.write(
      `Teardown failure diagnostics were not saved to ${directory} ` +
        `(written: ${written.join(", ") || "none"}): ${
          describeError(error).stack ?? error
        }\n`,
    );
  }
}

function* verifyTeardown() {
  const origin = performance.now();
  const elapsed = () => Math.round((performance.now() - origin) * 1000) / 1000;
  const startedAt = new Date().toISOString();
  const id = randomUUID();
  const configured = Deno.env.get("XMD_TEST_ARTIFACTS");
  const artifacts = configured !== undefined && configured.length > 0
    ? resolve(Deno.cwd(), configured)
    : join(root, ".xmd", "test-artifacts");
  const bundle = join(
    artifacts,
    `teardown-${startedAt.replaceAll(":", "-")}-${id}`,
  );
  const [command, ...args] = denoCommand(["test", journey]);
  const samples: Sample[] = [];
  const workers = new Map<number, Set<number>>();
  let source: unknown = null;
  let journeySource: unknown = null;
  let child: Deno.ChildProcess | undefined;
  let output: Promise<Deno.CommandOutput> | undefined;
  let result: Deno.CommandOutput | undefined;
  let outputError: unknown;
  let status: Deno.CommandStatus | undefined;
  const cleanupErrors: unknown[] = [];
  let launchedMs: number | undefined;
  let exitObservedMs: number | undefined;
  let failure: { error: unknown } | undefined;
  let verified = false;
  yield* ensure(function* () {
    if (verified) {
      return;
    }
    const channel = (name: "stdout" | "stderr") =>
      result === undefined
        ? {
          unavailable: output === undefined
            ? "not launched"
            : describeError(outputError),
        }
        : { file: `${name}.bin`, bytes: result[name].byteLength };
    yield* saveFailureBundle(
      bundle,
      {
        version: 1,
        id,
        test: { name: testName, source },
        journey: journeySource,
        checkout: root,
        cwd: Deno.cwd(),
        outerPid: Deno.pid,
        command: [command, ...args],
        childPid: child?.pid ?? null,
        startedAt,
        clock: "ms since startedAt, monotonic",
        launchedMs: launchedMs ?? null,
        exitObservedMs: exitObservedMs ?? null,
        exit: status ?? null,
        cleanupErrors: cleanupErrors.map(describeError),
        outcome: failure === undefined ? "cancelled" : "failed",
        error: failure === undefined ? null : describeError(failure.error),
        stdout: channel("stdout"),
        stderr: channel("stderr"),
      },
      samples,
      result,
    );
  });
  try {
    source = yield* sourceDigest(
      relative(root, fileURLToPath(import.meta.url)),
    );
    journeySource = yield* sourceDigest(journey);
    assert.ok(command);
    yield* scoped(function* () {
      let settled = false;
      yield* ensure(function* () {
        settled = true;
        if (
          child === undefined || output === undefined || result !== undefined
        ) {
          return;
        }
        try {
          child.kill();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          result = yield* until(output);
        } catch (error) {
          outputError = error;
          cleanupErrors.push(error);
        }
        try {
          status = yield* until(child.status);
          exitObservedMs = elapsed();
        } catch (error) {
          cleanupErrors.push(error);
        }
      });
      child = new Deno.Command(command, {
        args,
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      launchedMs = elapsed();
      output = child.output();
      const workerCommand = `${
        join(root, "packages/cli/src/deno.ts")
      } test-agent --connect `;
      const poll = yield* spawn(function* () {
        let sampling: Promise<Deno.CommandOutput> | undefined;
        let sampleStartedAt = "";
        let startedMs = 0;
        function* collectSample() {
          const pending = sampling;
          if (pending === undefined) {
            return;
          }
          let snapshot: Deno.CommandOutput;
          try {
            snapshot = yield* until(pending);
          } catch (error) {
            sampling = undefined;
            throw error;
          }
          sampling = undefined;
          const sample: Sample = {
            ordinal: samples.length + 1,
            startedAt: sampleStartedAt,
            startedMs,
            endedMs: elapsed(),
            code: snapshot.code,
            rows: [],
          };
          samples.push(sample);
          assert.equal(snapshot.code, 0, decoder.decode(snapshot.stderr));
          for (const line of decoder.decode(snapshot.stdout).split("\n")) {
            const row = line.match(/^\s*(\d+)\s+(\d+)\s+\S*\bdeno run /);
            if (row === null || !line.includes(workerCommand)) {
              continue;
            }
            const parent = Number(row[2]);
            const pids = workers.get(parent) ?? new Set<number>();
            pids.add(Number(row[1]));
            workers.set(parent, pids);
            sample.rows.push({
              pid: Number(row[1]),
              ppid: parent,
              line: line.trim(),
            });
          }
        }
        yield* ensure(function* () {
          try {
            yield* collectSample();
          } catch (error) {
            cleanupErrors.push(error);
          }
        });
        const ps = new Deno.Command("ps", {
          args: ["-ww", "-axo", "pid=,ppid=,command="],
        });
        while (!settled) {
          sampleStartedAt = new Date().toISOString();
          startedMs = elapsed();
          sampling = ps.output();
          yield* collectSample();
          yield* sleep(sampleIntervalMs);
        }
      });
      result = yield* until(output);
      status = yield* until(child.status);
      exitObservedMs = elapsed();
      settled = true;
      yield* poll;
      const log = decoder.decode(result.stderr) + "\n" +
        decoder.decode(result.stdout);
      try {
        assert.equal(
          result.code,
          1,
          "The intentional failures must exit with status 1",
        );
        const failures = [...expectedFailures, ...scriptedFailures];
        assert.ok(
          log.includes(
            `tests failed: ${failures.length} of ${failures.length} tests failed`,
          ),
        );
        for (const reason of failures) {
          assert.ok(log.includes(reason), `Missing test failure: ${reason}`);
        }
        for (const reason of scriptedFailures) {
          yield* assertReaped(log, reason, workers);
        }
      } catch (error) {
        process.stderr.write(log);
        throw error;
      }
    });
  } catch (error) {
    failure = { error };
    throw error;
  }
  verified = true;
}

Deno.test(testName, () => run(verifyTeardown));
