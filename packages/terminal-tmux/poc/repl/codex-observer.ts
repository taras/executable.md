/**
 * Issue #774 POC — the Codex rollout-file parser.
 *
 * Codex maps a thread identity to one rollout `.jsonl` file. A `session_meta`
 * header declares both the identity and the project (`cwd`) once; the `event_msg`
 * records that follow do not repeat the identity, so they inherit the located
 * file's. The shared observer reads only that header to decide whose a file is,
 * and constrains the match by the exact identity and the exact project, so the
 * shared sessions root cannot hand back another project's thread.
 *
 * Only three event shapes bear on the contract: `user_message` is acceptance,
 * `agent_message` is assistant output, and `task_complete` is the explicit
 * completion boundary. Codex threads are linear, so events carry no turn
 * identity. An `event_msg` whose payload is one of those but is otherwise
 * malformed is refused rather than skipped; every other event is ignored.
 */

import type { ParsedRecord, ProviderParser } from "./observer.ts";

/** The Codex parser: `session_meta` identity and project, `event_msg` events. */
export const codexParser: ProviderParser = {
  provider: "codex",
  supportsCompletion: true,
  identityFromName() {
    // Codex names its rollout files by timestamp, not by identity, so the
    // identity is only ever read from the `session_meta` record inside.
    return undefined;
  },
  classify(record) {
    const type = record["type"];
    if (type === "session_meta") {
      return classifyMeta(record);
    }
    if (type === "event_msg") {
      return classifyEvent(record);
    }
    return { kind: "ignore" };
  },
};

/** The header record that names the thread and the project it ran in. */
function classifyMeta(record: Record<string, unknown>): ParsedRecord {
  const payload = record["payload"];
  if (!isRecord(payload) || typeof payload["id"] !== "string" || payload["id"].length === 0) {
    return { kind: "unsupported", reason: "session_meta with no payload id" };
  }
  const cwd = payload["cwd"];
  return {
    kind: "identity",
    identity: payload["id"],
    ...(typeof cwd === "string" && cwd.length > 0 ? { project: cwd } : {}),
  };
}

/** One `event_msg`, read only for the three payload types that matter. */
function classifyEvent(record: Record<string, unknown>): ParsedRecord {
  const payload = record["payload"];
  if (!isRecord(payload)) {
    return { kind: "unsupported", reason: "event_msg with no payload" };
  }
  const kind = payload["type"];
  if (kind === "user_message") {
    return textEvent(payload, "user-accepted", "user_message");
  }
  if (kind === "agent_message") {
    return textEvent(payload, "assistant-output", "agent_message");
  }
  if (kind === "task_complete") {
    return { kind: "turn-completed" };
  }
  return { kind: "ignore" };
}

/** A `user_message` or `agent_message`, read for its `message` text. */
function textEvent(
  payload: Record<string, unknown>,
  kind: "user-accepted" | "assistant-output",
  label: string,
): ParsedRecord {
  const text = payload["message"];
  if (typeof text !== "string") {
    return { kind: "unsupported", reason: `${label} with no message text` };
  }
  if (kind === "user-accepted") {
    return { kind: "user-accepted", text };
  }
  return { kind: "assistant-output", text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
