/**
 * Issue #774 POC — the report artifact and its validator.
 *
 * The POC's result is one `terminal-repl-poc-report.v1.json`, validated against
 * the checked-in schema beside this file. It carries hashes, counters, versions,
 * turn budgets, the RP1–RP18 matrix, and restart and cleanup evidence — and
 * nothing that could leak a conversation: no transcript text, assistant reply,
 * path, argv, environment, tmux identifier, credential, socket, token or raw
 * native identity. An identity is carried only as a hash.
 *
 * The schema is the disclosure boundary *and* the proof boundary. A `PASS` is
 * only schema-valid with the full evidence its mode requires: a `live-claude` or
 * `live-codex` report needs that provider passing with a known version, hashed
 * native and source identities, observed acceptance and completion, a spent turn,
 * an attempted delivery, and exact base and head commits; a `deterministic` PASS
 * additionally needs the RP matrix with no failed or skipped row. The full POC
 * decision is the conjunction of the offline matrix and both provider documents
 * passing in their own authorized runs. A report that claims `PASS` without its
 * evidence, or carries a forbidden field, fails validation here.
 */

import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { until } from "effection";
import type { Operation } from "effection";

export const REPORT_SCHEMA = "terminal-repl-poc-report.v1" as const;

export type ReportVerdict =
  | "PASS"
  | "VIEW_ONLY"
  | "PROVIDER_EXCLUDED"
  | "ENVIRONMENT_BLOCKED"
  | "HARNESS_FAILED"
  | "NOT_AUTHORIZED";

export type ProviderVerdict = "PASS" | "VIEW_ONLY" | "PROVIDER_EXCLUDED" | "NOT_AUTHORIZED" | "n/a";

export type ReportMode = "deterministic" | "live-claude" | "live-codex" | "overall";

export interface MatrixEntry {
  readonly id: string;
  readonly result: "pass" | "fail" | "n/a";
  readonly evidence: string;
}

export interface ReportCounters {
  readonly convergenceAttempts: number;
  readonly admittedDeliveries: number;
  readonly refusals: number;
  readonly uncertain: number;
  readonly duplicateDeliveries: number;
  readonly wrongPaneDeliveries: number;
  readonly busyAdmissions: number;
  readonly manualActivityAdmissions: number;
  readonly replays: number;
}

export interface ProviderReport {
  readonly verdict: ProviderVerdict;
  readonly versionKnown: boolean;
  /** The observed provider version, when known. Required for a PASS. */
  readonly version?: string;
  /** A hash of the native identity. Required for a PASS. */
  readonly identityHash?: string;
  /** A hash of the source-file identity. Required for a PASS. */
  readonly sourceIdentityHash?: string;
  /** Whether the exact user event was observed. Required for a PASS. */
  readonly accepted?: boolean;
  /** Whether an explicit completion boundary was observed. Required for a PASS. */
  readonly completed?: boolean;
}

export interface DeliveryEvidence {
  readonly messageHash: string;
  readonly byteCount: number;
}

export interface RestartEvidence {
  readonly queuedRestored: number;
  readonly uncertainAfterRestart: number;
  readonly completedRestored: number;
  readonly reExecutions: number;
}

export interface CleanupEvidence {
  readonly storeRemoved: boolean;
  readonly messageFilesRemoved: boolean;
  readonly providerFilesUntouched: boolean;
}

export interface TurnBudgets {
  readonly claudeAuthorized: number;
  readonly claudeSpent: number;
  readonly codexAuthorized: number;
  readonly codexSpent: number;
}

export interface TerminalReplReport {
  readonly schema: typeof REPORT_SCHEMA;
  readonly verdict: ReportVerdict;
  readonly mode: ReportMode;
  readonly runtime: string;
  readonly detail?: string;
  readonly base: { readonly sha: string; readonly parent?: string };
  readonly head?: { readonly sha: string };
  readonly providers: { readonly claude: ProviderReport; readonly codex: ProviderReport };
  readonly turnBudgets: TurnBudgets;
  readonly matrix: readonly MatrixEntry[];
  readonly counters: ReportCounters;
  readonly deliveries?: readonly DeliveryEvidence[];
  readonly restart: RestartEvidence;
  readonly cleanup: CleanupEvidence;
}

