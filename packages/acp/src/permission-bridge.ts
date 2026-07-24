/**
 * Permission bridge (specs/acp-client-spec.md §Permissions).
 *
 * ## Authoritative routing source
 *
 * ACPX delivers a permission request to `onPermissionRequest` keyed by
 * `params.sessionId`, which is the ACP session id ACPX uses on the wire
 * for the prompting turn — its `acpSessionId` (surfaced as the handle's
 * `backendSessionId`). The provider registers each active turn's scope
 * under the id from the AUTHORITATIVE persisted session record at turn
 * start, so scoped `requestPermission` middleware (`<ApproveAll>`, eval
 * blocks, CLI policy) is visible when the matching request arrives.
 * Missing/torn-down registrations, policy errors, aborts, and unknown
 * selected option ids all resolve `{ outcome: "cancel" }` — never
 * `undefined` (which would let ACPX fall back to its mode resolver) and
 * never another active scope.
 *
 * ## Mid-turn id replacement
 *
 * On a reconnecting turn ACPX can replace the ACP session id
 * (`connectAndLoadSession` → `onSessionIdResolved`) and persists the new
 * id only when the turn completes. A permission request during that turn
 * carries the NEW id. The bridge can route it — `register` returns a
 * `rekey` that moves the live registration to the new id — but ACPX 0.12
 * exposes the resolved id on neither the public `AcpRuntimeTurn` nor its
 * event stream, so the provider has nothing to drive `rekey` with. Until
 * ACPX adds turn-level session-id visibility (see below), such a request
 * fails closed with cancel; a sole-active fallback is deliberately NOT
 * used, as it would misroute under concurrent sessions.
 *
 * REQUIRED ACPX API CHANGE: expose the turn's resolved ACP session id —
 * e.g. `AcpRuntimeTurn.sessionId`, an `onSessionIdResolved` callback on
 * `AcpRuntimeTurnInput`, or a structured `session_id` event — so the
 * provider can call `rekey` when the id changes mid-turn.
 */

import { once, race } from "effection";
import type { Operation, Scope } from "effection";
import { Agent } from "@executablemd/core";
import type { PermissionOption, PermissionRequest, Session } from "@executablemd/core";
import type { AcpPermissionDecision, AcpPermissionRequest } from "acpx/runtime";

const CANCEL: AcpPermissionDecision = { outcome: "cancel" };

interface RegisteredTurn {
  scope: Scope;
  session: Session;
}

export interface Registration {
  /** Remove this registration (only if it still owns its current id). */
  unregister(): void;
  /**
   * Move this live registration to `newSessionId` — the hook a future
   * ACPX turn-level session-id signal would drive on mid-turn
   * replacement.
   */
  rekey(newSessionId: string): void;
}

export interface PermissionBridge {
  /** Register the active turn's scope under its ACP session id. */
  register(backendSessionId: string, scope: Scope, session: Session): Registration;
  /**
   * Decide one permission request. Never undefined — missing or
   * torn-down registrations, policy errors, aborts, and unknown
   * selected option ids all resolve `{ outcome: "cancel" }`, so ACPX
   * can never fall back to its own mode resolver.
   */
  decision(request: AcpPermissionRequest, signal: AbortSignal): Operation<AcpPermissionDecision>;
}

export function createPermissionBridge(): PermissionBridge {
  const turns = new Map<string, RegisteredTurn>();
  return {
    register(backendSessionId, scope, session) {
      const registered: RegisteredTurn = { scope, session };
      let currentId = backendSessionId;
      turns.set(currentId, registered);
      return {
        unregister() {
          if (turns.get(currentId) === registered) {
            turns.delete(currentId);
          }
        },
        rekey(newSessionId) {
          if (newSessionId === currentId) {
            return;
          }
          if (turns.get(currentId) === registered) {
            turns.delete(currentId);
          }
          currentId = newSessionId;
          turns.set(currentId, registered);
        },
      };
    },
    *decision(request, signal) {
      const registered = turns.get(request.sessionId);
      if (!registered || signal.aborted) {
        return CANCEL;
      }
      try {
        // Policy errors are contained INSIDE the task: an unhandled
        // task failure would propagate into the prompt scope itself.
        // Halts are unaffected — try/catch does not intercept them.
        const task = registered.scope.run(function* (): Operation<AcpPermissionDecision> {
          try {
            const permissionRequest = toPermissionRequest(request, registered.session);
            const outcome = yield* Agent.operations.requestPermission(permissionRequest);
            return toDecision(outcome, permissionRequest.options);
          } catch {
            return CANCEL;
          }
        });
        return yield* race([
          task,
          (function* (): Operation<AcpPermissionDecision> {
            yield* once(signal, "abort");
            yield* task.halt();
            return CANCEL;
          })(),
        ]);
      } catch {
        // Torn-down prompt scopes cancel — never fall through to
        // another policy or ACPX's mode resolver.
        return CANCEL;
      }
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
