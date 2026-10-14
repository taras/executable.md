/**
 * Read a completed Prompt's opaque provider turn identity from `_meta`.
 *
 * Recognized identities are `_meta.codex.turnId` (App Server turn id) and
 * `_meta.claudeCode.assistantMessageUuid` (assistant message uuid). The runtime
 * passes metadata through; this package discards every other field.
 *
 * Exactly one recognized non-empty string yields a checkpoint. Missing or
 * ambiguous identities yield none; transcript text, current session head and
 * journal position never substitute for one. Values are compared unchanged,
 * without UUID validation or normalization.
 */

import type { AgentPromptCheckpoint } from "@executablemd/core";
import type { AcpRuntimeTurnResult } from "./acpx-runtime.ts";

interface RecognizedNamespace {
  /** The `_meta` member the adapter writes under. */
  readonly namespace: string;
  /** The member inside it that holds the identity. */
  readonly member: string;
  /** How this provider names itself in a retained checkpoint. */
  readonly provider: string;
  /** What kind of identity the value is. */
  readonly kind: string;
}

const RECOGNIZED: readonly RecognizedNamespace[] = Object.freeze([
  Object.freeze({
    namespace: "codex",
    member: "turnId",
    provider: "codex",
    kind: "app-server-turn-id",
  }),
  Object.freeze({
    namespace: "claudeCode",
    member: "assistantMessageUuid",
    provider: "claude",
    kind: "assistant-message-uuid",
  }),
]);

function member(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Reflect.get(value, name);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The checkpoint this metadata names, or none.
 *
 * Malformed metadata is not a failure. `_meta` is an adapter's own space and a
 * shape this build does not recognize says nothing about whether the turn
 * completed — so an unreadable one supplies no checkpoint and changes nothing
 * else about the completion.
 */
export function checkpointFromMeta(meta: unknown): AgentPromptCheckpoint | undefined {
  const found: AgentPromptCheckpoint[] = [];
  for (const recognized of RECOGNIZED) {
    const value = nonEmptyString(member(member(meta, recognized.namespace), recognized.member));
    if (value !== undefined) {
      found.push(Object.freeze({ provider: recognized.provider, kind: recognized.kind, value }));
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The checkpoint a turn result carries.
 *
 * Only a completed turn has one. A cancelled turn was interrupted rather than
 * finished, a failed turn produced no response to read metadata from, and the
 * runtime's timeout fallback reconstructs a completion from session updates —
 * none of them describes a point a later run could continue from.
 */
export function checkpointFromResult(
  result: AcpRuntimeTurnResult,
): AgentPromptCheckpoint | undefined {
  return result.status === "completed" ? checkpointFromMeta(result._meta) : undefined;
}
