/**
 * Permission policies (specs/acp-client-spec.md §Permissions).
 *
 * The base `requestPermission` denies. These helpers install scoped
 * middleware that layers policy on top of it:
 *
 * - approve-all selects `allow_once`, then `allow_always`.
 * - ask prompts on an interactive TTY.
 * - approve-reads approves `read` and `search` tool kinds and asks for
 *   everything else.
 *
 * A scoped policy decides every request inside its body: when it cannot
 * approve it denies through `denyPermission` rather than delegating to
 * `next`, because a nested policy that delegates reaches the *enclosing*
 * policy instead of the base deny — an inner ask with no TTY would then
 * be approved by an enclosing approve-all.
 */

import { until } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Agent, denyPermission } from "./agent-api.ts";
import type { PermissionMode, PermissionOutcome, PermissionRequest } from "./agent-api.ts";
import { AgentInternal } from "./internal.ts";

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
      *requestPermission([request], _next) {
        return approve(request) ?? denyPermission(request);
      },
    },
    { at: "min" },
  );
}

export function* installAskPermission(): Operation<void> {
  yield* Agent.around(
    {
      *requestPermission([request], _next) {
        return (yield* ask(request)) ?? denyPermission(request);
      },
    },
    { at: "min" },
  );
}

export function* installApproveReads(): Operation<void> {
  yield* Agent.around(
    {
      *requestPermission([request], _next) {
        const kind = request.toolCall.kind;
        if (kind === "read" || kind === "search") {
          const approval = approve(request);
          if (approval) {
            return approval;
          }
        }
        return (yield* ask(request)) ?? denyPermission(request);
      },
    },
    { at: "min" },
  );
}

/**
 * Decide, for this scope, that a failing `<Prompt>` ends the document even
 * though the author did not write `throwOnError`.
 *
 * A host that runs documents as tests needs a failed prompt to fail the test
 * rather than render its printed error and continue. `decide` is consulted once per
 * prompt, after its content has rendered and before the durable operation, so a
 * policy can depend on where the prompt is — inside a test, say. An explicit
 * `throwOnError={true}` wins without consulting it.
 *
 * Only the agent `<Prompt>` reads this. A repository component that happens to
 * be called `Prompt` is an ordinary component and never sees it.
 */
export function* installPromptFailurePolicy(decide: () => Operation<boolean>): Operation<void> {
  yield* AgentInternal.around(
    {
      *promptFailurePolicy(_args, next) {
        return (yield* decide()) || (yield* next());
      },
    },
    { at: "min" },
  );
}

/**
 * Install the middleware for a permission mode. Deny-all installs
 * nothing — the base implementation already denies.
 */
export function* installPermissionMode(mode: PermissionMode): Operation<void> {
  if (mode === "approve-all") {
    yield* installApproveAll();
  } else if (mode === "approve-reads") {
    yield* installApproveReads();
  }
}
