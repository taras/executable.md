/**
 * Issue #774 POC — the Claude session-file parser.
 *
 * Claude Code writes one identity-bearing `.jsonl` file per session under a
 * project directory, named by the session identifier, so identity comes from the
 * file name and the project is the directory the caller resolved. This parser
 * reads only the record shapes the observer needs and refuses a relevant record
 * whose required members are wrong; the shared observer owns file identity, the
 * cursor and the refusals.
 *
 * Assistant output and completion are grouped by an explicit turn identity — the
 * record's `requestId` — so output from one turn is never attributed to another.
 * Completion is an explicit closing `result` record, the one unambiguous
 * boundary this POC accepts. A build whose real interactive format offers no
 * such record is reported `PROVIDER_EXCLUDED` (see `live-worker.ts`) rather than
 * having completion inferred from anything weaker.
 */

import type { ParsedRecord, ProviderParser } from "./observer.ts";

/**
 * Build a Claude parser.
 *
 * `supportsCompletion` is the build's declared capability. When it is false, a
 * `result` record is ignored rather than treated as a completion boundary, and
 * the caller reports `PROVIDER_EXCLUDED` from that explicit fact — never from a
 * deadline. The default is a build whose interactive format does carry the
 * closing record.
 */
export function createClaudeParser(supportsCompletion: boolean): ProviderParser {
  return {
    provider: "claude",
    supportsCompletion,
    identityFromName(name) {
      return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : undefined;
    },
    classify(record) {
      const type = record["type"];
      if (type === "user") {
        return classifyMessage(record, "user-accepted");
      }
      if (type === "assistant") {
        return classifyMessage(record, "assistant-output");
      }
      if (type === "result") {
        return supportsCompletion ? classifyResult(record) : { kind: "ignore" };
      }
      // Summaries, system notices and anything else bear on nothing here.
      return { kind: "ignore" };
    },
  };
}

/** The Claude parser: filename identity, `sessionId`-tagged, `requestId`-grouped. */
export const claudeParser: ProviderParser = createClaudeParser(true);

/** The turn a record belongs to: its `requestId`, when it carries one. */
function turnOf(record: Record<string, unknown>): string | undefined {
  const requestId = record["requestId"];
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

/** A `user` or `assistant` record, read for its identity, turn and text. */
function classifyMessage(
  record: Record<string, unknown>,
  kind: "user-accepted" | "assistant-output",
): ParsedRecord {
  const identity = record["sessionId"];
  if (typeof identity !== "string" || identity.length === 0) {
    return { kind: "unsupported", reason: `${kind} record with no sessionId` };
  }
  const text = messageText(record["message"]);
  if (text === undefined) {
    return { kind: "unsupported", reason: `${kind} record with no readable text` };
  }
  const turn = turnOf(record);
  if (turn === undefined) {
    return { kind: "unsupported", reason: `${kind} record with no requestId turn identity` };
  }
  if (kind === "user-accepted") {
    return { kind: "user-accepted", identity, text, turn };
  }
  return { kind: "assistant-output", identity, text, turn };
}

/** The explicit closing record: `{"type":"result","sessionId":…,"requestId":…}`. */
function classifyResult(record: Record<string, unknown>): ParsedRecord {
  const identity = record["sessionId"];
  if (typeof identity !== "string" || identity.length === 0) {
    return { kind: "unsupported", reason: "result record with no sessionId" };
  }
  const turn = turnOf(record);
  if (turn === undefined) {
    return { kind: "unsupported", reason: "result record with no requestId turn identity" };
  }
  return { kind: "turn-completed", identity, turn };
}

/** Join the text parts of a Claude message, or nothing when there are none. */
function messageText(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const content = message["content"];
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") {
      parts.push(part["text"]);
    }
  }
  return parts.length === 0 ? undefined : parts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
