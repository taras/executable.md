/**
 * Permission policies (specs/acp-client-spec.md §Permissions).
 *
 * The base `requestPermission` denies. These helpers install scoped
 * middleware that layers policy on top of it:
 *
 * - approve-all selects `allow_once`, then `allow_always`.
 * - ask prompts on an interactive TTY and delegates to the base deny
 *   otherwise.
 * - approve-reads auto-approves `read` and `search` tool kinds and asks
 *   (or denies without a TTY) for everything else.
 */

import { until } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Agent } from "./agent-api.ts";
import type { PermissionMode, PermissionOutcome, PermissionRequest } from "./agent-api.ts";

function approve(request: PermissionRequest): PermissionOutcome | undefined {
  const approval =
    request.options.find((option) => option.kind === "allow_once") ??
    request.options.find((option) => option.kind === "allow_always");
  if (approval) {
    return { outcome: "selected", optionId: approval.optionId };
  }
  return undefined;
}

function* ask(request: PermissionRequest): Operation<PermissionOutcome | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }
  const title = request.toolCall.title ?? request.toolCall.toolCallId;
  const kind = request.toolCall.kind ? ` (${request.toolCall.kind})` : "";
  const lines = [
    `Agent requests permission: ${title}${kind}`,
    ...request.options.map((option, index) => `  ${index + 1}. ${option.name} [${option.kind}]`),
  ];
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(lines.join("\n"));
    const answer = yield* until(readline.question("Select an option number: "));
    const index = Number.parseInt(answer.trim(), 10);
    const option = request.options[index - 1];
    if (option) {
      return { outcome: "selected", optionId: option.optionId };
    }
    return undefined;
  } finally {
    readline.close();
  }
}

export function* installApproveAll(): Operation<void> {
  yield* Agent.around(
    {
      *requestPermission([request], next) {
        return approve(request) ?? (yield* next(request));
      },
    },
    { at: "min" },
  );
}

export function* installAskPermission(): Operation<void> {
  yield* Agent.around(
    {
      *requestPermission([request], next) {
        return (yield* ask(request)) ?? (yield* next(request));
      },
    },
    { at: "min" },
  );
}

export function* installApproveReads(): Operation<void> {
  yield* Agent.around(
    {
      *requestPermission([request], next) {
        const kind = request.toolCall.kind;
        if (kind === "read" || kind === "search") {
          const approval = approve(request);
          if (approval) {
            return approval;
          }
        }
        return (yield* ask(request)) ?? (yield* next(request));
      },
    },
    { at: "min" },
  );
}

/** Install the middleware for a CLI permission mode. Deny-all installs nothing — the base implementation already denies. */
export function* installPermissionMode(mode: PermissionMode): Operation<void> {
  if (mode === "approve-all") {
    yield* installApproveAll();
  } else if (mode === "approve-reads") {
    yield* installApproveReads();
  }
}
