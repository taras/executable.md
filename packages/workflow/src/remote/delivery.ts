/**
 * Answering a durable wait on a run whose owner is somewhere else.
 *
 * Delivery is not execution, and being remote does not change that: nothing
 * here takes an acquisition, opens a socket, begins an execution, appends a
 * journal event or moves a run's status. What it does is retain one typed value
 * against the exact wait the run is standing at, so the next execution that
 * reaches that wait finds it.
 *
 * ## Why the value is judged here rather than at the owner
 *
 * The wait retained a response schema, and judging a value against it means
 * compiling that schema — the same compilation `<Elicit>` uses. That compiler
 * and the secret scanner beside it are the document runtime's, and the document
 * runtime is not what a run's owner is. So the shape of this exchange follows
 * the shape of the authority: the owner says what the run is waiting at, this
 * judges the offered value against exactly that, and the owner then re-reads
 * the same facts inside its own transaction before it writes anything.
 *
 * The fingerprint is what makes that safe. A value is judged against one
 * request, and the retention names the fingerprint of the request it was judged
 * against. An owner whose retained request has changed in between refuses,
 * rather than retaining a value that was judged against a schema this run no
 * longer waits on. Nothing is retained on the strength of a claim made here.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import {
  createSecretScanner,
  type Json,
  prepareElicitation,
  SecretDetectedError,
  type SecretFinding,
  validateParsed,
} from "@executablemd/core";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { SUSPENSION_ANSWER } from "../suspension/effects.ts";
import {
  parseSuspensionRequest,
  suspensionRequestFingerprint,
  type WorkflowSuspensionRequest,
} from "../suspension/api.ts";
import type { RemoteDeliveryLink, RemoteRetainedWaitRecord } from "./answer-link.ts";
import {
  parseAnswerDelivery,
  type WorkflowAnswerDelivery,
  WorkflowAnswerDeliveryError,
  type WorkflowAnswerRetention,
  WorkflowInputDelivery,
} from "../suspension/delivery.ts";
import { canonicalJson } from "../storage/record.ts";

/**
 * The wait one run is standing at, once its retained description is walked.
 *
 * Three identities travel together because a value answers all three: the wait,
 * the exact journal event its request was published as, and a fingerprint of
 * that request with its response schema. The fingerprint is what the retention
 * is held to — a run whose retained request changed is a run this value was
 * judged for and is no longer an answer to.
 */
export interface RemoteRetainedWait {
  readonly runId: string;
  readonly suspensionId: string;
  readonly requestEventId: string;
  readonly request: WorkflowSuspensionRequest;
  readonly requestFingerprint: string;
}

/**
 * Install typed answer delivery over one remote link, for the current scope.
 *
 * `{ at: "min" }` for the reason every provider here uses it: middleware at the
 * default position runs outermost, so an enclosing scope's installation would
 * be selected ahead of the one installed nearer the run.
 */
export function* installRemoteInputDelivery(link: RemoteDeliveryLink): Operation<void> {
  yield* WorkflowInputDelivery.around(
    {
      *deliver([request]) {
        return yield* deliverRemotely(link, request);
      },
    },
    { at: "min" },
  );
}

function* deliverRemotely(
  link: RemoteDeliveryLink,
  request: WorkflowAnswerDelivery,
): Operation<Result<WorkflowAnswerRetention>> {
  const checked = parseAnswerDelivery(request);
  if (!checked.ok) {
    return checked;
  }
  const { runId, suspensionId, value, secretDetection } = checked.value;

  const answered = yield* link.wait(runId, suspensionId);
  if (!answered.ok) {
    return answered;
  }
  const waiting = walkRetainedWait(answered.value, runId, suspensionId);
  if (!waiting.ok) {
    return waiting;
  }

  const judged = yield* judgeAnswer(waiting.value, suspensionId, value);
  if (!judged.ok) {
    return judged;
  }

  if (secretDetection) {
    const scanned = yield* scanDelivery(waiting.value, suspensionId, value);
    if (!scanned.ok) {
      return scanned;
    }
  }

  return yield* link.retain({
    runId,
    suspensionId,
    requestEventId: waiting.value.requestEventId,
    // What the value was judged against, named so the owner can refuse a run
    // that moved on while this was being judged.
    requestFingerprint: waiting.value.requestFingerprint,
    answer: value,
  });
}

/**
 * The wait this owner described, as a request rather than as a claim about one.
 *
 * The retained description is journal data reached through a public durable
 * operation, so a schema nothing could validate against must not become the
 * schema a value is judged by. The fingerprint is recomputed rather than
 * believed: an owner that names one and retains another would have this value
 * judged against a request it will not hold the retention to.
 */
