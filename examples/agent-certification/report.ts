import type { SessionConfiguration } from "@executablemd/core";
import { z } from "zod";

export const capability = z.enum([
  "acceptance",
  "identity",
  "authentication",
  "streaming",
  "completion",
  "continuity",
  "separation",
  "model",
  "effort",
  "reconnect",
  "cancellation",
  "cleanup",
  "resume",
]);
export type Capability = z.infer<typeof capability>;
export const configurationSchema = z.strictObject({
  command: z.string().trim().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  scenarios: z
    .array(capability)
    .min(1)
    .refine((items) => new Set(items).size === items.length),
  expected: z.array(capability).refine((items) => new Set(items).size === items.length),
});
export type Configuration = z.infer<typeof configurationSchema>;
const reason = z.enum([
  "unselected",
  "selection-not-requested",
  "prerequisite-not-passed",
  "agent-unavailable",
  "authentication-refused",
  "acceptance-unavailable",
  "identity-unavailable",
  "selector-unavailable",
  "configuration-mismatch",
  "marker-mismatch",
  "session-contamination",
  "unattributed-deadline",
  "premature-completion",
  "cleanup-unverified",
  "cleanup-failed",
  "interrupted",
  "completed",
  "unexpected-failure",
]);
const rowSchema = z.strictObject({
  selected: z.boolean(),
  expected: z.boolean(),
  outcome: z.enum(["pass", "failure", "unsupported", "not_run"]),
  reason,
  observations: z.strictObject({
    accepted: z.boolean(),
    completed: z.boolean(),
    deltas: z.number().int().nonnegative(),
    matched: z.boolean(),
    requestedStop: z.boolean(),
    activeAtStop: z.boolean(),
    attributed: z.boolean(),
    ownerJoined: z.boolean(),
    nativeCleanupVerified: z.boolean(),
  }),
});
export type Row = z.infer<typeof rowSchema>;
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .nullable();
const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/u)
  .nullable();
export const reportSchema = z.strictObject({
  complete: z.boolean(),
  selectedCapabilitiesPassed: z.boolean(),
  durableSessionCertified: z.boolean(),
  fingerprints: z.strictObject({
    configuration: digest,
    source: digest,
    executable: digest,
    adapter: digest,
  }),
  versions: z.strictObject({ agent: version, adapter: version, runtime: version }),
  platform: z.strictObject({
    os: z.enum(["darwin", "linux", "win32", "unknown"]),
    arch: z.enum(["arm64", "x64", "unknown"]),
  }),
  counts: z.strictObject({
    prompts: z.number().int().min(0).max(6),
    cancellationRequests: z.number().int().min(0).max(1),
  }),
  exitState: z.enum(["settled", "failed", "interrupted"]),
  capabilities: z.strictObject({
    acceptance: rowSchema,
    identity: rowSchema,
    authentication: rowSchema,
    streaming: rowSchema,
    completion: rowSchema,
    continuity: rowSchema,
    separation: rowSchema,
    model: rowSchema,
    effort: rowSchema,
    reconnect: rowSchema,
    cancellation: rowSchema,
    cleanup: rowSchema,
    resume: rowSchema,
  }),
});
export type Report = z.infer<typeof reportSchema>;

export function initialRow(config: Configuration, name: Capability): Row {
  const selected = config.scenarios.includes(name);
  return {
    selected,
    expected: config.expected.includes(name),
    outcome: "not_run",
    reason: !selected
      ? "unselected"
      : (name === "model" && config.model === undefined) ||
          (name === "effort" && config.effort === undefined)
        ? "selection-not-requested"
        : "prerequisite-not-passed",
    observations: {
      accepted: false,
      completed: false,
      deltas: 0,
      matched: false,
      requestedStop: false,
      activeAtStop: false,
      attributed: false,
      ownerJoined: false,
      nativeCleanupVerified: false,
    },
  };
}
export function initialReport(config: Configuration): Report {
  return {
    complete: false,
    selectedCapabilitiesPassed: false,
    durableSessionCertified: false,
    fingerprints: { configuration: null, source: null, executable: null, adapter: null },
    versions: { agent: null, adapter: "0.22.0", runtime: null },
    platform: { os: "unknown", arch: "unknown" },
    counts: { prompts: 0, cancellationRequests: 0 },
    exitState: "settled",
    capabilities: {
      acceptance: initialRow(config, "acceptance"),
      identity: initialRow(config, "identity"),
      authentication: initialRow(config, "authentication"),
      streaming: initialRow(config, "streaming"),
      completion: initialRow(config, "completion"),
      continuity: initialRow(config, "continuity"),
      separation: initialRow(config, "separation"),
      model: initialRow(config, "model"),
      effort: initialRow(config, "effort"),
      reconnect: initialRow(config, "reconnect"),
      cancellation: initialRow(config, "cancellation"),
      cleanup: initialRow(config, "cleanup"),
      resume: initialRow(config, "resume"),
    },
  };
}

const configurationFailureSchema = z.strictObject({
  reason: z.enum(["selector-unavailable", "configuration-mismatch"]),
  setting: z.enum(["model", "effort"]),
});
export function configurationFailure(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    Reflect.get(error, "sessionUnusable") === true
  ) {
    return undefined;
  }
  const parsed = configurationFailureSchema.safeParse(
    Reflect.get(error, "executablemd.acp.configuration-failure"),
  );
  return parsed.success ? parsed.data : undefined;
}
export function recordConfigurationFailure(report: Report, error: unknown): void {
  const evidence = configurationFailure(error);
  if (evidence === undefined) {
    for (const name of ["model", "effort"] satisfies Capability[]) {
      if (
        report.capabilities[name].selected &&
        report.capabilities[name].reason !== "selection-not-requested"
      ) {
        Object.assign(report.capabilities[name], {
          outcome: "failure",
          reason: "unexpected-failure",
        });
      }
    }
    return;
  }
  const row = report.capabilities[evidence.setting];
  if (row.selected) {
    row.outcome = evidence.reason === "selector-unavailable" ? "unsupported" : "failure";
    row.reason = evidence.reason;
  }
}

