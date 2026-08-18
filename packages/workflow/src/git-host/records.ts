/**
 * What an external Git-host effect asks for, what a provider answers, and what
 * the journal keeps.
 *
 * Every value here crosses a boundary this package does not own. A request is
 * composed from the run and the expansion and handed to a provider another
 * package installed; an observation and a completion come back from that
 * provider; a reconciliation record comes back out of the journal on the next
 * execution. None of them is this module's word by the time it is read, so each
 * one is parsed — exactly, and totally.
 *
 * Exactly: a value carrying more or fewer members than the shape declares
 * describes something other than that shape, and reading it as one would
 * silently accept whatever a provider or a later version put there. An extra
 * member holding a raw provider payload is the case that matters, because
 * accepting it would journal it.
 *
 * Totally: enumeration and property reads are the value's own to refuse. A
 * revoked proxy, a throwing getter and a hostile `ownKeys` trap all mean the
 * same thing here — this value describes nothing — and answering that is what
 * keeps an untrusted value from carrying its own text out through an exception.
 */

import { until } from "effection";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "../storage/record.ts";

/**
 * Where one external effect sits: the run it belongs to and the expansion that
 * asked for it.
 *
 * Derived by the shared operation from the host-established run and the
 * engine's own expansion, never supplied by a document or a provider. The pair
 * has equality semantics and nothing else: it names no provider, no endpoint
 * and no resource.
 */
export interface GitHostEffectIdentity {
  readonly runId: string;
  readonly expansionId: string;
}

/** What one effect asks a Git host to do, apart from where it sits. */
export interface GitHostEffectRequest {
  /** The effect-specific operation, such as a push or a pull request. */
  readonly kind: string;
  /** The filtered inputs that operation acts on. Credentials are not inputs. */
  readonly inputs: Json;
  /** What the provider looks the effect up by when no local result exists. */
  readonly naturalKey: Json;
}

/** One effect's identity together with what it asks for. */
export interface CompleteGitHostEffectRequest extends GitHostEffectRequest {
  readonly identity: GitHostEffectIdentity;
}

/**
 * What one live observation proved, from a closed set of four.
 *
 * Temporary unavailability is not here. A provider that cannot see the remote
 * has not observed absence, and offering it as a fifth state would put a word
 * meaning "unknown" where the state machine reads "nothing is there".
 */
export type GitHostObservation =
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
export interface GitHostCompletion {
  readonly observations: Json;
  readonly result: Json;
}

/** Whether the completion was already there or this attempt produced it. */
export type GitHostDecision = "adopted" | "performed";

/**
 * The complete successful record one external effect retains.
 *
 * The request is repeated inside the record on purpose. A replayed record is
 * read back and compared with the request being made now, so a retained result
 * is consumed by the effect that produced it rather than by whatever arrives at
 * the same journal position.
 */
export interface GitHostReconciliationRecord {
  readonly request: CompleteGitHostEffectRequest;
  readonly preState: Json;
  readonly observations: Json;
  readonly decision: GitHostDecision;
  readonly result: Json;
}

const IDENTITY_MEMBERS = ["runId", "expansionId"] as const;
const REQUEST_MEMBERS = ["identity", "kind", "inputs", "naturalKey"] as const;
const COMPLETION_MEMBERS = ["observations", "result"] as const;
const RECORD_MEMBERS = ["request", "preState", "observations", "decision", "result"] as const;
const ABSENT_MEMBERS = ["state", "preState"] as const;
const COMPATIBLE_MEMBERS = ["state", "preState", "observations", "result"] as const;

/**
 * The exact members this shape declares, read once each, or `undefined`.
 *
 * One guarded region around classification, enumeration and every read: all
 * three are the value's to refuse, and a refusal of any of them is the same
 * answer.
 */
