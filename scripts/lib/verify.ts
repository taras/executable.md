/**
 * The whole applicable battery, at once, and the proof it changed nothing.
 *
 * The commands were always independent; what stopped them running together was
 * shared mutable state, which #304 removed by giving preparation an owner and
 * making builds inert. What is left is coordination, and it lives here: which
 * commands apply, in what order they are reported, what a failure prints, and
 * whether the tracked tree came out the way it went in.
 *
 * ## Nothing here knows which host it is on
 *
 * Every host-specific act — starting a process, spooling its bytes, reading the
 * index, digesting a file — arrives as a capability from `scripts/verify.ts`.
 * That is not decoration: this module is listed in `tsconfig.node.json`, so
 * importing `prepared-state.ts` (six `Deno.*` globals) would fail
 * `tsc --project tsconfig.node.json` in a program whose types are `["node"]`.
 * The typecheck is the boundary's proof.
 *
 * The fingerprint arrives whole rather than as a file-reading primitive, for
 * the same reason: digesting and `lstat` belong on the host side of the line.
 *
 * ## Two rules the report obeys
 *
 * Results are ordered by `BATTERY`, never by which command finished first, so
 * two runs of the same worktree read identically. And every command settles
 * before anything is decided: one runtime failing must not cancel another, and
 * must not skip the fingerprint that runs afterwards — a failing battery is
 * exactly when a dirtied tree would otherwise go unnoticed.
 *
 * A command that outlives `COMMAND_TIMEOUT_MILLISECONDS` is settled by the
 * battery itself — killed, counted failed, reported with whatever it wrote —
 * because a battery with no ceiling hangs silently when a command wedges. The
 * deadline is announced when the battery starts and named again in the line
 * that reports it, so it is never something a reader has to infer. Nothing
 * retries: a wedged command fails once, and an upstream defect that is getting
 * worse stays visible instead of being absorbed by an attempt count.
 */

import { allSettled, race, sleep } from "effection";
import type { Operation, Result } from "effection";

import { parseNameStatus, parsePorcelain, touches } from "./changed-paths.ts";
import { compareTracked } from "./tracked.ts";
import type { TrackedState } from "./tracked.ts";

/** The programs the battery runs, named rather than resolved. */
export type Program = "deno" | "pnpm" | "bun";

export interface CommandSpec {
  id: string;
  program: Program;
  args: string[];
  /** Repository-relative working directory; the root when absent. */
  cwd?: string;
  /** Applicable only when `site/` changed. */
  site?: boolean;
}

/** The battery, in the order every report uses. */
export const BATTERY: readonly CommandSpec[] = [
  { id: "vendor", program: "deno", args: ["task", "vendor:verify"] },
  { id: "lint", program: "deno", args: ["task", "lint"] },
  { id: "check", program: "deno", args: ["task", "check"] },
  { id: "test", program: "deno", args: ["task", "test"] },
  { id: "check:jsr", program: "deno", args: ["task", "check:jsr"] },
  {
    id: "tsc",
    program: "pnpm",
    args: ["exec", "tsc", "--project", "tsconfig.node.json", "--noEmit"],
  },
  { id: "test:node", program: "pnpm", args: ["test:node"] },
  { id: "test:bun", program: "bun", args: ["run", "test:bun"] },
  {
    id: "docs",
    program: "deno",
    args: ["task", "xmd", "test", "packages/core/src", "--raw"],
  },
  { id: "site:check", program: "deno", args: ["task", "check"], cwd: "site", site: true },
  { id: "site:build", program: "deno", args: ["task", "build"], cwd: "site", site: true },
];

export interface Settled {
  code: number;
  milliseconds: number;
  /** Settled by the ceiling rather than by its own exit. */
  timedOut?: boolean;
}

/**
 * How long one command may run before the battery gives up on it.
 *
 * `deno bundle` and its esbuild service can deadlock under concurrent load —
 * both idle at 0% CPU, never recovering — and a battery with no ceiling then
 * hangs to whatever kills it from outside, with nothing printed. The ceiling
 * clears every healthy command by a wide margin: the slowest observed leg of
 * the battery is minutes, not tens of minutes.
 */
export const COMMAND_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;

export interface VerifyHost {
  /** Start `command`, spool its output, and settle with its status. */
  run(command: CommandSpec): Operation<Settled>;
  /** The bytes a settled command wrote, in the order it wrote them. */
  spool(id: string): Operation<Uint8Array>;
  /** Every tracked path, by content, mode, symlink target, or absence. */
  fingerprint(): Operation<TrackedState>;
  /** Run git and return its standard output. */
  git(args: string[]): Operation<string>;
  /** A line of the report. */
  log(line: string): void;
  /** Bytes straight through, so a failure's output survives undecoded. */
  emit(bytes: Uint8Array): void;
}

