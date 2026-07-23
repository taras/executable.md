/**
 * Permission bridge (specs/acp-client-spec.md §Permissions).
 *
 * Each active turn registers its subscribing Effection scope under the
 * handle's `backendSessionId` — the ACP session ID that permission
 * requests carry. A request re-enters exactly that scope, so scoped
 * `requestPermission` middleware (`<ApproveAll>`, eval blocks, CLI
 * policy) is visible. A missing or torn-down scope, an unknown session
 * ID, or an unknown selected option ID all produce an ACP cancellation —
 * never `undefined` and never another active scope.
 */

import type { Scope } from "effection";
import { Agent } from "@executablemd/core";
import type { PermissionOption, PermissionRequest, Session } from "@executablemd/core";
import type { AcpPermissionDecision, AcpPermissionRequest } from "acpx/runtime";

const CANCEL: AcpPermissionDecision = { outcome: "cancel" };

interface RegisteredTurn {
  scope: Scope;
  session: Session;
}

export interface PermissionBridge {
  /** Register the active turn's scope. Returns the unregister cleanup. */
  register(backendSessionId: string, scope: Scope, session: Session): () => void;
  onPermissionRequest(
    request: AcpPermissionRequest,
    ctx: { signal: AbortSignal },
  ): Promise<AcpPermissionDecision | undefined>;
}

export function createPermissionBridge(): PermissionBridge {
  const turns = new Map<string, RegisteredTurn>();
  return {
    register(backendSessionId, scope, session) {
      const registered: RegisteredTurn = { scope, session };
      turns.set(backendSessionId, registered);
      return () => {
        if (turns.get(backendSessionId) === registered) {
          turns.delete(backendSessionId);
        }
      };
    },
    onPermissionRequest(request) {
      const registered = turns.get(request.sessionId);
      if (!registered) {
        return Promise.resolve(CANCEL);
      }
      const task = registered.scope.run(function* () {
        const permissionRequest = toPermissionRequest(request, registered.session);
        const outcome = yield* Agent.operations.requestPermission(permissionRequest);
        return toDecision(outcome, permissionRequest.options);
      });
      return Promise.resolve(task).then(
        (decision) => decision,
        () => CANCEL,
      );
    },
  };
}

const OPTION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"];

function parseOptionKind(value: unknown): PermissionOption["kind"] | undefined {
  if (value === "allow_once" || value === "allow_always") {
    return value;
  }
  if (value === "reject_once" || value === "reject_always") {
    return value;
  }
  return undefined;
}

function toPermissionRequest(request: AcpPermissionRequest, session: Session): PermissionRequest {
  const raw = request.raw;
  const options: PermissionOption[] = [];
  for (const option of raw.options) {
    // ACP's PermissionOptionKind is an open union; options whose kind is
    // outside the stable Executable.md shape are not offered.
    const kind = parseOptionKind(option.kind);
    if (kind) {
      options.push({ optionId: String(option.optionId), name: option.name, kind });
    }
  }
  const toolCall: PermissionRequest["toolCall"] = {
    toolCallId: String(raw.toolCall.toolCallId),
  };
  if (typeof raw.toolCall.title === "string") {
    toolCall.title = raw.toolCall.title;
  }
  const kind = raw.toolCall.kind ?? request.inferredKind;
  if (typeof kind === "string") {
    toolCall.kind = kind;
  }
  if (raw.toolCall.rawInput !== undefined) {
    toolCall.rawInput = raw.toolCall.rawInput;
  }
  return { session, toolCall, options };
}

function toDecision(
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" },
  options: readonly PermissionOption[],
): AcpPermissionDecision {
  if (outcome.outcome === "cancelled") {
    return CANCEL;
  }
  const selected = options.find((option) => option.optionId === outcome.optionId);
  if (!selected || !OPTION_KINDS.includes(selected.kind)) {
    return CANCEL;
  }
  return { outcome: selected.kind };
}
