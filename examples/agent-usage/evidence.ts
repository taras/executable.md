import { exists, readdir, readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { join } from "node:path";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { AGENT_PROMPT, parsePromptRecord } from "@executablemd/core/host";
import type { PromptRecord } from "@executablemd/core/host";
import type { PromptUsage, ReportedTokens, UsageReading } from "@executablemd/core";

/** How one check came out. */
export type Outcome = "verified" | "limited" | "unavailable" | "failed" | "not_run";

/** One labelled fact with a fixed categorical reason. */
export interface Check {
  readonly outcome: Outcome;
  readonly reason: string;
}

export function check(outcome: Outcome, reason: string): Check {
  return { outcome, reason };
}

/** One canonical Prompt the history acknowledged, read back without a provider. */
export interface Acknowledged {
  readonly name: string;
  readonly record: PromptRecord;
}

/**
 * Every acknowledged Prompt a child's canonical journal holds, in order.
 *
 * Read through Core's own record parser, so this is the same reader a replay
 * uses; a record that does not read back is refused rather than skipped.
 */
export function* readAcknowledged(journal: string): Operation<Acknowledged[] | undefined> {
  if (!(yield* exists(journal))) {
    return undefined;
  }
  const prompts: Acknowledged[] = [];
  for (const line of (yield* readTextFile(journal)).split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      throw new Error("a canonical journal line does not read back as a durable event");
    }
    const event = parsed.value;
    if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parsePromptRecord(event.result.value);
    if (record === undefined) {
      throw new Error("a canonical Prompt record does not read back");
    }
    prompts.push({ name: event.description.name, record });
  }
  return prompts;
}

export function tokensOf(
  usage: PromptUsage | undefined,
  source: UsageReading["source"],
): ReportedTokens | null | undefined {
  const reading = usage?.readings.find(
    (candidate) => candidate.source === source && candidate.kind === "tokens",
  );
  return reading?.kind === "tokens" ? reading.tokens : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** What ACPX saved for one exact request, compared with the canonical response view. */
export interface AcpxAgreement {
  readonly association: Check;
  readonly agreement: Check;
}

/**
 * Compare a canonical value with the owning ACPX record and its generated user message.
 *
 * The record and message are located by the identities the canonical value
 * carries, never by equal counts, order or time. Agreement here proves the
 * runtime's transport and storage, not that a total covers the outer Prompt.
 */
export function* acpxAgreement(
  acpxRoot: string,
  usage: PromptUsage | undefined,
): Operation<AcpxAgreement> {
  const recordId = usage?.providerRecordId;
  const messageId = usage?.providerMessageId;
  if (recordId === undefined || messageId === undefined) {
    return {
      association: check("unavailable", "identity-unavailable"),
      agreement: check("not_run", "association-unavailable"),
    };
  }
  const path = join(acpxRoot, "sessions", `${encodeURIComponent(recordId)}.json`);
  if (!(yield* exists(path))) {
    return {
      association: check("unavailable", "acpx-record-unavailable"),
      agreement: check("not_run", "association-unavailable"),
    };
  }
  const saved = asRecord(JSON.parse(yield* readTextFile(path)));
  const messages = Array.isArray(saved?.messages) ? saved.messages : [];
  const owned = messages.some(
    (message) => asRecord(asRecord(message)?.User)?.id === messageId,
  );
  const perRequest = asRecord(saved?.request_token_usage);
  const entry = asRecord(perRequest?.[messageId]);
  if (!owned && entry === undefined) {
    return {
      association: check("failed", "message-not-in-record"),
      agreement: check("not_run", "association-unavailable"),
    };
  }
  const association = check(
    owned ? "verified" : "limited",
    owned ? "generated-message-in-owning-record" : "message-trimmed-from-record",
  );
  const response = tokensOf(usage, "response");
  if (entry === undefined || response === undefined || response === null) {
    return { association, agreement: check("unavailable", "no-saved-or-reported-response") };
  }
  const saidByAcpx: Record<string, number | undefined> = {
    inputTokens: count(entry.input_tokens),
    outputTokens: count(entry.output_tokens),
    cachedReadTokens: count(entry.cache_read_input_tokens),
    cachedWriteTokens: count(entry.cache_creation_input_tokens),
    thoughtTokens: count(entry.thought_tokens),
    totalTokens: count(entry.total_tokens),
  };
  const agrees = Object.entries(saidByAcpx).every(
    ([field, value]) => value === Reflect.get(response, field),
  );
  return {
    association,
    agreement: check(agrees ? "verified" : "failed", agrees ? "saved-copy-agrees" : "saved-copy-disagrees"),
  };
}

/** The independent native account of one outer Prompt, as selected counters. */
export interface NativePrompt {
  /** Internal model calls the native source recorded for this Prompt. */
  readonly calls: number;
  /** Native tool calls the main loop made. */
  readonly toolCalls: number;
  /** The whole outer Prompt's counters, where the source can say. */
  readonly outer?: Record<string, number>;
  /** The final internal request's counters, where the source can say. */
  readonly last?: Record<string, number>;
  /** Counters native subagent work recorded separately. */
  readonly subagent?: Record<string, number>;
  readonly subagentCalls: number;
}

/** A native session's Prompts, located by its confirmed native identity, and where they came from. */
export interface NativeSession {
  readonly prompts: NativePrompt[];
  /** The exact private source file, for the private support record only. */
  readonly source: string;
}

function add(into: Record<string, number>, from: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = count(from[key]);
    if (value !== undefined) {
      into[key] = (into[key] ?? 0) + value;
    }
  }
}

