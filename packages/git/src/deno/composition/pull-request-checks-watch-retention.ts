/**
 * What one checks watch retains, so an unfinished one continues honestly
 * (specs/workflow-workspace-spec.md §7.7.1).
 *
 * Three effects, in order. The deadline is retained before the first read, so a
 * continued watch keeps the caller's original wall-clock budget rather than
 * starting a new one. The pinned head is retained once a collection names it, so
 * a continued watch reports on the revision it started watching. The result is
 * retained last, once the polling and every session it opened have finished.
 *
 * Polling happens inside the bodies of the second and third effects and nowhere
 * else, which is what keeps it live: a body runs only when its effect has not
 * been retained, so a completed watch restores its result without a read, a
 * sleep or a line of progress, and an unfinished one polls again from the
 * checkpoint it reached. The intermediate collections are never retained.
 *
 * Like an evidence read, the caller has already decided who the watch belongs
 * to: the request carries the owner and site, and this module obtains neither.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { EffectDescription, Json as DurableJson } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";
import { isJsonObject, JsonParseError, parseJson, sourceDescription } from "@executablemd/core";
import type { JsonObject, SourcePosition } from "@executablemd/core";
import { PullRequestReadError } from "../../composition/errors.ts";
import {
  checkWatchResultJson,
  checkWatchState,
  parseCheckWatchResult,
  pinCheckHead,
  PullRequestWatchClock,
  settleChecks,
} from "../../composition/pull-request-checks-watch.ts";
import type {
  CheckWatchProgress,
  CheckWatchReads,
  CheckWatchResult,
} from "../../composition/pull-request-checks-watch.ts";
import {
  canonicalPullRequestUrl,
  pullRequestProviderName,
} from "../../composition/pull-request-target.ts";
import { gitOperationFingerprint } from "./operations.ts";
import { joinedReadCoordinator } from "./pull-request-read-retention.ts";

/** When the watch's budget ends. */
export const PULL_REQUEST_CHECKS_WATCH_DEADLINE = "pull_request_checks_watch_deadline";

/** The head the watch pinned, or that it pinned none before the budget ended. */
export const PULL_REQUEST_CHECKS_WATCH_HEAD = "pull_request_checks_watch_head";

/** The result the watch settled with. */
export const PULL_REQUEST_CHECKS_WATCH_RESULT = "pull_request_checks_watch_result";

/** The three effect types one watch retains, in the order it retains them. */
export const PULL_REQUEST_CHECKS_WATCH_EFFECTS: readonly string[] = [
  PULL_REQUEST_CHECKS_WATCH_DEADLINE,
  PULL_REQUEST_CHECKS_WATCH_HEAD,
  PULL_REQUEST_CHECKS_WATCH_RESULT,
];

const ELEMENT = "<PullRequest.Checks>";

/** The complete question one watch asks, and whose it is. */
export interface PullRequestChecksWatchRequest {
  readonly operation: "watch";
  readonly url: string;
  readonly provider: string | null;
  readonly timeoutSeconds: number | null;
  readonly runId: string;
  readonly expansionId: string;
}

export function checksWatchRequest(
  url: string,
  provider: string | undefined,
  timeoutSeconds: number | undefined,
  runId: string,
  expansionId: string,
): PullRequestChecksWatchRequest {
  return Object.freeze({
    operation: "watch" as const,
    url,
    provider: provider ?? null,
    timeoutSeconds: timeoutSeconds ?? null,
    runId,
    expansionId,
  });
}

function checksWatchRequestJson(request: PullRequestChecksWatchRequest): JsonObject {
  return {
    operation: request.operation,
    url: request.url,
    provider: request.provider,
    timeoutSeconds: request.timeoutSeconds,
    runId: request.runId,
    expansionId: request.expansionId,
  };
}

/** The complete question a retained watch states, or `undefined`. */
export function parseChecksWatchRequest(
  received: unknown,
): PullRequestChecksWatchRequest | undefined {
  const value = jsonObject(received);
  if (value === undefined) {
    return undefined;
  }
  const names = ["operation", "url", "provider", "timeoutSeconds", "runId", "expansionId"];
  const present = Object.keys(value);
  if (present.length !== names.length || !names.every((name) => present.includes(name))) {
    return undefined;
  }
  const { operation, url, provider, timeoutSeconds, runId, expansionId } = value;
  if (operation !== "watch" || typeof url !== "string" || canonicalPullRequestUrl(url) !== url) {
    return undefined;
  }
  if (
    provider !== null &&
    (typeof provider !== "string" || pullRequestProviderName(provider) !== provider)
  ) {
    return undefined;
  }
  if (
    timeoutSeconds !== null &&
    (typeof timeoutSeconds !== "number" ||
      !Number.isSafeInteger(timeoutSeconds) ||
      timeoutSeconds < 1)
  ) {
    return undefined;
  }
  if (
    typeof runId !== "string" ||
    runId === "" ||
    typeof expansionId !== "string" ||
    expansionId === ""
  ) {
    return undefined;
  }
  return checksWatchRequest(
    url,
    provider ?? undefined,
    timeoutSeconds ?? undefined,
    runId,
    expansionId,
  );
}

