/**
 * Permission bridge (specs/acp-client-spec.md §Permissions).
 *
 * ## Routing
 *
 * ACPX delivers a permission request to `onPermissionRequest` keyed by
 * `params.sessionId` — the ACP session id (`acpSessionId`) of the
 * prompting turn. Each active turn registers its subscribing scope, an
 * initial id, and a `refresh` operation that reloads its ACPX record by
 * `acpxRecordId`. The id map is a cache: before routing, the bridge
 * refreshes and verifies a direct candidate; on a miss it refreshes all
 * active registrations and routes only when exactly one matches the
 * request id. This tracks ACPX's reconnect fallback, which updates
 * `record.acpSessionId` and checkpoints the record before running the
 * prompt. The public `Session.agentSessionId` is updated from the
 * refreshed record.
 *
 * ## Fail closed
 *
 * The decision resolves `{ outcome: "cancel" }` — never `undefined`
 * (which would let ACPX fall back to its mode resolver) and never
 * another scope — on: store errors during refresh, zero or multiple
 * matching registrations, a stale or torn-down prompt scope, a policy
 * error, an unknown selected option id, and an abort (before or during
 * evaluation).
 */

import { on, race } from "effection";
import type { Operation, Scope } from "effection";
import { Agent } from "@executablemd/core";
import type { PermissionOption, PermissionRequest, Session } from "@executablemd/core";
import type { AcpPermissionDecision, AcpPermissionRequest } from "acpx/runtime";

const CANCEL: AcpPermissionDecision = { outcome: "cancel" };

/** Reloads a registration's record; undefined when the record is gone. */
export type RefreshRecord = () => Operation<
  { acpSessionId?: string; agentSessionId?: string } | undefined
>;

interface RegisteredTurn {
  scope: Scope;
  session: Session;
  refresh: RefreshRecord;
  currentId: string;
  active: boolean;
}

export interface Registration {
  /** Remove this registration; an in-flight refresh cannot reinsert it. */
  unregister(): void;
}

export interface PermissionBridge {
  /** Register the active turn's scope under its ACP session id. */
  register(
    acpSessionId: string,
    scope: Scope,
    session: Session,
    refresh: RefreshRecord,
  ): Registration;
  /**
   * Decide one permission request. Never undefined — every failure mode
   * (see the module doc) resolves `{ outcome: "cancel" }`, so ACPX can
   * never fall back to its own mode resolver.
   */
  decision(request: AcpPermissionRequest, signal: AbortSignal): Operation<AcpPermissionDecision>;
}

export function createPermissionBridge(): PermissionBridge {
  const turns = new Map<string, RegisteredTurn>();

  function rekey(entry: RegisteredTurn, newId: string): void {
    // An async refresh must not resurrect an unregistered entry.
    if (!entry.active || newId === entry.currentId) {
      return;
    }
    if (turns.get(entry.currentId) === entry) {
      turns.delete(entry.currentId);
    }
    entry.currentId = newId;
    turns.set(newId, entry);
  }

  // Reload one registration's record, apply the current agent session id
  // to the public Session, rekey on a changed ACP session id, and return
  // that ACP session id. `undefined` means "does not currently match"
  // (missing record) — a thrown store error propagates to fail closed.
  function* refreshEntry(entry: RegisteredTurn): Operation<string | undefined> {
    const record = yield* entry.refresh();
    if (!record) {
      return undefined;
    }
    if (typeof record.agentSessionId === "string") {
      entry.session.agentSessionId = record.agentSessionId;
    }
    if (typeof record.acpSessionId === "string") {
      rekey(entry, record.acpSessionId);
      return record.acpSessionId;
    }
    return entry.currentId;
  }

  function* resolveTarget(sessionId: string): Operation<RegisteredTurn | undefined> {
    const direct = turns.get(sessionId);
    if (direct && direct.active) {
      const refreshed = yield* refreshEntry(direct);
      if (refreshed === sessionId) {
        return direct;
      }
    }
    // Cache miss: refresh every active registration and route only when
    // exactly one now matches the request id.
    const matches: RegisteredTurn[] = [];
    for (const entry of new Set(turns.values())) {
      if (!entry.active) {
        continue;
      }
      const refreshed = yield* refreshEntry(entry);
      if (refreshed === sessionId) {
        matches.push(entry);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  return {
    register(acpSessionId, scope, session, refresh) {
      const entry: RegisteredTurn = {
        scope,
        session,
        refresh,
        currentId: acpSessionId,
        active: true,
      };
      turns.set(acpSessionId, entry);
      return {
        unregister() {
          entry.active = false;
          if (turns.get(entry.currentId) === entry) {
            turns.delete(entry.currentId);
          }
        },
      };
    },
    *decision(request, signal) {
      // Subscribe to abort BEFORE any policy work and recheck, so a
      // synchronous abort during evaluation is never lost.
      const aborts = yield* on(signal, "abort");
      if (signal.aborted) {
        return CANCEL;
      }
      let target: RegisteredTurn | undefined;
      try {
        target = yield* resolveTarget(request.sessionId);
      } catch {
        // Store errors during refresh fail closed.
        return CANCEL;
      }
      if (!target) {
        return CANCEL;
      }
      const registered = target;
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
            yield* aborts.next();
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
