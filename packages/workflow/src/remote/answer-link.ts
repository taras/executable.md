/**
 * What crosses a connection when a durable wait is answered.
 *
 * Types only, and deliberately a leaf. An adapter implements these, and an
 * adapter is the one place that must not reach a document runtime: judging a
 * value against a response schema needs a schema compiler and a secret scanner,
 * and neither belongs in a run's owner. So the shapes live here, where nothing
 * an adapter cannot load lives, and the judging lives beside the contract that
 * needs it.
 *
 * Nothing here is a parsed request. What a wait retained is journal data until
 * something walks it, and walking it is what `remote/delivery.ts` does before a
 * value is judged against it.
 */

import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";

/** One delivered answer, as a run's owner retains it. */
export interface RemoteRetainedAnswer {
  readonly suspensionId: string;
  readonly requestEventId: string;
  readonly requestFingerprint: string;
  readonly answer: Json;
  readonly state: "pending" | "consumed";
}

/**
 * The wait a run is standing at, as its owner retains it.
 *
 * `request` and `responseSchema` are exactly what the retained description
 * held. The fingerprint is the owner's own, over that description, and is what
 * a retention is later held to — so a runner that derives a different one from
 * the same bytes has found a disagreement rather than a wait.
 */
export interface RemoteRetainedWaitRecord {
  readonly runId: string;
  readonly suspensionId: string;
  readonly requestEventId: string;
  readonly request: Json;
  readonly responseSchema: Json;
  readonly requestFingerprint: string;
}

/**
 * One value offered to a wait, for its owner to judge and retain.
 *
 * It carries the value and the gate decision and nothing else. There is
 * deliberately no request identity and no claim that anything was checked: the
 * owner resolves the wait it is answering, judges the value against the schema
 * that wait retained, and applies the selected gate, all where the write
 * happens. A member saying "already validated" would be a caller deciding what
 * it is allowed to store.
 */
export interface RemoteAnswerRetention {
  readonly runId: string;
  readonly suspensionId: string;
  readonly answer: Json;
  /** Whether the owner applies the credential gate before retaining. */
  readonly secretDetection: boolean;
}

/** What one accepted delivery left behind. */
export interface RemoteAnswerRetained {
  readonly runId: string;
  readonly suspensionId: string;
}

/**
 * Reaching a run's owner to answer it, and nothing else.
 *
 * Two operations, both about one wait. There is no acquisition to take, no
 * lifecycle to move and no journal to append: an implementation offering any of
 * those would be an executor plane wearing this one's name.
 */
export interface RemoteDeliveryLink {
  /** What this run is waiting at, or why it is not waiting at that. */
  wait(runId: string, suspensionId: string): Operation<Result<RemoteRetainedWaitRecord>>;
  /** Retain one judged value, or say why this run will not. */
  retain(retention: RemoteAnswerRetention): Operation<Result<RemoteAnswerRetained>>;
}
