import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import type { ReplPage, PageKey } from "./support/repl-page.ts";
import {
  intoComposer,
  typed,
  draftText,
  openHistory,
  selectPane,
  openConfigure,
  replaceAgent,
  applyConfigure,
} from "./support/screen-journeys.ts";

function* completedKey(page: ReplPage, key: PageKey): Operation<void> {
  const before = page.screen().index;
  yield* page.key(key);
  yield* page.until("the completed key write", (one) => one.index > before);
}
import type { ReplView, ReplSidekickChatRow } from "../src/repl/application.ts";
import type { ReplAgentTurn } from "../src/repl/model.ts";
import type { ReplLiveTurn } from "../src/repl/agent.ts";
import { projectRepl } from "../src/repl/model.ts";
import {
  createChatPreparationStore,
  SIDEKICK_WINDOW,
  SESSIONS_WINDOW,
} from "../src/repl/application.ts";
import { createPlainFitStore } from "../src/repl/fitting.ts";
import { prepareFrame } from "../src/repl/program.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
import { OTHER_MOUNTED_AGENT, awaited } from "./support/mounted-repl.ts";
import { decodeLocation } from "../src/repl/route.ts";
import { settledReading } from "./support/mounted-history.ts";
import { useReplPage } from "./support/repl-page.ts";
import { generateTypingHistory, typingView } from "./support/typing-history.ts";

const WIDE = { columns: 160, rows: 36 };

describe("1048 — prepare only admitted chat descriptions", () => {
  it("constructs the admitted range over all passes independently of off-screen history", function* () {
    const counts: number[] = [];
    for (const rounds of [2, 12]) {
      yield* scoped(function* () {
        const page = yield* useReplPage({ size: WIDE });
        const read = yield* generateTypingHistory(page, rounds, 32);
        const view = typingView(read, WIDE);
        const renderer = yield* useReplRenderer(WIDE);
        const store = createChatPreparationStore(createPlainFitStore());
        const warm = yield* prepareFrame(renderer, view, undefined, store);
        if (!warm.ok) {
          throw warm.error;
        }
        const keys: string[] = [];
        const sessionKeys: string[] = [];
        const sessionBuild = store.sessions.materialize;
        store.sessions.materialize = (one, focused, claim) => {
          sessionKeys.push(one.key);
          return sessionBuild(one, focused, claim);
        };
        const build = store.materialize;
        store.materialize = (one, focused) => {
          keys.push(one.key);
          return build(one, focused);
        };
        const next = yield* prepareFrame(
          renderer,
          { ...view, state: { ...view.state, message: "x" } },
          undefined,
          store,
        );
        if (!next.ok) {
          throw next.error;
        }
        const window = next.value.admission.windows.get(SIDEKICK_WINDOW);
        const sequence = next.value.context.chatSequence;
        if (window === undefined || sequence === undefined) {
          throw new Error("The prepared chat has no admitted window.");
        }
        const admitted = sequence.rows
          .slice(window.from, window.from + window.count)
          .map((one) => one.key);
        const sessions = next.value.context.sessions;
        const sessionWindow = next.value.admission.windows.get(SESSIONS_WINDOW);
        if (sessions === undefined || sessionWindow === undefined) {
          throw new Error("The Transcript has no prepared window.");
        }
        const admittedSessions = sessions.rows
          .slice(sessionWindow.from, sessionWindow.from + sessionWindow.count)
          .map((one) => one.key);
        expect(sessionKeys).toEqual([...admittedSessions, ...admittedSessions]);
        console.log(
          JSON.stringify({
            rounds,
            sessionRows: sessions.rows.length,
            admittedSessions: admittedSessions.length,
            sessionDescriptions: sessionKeys.length,
          }),
        );
        expect(sessions).toBe(warm.value.context.sessions);
        expect(keys).toEqual([...admitted, ...admitted]);
        expect(sequence).toBe(warm.value.context.chatSequence);
        expect(window.from).toBeGreaterThan(32);
        counts.push(keys.length);
      });
    }
    expect(counts[1]).toBe(counts[0]);
  });
});

