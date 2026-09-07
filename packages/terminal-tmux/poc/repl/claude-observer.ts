/**
 * Issue #774 POC — the Claude session-file parser.
 *
 * Claude Code writes one identity-bearing `.jsonl` file per session under a
 * project directory, named by the session identifier. This parser reads only the
 * record shapes the observer needs and refuses a relevant record whose required
 * members are wrong; the shared observer in `observer.ts` owns the file
 * identity, the cursor and the refusals.
 *
 * Identity comes from the file name, and every relevant record also carries its
 * own `sessionId`, so a record planted under another identity is caught rather
 * than inherited. Completion is an explicit closing `result` record — the one
 * unambiguous boundary this POC accepts. A build whose real format offers no
 * such record is reported `PROVIDER_EXCLUDED` rather than having completion
 * inferred from anything weaker.
 */

import type { ParsedRecord, ProviderParser } from "./observer.ts";

/** The Claude parser: filename identity, `sessionId`-tagged records. */
export const claudeParser: ProviderParser = {
  provider: "claude",
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
      return classifyResult(record);
    }
    // Summaries, system notices and anything else bear on nothing here.
    return { kind: "ignore" };
  },
};

/** A `user` or `assistant` record, read for its identity and its text. */
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
  if (kind === "user-accepted") {
    return { kind: "user-accepted", identity, text };
  }
  return { kind: "assistant-output", identity, text };
}

/** The explicit closing record: `{"type":"result","sessionId":…}`. */
function classifyResult(record: Record<string, unknown>): ParsedRecord {
  const identity = record["sessionId"];
  if (typeof identity !== "string" || identity.length === 0) {
    return { kind: "unsupported", reason: "result record with no sessionId" };
  }
  return { kind: "turn-completed", identity };
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
