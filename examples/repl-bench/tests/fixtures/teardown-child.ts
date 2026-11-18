/**
 * Stands in for the `deno` and `ps` executables the outer teardown test
 * launches, so its failure bundle can be checked against what a child really
 * wrote and which worker processes a real `ps` really observed.
 *
 * `child` replaces the nested `deno test`; `repl` holds one worker until a
 * forwarded `ps` sample has listed the pair; `worker` matches the scripted
 * Sidekick command line the outer test samples; `ps` forwards the real `ps`.
 */
import { ensureDir, exists, readdir, writeTextFile } from "@effectionx/fs";
import {
  all,
  ensure,
  exit,
  main,
  resource,
  run,
  suspend,
  until,
} from "effection";
import type { Operation } from "effection";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const Double = z.object({
  mode: z.enum([
    "missing-reason",
    "pass",
    "ps-failure",
    "output-rejection",
    "held-sample",
  ]),
  token: z.string(),
  directory: z.string(),
  launch: z.array(z.string()),
  entry: z.string(),
  path: z.string(),
});
type Double = z.infer<typeof Double>;

export const ChildRecord = z.object({
  childPid: z.number(),
  pairs: z.array(z.object({ ppid: z.number(), pid: z.number() })),
  evidence: z.array(z.string()),
});

export const omittedReason =
  'Timed out waiting for "only-in-draft-1248" in sidekick-composer';
const scriptedReasons = [
  'Scripted Sidekick prompt "Unexpected prompt.": prompt did not match the active stage.',
  'Timed out waiting for "fail-with-a-pending-acp-question" in viewport',
  'Scripted Sidekick prompt "Unexpected path prompt.": prompt did not match the active stage.',
  'Timed out waiting for "fail-with-a-pending-path-question" in viewport',
];
const reasons = [
  "test timed out after 8 seconds",
  omittedReason,
  'Timed out waiting for "false-history-drawer" in history',
];

const encoder = new TextEncoder();

/** Distinct bytes per channel and invocation, including non-ASCII text and invalid UTF-8. */
export function channelBytes(token: string, channel: string, part: string) {
  const text = encoder.encode(`${part} ${channel} ${token} ✓ `);
  return new Uint8Array([...text, 0xff, 0xfe, 0x00, 0x0a]);
}

