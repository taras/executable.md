import { exists, readdir, readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { join, resolve } from "node:path";
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
  /** The input this occurrence retained: the text the turn delivered. */
  readonly input: string;
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
    const input = event.description.input;
    prompts.push({ name: event.description.name, input: typeof input === "string" ? input : "", record });
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
  /** Distinct native tool calls the main loop made, by their own identity. */
  readonly toolCalls: number;
  /** Distinct native read calls whose target is one of the run's private fixture files. */
  readonly fixtureReads: number;
  /** Distinct fixture files those reads covered. */
  readonly fixtureFilesRead: number;
  /** The whole outer Prompt's counters, where the source can say. */
  readonly outer?: Record<string, number>;
  /** The final internal request's counters, where the source can say. */
  readonly last?: Record<string, number>;
  /** Counters native subagent work recorded separately. */
  readonly subagent?: Record<string, number>;
  /** Native subagent requests and separately recorded subagent model calls. */
  readonly subagentCalls: number;
}

/**
 * One native Prompt while it is read, with what association needs.
 *
 * `userText` is only ever compared, inside this process, with the canonical
 * input this run itself delivered; it is never written anywhere.
 */
interface Reading {
  calls: number;
  readonly tools: Set<string>;
  readonly reads: Set<string>;
  readonly files: Set<string>;
  readonly subagents: Set<string>;
  subagentCalls: number;
  outer: Record<string, number>;
  subagent: Record<string, number>;
  last?: Record<string, number>;
  start: Record<string, number>;
  end: Record<string, number>;
  userText: string;
  readonly seen: Set<string>;
}

function reading(start: Record<string, number> = {}): Reading {
  return {
    calls: 0,
    tools: new Set(),
    reads: new Set(),
    files: new Set(),
    subagents: new Set(),
    subagentCalls: 0,
    outer: {},
    subagent: {},
    start,
    end: start,
    userText: "",
    seen: new Set(),
  };
}

/** A native session's Prompts, located by its confirmed native identity, and where they came from. */
export interface NativeSession {
  readonly prompts: readonly NativePrompt[];
  /** The exact private source file, for the private support record only. */
  readonly source: string;
  /**
   * The one native Prompt whose user turn carried exactly this delivered input.
   *
   * Exact or nothing: no Prompt, or more than one, is an association gap, never
   * a choice by position.
   */
  associate(input: string): NativePrompt | undefined;
}

