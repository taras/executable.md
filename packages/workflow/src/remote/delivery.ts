/**
 * Answering a durable wait on a run whose owner is somewhere else.
 *
 * Delivery is not execution, and being remote does not change that: nothing
 * here takes an acquisition, opens a socket, begins an execution, appends a
 * journal event or moves a run's status. What it does is retain one typed value
 * against the exact wait the run is standing at, so the next execution that
 * reaches that wait finds it.
 *
 * ## What is judged here, and what the owner judges anyway
 *
 * The owner is the authority: it resolves the wait, judges the value against
 * the schema that wait retained, and applies the selected credential gate,
 * inside the transaction that writes. Nothing this module reports is taken on
 * trust there, and no member of the retention says a value was checked.
 *
 * What happens here is the document runtime's half, and it happens first
 * because it is better at it. The schema compiler `<Elicit>` uses gives a
 * document-shaped diagnostic naming where a value went wrong; the full secret
 * scanner catches far more than the owner's floor. A value refused here never
 * reaches the owner, and a value the owner refuses was refused for a reason
 * this had no way to see.
 *
 * Both judgments must agree before anything is sent. The shared judgment is the
 * one the owner will run, so running it here as well turns a disagreement
 * between the two into a refusal on this side rather than a surprise on the
 * other.
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
  describeJudgment,
  judgeAgainstSchema,
  requireJudgeableSchema,
} from "../suspension/judgment.ts";
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

  // The judgment the owner will make, made here too. A schema the owner cannot
  // judge is refused before a value is offered against it, and a disagreement
  // between the compiler and the shared judgment stops here.
  const shared = judgeShared(waiting.value, suspensionId, value);
  if (!shared.ok) {
    return shared;
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
    answer: value,
    // The choice travels; the judgment does not. The owner applies the gate
    // this names, and a value that reached here without the choice being made
    // could not have been offered at all.
    secretDetection,
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
 * The same judgment the owner makes, made before anything is offered.
 *
 * The owner refuses a schema it cannot judge rather than retaining a value it
 * could not check, so a wait whose schema is outside the judged subset is
 * reported here — where a caller can be told what happened — instead of
 * arriving as a bare refusal from somewhere else.
 */
function judgeShared(waiting: RemoteRetainedWait, suspensionId: string, value: Json): Result<void> {
  try {
    requireJudgeableSchema(waiting.request.responseSchema);
  } catch (error) {
    return Err(
      new WorkflowAnswerDeliveryError(
        `the response schema retained for ${suspensionId} is not one an answer can be judged ` +
          `against: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const issues = judgeAgainstSchema(waiting.request.responseSchema, value);
  if (issues.length === 0) {
    return Ok();
  }
  return Err(
    new WorkflowAnswerDeliveryError(
      `the value offered to ${suspensionId} does not satisfy the response schema that wait ` +
        `retained: ${describeJudgment(issues)}.`,
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