describe("1048 — selected chat preparation", () => {
  it("matches fresh preparation after changed source facts and keeps one geometry", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const read = yield* generateTypingHistory(page, 2, 32);
    const original = typingView(read, WIDE);
    const renderer = yield* useReplRenderer(WIDE);
    const cuts = createPlainFitStore();
    const retained = new Map<string, unknown>();
    const settle = cuts.settle;
    const keep = cuts.keep;
    cuts.keep = (text, room, size, pieces) => {
      retained.set(text, pieces);
      keep(text, room, size, pieces);
    };
    cuts.settle = (texts, room, size) => {
      for (const text of retained.keys()) {
        if (!texts.includes(text) || cuts.held(text, room, size) === undefined) {
          retained.delete(text);
        }
      }
      settle(texts, room, size);
    };
    const store = createChatPreparationStore(cuts);
    const reading = original.live.sidekick;
    if (reading === undefined) {
      throw new Error("The fixture did not produce a chat.");
    }
    const first = yield* store.prepare(original, renderer, 48);
    if (!first.ok) {
      throw first.error;
    }
    const inventory = retained.size;
    for (let edit = 0; edit < 100; edit++) {
      const edited = yield* store.prepare(
        { ...original, state: { ...original.state, message: String(edit) } },
        renderer,
        48,
      );
      expect(edited).toEqual(first);
      if (edited.ok) {
        expect(edited.value).toBe(first.value);
      }
      expect(retained.size).toBe(inventory);
    }
    for (let at = 0; at < 20; at++) {
      const size = [WIDE, { columns: 120, rows: 30 }, { columns: 72, rows: 20 }][at % 3];
      renderer.resize(size);
      const chat = reading.chat.map<ReplSidekickChatRow>((one, index) =>
        index === reading.chat.length - 1
          ? {
              ...one,
              kind: at % 2 === 0 ? "preview" : "reply",
              text: `revision-${at}`,
              hasOutput: true,
            }
          : one,
      );
      const changed = typingView(
        read,
        size,
        { ...original.state, message: "saved", draft: "draft" },
        {
          ...reading,
          chat,
          current: at % 3 !== 0,
          reading: at % 2 === 0 ? reading.reading : "other-chat",
        },
      );
      const room = size.columns === 72 ? 68 : 48;
      const warmed = yield* store.prepare(changed, renderer, room);
      const fresh = yield* createChatPreparationStore(createPlainFitStore()).prepare(
        changed,
        renderer,
        room,
      );
      expect(warmed).toEqual(fresh);
      expect(retained.size).toBeLessThanOrEqual(inventory + 1);
      if (warmed.ok) {
        expect(
          warmed.value.rows.some(
            (one) => one.kind === "text" && one.label.includes(`revision-${at - 1}`),
          ),
        ).toBe(false);
      }
    }
    renderer.resize(WIDE);
    const opened = yield* page.repl.repository.open(read.execution);
    const prefix = projectRepl(
      yield* opened.stream.readAll(),
      read.model.entries[0].checkpoints.at(-2)?.marker,
    );
    if (!prefix.ok) {
      throw prefix.error;
    }
    const retry: ReplSidekickChatRow = {
      ...reading.chat[0],
      key: "retry-example",
      kind: "incomplete",
      text: "equal text",
      failure: "stopped",
      retry: { conversation: reading.reading ?? "", message: 1 },
    };
    const variants = [
      typingView({ ...read, model: prefix.value }, WIDE, {
        ...original.state,
        route: { ...original.state.route, at: prefix.value.selection },
      }),
      original,
      typingView(read, WIDE, original.state, { ...reading, chat: [...reading.chat, retry] }),
      typingView(read, WIDE, original.state, {
        ...reading,
        chat: [...reading.chat, { ...retry, retry: undefined }],
      }),
      typingView(read, WIDE, original.state, {
        ...reading,
        chat: [
          ...reading.chat,
          { ...reading.chat[0], key: "equal-text-one", text: "equal text" },
          { ...reading.chat[0], key: "equal-text-two", text: "equal text" },
        ],
      }),
    ];
    for (const variant of variants) {
      const warmed = yield* prepareFrame(renderer, variant, undefined, store);
      const fresh = yield* prepareFrame(renderer, variant);
      expect(warmed.ok).toBe(true);
      if (warmed.ok && fresh.ok) {
        expect(warmed.value.context.chatSequence).toEqual(fresh.value.context.chatSequence);
        expect(warmed.value.admission).toEqual(fresh.value.admission);
      } else if (!fresh.ok) {
        throw fresh.error;
      }
    }
    const failed = yield* store.prepare(
      {
        ...original,
        live: {
          ...original.live,
          sidekick: { ...reading, chat: [{ ...reading.chat[0], text: "界" }] },
        },
      },
      renderer,
      1,
    );
    expect(failed.ok).toBe(false);
    expect(retained.size).toBe(0);
    const recovered = yield* store.prepare(original, renderer, 48);
    expect(recovered).toEqual(first);
  });
});

