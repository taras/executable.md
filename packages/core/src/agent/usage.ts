/**
 * What one Prompt's turn reported about its own consumption
 * (specs/acp-client-spec.md §Prompt usage).
 *
 * A provider observes the readings; this module owns what one of them means
 * once it reaches Core. The value is descriptive and nothing else: no string in
 * it routes a turn, authorizes work, names a Session or continues one. The
 * canonical Prompt record keeps it as optional data beside the identity,
 * Session and outcome the record already carries.
 *
 * Readings are source views, not a ledger. A response total, a quota total and
 * per-model rows can describe overlapping work, so nothing here adds one to
 * another, and coverage says how much of the outer Prompt the readings are
 * known to describe. An empty list of readings is not zero, `tokens: null` is a
 * source that said null, and an omitted number is unknown.
 */

import type { Json } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { retainsOptionalText } from "../secrets/policy.ts";

/** One build identity, where it was observed. */
export interface UsageBuild {
  readonly version?: string;
  readonly digest?: string;
}

/** Which builds produced the turn the readings describe. */
export interface UsageProvenance {
  readonly host: "deno-source" | "compiled";
  readonly xmd: UsageBuild & { readonly sourceRevision?: string };
  readonly runtime: UsageBuild;
  readonly adapter: UsageBuild;
  readonly native?: UsageBuild;
}

/** Counters a source reported, under the source's own field names. */
export interface ReportedTokens {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly thoughtTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
}

interface UsageReadingBase {
  readonly source: "response" | "quota-total" | "quota-model" | "update";
  readonly scope: "main-loop" | "last-request" | "broader-model-work" | "session" | "unknown";
  readonly model?: string;
}

/** One source-labelled view: token counters, context occupancy, or reported cost. */
export type UsageReading = UsageReadingBase &
  (
    | {
        readonly kind: "tokens";
        readonly counter: "turn-total" | "snapshot" | "increment" | "unknown";
        readonly tokens: ReportedTokens | null;
      }
    | {
        readonly kind: "context";
        readonly used?: number;
        readonly size?: number;
      }
    | {
        readonly kind: "cost";
        readonly amount?: number;
        readonly currency?: string;
      }
  );

/** How much of the outer Prompt the readings are known to describe. */
export interface UsageCoverage {
  readonly finalReport: "received" | "unavailable";
  readonly outerPrompt: "verified" | "partial" | "unknown";
  readonly limitations: readonly string[];
}

/** One turn's detached usage, as a provider reported it and a record retains it. */
export interface PromptUsage {
  readonly requestId?: string;
  readonly providerRecordId?: string;
  readonly providerMessageId?: string;
  readonly providerSessionId?: string;
  readonly provenance: UsageProvenance;
  readonly readings: readonly UsageReading[];
  readonly coverage: UsageCoverage;
}

/** Record a detached usage snapshot for the subscription that supplied this receiver. */
export type PromptUsageReporter = (usage: PromptUsage) => void;

/** A canonical turn whose stream was subscribed more than once has no one owner. */
export const USAGE_ASSOCIATION_AMBIGUOUS = "association-ambiguous";
/** An optional string failed the producing execution's disclosure checks. */
export const USAGE_FIELD_WITHHELD = "field-withheld";
/** A reported value did not read as the closed shape a record retains. */
export const USAGE_INVALID = "invalid-usage";

