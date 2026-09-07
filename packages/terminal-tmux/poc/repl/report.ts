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
 * The schema is the disclosure boundary. A report that tried to carry a
 * forbidden field would fail validation here, so the builder and the validator
 * are kept together.
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

export type ReportMode = "deterministic" | "live-claude" | "live-codex";

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
  readonly identityHash?: string;
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
  readonly head?: { readonly sha?: string };
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
