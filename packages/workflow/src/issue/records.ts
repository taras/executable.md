/**
 * What one `<Issue>` asks for, and what its reconciliation retains.
 *
 * An issue belongs to a service this repository's SQLite transaction cannot
 * enclose, so what travels through the boundary is JSON a provider in another
 * package receives and a journal in this one keeps. None of it is this module's
 * word by the time it is read back, so every value is parsed exactly.
 *
 * ## The resource is the position, not the text
 *
 * The natural key is the container, the run and the expansion:
 *
 * ```text
 * { canonicalTargetUrl, runId, expansionId }
 * ```
 *
 * Title is never identity. Two runs of one workflow are two obligations to file
 * unless workflow policy deliberately reuses retained history, and a document
 * that edits its own title between attempts is still asking about the issue its
 * position already created. What the complete request fingerprint covers — the
 * resolved provider, the canonical target, the title, the description, the
 * normalized tags and the assignee — is what makes a *changed request* diverge
 * at the durable position rather than consume the result retained for another
 * question.
 *
 * ## Tags are a set
 *
 * Deduplicated and sorted by code point, because tag order is not issue
 * identity and a document that reordered its list would otherwise ask a
 * different question. Sorting by code point rather than by the default
 * comparison is deliberate: the default compares UTF-16 code units, which
 * orders supplementary characters before ones in the private-use area, and a
 * durable identity should not depend on which encoding a comparison happened to
 * walk.
 *
 * ## Absence has one spelling
 *
 * An absent assignee is `null` from the moment the component reads its props,
 * in the request, in every observation and in the retained record. `undefined`
 * is not a JSON value, and a member that is sometimes missing is a second shape
 * rather than a value.
 */