const TOKEN_FIELDS: readonly (keyof ReportedTokens)[] = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "cachedInputTokens",
  "cachedWriteTokens",
  "thoughtTokens",
  "reasoningOutputTokens",
  "totalTokens",
];
const SOURCES: readonly UsageReading["source"][] = [
  "response",
  "quota-total",
  "quota-model",
  "update",
];
const SCOPES: readonly UsageReading["scope"][] = [
  "main-loop",
  "last-request",
  "broader-model-work",
  "session",
  "unknown",
];
const COUNTERS = ["turn-total", "snapshot", "increment", "unknown"] as const;
const HOSTS: readonly UsageProvenance["host"][] = ["deno-source", "compiled"];
const FINAL_REPORTS: readonly UsageCoverage["finalReport"][] = ["received", "unavailable"];
const OUTER_PROMPT: readonly UsageCoverage["outerPrompt"][] = ["verified", "partial", "unknown"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function member<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

/** Every key of `value` is one of `allowed`. */
function closed(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const INVALID = Symbol("invalid usage");
type Read<T> = T | typeof INVALID;

function optionalString(value: unknown): Read<string | undefined> {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && value.length > 0 ? value : INVALID;
}

function optionalCount(value: unknown): Read<number | undefined> {
  if (value === undefined) {
    return undefined;
  }
  return isCount(value) ? value : INVALID;
}

function readBuild(value: unknown, extra: readonly string[] = []): Read<Record<string, string>> {
  if (!isRecord(value) || !closed(value, ["version", "digest", ...extra])) {
    return INVALID;
  }
  const build: Record<string, string> = {};
  for (const key of ["version", "digest", ...extra]) {
    const read = optionalString(value[key]);
    if (read === INVALID) {
      return INVALID;
    }
    if (read !== undefined) {
      build[key] = read;
    }
  }
  return build;
}

function readProvenance(value: unknown): Read<UsageProvenance> {
  if (!isRecord(value) || !closed(value, ["host", "xmd", "runtime", "adapter", "native"])) {
    return INVALID;
  }
  const host = member(HOSTS, value.host);
  const xmd = readBuild(value.xmd, ["sourceRevision"]);
  const runtime = readBuild(value.runtime);
  const adapter = readBuild(value.adapter);
  const native = value.native === undefined ? undefined : readBuild(value.native);
  if (
    host === undefined ||
    xmd === INVALID ||
    runtime === INVALID ||
    adapter === INVALID ||
    native === INVALID
  ) {
    return INVALID;
  }
  return { host, xmd, runtime, adapter, ...(native === undefined ? {} : { native }) };
}

function readTokens(value: unknown): Read<ReportedTokens | null> {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || !closed(value, TOKEN_FIELDS)) {
    return INVALID;
  }
  const tokens: Record<string, number> = {};
  for (const field of TOKEN_FIELDS) {
    const read = optionalCount(value[field]);
    if (read === INVALID) {
      return INVALID;
    }
    if (read !== undefined) {
      tokens[field] = read;
    }
  }
  return tokens;
}

function readReading(value: unknown): Read<UsageReading> {
  if (!isRecord(value)) {
    return INVALID;
  }
  const source = member(SOURCES, value.source);
  const scope = member(SCOPES, value.scope);
  const model = optionalString(value.model);
  if (source === undefined || scope === undefined || model === INVALID) {
    return INVALID;
  }
  const base = { source, scope, ...(model === undefined ? {} : { model }) };
  if (value.kind === "tokens") {
    if (!closed(value, ["source", "scope", "model", "kind", "counter", "tokens"])) {
      return INVALID;
    }
    const counter = member(COUNTERS, value.counter);
    const tokens = readTokens(value.tokens);
    if (counter === undefined || tokens === INVALID || !Object.hasOwn(value, "tokens")) {
      return INVALID;
    }
    return { ...base, kind: "tokens", counter, tokens };
  }
  if (value.kind === "context") {
    if (!closed(value, ["source", "scope", "model", "kind", "used", "size"])) {
      return INVALID;
    }
    const used = optionalCount(value.used);
    const size = optionalCount(value.size);
    if (used === INVALID || size === INVALID) {
      return INVALID;
    }
    return {
      ...base,
      kind: "context",
      ...(used === undefined ? {} : { used }),
      ...(size === undefined ? {} : { size }),
    };
  }
  if (value.kind === "cost") {
    if (!closed(value, ["source", "scope", "model", "kind", "amount", "currency"])) {
      return INVALID;
    }
    const amount = optionalCount(value.amount);
    const currency = optionalString(value.currency);
    if (amount === INVALID || currency === INVALID) {
      return INVALID;
    }
    return {
      ...base,
      kind: "cost",
      ...(amount === undefined ? {} : { amount }),
      ...(currency === undefined ? {} : { currency }),
    };
  }
  return INVALID;
}

function readCoverage(value: unknown): Read<UsageCoverage> {
  if (!isRecord(value) || !closed(value, ["finalReport", "outerPrompt", "limitations"])) {
    return INVALID;
  }
  const finalReport = member(FINAL_REPORTS, value.finalReport);
  const outerPrompt = member(OUTER_PROMPT, value.outerPrompt);
  const limitations = value.limitations;
  if (
    finalReport === undefined ||
    outerPrompt === undefined ||
    !Array.isArray(limitations) ||
    !limitations.every((limitation) => typeof limitation === "string" && limitation.length > 0)
  ) {
    return INVALID;
  }
  return { finalReport, outerPrompt, limitations: [...limitations] };
}

/**
 * One usage value read as the closed shape it describes, or nothing.
 *
 * Closed in both directions, like a permission audit: a member nothing here
 * defines refuses the whole value rather than being read past, because a reader
 * that skipped part of an account of spend would be reporting numbers it had
 * not read.
 */
export function readPromptUsage(value: unknown): PromptUsage | undefined {
  if (
    !isRecord(value) ||
    !closed(value, [
      "requestId",
      "providerRecordId",
      "providerMessageId",
      "providerSessionId",
      "provenance",
      "readings",
      "coverage",
    ])
  ) {
    return undefined;
  }
  const identities: Record<string, string> = {};
  for (const key of ["requestId", "providerRecordId", "providerMessageId", "providerSessionId"]) {
    const read = optionalString(value[key]);
    if (read === INVALID) {
      return undefined;
    }
    if (read !== undefined) {
      identities[key] = read;
    }
  }
  const provenance = readProvenance(value.provenance);
  const coverage = readCoverage(value.coverage);
  if (provenance === INVALID || coverage === INVALID || !Array.isArray(value.readings)) {
    return undefined;
  }
  const readings: UsageReading[] = [];
  for (const entry of value.readings) {
    const reading = readReading(entry);
    if (reading === INVALID) {
      return undefined;
    }
    readings.push(reading);
  }
  return { ...identities, provenance, readings, coverage };
}

/** The value as the journal writes it: a fresh copy of exactly the members it read. */
export function serializePromptUsage(usage: PromptUsage): Json {
  // Read back through the parser first, so what is written is what a reader
  // will accept and nothing a caller attached to the object comes along.
  const parsed = readPromptUsage(usage);
  if (parsed === undefined) {
    throw new Error("a Prompt usage value does not read as the shape a record retains");
  }
  return JSON.parse(JSON.stringify(parsed));
}

/**
 * The receipt a canonical turn retains when what was reported cannot be.
 *
 * Provenance is kept because it says which builds produced the turn; every
 * identity, reading and number is dropped, and the limitation says why.
 */
function unavailableUsage(provenance: UsageProvenance, limitation: string): PromptUsage {
  return {
    provenance,
    readings: [],
    coverage: { finalReport: "unavailable", outerPrompt: "unknown", limitations: [limitation] },
  };
}

/**
 * One native subscription's place to report usage.
 *
 * Created when a stream is actually subscribed, never when it is wrapped: a
 * cold stream subscribed twice starts two turns, and each turn's readings are
 * its own. The receiver is a closure over this destination alone, so a
 * provider holding it can reach no other turn's slot, and once the subscribing
 * scope has torn down the receiver records nothing.
 */
export interface PromptUsageDestination {
  readonly report: PromptUsageReporter;
  /** Stop accepting reports. Called once the subscription's own teardown has joined. */
  seal(): void;
  /** The latest report, if one arrived while the destination was open. */
  reported(): PromptUsage | undefined;
}

export function promptUsageDestination(): PromptUsageDestination {
  let open = true;
  let latest: PromptUsage | undefined;
  let invalid: UsageProvenance | undefined;
  return {
    report(usage: PromptUsage): void {
      if (!open) {
        return;
      }
      // Detached at the moment it arrives: a provider is free to keep mutating
      // whatever it built, and the record describes what was reported.
      const parsed = readPromptUsage(usage);
      if (parsed === undefined) {
        const provenance = readProvenance(Reflect.get(Object(usage), "provenance"));
        invalid = provenance === INVALID ? invalid : provenance;
        latest = undefined;
        return;
      }
      invalid = undefined;
      latest = parsed;
    },
    seal(): void {
      open = false;
    },
    reported(): PromptUsage | undefined {
      if (latest !== undefined) {
        return latest;
      }
      return invalid === undefined ? undefined : unavailableUsage(invalid, USAGE_INVALID);
    },
  };
}

/**
 * The usage one canonical consumption retains, given every subscription made
 * through the stream it consumed.
 *
 * One subscription is the turn. More than one means this stream started more
 * than one native turn, and nothing here can say which of them the record
 * describes, so the answer keeps the explicit gap rather than whichever turn
 * reported last.
 */
export function canonicalUsage(
  subscriptions: readonly PromptUsageDestination[],
): PromptUsage | undefined {
  if (subscriptions.length === 0) {
    return undefined;
  }
  if (subscriptions.length === 1) {
    return subscriptions[0].reported();
  }
  const reported = subscriptions.flatMap((subscription) => {
    const usage = subscription.reported();
    return usage === undefined ? [] : [usage];
  });
  if (reported.length === 0) {
    return undefined;
  }
  return unavailableUsage(reported[0].provenance, USAGE_ASSOCIATION_AMBIGUOUS);
}

/** A limitation is a fixed categorical name: lowercase words joined by hyphens. */
const LIMITATION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The part of a reported value this execution may retain.
 *
 * Asked by the canonical runner, under the execution that produced the turn and
 * before the record is serialized. Each optional string is checked on its own,
 * so one unsafe model name withholds that name rather than the whole account;
 * a reading whose only identity was a withheld model is dropped, because
 * keeping its numbers without the model would let it read as another view.
 * Numbers and enumerations carry nothing a host wrote. Every supplied string —
 * identities, builds, model names, currency and limitation names — is checked
 * through the producing execution's own policy binding. The journal's own gate
 * still decides whether the record is persisted.
 */
export function* retainablePromptUsage(usage: PromptUsage): Operation<PromptUsage> {
  let withheld = false;
  function* keep(value: string | undefined): Operation<string | undefined> {
    if (value === undefined) {
      return undefined;
    }
    if (yield* retainsOptionalText(value)) {
      return value;
    }
    withheld = true;
    return undefined;
  }
  function* build<T extends UsageBuild & { sourceRevision?: string }>(
    value: T,
  ): Operation<Record<string, string>> {
    const kept: Record<string, string> = {};
    for (const key of ["version", "digest", "sourceRevision"] as const) {
      const read = yield* keep(value[key]);
      if (read !== undefined) {
        kept[key] = read;
      }
    }
    return kept;
  }

  const identities: Record<string, string> = {};
  for (const key of [
    "requestId",
    "providerRecordId",
    "providerMessageId",
    "providerSessionId",
  ] as const) {
    const read = yield* keep(usage[key]);
    if (read !== undefined) {
      identities[key] = read;
    }
  }
  const provenance: UsageProvenance = {
    host: usage.provenance.host,
    xmd: yield* build(usage.provenance.xmd),
    runtime: yield* build(usage.provenance.runtime),
    adapter: yield* build(usage.provenance.adapter),
    ...(usage.provenance.native === undefined
      ? {}
      : { native: yield* build(usage.provenance.native) }),
  };
  const readings: UsageReading[] = [];
  for (const reading of usage.readings) {
    if (reading.model !== undefined) {
      const model = yield* keep(reading.model);
      if (model === undefined) {
        continue;
      }
    }
    if (reading.kind === "cost" && reading.currency !== undefined) {
      const currency = yield* keep(reading.currency);
      if (currency === undefined) {
        readings.push({
          source: reading.source,
          scope: reading.scope,
          kind: "cost",
          ...(reading.amount === undefined ? {} : { amount: reading.amount }),
        });
        continue;
      }
    }
    readings.push(reading);
  }
  // Limitations are supplied strings too, so each is selected like any other
  // and only a categorical name survives.
  const limitations: string[] = [];
  for (const limitation of usage.coverage.limitations) {
    const kept =
      LIMITATION.test(limitation) && limitation.length <= 64 ? yield* keep(limitation) : undefined;
    if (kept === undefined) {
      withheld = true;
    } else if (!limitations.includes(kept)) {
      limitations.push(kept);
    }
  }
  if (withheld && !limitations.includes(USAGE_FIELD_WITHHELD)) {
    limitations.push(USAGE_FIELD_WITHHELD);
  }
  return {
    ...identities,
    provenance,
    readings,
    coverage: { ...usage.coverage, limitations },
  };
}