/** Hash an identity so the report carries it without carrying the raw value. */
export function identityHash(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

/** The result of validating a report against the checked-in schema. */
export type Validation =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: readonly string[] };

/** Validate a report against `report.schema.json`, read from disk. */
export function validateReport(report: unknown): Operation<Validation> {
  return (function* (): Operation<Validation> {
    const schemaPath = fileURLToPath(new URL("./report.schema.json", import.meta.url));
    const schemaText = new TextDecoder().decode(yield* until(readFile(schemaPath)));
    const schema: unknown = JSON.parse(schemaText);
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema as object);
    if (validate(report)) {
      return { valid: true };
    }
    const errors = (validate.errors ?? []).map(
      (error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    );
    return { valid: false, errors };
  })();
}

/** The report a run produces when its live gates were not supplied. */
export function notAuthorizedReport(
  mode: ReportMode,
  runtime: string,
  base: string,
): TerminalReplReport {
  return {
    schema: REPORT_SCHEMA,
    verdict: "NOT_AUTHORIZED",
    mode,
    runtime,
    detail: "the live proof gates were not supplied, so no agent was started and no turn was spent",
    base: { sha: base },
    providers: {
      claude: { verdict: "NOT_AUTHORIZED", versionKnown: false },
      codex: { verdict: "NOT_AUTHORIZED", versionKnown: false },
    },
    turnBudgets: { claudeAuthorized: 0, claudeSpent: 0, codexAuthorized: 0, codexSpent: 0 },
    matrix: [],
    counters: zeroCounters(),
    restart: { queuedRestored: 0, uncertainAfterRestart: 0, completedRestored: 0, reExecutions: 0 },
    cleanup: { storeRemoved: true, messageFilesRemoved: true, providerFilesUntouched: true },
  };
}

/** Whether a counters block admits nothing unsafe. */
export function countersSafe(counters: ReportCounters): boolean {
  return (
    counters.busyAdmissions === 0 &&
    counters.manualActivityAdmissions === 0 &&
    counters.wrongPaneDeliveries === 0 &&
    counters.duplicateDeliveries === 0
  );
}

/**
 * Decide one provider's verdict from evidence alone.
 *
 * `PROVIDER_EXCLUDED` is reached only from the explicit capability fact that the
 * build has no completion record — never from a deadline. An unsafe admission is
 * `VIEW_ONLY` regardless of acceptance.
 */
export function decideProviderVerdict(inputs: {
  readonly accepted: boolean;
  readonly completed: boolean;
  readonly safe: boolean;
  readonly supportsCompletion: boolean;
}): ProviderVerdict {
  if (!inputs.safe) {
    return "VIEW_ONLY";
  }
  if (inputs.accepted && inputs.completed) {
    return "PASS";
  }
  if (inputs.accepted && !inputs.completed && !inputs.supportsCompletion) {
    return "PROVIDER_EXCLUDED";
  }
  return "VIEW_ONLY";
}

/**
 * Aggregate the offline matrix and both live provider journeys into one overall
 * report.
 *
 * The overall `PASS` is the conjunction the POC decision requires: RP1–RP18 all
 * passing, both providers passing their own authorized journey, every unsafe
 * counter zero, no restart re-execution, and verified cleanup. Anything short of
 * that is not a `PASS` — a single provider can never make the whole POC pass.
 */