function concat(chunks: Uint8Array[]) {
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

function* emit(
  stream: WritableStream<Uint8Array>,
  emitted: Uint8Array[],
  bytes: Uint8Array,
): Operation<void> {
  const writer = stream.getWriter();
  try {
    yield* until(writer.write(bytes));
  } finally {
    writer.releaseLock();
  }
  emitted.push(bytes);
}

function useProcess(
  args: string[],
  stdout: "piped" | "null",
): Operation<Deno.ChildProcess> {
  return resource(function* (provide) {
    let process: Deno.ChildProcess | undefined;
    yield* ensure(function* () {
      if (process === undefined) {
        return;
      }
      try {
        process.kill();
      } catch {
        // Deno refuses to signal a child whose status has already resolved.
      }
      yield* until(process.status);
    });
    process = new Deno.Command(Deno.execPath(), {
      args,
      stdout,
      stderr: "inherit",
    }).spawn();
    yield* provide(process);
  });
}

function* waitForSighting(gate: string, ppid: number, pid: number) {
  const listener = Deno.listen({
    transport: "unix",
    path: join(gate, `${ppid}-${pid}.sock`),
  });
  try {
    const connection = yield* until(listener.accept());
    connection.close();
  } finally {
    listener.close();
  }
}

function* repl(double: Double) {
  const worker = yield* useProcess(
    [
      ...double.launch,
      "worker",
      double.entry,
      "test-agent",
      "--connect",
      double.token,
    ],
    "null",
  );
  yield* waitForSighting(join(double.directory, "gate"), Deno.pid, worker.pid);
  worker.kill();
  yield* until(worker.status);
  yield* emit(
    Deno.stdout.writable,
    [],
    encoder.encode(JSON.stringify({ worker: worker.pid })),
  );
}

function* launchRepl(
  double: Double,
  record: z.infer<typeof ChildRecord>,
  reason?: string,
) {
  const process = yield* useProcess([...double.launch, "repl"], "piped");
  const output = yield* until(process.output());
  const { worker } = z
    .object({ worker: z.number() })
    .parse(JSON.parse(new TextDecoder().decode(output.stdout)));
  record.pairs.push({ ppid: process.pid, pid: worker });
  return { reason, pid: process.pid };
}

function* writeEvidence(double: Double, pid: number) {
  const directory = join(double.directory, "evidence", String(pid));
  yield* ensureDir(directory);
  yield* writeTextFile(join(directory, "pid"), `${pid}\n`);
  yield* writeTextFile(join(directory, "screen.txt"), "screen\n");
  yield* writeTextFile(join(directory, "terminal.ansi"), "\u001b[0mterminal\n");
  yield* writeTextFile(join(directory, "closed.json"), JSON.stringify({ pid }));
  return directory;
}

function* child(double: Double) {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const record: z.infer<typeof ChildRecord> = {
    childPid: Deno.pid,
    pairs: [],
    evidence: [],
  };
  yield* ensure(function* () {
    if (double.mode === "ps-failure") {
      yield* emit(
        Deno.stdout.writable,
        stdout,
        channelBytes(double.token, "stdout", "tail"),
      );
      yield* emit(
        Deno.stderr.writable,
        stderr,
        channelBytes(double.token, "stderr", "tail"),
      );
    }
    yield* until(
      writeFile(join(double.directory, "emitted-stdout.bin"), concat(stdout)),
    );
    yield* until(
      writeFile(join(double.directory, "emitted-stderr.bin"), concat(stderr)),
    );
    yield* writeTextFile(
      join(double.directory, "record.json"),
      JSON.stringify(record),
    );
  });
  yield* emit(
    Deno.stdout.writable,
    stdout,
    channelBytes(double.token, "stdout", "head"),
  );
  yield* emit(
    Deno.stderr.writable,
    stderr,
    channelBytes(double.token, "stderr", "head"),
  );
  if (double.mode === "ps-failure") {
    yield* writeTextFile(join(double.directory, "ready"), "");
    yield* suspend();
  }
  const scripted = double.mode === "pass" ? scriptedReasons : [undefined];
  const repls = yield* all(
    scripted.map((reason) => launchRepl(double, record, reason)),
  );
  if (double.mode === "output-rejection" || double.mode === "held-sample") {
    yield* suspend();
  }
  const lines = ["tests failed: 7 of 7 tests failed"];
  if (double.mode === "pass") {
    lines.push(...reasons);
    for (const { reason, pid } of repls) {
      const evidence = yield* writeEvidence(double, pid);
      record.evidence.push(evidence);
      lines.push(`${reason}`, `Evidence: ${evidence}`);
    }
  } else {
    lines.push(
      ...reasons.filter((reason) => reason !== omittedReason),
      ...scriptedReasons,
    );
  }
  yield* emit(
    Deno.stdout.writable,
    stdout,
    encoder.encode(`${lines.join("\n")}\n`),
  );
  yield* exit(1);
}

/** In `ps-failure` mode, forward until one sample follows the child's readiness, then refuse. */
function* refuses(double: Double) {
  if (
    double.mode !== "ps-failure" ||
    !(yield* exists(join(double.directory, "ready")))
  ) {
    return false;
  }
  try {
    const marker = yield* until(
      open(join(double.directory, "forwarded-after-ready"), "wx"),
    );
    yield* until(marker.close());
    return false;
  } catch {
    return true;
  }
}

function* ps(double: Double, args: string[]) {
  const runs = join(double.directory, "ps");
  yield* ensureDir(runs);
  yield* writeTextFile(join(runs, `${Deno.pid}.started`), "");
  yield* ensure(() => writeTextFile(join(runs, `${Deno.pid}.ended`), ""));
  if (yield* refuses(double)) {
    yield* emit(
      Deno.stderr.writable,
      [],
      encoder.encode(`ps double refused ${double.token}\n`),
    );
    yield* exit(1);
  }
  const snapshot = yield* until(
    new Deno.Command("ps", { args, env: { PATH: double.path } }).output(),
  );
  yield* emit(Deno.stdout.writable, [], snapshot.stdout);
  yield* emit(Deno.stderr.writable, [], snapshot.stderr);
  const listed = new TextDecoder().decode(snapshot.stdout);
  const gate = join(double.directory, "gate");
  for (const name of yield* readdir(gate)) {
    const pair = name.match(/^(\d+)-(\d+)\.sock$/);
    if (
      pair !== null &&
      new RegExp(`^\\s*${pair[2]}\\s+${pair[1]}\\s`, "m").test(listed)
    ) {
      try {
        const connection = yield* until(
          Deno.connect({ transport: "unix", path: join(gate, name) }),
        );
        try {
          // macOS fails the waiter's accept when its peer has already closed.
          yield* until(connection.read(new Uint8Array(1)));
        } finally {
          connection.close();
        }
      } catch {
        // The waiter already saw an earlier sample and closed its socket.
      }
    }
  }
  yield* exit(snapshot.code);
}

if (import.meta.main) {
  await main(function* (args) {
    const double = Double.parse(
      JSON.parse(Deno.env.get("TEARDOWN_DOUBLE") ?? ""),
    );
    const [role, ...rest] = args;
    if (role === "child") {
      yield* child(double);
    } else if (role === "repl") {
      yield* repl(double);
    } else if (role === "worker") {
      yield* suspend();
    } else if (role === "ps") {
      yield* ps(double, rest);
    } else {
      throw new Error(`Unknown teardown double role: ${role}`);
    }
  });
}

// The preload controls only native collection promises; real child/status and ps remain owned.
if (!import.meta.main && Deno.env.get("TEARDOWN_COLLECTION_GATE") === "1") {
  const double = Double.parse(
    JSON.parse(Deno.env.get("TEARDOWN_DOUBLE") ?? ""),
  );
  const rejected = Promise.withResolvers<void>();
  const spawnCommand = Deno.Command.prototype.spawn;
  const collectCommand = Deno.Command.prototype.output;
  let acquired = false;
  Deno.Command.prototype.spawn = function () {
    const child = spawnCommand.call(this);
    if (acquired) {
      return child;
    }
    acquired = true;
    const collect = child.output.bind(child);
    const status = child.status;
    const draining = collect();
    Object.defineProperty(child, "status", {
      get: () =>
        run(function* () {
          const result = yield* until(status);
          yield* until(draining);
          yield* writeTextFile(
            join(double.directory, "status-joined"),
            JSON.stringify(result),
          );
          return result;
        }),
    });
    // Keep the real channel collector joined even though the exposed collection rejects.
    Object.defineProperty(child, "output", {
      configurable: true,
      value: () => {
        return run(function* () {
          yield* until(rejected.promise);
          Deno.kill(child.pid, 0);
          yield* writeTextFile(
            join(double.directory, "rejected-live"),
            String(child.pid),
          );
          throw new Error(`controlled output rejection ${double.token}`);
        });
      },
    });
    return child;
  };
  Deno.Command.prototype.output = function () {
    const captured = collectCommand.call(this);
    const held = Promise.withResolvers<Deno.CommandOutput>();
    let matched = false;
    const pendingTask = run(function* () {
      const snapshot = yield* until(captured);
      const listed = new TextDecoder().decode(snapshot.stdout);
      const pair = listed.split("\n").find((line) =>
        line.includes(double.token) && line.includes("test-agent --connect")
      );
      if (pair === undefined) {
        return snapshot;
      }
      const row = pair.trim().split(/\s+/);
      yield* writeTextFile(
        join(double.directory, "held-pair.json"),
        JSON.stringify({ pid: Number(row[0]), ppid: Number(row[1]) }),
      );
      matched = true;
      rejected.resolve();
      if (double.mode === "held-sample") {
        return yield* until(held.promise);
      }
      return snapshot;
    });
    const pending = pendingTask.then((value) => value);
    const then = pending.then.bind(pending);
    let observations = 0;
    Object.defineProperty(pending, "then", {
      value: (...args: Parameters<typeof then>) => {
        observations++;
        if (matched && double.mode === "held-sample") {
          if (observations === 2) {
            // The unwind collector joins the single native wait before delivery.
            captured.then(held.resolve, held.reject);
          }
        }
        return then(...args);
      },
    });
    return pending;
  };
}
