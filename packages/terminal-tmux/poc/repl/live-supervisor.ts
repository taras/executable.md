/**
 * Issue #774 POC — the doubly-gated live-proof supervisor.
 *
 * A live journey launches a real coding agent and spends real model turns, so it
 * is refused unless both of its exact gates are supplied for this invocation.
 * The gate check is the first thing that happens: before it passes, nothing here
 * starts an agent, opens a provider transcript, or reads anything a provider
 * owns. Without the gates the supervisor prints a `NOT_AUTHORIZED` report and
 * exits cleanly, which is what runs on an ordinary machine and in CI.
 *
 * Previous authorization does not count. Each provider's gates are read from the
 * live environment of this exact invocation, and the turn-count gate must carry
 * the exact value the journey is allowed to spend — one for Claude, two for
 * Codex.
 *
 * When the gates are present, the journey itself lives in `live-worker.ts`; this
 * module only decides whether it may run and shapes the report either way.
 */

import { main } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { notAuthorizedReport } from "./report.ts";
import type { ReportMode, TerminalReplReport } from "./report.ts";
import { runLiveJourney } from "./live-worker.ts";

/** The provider a live journey targets. */
export type LiveProvider = "claude" | "codex";

/** One provider's exact gates and the turn value its journey may spend. */
interface Gate {
  readonly proofEnv: string;
  readonly turnsEnv: string;
  readonly turnsValue: string;
  readonly mode: ReportMode;
}

const GATES: Readonly<Record<LiveProvider, Gate>> = {
  claude: {
    proofEnv: "XMD_TERMINAL_REPL_CLAUDE_PROOF",
    turnsEnv: "XMD_TERMINAL_REPL_CLAUDE_MODEL_TURNS_AUTHORIZED",
    turnsValue: "1",
    mode: "live-claude",
  },
  codex: {
    proofEnv: "XMD_TERMINAL_REPL_CODEX_PROOF",
    turnsEnv: "XMD_TERMINAL_REPL_CODEX_MODEL_TURNS_AUTHORIZED",
    turnsValue: "2",
    mode: "live-codex",
  },
};

/** Whether both of a provider's gates are supplied with their exact values. */
export function gatesSatisfied(
  provider: LiveProvider,
  env: Record<string, string | undefined>,
): boolean {
  const gate = GATES[provider];
  return env[gate.proofEnv] === "1" && env[gate.turnsEnv] === gate.turnsValue;
}

/** The two exact commands a reviewer runs to authorize each live journey. */
export const LIVE_COMMANDS: Readonly<Record<LiveProvider, string>> = {
  claude:
    "XMD_TERMINAL_REPL_CLAUDE_PROOF=1 XMD_TERMINAL_REPL_CLAUDE_MODEL_TURNS_AUTHORIZED=1 " +
    "deno task xmd test packages/terminal-tmux/poc/repl/ClaudeBlackBoxRepl.test.md --raw",
  codex:
    "XMD_TERMINAL_REPL_CODEX_PROOF=1 XMD_TERMINAL_REPL_CODEX_MODEL_TURNS_AUTHORIZED=2 " +
    "deno task xmd test packages/terminal-tmux/poc/repl/CodexBlackBoxRepl.test.md --raw",
};

/** The runtime this supervisor runs under, for the report's provenance. */
function runtimeName(): string {
  const globals = globalThis as { Deno?: unknown; Bun?: unknown };
  if (globals.Deno !== undefined) {
    return "deno";
  }
  if (globals.Bun !== undefined) {
    return "bun";
  }
  return "node";
}

/**
 * Decide whether a live journey may run, and produce its report either way.
 *
 * The gate check comes first and touches nothing a provider owns. A refusal
 * returns a `NOT_AUTHORIZED` report that spent no turn; a pass hands off to the
 * journey.
 */
export function runLiveProof(
  provider: LiveProvider,
  env: Record<string, string | undefined>,
  base: string,
): Operation<TerminalReplReport> {
  return (function* (): Operation<TerminalReplReport> {
    const gate = GATES[provider];
    if (!gatesSatisfied(provider, env)) {
      return notAuthorizedReport(gate.mode, runtimeName(), base);
    }
    // Only past the gate does anything provider-facing begin.
    return yield* runLiveJourney(provider, env, base);
  })();
}

/** The base commit this POC was built from, recorded in every report. */
const BASE_SHA = "97fda6aa7b5f85db747c066898fd3ef3c6d1dbeb";

/** Parse the provider argument, refusing anything but the two supported names. */
function providerArgument(argv: readonly string[]): LiveProvider | undefined {
  const [name] = argv;
  if (name === "claude" || name === "codex") {
    return name;
  }
  return undefined;
}

// Runnable under Deno as `deno run ... live-supervisor.ts <claude|codex>`. It
// prints one report as JSON and exits 0; a nonzero exit means the supervisor
// itself broke, never that a journey reached a verdict.
if (import.meta.main) {
  await main(function* (): Operation<void> {
    const provider = providerArgument(process.argv.slice(2));
    if (provider === undefined) {
      process.stdout.write(
        `${JSON.stringify({ error: "usage: live-supervisor.ts <claude|codex>" })}\n`,
      );
      return;
    }
    const report = yield* runLiveProof(provider, process.env, BASE_SHA);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
}