export function recordConfigurationSuccess(
  report: Report,
  configuration: SessionConfiguration | undefined,
): void {
  for (const name of ["model", "effort"] satisfies Capability[]) {
    const row = report.capabilities[name];
    if (row.selected && configuration?.[name] !== undefined) {
      row.outcome = "pass";
      row.reason = "completed";
    }
  }
}

export function recordTurn(
  report: Report,
  observation: { accepted: boolean; completed: boolean; deltas: number },
  count = true,
): void {
  if (count) {
    report.counts.prompts++;
  }
  for (const name of ["authentication", "streaming", "completion"] satisfies Capability[]) {
    const row = report.capabilities[name];
    if (!row.selected || row.outcome === "pass") {
      continue;
    }
    Object.assign(row.observations, observation);
    const passed =
      observation.accepted &&
      observation.completed &&
      (name !== "streaming" || observation.deltas > 0);
    row.outcome = passed ? "pass" : "failure";
    row.reason = passed ? "completed" : "unexpected-failure";
  }
}
export function recordMarker(
  report: Report,
  name: "continuity" | "separation" | "reconnect" | "resume",
  marker: string,
  reply: string,
  accepted: boolean,
): void {
  const row = report.capabilities[name];
  if (!row.selected) {
    return;
  }
  const matched = reply.trim() === marker;
  const passed = accepted && (name === "separation" ? reply.trim() === "UNKNOWN" : matched);
  Object.assign(row.observations, { accepted, matched });
  row.outcome = passed ? "pass" : "failure";
  row.reason = passed
    ? "completed"
    : name === "separation" && matched
      ? "session-contamination"
      : "marker-mismatch";
}
export function recordCancellation(
  report: Report,
  observation: {
    requestedStop: boolean;
    activeAtStop: boolean;
    attributed: boolean;
    completed: boolean;
    ownerJoined: boolean;
    nativeCleanupVerified: boolean;
  },
): void {
  report.counts.cancellationRequests = observation.requestedStop ? 1 : 0;
  const row = report.capabilities.cancellation;
  if (!row.selected) {
    return;
  }
  Object.assign(row.observations, observation);
  if (
    !observation.requestedStop ||
    !observation.activeAtStop ||
    !observation.attributed ||
    observation.completed
  ) {
    row.outcome = "failure";
    row.reason = observation.completed ? "premature-completion" : "unattributed-deadline";
  } else if (!observation.ownerJoined || !observation.nativeCleanupVerified) {
    row.outcome = "not_run";
    row.reason = "cleanup-unverified";
  } else {
    row.outcome = "pass";
    row.reason = "completed";
  }
}
export function recordCleanup(
  report: Report,
  joined: boolean,
  verified: boolean,
  failed = false,
): void {
  const row = report.capabilities.cleanup;
  failed ||= row.outcome === "failure" && row.reason === "cleanup-failed";
  row.observations.ownerJoined = joined;
  row.observations.nativeCleanupVerified = verified;
  const cancellation = report.capabilities.cancellation;
  if (
    cancellation.selected &&
    cancellation.observations.requestedStop &&
    (failed || ((!verified || !joined) && cancellation.outcome !== "failure"))
  ) {
    cancellation.outcome = failed ? "failure" : "not_run";
    cancellation.reason = failed ? "cleanup-failed" : "cleanup-unverified";
  }
  if (row.selected) {
    row.outcome = failed ? "failure" : verified && joined ? "pass" : "not_run";
    row.reason = failed
      ? "cleanup-failed"
      : verified && joined
        ? "completed"
        : "cleanup-unverified";
  }
}
export function finalizeReport(input: Report): Report {
  const report = reportSchema.parse(input);
  const provenance =
    Object.values(report.fingerprints).every((value) => value !== null) &&
    Object.values(report.versions).every((value) => value !== null);
  const rows = Object.values(report.capabilities);
  report.complete =
    report.exitState === "settled" &&
    provenance &&
    rows.every((row) => !row.selected || row.outcome !== "not_run");
  report.selectedCapabilitiesPassed =
    report.complete &&
    rows.every((row) => !(row.selected || row.expected) || row.outcome === "pass");
  report.durableSessionCertified =
    report.selectedCapabilitiesPassed &&
    [
      report.capabilities.acceptance,
      report.capabilities.identity,
      report.capabilities.continuity,
      report.capabilities.separation,
      report.capabilities.reconnect,
      report.capabilities.resume,
      report.capabilities.cleanup,
    ].every((row) => row.outcome === "pass");
  return reportSchema.parse(report);
}

export function recordSessionEvidence(report: Report, strong: boolean, native: boolean): void {
  for (const [name, passed, unavailable] of [
    ["acceptance", strong, "acceptance-unavailable"],
    ["identity", native, "identity-unavailable"],
  ] satisfies [
    "acceptance" | "identity",
    boolean,
    "acceptance-unavailable" | "identity-unavailable",
  ][]) {
    const row = report.capabilities[name];
    if (row.selected && row.outcome !== "pass") {
      row.outcome = passed ? "pass" : "unsupported";
      row.reason = passed ? "completed" : unavailable;
    }
  }
}
