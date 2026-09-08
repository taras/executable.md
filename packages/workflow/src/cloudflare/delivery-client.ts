/**
 * Answering a run on a Cloudflare owner, from wherever the value came from.
 *
 * The transport is narrow on purpose: one request out, one response back, and
 * it knows nothing about runs, waits or authority. A host wires it to an
 * ordinary HTTPS request; a test wires it to the object directly. Delivery
 * never opens a socket, so there is no connection here to hold and nothing that
 * could be mistaken for an acquisition.
 *
 * Every answer is parsed before it is believed. A wait this build cannot read
 * back the way it was described is not a wait to judge a value against, and a
 * retention naming a different run or wait is an owner disagreeing with the
 * question rather than an accepted delivery.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type {
  RemoteAnswerRetained,
  RemoteAnswerRetention,
  RemoteDeliveryLink,
  RemoteRetainedWaitRecord,
} from "../remote/answer-link.ts";
import { RemoteRecordError } from "../remote/records.ts";
import { parseJsonValue, parseMembers, requireMemberNames } from "../storage/members.ts";
import { WorkflowRunNotFoundError } from "../storage/errors.ts";
import { canonicalJson } from "../storage/record.ts";
import { privateRefusal, storageFailure } from "./client.ts";
import { DELIVERY_REQUEST_BYTES } from "./delivery-plane.ts";

/**
 * One request out, one response back.
 *
 * The admission travels beside the body rather than inside it, because the
 * owner decides on the release before it decodes anything.
 */
export interface DeliveryTransport {
  send(admission: DeliveryAdmission, body: string): Operation<string>;
}

/** What a request carries outside its body. */
export interface DeliveryAdmission {
  readonly release: string;
  readonly token: string;
  readonly runId: string;
}

/** How a host supplies one delivery's admission. */
export interface DeliveryAdmissionSource {
  /** The build this deployment agreed to talk to. */
  readonly release: string;
  /** A short-lived token, minted per delivery rather than retained. */
  token(runId: string): Operation<string>;
}

/**
 * The most serialized bytes one delivery answer may carry.
 *
 * A `wait` answer carries a retained request and its response schema, which are
 * journal values, so what bounds it is what bounds a request carrying one.
 */
const ANSWER_BYTES = DELIVERY_REQUEST_BYTES + 4096;

function fail(reason: string): never {
  throw new RemoteRecordError(`the owner returned a malformed delivery answer: ${reason}`);
}

/** Reach one Cloudflare owner's delivery plane. */
export function cloudflareDeliveryLink(
  transport: DeliveryTransport,
  admission: DeliveryAdmissionSource,
): RemoteDeliveryLink {
  function* ask(runId: string, body: Record<string, unknown>): Operation<Result<unknown>> {
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).length > DELIVERY_REQUEST_BYTES) {
      return Err(storageFailure("command:too-large"));
    }
    let raw: string;
    try {
      const token = yield* admission.token(runId);
      raw = yield* transport.send({ release: admission.release, token, runId }, encoded);
    } catch {
      // Whatever the transport raised, the owner was not reached and nothing
      // was decided. What went wrong underneath is the host's to log; a public
      // error carrying it would carry an endpoint or a token with it.
      return Err(storageFailure("command:unavailable"));
    }
    if (new TextEncoder().encode(raw).length > ANSWER_BYTES) {
      return Err(storageFailure("command:too-large"));
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return Err(storageFailure("command:malformed-member"));
    }
    const answered = parseMembers(decoded, "$", (reason) => new RemoteRecordError(reason));
    const outcome = answered.get("outcome");
    if (outcome === "refused") {
      const refusal = answered.get("refusal");
      if (typeof refusal !== "string") {
        return Err(storageFailure("command:malformed-member"));
      }
      const named = privateRefusal(refusal);
      // The one category that is a fact about the run rather than a failure.
      if (named === "command:absent") {
        return Err(new WorkflowRunNotFoundError(runId));
      }
      return Err(storageFailure(named));
    }
    if (outcome !== "performed") {
      return Err(storageFailure("command:malformed-member"));
    }
    return Ok(answered.get("value"));
  }

  return {
    *wait(runId: string, suspensionId: string): Operation<Result<RemoteRetainedWaitRecord>> {
      const answered = yield* ask(runId, { operation: "wait", suspensionId });
      if (!answered.ok) {
        return answered;
      }
      try {
        return Ok(parseWait(answered.value));
      } catch (error) {
        return Err(
          error instanceof RemoteRecordError ? error : storageFailure("command:malformed-member"),
        );
      }
    },

    *retain(retention: RemoteAnswerRetention): Operation<Result<RemoteAnswerRetained>> {
      const answered = yield* ask(retention.runId, {
        operation: "retain",
        suspensionId: retention.suspensionId,
        requestEventId: retention.requestEventId,
        requestFingerprint: retention.requestFingerprint,
        // Canonically encoded here, once, so the bytes the owner retains are
        // the bytes a later commit is compared against.
        answer: canonicalJson(retention.answer),
      });
      if (!answered.ok) {
        return answered;
      }
      try {
        const retained = parseRetained(answered.value);
        if (
          retained.runId !== retention.runId ||
          retained.suspensionId !== retention.suspensionId
        ) {
          fail("a retention named a different run or wait");
        }
        return Ok(retained);
      } catch (error) {
        return Err(
          error instanceof RemoteRecordError ? error : storageFailure("command:malformed-member"),
        );
      }
    },
  };
}

function parseWait(value: unknown): RemoteRetainedWaitRecord {
  const found = parseMembers(value, "$", (reason) => new RemoteRecordError(reason));
  requireMemberNames(
    found,
    ["runId", "suspensionId", "requestEventId", "request", "responseSchema", "requestFingerprint"],
    "$",
    (reason) => new RemoteRecordError(reason),
  );
  return Object.freeze({
    runId: text(found.get("runId"), "a wait named no run"),
    suspensionId: text(found.get("suspensionId"), "a wait named no suspension"),
    requestEventId: text(found.get("requestEventId"), "a wait named no request event"),
    request: json(found.get("request"), "a wait carried a request this build cannot read"),
    responseSchema: json(
      found.get("responseSchema"),
      "a wait carried a response schema this build cannot read",
    ),
    requestFingerprint: digest(found.get("requestFingerprint")),
  });
}

function parseRetained(value: unknown): RemoteAnswerRetained {
  const found = parseMembers(value, "$", (reason) => new RemoteRecordError(reason));
  requireMemberNames(
    found,
    ["runId", "suspensionId"],
    "$",
    (reason) => new RemoteRecordError(reason),
  );
  return Object.freeze({
    runId: text(found.get("runId"), "a retention named no run"),
    suspensionId: text(found.get("suspensionId"), "a retention named no wait"),
  });
}

function text(value: unknown, reason: string): string {
  if (typeof value !== "string" || value === "") {
    return fail(reason);
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    return fail("a wait named no request fingerprint");
  }
  return value;
}

function json(value: unknown, reason: string): Json {
  return parseJsonValue(value, "$", () => new RemoteRecordError(reason));
}
