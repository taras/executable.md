/**
 * Issue #774 POC — the closed-out live supervisor.
 *
 * The POC concluded VIEW_ONLY (see `RESULT.md`): reliable message dispatch cannot
 * be established over black-box tmux input and stays ACP-owned. The live-delivery
 * journey is therefore permanently disabled. `runLiveProof` launches no coding
 * agent, opens no transcript, spends no model turn, and reads no gate: under any
 * environment it returns the VIEW_ONLY conclusion. The gates that once armed a
 * paid run are gone, so there is nothing to authorize.
 */

import { main } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { validateReport } from "./report.ts";
import type { ReportMode, TerminalReplReport } from "./report.ts";

/** The provider a (now disabled) live journey would have targeted. */
export type LiveProvider = "claude" | "codex";

/** The base commit this POC was built from, recorded in every report. */
const BASE_SHA = "97fda6aa7b5f85db747c066898fd3ef3c6d1dbeb";

/** The one-line reason dispatch was not established, carried in the report. */
const RACE_DETAIL =
  "VIEW_ONLY: a provider turn can open between the final combined sample and the " +
  "single guarded paste; that window is not observable before the paste and cannot " +
  "be atomically refused, so reliable dispatch is not established and tmux delivery " +
  "stays view-only while reliable REPL interaction remains ACP-owned.";

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

/** The VIEW_ONLY closeout report for one provider. No agent, no turn. */
export function viewOnlyCloseout(provider: LiveProvider, base: string): TerminalReplReport {
  const mode: ReportMode = provider === "claude" ? "live-claude" : "live-codex";
  const target = { verdict: "VIEW_ONLY" as const, versionKnown: false };
  const absent = { verdict: "n/a" as const, versionKnown: false };
  return {
    schema: "terminal-repl-poc-report.v1",
    verdict: "VIEW_ONLY",
    mode,
    runtime: runtimeName(),
    detail: RACE_DETAIL,
    base: { sha: base },
    providers: {
      claude: provider === "claude" ? target : absent,
      codex: provider === "codex" ? target : absent,
    },
    turnBudgets: { claudeAuthorized: 0, claudeSpent: 0, codexAuthorized: 0, codexSpent: 0 },
    matrix: [],
    counters: {
      convergenceAttempts: 0,
      admittedDeliveries: 0,
      refusals: 0,
      uncertain: 0,
      duplicateDeliveries: 0,
      wrongPaneDeliveries: 0,
      busyAdmissions: 0,
      manualActivityAdmissions: 0,
      replays: 0,
    },
    restart: { queuedRestored: 0, uncertainAfterRestart: 0, completedRestored: 0, reExecutions: 0 },
    cleanup: { storeRemoved: true, messageFilesRemoved: true, providerFilesUntouched: true },
  };
}

/**
 * The live proof, permanently disabled.
 *
 * Regardless of the environment, this launches nothing and returns the VIEW_ONLY
 * conclusion — the delivery journey the POC used to gate is gone.
 */
// deno-lint-ignore require-yield
export function runLiveProof(
  provider: LiveProvider,
  _env: Record<string, string | undefined>,
  base: string,
): Operation<TerminalReplReport> {
  return (function* (): Operation<TerminalReplReport> {
    return viewOnlyCloseout(provider, base);
  })();
}

/** Parse the provider argument, refusing anything but the two supported names. */
function providerArgument(argv: readonly string[]): LiveProvider | undefined {
  const [name] = argv;
  if (name === "claude" || name === "codex") {
    return name;
  }
  return undefined;
}

// Runnable under Deno as `deno run ... live-supervisor.ts <claude|codex>`. It
// prints the VIEW_ONLY closeout report and the full-schema validation result, and
// exits 0. It starts no agent under any environment.
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
    const validation = yield* validateReport(report);
    const schemaValid = validation.valid;
    process.stdout.write(
      `${JSON.stringify({ report, schemaValid, errors: validation.valid ? [] : validation.errors }, null, 2)}\n`,
    );
    if (!schemaValid) {
      process.exitCode = 1;
    }
  });
}
