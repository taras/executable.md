/**
 * One creation request, parsed as a closed shape before any member is read.
 *
 * The type describes what a caller meant. What arrives is whatever the language
 * allows, and reading `.runId` off `null` fails as a `TypeError` rather than as
 * an answer about the request.
 *
 * Shared because both providers admit the same request: the local one from a
 * caller in its own process, the remote one from a command that crossed a
 * connection. Two parsers would be two definitions of what a run *is*, and the
 * more permissive one would decide.
 */

import { Err, Ok, type Result } from "effection";
import {
  type JsonObject,
  type Members,
  parseJsonObject,
  parseMembers,
  requireMemberNames,
} from "./members.ts";
import { parseWorkflowDefinition } from "./definition.ts";
import { WorkflowRequestError } from "./errors.ts";
import { parseRunId } from "./record.ts";
import type { CreateWorkflowRunRequest } from "./api.ts";
import type { WorkflowDefinition } from "./definition.ts";

const REQUEST_MEMBERS: readonly string[] = ["runId", "definition", "base", "props"];

/** A request whose every member has been checked rather than believed. */
export interface CheckedRequest {
  readonly runId: string;
  readonly definition: WorkflowDefinition;
  readonly base: string;
  readonly props: JsonObject;
}

export function checkRunId(runId: unknown): Result<string> {
  try {
    return Ok(parseRunId(runId, "$", runIdFailure));
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return Err(error);
    }
    throw error;
  }
}

function runIdFailure(reason: string): Error {
  return new WorkflowRequestError(`${reason}.`);
}

/**
 * The whole request, parsed as a closed shape before any member is read.
 *
 * The type describes what a caller meant. What arrives is whatever the
 * language allows, and reading `.runId` off `null` fails as a `TypeError`
 * rather than as an answer about the request.
 */
export function parseCreateRequest(offered: unknown): Result<CheckedRequest> {
  let members: Members;
  try {
    members = parseMembers(offered, "$", requestFailure);
    requireMemberNames(members, REQUEST_MEMBERS, "$", requestFailure);
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return Err(error);
    }
    throw error;
  }

  const runId = checkRunId(members.get("runId"));
  if (!runId.ok) {
    return runId;
  }

  const base = members.get("base");
  if (typeof base !== "string" || base === "") {
    return Err(
      new WorkflowRequestError("a base is required: it is what the run's starting state is."),
    );
  }

  const definition = parseWorkflowDefinition(members.get("definition"));
  if (!definition.ok) {
    return definition;
  }

  let props: JsonObject;
  try {
    props = parseJsonObject(members.get("props"), "$", propsFailure);
  } catch (error) {
    if (error instanceof WorkflowRequestError) {
      return Err(error);
    }
    throw error;
  }

  return Ok({ runId: runId.value, definition: definition.value, base, props });
}

function requestFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `the request does not describe a workflow run: ${reason} at ${path}`,
  );
}

function propsFailure(reason: string, path: string): Error {
  return new WorkflowRequestError(
    `the normalized props are not a JSON value: ${reason} at ${path}`,
  );
}
