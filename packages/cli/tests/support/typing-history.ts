import type { Operation } from "effection";
import { expect } from "@executablemd/test-support/expect";
import { projectSidekick } from "../../src/repl/sidekick/model.ts";
import { sidekickChatRows, sidekickTurnRows } from "../../src/repl/program.ts";
import type { ReplSidekickReading, ReplState, ReplView } from "../../src/repl/application.ts";
import {
  initialState,
  NO_AGENT,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../../src/repl/application.ts";
import { navigationOf } from "../../src/repl/navigation.ts";
import { NO_LIFECYCLE } from "../../src/repl/lifecycle.ts";
import type { ReplTerminalSize } from "../../src/repl/terminal.ts";
import { settledReading } from "./mounted-history.ts";
import type { MountedHistory } from "./mounted-history.ts";
import type { ReplPage } from "./repl-page.ts";
import { intoComposer, composerHolds, sidekickIdle } from "./screen-journeys.ts";

export function typingPayload(round: number, rounds: number, lines: number): string {
  return Array.from({ length: lines }, (_, at) => {
    const name = round === rounds - 1 ? "TAIL" : `R${String(round).padStart(3, "0")}`;
    const sentinel =
      at === 0
        ? "BEGIN"
        : at === Math.floor(lines / 2)
          ? "MIDDLE"
          : at === lines - 1
            ? "END"
            : "LINE";
    return `${name}-${sentinel}-${String(at).padStart(3, "0")} verified words `.padEnd(63, ".");
  }).join("\n");
}

export function* generateTypingHistory(
  page: ReplPage,
  rounds: number,
  lines: number,
  rich = false,
): Operation<MountedHistory> {
  for (let round = 0; round < rounds; round++) {
    const payload = typingPayload(round, rounds, lines);
    const code = `<Output>${payload}</Output>`;
    page.repl.fake.script({
      reply: `<Let as="code" select="code">\n\`\`\`xmd\n${code}\n\`\`\`\n</Let><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit /><Output>Submitted.</Output>`,
    });
    const settled =
      round === rounds - 1 ? "Settled TAIL." : `Settled R${String(round).padStart(3, "0")}.`;
    page.repl.fake.script({
      reply: rich
        ? `<Output>${"x".repeat(90)}
 
${settled} 界 é 🙂</Output>`
        : `<Output>${settled}</Output>`,
    });
    const prompts = page.repl.fake.prompts.length;
    const request = round === rounds - 1 ? "Ask TAIL" : `Ask R${String(round).padStart(3, "0")}`;
    yield* intoComposer(page);
    const before = page.screen().index;
    yield* page.type(request);
    yield* page.until(
      "the current request in Message",
      (one) => one.index > before && composerHolds(one, request),
    );
    yield* page.key("Enter");
    yield* page.until(
      "the settled round",
      (one) =>
        page.repl.fake.prompts.length === prompts + 2 && one.shows(settled) && sidekickIdle(one),
    );
  }
  const read = yield* settledReading(page.repl);
  expect(read.model.entries).toHaveLength(rounds);
  const chat = projectSidekick(read.chat);
  if (!chat.ok) {
    throw chat.error;
  }
  expect(chat.value.submits.filter((one) => one.settled && one.admitted)).toHaveLength(rounds);
  for (const [at, entry] of read.model.entries.entries()) {
    expect(entry.terminal?.status).toBe("ok");
    expect(entry.terminal?.output).toContain(typingPayload(at, rounds, lines));
  }
  return read;
}

export function typingReading(read: MountedHistory): ReplSidekickReading {
  const projected = projectSidekick(read.chat);
  if (!projected.ok) {
    throw projected.error;
  }
  const known = projected.value;
  return {
    chat: sidekickChatRows(known, undefined),
    turns: sidekickTurnRows(known, undefined),
    submits: known.submits.map((one) => ({
      conversation: one.conversation,
      response: one.response,
      ordinal: one.ordinal,
      entry: one.entry,
      source: one.source,
      settled: one.settled,
      admitted: one.admitted,
    })),
    busy: false,
    agent: "scribe",
    refusal: undefined,
    question: undefined,
    requested: undefined,
    verified: undefined,
    conversation: known.active,
    reading: known.active,
    current: true,
    availability: {
      chats: known.conversations.map((one) => one.id),
      sessions: [],
      refusal: undefined,
    },
  };
}

export function typingView(
  read: MountedHistory,
  size: ReplTerminalSize,
  state: ReplState = initialState(read.execution),
  reading = typingReading(read),
): ReplView {
  const view = viewFor(
    state,
    read.model,
    {
      output: "",
      question: undefined,
      expansion: "playing",
      pausable: false,
      running: false,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
      sidekick: reading,
    },
    size,
    "sidekick:message",
    navigationOf(read.model.checkpoints, "live"),
  );
  if (!view.ok) {
    throw view.error;
  }
  return withWorkspace(view.value, workspaceOf(read.model, reading));
}
