/**
 * Answering a run's owner without taking the run.
 *
 * A third plane, and it is a third plane for the same reason the read plane is
 * a second one: what it does cannot be done over the executor socket. A run
 * that is waiting has no executor, and it must be answerable while another
 * executor is live — so this accepts no socket, mints no acquisition, and
 * cannot move a lifecycle. What separates it from the read plane is that it
 * writes exactly one row, in one transaction, and nothing else.
 *
 * It writes no journal event, no execution row, no status, no root, no mapping
 * and no acquisition state. What a delivery leaves behind is a pending answer
 * correlated to the wait it answers, which the next acquired execution to reach
 * that wait spends.
 *
 * What crosses is closed and private to this release, and there is exactly one
 * operation that writes. It carries a value and a gate decision and nothing
 * else: no request identity, no fingerprint, no claim that anything was
 * checked. The owner resolves the wait itself, judges the value against the
 * schema that wait retained, applies the gate the request selected, and only
 * then writes — inside one transaction, having read every one of those facts
 * again. There is no lower operation to select instead.
 */

import { parseMembers, requireMemberNames } from "../storage/members.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { canonicalJson } from "../storage/record.ts";
import { CommandError } from "./commands.ts";
import { READ_PAGE_BYTES, READ_REQUEST_ENVELOPE } from "./read-plane.ts";
import { fingerprintOf, readRetainedWait, retainAnswer } from "./owner-answers.ts";
import type { OwnerStorage } from "./storage.ts";

/** What a delivery answered, or why it would not. */
export type DeliveryAnswer =
  | { readonly outcome: "performed"; readonly value: unknown }
  | { readonly outcome: "refused"; readonly refusal: string };

/** The most characters one wait's identifier may carry. */
const MAX_SUSPENSION_ID = 256;

/**
 * The most serialized bytes one delivery request may carry.
 *
 * Derived rather than picked. A retained answer is a value this owner will hand
 * back through the read plane once it is an event, so what bounds it is what
 * one page of that plane may carry; the envelope around it — a wait, an event
 * id, a fingerprint and the punctuation between them — is the same fixed
 * envelope a read request carries.
 */
export const DELIVERY_REQUEST_BYTES = READ_PAGE_BYTES + READ_REQUEST_ENVELOPE;

/** What a caller may ask this plane for. */
export type DeliveryOperation =
  | { readonly operation: "wait"; readonly suspensionId: string }
  | {
      readonly operation: "deliver";
      readonly suspensionId: string;
      /** The canonical encoding of the value being offered. */
      readonly answer: string;
      /**
       * Whether this value crosses the credential gate before it is retained.
       *
       * Required, with no default, because the choice is the caller's and
       * omitting it must not be a way of making it. `false` is the documented
       * opt-out and is the only way past the gate.
       */
      readonly secretDetection: boolean;
    };

function failure(reason: string, path: string): Error {
  return new WorkflowRecordMalformedError("workflow delivery request", `${reason} at ${path}`);
}

/**
 * The whole request, parsed as a closed shape before any member is read.
 *
 * Nothing here reaches storage. A request that is not one of the two shapes
 * this plane implements is refused as malformed, before a run is recognized,
 * before a wait is read, and before anything could be written.
 */
export function parseDeliveryOperation(raw: string): DeliveryOperation {
  if (new TextEncoder().encode(raw).length > DELIVERY_REQUEST_BYTES) {
    throw failure("expected a bounded request", "$");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw failure("expected one JSON object", "$");
  }
  const read = parseMembers(decoded, "$", failure);
  const operation = read.get("operation");

  if (operation === "wait") {
    requireMemberNames(read, ["operation", "suspensionId"], "$", failure);
    return { operation, suspensionId: identifier(read.get("suspensionId"), "$.suspensionId") };
  }
  if (operation === "deliver") {
    requireMemberNames(
      read,
      ["operation", "suspensionId", "answer", "secretDetection"],
      "$",
      failure,
    );
    const secretDetection = read.get("secretDetection");
    if (typeof secretDetection !== "boolean") {
      throw failure("expected a secret-gate decision", "$.secretDetection");
    }
    const answer = read.get("answer");
    if (typeof answer !== "string" || answer === "") {
      throw failure("expected the canonical encoding of one value", "$.answer");
    }
    // Held to the same rules the journal holds a value to, and to the exact
    // canonical spelling: two encodings of one value would be two answers, and
    // the row is compared as text when a lost response is delivered again.
    let value: unknown;
    try {
      value = JSON.parse(answer);
    } catch {
      throw failure("expected the canonical encoding of one value", "$.answer");
    }
    if (canonicalJson(readValue(value)) !== answer) {
      throw failure("expected the canonical encoding of one value", "$.answer");
    }
    return {
      operation,
      suspensionId: identifier(read.get("suspensionId"), "$.suspensionId"),
      answer,
      secretDetection,
    };
  }
  throw failure("expected an operation this owner implements", "$.operation");
}

/**
 * Answer one delivery request.
 *
 * `wait` reads and writes nothing. `retain` runs inside the caller's own owner
 * transaction, which is where every fact it depends on is read again.
 */
export function answerDelivery(
  storage: OwnerStorage,
  runId: string,
  request: DeliveryOperation,
  now: string,
): Record<string, unknown> {
  if (request.operation === "wait") {
    const waiting = readRetainedWait(storage, runId, request.suspensionId);
    return {
      runId: waiting.runId,
      suspensionId: waiting.suspensionId,
      requestEventId: waiting.requestEventId,
      request: waiting.request,
      responseSchema: waiting.responseSchema,
      requestFingerprint: fingerprintOf(waiting),
    };
  }
  return retainAnswer(
    storage,
    runId,
    {
      suspensionId: request.suspensionId,
      answer: request.answer,
      secretDetection: request.secretDetection,
    },
    now,
  );
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw failure("expected a non-empty identifier", path);
  }
  if (value.length > MAX_SUSPENSION_ID) {
    throw failure("expected a bounded identifier", path);
  }
  return value;
}

/** One offered value, held to the JSON rules a retained value is held to. */
function readValue(value: unknown): Parameters<typeof canonicalJson>[0] {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CommandError("malformed-member");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => readValue(entry));
  }
  if (typeof value === "object") {
    const held: Record<string, Parameters<typeof canonicalJson>[0]> = {};
    for (const [name, member] of Object.entries(value)) {
      held[name] = readValue(member);
    }
    return held;
  }
  throw new CommandError("malformed-member");
}