import { until, type Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "../storage/record.ts";

/**
 * Where one Issue effect sits: the run it belongs to and the expansion that
 * asked for it.
 *
 * Derived by the shared operation from the host-established run and the
 * engine's own expansion, never supplied by a document, a context, middleware
 * or a provider. The pair has equality semantics and nothing else.
 */
export interface IssueEffectIdentity {
  readonly runId: string;
  readonly expansionId: string;
}

/** What one `<Issue>` invocation asks for, filtered to what durable JSON holds. */
export interface IssueInputs {
  readonly title: string;
  readonly description: string;
  /** Deduplicated and code-point sorted. Empty is `[]`, never absent. */
  readonly tags: readonly string[];
  /** The opaque provider account identifier, or `null` for none. */
  readonly assignee: string | null;
}

/** What the provider looks one issue up by when no local result exists. */
export interface IssueNaturalKey {
  readonly canonicalTargetUrl: string;
  readonly runId: string;
  readonly expansionId: string;
}

/** One effect's identity, its destination and what it asks for. */
export interface CompleteIssueRequest {
  readonly identity: IssueEffectIdentity;
  /** The resolved discriminator. Only a provider registered under it may act. */
  readonly provider: string;
  /** The canonical container URL. */
  readonly target: string;
  readonly inputs: Json;
  readonly naturalKey: Json;
}

/**
 * What one live observation proved, from a closed set of four.
 *
 * Temporary unavailability is not here. A provider that cannot see its service
 * has not observed absence, and offering it as a fifth state would put a word
 * meaning "unknown" where the state machine reads "nothing is there".
 */
export type IssueObservation =
  | { readonly state: "absent"; readonly preState: Json }
  | {
      readonly state: "compatible";
      readonly preState: Json;
      readonly observations: Json;
      readonly result: Json;
    }
  | { readonly state: "conflict"; readonly preState: Json }
  | { readonly state: "ambiguous"; readonly preState: Json };

/** What performing proved afterwards, and what it produced. */
export interface IssueCompletion {
  readonly observations: Json;
  readonly result: Json;
}

/** Whether the completion was already there or this attempt produced it. */
export type IssueDecision = "adopted" | "performed";

/**
 * The complete successful record one Issue effect retains.
 *
 * The request is repeated inside the record on purpose. A replayed record is
 * read back and compared with the request being made now, so a retained result
 * is consumed by the effect that produced it rather than by whatever arrives at
 * the same journal position.
 */
export interface IssueReconciliationRecord {
  readonly request: CompleteIssueRequest;
  readonly preState: Json;
  readonly observations: Json;
  readonly decision: IssueDecision;
  readonly result: Json;
}

/** One open issue, normalized away from whatever a provider calls it. */
export interface IssueSnapshot {
  /** The provider's own stable identity for this issue. */
  readonly providerId: string;
  readonly url: string;
  readonly state: "open";
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly assignee: string | null;
}

/**
 * What the provider held for this resource before this attempt.
 *
 * `null` only where nothing was there. An issue about to be updated has a
 * pre-state, and that is what makes a performed update describable at all.
 */
export interface IssuePreState {
  readonly issue: IssueSnapshot | null;
}

/** The issue this effect finished at, observed after everything it did. */
export interface IssueObservations {
  readonly issue: IssueSnapshot;
}

/**
 * What a reconciled issue retains.
 *
 * More than the document binds. The provider, the canonical target and the
 * provider's own identity are what make a retained record checkable against the
 * request that produced it; the public `as` value is the URL alone.
 */
export interface IssueRecordResult {
  readonly provider: string;
  readonly target: string;
  readonly providerId: string;
  readonly url: string;
}

/** One reconciled issue: what the engine decided, and what it retains. */
export interface IssueOutcome {
  readonly decision: IssueDecision;
  readonly result: IssueRecordResult;
}

const IDENTITY_MEMBERS = ["runId", "expansionId"] as const;
const REQUEST_MEMBERS = ["identity", "provider", "target", "inputs", "naturalKey"] as const;
const INPUT_MEMBERS = ["title", "description", "tags", "assignee"] as const;
const KEY_MEMBERS = ["canonicalTargetUrl", "runId", "expansionId"] as const;
const SNAPSHOT_MEMBERS = [
  "providerId",
  "url",
  "state",
  "title",
  "description",
  "tags",
  "assignee",
] as const;
const PRE_STATE_MEMBERS = ["issue"] as const;
const OBSERVATION_MEMBERS = ["issue"] as const;
const RESULT_MEMBERS = ["provider", "target", "providerId", "url"] as const;
const COMPLETION_MEMBERS = ["observations", "result"] as const;
const RECORD_MEMBERS = ["request", "preState", "observations", "decision", "result"] as const;
const ABSENT_MEMBERS = ["state", "preState"] as const;
const COMPATIBLE_MEMBERS = ["state", "preState", "observations", "result"] as const;

/** The one state an issue this effect settles on is in. */
export const OPEN = "open";

/**
 * The exact members this shape declares, read once each, or `undefined`.
 *
 * One guarded region around classification, enumeration and every read: all
 * three are the value's to refuse, and a refusal of any of them is the same
 * answer.
 */
function members(value: unknown, expected: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const keys = Object.keys(value);
    if (keys.length !== expected.length) {
      return undefined;
    }
    if (!expected.every((member) => Object.hasOwn(value, member))) {
      return undefined;
    }
    const read: Record<string, unknown> = Object.create(null);
    for (const member of expected) {
      read[member] = Reflect.get(value, member);
    }
    return read;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Text that may be empty and may not be absent. */
function anyText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The assignee this value names, `null` for none, or `undefined` for neither. */
function assigneeOf(value: unknown): string | null | undefined {
  return value === null ? null : text(value);
}

/** One string's code points, so ordering does not depend on the encoding. */
function codePoints(value: string): number[] {
  const points: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0);
    points.push(point === undefined ? 0 : point);
  }
  return points;
}

/** Two strings ordered by code point. */
export function byCodePoint(left: string, right: string): number {
  const first = codePoints(left);
  const second = codePoints(right);
  const shared = Math.min(first.length, second.length);
  for (let index = 0; index < shared; index += 1) {
    const one = first[index] ?? 0;
    const two = second[index] ?? 0;
    if (one !== two) {
      return one < two ? -1 : 1;
    }
  }
  if (first.length === second.length) {
    return 0;
  }
  return first.length < second.length ? -1 : 1;
}