/**
 * The fingerprint one question produces.
 *
 * The owner and site are outside it for the reason an evidence read keeps them
 * out; the budget is inside it, because a different budget is a different
 * question.
 */
export function checksWatchConfiguration(request: PullRequestChecksWatchRequest): string {
  return gitOperationFingerprint([
    request.operation,
    request.url,
    request.provider,
    request.timeoutSeconds === null ? null : String(request.timeoutSeconds),
  ]);
}

function describe(
  type: string,
  request: PullRequestChecksWatchRequest,
  position: Readonly<SourcePosition> | undefined,
): EffectDescription {
  const configuration = checksWatchConfiguration(request);
  return {
    type,
    name: `${request.expansionId}:${configuration}`,
    input: checksWatchRequestJson(request),
    configuration,
    ...sourceDescription(position),
  };
}

/** The retained deadline, read back. */
export function parseChecksWatchDeadline(
  received: unknown,
  timeoutSeconds: number | null,
): bigint | null | undefined {
  const value = jsonObject(received);
  if (value === undefined || Object.keys(value).length !== 1) {
    return undefined;
  }
  const deadline = value.deadline;
  if (timeoutSeconds === null) {
    return deadline === null ? null : undefined;
  }
  if (typeof deadline === "number" && Number.isSafeInteger(deadline)) {
    return BigInt(deadline);
  }
  if (typeof deadline === "string" && /^[1-9][0-9]*$/.test(deadline)) {
    const exact = BigInt(deadline);
    if (exact > BigInt(Number.MAX_SAFE_INTEGER)) {
      return exact;
    }
  }
  return undefined;
}

/** What the pinning half established, read back. */
export interface ChecksWatchHead {
  readonly headSha: string | null;
  readonly failing: boolean;
}

export function parseChecksWatchHead(received: unknown): ChecksWatchHead | undefined {
  const value = jsonObject(received);
  if (value === undefined || Object.keys(value).length !== 2) {
    return undefined;
  }
  const { headSha, failing } = value;
  if (typeof failing !== "boolean") {
    return undefined;
  }
  if (headSha === null || (typeof headSha === "string" && headSha !== "")) {
    return { headSha, failing };
  }
  return undefined;
}

/**
 * Watch, or continue the watch this invocation already started.
 *
 * `reads` performs one live read through the host's own transport; `progress`
 * writes one live line. Neither is called for an effect already retained.
 */
export function retainPullRequestChecksWatch(
  request: PullRequestChecksWatchRequest,
  position: Readonly<SourcePosition> | undefined,
  reads: CheckWatchReads,
  progress: CheckWatchProgress,
): Operation<CheckWatchResult> {
  return scoped(function* () {
    const deadline = parseChecksWatchDeadline(
      yield createDurableOperation<DurableJson>(
        describe(PULL_REQUEST_CHECKS_WATCH_DEADLINE, request, position),
        function* (): Operation<DurableJson> {
          if (request.timeoutSeconds === null) {
            return { deadline: null };
          }
          const now = yield* PullRequestWatchClock.operations.now();
          const exact = BigInt(Math.trunc(now)) + BigInt(request.timeoutSeconds) * 1000n;
          return {
            deadline: exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : String(exact),
          };
        },
      ),
      request.timeoutSeconds,
    );
    if (deadline === undefined) {
      throw restored();
    }
    const state = checkWatchState(deadline);

    const head = parseChecksWatchHead(
      yield createDurableOperation<DurableJson>(
        describe(PULL_REQUEST_CHECKS_WATCH_HEAD, request, position),
        function* (): Operation<DurableJson> {
          yield* pinCheckHead(state, reads, progress);
          return { headSha: state.headSha, failing: state.failing };
        },
        { coordinator: joinedReadCoordinator },
      ),
    );
    if (head === undefined || (deadline === null && head.headSha === null && !head.failing)) {
      throw restored();
    }
    state.headSha = head.headSha;
    state.failing = head.failing;

    const result = parseCheckWatchResult(
      yield createDurableOperation<DurableJson>(
        describe(PULL_REQUEST_CHECKS_WATCH_RESULT, request, position),
        function* (): Operation<DurableJson> {
          return checkWatchResultJson(yield* settleChecks(state, reads, progress));
        },
        { coordinator: joinedReadCoordinator },
      ),
    );
    if (
      result === undefined ||
      result.headSha !== head.headSha ||
      (deadline === null && result.reason === "timeout")
    ) {
      throw restored();
    }
    return result;
  });
}

/** A value read across the JSON boundary, when it is an object. */
function jsonObject(value: unknown): JsonObject | undefined {
  try {
    const parsed = parseJson(value);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof JsonParseError) {
      return undefined;
    }
    throw error;
  }
}

function restored(): PullRequestReadError {
  return new PullRequestReadError(
    "protocol",
    ELEMENT,
    "what this run retained for its watch is not the checkpoint a watch produces.",
  );
}