const CLAUDE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

function* findFile(root: string, accept: (name: string) => boolean, depth: number): Operation<string | undefined> {
  if (!(yield* exists(root))) {
    return undefined;
  }
  for (const name of yield* readdir(root)) {
    const path = join(root, name);
    if (accept(name)) {
      return path;
    }
    if (depth > 0 && !name.includes(".")) {
      const found = yield* findFile(path, accept, depth - 1);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function lines(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    if (line.trim().length === 0) {
      return [];
    }
    try {
      const parsed = asRecord(JSON.parse(line));
      return parsed === undefined ? [] : [parsed];
    } catch {
      return [];
    }
  });
}

/**
 * Claude Code's own transcript for one native session.
 *
 * A user entry that is a typed prompt rather than a tool result starts a
 * Prompt. Assistant entries repeat one API message per content block, so usage
 * counts once per message id. Sidechain entries and subagent transcripts are
 * the native account of subagent work, kept apart from the main loop.
 */
export function* claudeNative(home: string, sessionId: string): Operation<NativeSession | undefined> {
  const projects = join(home, ".claude", "projects");
  const file = yield* findFile(projects, (name) => name === `${sessionId}.jsonl`, 1);
  if (file === undefined) {
    return undefined;
  }
  const prompts: ClaudePrompt[] = [];
  for (const entry of lines(yield* readTextFile(file))) {
    const message = asRecord(entry.message);
    if (entry.type === "user" && entry.isSidechain !== true && entry.isMeta !== true) {
      const content = message?.content;
      const typed =
        typeof content === "string" ||
        (Array.isArray(content) &&
          content.some((block) => asRecord(block)?.type === "text") &&
          !content.some((block) => asRecord(block)?.type === "tool_result"));
      if (typed) {
        prompts.push({ calls: 0, toolCalls: 0, outer: {}, subagent: {}, seen: new Set(), subagentCalls: 0 });
      }
      continue;
    }
    const current = prompts.at(-1);
    if (entry.type !== "assistant" || current === undefined || message === undefined) {
      continue;
    }
    const id = typeof message.id === "string" ? message.id : undefined;
    const usage = asRecord(message.usage);
    const content = Array.isArray(message.content) ? message.content : [];
    current.toolCalls += entry.isSidechain === true
      ? 0
      : content.filter((block) => asRecord(block)?.type === "tool_use").length;
    if (id === undefined || usage === undefined || current.seen.has(id)) {
      continue;
    }
    current.seen.add(id);
    if (entry.isSidechain === true) {
      current.subagentCalls++;
      add(current.subagent, usage, CLAUDE_KEYS);
    } else {
      current.calls++;
      add(current.outer, usage, CLAUDE_KEYS);
    }
  }
  return {
    source: file,
    prompts: prompts.map(({ calls, toolCalls, outer, subagent, subagentCalls }) => ({
      calls,
      toolCalls,
      outer,
      ...(subagentCalls > 0 ? { subagent } : {}),
      subagentCalls,
    })),
  };
}

/** One Codex Prompt while its rollout is being read. */
interface CodexPrompt {
  calls: number;
  toolCalls: number;
  start: Record<string, number>;
  end: Record<string, number>;
  last?: Record<string, number>;
}

/** One Claude Prompt while its transcript is being read. */
interface ClaudePrompt {
  calls: number;
  toolCalls: number;
  outer: Record<string, number>;
  subagent: Record<string, number>;
  subagentCalls: number;
  readonly seen: Set<string>;
}

const CODEX_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

/**
 * Codex's own rollout for one native thread.
 *
 * Each `token_count` event carries both the running thread total and the last
 * request's reading. A started task starts a Prompt; the difference between the
 * running totals at its end and at the previous Prompt's end is the outer
 * Prompt's own total, and the last reading in it is its final request.
 */
export function* codexNative(home: string, threadId: string): Operation<NativeSession | undefined> {
  const sessions = join(home, ".codex", "sessions");
  const file = yield* findFile(sessions, (name) => name.endsWith(`${threadId}.jsonl`), 3);
  if (file === undefined) {
    return undefined;
  }
  let previousTotal: Record<string, number> = {};
  let runningTotal: Record<string, number> = {};
  const prompts: CodexPrompt[] = [];
  const entries = lines(yield* readTextFile(file));
  // A turn starts where the rollout says a task started; older rollouts mark
  // only the user message.
  const boundary = entries.some(
    (entry) => entry.type === "event_msg" && asRecord(entry.payload)?.type === "task_started",
  )
    ? "task_started"
    : "user_message";
  for (const entry of entries) {
    const payload = asRecord(entry.payload);
    if (entry.type === "event_msg" && payload?.type === boundary) {
      previousTotal = { ...runningTotal };
      prompts.push({ calls: 0, toolCalls: 0, start: previousTotal, end: previousTotal });
      continue;
    }
    const current = prompts.at(-1);
    if (current === undefined) {
      continue;
    }
    if (entry.type === "response_item" && typeof payload?.type === "string" && /call$/u.test(payload.type) && !/output$/u.test(payload.type)) {
      current.toolCalls++;
    }
    if (entry.type === "event_msg" && payload?.type === "token_count") {
      const info = asRecord(payload.info);
      const total = asRecord(info?.total_token_usage);
      const last = asRecord(info?.last_token_usage);
      if (total !== undefined) {
        const next: Record<string, number> = {};
        add(next, total, CODEX_KEYS);
        if (JSON.stringify(next) !== JSON.stringify(runningTotal)) {
          current.calls++;
        }
        runningTotal = next;
      }
      if (last !== undefined) {
        const reading: Record<string, number> = {};
        add(reading, last, CODEX_KEYS);
        current.last = reading;
      }
    }
    current.end = { ...runningTotal };
  }
  return {
    source: file,
    prompts: prompts.map((prompt) => {
      const outer: Record<string, number> = {};
      for (const key of CODEX_KEYS) {
        const end = prompt.end[key];
        if (end !== undefined) {
          outer[key] = end - (prompt.start[key] ?? 0);
        }
      }
      return {
        calls: prompt.calls,
        toolCalls: prompt.toolCalls,
        outer,
        ...(prompt.last === undefined ? {} : { last: prompt.last }),
        subagentCalls: 0,
      };
    }),
  };
}

/** The canonical response view, spelled in a native source's own counter names. */
function canonicalAs(agent: "claude" | "codex", tokens: ReportedTokens): Record<string, number> {
  const named: Record<string, number> = {};
  const put = (key: string, value: number | undefined) => {
    if (value !== undefined) {
      named[key] = value;
    }
  };
  if (agent === "claude") {
    put("input_tokens", tokens.inputTokens);
    put("output_tokens", tokens.outputTokens);
    put("cache_read_input_tokens", tokens.cachedReadTokens);
    put("cache_creation_input_tokens", tokens.cachedWriteTokens);
    return named;
  }
  // The Codex adapter subtracts cached input from native input before replying.
  put(
    "input_tokens",
    tokens.inputTokens === undefined ? undefined : tokens.inputTokens + (tokens.cachedReadTokens ?? 0),
  );
  put("cached_input_tokens", tokens.cachedReadTokens);
  put("output_tokens", tokens.outputTokens);
  put("reasoning_output_tokens", tokens.thoughtTokens);
  put("total_tokens", tokens.totalTokens);
  return named;
}

function sameOn(left: Record<string, number>, right: Record<string, number> | undefined): boolean {
  if (right === undefined) {
    return false;
  }
  const keys = Object.keys(left);
  return keys.length > 0 && keys.every((key) => left[key] === right[key]);
}

/**
 * Compare one acknowledged response view with the native account of the same Prompt.
 *
 * `limited` when the canonical value matches only the final internal request
 * of a Prompt that made more than one: a bound, not a total. A disagreement is
 * a documented limitation, never a reason to manufacture a total.
 */
export function nativeComparison(
  agent: "claude" | "codex",
  usage: PromptUsage | undefined,
  native: NativePrompt | undefined,
): Check {
  if (native === undefined) {
    return check("unavailable", "native-source-unavailable");
  }
  const response = tokensOf(usage, "response");
  if (response === undefined || response === null) {
    return check("unavailable", "no-reported-response");
  }
  const canonical = canonicalAs(agent, response);
  if (sameOn(canonical, native.outer)) {
    return check("verified", native.calls > 1 ? "matches-native-outer-total-multicall" : "matches-native-outer-total");
  }
  if (sameOn(canonical, native.last)) {
    return check("limited", "final-request-only");
  }
  return check("limited", "native-disagreement");
}