describe("1048 — generated retained output", () => {
  it("reads early, middle and tail output after resizing without consuming either draft", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const read = yield* generateTypingHistory(page, 2, 32, true);
    yield* intoComposer(page);
    yield* typed(page, "ab界");
    yield* completedKey(page, "ArrowLeft");
    const seen = new Set<string>();
    const sentinels = [
      "R000-BEGIN",
      "R000-MIDDLE",
      "R000-END",
      "TAIL-BEGIN",
      "TAIL-MIDDLE",
      "TAIL-END",
    ];
    for (const size of [WIDE, { columns: 120, rows: 30 }, { columns: 72, rows: 20 }]) {
      if (page.screen().size.columns !== size.columns) {
        yield* page.resize(size);
      }
      if (size.columns === 72) {
        yield* page.press("Sidekick", { onRow: "Entries" });
        yield* page.until("the routed Sidekick", (one) => one.shows("message the sidekick"));
      }
      const cell = page.screen().locate("Settled TAIL.", { rightOf: "message the sidekick" });
      const floor = page.screen().locate("message the sidekick").column;
      for (const direction of ["up", "down"] as const) {
        for (let step = 0; step < 100; step++) {
          const text = page
            .screen()
            .rows.map((row) => row.slice(floor))
            .join("\n");
          for (const sentinel of sentinels) {
            if (text.includes(sentinel)) {
              seen.add(sentinel);
            }
          }
          const before = page.screen().index;
          yield* page.wheel(direction, cell);
          yield* page.until("the completed scrolling write", (one) => one.index > before);
          if (direction === "up" && text.includes("R000-BEGIN")) {
            break;
          }
          if (direction === "down" && text.includes("Settled TAIL.")) {
            break;
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...sentinels].sort());
    yield* page.resize(WIDE);
    yield* page.type("!");
    yield* page.until("the saved middle Message caret", (one) => one.shows("ab!界"));
    yield* draftText(page, "draft", ["Tab", "Tab", "Tab", "Tab"]);
    yield* completedKey(page, "ArrowLeft");
    yield* openHistory(page);
    yield* page.key("Escape");
    yield* page.until("History closed", (one) => !one.shows("[close]"));
    yield* page.type("!");
    yield* page.until("the saved middle Draft caret", (one) => one.shows("draf!t"));
    const after = yield* settledReading(page.repl);
    expect(after).toEqual(read);
    expect(page.repl.fake.prompts).toHaveLength(4);
    yield* selectPane(page, "bindings");
    yield* page.press("Ask R000");
    yield* page.until(
      "the requested evaluated reply revealed",
      (one) =>
        one.shows("[Back to current chat]") &&
        one.found("Submitted.", { rightOf: "message the sidekick" }) > 0,
    );
    yield* page.press("[Back to current chat]");
    yield* openConfigure(page);
    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    yield* applyConfigure(page);
    yield* page.until(
      "the replacement's empty chat",
      (one) => one.shows("No messages yet.") && !one.shows("[refresh]"),
    );
    const replaced = yield* settledReading(page.repl);
    yield* page.press("Ask R000");
    yield* page.until(
      "the saved chat read-only",
      (one) => one.shows("[Back to current chat]") && !one.shows("message the sidekick"),
    );
    expect(page.screen().shows("Submitted.")).toBe(true);
    yield* page.press("[Back to current chat]");
    yield* intoComposer(page);
    yield* page.type("?");
    yield* page.until("the Message caret after returning to current", (one) => one.shows("ab!?界"));
    expect(page.screen().shows("draf!t")).toBe(true);
    expect(yield* settledReading(page.repl)).toEqual(replaced);
    expect(page.repl.fake.prompts).toHaveLength(4);
    yield* page.press("[exit]");
    yield* awaited("the journey's location", () => page.repl.outcome() !== undefined);
    const outcome = page.repl.outcome();
    if (outcome === undefined || !outcome.ok) {
      throw new Error("The journey did not return its location.");
    }
    const location = decodeLocation(outcome.value.location);
    if (!location.ok) {
      throw location.error;
    }
    expect(location.value.draft).toBe("draf!t");
    expect(location.value.at).toBeUndefined();
    expect(location.value.scopes).toEqual([]);
  });
});

describe("1048 — reuse Transcript facts", () => {
  it("invalidates consumed source facts while retaining only the current sequence", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const read = yield* generateTypingHistory(page, 2, 32);
    const original = typingView(read, WIDE);
    const store = createChatPreparationStore(createPlainFitStore()).sessions;
    const first = store.prepare(original, 48);
    for (let edit = 0; edit < 100; edit++) {
      expect(
        store.prepare(
          {
            ...original,
            focused: "sidekick:message",
            state: { ...original.state, message: String(edit), draft: "draft" },
          },
          48,
        ),
      ).toBe(first);
    }
    const sidekick = original.live.sidekick;
    if (sidekick === undefined) {
      throw new Error("The generated fixture has no Sidekick.");
    }
    const cases: ReplView[] = [];
    for (const change of [
      { title: "changed request" },
      { text: "streaming update", running: true },
      { state: "failed", failure: "failed update", failed: true },
      { key: "replacement-key" },
      { agent: "different agent", conversation: "another chat", turn: null },
      { sessionKey: "provider-session" },
    ]) {
      cases.push({
        ...original,
        live: {
          ...original.live,
          sidekick: {
            ...sidekick,
            turns: sidekick.turns.map((one, at) => (at === 0 ? { ...one, ...change } : one)),
          },
        },
      });
    }
    cases.push(
      { ...original, live: { ...original.live, sidekick: { ...sidekick, refusal: "unreadable" } } },
      {
        ...original,
        live: {
          ...original.live,
          sidekick: {
            ...sidekick,
            availability: { ...sidekick.availability, sessions: ["filter-choice"] },
          },
        },
      },
      {
        ...original,
        live: {
          ...original.live,
          sidekick: {
            ...sidekick,
            chat: sidekick.chat.map((one) =>
              one.kind === "person"
                ? { ...one, origin: { kind: "acp", attachment: "attachment" } }
                : one,
            ),
          },
        },
      },
      { ...original, state: { ...original.state, filtering: true } },
      {
        ...original,
        state: { ...original.state, route: { ...original.state.route, session: "absent" } },
      },
      { ...original, workspace: undefined },
    );
    for (const [at, changed] of cases.entries()) {
      const width = at % 2 === 0 ? 48 : 31;
      const cached = store.prepare(changed, width);
      const fresh = createChatPreparationStore(createPlainFitStore()).sessions.prepare(
        changed,
        width,
      );
      expect(cached).toEqual(fresh);
      expect(cached).not.toBe(first);
      expect(store.prepare(changed, width)).toBe(cached);
    }
    const liveTurn = {
      key: "entry-turn",
      entry: "entry-1",
      prompt: "entry request",
      state: "active" as const,
      text: "partial reply",
      agent: "entry agent",
      sessionKey: "entry-session",
      agentSessionId: undefined,
      status: undefined,
      stopReason: undefined,
      failure: undefined,
    };
    const live: ReplView = {
      ...original,
      live: {
        ...original.live,
        agent: {
          ...original.live.agent,
          turns: [liveTurn],
          slots: [
            {
              key: liveTurn.key,
              entry: liveTurn.entry,
              order: 1,
              durable: undefined,
              last: undefined,
            },
          ],
          requests: [
            {
              key: "permission",
              turn: liveTurn.key,
              toolCallId: "tool",
              title: "May I read?",
              kind: "read",
              choices: [],
            },
          ],
        },
      },
    };
    for (const changed of [
      live,
      {
        ...live,
        live: {
          ...live.live,
          agent: {
            ...live.live.agent,
            requests: [],
            turns: [
              {
                ...liveTurn,
                text: "completed reply",
                state: "terminal" as const,
                status: "completed" as const,
                stopReason: "finished",
              },
            ],
          },
        },
      },
      {
        ...live,
        state: { ...live.state, route: { ...live.state.route, surface: "entries" as const } },
        workspace: undefined,
      },
    ]) {
      expect(store.prepare(changed, 48)).toEqual(
        createChatPreparationStore(createPlainFitStore()).sessions.prepare(changed, 48),
      );
    }
    const notices: ReplLiveTurn["inputResults"] = [
      {
        type: "question_answer_result",
        questionId: "question",
        inputId: "input",
        result: { status: "invalid", reason: "response-format" },
      },
      {
        type: "permission_decision_result",
        permissionId: "permission",
        inputId: "decision",
        result: { status: "stale" },
      },
    ];
    const withNotice = {
      ...live,
      live: {
        ...live.live,
        agent: { ...live.live.agent, turns: [{ ...liveTurn, inputResults: notices }] },
      },
    };
    expect(store.prepare(withNotice, 48)).toEqual(
      createChatPreparationStore(createPlainFitStore()).sessions.prepare(withNotice, 48),
    );
    const recorded: ReplAgentTurn = {
      marker: "recorded-turn",
      entry: "entry-1",
      sequence: 1,
      name: "Prompt",
      input: "saved request",
      scope: "root",
      position: { path: undefined, generatedSource: undefined, offset: 0, line: 1, column: 1 },
      agent: "recorded agent",
      sessionKey: "saved-session",
      agentSessionId: undefined,
      status: "completed",
      stopReason: "finished",
      text: "saved reply",
      failure: undefined,
      error: undefined,
      configuration: undefined,
      permissions: [
        {
          toolCallId: "read",
          title: "Read file",
          kind: "read",
          options: [{ optionId: "yes", name: "Allowed", kind: "allow_once" }],
          outcome: "selected",
          selected: "yes",
        },
      ],
    };
    for (const turn of [
      recorded,
      {
        ...recorded,
        marker: "new-marker",
        input: "changed request",
        text: "changed reply",
        agent: "other",
        sessionKey: "other-session",
        failure: "failure",
      },
      {
        ...recorded,
        permissions: recorded.permissions.map((one) => ({
          ...one,
          selected: "no",
          title: "Changed title",
        })),
      },
    ]) {
      const changed = { ...original, model: { ...original.model, turns: [turn] } };
      expect(store.prepare(changed, 48)).toEqual(
        createChatPreparationStore(createPlainFitStore()).sessions.prepare(changed, 48),
      );
    }
    for (const size of [WIDE, { columns: 120, rows: 30 }, { columns: 72, rows: 20 }]) {
      const changed = { ...original, size };
      const sequence = store.prepare(changed, 31);
      expect(sequence).toEqual(
        createChatPreparationStore(createPlainFitStore()).sessions.prepare(changed, 31),
      );
      expect(sequence.rows.some((one) => one.label.includes("streaming update"))).toBe(false);
    }
    expect(store.prepare(original, 48)).toEqual(first);
  });
});