/**
 * The tags this value describes as a set, or `undefined` when it is not one.
 *
 * Every member is a non-empty string, duplicates are removed and the result is
 * ordered by code point. A value that is not an array of strings names no tag
 * set, and reading one as empty would file an issue the document did not ask
 * for.
 */
export function normalizedTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const unique = new Set<string>();
  for (const entry of value) {
    const tag = text(entry);
    if (tag === undefined) {
      return undefined;
    }
    unique.add(tag);
  }
  return Object.freeze([...unique].sort(byCodePoint));
}

export function issueInputsJson(inputs: IssueInputs): Json {
  return {
    title: inputs.title,
    description: inputs.description,
    tags: [...inputs.tags],
    assignee: inputs.assignee,
  };
}

export function issueNaturalKeyJson(key: IssueNaturalKey): Json {
  return {
    canonicalTargetUrl: key.canonicalTargetUrl,
    runId: key.runId,
    expansionId: key.expansionId,
  };
}

export function issueSnapshotJson(snapshot: IssueSnapshot): Json {
  return {
    providerId: snapshot.providerId,
    url: snapshot.url,
    state: snapshot.state,
    title: snapshot.title,
    description: snapshot.description,
    tags: [...snapshot.tags],
    assignee: snapshot.assignee,
  };
}

export function issuePreStateJson(preState: IssuePreState): Json {
  return { issue: preState.issue === null ? null : issueSnapshotJson(preState.issue) };
}

export function issueObservationsJson(observations: IssueObservations): Json {
  return { issue: issueSnapshotJson(observations.issue) };
}

export function issueRecordResultJson(result: IssueRecordResult): Json {
  return {
    provider: result.provider,
    target: result.target,
    providerId: result.providerId,
    url: result.url,
  };
}

export function completeIssueRequestJson(request: CompleteIssueRequest): Json {
  return {
    identity: { runId: request.identity.runId, expansionId: request.identity.expansionId },
    provider: request.provider,
    target: request.target,
    inputs: request.inputs,
    naturalKey: request.naturalKey,
  };
}

export function issueReconciliationRecordJson(record: IssueReconciliationRecord): Json {
  return {
    request: completeIssueRequestJson(record.request),
    preState: record.preState,
    observations: record.observations,
    decision: record.decision,
    result: record.result,
  };
}

/** The natural key one request at this identity and target describes. */
export function issueNaturalKey(identity: IssueEffectIdentity, target: string): IssueNaturalKey {
  return Object.freeze({
    canonicalTargetUrl: target,
    runId: identity.runId,
    expansionId: identity.expansionId,
  });
}

/** The public result one settled issue produces: the URL, and nothing else. */
export function issueResultJson(result: IssueRecordResult): Json {
  return { url: result.url };
}

/**
 * The detached JSON this value describes, or `undefined`.
 *
 * The same total walk the Git-host boundary uses. A frozen copy is what travels
 * to a provider and into the journal, so nothing a caller keeps a reference to
 * can change after it has been described.
 */
export function detachIssueJson(value: unknown): Json | undefined {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(encoded);
    return freezeJson(parsed);
  } catch {
    return undefined;
  }
}

function freezeJson(value: unknown): Json | undefined {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const entries: Json[] = [];
    for (const entry of value) {
      const frozen = freezeJson(entry);
      if (frozen === undefined) {
        return undefined;
      }
      entries.push(frozen);
    }
    Object.freeze(entries);
    return entries;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const object: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    const frozen = freezeJson(entry);
    if (frozen === undefined) {
      return undefined;
    }
    object[key] = frozen;
  }
  Object.freeze(object);
  return object;
}

