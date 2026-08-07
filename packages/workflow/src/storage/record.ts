/**
 * What one workflow run retains.
 *
 * A run's record separates what cannot change from what does. Identity — the
 * run id, the definition descriptor, the base, and the normalized props — is
 * written once and compared on every reuse. Status, stop reason, retrieval
 * metadata and timestamps move as the run progresses and take no part in that
 * comparison, so a run that has failed is still the same run it was.
 *
 * A document execution is one evaluation of the root document: the initial
 * start, and one more for every resume. These are not attempts. An attempt is
 * one execution of a retried operation or region and belongs to the journal;
 * an execution record is the outer envelope those attempts happen inside.
 */

import { Err, Ok, type Result } from "effection";
import { canonicalize } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type { WorkflowDefinition } from "./definition.ts";
import { WorkflowRequestError } from "./errors.ts";
import {
  describe,
  type Fail,
  parseMembers,
  parseStringMember,
  requireMemberNames,
} from "./members.ts";

/**
 * What a run is doing, or what it stopped doing.
 *
 * These six are what storage retains. Which transitions are legal, and what a
 * caller may do to a run in each of them, is lifecycle policy and is not
 * decided here.
 */
export type WorkflowRunStatus =
  | "running"
  | "suspended"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

/** Every retained status, in the order the specification lists them. */
export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = Object.freeze([
  "running",
  "suspended",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Why a run stopped, without repeating why.
 *
 * A host reason carries a categorical code the host assigns. A journal reason
 * points at an event that already crossed the secret filter. Neither shape can
 * hold an arbitrary exception message, because a message that reached storage
 * this way would be retained history nothing had filtered.
 */
export type WorkflowStopReason =
  | { readonly kind: "host"; readonly code: string }
  | { readonly kind: "journal"; readonly eventId: string };

/** One workflow run's retained metadata. */
export interface WorkflowRunRecord {
  readonly runId: string;
  readonly definition: WorkflowDefinition;
  readonly base: string;
  readonly props: Json;
  readonly status: WorkflowRunStatus;
  readonly stopReason?: WorkflowStopReason;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Where this host can fetch the definition from, as of now.
 *
 * Replaceable, excluded from identity, and never a credential. A host
 * reauthorizes before using it rather than treating a retained locator as
 * permission it already has.
 */
export interface DefinitionRetrieval {
  readonly metadata: Json;
  readonly revision: number;
  readonly updatedAt: string;
}

/** One evaluation of the root document: the initial start, or one resume. */
export interface DocumentExecutionRecord {
  readonly executionId: string;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly stopStatus?: WorkflowRunStatus;
  readonly stopReason?: WorkflowStopReason;
}

/** How a document execution ended. */
export interface DocumentExecutionCompletion {
  readonly executionId: string;
  readonly status: WorkflowRunStatus;
  readonly reason?: WorkflowStopReason;
}

/** The run state a caller is publishing. */
export interface StoredRunState {
  readonly status: WorkflowRunStatus;
  readonly reason?: WorkflowStopReason;
}

/**
 * The stable spelling of a JSON value.
 *
 * Two values differing only in key order are one value, and comparing their
 * raw text would make a host that reordered its props look like it asked for a
 * different run.
 */
export function canonicalJson(value: Json): string {
  const text = JSON.stringify(canonicalize(value));
  if (typeof text !== "string") {
    throw new TypeError("canonicalJson: value has no JSON representation");
  }
  return text;
}

/** The status a value names. */
export function parseWorkflowRunStatus(
  value: unknown,
  path: string,
  fail: Fail,
): WorkflowRunStatus {
  switch (value) {
    case "running":
    case "suspended":
    case "interrupted":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      throw fail(`expected a workflow run status, found ${describe(value)}`, path);
  }
}

/** The stop reason a value describes. */
export function parseWorkflowStopReason(
  value: unknown,
  path: string,
  fail: Fail,
): WorkflowStopReason {
  const members = parseMembers(value, path, fail);
  const kind = parseStringMember(members, "kind", path, fail);

  if (kind === "host") {
    requireMemberNames(members, ["kind", "code"], path, fail);
    return { kind: "host", code: parseNonEmpty(members, "code", path, fail) };
  }
  if (kind === "journal") {
    requireMemberNames(members, ["kind", "eventId"], path, fail);
    return { kind: "journal", eventId: parseNonEmpty(members, "eventId", path, fail) };
  }
  throw fail('expected the kind "host" or "journal"', `${path}.kind`);
}

function parseNonEmpty(
  members: Map<string, unknown>,
  key: string,
  path: string,
  fail: Fail,
): string {
  const value = parseStringMember(members, key, path, fail);
  if (value === "") {
    throw fail("expected a non-empty string", `${path}.${key}`);
  }
  return value;
}

/**
 * The stop reason a caller offered, checked before it is stored.
 *
 * A caller's reason is as unchecked as a stored one: both arrive from outside
 * this module, and a shape that reaches the database unparsed becomes a row
 * nothing can read back.
 */
export function parseStopReasonInput(value: unknown): Result<WorkflowStopReason> {
  try {
    return Ok(parseWorkflowStopReason(value, "$", stopReasonFailure));
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return Err(error);
    }
    throw error;
  }
}

function stopReasonFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(`the stop reason does not describe one: ${reason} at ${path}`);
}