function exactMembers(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
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

/**
 * A detached, deeply frozen copy of the JSON `value` describes, or `undefined`.
 *
 * A copy rather than the value itself: whatever handed it over keeps its own
 * object, and nothing it does to that object afterwards reaches the request a
 * provider is about to receive or the result the journal is about to hold.
 *
 * `undefined` is the one answer for "this is not JSON", which is why a member
 * that is literally `undefined` is rejected rather than dropped: a shape with a
 * missing member is not that shape with a hole in it.
 */
function detachJsonValue(value: unknown, ancestors: Set<object>): Json | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (ancestors.has(value)) {
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: Json[] = [];
      for (let index = 0; index < value.length; index += 1) {
        // A hole is not a member. `[1, , 3]` reads its middle element as
        // `undefined`, which JSON cannot express and this must not invent.
        if (!Object.hasOwn(value, index)) {
          return undefined;
        }
        const item = detachJsonValue(Reflect.get(value, index), ancestors);
        if (item === undefined) {
          return undefined;
        }
        items.push(item);
      }
      Object.freeze(items);
      return items;
    }
    const detached: Record<string, Json> = {};
    for (const key of Object.keys(value)) {
      const member = detachJsonValue(Reflect.get(value, key), ancestors);
      if (member === undefined) {
        return undefined;
      }
      // Defined rather than assigned: `detached[key] = …` reaches
      // `Object.prototype`'s setter for `__proto__` and drops the key on Node
      // and Bun, so a payload declaring that name would detach differently
      // depending on where it ran.
      Object.defineProperty(detached, key, {
        value: member,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(detached);
    return detached;
  } finally {
    ancestors.delete(value);
  }
}

/** The detached JSON this value describes, or `undefined` when it describes none. */
export function detachJson(value: unknown): Json | undefined {
  try {
    return detachJsonValue(value, new Set<object>());
  } catch {
    return undefined;
  }
}

/** The effect identity this value describes, or `undefined`. */
export function parseGitHostEffectIdentity(value: unknown): GitHostEffectIdentity | undefined {
  const read = exactMembers(value, IDENTITY_MEMBERS);
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

/** The complete detached request this value describes, or `undefined`. */
export function parseCompleteGitHostEffectRequest(
  value: unknown,
): CompleteGitHostEffectRequest | undefined {
  const read = exactMembers(value, REQUEST_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const identity = parseGitHostEffectIdentity(read["identity"]);
  const kind = text(read["kind"]);
  const inputs = detachJson(read["inputs"]);
  const naturalKey = detachJson(read["naturalKey"]);
  if (
    identity === undefined ||
    kind === undefined ||
    inputs === undefined ||
    naturalKey === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ identity, kind, inputs, naturalKey });
}

/** The observation this value describes, or `undefined` when it describes none. */
export function parseGitHostObservation(value: unknown): GitHostObservation | undefined {
  const state = readState(value);
  if (state === "compatible") {
    const read = exactMembers(value, COMPATIBLE_MEMBERS);
    if (read === undefined) {
      return undefined;
    }
    const preState = detachJson(read["preState"]);
    const observations = detachJson(read["observations"]);
    const result = detachJson(read["result"]);
    if (preState === undefined || observations === undefined || result === undefined) {
      return undefined;
    }
    return Object.freeze({ state, preState, observations, result });
  }
  if (state !== "absent" && state !== "conflict" && state !== "ambiguous") {
    return undefined;
  }
  const read = exactMembers(value, ABSENT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const preState = detachJson(read["preState"]);
  if (preState === undefined) {
    return undefined;
  }
  return Object.freeze({ state, preState });
}

/**
 * The word this value uses for its state, read on its own.
 *
 * The state selects which member set the value must carry exactly, so it has to
 * be read before that membership is decided — and reading it is as much the
 * value's to refuse as anything else about it.
 */
function readState(value: unknown): unknown {
  try {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    return Reflect.get(value, "state");
  } catch {
    return undefined;
  }
}

/** The completion this value describes, or `undefined` when it describes none. */
export function parseGitHostCompletion(value: unknown): GitHostCompletion | undefined {
  const read = exactMembers(value, COMPLETION_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const observations = detachJson(read["observations"]);
  const result = detachJson(read["result"]);
  if (observations === undefined || result === undefined) {
    return undefined;
  }
  return Object.freeze({ observations, result });
}

/** The reconciliation record this value describes, or `undefined`. */
export function parseGitHostReconciliationRecord(
  value: unknown,
): GitHostReconciliationRecord | undefined {
  const read = exactMembers(value, RECORD_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const request = parseCompleteGitHostEffectRequest(read["request"]);
  const preState = detachJson(read["preState"]);
  const observations = detachJson(read["observations"]);
  const decision = read["decision"];
  const result = detachJson(read["result"]);
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

/** The request as the journal holds it. */
export function completeGitHostEffectRequestJson(request: CompleteGitHostEffectRequest): Json {
  return {
    identity: { runId: request.identity.runId, expansionId: request.identity.expansionId },
    kind: request.kind,
    inputs: request.inputs,
    naturalKey: request.naturalKey,
  };
}

/** The record as the journal holds it. */
export function gitHostReconciliationRecordJson(record: GitHostReconciliationRecord): Json {
  return {
    request: completeGitHostEffectRequestJson(record.request),
    preState: record.preState,
    observations: record.observations,
    decision: record.decision,
    result: record.result,
  };
}

/** Whether two complete requests ask the same Git host for the same thing. */
export function sameGitHostEffectRequest(
  left: CompleteGitHostEffectRequest,
  right: CompleteGitHostEffectRequest,
): boolean {
  return (
    canonicalJson(completeGitHostEffectRequestJson(left)) ===
    canonicalJson(completeGitHostEffectRequestJson(right))
  );
}

/**
 * The stable name one complete request is journaled under.
 *
 * A digest of the canonical encoding, so the durable operation's own identity
 * moves when the kind, the inputs or the natural key move. Without it a changed
 * request would arrive at a matching `type` and name and consume the retained
 * result of a different question.
 *
 * The platform's `crypto`, adapted with `until`: this is shared code, and it
 * names no host.
 */
export function* gitHostRequestFingerprint(
  request: CompleteGitHostEffectRequest,
): Operation<string> {
  const encoded = new TextEncoder().encode(
    canonicalJson(completeGitHostEffectRequestJson(request)),
  );
  const digest = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
