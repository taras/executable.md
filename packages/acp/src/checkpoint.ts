/**
 * Which provider turn a completed Prompt was, as this package reads it.
 *
 * ACP carries per-response metadata under `_meta`, and an adapter that knows
 * how to name its own turns puts that name there. The runtime carries the whole
 * value across untouched and recognizes nothing in it, because which keys mean
 * something is this package's decision rather than a transport's.
 *
 * Two namespaces mean something here, one per adapter, and each is the
 * adapter's own:
 *
 * | Adapter | Where it says it | What that is |
 * | --- | --- | --- |
 * | Codex | `_meta.codex.turnId` | the App Server turn id |
 * | Claude | `_meta.claudeCode.assistantMessageUuid` | the assistant message uuid |
 *
 * Everything else in `_meta` is discarded. Quota, failure detail and whatever
 * else an adapter reports are that adapter's business; nothing here reads them,
 * and nothing here treats an unfamiliar key as a checkpoint because it happens
 * to look like one.
 *
 * The value is opaque. It is compared, never interpreted: this does not check
 * it against a UUID grammar, does not shorten or normalize it, and does not
 * reconstruct one from anything else. Transcript text repeats, another turn's
 * token is a different turn, a provider's current head is a later point in the
 * conversation, and prompt or journal position is order rather than identity —
 * so a completion that names no turn simply names none.
 *
 * Ambiguity is refused for the same reason. Two adapters both claiming one turn
 * is two answers to which conversation this was, and there is no rule for
 * choosing between them, so such a completion carries no checkpoint at all.
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