export function aggregateReport(
  base: { readonly sha: string; readonly parent?: string },
  head: { readonly sha: string },
  runtime: string,
  deterministic: {
    readonly matrix: readonly MatrixEntry[];
    readonly counters: ReportCounters;
    readonly restart: RestartEvidence;
    readonly cleanup: CleanupEvidence;
    readonly deliveries: readonly DeliveryEvidence[];
  },
  claude: TerminalReplReport,
  codex: TerminalReplReport,
): TerminalReplReport {
  const matrixComplete =
    deterministic.matrix.length >= 18 &&
    deterministic.matrix.every((entry) => entry.result === "pass");
  const counters = mergeCounters(deterministic.counters, claude.counters, codex.counters);
  const cleanup: CleanupEvidence = {
    storeRemoved:
      deterministic.cleanup.storeRemoved &&
      claude.cleanup.storeRemoved &&
      codex.cleanup.storeRemoved,
    messageFilesRemoved:
      deterministic.cleanup.messageFilesRemoved &&
      claude.cleanup.messageFilesRemoved &&
      codex.cleanup.messageFilesRemoved,
    providerFilesUntouched:
      deterministic.cleanup.providerFilesUntouched &&
      claude.cleanup.providerFilesUntouched &&
      codex.cleanup.providerFilesUntouched,
  };
  const restart: RestartEvidence = {
    queuedRestored: deterministic.restart.queuedRestored,
    uncertainAfterRestart: deterministic.restart.uncertainAfterRestart,
    completedRestored: deterministic.restart.completedRestored,
    reExecutions:
      deterministic.restart.reExecutions + claude.restart.reExecutions + codex.restart.reExecutions,
  };
  const cleanupOk =
    cleanup.storeRemoved && cleanup.messageFilesRemoved && cleanup.providerFilesUntouched;
  const pass =
    matrixComplete &&
    claude.verdict === "PASS" &&
    codex.verdict === "PASS" &&
    countersSafe(counters) &&
    restart.reExecutions === 0 &&
    cleanupOk;
  const verdict: ReportVerdict = pass
    ? "PASS"
    : claude.verdict === "PROVIDER_EXCLUDED" || codex.verdict === "PROVIDER_EXCLUDED"
      ? "PROVIDER_EXCLUDED"
      : "VIEW_ONLY";
  return {
    schema: REPORT_SCHEMA,
    verdict,
    mode: "overall",
    runtime,
    base,
    head,
    providers: { claude: claude.providers.claude, codex: codex.providers.codex },
    turnBudgets: {
      claudeAuthorized: claude.turnBudgets.claudeAuthorized,
      claudeSpent: claude.turnBudgets.claudeSpent,
      codexAuthorized: codex.turnBudgets.codexAuthorized,
      codexSpent: codex.turnBudgets.codexSpent,
    },
    matrix: [...deterministic.matrix],
    counters,
    deliveries: [
      ...deterministic.deliveries,
      ...(claude.deliveries ?? []),
      ...(codex.deliveries ?? []),
    ],
    restart,
    cleanup,
  };
}

/** Sum every counter across the offline matrix and the two live journeys. */
function mergeCounters(...blocks: readonly ReportCounters[]): ReportCounters {
  const sum = (pick: (c: ReportCounters) => number) =>
    blocks.reduce((total, c) => total + pick(c), 0);
  return {
    convergenceAttempts: sum((c) => c.convergenceAttempts),
    admittedDeliveries: sum((c) => c.admittedDeliveries),
    refusals: sum((c) => c.refusals),
    uncertain: sum((c) => c.uncertain),
    duplicateDeliveries: sum((c) => c.duplicateDeliveries),
    wrongPaneDeliveries: sum((c) => c.wrongPaneDeliveries),
    busyAdmissions: sum((c) => c.busyAdmissions),
    manualActivityAdmissions: sum((c) => c.manualActivityAdmissions),
    replays: sum((c) => c.replays),
  };
}

/** A counters block with every field at zero. */
export function zeroCounters(): ReportCounters {
  return {
    convergenceAttempts: 0,
    admittedDeliveries: 0,
    refusals: 0,
    uncertain: 0,
    duplicateDeliveries: 0,
    wrongPaneDeliveries: 0,
    busyAdmissions: 0,
    manualActivityAdmissions: 0,
    replays: 0,
  };
}