function session(source: string, readings: readonly Reading[], summary: (reading: Reading) => NativePrompt): NativeSession {
  const prompts = readings.map(summary);
  return {
    source,
    prompts,
    associate(input) {
      const wanted = input.trim();
      if (wanted.length === 0) {
        return undefined;
      }
      const matches = readings.flatMap((entry, index) =>
        entry.userText.includes(wanted) ? [prompts[index]] : [],
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
  };
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

/** Claude Code's own names for delegating to a subagent. */
const CLAUDE_SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

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

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const text = asRecord(block)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/** The fixture files a native read may target, resolved against its working directory. */
export interface Fixture {
  readonly files: readonly string[];
}

function fixtureFile(fixture: Fixture | undefined, path: unknown, cwd: unknown): string | undefined {
  if (fixture === undefined || typeof path !== "string") {
    return undefined;
  }
  const resolved = resolve(typeof cwd === "string" ? cwd : "/", path);
  return fixture.files.find((file) => resolve(file) === resolved);
}

/**
 * Claude Code's own transcript for one native session.
 *
 * A user entry that is a typed prompt rather than a tool result starts a
 * Prompt. Assistant entries repeat one API message per content block, so usage
 * counts once per message id and a tool call once per tool-use id. Sidechain
 * entries are the native account of subagent work, kept apart from the main
 * loop; a `Task`/`Agent` tool use is the main loop asking for one.
 */
export function* claudeNative(
  home: string,
  sessionId: string,
  fixture?: Fixture,
): Operation<NativeSession | undefined> {
  const projects = join(home, ".claude", "projects");
  const file = yield* findFile(projects, (name) => name === `${sessionId}.jsonl`, 1);
  if (file === undefined) {
    return undefined;
  }
  const readings: Reading[] = [];
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
        const next = reading();
        next.userText = textOf(content);
        readings.push(next);
      }
      continue;
    }
    const current = readings.at(-1);
    if (entry.type !== "assistant" || current === undefined || message === undefined) {
      continue;
    }
    const id = typeof message.id === "string" ? message.id : undefined;
    const content = Array.isArray(message.content) ? message.content : [];
    if (entry.isSidechain !== true) {
      for (const [index, raw] of content.entries()) {
        const block = asRecord(raw);
        if (block?.type !== "tool_use") {
          continue;
        }
        const tool = typeof block.id === "string" ? block.id : `${id ?? "message"}#${index}`;
        current.tools.add(tool);
        const input = asRecord(block.input);
        if (block.name === "Read") {
          const target = fixtureFile(fixture, input?.file_path, "/");
          if (target !== undefined) {
            current.reads.add(tool);
            current.files.add(target);
          }
        }
        if (typeof block.name === "string" && CLAUDE_SUBAGENT_TOOLS.has(block.name)) {
          current.subagents.add(tool);
        }
      }
    }
    const usage = asRecord(message.usage);
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
  return session(file, readings, (entry) => ({
    calls: entry.calls,
    toolCalls: entry.tools.size,
    fixtureReads: entry.reads.size,
    fixtureFilesRead: entry.files.size,
    outer: entry.outer,
    ...(entry.subagentCalls > 0 ? { subagent: entry.subagent } : {}),
    subagentCalls: entry.subagents.size + entry.subagentCalls,
  }));
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
 * Prompt's own total, and the last reading in it is its final request. Tool
 * calls count once per call id; a completed command whose parsed form is a read
 * of a fixture file is a fixture read; `spawn_agent` is a native subagent.
 */
export function* codexNative(
  home: string,
  threadId: string,
  fixture?: Fixture,
): Operation<NativeSession | undefined> {
  const sessions = join(home, ".codex", "sessions");
  const file = yield* findFile(sessions, (name) => name.endsWith(`${threadId}.jsonl`), 3);
  if (file === undefined) {
    return undefined;
  }
  const entries = lines(yield* readTextFile(file));
  // A turn starts where the rollout says a task started; older rollouts mark
  // only the user message.
  const boundary = entries.some(
    (entry) => entry.type === "event_msg" && asRecord(entry.payload)?.type === "task_started",
  )
    ? "task_started"
    : "user_message";
  let runningTotal: Record<string, number> = {};
  const readings: Reading[] = [];
  for (const entry of entries) {
    const payload = asRecord(entry.payload);
    if (entry.type === "event_msg" && payload?.type === boundary) {
      readings.push(reading({ ...runningTotal }));
      continue;
    }
    const current = readings.at(-1);
    if (current === undefined) {
      continue;
    }
    if (entry.type === "response_item" && payload?.type === "message" && payload.role === "user") {
      current.userText += `${textOf(payload.content)}\n`;
    }
    if (
      entry.type === "response_item" &&
      typeof payload?.type === "string" &&
      /call$/u.test(payload.type) &&
      !/output$/u.test(payload.type)
    ) {
      const call = typeof payload.call_id === "string" ? payload.call_id : `call#${current.tools.size}`;
      current.tools.add(call);
      if (payload.name === "spawn_agent") {
        current.subagents.add(call);
      }
    }
    if (entry.type === "event_msg" && payload?.type === "item_completed") {
      const item = asRecord(payload.item);
      if (item?.type === "CommandExecution" && Array.isArray(item.parsed_cmd)) {
        const id = typeof item.id === "string" ? item.id : `command#${current.reads.size}`;
        for (const parsed of item.parsed_cmd) {
          const command = asRecord(parsed);
          const target = command?.type === "read" ? fixtureFile(fixture, command.path, item.cwd) : undefined;
          if (target !== undefined) {
            current.reads.add(id);
            current.files.add(target);
          }
        }
      }
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
        const latest: Record<string, number> = {};
        add(latest, last, CODEX_KEYS);
        current.last = latest;
      }
    }
    current.end = { ...runningTotal };
  }
  return session(file, readings, (entry) => {
    const outer: Record<string, number> = {};
    for (const key of CODEX_KEYS) {
      const end = entry.end[key];
      if (end !== undefined) {
        outer[key] = end - (entry.start[key] ?? 0);
      }
    }
    return {
      calls: entry.calls,
      toolCalls: entry.tools.size,
      fixtureReads: entry.reads.size,
      fixtureFilesRead: entry.files.size,
      outer,
      ...(entry.last === undefined ? {} : { last: entry.last }),
      subagentCalls: entry.subagents.size,
    };
  });
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
 * The native Prompt is the one whose user turn, in the session the canonical
 * record names, carried the exact input this run delivered; anything else is
 * an association gap rather than a comparison.
 *
 * `limited` when the canonical value matches only the final internal request
 * of a Prompt that made more than one: a bound, not a total. A disagreement is
 * a documented limitation, never a reason to manufacture a total.
 */
export function nativeComparison(
  agent: "claude" | "codex",
  usage: PromptUsage | undefined,
  session: NativeSession | undefined,
  input: string,
): Check {
  if (session === undefined) {
    return check("unavailable", "native-source-unavailable");
  }
  const native = session.associate(input);
  if (native === undefined) {
    return check("unavailable", "native-association-unavailable");
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