function walkRetainedWait(
  record: RemoteRetainedWaitRecord,
  runId: string,
  suspensionId: string,
): Result<RemoteRetainedWait> {
  // The owner answered about a wait, and this is the one that was asked about.
  // An answer describing something else is an owner disagreeing with the
  // question, not a wait to judge a value against.
  if (record.runId !== runId || record.suspensionId !== suspensionId) {
    return Err(
      new WorkflowAnswerDeliveryError(
        "this run's owner answered about a different wait, so the value was not judged.",
      ),
    );
  }
  let request: WorkflowSuspensionRequest;
  try {
    request = parseSuspensionRequest({
      request: record.request,
      responseSchema: record.responseSchema,
    });
  } catch (error) {
    return Err(
      new WorkflowAnswerDeliveryError(
        `the request retained for ${suspensionId} is not one a durable wait can be answered ` +
          `for: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (suspensionRequestFingerprint(request) !== record.requestFingerprint) {
    return Err(
      new WorkflowAnswerDeliveryError(
        `this run's owner names a different request for ${suspensionId} than the one it ` +
          "returned, so the value was not judged.",
      ),
    );
  }
  return Ok({
    runId: record.runId,
    suspensionId: record.suspensionId,
    requestEventId: record.requestEventId,
    request,
    requestFingerprint: record.requestFingerprint,
  });
}

/**
 * The value, judged by the schema the wait retained.
 *
 * The same compilation `<Elicit>` uses, so what a document may receive here is
 * exactly what it may receive there. The refusal names where the value went
 * wrong and never what it held: a diagnostic that quoted a rejected value would
 * publish it in a place nothing filters.
 */
function* judgeAnswer(
  waiting: RemoteRetainedWait,
  suspensionId: string,
  value: Json,
): Operation<Result<void>> {
  let issues;
  try {
    const prepared = yield* prepareElicitation(waiting.request.responseSchema, "workflow answer");
    issues = validateParsed(prepared.validate, value);
  } catch (error) {
    return Err(
      new WorkflowAnswerDeliveryError(
        `the response schema retained for ${suspensionId} cannot judge an answer: ` +
          (error instanceof Error ? error.message : String(error)),
      ),
    );
  }
  if (issues.length === 0) {
    return Ok();
  }
  const described = issues
    .map(
      (issue) => `${issue.instancePath === "" ? "the value" : issue.instancePath} ${issue.message}`,
    )
    .join("; ");
  return Err(
    new WorkflowAnswerDeliveryError(
      `the value offered to ${suspensionId} does not satisfy the response schema that wait ` +
        `retained: ${described}.`,
    ),
  );
}

/**
 * Cross the same gate a durable event crosses, before anything is retained.
 *
 * Both framings, exactly as the local host scans them: the retained row this
 * value becomes, and the durable event a later execution would publish from it.
 * A credential that reached retained state has already leaked, and it has
 * leaked into somebody else's storage — which is a reason to scan here rather
 * than a reason not to.
 */
function* scanDelivery(
  waiting: RemoteRetainedWait,
  suspensionId: string,
  value: Json,
): Operation<Result<void>> {
  const scanner = createSecretScanner();
  const findings: SecretFinding[] = [];
  for (const content of [
    canonicalJson({
      suspensionId,
      requestEventId: waiting.requestEventId,
      requestFingerprint: waiting.requestFingerprint,
      answer: value,
    }),
    serializeDurableEvent(answerEvent(suspensionId, value)),
  ]) {
    try {
      findings.push(...(yield* scanner.scan(content)));
    } catch (error) {
      return Err(
        new WorkflowAnswerDeliveryError(
          "secret detection could not scan this answer, so it was not retained: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
    }
  }
  if (findings.length === 0) {
    return Ok();
  }
  return Err(new WorkflowAnswerDeliveryError(describeDetection(findings)));
}

/**
 * The event a resume would publish, for the scanner to read.
 *
 * Which coroutine reaches the wait is not known until an execution does, and
 * nothing delivered travels in that field — so it is left empty here.
 */
function answerEvent(suspensionId: string, value: Json): DurableEvent {
  return {
    type: "yield",
    coroutineId: "",
    description: { type: SUSPENSION_ANSWER, name: suspensionId, suspensionId },
    result: { status: "ok", value },
  };
}

/**
 * What was found, without what was matched.
 *
 * The rule and the position say enough to fix the data flow. The fingerprints
 * are keyed to a scanner that existed for this call alone, so reporting them
 * would say nothing, and the matched text is exactly what must not travel.
 */
function describeDetection(findings: readonly SecretFinding[]): string {
  const detected = new SecretDetectedError(findings);
  const where = findings
    .map((finding) => `${finding.ruleId} (${finding.messageId})`)
    .filter((description, index, all) => all.indexOf(description) === index)
    .join(", ");
  return (
    `${detected.name}: this answer was not retained because secret detection matched it: ` +
    `${where}. Neither the value nor the match is recorded. Disable detection for this ` +
    "delivery with --no-secret-detection only when the value is known not to be a credential."
  );
}