export function parseIssueEffectIdentity(value: unknown): IssueEffectIdentity | undefined {
  const read = members(value, IDENTITY_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const runId = text(read["runId"]);
  const expansionId = text(read["expansionId"]);
  if (runId === undefined || expansionId === undefined) {
    return undefined;
  }
  return Object.freeze({ runId, expansionId });
}

export function parseCompleteIssueRequest(value: unknown): CompleteIssueRequest | undefined {
  const read = members(value, REQUEST_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const identity = parseIssueEffectIdentity(read["identity"]);
  const provider = text(read["provider"]);
  const target = text(read["target"]);
  const inputs = detachIssueJson(read["inputs"]);
  const naturalKey = detachIssueJson(read["naturalKey"]);
  if (
    identity === undefined ||
    provider === undefined ||
    target === undefined ||
    inputs === undefined ||
    naturalKey === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ identity, provider, target, inputs, naturalKey });
}

/** The issue inputs this value describes, or `undefined`. */
export function parseIssueInputs(value: unknown): IssueInputs | undefined {
  const read = members(value, INPUT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const title = text(read["title"]);
  const description = text(read["description"]);
  const assignee = assigneeOf(read["assignee"]);
  const tags = Array.isArray(read["tags"]) ? normalizedTags(read["tags"]) : undefined;
  if (
    title === undefined ||
    description === undefined ||
    assignee === undefined ||
    tags === undefined
  ) {
    return undefined;
  }
  // Read back as a set: a retained value whose tags are out of order or
  // repeated is not one this boundary wrote, and reading it as though it were
  // would let two spellings of one request answer for each other.
  const written = read["tags"];
  if (!Array.isArray(written) || written.length !== tags.length) {
    return undefined;
  }
  for (const [index, tag] of tags.entries()) {
    if (written[index] !== tag) {
      return undefined;
    }
  }
  return Object.freeze({ title, description, tags, assignee });
}

/** The natural key this value describes, or `undefined`. */
export function parseIssueNaturalKey(value: unknown): IssueNaturalKey | undefined {
  const read = members(value, KEY_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const canonicalTargetUrl = text(read["canonicalTargetUrl"]);
  const runId = text(read["runId"]);
  const expansionId = text(read["expansionId"]);
  if (canonicalTargetUrl === undefined || runId === undefined || expansionId === undefined) {
    return undefined;
  }
  return Object.freeze({ canonicalTargetUrl, runId, expansionId });
}

/** Whether two natural keys name the same resource. */
export function sameIssueNaturalKey(left: IssueNaturalKey, right: IssueNaturalKey): boolean {
  return (
    left.canonicalTargetUrl === right.canonicalTargetUrl &&
    left.runId === right.runId &&
    left.expansionId === right.expansionId
  );
}

/** The issue snapshot this value describes, or `undefined`. */
export function parseIssueSnapshot(value: unknown): IssueSnapshot | undefined {
  const read = members(value, SNAPSHOT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const providerId = text(read["providerId"]);
  const url = text(read["url"]);
  const title = text(read["title"]);
  const description = anyText(read["description"]);
  const assignee = assigneeOf(read["assignee"]);
  const tags = Array.isArray(read["tags"]) ? normalizedTags(read["tags"]) : undefined;
  if (
    providerId === undefined ||
    url === undefined ||
    read["state"] !== OPEN ||
    title === undefined ||
    description === undefined ||
    assignee === undefined ||
    tags === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ providerId, url, state: OPEN, title, description, tags, assignee });
}

export function parseIssuePreState(value: unknown): IssuePreState | undefined {
  const read = members(value, PRE_STATE_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  if (read["issue"] === null) {
    return Object.freeze({ issue: null });
  }
  const issue = parseIssueSnapshot(read["issue"]);
  return issue === undefined ? undefined : Object.freeze({ issue });
}

export function parseIssueObservations(value: unknown): IssueObservations | undefined {
  const read = members(value, OBSERVATION_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const issue = parseIssueSnapshot(read["issue"]);
  return issue === undefined ? undefined : Object.freeze({ issue });
}

/** The retained result this value describes for this request, or `undefined`. */
export function parseIssueRecordResult(
  value: unknown,
  expected: { readonly provider: string; readonly target: string },
): IssueRecordResult | undefined {
  const read = members(value, RESULT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const provider = text(read["provider"]);
  const target = text(read["target"]);
  const providerId = text(read["providerId"]);
  const url = text(read["url"]);
  if (
    provider === undefined ||
    target === undefined ||
    providerId === undefined ||
    url === undefined
  ) {
    return undefined;
  }
  if (provider !== expected.provider || target !== expected.target) {
    return undefined;
  }
  return Object.freeze({ provider, target, providerId, url });
}

/** The word this value uses for its state, read on its own. */
function readState(value: unknown): unknown {
  try {
    return typeof value === "object" && value !== null ? Reflect.get(value, "state") : undefined;
  } catch {
    return undefined;
  }
}

export function parseIssueObservation(value: unknown): IssueObservation | undefined {
  const state = readState(value);
  if (state === "compatible") {
    const read = members(value, COMPATIBLE_MEMBERS);
    if (read === undefined) {
      return undefined;
    }
    const preState = detachIssueJson(read["preState"]);
    const observations = detachIssueJson(read["observations"]);
    const result = detachIssueJson(read["result"]);
    if (preState === undefined || observations === undefined || result === undefined) {
      return undefined;
    }
    return Object.freeze({ state, preState, observations, result });
  }
  if (state !== "absent" && state !== "conflict" && state !== "ambiguous") {
    return undefined;
  }
  const read = members(value, ABSENT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const preState = detachIssueJson(read["preState"]);
  if (preState === undefined) {
    return undefined;
  }
  return Object.freeze({ state, preState });
}

export function parseIssueCompletion(value: unknown): IssueCompletion | undefined {
  const read = members(value, COMPLETION_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const observations = detachIssueJson(read["observations"]);
  const result = detachIssueJson(read["result"]);
  if (observations === undefined || result === undefined) {
    return undefined;
  }
  return Object.freeze({ observations, result });
}

export function parseIssueReconciliationRecord(
  value: unknown,
): IssueReconciliationRecord | undefined {
  const read = members(value, RECORD_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const request = parseCompleteIssueRequest(read["request"]);
  const preState = detachIssueJson(read["preState"]);
  const observations = detachIssueJson(read["observations"]);
  const decision = read["decision"];
  const result = detachIssueJson(read["result"]);
  if (
    request === undefined ||
    preState === undefined ||
    observations === undefined ||
    result === undefined ||
    (decision !== "adopted" && decision !== "performed")
  ) {
    return undefined;
  }
  return Object.freeze({ request, preState, observations, decision, result });
}

/** Whether two complete requests ask the same provider for the same thing. */
export function sameIssueRequest(left: CompleteIssueRequest, right: CompleteIssueRequest): boolean {
  return (
    canonicalJson(completeIssueRequestJson(left)) === canonicalJson(completeIssueRequestJson(right))
  );
}

/** Whether this issue is the one these inputs ask for. */
export function issueAgrees(snapshot: IssueSnapshot, inputs: IssueInputs): boolean {
  return (
    snapshot.state === OPEN &&
    snapshot.title === inputs.title &&
    snapshot.description === inputs.description &&
    snapshot.assignee === inputs.assignee &&
    snapshot.tags.length === inputs.tags.length &&
    snapshot.tags.every((tag, index) => tag === inputs.tags[index])
  );
}

/** Whether an issue about to be updated is the one that was updated. */
export function sameIssueIdentity(before: IssueSnapshot, after: IssueSnapshot): boolean {
  return before.providerId === after.providerId && before.url === after.url;
}

/**
 * The stable name one complete request is journaled under.
 *
 * A digest of the canonical encoding, so the durable operation's own identity
 * moves when the provider, the target, the inputs or the natural key move.
 * Without it a changed request would arrive at a matching type and name and
 * consume the retained result of a different question.
 */
export function* issueRequestFingerprint(request: CompleteIssueRequest): Operation<string> {
  const encoded = new TextEncoder().encode(canonicalJson(completeIssueRequestJson(request)));
  const digest = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
