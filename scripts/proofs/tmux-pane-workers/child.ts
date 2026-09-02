/**
 * The deterministic interactive child that stands in for a native Agent UI.
 *
 * It records what it can see — its argv bytes, its process relationships, and
 * whether each standard stream is a terminal — in an evidence file the parent
 * reads, prints the same to the pane, then echoes every line typed at it until
 * told `exit N`. Negative modes make it misbehave in the ways the topology has
 * to survive:
 *
 * - `exit1`: start, then exit 1 at once (ready and settled together);
 * - `ignore-sigint-fork`: swallow SIGINT and fork a descendant that stays in
 *   the inherited process group;
 * - `escape`: fork a descendant that leaves the process group and session
 *   with `setsid()` while still holding the pane's terminal open;
 * - `escape-closed`: the same, with the terminal closed, so nothing but the
 *   process table remembers where it came from.
 *
 * Usage: child.ts --evidence <file> --mode <mode> -- <arbitrary args...>
 *
 * Started with `run()`, not `main()`: `main()` would turn every SIGINT into
 * its own exit 130, and the negative mode has to be able to ignore one.
 */

import { spawn as spawnChild } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { writeTextFile } from "@effectionx/fs";
import { fromReadable } from "@effectionx/node";
import { lines } from "@effectionx/stream-helpers";
import { each, run, withResolvers } from "effection";
import type { Operation } from "effection";
import { processFacts } from "./processes.ts";

export interface ChildEvidence {
  mode: string;
  argv: string[];
  pid: number;
  ppid: number;
  pgid: number;
  tty: string;
  tpgid: number;
  isatty: [boolean, boolean, boolean];
  stdin: string[];
  signals: string[];
  descendants: { pid: number; kind: string }[];
}

function say(text: string): Operation<void> {
  const written = withResolvers<void>();
  process.stdout.write(text, () => written.resolve());
  return written.operation;
}

function parseArgs(argv: string[]): { evidence: string; mode: string; rest: string[] } {
  let evidence = "";
  let mode = "plain";
  let index = 0;
  while (index < argv.length) {
    const current = argv[index];
    if (current === "--") {
      return { evidence, mode, rest: argv.slice(index + 1) };
    }
    if (current === "--evidence") {
      evidence = argv[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (current === "--mode") {
      mode = argv[index + 1] ?? "plain";
      index += 2;
      continue;
    }
    index += 1;
  }
  return { evidence, mode, rest: [] };
}

const status = await run(function* (): Operation<number> {
  const { evidence: evidencePath, mode, rest } = parseArgs(process.argv.slice(2));
  const facts = yield* processFacts(process.pid);
  const evidence: ChildEvidence = {
    mode,
    argv: rest,
    pid: process.pid,
    ppid: process.ppid,
    pgid: facts?.pgid ?? -1,
    tty: facts?.tty ?? "??",
    tpgid: facts?.tpgid ?? -1,
    isatty: [
      process.stdin.isTTY === true,
      process.stdout.isTTY === true,
      process.stderr.isTTY === true,
    ],
    stdin: [],
    signals: [],
    descendants: [],
  };
  function* record(): Operation<void> {
    if (evidencePath.length > 0) {
      yield* writeTextFile(evidencePath, JSON.stringify(evidence, null, 2));
    }
  }

  if (mode === "ignore-sigint-fork") {
    process.on("SIGINT", () => {
      evidence.signals.push("SIGINT");
      process.stdout.write("child: ignoring SIGINT\n");
      // From a callback, and SIGKILL may follow within two seconds, so the
      // write cannot wait for the next stdin line.
      writeFile(evidencePath, JSON.stringify(evidence, null, 2)).catch(() => undefined);
    });
    // The descendant ignores SIGINT too: it shares the pane's process group,
    // so a `^C` typed at the pane would otherwise end it before teardown
    // gets to prove anything.
    const descendant = spawnChild("sh", ["-c", "trap '' INT; exec sleep 600"], { stdio: "ignore" });
    if (descendant.pid !== undefined) {
      evidence.descendants.push({ pid: descendant.pid, kind: "in-group" });
    }
  }
  if (mode === "escape" || mode === "escape-closed") {
    const descendant = spawnChild("sleep", ["600"], {
      detached: true,
      stdio: mode === "escape" ? "inherit" : "ignore",
    });
    descendant.unref();
    if (descendant.pid !== undefined) {
      evidence.descendants.push({ pid: descendant.pid, kind: mode });
    }
  }

  yield* record();
  yield* say(
    `child[${mode}] pid=${evidence.pid} pgid=${evidence.pgid} tty=${evidence.tty} ` +
      `isatty=${evidence.isatty.join(",")} argv=${JSON.stringify(rest)}\n`,
  );
  if (mode === "exit1") {
    return 1;
  }

  for (const line of yield* each(lines()(fromReadable(process.stdin)))) {
    evidence.stdin.push(line);
    yield* record();
    const exitRequest = /^exit (\d+)$/.exec(line.trim());
    if (exitRequest) {
      yield* say(`child: exiting ${exitRequest[1]}\n`);
      return Number(exitRequest[1]);
    }
    yield* say(`> ${line}\n`);
    yield* each.next();
  }
  return 0;
});
process.exit(status);