export interface VerifyOptions {
  /** `off` is how `verify:clean` runs the battery inside a fresh clone. */
  site: "auto" | "off";
  /** Milliseconds one command may run; `COMMAND_TIMEOUT_MILLISECONDS` when absent. */
  timeout?: number;
}

interface Applicability {
  commands: CommandSpec[];
  reason: string;
}

/**
 * Whether the site pair applies, and why.
 *
 * An unresolvable base is not "nothing changed": it is not knowing, and not
 * knowing runs the checks.
 */
export function* applicable(host: VerifyHost, options: VerifyOptions): Operation<Applicability> {
  if (options.site === "off") {
    return { commands: BATTERY.filter((command) => !command.site), reason: "--no-site" };
  }

  const worktree = parsePorcelain(yield* host.git(["status", "--porcelain=v1", "-z"]));
  let branch: string[] = [];
  let reason = "site/ unchanged since origin/main";
  try {
    const base = (yield* host.git(["merge-base", "origin/main", "HEAD"])).trim();
    branch = parseNameStatus(
      yield* host.git(["diff", "--name-status", "-z", "-M", "-C", `${base}...HEAD`]),
    );
  } catch {
    return {
      commands: [...BATTERY],
      reason: "the base could not be resolved, so site/ may have changed",
    };
  }

  if (touches([...worktree, ...branch], "site")) {
    reason = "site/ changed";
    return { commands: [...BATTERY], reason };
  }
  return { commands: BATTERY.filter((command) => !command.site), reason };
}

/** `deno task lint`, `pnpm exec tsc …` — what a reader would type to re-run it. */
export function line(command: CommandSpec): string {
  const prefix = command.cwd ? `(cd ${command.cwd} && ` : "";
  const suffix = command.cwd ? ")" : "";
  return `${prefix}${command.program} ${command.args.join(" ")}${suffix}`;
}

/** The deadline as the report states it, so a reader never has to infer one. */
function minutes(milliseconds: number): string {
  return `${Math.round(milliseconds / 60_000)}m`;
}

function seconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 100) / 10}s`;
}

/**
 * Losing the race halts `host.run`, whose scope teardown signals the
 * command's process group and closes its spool — so a command settled this
 * way still reports with everything it had written.
 */
function* expiry(milliseconds: number): Operation<Settled> {
  yield* sleep(milliseconds);
  return { code: 1, milliseconds, timedOut: true };
}

/**
 * Run the applicable battery and report it.
 *
 * Returns the exit code: non-zero when any command failed, when the tracked
 * tree moved, or when the fingerprint refused an entry it cannot describe.
 */
export function* verify(host: VerifyHost, options: VerifyOptions): Operation<number> {
  const before = yield* host.fingerprint();
  const { commands, reason } = yield* applicable(host, options);
  const timeout = options.timeout ?? COMMAND_TIMEOUT_MILLISECONDS;

  host.log(
    `verifying ${commands.length} commands concurrently (${reason}), ` +
      `${minutes(timeout)} deadline each`,
  );
  const settled = yield* allSettled(
    commands.map((command) => race([host.run(command), expiry(timeout)])),
  );
  const after = yield* host.fingerprint();

  const failures: CommandSpec[] = [];
  host.log("");
  for (const [index, command] of commands.entries()) {
    const result = outcome(settled[index]!);
    if (result.code === 0) {
      host.log(`  ok      ${command.id.padEnd(10)} ${seconds(result.milliseconds)}`);
      continue;
    }
    failures.push(command);
    const why = result.timedOut ? `timed out after ${minutes(timeout)}` : `exit ${result.code}`;
    host.log(`  FAILED  ${command.id.padEnd(10)} ${seconds(result.milliseconds)} (${why})`);
  }

  const [first, ...rest] = failures;
  if (first) {
    host.log(`\n─── ${first.id} ───`);
    host.emit(yield* host.spool(first.id));
    host.log(`\nre-run with:\n  ${line(first)}`);
    for (const command of rest) {
      host.log(`\nalso failed: ${command.id}\n  ${line(command)}`);
    }
  }

  const moved = compareTracked(before, after);
  if (moved.length > 0) {
    host.log(`\n✗ the battery changed ${moved.length} tracked path(s):`);
    for (const change of moved) {
      host.log(`  ${change}`);
    }
    return 1;
  }

  if (failures.length > 0) {
    return 1;
  }
  host.log("\nthe battery passed, and the tracked tree is unchanged");
  return 0;
}

/** A runner that never started still failed, and its command still reports. */
function outcome(result: Result<Settled>): Settled {
  if (result.ok) {
    return result.value;
  }
  return { code: 1, milliseconds: 0 };
}
