/**
 * Tier MP — the Sidekick on the real screen, reached the way a person reaches it.
 *
 * Every row here runs `runReplProgram`: the product's repository, route
 * validation, session, Sidekick owner and mounted tree, with only the terminal
 * and the agent transport replaced. Nothing calls the owner, fills a reservation
 * or reduces an action directly — a control reached past the tree would prove
 * nothing about the control somebody actually has.
 *
 * The owner-level rows in `repl-sidekick-journey.test.ts` say what a
 * conversation does with what a provider says. These say that the command
 * acquires exactly one of them, for both storage shapes, without doing any work
 * — and that the screen a person is looking at is where its chat, its one input
 * and its two controls are.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "@executablemd/core";
import { expect } from "@executablemd/test-support/expect";
import type { Operation, Result } from "effection";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { ensure, scoped, sleep, spawn, withResolvers } from "effection";
import { API } from "@executablemd/runtime";
import { join } from "node:path";
import { until } from "effection";

import {
  activate,
  catalogShowing,
  closeCatalog,
  marked,
  openCatalog,
  settledEntry,
  appendGate,
  awaited,
  awaiting,
  click,
  clickAt,
  coordinateOf,
  draftText,
  DRAFT_PROMPT,
  focusDraft,
  focusedOn,
  focusedField,
  focusFormValue,
  focusMessage,
  focusOn,
  blockSays,
  draftTextIn,
  MESSAGE_PROMPT,
  saidByPerson,
  saidBySidekick,
  sidekickColumn,
  sidekickPaneIn,
  messageRows,
  messageText,
  messageTextIn,
  maybeDraftRow,
  mountedExecution,
  mountedReading,
  MOUNTED_AGENT,
  operationGate,
  OTHER_MOUNTED_AGENT,
  recordingTerminal,
  screenOf,
  readingAt,
  replay,
  resizeTo,
  paneShown,
  panePresented,
  rowsShow,
  saysAcross,
  sendMessage,
  settled,
  shows,
  typing,
  useMountedHost,
  useMountedRepl,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import type {
  AppendGate,
  MountedHost,
  MountedRepl,
  Terminal,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { agentReferenceEvents } from "./fixtures/repl/reference.ts";
import type { DurableEvent } from "@executablemd/durable-streams";
import { usePresenter } from "./fixtures/repl/presentation.ts";
import type { CheckpointFrame } from "./fixtures/repl/workspace-checkpoint.ts";
import {
  CHECKPOINT_ASKING,
  CHECKPOINT_BELOW,
  CHECKPOINT_MEDIUM,
  CHECKPOINT_NARROW,
  CHECKPOINT_QUESTION,
  CHECKPOINT_QUESTION_FORM,
  CHECKPOINT_SIZE,
  checkpointModel,
  checkpointSelected,
  checkpointState,
  commitCheckpoint,
  SEEDED_DRAFT,
  SEEDED_MESSAGE,
  seededState,
} from "./fixtures/repl/workspace-checkpoint.ts";
import { runReplProgram, sidekickChatRows, sidekickTurnRows } from "../src/repl/program.ts";
import type { ReplOutcome } from "../src/repl/program.ts";
import { projectSidekick, SAVED_WITHOUT_REPLY } from "../src/repl/sidekick/model.ts";
import { projectRepl } from "../src/repl/model.ts";
import {
  EARLIER,
  initialState,
  LATER,
  NO_AGENT,
  presentedDrawer,
  reduceRepl,
  SCROLL_DOWN,
  SCROLL_UP,
  viewFor,
} from "../src/repl/application.ts";
import type {
  ReplLive,
  ReplSidekickChatRow,
  ReplSidekickReading,
  ReplState,
} from "../src/repl/application.ts";

import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import {
  NARROW,
  workspaceConversationWidth,
  workspaceTranscriptWidth,
} from "../src/repl/layout.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  readSidekickRecords,
  SIDEKICK_FILE,
} from "../src/repl/sidekick/history.ts";
import type { ControlRecord, SidekickRecord } from "../src/repl/sidekick/history.ts";
import { renderReceipt } from "../src/repl/sidekick/controls.ts";

/**
 * Write an older single-file history for one execution.
 *
 * The shape every execution written before the pair existed is in: one file of
 * durable events, named for the execution, with no chat history beside it.
 */
function* legacyExecution(root: string, execution: string): Operation<string> {
  const path = join(root, `${execution}.jsonl`);
  yield* until(mkdir(root, { recursive: true }));
  // Empty, which is a history that has admitted nothing — the same thing a
  // fresh execution's entries file holds, in the shape that has no pair.
  yield* until(writeFile(path, ""));
  return path;
}

/** Every file this repository root holds, relative, sorted. */
function* held(root: string): Operation<string[]> {
  const found: string[] = [];
  const walk = function* (at: string, prefix: string): Operation<void> {
    for (const entry of yield* until(readdir(at, { withFileTypes: true }))) {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        yield* walk(join(at, entry.name), name);
        continue;
      }
      found.push(name);
    }
  };
  yield* walk(root, "");
  return found.sort();
}

/**
 * The conversation pane's own rows at one size.
 *
 * Sliced to that column, because a row of a shared width crosses all three and
 * a control found somewhere on one is usually a different control in a
 * different column. A narrow frame routes one outlet, so where this reading is
 * the routed one the pane *is* the frame — and the column slicer that reads a
 * conversation beside its composer cannot help a read-only chat, which has no
 * composer to find the column by.
 */
function conversationPane(rows: readonly string[], size: ReplTerminalSize): readonly string[] {
  const width = workspaceConversationWidth(size);
  return width === undefined ? rows : rows.map((line) => line.slice(size.columns - width));
}

/**
 * How the staged panes spell their own two tabs.
 *
 * In capitals, which is what a reader sees. A row reaching for one by the name
 * a person says it by is case-folded by {@link focusOn}; a row *reading* the
 * screen is not, and found neither.
 */
const PANE_TABS = Object.freeze({ bindings: "BINDINGS", sidekick: "SIDEKICK" });

/**
 * Whether the Transcript is narrowed to one conversation, and to which.
 *
 * One list with the conversations as its filter says which one it is narrowed to
 * on the selector itself — that is the control a person opened to choose it, and
 * it names the choice afterwards. `All conversations (filtered)` is a row *of*
 * the chooser, and choosing closes the chooser behind the choice, so it is not
 * on the screen once a choice has been made.
 *
 * Matched against a prefix of the key, because the selector gives up columns
 * for a name nothing in this product bounds: a provider's session key is longer
 * than this column, so what it draws is as much of it as fits and an ellipsis.
 */
function filteredTo(terminal: Terminal, key: string): boolean {
  const selector = sessionsColumn(terminal).find((line) => line.includes("\u25be"));
  if (selector === undefined) {
    return false;
  }
  for (let kept = key.length; kept >= 8; kept -= 1) {
    const shown = kept === key.length ? key : `${key.slice(0, kept)}\u2026`;
    if (selector.includes(shown)) {
      return true;
    }
  }
  return false;
}

/**
 * Open the Transcript's conversation filter, the way a person does.
 *
 * One list with every conversation as its filter is the reading this screen was
 * asked for, so the choices live behind the selector and are not on the screen
 * while it is closed. Nothing is chosen by opening it.
 */
function* openFilter(terminal: Terminal): Operation<void> {
  if (columnShows(sessionsColumn(terminal), "All conversations")) {
    return;
  }
  yield* activate(terminal, "All sessions");
  yield* awaiting(terminal, "the conversations being offered", (one) =>
    columnShows(sessionsColumn(one), "All conversations"),
  );
}

/**
 * Whether the catalog marks this row as the one being read.
 *
 * Asked in the catalog, which is where that marker is. The selection is a
 * standing fact about the reading and the catalog is a drawer over it, so this
 * opens the drawer for the marker and puts it away again — and the drawer hands
 * focus back to the control that opened it, which is why a row asking this asks
 * it after whatever it has to say about focus.
 */
function* markedEntry(terminal: Terminal, label: string): Operation<boolean> {
  yield* openCatalog(terminal);
  const found = marked(terminal, label);
  yield* closeCatalog(terminal);
  return found;
}

describe("Tier MP — one Sidekick per command, acquired without working", () => {
  it("M1: a fresh command shows its Sidekick, asks the agent nothing, and still runs entries", function* () {
    const repl = yield* useMountedRepl();

    // The pane is the Sidekick by default, which is its body being the one
    // drawn. Both tabs are named in that column's header either way, so the
    // reading is read from the pane rather than from the label.
    expect(panePresented(repl.terminal)).toBe("sidekick");
    expect(shows(repl.terminal, "BINDINGS")).toBe(true);
    // An execution nobody has said anything in.
    expect(shows(repl.terminal, "No messages yet.")).toBe(true);
    // And the box its messages go in, named so the row says which destination
    // it is.
    expect(shows(repl.terminal, MESSAGE_PROMPT.trim())).toBe(true);
    expect(shows(repl.terminal, "[send]")).toBe(true);

    // Acquiring it did no work: no runtime created, no session established, no
    // turn sent. Reopening a chat is free, and so is looking at one.
    expect(repl.fake.created).toEqual([]);
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
    expect(repl.fake.started).toBe(false);

    // Focus is the draft's, not the Sidekick's: the pane being the one showing
    // is a reading, and somebody who starts typing is typing their entry.
    //
    // Waited for rather than read off the first drawn frame. A startup focus
    // claim is resolved when the frame that carries it is built, and on a
    // loaded machine that is not always the frame that arrives first — so a
    // row that read it immediately reported "the Sidekick took the focus" for
    // a screen that had simply not caught up. Nothing is pressed either way.
    yield* awaiting(repl.terminal, "the draft holding focus with nothing pressed", (one) =>
      focusedField(one, DRAFT_PROMPT),
    );
    expect(focusedField(repl.terminal, MESSAGE_PROMPT)).toBe(false);

    // Selecting the Sidekick is what focuses its box, because that is somebody
    // asking to type into it.
    yield* activate(repl.terminal, "Sidekick");
    expect(focusedField(repl.terminal, MESSAGE_PROMPT)).toBe(true);
    // Still nothing asked of the agent by looking at it.
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
  });

  it("M1: a legacy execution is reopened unchanged, and publishes no pair", function* () {
    const host = yield* useMountedHost();
    // One execution in the older single-file shape, holding a real history —
    // which is what every execution written before the pair existed is.
    const execution = "legacy-one";
    const path = yield* legacyExecution(host.root, execution);
    const before = yield* until(readFile(path, "utf8"));
    const files = yield* held(host.root);

    const repl = yield* useMountedRepl({
      host,
      location: `xmd://repl/${execution}/entries`,
    });

    // It opened, and its Sidekick is there with nothing in it.
    expect(shows(repl.terminal, "No messages yet.")).toBe(true);
    // The file is exactly as it was and no pair was published: reopening a chat
    // writes nothing, and neither does looking at the Sidekick.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    yield* activate(repl.terminal, "Sidekick");
    expect(yield* held(host.root)).toEqual(files);
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
  });
});

/**
 * One entry whose run appends more than once and stops in the middle.
 *
 * Two evaluated blocks, so the run writes a record, keeps going and writes
 * another: holding the first append leaves an entry that is genuinely running
 * with a record genuinely in flight, and the second is the "later append" whose
 * destination the upgrade decides.
 */
const TWO_STEP_ENTRY = [
  "```js eval",
  'const first = "the held step";',
  "```",
  "",
  "<Output>{first}</Output>",
  "",
  "```js eval",
  'const second = "the released step";',
  "```",
  "",
  "<Output>{second}</Output>",
  "",
].join("\n");

/** Where a published pair's two files are. */
function pairPaths(root: string, execution: string): { entries: string; sidekick: string } {
  const directory = join(root, PAIRED_DIRECTORY, execution);
  return { entries: join(directory, ENTRIES_FILE), sidekick: join(directory, SIDEKICK_FILE) };
}

/**
 * The executions that have a published pair, or none at all.
 *
 * A missing `v1` directory and an empty one are the same answer here: nothing
 * has been published. Distinguishing them would be asserting on the order the
 * repository happens to create directories in.
 */
function* published(root: string): Operation<string[]> {
  try {
    return (yield* until(readdir(join(root, PAIRED_DIRECTORY)))).sort();
  } catch {
    return [];
  }
}

/** Every person message a chat history holds, in order. */
function chatMessages(records: readonly SidekickRecord[]): string[] {
  const said: string[] = [];
  for (const record of records) {
    if (record.kind === "message") {
      said.push(record.text);
    }
  }
  return said;
}

describe("Tier MP — the first explicit message is what upgrades the history", () => {
  it("M2: a legacy Send waits for the entry record in flight, then publishes one pair", function* () {
    const gate = appendGate();
    const host = yield* useMountedHost({ gate });
    const execution = "legacy-hot";
    const legacy = join(host.root, `${execution}.jsonl`);
    yield* until(mkdir(host.root, { recursive: true }));
    yield* until(writeFile(legacy, ""));

    // One reply, with no controls in it: what this row is about is the storage
    // handoff, so the turn has to happen exactly once and do nothing else.
    host.fake.script({ reply: "<Output>Noted.</Output>\n" });

    const repl = yield* useMountedRepl({ host, location: `xmd://repl/${execution}/entries` });
    const pair = pairPaths(host.root, execution);

    /**
     * A record of this entry's *run*, held open inside the host.
     *
     * The second one it writes rather than the first: the first is its
     * admission, and what this row is about is an entry already running when
     * the handoff starts. Registered before the entry is submitted and decided
     * at append time, because waiting for the admission to land and *then*
     * asking to hold would be racing the record it means to hold.
     */
    const running = gate.holdNext((path) => path === legacy && gate.reaching(legacy) >= 1);

    // An ordinary entry, admitted the ordinary way: typed into the draft and
    // run with Enter.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(TWO_STEP_ENTRY));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* running.started();

    // The entry is admitted and is still going: its source left the draft, and
    // the record it is writing has not landed. Waited for, because the
    // admission clears the draft in the frame after it and this row is about
    // *that* the source left rather than about which frame carried it away.
    yield* awaiting(
      repl.terminal,
      "the admitted source leaving the draft",
      (one) => draftText(one) === "",
    );

    // Now ask the Sidekick, through its own box and its own control.
    yield* activate(repl.terminal, "Sidekick");
    expect(focusedField(repl.terminal, MESSAGE_PROMPT)).toBe(true);
    yield* typing(repl.terminal, "explain");
    expect(messageText(repl.terminal).includes("explain")).toBe(true);
    // This screen has two Sends — the entry draft's and this composer's — so
    // the column the Sidekick's own pane begins at is what names which one.
    // Clicking the leftmost would submit a draft instead of sending a message.
    yield* click(repl.terminal, "[send]", sidekickColumn(repl.terminal));
    yield* settled(120);

    // Nothing has been asked of the provider, because the history it would be
    // written to does not exist yet: no session established and no turn sent.
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
    expect(running.released).toBe(false);
    // And no pair: the publication is what the message is waiting on.
    expect(yield* published(host.root)).toEqual([]);

    // The keyboard is nobody else's while all of that waits. The message box
    // still takes what is typed into it, and the draft is still the draft.
    yield* typing(repl.terminal, "!");
    expect(messageText(repl.terminal).includes("explain!")).toBe(true);
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "next");
    expect(draftText(repl.terminal)).toBe("next");

    // Let the entry's record finish.
    running.release();

    // One pair, published under this same execution.
    yield* awaited("the pair being published", () => gate.reaching(pair.sidekick) > 0);
    expect(yield* published(host.root)).toEqual([execution]);

    // The handoff waited for that record: the copied prefix holds it, and the
    // original is retained rather than removed.
    const retained = yield* until(readFile(legacy, "utf8"));
    const records = retained.split("\n").filter((line) => line.length > 0);
    expect(records.length).toBeGreaterThan(1);
    // The new file begins with that prefix, byte for byte: the handoff held
    // this entry's later records until the writer had moved, so none of them
    // reached the superseded file after its bytes were taken — and the pair
    // holds every record the entry wrote, in order.
    expect(yield* until(readFile(pair.entries, "utf8"))).toContain(retained);
    expect((yield* until(readFile(pair.entries, "utf8"))).startsWith(retained)).toBe(true);
    // Which is also what keeps the execution openable: the retained origin is
    // still exactly what it was fingerprinted from.
    expect((yield* host.repository.open(execution)).chat.form).toBe("paired");
    expect((yield* readSidekickRecords(pair.sidekick))[0]).toMatchObject({
      kind: "owner",
      execution,
      origin: {
        bytes: new TextEncoder().encode(retained).length,
        records: records.length,
      },
    });

    // The message ran once, and only once: one session established, one turn.
    yield* awaiting(repl.terminal, "the reply arriving", (one) => shows(one, "Noted."));
    expect(repl.fake.prompts).toHaveLength(1);
    expect(repl.fake.ensured).toHaveLength(1);
    // Exactly the text Send captured, not what the box held by the time the
    // storage handoff finished. The preservation rule itself is M4's; what this
    // row needs is that the turn carried the message that was sent.
    expect(repl.fake.prompts[0]).toContain("explain");
    expect(repl.fake.prompts[0]).not.toContain("explain!");
    // Saved once in the history too, and shown as the person's own message.
    expect(chatMessages(yield* readSidekickRecords(pair.sidekick))).toEqual(["explain"]);
    expect(saidByPerson(repl.terminal, "explain")).toBe(true);

    // And that same entry's later record reached the new file and no other: the
    // writer moved, and the object the running entry holds moved with it.
    const reachedLegacy = gate.reaching(legacy);
    yield* awaited(
      "the entry's next record reaching the published pair",
      () => gate.reaching(pair.entries) > 0,
    );
    expect(gate.reaching(legacy)).toBe(reachedLegacy);
    expect(yield* until(readFile(legacy, "utf8"))).toBe(retained);
  });
});

/** A reply that fills the shared draft and nothing else. */
const FILLING_REPLY = [
  '<Let as="code" select="code">',
  "````xmd",
  "Replaced by the reply.",
  "````",
  "</Let>",
  "<REPL.EntryInput>{code}</REPL.EntryInput>",
  "<Output>Filled it.</Output>",
  "",
].join("\n");

/** Hold the record that saves a person's message to this chat history. */
function heldMessageRecord(gate: AppendGate) {
  return gate.holdNext(
    (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"message"'),
  );
}

describe("Tier MP — the message box is cleared by the message that was saved", () => {
  it("M4: a delayed acknowledgement clears what was sent and keeps what came after", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.script({ reply: FILLING_REPLY });
    repl.fake.script({ reply: "<Output>Understood.</Output>\n" });

    // The draft is this person's: they typed in it, which pauses the Sidekick's
    // automatic replacement until they ask for something next.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");
    expect(draftText(repl.terminal)).toBe("mine");

    // The record that saves the message, held open before it is asked for.
    const saving = heldMessageRecord(gate);
    yield* sendMessage(repl, "ask");
    yield* saving.started();

    // Both texts move on while the save is in flight. The box first, which
    // stays editable while the Sidekick is working.
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "!");
    expect(messageText(repl.terminal).includes("ask!")).toBe(true);
    // Then the draft, which is a newer claim on it than the message was.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "X");
    expect(draftText(repl.terminal)).toBe("mineX");

    saving.release();
    yield* awaiting(repl.terminal, "the reply arriving", (one) => shows(one, "Understood."));

    // What was saved and what was sent are the text Send captured, not what the
    // box held by the time the record landed.
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["ask"]);
    expect(repl.fake.prompts[0]).toContain("ask");
    expect(repl.fake.prompts[0]).not.toContain("ask!");

    // And both newer texts survive: the message that was sent cleared its own
    // revision and nothing else.
    expect(messageText(repl.terminal).includes("ask!")).toBe(true);
    expect(draftText(repl.terminal)).toBe("mineX");

    // The newer draft edit still owns the draft, so the reply's fill was
    // refused rather than overwriting what somebody is typing — and the reply
    // was told so.
    expect(repl.fake.prompts[1] ?? "").toContain("taken the shared draft over");
    expect(draftText(repl.terminal)).toBe("mineX");
  });

  it("M4: control — with nothing typed after it, the same message clears the box", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.script({ reply: FILLING_REPLY });
    repl.fake.script({ reply: "<Output>Understood.</Output>\n" });

    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");

    // The same hold, released with nothing typed in between: the revisions the
    // acknowledgement names are still the current ones.
    const saving = heldMessageRecord(gate);
    yield* sendMessage(repl, "ask");
    yield* saving.started();
    saving.release();

    yield* awaiting(repl.terminal, "the reply arriving", (one) => shows(one, "Understood."));

    // The box is empty, because the history holds what was in it.
    expect(messageText(repl.terminal).includes("ask")).toBe(false);
    // And the takeover this explicit instruction released let the fill through
    // — which is only true because the root applied the acknowledgement before
    // the reply that came straight back asked to fill.
    expect(repl.fake.prompts[1] ?? "").toContain("Entry input updated.");
    expect(repl.fake.prompts[1] ?? "").not.toContain("taken the shared draft over");
    expect(draftText(repl.terminal)).toContain("Replaced by the reply.");
  });
});

describe("Tier MP — a working Sidekick, and what reaches the screen while it works", () => {
  it("M5: while generation is held, Stop is the control and Send cannot start a second cycle", function* () {
    const repl = yield* useMountedRepl();
    // Generation that has been accepted and is saying nothing yet.
    repl.fake.script({ held: true, reply: "<Output>Done.</Output>\n" });

    // Two activations in one chunk: one burst, which is the only way to ask for
    // a second cycle before the first has remounted the row. The reservation is
    // taken synchronously by the reduction, so the second finds it held.
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "ask");
    repl.terminal.feed("\r\r");
    yield* repl.fake.holdingTurns(1);

    // One turn, and one message in the history: the second Enter asked for a
    // cycle that was already taken.
    expect(repl.fake.prompts).toHaveLength(1);
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["ask"]);

    // Working, and the pane says so in its own status row. Send is gone —
    // there is no admitted activation target for a second cycle — and Stop is
    // there.
    expect(saidBySidekick(repl.terminal, "working")).toBe(true);
    expect(shows(repl.terminal, "[stop]")).toBe(true);
    // Asked of this pane rather than of the whole screen: the entry draft keeps
    // its own Send beside it, and the two are two destinations with two
    // controls. What must be gone is *this* pane's.
    expect(rowsShow(paneColumn(repl.terminal), "[send]")).toBe(false);

    // And the box is still a box: somebody composing their next question while
    // a reply comes back is the ordinary case.
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "then this");
    expect(messageText(repl.terminal).includes("then this")).toBe(true);

    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the reply arriving", (one) => shows(one, "Done."));
    // Finishing sends nothing: text prepared while busy is still only prepared.
    expect(messageText(repl.terminal).includes("then this")).toBe(true);
    expect(repl.fake.prompts).toHaveLength(1);
    expect(shows(repl.terminal, "[send]")).toBe(true);
  });

  it("M5: the first reply appears while its follow-up is held, with nothing pressed", function* () {
    const repl = yield* useMountedRepl();
    // A response that says something *and* reads something: the Output is the
    // reply a person is answered with, and the read is what owes a next turn.
    repl.fake.script({
      reply: ["<Output>First answer.</Output>", "<REPL.Bindings />", ""].join("\n"),
    });
    // That next turn, held: generation in flight with the reply before it
    // already acknowledged.
    repl.fake.script({ held: true, reply: "<Output>Second answer.</Output>\n" });

    yield* sendMessage(repl, "ask");
    yield* repl.fake.holdingTurns(1);
    // Nothing is typed, clicked or submitted from here, and this is what says
    // so: a claim about the screen updating on its own is only a claim if no
    // keystroke could have caused it.
    const fed = repl.terminal.fed;

    // The reply has to arrive while the job that produced it is still running,
    // because the only thing that knows it arrived is the Sidekick.
    yield* awaiting(
      repl.terminal,
      "the acknowledged first reply arriving with no keystroke",
      (one) => saidBySidekick(one, `First answer.`),
    );
    expect(repl.terminal.fed).toBe(fed);
    // Still working, because the turn its read owes has not come back.
    expect(shows(repl.terminal, "[stop]")).toBe(true);
    expect(shows(repl.terminal, "Second answer.")).toBe(false);
    // And the message job is still the one in flight: no second cycle started.
    expect(repl.fake.prompts).toHaveLength(2);

    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the follow-up answering", (one) =>
      saidBySidekick(one, `Second answer.`),
    );
    expect(repl.fake.prompts).toHaveLength(2);
    expect(shows(repl.terminal, "[send]")).toBe(true);
  });

  it("M5: control — an ordinary entry's own progress reaches the screen with no further key", function* () {
    const repl = yield* useMountedRepl();

    // One ordinary entry, admitted the ordinary way, and then nothing.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(TWO_STEP_ENTRY));
    yield* settled(60);
    repl.terminal.feed("\r");

    // Its output arrives without another keystroke: the entry's own
    // notifications wake the loop, and they are not the Sidekick's.
    yield* awaiting(repl.terminal, "the entry's output arriving with no keystroke", (one) =>
      shows(one, "the released step"),
    );
    // And no Sidekick work happened at all.
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
  });
});

/** The three drawable profiles this slice is mounted at. */
const PROFILES: readonly ReplTerminalSize[] = [
  { columns: 160, rows: 36 },
  { columns: 120, rows: 30 },
  { columns: 72, rows: 20 },
];

/** Below the minimum, which is the refusal rather than a smaller screen. */
const TOO_SMALL: ReplTerminalSize = { columns: 60, rows: 15 };

describe("Tier MP — the Sidekick at every size it is drawn at", () => {
  it("M7: all three profiles keep both texts, the footer's seven rows and one body", function* () {
    const repl = yield* useMountedRepl();

    // Both destinations, each with its own text. Short, because the medium
    // profile's right pane is narrow and a field draws one row: a longer value
    // would be truncated by the pane, which is a fact about the pane rather
    // than about the text surviving.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "note");
    // Activated explicitly, which is both what focuses the box and what makes
    // the Sidekick a *route* — the narrow profile has one outlet and reaches it
    // only when the route says so.
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "ask");

    for (const size of PROFILES) {
      const rows = yield* readingAt(repl.terminal, size);
      const drawn = rows();

      // The footer is this screen's own rows at the bottom of the frame: the
      // way out is in that band wherever this size puts it, and the frame is
      // exactly as tall as the size asked for.
      expect(drawn.slice(footerRow(drawn)).some((line) => line.includes("[exit]"))).toBe(true);
      expect(drawn.length).toBe(size.rows);

      // The Sidekick's own text is in the pane this route is reading, at every
      // size — one body and one message box, not one per column.
      expect(messageTextIn(drawn).includes("ask")).toBe(true);
      expect(drawn.filter((line) => line.includes(MESSAGE_PROMPT)).length).toBe(1);
      // And one Send in that pane. The entry draft keeps its own beside it —
      // two destinations, two controls — so this counts the pane's rather than
      // the screen's.
      expect(sidekickPaneIn(drawn).filter((line) => line.includes("[send]")).length).toBe(1);

      if (size.columns > NARROW.columns) {
        // A shared width draws the selected work beside the chat, so the
        // entry's own draft is there to read as well.
        expect(blockSays(draftTextIn(drawn), "note")).toBe(true);
        continue;
      }
      // A narrow frame routes one outlet, and this route is reading the
      // Sidekick — so the draft is in no cell of it, which is not the same as
      // lost. Going back to the entries is how a person reaches it, and it is
      // still holding what they typed; then back here, where the chat's text is
      // still holding too. Both are facts about the reading rather than about
      // the frame, which is the whole of this row's claim.
      expect(drawn.some((line) => line.includes(DRAFT_PROMPT))).toBe(false);
      yield* openCatalog(repl.terminal);
      yield* closeCatalog(repl.terminal);
      yield* awaiting(repl.terminal, "the draft back on the narrow outlet", (one) =>
        blockSays(draftTextIn(screenOf(one)), "note"),
      );
      // And the chat's own text is holding too, read where there is a column
      // for it. Reaching the entries is what cleared the Sidekick route, and a
      // narrow frame heads no shared column — so there is no tab on it to ask
      // for that reading back with, which is the routing this size does rather
      // than anything happening to the text.
      const recovered = yield* readingAt(repl.terminal, PROFILES[0]);
      expect(messageTextIn(recovered()).includes("ask")).toBe(true);
      expect(blockSays(draftTextIn(recovered()), "note")).toBe(true);
    }
  });

  it("M7: selecting Bindings removes the Sidekick's body and its input targets", function* () {
    const repl = yield* useMountedRepl();
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "my question");

    // Bindings is a pane, not a reading: selecting it takes the Sidekick's body
    // away, and with it every target somebody could type or send into.
    yield* activate(repl.terminal, "Bindings");
    const onBindings = yield* readingAt(repl.terminal, repl.terminal.size);
    expect(paneShown(onBindings())).toBe("bindings");
    expect(rowsShow(onBindings(), MESSAGE_PROMPT)).toBe(false);
    // The pane's own Send, not the screen's: the entry draft is in a different
    // column and keeps the control that belongs to it.
    expect(rowsShow(paneColumn(repl.terminal), "[send]")).toBe(false);
    // The draft is still the draft, because it is not in that pane.
    expect(blockSays(draftTextIn(onBindings()), "my entry")).toBe(true);

    // And going back brings the message with it: the text is process-local and
    // is not thrown away by looking at something else.
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message coming back", (one) =>
      messageText(one).includes("my question"),
    );
  });

  it("M7: a default Sidekick shrinks to narrow Entries, and an explicit one stays", function* () {
    const repl = yield* useMountedRepl();
    // Nothing has been activated, so the route names no view: the right pane is
    // the Sidekick by default, which is a reading rather than a route.
    expect(panePresented(repl.terminal)).toBe("sidekick");

    // Narrow routes one outlet, and with no explicit view it is Entries.
    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    expect(rowsShow(narrow(), "Entries")).toBe(true);
    expect(rowsShow(narrow(), MESSAGE_PROMPT)).toBe(false);
    // The Sidekick's own Send is gone with its pane. The entry draft keeps the
    // one that belongs to it — this outlet is the Draft's — so this asks about
    // the pane that was routed away rather than about the screen.
    expect(paneShown(narrow())).toBe("bindings");

    // Back out, and ask for the Sidekick explicitly. That is a route, so it
    // survives the shrink this time.
    yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "kept");

    const again = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    expect(messageTextIn(again()).includes("kept")).toBe(true);

    // And expanding gives the two panes back without losing where somebody was.
    const expanded = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    expect(paneShown(expanded())).toBe("sidekick");
    expect(messageTextIn(expanded()).includes("kept")).toBe(true);
  });

  it("M7: an older entry stays frozen while the Sidekick works, and Bindings still reads it", function* () {
    const repl = yield* useMountedRepl();

    // One ordinary entry of this person's, run and settled.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(TWO_STEP_ENTRY));
    yield* settled(60);
    repl.terminal.feed("\r");
    // Settled, read from the rail. The catalog's `[ok]` row is in a drawer
    // nobody has opened, and what this needs is that the entry is done.
    yield* awaiting(repl.terminal, "the released step", (one) => shows(one, "the released step"));
    yield* settledEntry(repl.terminal, 1, "ok");

    // Selected, so the reading beside the catalog is that entry's own.
    // Chosen in the catalog, which is where this screen keeps those rows: a
    // drawer over the reading, opened to point at one, and the choice closes it.
    yield* openCatalog(repl.terminal);
    yield* click(repl.terminal, "1.");
    yield* awaiting(
      repl.terminal,
      "the catalog closing behind the choice",
      (one) => !catalogShowing(one),
    );

    // A reply that runs a second entry. The chat and the catalog both move;
    // the position somebody is reading does not.
    repl.fake.script({
      reply: [
        '<Let as="code" select="code">',
        "````xmd",
        "```js eval",
        'const second = "the second entry";',
        "```",
        "",
        "<Output>{second}</Output>",
        "````",
        "</Let>",
        "<REPL.EntryInput>{code}</REPL.EntryInput>",
        "<REPL.Submit />",
        "",
      ].join("\n"),
    });
    repl.fake.script({ reply: "<Output>Both ran.</Output>\n" });

    yield* sendMessage(repl, "run two");
    yield* awaiting(repl.terminal, "the second entry being reported", (one) =>
      saidBySidekick(one, `Both ran.`),
    );

    // The catalog grew and the chat updated, and the selection is where it was.
    expect(yield* markedEntry(repl.terminal, "1.")).toBe(true);
    expect((yield* mountedReading(repl)).model.entries).toHaveLength(2);
    // The reading is still the first entry's: a current message does not move
    // somebody off the position they were reading.
    expect(shows(repl.terminal, "the released step")).toBe(true);

    // Bindings still switches, and what it reads is still that same entry.
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(
      repl.terminal,
      "the inspector coming back",
      (one) => panePresented(one) === "bindings",
    );
    expect(yield* markedEntry(repl.terminal, "1.")).toBe(true);
    expect(shows(repl.terminal, "the released step")).toBe(true);
    expect(shows(repl.terminal, MESSAGE_PROMPT)).toBe(false);

    // And back to the Sidekick, with the chat it had.
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the chat coming back", (one) =>
      saidBySidekick(one, `Both ran.`),
    );
    expect(saidByPerson(repl.terminal, "run two")).toBe(true);
  });

  it("M7: a terminal below the minimum refuses, and recovers with both texts", function* () {
    const repl = yield* useMountedRepl();
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "my question");

    // Too small to draw: a refusal, not a smaller screen.
    const from = repl.terminal.presented.length;
    repl.terminal.resized(TOO_SMALL);
    yield* awaiting(repl.terminal, "the refusal this size draws", () =>
      rowsShow(replay(repl.terminal.presented.slice(from)), `${NARROW.columns}x`),
    );
    const refused = replay(repl.terminal.presented.slice(from));
    expect(rowsShow(refused, MESSAGE_PROMPT)).toBe(false);
    // A refusal is the whole of its own screen: no control of any pane's is on
    // it, the draft's own Send included.
    expect(rowsShow(refused, "[send]")).toBe(false);

    // And back: nothing about either text was a property of the frame.
    const recovered = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    expect(blockSays(draftTextIn(recovered()), "my entry")).toBe(true);
    expect(messageTextIn(recovered()).includes("my question")).toBe(true);
  });
});

/**
 * A reply that prepares an entry whose preflight suspends, and submits it.
 *
 * The entry's one element is a component read from a file this case gates, so
 * the preflight has somewhere to wait: between the reservation being taken and
 * the entry actually starting, which is the window the start check exists for.
 */
const GATED_ENTRY_REPLY = [
  '<Let as="entry" select="code">',
  "```md",
  "<GateThing />",
  "```",
  "</Let>",
  "<REPL.EntryInput>{entry}</REPL.EntryInput>",
  "<REPL.Submit />",
  "",
].join("\n");

/**
 * One mounted message whose Submit waits in preflight, with or without an edit.
 *
 * Returns the entries the execution actually admitted, which is what both arms
 * are about: the reserved source is still exactly what was reserved, and
 * whether it becomes an entry depends on whether anybody still wants it.
 */
function* submittedUnderEdit(edit: boolean): Operation<{
  readonly entries: readonly string[];
  /** The draft once the response has finished. */
  readonly draft: string;
  /** What the draft held the moment it was edited, where this arm edits it. */
  readonly edited: string | undefined;
}> {
  const directory = yield* useTemporary("xmd-883-mounted-preflight-");
  yield* until(writeFile(join(directory, "GateThing.md"), "The reserved entry ran.\n"));

  // The component's own file read, held open. A real contextual Api boundary,
  // and the one place the entry's preflight genuinely suspends.
  const reached = withResolvers<void>();
  const allow = withResolvers<void>();
  // Released at the end whatever happened, so a failing arm leaves no latch.
  yield* ensure(() => allow.resolve());
  let first = true;
  yield* API.Fs.around({
    *readTextFile([path], next): Operation<string> {
      if (first && path.endsWith("GateThing.md")) {
        first = false;
        reached.resolve();
        yield* allow.operation;
      }
      return yield* next(path);
    },
  });

  const host = yield* useMountedHost({ includes: [directory] });
  host.fake.script({ reply: GATED_ENTRY_REPLY });
  host.fake.script({ reply: "<Output>Done.</Output>\n" });
  const repl = yield* useMountedRepl({
    host,
  });

  yield* sendMessage(repl, "run this");
  yield* reached.operation;

  let edited: string | undefined;
  if (edit) {
    // Through the mounted input, while the preflight is held: this is somebody
    // typing into the shared draft after the reply reserved it. They are typing
    // *after* the fill the same reply made, so what they end up owning is that
    // source with their own text on the end of it.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine now");
    edited = draftText(repl.terminal);
    expect(edited).toContain("mine now");
  }

  allow.resolve();
  yield* awaiting(repl.terminal, "the response completing", (one) => shows(one, "Done."));

  const read = yield* mountedReading(repl);
  return {
    entries: read.model.entries.map((entry) => entry.key),
    draft: draftText(repl.terminal),
    edited,
  };
}

describe("Tier MP — a reply's Submit is held to the draft as it is when its entry starts", () => {
  it("M-P2: a Draft edit during preflight admits no stale entry, and the edit survives", function* () {
    const settledRun = yield* submittedUnderEdit(true);

    // Nothing was admitted. The reserved source is still exactly what was
    // reserved, and submitting it now would submit something other than what
    // the draft says while discarding the edit that replaced it.
    expect(settledRun.entries).toEqual([]);
    // And the newer text is still theirs, exactly as they left it: a refusal
    // clears nothing, because nothing of theirs was admitted.
    expect(settledRun.draft).toBe(settledRun.edited);
    expect(settledRun.draft).toContain("mine now");
  });

  it("M-P2: control — an unchanged Draft admits the requested entry once", function* () {
    const settledRun = yield* submittedUnderEdit(false);

    // The same held preflight, with nobody typing: the reservation is still the
    // one everybody wants, so it becomes exactly one entry.
    expect(settledRun.entries).toEqual(["entry-1"]);
    // Admitted means consumed: the draft that became it is finished.
    expect(settledRun.draft).toBe("");
  });
});

/** The one schema these rows ask with: a choice, and a reason long enough to mean it. */
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    message: { type: "string", minLength: 4 },
  },
  required: ["decision", "message"],
  additionalProperties: false,
} as const;

/** One reply that asks, with its schema as the declarative data it must be. */
function askingReply(
  body: string,
  schema: Readonly<Record<string, unknown>> = REVIEW_SCHEMA,
): string {
  return `<Elicit schema={${JSON.stringify(schema)}} as="answer">${body}</Elicit>\n`;
}

/** An entry that asks a question of its own and waits for it. */
const ENTRY_ASKS = [
  "```js eval",
  'const shape = {"type":"object","properties":{"ok":{"type":"string","enum":["yes"]}},' +
    '"required":["ok"],"additionalProperties":false};',
  "```",
  "",
  '<Elicit schema={shape} as="said">The entry is asking.</Elicit>',
  "",
].join("\n");

/** Hold the record that files the Sidekick's question before anybody is asked. */
function heldElicitIntent(gate: AppendGate) {
  return gate.holdNext(
    (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"component":"Elicit"'),
  );
}

describe("Tier MQ — a Sidekick question announces itself and takes nothing over", () => {
  it("MQ1: the notice arrives with nothing pressed, and only opening shows the form", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.script({ reply: askingReply("Approve the plan?") });
    repl.fake.script({ reply: "<Output>Noted.</Output>\n" });

    // The record that files this question, held open before the question is
    // published: the intent goes down before anybody is asked, so holding it
    // holds the asking itself.
    const filing = heldElicitIntent(gate);

    // One ordinary entry of this person's, so there is a History position and a
    // catalog row for the arrival below to leave alone.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(TWO_STEP_ENTRY));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* settledEntry(repl.terminal, 1, "ok");
    // Chosen in the catalog, which is where this screen keeps those rows: a
    // drawer over the reading, opened to point at one, and the choice closes it.
    yield* openCatalog(repl.terminal);
    yield* click(repl.terminal, "1.");
    yield* awaiting(
      repl.terminal,
      "the catalog closing behind the choice",
      (one) => !catalogShowing(one),
    );

    // Then the message that will ask, sent from the Sidekick's own box.
    yield* sendMessage(repl, "review it");
    yield* filing.started();

    // And now somebody walks away from the Sidekick: Bindings selected, an
    // entry being read, their own text in the draft.
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(
      repl.terminal,
      "Bindings being selected",
      (one) => panePresented(one) === "bindings",
    );
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");
    expect(draftText(repl.terminal)).toBe("mine");

    // Nothing is pressed from here. The question has to announce itself.
    const fed = repl.terminal.fed;
    filing.release();
    yield* awaiting(repl.terminal, "the question announcing itself with no keystroke", (one) =>
      shows(one, `${PANE_TABS.sidekick} (question)`),
    );
    expect(repl.terminal.fed).toBe(fed);

    // It took nothing over. The tab is still Bindings, focus is still the
    // draft, both texts are still theirs, and the entry they were reading is
    // still the one selected.
    expect(panePresented(repl.terminal)).toBe("bindings");
    expect(focusedField(repl.terminal, DRAFT_PROMPT)).toBe(true);
    expect(draftText(repl.terminal)).toBe("mine");
    expect(yield* markedEntry(repl.terminal, "1.")).toBe(true);
    // And no form is open: arrival opens no drawer.
    expect(shows(repl.terminal, "[submit]")).toBe(false);

    // Selecting the Sidekick shows the notice and the way in, and still opens
    // nothing — opening is a separate deliberate act.
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the notice in the pane", (one) =>
      shows(one, "[answer sidekick]"),
    );
    expect(shows(repl.terminal, "[answer sidekick]")).toBe(true);
    expect(shows(repl.terminal, "[submit]")).toBe(false);
    expect(messageText(repl.terminal).includes("review it")).toBe(false);

    // This act, and only this act, opens the form.
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form opening", (one) => shows(one, "[submit]"));
    expect(shows(repl.terminal, "Approve the plan?")).toBe(true);
    expect(shows(repl.terminal, "decision: approve | reject")).toBe(true);
  });

  it("MQ1: control — an ordinary entry's question announces itself the same way", function* () {
    const repl = yield* useMountedRepl();

    // An entry that asks. Its own provider, in the session's own scope, and its
    // own announcement: this is the wakeup that is not the Sidekick's.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(ENTRY_ASKS));
    yield* settled(60);
    repl.terminal.feed("\r");

    const fed = repl.terminal.fed;
    yield* awaiting(
      repl.terminal,
      "the entry's question announcing itself with no keystroke",
      (one) => shows(one, "[answer]"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // And it is the entry's, not the Sidekick's: nothing was asked of the agent.
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
  });
});

/** The fields the long question declares, in the order it declares them. */
const LONG_FIELDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "last",
] as const;

/**
 * A question with more rows than any of these panes can hold.
 *
 * Thirteen fields, each with a line about it, so the last of them and
 * `[submit]` are outside the measured window even in the tallest frame — which
 * is what makes "off the window" a real state rather than a smaller version of
 * "on it".
 */
const LONG_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    LONG_FIELDS.map((name) => [name, { type: "string", description: `What ${name} is for.` }]),
  ),
  required: ["one"],
  additionalProperties: false,
} as const;

/** The two window controls this form scrolls with, as the screen draws them. */
const LATER_CONTROL = "[\u2193 later]";
const EARLIER_CONTROL = "[\u2191 earlier]";

/** The outer envelope of the pane that owns the Sidekick's form, by width. */
function paneEnvelope(columns: number): number {
  // From the accepted table rather than asked of the product: the staged screen
  // gives the Transcript 36 and the conversation 58 of 160 and 32 of 120, so the
  // right column begins at 102 and at 88. A narrow frame routes one outlet and
  // has no column of its own to begin.
  if (columns >= 160) {
    return 102;
  }
  return columns >= 120 ? 88 : 0;
}

/** Where on the screen this text starts, or a failure saying it is not there. */
function columnOf(terminal: Terminal, label: string, from = 0): { column: number; row: number } {
  const at = coordinateOf(terminal, label, from);
  if (at === undefined) {
    throw new Error(`no row of the screen holds ${JSON.stringify(label)}`);
  }
  return { column: at.column, row: at.row };
}

describe("Tier MQ — the question form lives in the pane that owns it", () => {
  it("MQ4: the form stays inside its own pane at every size, and survives a refusal", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: askingReply("Fill this in.", LONG_SCHEMA) });
    repl.fake.script({ reply: "<Output>Got it.</Output>\n" });

    // Their own text in both composers, which none of what follows may touch.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");
    yield* sendMessage(repl, "ask");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "later");

    // The notice this screen gives: the control that opens the question, in the
    // pane that owns it. The prose that named the agent belongs to the screen
    // this one replaced.
    yield* awaiting(repl.terminal, "the question announcing itself", (one) =>
      shows(one, "[answer sidekick]"),
    );
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form opening", (one) => shows(one, "Fill this in."));

    // Something typed into it, so every size below is preserving a partial
    // answer rather than an empty form.
    yield* typing(repl.terminal, "first");
    expect(shows(repl.terminal, "one: first")).toBe(true);

    // Not every field fits: the last one and the way to submit are outside the
    // window, so they are no node, no cell and no target.
    expect(shows(repl.terminal, "last:")).toBe(false);
    expect(shows(repl.terminal, "[submit]")).toBe(false);
    // And real scrolling reaches them, one row at a time through the control
    // that moves this window.
    // The form's own control, not the transcript's: both read `[↓ later]`, and
    // the pane this one belongs to is what tells them apart.
    const pane = paneEnvelope(repl.terminal.size.columns);
    for (let press = 0; press < 80 && !shows(repl.terminal, "[submit]"); press += 1) {
      yield* click(repl.terminal, LATER_CONTROL, pane);
    }
    expect(shows(repl.terminal, "[submit]")).toBe(true);
    expect(shows(repl.terminal, "last:")).toBe(true);

    // And back to the top, through the control that moves it the other way, so
    // what follows is about the pane rather than about where the window is.
    for (let press = 0; press < 80 && !shows(repl.terminal, "Fill this in."); press += 1) {
      yield* click(repl.terminal, EARLIER_CONTROL, pane);
    }
    expect(shows(repl.terminal, "Fill this in.")).toBe(true);

    for (const size of PROFILES) {
      const rows = yield* readingAt(repl.terminal, size);
      yield* awaiting(repl.terminal, `the form at ${size.columns}x${size.rows}`, (one) =>
        shows(one, "Fill this in."),
      );
      const envelope = paneEnvelope(size.columns);
      const drawn = rows();

      // Inside the pane that owns it. Compared against the reference envelope
      // rather than against the production rectangle: a test that asked the
      // code where it put the drawer would agree with it however wrong it was.
      for (const label of ["Fill this in.", "[close]", EARLIER_CONTROL]) {
        const at = columnOf(repl.terminal, label, envelope);
        expect(at.column).toBeGreaterThanOrEqual(envelope);
        expect(at.column).toBeLessThan(size.columns);
        // Above this screen's own footer, which the form never covers. Read
        // from the row the way out is actually drawn on rather than from a
        // count: how many rows a footer takes is the layout's, and what this
        // asserts is that the drawer stays off it.
        expect(at.row).toBeLessThan(footerRow(drawn));
      }
      // The footer is still the footer.
      expect(rowsShow(drawn, "[exit]")).toBe(true);
      // No entry form is drawn beside it: one question drawer at a time.
      expect(drawn.filter((line) => line.includes("[close]")).length).toBe(1);
      // What was typed is still in it.
      expect(rowsShow(drawn, "one: first")).toBe(true);
      // And the draft is still the draft, read where it is drawn: a narrow
      // frame routes one outlet, and this form belongs to the reading that has
      // it — so the draft is in no cell there, which the resize below proves is
      // not the same as lost.
      if (size.columns > NARROW.columns) {
        expect(blockSays(draftTextIn(drawn), "mine")).toBe(true);
      } else {
        expect(drawn.some((line) => line.includes(DRAFT_PROMPT))).toBe(false);
      }
    }

    // Too small to draw: a refusal, and the form is not in it.
    const from = repl.terminal.presented.length;
    repl.terminal.resized(TOO_SMALL);
    yield* awaiting(repl.terminal, "the refusal this size draws", () =>
      rowsShow(replay(repl.terminal.presented.slice(from)), `${NARROW.columns}x`),
    );
    expect(rowsShow(replay(repl.terminal.presented.slice(from)), "[close]")).toBe(false);

    // Back to narrow, then wide: the question, its partial value and both
    // composers are all exactly as they were.
    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    yield* awaiting(repl.terminal, "the form coming back at 72x20", (one) =>
      shows(one, "Fill this in."),
    );
    expect(rowsShow(narrow(), "one: first")).toBe(true);
    const wide = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* awaiting(repl.terminal, "the form coming back at 160x36", (one) =>
      shows(one, "Fill this in."),
    );
    expect(rowsShow(wide(), "one: first")).toBe(true);
    expect(blockSays(draftTextIn(wide()), "mine")).toBe(true);

    // The form holds focus while it is open, so the way out of this reading is
    // its own close — which is the same precedence the entry's drawer has.
    yield* click(repl.terminal, "[close]", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the form closing", (one) => shows(one, "[answer sidekick]"));
    expect(shows(repl.terminal, "[close]")).toBe(false);

    // Leaving the reading takes the notice and the way in with it, and coming
    // back brings them back — with the value still in the form behind them.
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(
      repl.terminal,
      "Bindings being selected",
      (one) => panePresented(one) === "bindings",
    );
    const onBindings = yield* readingAt(repl.terminal, repl.terminal.size);
    expect(rowsShow(onBindings(), "[close]")).toBe(false);
    expect(rowsShow(onBindings(), "[answer sidekick]")).toBe(false);
    expect(rowsShow(onBindings(), "Fill this in.")).toBe(false);

    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the notice still in the pane", (one) =>
      shows(one, "[answer sidekick]"),
    );
    // Coming back selects the reading and nothing more: the form is not put
    // back on the screen by returning to the pane it was open in.
    expect(shows(repl.terminal, "[close]")).toBe(false);
    // And the pane's own body is back, with both composers exactly as they were.
    expect(messageText(repl.terminal).includes("later")).toBe(true);
    expect(draftText(repl.terminal)).toBe("mine");
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form reopening", (one) => shows(one, "Fill this in."));
    expect(shows(repl.terminal, "one: first")).toBe(true);
  });
});

/** A question with one short required field, for the ownership rows below. */
const ONE_FIELD = {
  type: "object",
  properties: { message: { type: "string", minLength: 2 } },
  required: ["message"],
  additionalProperties: false,
} as const;

/**
 * One command with a Sidekick question open and half filled in.
 *
 * `explicit` is the whole distinction. Activating the Sidekick's tab makes it a
 * *route*, which a narrow frame keeps; reaching its box by traversal leaves the
 * default reading, which a narrow frame routes to Entries instead. Both leave
 * the same question pending with the same partial answer in it — and what the
 * screen then shows is different, which is exactly what input ownership has to
 * follow.
 */
function* askedAndOpen(explicit: boolean): Operation<MountedRepl> {
  const repl = yield* useMountedRepl();
  repl.fake.script({ reply: askingReply("Sidekick asks.", ONE_FIELD) });
  if (explicit) {
    yield* activate(repl.terminal, "Sidekick");
  }
  // Traversal rather than activation in the default arm: activating the tab is
  // what would make this a route, and this arm is about the default reading.
  // The field's own helper, because a field is focused by its marker and its
  // prompt together: this prompt begins with a space of its own, so composing
  // one here would be spelling the row the screen does not draw.
  yield* focusMessage(repl.terminal);
  expect(focusedField(repl.terminal, MESSAGE_PROMPT)).toBe(true);
  yield* typing(repl.terminal, "ask");
  yield* click(repl.terminal, "[send]", sidekickColumn(repl.terminal));
  yield* awaiting(repl.terminal, "the question opener", (one) => shows(one, "[answer sidekick]"));
  yield* click(repl.terminal, "[answer sidekick]");
  yield* awaiting(repl.terminal, "the form opening", (one) => shows(one, "[submit]"));
  yield* focusFormValue(repl.terminal, 0);
  yield* typing(repl.terminal, "partial");
  expect(shows(repl.terminal, "message: partial")).toBe(true);
  return repl;
}

/**
 * Open History over this command, close it once, and say whether the question
 * form came back.
 *
 * One close action, as a person presses it: a drawer that needed two would be
 * one whose close acted on something underneath it.
 */
function* historyOver(repl: MountedRepl): Operation<boolean> {
  yield* click(repl.terminal, "[history]");
  // The whole-body drawer, told from the Sidekick's by where its close lands:
  // History covers the body, so its own close is left of the Sidekick's pane.
  yield* awaiting(repl.terminal, "History's own drawer", (one) => {
    const close = coordinateOf(one, "[close]");
    return close !== undefined && close.column < paneEnvelope(one.size.columns);
  });
  yield* click(repl.terminal, "[close]");
  yield* awaiting(repl.terminal, "History leaving its rectangle", (one) => {
    const close = coordinateOf(one, "[close]");
    return close === undefined || close.column >= paneEnvelope(one.size.columns);
  });
  return shows(repl.terminal, "[submit]");
}

describe("Tier MQ — what is on the screen owns the keys and the controls", () => {
  it("Q-P1: a form hidden by a resize does not consume Draft typing", function* () {
    const repl = yield* askedAndOpen(false);

    // Narrow routes one outlet, and with no explicit view it is Entries — so
    // this question is pending, its partial answer is stored, and neither is
    // on the screen.
    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    expect(rowsShow(narrow(), "[submit]")).toBe(false);

    // The draft is the visible input, so it is the one that takes the keys.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "ordinary");
    expect(draftText(repl.terminal)).toBe("ordinary");

    // And the form it did not reach is exactly as it was left. Expanding shows
    // it again — a resize hides a form, it does not close one — and what is in
    // it is still the partial answer, not the draft typed over the top of it.
    const wide = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* awaiting(repl.terminal, "the form back in its pane", (one) => shows(one, "[submit]"));
    expect(rowsShow(wide(), "partialordinary")).toBe(false);
    expect(shows(repl.terminal, "message: partial")).toBe(true);
    expect(draftText(repl.terminal)).toBe("ordinary");
  });

  it("Q-P1: control — an explicitly selected form still edits its own field", function* () {
    const repl = yield* askedAndOpen(true);

    // Explicit activation made the Sidekick a route, so narrow keeps it — and
    // the form is what the screen is showing.
    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    expect(rowsShow(narrow(), "[submit]")).toBe(true);

    yield* focusFormValue(repl.terminal, 0);
    yield* typing(repl.terminal, " more");
    expect(shows(repl.terminal, "message: partial more")).toBe(true);
    // And the draft, which is not the visible input, took none of it.
    expect(draftText(repl.terminal)).toBe("");
  });

  it("Q-P2: History over an open form closes once and leaves the form waiting", function* () {
    const repl = yield* askedAndOpen(true);

    // One close, acting on the drawer that owns the modal. The command is still
    // running afterwards, which a focus claim made outside that modal would
    // have ended.
    expect(yield* historyOver(repl)).toBe(true);
    expect(repl.outcome()).toBe(undefined);
    // And the question is still the one it was, with what was typed in it.
    expect(shows(repl.terminal, "Sidekick asks.")).toBe(true);
    expect(shows(repl.terminal, "message: partial")).toBe(true);
  });

  it("Q-P2: control — History closes the same way with no form open", function* () {
    const repl = yield* askedAndOpen(true);
    yield* click(repl.terminal, "[close]", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the question opener again", (one) =>
      shows(one, "[answer sidekick]"),
    );

    // The same one close, and nothing of the Sidekick's comes back because
    // nothing of it was open.
    expect(yield* historyOver(repl)).toBe(false);
    expect(repl.outcome()).toBe(undefined);
    expect(shows(repl.terminal, "[answer sidekick]")).toBe(true);
  });
});

describe("Tier CFG — Configure in the pane that owns it, at every size", () => {
  const ADVERTISED = {
    model: {
      selected: "balanced",
      choices: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
      ],
    },
    effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
  } as const;

  /** A question with two fields, so one of them can be left half filled. */
  const ASKS = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "reject"] },
      message: { type: "string", minLength: 4 },
    },
    required: ["decision", "message"],
    additionalProperties: false,
  } as const;

  /** Open Configure from the pane's own header. */
  function* openConfigure(repl: MountedRepl): Operation<void> {
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    expect(shows(repl.terminal, "[refresh]")).toBe(true);
  }

  it("CFG6: Configure stays inside its pane at every size, and survives a refusal", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    // Both composers, and an explicit Sidekick route so the narrow profile
    // keeps this pane rather than routing its one outlet to Entries.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "note");
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "ask");

    yield* openConfigure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* click(repl.terminal, "( ) Fast", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "a chosen model", (one) => shows(one, "(x) Fast"));

    for (const size of PROFILES) {
      const rows = yield* readingAt(repl.terminal, size);
      yield* awaiting(repl.terminal, `Configure at ${size.columns}x${size.rows}`, (one) =>
        shows(one, "(x) Fast"),
      );
      const envelope = paneEnvelope(size.columns);
      const drawn = rows();

      // Inside the pane that owns it, and above the footer's seven rows.
      // Compared against the reference envelope rather than against the
      // production rectangle: a test that asked the code where it put the
      // drawer would agree with it however wrong it was.
      for (const label of ["[close]", "[refresh]"]) {
        const at = columnOf(repl.terminal, label, envelope);
        expect(at.column).toBeGreaterThanOrEqual(envelope);
        expect(at.column).toBeLessThan(size.columns);
        expect(at.row).toBeLessThan(footerRow(drawn));
      }
      // One presented modal, and the footer still the footer.
      expect(drawn.filter((line) => line.includes("[close]")).length).toBe(1);
      expect(rowsShow(drawn, "[exit]")).toBe(true);
      // The chosen model survived the resize, and nothing was applied by it.
      expect(rowsShow(drawn, "(x) Fast")).toBe(true);
      // And the draft is read where it is drawn. A narrow frame routes one
      // outlet and Configure belongs to the pane this route is reading, so the
      // draft is in no cell there — which the resize back below proves is not
      // the same as lost.
      if (size.columns > NARROW.columns) {
        expect(blockSays(draftTextIn(drawn), "note")).toBe(true);
      } else {
        expect(drawn.some((line) => line.includes(DRAFT_PROMPT))).toBe(false);
      }
    }

    // Too small to draw: a refusal, and Configure is not in it.
    const from = repl.terminal.presented.length;
    repl.terminal.resized(TOO_SMALL);
    yield* awaiting(repl.terminal, "the refusal this size draws", () =>
      rowsShow(replay(repl.terminal.presented.slice(from)), `${NARROW.columns}x`),
    );
    expect(rowsShow(replay(repl.terminal.presented.slice(from)), "[refresh]")).toBe(false);

    // And back: the drawer, its selection and both composers are as they were.
    const wide = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* awaiting(repl.terminal, "Configure coming back", (one) => shows(one, "[refresh]"));
    expect(rowsShow(wide(), "(x) Fast")).toBe(true);
    expect(blockSays(draftTextIn(wide()), "note")).toBe(true);
  });

  it("CFG6: a choice below the drawer's window is reached by scrolling to it", function* () {
    const repl = yield* useMountedRepl();
    // More models than this drawer can draw at once. A real agent's list is
    // whatever it advertises, so the window has to be something a person can
    // move rather than a limit on what they may choose.
    // Sixty-four of them. A real agent's list is whatever it advertises, and
    // the staged pane is taller than the one this row was written against —
    // twenty-four of these now fit, and a window nothing overflows proves
    // nothing about reaching past one.
    const many = Array.from({ length: 64 }, (_, at) => ({
      id: `model-${at + 1}`,
      name: `Model ${at + 1}`,
    }));
    repl.fake.configuration({
      model: { selected: "model-1", choices: many },
      effort: {},
    });

    // Opened without asserting its controls: with a list this long they are
    // below the window too, which is the state this row is about.
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Model 1"));
    const last = `( ) Model ${many.length}`;
    // Genuinely off the window: not drawn, and so not clickable either.
    expect(shows(repl.terminal, last)).toBe(false);
    expect(coordinateOf(repl.terminal, last)).toBe(undefined);

    // Scrolled with the drawer's own control, a line at a time, until it is
    // on the screen. Bounded, so a drawer that cannot move fails here rather
    // than scrolling for ever.
    const envelope = paneEnvelope(repl.terminal.size.columns);
    // Scrolled with the drawer's own control until the row being looked for is
    // somewhere a click can land. Bounded, so a window that cannot move fails
    // here rather than scrolling for ever.
    const scrollTo = function* (label: string): Operation<void> {
      for (
        let press = 0;
        press < 60 && coordinateOf(repl.terminal, label, envelope) === undefined;
        press += 1
      ) {
        // Configure's own control, which says what moving this window does
        // rather than borrowing a recorded order's words.
        yield* click(repl.terminal, SCROLL_DOWN, envelope);
        yield* settled(20);
      }
      expect(coordinateOf(repl.terminal, label, envelope)).toBeDefined();
    };
    yield* scrollTo(last);

    // And it is a real choice once it is reachable: selected, applied, saved.
    yield* click(repl.terminal, last, envelope);
    yield* awaiting(repl.terminal, "the off-window model being selected", (one) =>
      shows(one, `(x) Model ${many.length}`),
    );
    // Choosing it says what effort has not been read for it, so the content
    // grew by a line and Apply is below the window again.
    yield* scrollTo("[apply]");
    yield* click(repl.terminal, "[apply]", envelope);
    yield* awaiting(repl.terminal, "Configure closing on the save", (one) => shows(one, "[send]"));
    const read = yield* mountedReading(repl);
    const saved = read.chat.filter((record) => record.kind === "preferences");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ model: `model-${many.length}` });
  });

  it("CFG6: a half-filled Sidekick question keeps its values across Configure", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Ready.</Output>\n" });
    repl.fake.script({
      reply: `<Elicit schema={${JSON.stringify(ASKS)}} as="answer">Approve the plan?</Elicit>\n`,
    });
    repl.fake.script({ reply: "<Output>Thanks for deciding.</Output>\n" });

    // One conversation, and one read of what it offers before it goes busy: a
    // pending question is a turn in flight, and inspection is one of the
    // things a working conversation cannot do.
    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "Ready."));
    yield* openConfigure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* click(repl.terminal, "[close]", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "Configure closing", (one) => !shows(one, "[refresh]"));

    yield* sendMessage(repl, "review it");
    // The notice this screen gives: the control that opens the question, in the
    // pane that owns it. The prose that named the agent belongs to the screen
    // this one replaced.
    yield* awaiting(repl.terminal, "the question announcing itself", (one) =>
      shows(one, "[answer sidekick]"),
    );
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form opening", (one) => shows(one, "[submit]"));

    // Half an answer: one field filled, the other deliberately left as it is.
    yield* typing(repl.terminal, "approve");
    yield* focusFormValue(repl.terminal, 1);
    yield* typing(repl.terminal, "ok");
    expect(shows(repl.terminal, "message: ok")).toBe(true);

    // Configure, over the top of it, used for something real and then closed.
    yield* click(repl.terminal, "[close]");
    yield* awaiting(repl.terminal, "the form closing", (one) => !shows(one, "[submit]"));
    yield* openConfigure(repl);
    yield* awaiting(repl.terminal, "the choices already advertised", (one) =>
      shows(one, "Balanced"),
    );
    yield* click(repl.terminal, "( ) Fast", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "a chosen model", (one) => shows(one, "(x) Fast"));
    yield* click(repl.terminal, "[close]", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "Configure closing", (one) => !shows(one, "[refresh]"));

    // The question is still pending and still half-answered: two drawers of
    // this pane are two separate things being filled in, and neither holds the
    // other's values.
    expect(shows(repl.terminal, "[answer sidekick]")).toBe(true);
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form reopening", (one) => shows(one, "[submit]"));
    expect(shows(repl.terminal, "decision: approve")).toBe(true);
    expect(shows(repl.terminal, "message: ok")).toBe(true);

    // And finishing it from there answers the question that was asked. The
    // reopened form opens on its first line, so the field being completed is
    // selected rather than assumed.
    yield* focusFormValue(repl.terminal, 1);
    yield* typing(repl.terminal, "ay");
    yield* awaiting(repl.terminal, "the completed value", (one) => shows(one, "message: okay"));
    yield* click(repl.terminal, "[submit]");
    yield* awaiting(repl.terminal, "the reply that was waiting", (one) =>
      shows(one, "Thanks for deciding."),
    );
    expect(JSON.parse(repl.fake.prompts[2] ?? "")).toEqual({
      decision: "approve",
      message: "okay",
    });
  });

  it("CFG6: control — an explicitly selected narrow Sidekick draws Configure and takes its keys", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "note");
    // Explicitly selected, which is what the narrow profile honours: its one
    // outlet goes to the pane a person chose rather than to Entries.
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* openConfigure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));

    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    // Drawn at this size, which is the positive half of the hidden-default
    // case: the row below hides Configure by *not* selecting this pane, so
    // this one has to show that the same size draws it when it is selected.
    yield* awaiting(repl.terminal, "Configure at the narrow size", (one) =>
      shows(one, "[refresh]"),
    );
    expect(rowsShow(narrow(), "Balanced")).toBe(true);

    // And its own field takes the keys here: the agent's name is edited in the
    // drawer that is on the screen, and the draft keeps what is in it.
    yield* focusOn(repl.terminal, "> Agent: ");
    yield* typing(repl.terminal, "-two");
    yield* awaiting(repl.terminal, "the name being edited at this size", (one) =>
      shows(one, `Agent: ${MOUNTED_AGENT}-two`),
    );
    // And the draft kept what is in it. Read where it is drawn, which takes two
    // steps at this size: Configure owns the keyboard while it is open, so it
    // is closed first, and then this frame's one outlet is routed back to the
    // entries, which is the reading the draft belongs to.
    expect(shows(repl.terminal, DRAFT_PROMPT)).toBe(false);
    yield* click(repl.terminal, "[close]");
    yield* awaiting(repl.terminal, "Configure closing", (one) => !shows(one, "[refresh]"));
    yield* openCatalog(repl.terminal);
    yield* closeCatalog(repl.terminal);
    yield* awaiting(
      repl.terminal,
      "the draft back on the narrow outlet",
      (one) => draftText(one) === "note",
    );
  });

  it("CFG6: History over Configure closes once, and a hidden Configure takes no keys", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "note");
    yield* openConfigure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));

    // History owns the modal while it is open, so one close closes History and
    // leaves Configure exactly as it was underneath.
    yield* click(repl.terminal, "[history]");
    yield* awaiting(repl.terminal, "History's own drawer", (one) => {
      const close = coordinateOf(one, "[close]");
      return close !== undefined && close.column < paneEnvelope(one.size.columns);
    });
    yield* click(repl.terminal, "[close]");
    yield* awaiting(repl.terminal, "History leaving its rectangle", (one) => {
      const close = coordinateOf(one, "[close]");
      return close === undefined || close.column >= paneEnvelope(one.size.columns);
    });
    // Still running, and Configure is still the thing in the pane.
    expect(repl.outcome()).toBe(undefined);
    expect(shows(repl.terminal, "[refresh]")).toBe(true);

    // Shrunk with no explicit Sidekick route: the pane routes to Entries, so
    // Configure is nowhere on the screen and the visible Draft takes the keys.
    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    expect(rowsShow(narrow(), "[refresh]")).toBe(false);
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "-more");
    expect(draftText(repl.terminal)).toBe("note-more");

    // And the hidden drawer kept what was in it, rather than being closed by a
    // resize or consuming what was typed.
    const back = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* awaiting(repl.terminal, "Configure coming back", (one) => shows(one, "[refresh]"));
    expect(rowsShow(back(), "Balanced")).toBe(true);
  });

  it("CX3: Escape closes History first, and Configure under its own rule after", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "note");
    yield* openConfigure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    // A choice made and not applied, so what survives the first Escape and what
    // the second one discards are both observable.
    const envelope = paneEnvelope(repl.terminal.size.columns);
    yield* click(repl.terminal, "( ) Fast", envelope);
    yield* awaiting(repl.terminal, "the model being selected", (one) => shows(one, "(x) Fast"));

    // History over it. A route drawer owns the modal while it is open, so
    // Configure underneath is held state and not presentation — and an Escape
    // meant for the reading in front must not reach it.
    yield* click(repl.terminal, "[history]");
    yield* awaiting(repl.terminal, "History's own drawer", (one) => {
      const close = coordinateOf(one, "[close]");
      return close !== undefined && close.column < paneEnvelope(one.size.columns);
    });
    repl.terminal.feed("\x1b");
    yield* awaiting(repl.terminal, "History leaving its rectangle", (one) => {
      const close = coordinateOf(one, "[close]");
      return close === undefined || close.column >= paneEnvelope(one.size.columns);
    });
    // One drawer closed, and exactly one: Configure is still the thing in the
    // pane and still holds the choice that was made in it.
    expect(repl.outcome()).toBe(undefined);
    expect(shows(repl.terminal, "[refresh]")).toBe(true);
    expect(shows(repl.terminal, "(x) Fast")).toBe(true);

    // The next Escape is Configure's, and it closes under Configure's own rule:
    // nothing saved, and the choice goes with the drawer.
    const from = repl.terminal.presented.length;
    repl.terminal.feed("\x1b");
    yield* awaited("Configure closing", () =>
      replay(repl.terminal.presented.slice(from)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
      ),
    );
    expect(shows(repl.terminal, "[refresh]")).toBe(false);
    expect((yield* mountedReading(repl)).chat.some((one) => one.kind === "preferences")).toBe(
      false,
    );
    // The draft was never the destination of either key.
    expect(draftText(repl.terminal)).toBe("note");
    yield* openConfigure(repl);
    yield* awaiting(repl.terminal, "the models again", (one) => shows(one, "Balanced"));
    expect(shows(repl.terminal, "(x) Fast")).toBe(false);
  });

  it("CX4: Configure says scroll, the readings around it still say earlier", function* () {
    // More models than the drawer draws at either size, so its window is real
    // and the controls below are the way through it.
    // Sixty-four of them. A real agent's list is whatever it advertises, and
    // the staged pane is taller than the one this row was written against —
    // twenty-four of these now fit, and a window nothing overflows proves
    // nothing about reaching past one.
    const many = Array.from({ length: 64 }, (_, at) => ({
      id: `model-${at + 1}`,
      name: `Model ${at + 1}`,
    }));
    const repl = yield* useMountedRepl();
    repl.fake.configuration({ model: { selected: "model-1", choices: many }, effort: {} });
    // Opened without asserting its controls: with a list this long some of them
    // are below the window, which is what makes this window real.
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Model 1"));

    /**
     * The same questions at whichever size the pane is being drawn at.
     *
     * Each size chooses a different model, because a choice made at one size is
     * still made at the next: looking for an unselected row that an earlier
     * pass had already marked would be looking for a row this drawer is right
     * not to be drawing.
     */
    const reading = function* (columns: number, choice: number): Operation<void> {
      const envelope = paneEnvelope(columns);
      // Both of Configure's own controls, drawn in its pane and targetable
      // there: a label nothing can be aimed at is not a control.
      expect(coordinateOf(repl.terminal, SCROLL_UP, envelope)).toBeDefined();
      expect(coordinateOf(repl.terminal, SCROLL_DOWN, envelope)).toBeDefined();
      // And neither of the words that belong to a recorded order. Asked of the
      // pane rather than of the screen, because the sidebar's own reading is
      // drawn on the same rows and still says them.
      expect(coordinateOf(repl.terminal, EARLIER_CONTROL, envelope)).toBe(undefined);
      expect(coordinateOf(repl.terminal, LATER_CONTROL, envelope)).toBe(undefined);
      // The scope control keeps its own vocabulary: Sessions is a reading of
      // what happened, so Earlier and Later are the right words for it.
      expect(columnShows(sessionsColumn(repl.terminal), EARLIER_CONTROL)).toBe(true);

      // And the control really scrolls: the choice below the window is reached
      // through it, and is a choice once it is there.
      const below = `( ) Model ${choice}`;
      const until_ = function* (label: string, control: string): Operation<void> {
        for (
          let press = 0;
          press < 60 && coordinateOf(repl.terminal, label, envelope) === undefined;
          press += 1
        ) {
          yield* click(repl.terminal, control, envelope);
          yield* settled(20);
        }
        expect(coordinateOf(repl.terminal, label, envelope)).toBeDefined();
      };
      expect(coordinateOf(repl.terminal, below, envelope)).toBe(undefined);
      yield* until_(below, SCROLL_DOWN);
      yield* click(repl.terminal, below, envelope);
      yield* awaiting(repl.terminal, "the off-window model being selected", (one) =>
        shows(one, `(x) Model ${choice}`),
      );
      // Back up through the other one, to the first choice again — which also
      // leaves the window where the next size finds it.
      yield* until_("( ) Model 1", SCROLL_UP);
    };

    yield* reading(MOUNTED_SIZE.columns, many.length);
    // The same pane at the medium profile, by a real resize rather than a
    // second program: one command owns this terminal.
    yield* resizeTo(repl.terminal, { columns: 120, rows: 30 });
    yield* awaiting(repl.terminal, "Configure at the medium profile", (one) =>
      shows(one, "Model 1"),
    );
    yield* reading(120, many.length - 1);
  });
});

/** The wide size every row in this file drives the mounted program at. */
const MOUNTED_SIZE: ReplTerminalSize = { columns: 160, rows: 36 };

/** How wide the Transcript column is at that size, which is where the list is. */
const SIDEBAR_COLUMNS = workspaceTranscriptWidth(MOUNTED_SIZE) ?? 0;

/**
 * The column the right pane begins at, at the wide size these rows drive.
 *
 * Asked of the layout rather than written down: these two are how the helpers
 * below *slice* the screen into columns, and say nothing about how wide a column
 * should be. Tier PW asserts the accepted shares independently, which is where
 * a wrong width belongs — a slicer that disagreed with the product would quietly
 * read the wrong pane instead of failing.
 */
const INSPECTION_FROM = MOUNTED_SIZE.columns - (workspaceConversationWidth(MOUNTED_SIZE) ?? 0);

/**
 * The Transcript of agent work, as its own column draws it.
 *
 * Sliced to that column's own cells, because three columns write to the same
 * rows: a label found *somewhere* on a line is usually a different control in
 * a different pane. What a reader sees in this column is the prefix of each row
 * that fits in it.
 */
function sessionsColumn(terminal: Terminal): string[] {
  return screenOf(terminal)
    .map((line) => line.slice(0, SIDEBAR_COLUMNS).trimEnd())
    .filter((line) => line.trim().length > 0);
}

/**
 * The Sidekick pane, as its own column draws it.
 *
 * Not trimmed at the end, because one of the things these rows ask about is
 * whether the message box is drawn at all — and its prompt ends in a space, so
 * a trimmed row would answer "no composer" for a pane that has one.
 */
/**
 * The row this screen draws its way out on, which is where its footer begins.
 *
 * Read from the screen rather than counted from a layout constant: how many
 * rows a footer takes is the composition's business, and what a drawer has to
 * respect is the band it actually drew.
 */
function footerRow(rows: readonly string[]): number {
  const at = rows.findIndex((line) => line.includes("[exit]"));
  return at === -1 ? rows.length : at;
}

function paneColumn(terminal: Terminal): string[] {
  return screenOf(terminal)
    .map((line) => line.slice(INSPECTION_FROM))
    .filter((line) => line.trim().length > 0);
}

/**
 * Whether this column shows this text, whole or shortened to fit its rows.
 *
 * A row is as wide as the region the frame measured for it, so a label nobody
 * bounded keeps the columns the row's own vocabulary leaves it, marked where it
 * was cut. The question "is this turn on the screen" is therefore about the
 * prefix that fits rather than about every letter.
 */
function columnShows(rows: readonly string[], text: string): boolean {
  for (let kept = text.length; kept >= 1; kept -= 1) {
    const shown = kept === text.length ? text : `${text.slice(0, kept)}…`;
    if (rows.some((line) => line.includes(shown))) {
      return true;
    }
  }
  return false;
}

/**
 * How many of a column's rows show this text, elision included.
 *
 * The same question {@link columnShows} asks, counted: one stable row per turn
 * is an assertion about how many rows name that turn, and a
 * count that missed the shortened spelling would count none of them.
 */
function columnCount(rows: readonly string[], text: string): number {
  for (let kept = text.length; kept >= 1; kept -= 1) {
    const shown = kept === text.length ? text : `${text.slice(0, kept)}\u2026`;
    const found = rows.filter((line) => line.includes(shown)).length;
    if (found > 0) {
      return found;
    }
  }
  return 0;
}

/**
 * Whether one elided column shows nothing that could be this text.
 *
 * Absence read through an elision, which is not the mirror of presence: the
 * tolerant match above walks every prefix down to one character, so it answers
 * `true` for almost any elided row and cannot be negated. This asks the
 * narrower question it can answer — no row holds the whole text, and no row
 * holds an elided prefix long enough to name nothing else.
 *
 * An assertion whose first eight characters are shared with another row on the
 * screen is not one this can settle, and belongs against the history or
 * the reading instead.
 */
const COLUMN_DISTINCT = 8;
function columnLacks(rows: readonly string[], text: string): boolean {
  const floor = Math.min(text.length, COLUMN_DISTINCT);
  for (let kept = text.length; kept >= floor; kept -= 1) {
    const shown = kept === text.length ? text : `${text.slice(0, kept)}…`;
    if (rows.some((line) => line.includes(shown))) {
      return false;
    }
  }
  return true;
}

/**
 * Where one Sessions row is on the screen, by the label it shows.
 *
 * Bounded to the sidebar's own columns, because the same title is drawn in the
 * chat pane as well: a pointer aimed at whichever came first would press a
 * line in another column.
 */
function sessionsCoordinate(
  terminal: Terminal,
  label: string,
): { readonly column: number; readonly row: number } {
  for (const [row, line] of screenOf(terminal).entries()) {
    const column = line.slice(0, SIDEBAR_COLUMNS).indexOf(label);
    if (column !== -1) {
      return { column, row };
    }
  }
  throw new Error(
    `no Sessions row shows ${label}. rows=${JSON.stringify(sessionsColumn(terminal))}`,
  );
}

/** Where one label sits among a column's rows, or -1. */
function columnRow(rows: readonly string[], text: string): number {
  for (let kept = text.length; kept >= 1; kept -= 1) {
    const shown = kept === text.length ? text : `${text.slice(0, kept)}…`;
    const at = rows.findIndex((line) => line.includes(shown));
    if (at !== -1) {
      return at;
    }
  }
  return -1;
}

/** One entry holding one Prompt, which is an entry whose Agent work is real. */
function promptEntry(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}

/** Admit one entry through the draft, the way a person does. */
function* submitEntry(repl: MountedRepl, source: string): Operation<void> {
  yield* focusDraft(repl.terminal);
  repl.terminal.bytes(new TextEncoder().encode(source));
  yield* settled(60);
  repl.terminal.feed("\r");
}

/**
 * One Sidekick reading, from the parts a case states.
 *
 * Built here rather than taken from a running owner, because what these rows
 * are about is what the *screen* does with a reading: a Sidekick with no turns,
 * a Sidekick whose history cannot be read, and the difference between either of
 * those and a frame that has no Sidekick at all.
 */
function sidekickReading(parts: Partial<ReplSidekickReading>): ReplSidekickReading {
  return Object.freeze({
    chat: Object.freeze([]),
    turns: Object.freeze([]),
    busy: false,
    agent: MOUNTED_AGENT,
    refusal: undefined,
    question: undefined,
    conversation: undefined,
    requested: undefined,
    verified: undefined,
    reading: undefined,
    setup: undefined,
    current: true,
    availability: Object.freeze({
      chats: Object.freeze([]),
      sessions: Object.freeze([]),
      refusal: undefined,
    }),
    ...parts,
  });
}

/**
 * Every row one Sessions reading mounts, by key, at the wide profile.
 *
 * Through the production pipeline over one real tree and one real engine pair,
 * because the section rows live inside a measured window: a list described
 * without a frame is a list nothing placed, which is the opposite of what these
 * rows are about.
 */
function* sessionsKeys(
  sidekick: ReplSidekickReading | undefined,
  /**
   * The entry history to read beside the Sidekick's, and the key to filter by.
   *
   * Both default to nothing, which is the entry-only compatibility case these
   * rows started as. A row about the filter both owners share supplies a real
   * entry history and the key it is being asked about.
   */
  beside: { readonly events?: readonly DurableEvent[]; readonly session?: string } = {},
): Operation<readonly string[]> {
  const projected = projectRepl(beside.events ?? []);
  if (!projected.ok) {
    throw projected.error;
  }
  const live: ReplLive = {
    output: "",
    question: undefined,
    expansion: "playing",
    pausable: false,
    running: false,
    agent: NO_AGENT,
    lifecycle: NO_LIFECYCLE,
    ...(sidekick === undefined ? {} : { sidekick }),
  };
  const size: ReplTerminalSize = { columns: 160, rows: 36 };
  const opening = initialState("kf39sla2");
  const state =
    beside.session === undefined
      ? opening
      : Object.freeze({
          ...opening,
          route: Object.freeze({ ...opening.route, surface: "sessions", session: beside.session }),
        });
  const view = viewFor(state, projected.value, live, size);
  if (!view.ok) {
    throw view.error;
  }
  const presenter = yield* usePresenter(size);
  return (yield* presenter.commit(view.value)).keys;
}

describe("Tier SS — Sessions shows two owners, each in its own order", () => {
  it("SS1: both sections hold their own work, settled in the order each finishes", function* () {
    const repl = yield* useMountedRepl();
    // The entry's Agent turn, accepted and held: it says nothing and settles
    // nothing until this case lets it.
    repl.fake.script({ held: true, reply: "ENTRY-DONE" });
    // The Sidekick's turn, which streams one piece and then holds. Two
    // different seams, because this case has to release the *later-started*
    // turn first and the longest-held release cannot choose.
    repl.fake.script({
      deltas: ["<Output>Side ans", "wer.</Output>\n"],
      holdAfter: 1,
    });

    yield* submitEntry(repl, promptEntry("ask-entry"));
    yield* repl.fake.holdingTurns(1);
    yield* sendMessage(repl, "ask side");
    yield* repl.fake.streamingTurns(1);

    // One list, which is the reading the person who accepted this screen asked
    // for, holding both owners' work. The headings over blocks of rows are
    // gone, so whose work a row is is said on the row.
    yield* awaiting(repl.terminal, "both owners' turns in the one list", (one) => {
      const rows = sessionsColumn(one);
      return columnShows(rows, "ask-entry") && columnShows(rows, "ask side");
    });
    const held = sessionsColumn(repl.terminal);
    expect(columnShows(held, "Entry agents")).toBe(false);
    expect(columnRow(held, "ask-entry")).toBeGreaterThanOrEqual(0);
    expect(columnRow(held, "ask side")).toBeGreaterThanOrEqual(0);
    // The Sidekick's row says which agent answered and in which conversation —
    // never whichever agent happens to be selected. Read from the row, because
    // one list of two owners' work has no other place to say it.
    expect(columnShows(held, MOUNTED_AGENT)).toBe(true);

    // The later-started turn released first. Its evaluated reply is recorded
    // while the entry's turn is still generating, so the two owners settle in
    // their own order and each section keeps its own.
    repl.fake.releaseDeltas();
    yield* awaiting(repl.terminal, "the Sidekick turn being saved", (one) =>
      columnShows(sessionsColumn(one), "ask side · completed"),
    );
    // And the entry's turn has not been recorded: the two owners settle in
    // their own order, so the later-started one being saved says nothing about
    // the earlier one. Which live phase the entry turn is in is the session's
    // own business and is not asserted here.
    //
    // Asked of the journal rather than of the column, because the column is
    // elided and a row read through an elision cannot establish an absence:
    // the entry turn is recorded when its own history holds it, and that is
    // the fact this claim is about.
    const holding = yield* mountedReading(repl);
    expect(holding.model.turns).toEqual([]);

    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the entry turn being recorded", (one) =>
      columnShows(sessionsColumn(one), "ask-entry · completed, recorded"),
    );

    // One stable row per turn: exactly one row in each section names its own
    // turn, before and after publication.
    const settledRows = sessionsColumn(repl.terminal);
    expect(columnCount(settledRows, "ask side")).toBe(1);
    expect(columnCount(settledRows, "ask-entry")).toBe(1);

    // And the entry journal holds not one Sidekick record. The two histories
    // are two files, and this is the one that says so.
    const read = yield* mountedReading(repl);
    expect(read.model.turns).toHaveLength(1);
    expect(read.model.turns[0]?.input).toBe("ask-entry");
    expect(read.chat.some((record) => record.kind === "message")).toBe(true);
    // Each conversation names a provider conversation of its own, and the two
    // rows are never merged whatever they have in common.
    expect(read.model.sessions).toHaveLength(1);
  });

  it("SS1: a turn that renders nothing is announced at begin and keeps its row", function* () {
    const repl = yield* useMountedRepl();
    // A reply that answers and reads something, so the exchange owes an
    // automatic follow-up.
    repl.fake.script({
      reply: ["<Output>First answer.</Output>", "<REPL.Bindings />", ""].join("\n"),
    });
    // That follow-up, held before its first delta: it has said nothing, it
    // will render nothing for the person, and it carries a response's results
    // rather than anything anybody typed.
    repl.fake.script({ held: true, reply: "<REPL.Bindings />\n" });

    yield* sendMessage(repl, "read it");
    // Waited for, so the loop has drawn the frame the first reply produced and
    // has nothing queued: from here the only thing that can put the follow-up
    // on the screen is the canonical boundary announcing that it began.
    yield* awaiting(repl.terminal, "the first reply arriving", (one) =>
      saidBySidekick(one, `First answer.`),
    );
    yield* repl.fake.holdingTurns(1);
    const fed = repl.terminal.fed;

    yield* awaiting(repl.terminal, "the held follow-up being announced", (one) =>
      columnShows(sessionsColumn(one), "Automatic feedback"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // It is agent work, labelled as such: the machine input it carries is not
    // a person's words and is nowhere on the screen.
    expect(columnShows(sessionsColumn(repl.terminal), "Automatic feedback \u00b7 generating")).toBe(
      true,
    );
    expect(shows(repl.terminal, "REPL.Bindings")).toBe(false);

    repl.fake.releaseTurn();
    // It stays a turn. The reply rendered nothing for the person, which is work
    // rather than silence: Sessions is where that turn's own account of itself
    // is, so this row does not disappear and it shows no source.
    yield* awaiting(repl.terminal, "the follow-up being saved", (one) =>
      columnShows(sessionsColumn(one), "Automatic feedback \u00b7 completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    expect(shows(repl.terminal, "REPL.Bindings")).toBe(false);
    expect(columnCount(sessionsColumn(repl.terminal), "Automatic feedback")).toBe(1);
    expect(columnCount(sessionsColumn(repl.terminal), "read it")).toBe(1);
  });

  it("SS7: a no-Sidekick reading keeps the entry-only surface; an unreadable one refuses", function* () {
    // The compatibility control: a reading built with no Sidekick at all draws
    // exactly the surface this always was — one list, one placeholder, and no
    // section headings.
    const entryOnly = yield* scoped(() => sessionsKeys(undefined));
    expect(entryOnly).toContain("sessions:empty");
    expect(entryOnly).not.toContain("sessions:section:entries");
    expect(entryOnly).not.toContain("sessions:section:sidekick");

    // With one installed there are two sections, and each says what it holds.
    const installed = yield* scoped(() => sessionsKeys(sidekickReading({})));
    expect(installed).toContain("sessions:section:entries");
    expect(installed).toContain("sessions:entries:none");
    expect(installed).toContain("sessions:section:sidekick");
    expect(installed).toContain("sessions:sidekick:none");
    expect(installed).not.toContain("sessions:empty");

    // And a chat history this version cannot read says why, in its own
    // section, rather than claiming the Sidekick has done no work.
    const refused = yield* scoped(() =>
      sessionsKeys(
        sidekickReading({ refusal: "this chat history is not one this version can read." }),
      ),
    );
    expect(refused).toContain("sessions:section:sidekick");
    expect(refused).toContain("sessions:sidekick:refusal");
    expect(refused).not.toContain("sessions:sidekick:none");
  });
});

/** Type a different agent's name into Configure's own field. */
function* nameAgent(repl: MountedRepl, agent: string): Operation<void> {
  yield* focusOn(repl.terminal, `> Agent: `);
  for (let press = 0; press < MOUNTED_AGENT.length; press += 1) {
    repl.terminal.feed("\x7f");
    yield* settled(8);
  }
  yield* typing(repl.terminal, agent);
}

describe("Tier SS — an older chat is read, and only read", () => {
  /**
   * One execution with two real conversations, the older one holding a chat.
   *
   * Through the product: a message, its reply, an agent replacement that opens
   * the second conversation, and one message in that. So the chat somebody
   * reads afterwards is a conversation this execution really had rather than
   * records written by hand.
   */
  function* twoChats(
    repl: MountedRepl,
    /**
     * Also leave a turn the provider failed in the older chat.
     *
     * For the row about a *current* failure arriving while that chat is being
     * read: the older chat then holds a reply and an attempt of its own, so
     * what the current one does to them is something there is to observe.
     */
    withOlderFailure = false,
  ): Operation<void> {
    repl.fake.configuration({
      model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    repl.fake.script({ reply: "<Output>Older answer.</Output>\n" });
    if (withOlderFailure) {
      repl.fake.script({ reply: "<Output>Older attempt.</Output>\n", stopReason: "max_tokens" });
    }
    repl.fake.script({ reply: "<Output>Newer answer.</Output>\n" });

    yield* sendMessage(repl, "older ask");
    yield* awaiting(repl.terminal, "the older chat's reply", (one) => shows(one, "Older answer."));
    if (withOlderFailure) {
      yield* sendMessage(repl, "older failed");
      yield* awaiting(repl.terminal, "the older chat's failed attempt", (one) =>
        columnShows(sessionsColumn(one), "older failed · failed"),
      );
    }

    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    yield* nameAgent(repl, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the control saying it starts a new conversation", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
      shows(one, "No messages yet."),
    );

    yield* sendMessage(repl, "newer ask");
    yield* awaiting(repl.terminal, "the newer chat's reply", (one) => shows(one, "Newer answer."));
  }

  it("SS4: activating an older turn opens its chat read-only, and Back comes home", function* () {
    const repl = yield* useMountedRepl();
    yield* twoChats(repl);

    // An unsent message, typed and left. It is the current chat's, and
    // reading an older one must not consume or lose it.
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "not sent yet");
    expect(messageText(repl.terminal)).toBe("not sent yet");
    // And a selected entry, so the left surface can be shown to survive.
    const entries = (yield* mountedReading(repl)).model.entries.length;
    expect(entries).toBe(0);

    const before = repl.fake.prompts.length;
    const sessionsBefore = repl.fake.ensured.length;
    const chatBefore = (yield* mountedReading(repl)).chat.length;

    // The older turn, activated from the Sessions reading by the mounted
    // control. Nothing here reaches the owner.
    yield* awaiting(repl.terminal, "the older turn being listed", (one) =>
      columnShows(sessionsColumn(one), "older ask"),
    );
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "older ask"));

    // Its own chat is what is drawn: the older reply is there, the newer one
    // is not, and the agent it says answered is the one that did.
    yield* awaiting(repl.terminal, "the older chat opening", (one) =>
      rowsShow(paneColumn(one), "Older answer."),
    );
    expect(rowsShow(paneColumn(repl.terminal), "Newer answer.")).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), `[S] Older answer.`)).toBe(true);

    // Read-only, and absent rather than refused: no composer, no Send, no
    // Stop, no Configure and no Retry addressing it.
    const reading = paneColumn(repl.terminal);
    expect(rowsShow(reading, MESSAGE_PROMPT)).toBe(false);
    expect(rowsShow(reading, "[send]")).toBe(false);
    expect(rowsShow(reading, "[stop]")).toBe(false);
    expect(rowsShow(reading, "[configure")).toBe(false);
    expect(rowsShow(reading, "[retry]")).toBe(false);
    // And the way back is there, outside the scrolling transcript.
    expect(rowsShow(reading, "[Back to current chat]")).toBe(true);

    // Selecting a reading started nothing, wrote nothing and stopped nothing.
    expect(repl.fake.prompts).toHaveLength(before);
    expect(repl.fake.ensured).toHaveLength(sessionsBefore);
    expect((yield* mountedReading(repl)).chat).toHaveLength(chatBefore);
    expect((yield* mountedReading(repl)).model.entries).toHaveLength(entries);

    // Back restores the current chat and the message that was never sent.
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      rowsShow(paneColumn(one), "Newer answer."),
    );
    expect(messageText(repl.terminal)).toBe("not sent yet");
    expect(rowsShow(paneColumn(repl.terminal), "[send]")).toBe(true);
    expect(rowsShow(paneColumn(repl.terminal), "[Back to current chat]")).toBe(false);
  });

  it("SS4: the active chat keeps its controls, and a current update leaves the reading alone", function* () {
    const repl = yield* useMountedRepl();
    yield* twoChats(repl);

    // A held follow-up in the *current* chat, so an update really arrives
    // while an older chat is being read.
    repl.fake.script({ held: true, reply: "<Output>Arrived later.</Output>\n" });
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "one more");
    // This screen has two Sends — the entry draft's and this composer's — so
    // the column the Sidekick's own pane begins at is what names which one.
    // Clicking the leftmost would submit a draft instead of sending a message.
    yield* click(repl.terminal, "[send]", sidekickColumn(repl.terminal));
    yield* repl.fake.holdingTurns(1);

    // Now read the older chat.
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "older ask"));
    yield* awaiting(repl.terminal, "the older chat opening", (one) =>
      rowsShow(paneColumn(one), "Older answer."),
    );

    const fed = repl.terminal.fed;
    repl.fake.releaseTurn();
    // The current chat's own reply lands. The Sessions reading says so, and
    // the chat being read is still the older one: background work never
    // retargets a chat somebody explicitly selected.
    yield* awaiting(repl.terminal, "the current reply being recorded", (one) =>
      columnShows(sessionsColumn(one), "one more · completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    expect(rowsShow(paneColumn(repl.terminal), "Older answer.")).toBe(true);
    expect(rowsShow(paneColumn(repl.terminal), "Arrived later.")).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), MESSAGE_PROMPT)).toBe(false);

    // Back, and the current chat has its controls and the reply that arrived.
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      rowsShow(paneColumn(one), "Arrived later."),
    );
    expect(rowsShow(paneColumn(repl.terminal), "[send]")).toBe(true);
    expect(rowsShow(paneColumn(repl.terminal), `[configure ${OTHER_MOUNTED_AGENT}]`)).toBe(true);
  });

  it("SS4: a pending question and its partial answer survive reading an older chat", function* () {
    const repl = yield* useMountedRepl();
    yield* twoChats(repl);

    // The current conversation asks something, and the follow-up it will owe
    // once that question is answered.
    repl.fake.script({ reply: askingReply("Approve the plan?") });
    repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    yield* sendMessage(repl, "review it");
    // The notice this screen gives: the control that opens the question, in the
    // pane that owns it. The prose that named the agent belongs to the screen
    // this one replaced.
    yield* awaiting(repl.terminal, "the question announcing itself", (one) =>
      shows(one, "[answer sidekick]"),
    );
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form opening", (one) => shows(one, "Approve the plan?"));

    // A partial answer: the first field filled and the rest of the form not.
    yield* typing(repl.terminal, "appr");
    expect(shows(repl.terminal, "decision: appr")).toBe(true);

    // Closed, which leaves the question pending and keeps what was typed. The
    // form is a modal while it is open, so this is the state somebody walks
    // away from a question in.
    const pane = paneEnvelope(repl.terminal.size.columns);
    yield* click(repl.terminal, "[close]", pane);
    yield* awaiting(repl.terminal, "the notice coming back", (one) =>
      shows(one, "[answer sidekick]"),
    );
    expect(shows(repl.terminal, "[submit]")).toBe(false);
    // Where the way in is, so pressing exactly there afterwards asks whether
    // anything is still a target at that cell.
    const answer = columnOf(repl.terminal, "[answer sidekick]", pane);

    // Now read a chat this Sidekick is no longer continuing.
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "older ask"));
    yield* awaiting(repl.terminal, "the older chat opening", (one) =>
      rowsShow(paneColumn(one), "Older answer."),
    );

    // The question's notice, its form and every way to reach either are gone
    // from this screen — and so are the controls that would act on a chat
    // nobody may continue.
    for (const absent of [
      "Approve the plan?",
      "decision: appr",
      "[submit]",
      "[answer sidekick]",
      MESSAGE_PROMPT,
    ]) {
      expect([absent, shows(repl.terminal, absent)]).toEqual([absent, false]);
    }
    // The controls that would act on the chat are absent from the pane that
    // reads it. Asked of that pane rather than of the screen: the entry draft
    // has a Send and a Stop of its own in a different column, and a question
    // about this chat's controls that found those would be about the wrong
    // destination.
    for (const absent of ["[send]", "[stop]"]) {
      const inside = conversationPane(screenOf(repl.terminal), repl.terminal.size);
      expect([absent, rowsShow(inside, absent)]).toEqual([absent, false]);
    }

    // And nothing is a target at the cell that control occupied: a press there
    // reaches no node, so no form opens and the reading does not move.
    yield* clickAt(repl.terminal, answer);
    yield* settled(40);
    expect(shows(repl.terminal, "[submit]")).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), "Older answer.")).toBe(true);
    // The exchange is still waiting: no reply was published and no second
    // question was invented by visiting.
    expect(shows(repl.terminal, "Noted.")).toBe(false);

    // The one input on this screen is the ordinary draft, and typing goes
    // there. A hidden form that had taken the keys would be holding this text.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    expect(draftText(repl.terminal)).toBe("my entry");

    // Back, and the question is exactly where it was: still pending, still
    // only announced, and the deliberate draft edit is the one thing changed.
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the notice coming home", (one) =>
      shows(one, "[answer sidekick]"),
    );
    expect(draftText(repl.terminal)).toBe("my entry");
    expect(shows(repl.terminal, "[submit]")).toBe(false);

    // Reopened deliberately, it is the same question holding the same partial
    // answer: visiting answered nothing, consumed nothing and replaced nothing.
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form reopening", (one) => shows(one, "Approve the plan?"));
    expect(shows(repl.terminal, "decision: appr")).toBe(true);
    expect(shows(repl.terminal, "Noted.")).toBe(false);
    expect(draftText(repl.terminal)).toBe("my entry");
  });

  it("SS2: a current failure read beside an older chat leaves its items alone", function* () {
    const repl = yield* useMountedRepl();
    // The older chat holds a reply *and* an attempt of its own, which are the
    // two items a current failure could reach into.
    yield* twoChats(repl, true);

    // A failing turn in the current chat, held partway through so its own
    // account is live rather than saved while the older chat is being read.
    repl.fake.script({
      deltas: ["<Output>Current half.</Output>\n", "<REPL.Bindings />\n"],
      holdAfter: 1,
      stopReason: "refusal",
    });
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "goes wrong");
    // This screen has two Sends — the entry draft's and this composer's — so
    // the column the Sidekick's own pane begins at is what names which one.
    // Clicking the leftmost would submit a draft instead of sending a message.
    yield* click(repl.terminal, "[send]", sidekickColumn(repl.terminal));
    yield* repl.fake.streamingTurns(1);

    // Read the older chat while that failure is in flight.
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "older ask"));
    yield* awaiting(repl.terminal, "the older chat opening", (one) =>
      rowsShow(paneColumn(one), "Older answer."),
    );

    /** The older chat's own rows, composed from the real history as it stands. */
    const olderRows = function* (): Operation<readonly ReplSidekickChatRow[]> {
      const read = yield* mountedReading(repl);
      const projected = projectSidekick(read.chat);
      if (!projected.ok) {
        throw projected.error;
      }
      const older = projected.value.conversations[0]?.id;
      return sidekickChatRows(projected.value, undefined).filter(
        (one) => one.conversation === older,
      );
    };

    const before = yield* olderRows();
    // Two messages, a reply and that chat's own unfinished attempt, each with
    // an identity of its own.
    expect(before.map((one) => one.kind)).toEqual(["person", "reply", "person", "incomplete"]);
    expect(new Set(before.map((one) => one.key)).size).toBe(before.length);

    // The current chat's live failure is not in this reading at all: what it
    // is saying belongs to the conversation it is in.
    // Named by the message that started it, because the half it streamed was
    // never evaluated and so is in no row of either reading.
    expect(rowsShow(paneColumn(repl.terminal), "goes wrong")).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), "Current half.")).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), "Older answer.")).toBe(true);
    // And this chat's own unfinished attempt is in it too. What the screen says
    // about an attempt the provider stopped is that it is unfinished and why:
    // the reply it had begun was never evaluated, so there is no output of it to
    // show, and the row gives the stop reason rather than inventing one. The
    // item itself is in `before` above, with an identity of its own.
    expect(rowsShow(paneColumn(repl.terminal), "(unfinished)")).toBe(true);
    expect(saysAcross(repl.terminal, "max_tokens")).toBe(true);
    // What that window is showing now, kept: the failure below is compared
    // against the reading somebody was actually looking at. The Sidekick's own
    // working state is the pane's rather than this reading's — it legitimately
    // stops saying so when the current turn ends — so it is not one of the rows
    // being compared, and the exact items are compared as records above.
    const reading = (rows: readonly string[]): readonly string[] =>
      rows
        .map((line) => line.replace(/^\s*\u2502/, "").trim())
        .filter((line) => line !== "" && line !== "[S] working");
    const looking = reading(paneColumn(repl.terminal));

    // Let it fail for real, still reading the older chat.
    repl.fake.releaseDeltas();
    yield* awaiting(repl.terminal, "the current turn failing", (one) =>
      columnShows(sessionsColumn(one), "goes wrong · failed"),
    );

    // The older chat's items are exactly the items they were: the current
    // failure took none of their keys, replaced none of them and dropped none.
    expect(yield* olderRows()).toEqual(before);
    // And the window is still the window: row for row, the reading somebody was
    // looking at is the reading they are still looking at.
    expect(reading(paneColumn(repl.terminal))).toEqual(looking);
    expect(rowsShow(paneColumn(repl.terminal), "goes wrong")).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), "Current half.")).toBe(false);

    // And the current chat's own account of it is there when somebody goes back.
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      rowsShow(paneColumn(one), "goes wrong"),
    );
    // Its own account of what became of it: the provider stopped this turn, so
    // the row says that and why. The half it had begun streaming was never
    // evaluated, and this screen does not show an output nothing produced.
    expect(saysAcross(repl.terminal, "refusal")).toBe(true);
  });
});

/** Wait until this command's chat history holds at least this many replies. */
function* repliesSaved(repl: MountedRepl, count: number): Operation<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const read = yield* mountedReading(repl);
    if (read.chat.filter((one) => one.kind === "response").length >= count) {
      return;
    }
    yield* settled(20);
  }
  throw new Error(`this chat never saved ${count} replies`);
}

describe("Tier SS — an older chat, from a frame that measures no chat", () => {
  it("SS4: a turn past the chat's window is revealed, and this screen keeps its own", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration({
      model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    // Twelve ordinary turns in the first chat, which is more rows than the
    // chat pane measures: the turn chosen below is genuinely past its window.
    const TURNS = 12;
    for (let number = 1; number <= TURNS; number += 1) {
      repl.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
    }
    repl.fake.script({ reply: "<Output>Newer answer.</Output>\n" });
    // The entry this screen selects asks this provider too.
    repl.fake.script({ reply: "ENTRY-ANSWER" });

    for (let number = 1; number <= TURNS; number += 1) {
      yield* sendMessage(repl, `ask-${number}`);
      // Waited for in the history rather than on the screen: a chat window
      // stays where it was put, so a reply past it is saved without being
      // drawn — which is the whole reason this chat needs revealing.
      yield* repliesSaved(repl, number);
    }

    // A real agent replacement, so the twelve-turn chat is genuinely older.
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    yield* focusOn(repl.terminal, `> Agent: `);
    for (let press = 0; press < MOUNTED_AGENT.length; press += 1) {
      repl.terminal.feed("\x7f");
      yield* settled(8);
    }
    yield* typing(repl.terminal, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the replacement control", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
      shows(one, "No messages yet."),
    );
    yield* sendMessage(repl, "newer ask");
    yield* awaiting(repl.terminal, "the newer reply", (one) => shows(one, "Newer answer."));

    // A real entry, selected, and a partial message left in the composer. Both
    // belong to this screen and neither belongs to the chat about to be read.
    yield* submitEntry(repl, promptEntry("kept-entry"));
    yield* settledEntry(repl.terminal, 1, "ok");
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "half typed");

    // The pane put on Bindings, which is the other frame that measures no chat
    // window at all: the selection below is answered by a frame that has no
    // offset to compute, so the chat's own measurement is what places the turn.
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(repl.terminal, "the inspector", (one) => panePresented(one) === "bindings");
    expect(rowsShow(paneColumn(repl.terminal), EARLIER)).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), LATER)).toBe(false);

    // The Sessions reading is windowed too, so the row for the last turn is
    // reached with that section's own control rather than assumed to be drawn.
    for (let press = 0; press < 40; press += 1) {
      if (sessionsColumn(repl.terminal).some((line) => line.includes(`ask-${TURNS} `))) {
        break;
      }
      yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, LATER));
    }
    expect(columnShows(sessionsColumn(repl.terminal), `ask-${TURNS} `)).toBe(true);
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, `ask-${TURNS} `));

    // The chat opens on the turn that was chosen: its own evaluated reply is on
    // the screen, and the first turn of that chat — which is what offset zero
    // shows — is not.
    yield* awaiting(repl.terminal, "the chosen turn being revealed", (one) =>
      rowsShow(paneColumn(one), `ANSWER-${TURNS}`),
    );
    expect(paneColumn(repl.terminal).some((line) => /ANSWER-1\b/.test(line))).toBe(false);
    // Read-only, with the way home outside the window that moved.
    expect(rowsShow(paneColumn(repl.terminal), "[Back to current chat]")).toBe(true);
    expect(rowsShow(paneColumn(repl.terminal), MESSAGE_PROMPT)).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), "[send]")).toBe(false);
    expect(rowsShow(paneColumn(repl.terminal), `[configure `)).toBe(false);
    // And the two texts this screen owns are still exactly what was typed:
    // visiting a read-only chat consumed neither.
    expect(draftText(repl.terminal)).toBe("my entry");
    expect(messageText(repl.terminal)).toBe("");

    // Back, and this screen has its own again — the entry that was selected,
    // the current chat's controls and the partial message.
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      rowsShow(paneColumn(one), "Newer answer."),
    );
    expect(messageText(repl.terminal)).toBe("half typed");
    expect(draftText(repl.terminal)).toBe("my entry");
    expect(rowsShow(paneColumn(repl.terminal), `[configure ${OTHER_MOUNTED_AGENT}]`)).toBe(true);
    expect(shows(repl.terminal, "kept-entry")).toBe(true);
  });
});

/**
 * Tier ER — a successful control-only reply, and what Sessions reveals (#883).
 *
 * The chat and Sessions answer two different questions, and this is where the
 * two meet: a reply that ran controls and said nothing to anybody is still a
 * saved turn somebody may select, and selecting it has to put something real on
 * the screen. What it puts there is the request that turn answered — the one
 * already in the chat — rather than a row composed to be landed on.
 */
describe("Tier ER — a turn that said nothing, selected from Sessions", () => {
  it("ER4: a silent turn reveals the request it answered, and composes no anchor", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration({
      model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    // The control-only exchange first, so the request it answered is at the top
    // of a chat that later fills past its window. One person turn that says
    // nothing, and the automatic follow-up carrying its result, which says
    // nothing either and runs no control of its own — so the chain ends there.
    repl.fake.script({ reply: "<REPL.Bindings />\n" });
    repl.fake.script({ reply: "Nothing to add.\n" });
    // Then one that does speak, as the control for what a reveal lands on when
    // the turn has an utterance of its own.
    repl.fake.script({ reply: "<Output>SPOKE-ALOUD</Output>\n" });
    // And enough ordinary turns after it to push all three past the window.
    const TURNS = 10;
    for (let number = 1; number <= TURNS; number += 1) {
      repl.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
    }
    repl.fake.script({ reply: "<Output>Newer answer.</Output>\n" });
    repl.fake.script({ reply: "ENTRY-ANSWER" });

    yield* sendMessage(repl, "run it");
    yield* repliesSaved(repl, 2);
    yield* sendMessage(repl, "say it");
    yield* repliesSaved(repl, 3);
    for (let number = 1; number <= TURNS; number += 1) {
      // Waited for in the history rather than on the screen: a chat window
      // stays where it was put, so a reply past it is saved without being drawn.
      yield* sendMessage(repl, `ask-${number}`);
      yield* repliesSaved(repl, 3 + number);
    }

    // A real agent replacement, so the chat holding those turns is genuinely an
    // older one and the reading below is of a chat this screen is not continuing.
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    yield* focusOn(repl.terminal, `> Agent: `);
    for (let press = 0; press < MOUNTED_AGENT.length; press += 1) {
      repl.terminal.feed("\x7f");
      yield* settled(8);
    }
    yield* typing(repl.terminal, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the replacement control", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
      shows(one, "No messages yet."),
    );
    yield* sendMessage(repl, "newer ask");
    yield* awaiting(repl.terminal, "the newer reply", (one) => shows(one, "Newer answer."));

    // Both texts this screen owns, left partly typed, and a real entry selected.
    yield* submitEntry(repl, promptEntry("kept-entry"));
    yield* settledEntry(repl.terminal, 1, "ok");
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "half typed");

    // Sessions is windowed too, so each row is reached with that section's own
    // control rather than assumed to be drawn.
    const reach = (label: string) =>
      function* (): Operation<void> {
        for (let press = 0; press < 60; press += 1) {
          if (columnShows(sessionsColumn(repl.terminal), label)) {
            return;
          }
          yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, EARLIER));
        }
        throw new Error(`no Sessions row ever showed ${label}`);
      };

    // The turn whose own reply said nothing. Its Sessions row is a completed
    // turn, which is what it is.
    yield* reach("run it \u00b7 completed")();
    expect(columnShows(sessionsColumn(repl.terminal), "run it \u00b7 completed")).toBe(true);
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "run it "));
    yield* awaiting(repl.terminal, "the request that turn answered", (one) =>
      columnShows(paneColumn(one), "[U] run it"),
    );
    // The window moved to it. An older chat left to itself follows its newest
    // rows, so the newest reply being absent is what says this one was placed.
    expect(columnLacks(paneColumn(repl.terminal), "ANSWER-10")).toBe(true);
    // And nothing was composed to land on. The next row is the next request:
    // no empty row, no bare agent name and no sentence about the absence stands
    // between the two turns whose replies said nothing.
    const pane = paneColumn(repl.terminal);
    // Asked of the rows that say something. A blank row between items is this
    // chat's own separator and stands between every pair of them, so counting
    // it would be counting the chat's spacing as composed content.
    const said = pane.filter((line) => line.replace(/^\s*\u2502/, "").trim() !== "");
    expect(columnRow(said, "[U] say it")).toBe(columnRow(said, "[U] run it") + 1);
    expect(rowsShow(pane, "answered without saying")).toBe(false);
    expect(rowsShow(pane, "Nothing to add.")).toBe(false);
    // The chat being read is the one that holds that turn, and not the chat
    // this screen is continuing.
    expect(rowsShow(pane, "Newer answer.")).toBe(false);
    expect(rowsShow(pane, "[Back to current chat]")).toBe(true);
    expect(draftText(repl.terminal)).toBe("my entry");

    // Back, and then the automatic follow-up: its own reply said nothing too,
    // and the request its chain began with is a person's, not the machine input
    // it carried.
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      columnShows(paneColumn(one), "Newer answer."),
    );
    yield* reach("Automatic feedback")();
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "Automatic fee"));
    yield* awaiting(repl.terminal, "the request that chain began with", (one) =>
      columnShows(paneColumn(one), "[U] run it"),
    );
    expect(columnLacks(paneColumn(repl.terminal), "ANSWER-10")).toBe(true);
    expect(rowsShow(paneColumn(repl.terminal), "answered without saying")).toBe(false);

    // And the control: a turn that did say something is revealed at its own
    // Output, which is still the first thing a reveal prefers.
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      columnShows(paneColumn(one), "Newer answer."),
    );
    yield* reach("say it \u00b7 completed")();
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "say it "));
    yield* awaiting(repl.terminal, "that turn's own Output", (one) =>
      columnShows(paneColumn(one), "SPOKE-ALOUD"),
    );

    // Every turn is still in Sessions with its own title and status, and both
    // texts this screen owns are still exactly what was typed.
    const sessions = sessionsColumn(repl.terminal);
    expect(columnShows(sessions, "run it \u00b7 completed")).toBe(true);
    expect(columnShows(sessions, "Automatic feedback \u00b7 completed")).toBe(true);
    expect(columnShows(sessions, "say it \u00b7 completed")).toBe(true);
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      columnShows(paneColumn(one), "Newer answer."),
    );
    expect(draftText(repl.terminal)).toBe("my entry");
    expect(messageText(repl.terminal)).toBe("half typed");
    expect(shows(repl.terminal, "kept-entry")).toBe(true);
  });

  it("ER5: the same chat reopened cold makes the same decisions, and costs nothing", function* () {
    const host = yield* useMountedHost();
    const first = yield* useMountedRepl({ host });
    // The three exchanges this correction is about, in one history: a reply
    // that ran a control and said nothing, with the automatic follow-up
    // carrying its result saying nothing either; a reply that failed with no
    // Output, and the correction it was given; and one that spoke.
    first.fake.script({ reply: "<REPL.Bindings />\n" });
    first.fake.script({ reply: "Nothing to add.\n" });
    first.fake.script({ reply: "<REPL.Delete />\n" });
    first.fake.script({ reply: "<Output>Fixed it.</Output>\n" });
    first.fake.script({ reply: "<Output>SPOKE-ALOUD</Output>\n" });
    // And enough ordinary turns after them to fill the chat's window, so the
    // three above are reached cold by selecting them rather than by being
    // drawn wherever the reopened window happened to land.
    const TURNS = 8;
    for (let number = 1; number <= TURNS; number += 1) {
      first.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
    }

    yield* sendMessage(first, "run it");
    yield* repliesSaved(first, 2);
    yield* sendMessage(first, "break it");
    yield* repliesSaved(first, 4);
    yield* sendMessage(first, "say it");
    yield* repliesSaved(first, 5);
    for (let number = 1; number <= TURNS; number += 1) {
      yield* sendMessage(first, `ask-${number}`);
      yield* repliesSaved(first, 5 + number);
    }
    const execution = yield* mountedExecution(first);
    // What this host's provider was asked for by the command that really ran.
    // The reopen below shares the same fake, so what it must add is nothing.
    const asked = first.fake.prompts.length;
    const opened = first.fake.ensured.length;
    yield* click(first.terminal, "[exit]");
    yield* awaited("the first command returning", () => first.outcome() !== undefined);
    const written = yield* until(readFile(pairPaths(host.root, execution).sidekick, "utf8"));

    // The same history, opened cold by another command.
    const again = yield* useMountedRepl({
      host,
      location: `xmd://repl/${execution}/entries`,
    });
    yield* awaiting(again.terminal, "the reopened chat", (one) =>
      columnShows(paneColumn(one), "ANSWER-8"),
    );

    const reach = (label: string) =>
      function* (): Operation<void> {
        for (let press = 0; press < 60; press += 1) {
          if (columnShows(sessionsColumn(again.terminal), label)) {
            return;
          }
          yield* clickAt(again.terminal, sessionsCoordinate(again.terminal, EARLIER));
        }
        throw new Error(`no Sessions row ever showed ${label}`);
      };

    // The failure is still a failure, with the reason this history holds — read
    // from the record rather than from anything a live process remembered.
    yield* reach("break it ")();
    yield* clickAt(again.terminal, sessionsCoordinate(again.terminal, "break it "));
    yield* awaiting(again.terminal, "the recorded failure", (one) =>
      rowsShow(paneColumn(one), `${MOUNTED_AGENT} (failed):`),
    );
    // Its own recorded reason, in the words the record holds, and not a status
    // this screen composed. Read as the prefix that fits: a reveal lands its
    // row at the foot of the window, so the rest of a wrapped reason is below
    // it rather than missing.
    expect(rowsShow(paneColumn(again.terminal), "(failed): a generated fragment")).toBe(true);
    // The turn that spoke still speaks.
    yield* reach("say it ")();
    yield* clickAt(again.terminal, sessionsCoordinate(again.terminal, "say it "));
    yield* awaiting(again.terminal, "that turn's own Output", (one) =>
      columnShows(paneColumn(one), "SPOKE-ALOUD"),
    );
    // And the two silent replies are still absent, with the request they
    // answered still what their selection reveals.
    yield* reach("run it \u00b7 completed")();
    yield* clickAt(again.terminal, sessionsCoordinate(again.terminal, "run it "));
    yield* awaiting(again.terminal, "the request that turn answered", (one) =>
      columnShows(paneColumn(one), "[U] run it"),
    );
    expect(columnLacks(paneColumn(again.terminal), "ANSWER-8")).toBe(true);
    yield* reach("Automatic feedback")();
    yield* clickAt(again.terminal, sessionsCoordinate(again.terminal, "Automatic fee"));
    yield* awaiting(again.terminal, "the request that chain began with", (one) =>
      columnShows(paneColumn(one), "[U] run it"),
    );
    expect(columnLacks(paneColumn(again.terminal), "ANSWER-8")).toBe(true);
    expect(rowsShow(paneColumn(again.terminal), "answered without saying")).toBe(false);
    expect(rowsShow(paneColumn(again.terminal), "Nothing to add.")).toBe(false);
    expect(rowsShow(paneColumn(again.terminal), "REPL.Bindings")).toBe(false);

    // Reading it cost nothing: no turn, no session, not one byte.
    expect(again.fake.prompts).toHaveLength(asked);
    expect(again.fake.ensured).toHaveLength(opened);
    expect(yield* until(readFile(pairPaths(host.root, execution).sidekick, "utf8"))).toBe(written);
  });
});

describe("Tier SS — a real gap, and a turn nothing answered", () => {
  it("SS6: an interrupted first message leaves every later row its own identity", function* () {
    const host = yield* useMountedHost();
    let repl = yield* useMountedRepl({ host });
    // The accepted divergence, produced the way it really happens: a first
    // message whose generation is stopped, so this history's own response
    // ordinals run ahead of Core's turn numbers from then on.
    repl.fake.script({ reply: "<Output>Unrecorded.</Output>\n", held: true });
    yield* sendMessage(repl, "unrecorded");
    yield* repl.fake.holdingTurns(1);
    yield* awaiting(repl.terminal, "the held first generation", (one) => shows(one, "[stop]"));
    yield* click(repl.terminal, "[stop]");
    yield* awaiting(repl.terminal, "Stop finishing", (one) => shows(one, "[send]"));
    const execution = yield* mountedExecution(repl);
    yield* click(repl.terminal, "[exit]");
    yield* awaited("the first command closing", () => repl.outcome() !== undefined);

    // A second process over the same files: a reply that is saved, then a turn
    // the provider does not finish.
    repl = yield* useMountedRepl({ host, location: `xmd://repl/${execution}/entries` });
    repl.fake.script({ reply: "<Output>Saved reply.</Output>\n" });
    yield* sendMessage(repl, "saved ask");
    yield* awaiting(repl.terminal, "the saved reply", (one) => saidBySidekick(one, `Saved reply.`));
    repl.fake.script({ reply: "<Output>Half said.</Output>\n", stopReason: "max_tokens" });
    yield* sendMessage(repl, "failed ask");
    yield* awaiting(repl.terminal, "the failed turn being accounted for", (one) =>
      columnShows(sessionsColumn(one), "failed ask · failed"),
    );

    // The real history, read back, and the rows it composes. The divergence is
    // present: the saved reply's own response record is not numbered one.
    const read = yield* mountedReading(repl);
    const projected = projectSidekick(read.chat);
    if (!projected.ok) {
      throw projected.error;
    }
    const responses = read.chat.flatMap((one) => (one.kind === "response" ? [one.response] : []));
    expect(responses).toEqual(["response:2"]);

    // Every Sessions row and every chat row has an identity of its own: the
    // failed turn is addressed by the turn it was, because this history's own
    // response ordinals and Core's turn numbers have diverged and inferring
    // one from the other would hand it the saved reply's row.
    const turns = sidekickTurnRows(projected.value, undefined);
    expect(new Set(turns.map((one) => one.key)).size).toBe(turns.length);
    expect(turns.map((one) => [one.turn, one.state])).toEqual([
      [1, "completed"],
      [2, "failed"],
    ]);
    expect(turns[0]?.key).toContain("response:2");
    expect(turns[1]?.key).toContain(":turn:");
    const chat = sidekickChatRows(projected.value, undefined);
    expect(new Set(chat.map((one) => one.key)).size).toBe(chat.length);

    // And the screen holds one row per turn, neither of them merged into the
    // other.
    expect(columnCount(sessionsColumn(repl.terminal), "saved ask ")).toBe(1);
    expect(columnCount(sessionsColumn(repl.terminal), "failed ask ")).toBe(1);
  });

  it("SS6: a real automatic turn nobody answered opens as its own inert anchor", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss6-anchor-");
    const gate = appendGate();
    let execution = "";

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot, gate });
      const repl = yield* useMountedRepl({ host });
      // A reply that reads something, so the exchange owes an automatic
      // follow-up carrying that read's results.
      repl.fake.script({
        reply: ["<Output>First answer.</Output>", "<REPL.Bindings />", ""].join("\n"),
      });
      // The follow-up itself, which renders nothing for the person.
      repl.fake.script({ reply: "<REPL.Bindings />\n" });

      // The *follow-up's* own reply record, held: the first reply's response is
      // written before it, so this is the second one.
      let seen = 0;
      const answered = gate.holdNext(
        (path, record) =>
          path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"response"') && ++seen === 2,
      );
      yield* sendMessage(repl, "read it");
      yield* answered.started();
      execution = yield* mountedExecution(repl);
      // And the process ends with that record never written: the provider
      // finished its turn, its canonical record is saved, and nothing says the
      // program it returned was ever run.
    });

    // Cold, over those files.
    const cold = yield* useMountedHost({ dataRoot });
    const reopened = yield* useMountedRepl({
      host: cold,
      location: `xmd://repl/${execution}/sessions`,
    });
    // The Sessions row says what became of it, as far as a 32-column section
    // holds the sentence; the whole of it is in the chat below.
    yield* awaiting(reopened.terminal, "the automatic turn's saved status", (one) =>
      columnShows(sessionsColumn(one), "Automatic feedback \u00b7 Turn"),
    );
    // Its machine input is nowhere: a response's own results are not chat.
    expect(shows(reopened.terminal, "REPL.Bindings")).toBe(false);

    // Selected, it opens the chat on its own inert anchor rather than on a
    // reply nobody recorded or on nothing at all.
    yield* clickAt(reopened.terminal, sessionsCoordinate(reopened.terminal, "Automatic feedback"));
    yield* awaiting(reopened.terminal, "the inert anchor in the chat", (one) =>
      rowsShow(paneColumn(one), "Automatic feedback \u00b7 Turn saved"),
    );
    // The whole status, as the pane pays it out over the rows it has.
    //
    // Re-anchored for #883's chat fitting. This asserted two rows, the second
    // of them carrying the sentence's whole tail — which is what an unfitted
    // row produced by overflowing into the row beneath it. The pane now cuts
    // the sentence at its own word boundaries against the width it measured,
    // so a sentence this wide is three rows. The claim is unchanged and is read
    // the way the rows actually hold it: consecutive rows of the anchor whose
    // text, rejoined, is exactly the status.
    // The pane's rows without the column divider they begin at, so rejoining
    // them recovers the sentence rather than the rule beside it.
    // And without the mark that says who said it. That mark is this pane's own
    // attribution rather than a word of the sentence — asserted on its own
    // below, because an anchor nobody is said to have written is a different
    // claim from this one.
    const anchor = paneColumn(reopened.terminal).map((row) =>
      (row.startsWith("\u2502") ? row.slice(1) : row).replace(/^\s*\[[US]\]\s/, "").trim(),
    );
    const opens = anchor.findIndex((row) => row.includes("Automatic feedback"));
    expect(opens).toBeGreaterThanOrEqual(0);
    expect(saidBySidekick(reopened.terminal, "Automatic feedback")).toBe(true);
    expect(
      anchor
        .slice(opens, opens + 3)
        .join(" ")
        .trim(),
    ).toBe(`Automatic feedback \u00b7 ${SAVED_WITHOUT_REPLY}`);
    expect(SAVED_WITHOUT_REPLY).toBe("Turn saved; no evaluated reply recorded.");
    expect(rowsShow(paneColumn(reopened.terminal), "First answer.")).toBe(true);
    expect(shows(reopened.terminal, "REPL.Bindings")).toBe(false);
  });
});

describe("Tier SS — a copied location reopens the chat it named", () => {
  /** Both files of one published pair, as bytes. */
  function* pairBytes(
    root: string,
    execution: string,
  ): Operation<{ readonly entries: string; readonly sidekick: string }> {
    const paths = pairPaths(root, execution);
    return {
      entries: yield* until(readFile(paths.entries, "utf8")),
      sidekick: yield* until(readFile(paths.sidekick, "utf8")),
    };
  }

  /** Leave one mounted command, and hand back the location it ended at. */
  function* leaving(repl: MountedRepl): Operation<string> {
    yield* click(repl.terminal, "[exit]");
    yield* awaited("the command returning its outcome", () => repl.outcome() !== undefined);
    const outcome = repl.outcome();
    if (outcome === undefined || !outcome.ok) {
      throw new Error(`this command refused rather than leaving: ${String(outcome?.error)}`);
    }
    return outcome.value.location;
  }

  it("SS5: the same older chat is selected read-only, with no provider work and no writes", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss5-");
    let copied = "";
    let execution = "";
    let root = "";
    let before: { entries: string; sidekick: string } | undefined;

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      root = host.root;
      const repl = yield* useMountedRepl({ host });
      repl.fake.configuration({
        model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
        effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
      });
      repl.fake.script({ reply: "<Output>Older answer.</Output>\n" });
      repl.fake.script({ reply: "<Output>Newer answer.</Output>\n" });

      yield* sendMessage(repl, "older ask");
      yield* awaiting(repl.terminal, "the older reply", (one) => shows(one, "Older answer."));
      yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
      yield* settled(60);
      yield* focusOn(repl.terminal, `> Agent: `);
      for (let press = 0; press < MOUNTED_AGENT.length; press += 1) {
        repl.terminal.feed("\x7f");
        yield* settled(8);
      }
      yield* typing(repl.terminal, OTHER_MOUNTED_AGENT);
      yield* awaiting(repl.terminal, "the replacement control", (one) =>
        shows(one, "[start new conversation]"),
      );
      yield* click(repl.terminal, "[start new conversation]", 96);
      yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
        shows(one, "No messages yet."),
      );
      yield* sendMessage(repl, "newer ask");
      yield* awaiting(repl.terminal, "the newer reply", (one) => shows(one, "Newer answer."));

      // The older chat, opened from its own Sessions row, and the location
      // that view ends at.
      yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "older ask"));
      yield* awaiting(repl.terminal, "the older chat opening", (one) =>
        rowsShow(paneColumn(one), "Older answer."),
      );
      execution = yield* mountedExecution(repl);
      before = yield* pairBytes(host.root, execution);
      copied = yield* leaving(repl);
    });

    // The location really names the chat rather than remembering it somewhere.
    expect(copied).toContain("sidekick=");
    expect(copied).toContain("view=sidekick");
    if (before === undefined) {
      throw new Error("this run published no pair to compare against");
    }

    // A fresh command over the same files: a new host, a new repository handle
    // and a transport nobody has used. Only the location and the files cross.
    const second = yield* useMountedHost({ dataRoot });
    const reopened = yield* useMountedRepl({ host: second, location: copied });

    // The same older chat is what it is reading, read-only.
    expect(rowsShow(paneColumn(reopened.terminal), "Older answer.")).toBe(true);
    expect(rowsShow(paneColumn(reopened.terminal), "Newer answer.")).toBe(false);
    expect(rowsShow(paneColumn(reopened.terminal), MESSAGE_PROMPT)).toBe(false);
    expect(rowsShow(paneColumn(reopened.terminal), "[send]")).toBe(false);
    expect(rowsShow(paneColumn(reopened.terminal), "[Back to current chat]")).toBe(true);

    // And it asked nobody anything: no runtime, no session, no prompt. Pure
    // reading is what reopening a chat is.
    expect(second.fake.created).toEqual([]);
    expect(second.fake.ensured).toEqual([]);
    expect(second.fake.prompts).toEqual([]);
    // Both files are byte-identical: reading appends nothing.
    expect(yield* pairBytes(root, execution)).toEqual(before);

    // Back works, and the current association is the one the history holds —
    // the chat the replacement opened, not the one that was being read.
    yield* click(reopened.terminal, "[Back to current chat]");
    yield* awaiting(reopened.terminal, "the current chat coming back", (one) =>
      rowsShow(paneColumn(one), "Newer answer."),
    );
    expect(rowsShow(paneColumn(reopened.terminal), `[configure ${OTHER_MOUNTED_AGENT}]`)).toBe(
      true,
    );
    expect(yield* pairBytes(root, execution)).toEqual(before);
  });

  it("SS5: selecting another surface and coming back does not forget the pinned chat", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: "<Output>Only answer.</Output>\n" });
    yield* sendMessage(repl, "only ask");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Only answer."));

    // Explicitly selecting the chat that is also the current one: it keeps its
    // usual controls, because it *is* the active association.
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "only ask"));
    yield* awaiting(repl.terminal, "the selector standing", (one) =>
      rowsShow(paneColumn(one), "[Back to current chat]"),
    );
    expect(rowsShow(paneColumn(repl.terminal), MESSAGE_PROMPT)).toBe(true);
    expect(rowsShow(paneColumn(repl.terminal), "[send]")).toBe(true);

    // Bindings, and back. The selection is kept for returning to.
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(repl.terminal, "the inspector", (one) => panePresented(one) === "bindings");
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the chat coming back", (one) =>
      rowsShow(paneColumn(one), "Only answer."),
    );
    expect(rowsShow(paneColumn(repl.terminal), "[Back to current chat]")).toBe(true);

    // And the Entries catalog, and back. Entries opens a drawer over the
    // reading rather than routing to a column of its own, so it is put away
    // before the pane beneath it is reached for — a modal owns the keyboard
    // while it is up, and Tab through one would be Tab through a modal.
    yield* openCatalog(repl.terminal);
    yield* closeCatalog(repl.terminal);
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the chat coming back again", (one) =>
      rowsShow(paneColumn(one), "Only answer."),
    );
    expect(rowsShow(paneColumn(repl.terminal), "[Back to current chat]")).toBe(true);
  });

  it("SS2: a chat whose setup failed opens read-only, saying what became of it", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss2-setup-");
    let execution = "";
    let root = "";
    let failed = "";
    let before: { entries: string; sidekick: string } | undefined;

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      root = host.root;
      const repl = yield* useMountedRepl({ host });
      repl.fake.configuration({
        model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
        effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
      });
      repl.fake.script({ reply: "<Output>The only answer.</Output>\n" });
      // The replacement agent cannot be started here, so its setup really
      // fails: the association before it is preserved and the chat it opened
      // is left on disk as the failure it was.
      repl.fake.unavailable(OTHER_MOUNTED_AGENT, new Error("that agent will not start here"));

      yield* sendMessage(repl, "only ask");
      yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "The only answer."));
      yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
      yield* settled(60);
      yield* focusOn(repl.terminal, `> Agent: `);
      for (let press = 0; press < MOUNTED_AGENT.length; press += 1) {
        repl.terminal.feed("\x7f");
        yield* settled(8);
      }
      yield* typing(repl.terminal, OTHER_MOUNTED_AGENT);
      yield* awaiting(repl.terminal, "the replacement control", (one) =>
        shows(one, "[start new conversation]"),
      );
      yield* click(repl.terminal, "[start new conversation]", 96);
      yield* awaiting(repl.terminal, "the reason the replacement gave", (one) =>
        shows(one, "will not start"),
      );
      execution = yield* mountedExecution(repl);
      before = yield* pairBytes(host.root, execution);
      yield* click(repl.terminal, "[exit]");
      yield* awaited("the command leaving", () => repl.outcome() !== undefined);
    });
    if (before === undefined) {
      throw new Error("this run published no pair to compare against");
    }

    // The chat that failed, named by the history rather than by this fixture:
    // its own conversation record is what says the setup failed and why.
    const projected = projectSidekick(
      yield* readSidekickRecords(pairPaths(root, execution).sidekick),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    const broken = projected.value.conversations.find((one) => one.phase === "failed");
    expect(broken?.failure).toContain("will not start");
    // It really is a chat with no provider key and no turn of its own: there
    // is nothing about it but its setup.
    expect(projected.value.turns.filter((one) => one.conversation === broken?.id)).toEqual([]);
    failed = broken?.id ?? "";
    expect(failed).not.toBe("");

    // Cold, over the same files, with a transport nobody has used.
    const cold = yield* useMountedHost({ dataRoot });
    const reopened = yield* useMountedRepl({
      host: cold,
      location:
        `xmd://repl/${execution}/sessions?view=sidekick&right=sidekick` +
        `&sidekick=${encodeURIComponent(failed)}`,
    });

    // It opens, and what it says is that chat's own setup status with the
    // agent's own reason — not an absence of messages, and not the current
    // chat's conversation.
    yield* awaiting(reopened.terminal, "the failed chat's own status", (one) =>
      rowsShow(paneColumn(one), "Setup failed:"),
    );
    // The agent's own words, as far as a pane this wide holds them: the whole
    // reason is established from the record above, and this is the screen
    // carrying it rather than a sentence of this product's own.
    expect(rowsShow(paneColumn(reopened.terminal), "Setup failed: that agent will")).toBe(true);
    expect(rowsShow(paneColumn(reopened.terminal), "The only answer.")).toBe(false);
    // Read-only, like every chat that is not the active association.
    expect(rowsShow(paneColumn(reopened.terminal), MESSAGE_PROMPT)).toBe(false);
    expect(rowsShow(paneColumn(reopened.terminal), "[send]")).toBe(false);
    expect(rowsShow(paneColumn(reopened.terminal), "[Back to current chat]")).toBe(true);

    // And reading it ran nothing and wrote nothing.
    expect(cold.fake.created).toEqual([]);
    expect(cold.fake.ensured).toEqual([]);
    expect(cold.fake.prompts).toEqual([]);
    expect(yield* pairBytes(root, execution)).toEqual(before);

    // Back comes home to the association the failed replacement preserved.
    yield* click(reopened.terminal, "[Back to current chat]");
    yield* awaiting(reopened.terminal, "the preserved chat coming back", (one) =>
      rowsShow(paneColumn(one), "The only answer."),
    );
    expect(rowsShow(paneColumn(reopened.terminal), `[configure ${MOUNTED_AGENT}]`)).toBe(true);
    expect(yield* pairBytes(root, execution)).toEqual(before);
  });

  it("SS2: an unknown chat refuses cold before an unfinished entry could resume", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss2-unfinished-");
    let execution = "";
    let root = "";

    // One real execution whose last entry never finished: its turn is in
    // flight when the process ends, which is the state a reopening has
    // something to do with.
    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      root = host.root;
      const repl = yield* useMountedRepl({ host });
      repl.fake.script({ reply: "<Output>Chat answer.</Output>\n" });
      // The entry's own turn, held: the entry is running and waiting on this
      // provider when the process below it goes away.
      repl.fake.script({ held: true, reply: "ENTRY-NEVER" });

      yield* sendMessage(repl, "chat ask");
      yield* awaiting(repl.terminal, "the chat reply", (one) => shows(one, "Chat answer."));
      yield* submitEntry(repl, promptEntry("unfinished-entry"));
      // The barrier: the entry really is asking, so it is genuinely unfinished
      // rather than waiting to start.
      yield* repl.fake.holdingTurns(1);
      execution = yield* mountedExecution(repl);
      // And the process ends here, with that entry still in flight. Nothing is
      // clicked: leaving cleanly is what the row above does.
    });

    // What the first process left behind, read after it was gone.
    const before = {
      entries: yield* until(readFile(pairPaths(root, execution).entries, "utf8")),
      sidekick: yield* until(readFile(pairPaths(root, execution).sidekick, "utf8")),
    };
    const cold = yield* useMountedHost({ dataRoot });
    const left = yield* cold.repository.open(execution);
    const projected = projectRepl(yield* left.stream.readAll());
    if (!projected.ok) {
      throw projected.error;
    }
    // The entry is in that history with no outcome of its own: this is the
    // unfinished work a successful open would reach.
    const unfinished = projected.value.entries.filter((entry) => !entry.settled);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.source).toContain("unfinished-entry");

    // Refused, over exactly that history. Nothing resumed and nothing ran.
    const refused = yield* refusing(
      cold,
      `xmd://repl/${execution}/entries?view=sidekick&sidekick=never-held`,
    );
    expect(refused).toContain("never-held");
    expect(cold.fake.created).toEqual([]);
    expect(cold.fake.ensured).toEqual([]);
    expect(cold.fake.prompts).toEqual([]);
    expect({
      entries: yield* until(readFile(pairPaths(root, execution).entries, "utf8")),
      sidekick: yield* until(readFile(pairPaths(root, execution).sidekick, "utf8")),
    }).toEqual(before);

    // Control: the same location without the unknown selector opens over the
    // same unfinished history, and this is the command getting as far as its
    // own screen — which is what the refusal above came before.
    const opened = yield* useMountedRepl({
      host: cold,
      location: `xmd://repl/${execution}/entries?view=sidekick`,
    });
    yield* awaiting(opened.terminal, "the chat this execution really holds", (one) =>
      shows(one, "Chat answer."),
    );
    expect(opened.outcome()).toBe(undefined);
  });

  it("SS2: an unknown or unselectable chat refuses cold, before anything can run", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss2-");
    let execution = "";
    let before: { entries: string; sidekick: string } | undefined;
    let root = "";

    // One real execution with a chat and an entry, so a refusal that came
    // after resumption would have grown somebody's file.
    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      root = host.root;
      const repl = yield* useMountedRepl({ host });
      repl.fake.script({ reply: "<Output>Only answer.</Output>\n" });
      yield* sendMessage(repl, "only ask");
      yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Only answer."));
      yield* submitEntry(repl, TWO_STEP_ENTRY);
      yield* settledEntry(repl.terminal, 1, "ok");
      execution = yield* mountedExecution(repl);
      before = yield* pairBytes(host.root, execution);
      yield* click(repl.terminal, "[exit]");
      yield* awaited("the command leaving", () => repl.outcome() !== undefined);
    });
    if (before === undefined) {
      throw new Error("this run published no pair to compare against");
    }

    // A fresh host over the same files, with a transport nobody has used.
    const cold = yield* useMountedHost({ dataRoot });
    const legacy = "legacy-selector";
    const legacyPath = yield* legacyExecution(cold.root, legacy);
    const legacyBefore = yield* until(readFile(legacyPath, "utf8"));

    // A chat identifier this execution never held, and a legacy execution with
    // no saved chat to select at all. Each is refused on the screen the command
    // shows for a location it cannot answer.
    for (const [location, said] of [
      [`xmd://repl/${execution}/entries?view=sidekick&sidekick=never-held`, "never-held"],
      [`xmd://repl/${legacy}/entries?sidekick=anything`, "no Sidekick history"],
    ] as const) {
      expect([location, yield* refusing(cold, location)]).toEqual([
        location,
        expect.stringContaining(said),
      ]);
      // Nothing ran: no runtime created, no session established, no turn.
      expect(cold.fake.created).toEqual([]);
      expect(cold.fake.ensured).toEqual([]);
      expect(cold.fake.prompts).toEqual([]);
      // And nothing was written, which is what says the refusal came before
      // anything could replay or resume.
      expect(yield* pairBytes(root, execution)).toEqual(before);
      expect(yield* until(readFile(legacyPath, "utf8"))).toBe(legacyBefore);
    }
    // Reading one did not publish a pair for it either.
    expect(yield* published(root)).toEqual([execution]);
  });
});

/**
 * Open one location that cannot be shown, and hand back its refusal.
 *
 * The command's own outcome rather than the cells, because a refusal is a
 * sentence and a sentence is paid out over as many rows as the frame has: a
 * row matching a phrase on one line would be asserting about the width.
 */
function* refusing(host: MountedHost, location: string): Operation<string> {
  return yield* scoped(function* (): Operation<string> {
    const recording = recordingTerminal();
    yield* recording.install();
    const outcome: { value?: Result<ReplOutcome> } = {};
    const running = yield* spawn(function* (): Operation<void> {
      outcome.value = yield* runReplProgram({ profile: host.profile, location });
    });
    // The refusal screen offers a way out and no draft, which is what says it
    // is the refusal rather than a reading.
    yield* awaiting(
      recording.terminal,
      `the refusal screen for ${location}`,
      (one) => shows(one, "[exit]") && maybeDraftRow(one) === undefined,
    );
    recording.terminal.feed("\x1b");
    yield* running;
    const settledOutcome = outcome.value;
    if (settledOutcome === undefined || settledOutcome.ok) {
      throw new Error(`${location} was shown rather than refused`);
    }
    return settledOutcome.error.message;
  });
}

/**
 * One turn held at the operation that would append its canonical Prompt.
 *
 * `stopped` chooses the boundary this exercises. Stopped, the operation holding
 * that append is cancelled and the record is never written at all — which is
 * what makes the no-saved-turn and cold-refusal rows below assertions about the
 * file rather than about when it was read. Released, the same boundary goes on
 * and the turn is saved, which is the control that says the hold was the only
 * difference.
 *
 * The hold is the contextual operation itself rather than a Promise the host
 * has already been handed: a native append cannot be taken back, so a gate in
 * front of one proves nothing about cancellation.
 */
function* stoppedBeforeAppend(stopped: boolean): Operation<void> {
  const dataRoot = yield* useTemporary(`xmd-repl-ss3-${stopped ? "stop" : "release"}-`);
  const operations = operationGate();
  let execution = "";
  let observed = "";

  yield* scoped(function* (): Operation<void> {
    const host = yield* useMountedHost({ dataRoot, operations });
    const repl = yield* useMountedRepl({ host });
    // A turn the adapter names, so its completion carries a checkpoint and its
    // publication association really names a conversation.
    repl.fake.script({ reply: "<Output>Never saved.</Output>\n", turnId: "sk-turn-stop" });

    // The canonical Prompt's own append, held inside the operation that
    // performs it — and the record it carries kept, because the key this row
    // is about is the one that publication actually named rather than one read
    // off an elided column or predicted from an ordinal.
    const appending = operations.holdNext((path, record) => {
      if (!path.endsWith(SIDEKICK_FILE) || !record.includes("agent_prompt")) {
        return false;
      }
      observed = /xmd:v1:[0-9a-f:]+/.exec(record)?.[0] ?? "";
      return true;
    });
    yield* sendMessage(repl, "stop me");
    yield* appending.started();
    expect(observed).not.toBe("");
    expect(appending.holding).toBe(true);

    // The key is offered and chosen while the turn is still unsaved.
    yield* openFilter(repl.terminal);
    yield* awaiting(repl.terminal, "the live turn's conversation being offered", (one) =>
      sessionsColumn(one).some((line) => line.includes("xmd:v1:")),
    );
    const offered = sessionsColumn(repl.terminal).find((line) => line.includes("xmd:v1:"));
    yield* click(repl.terminal, (offered ?? "").trim());
    yield* awaiting(repl.terminal, "the filter being applied", (one) => filteredTo(one, observed));

    if (stopped) {
      // Stop, with that append's own operation still suspended. This is the
      // boundary: the provider answered, the publication named its
      // conversation, and the record that would have made the turn saved is
      // one this process is now taking back rather than one it will write.
      yield* click(repl.terminal, "[stop]");
      yield* awaiting(repl.terminal, "the Sidekick going idle", (one) => shows(one, "[send]"));
      // The operation came down without appending, and nothing is holding any
      // more: Stop joined it rather than leaving a write scheduled.
      yield* awaited("the held append's operation coming down", () => appending.abandoned);
      expect(appending.holding).toBe(false);
    } else {
      appending.release();
      yield* awaiting(repl.terminal, "the turn being saved", (one) =>
        columnShows(sessionsColumn(one), "stop me · completed"),
      );
    }

    // What the host physically wrote. A path lands here only after the real
    // append returned, so this is the fact the earlier Promise gate could not
    // establish: with Stop, no canonical Prompt was ever written.
    expect(
      operations.appended.some(
        (one) => one.path.endsWith(SIDEKICK_FILE) && one.record.includes("agent_prompt"),
      ),
    ).toBe(!stopped);

    // And the history says the same. The chat holds the message somebody sent;
    // whether it holds a turn is exactly what the hold decided.
    const after = yield* mountedReading(repl);
    expect(chatMessages(after.chat)).toEqual(["stop me"]);
    const prompts = after.chat.filter((record) => {
      if (record.kind !== "event") {
        return false;
      }
      // Narrowed by the discriminant the record already carries: an `event`
      // record holds its serialized durable event, and what makes this one the
      // canonical Prompt is that event naming an agent prompt.
      return record.event.includes("agent_prompt");
    });
    expect(prompts).toHaveLength(stopped ? 0 : 1);
    const projected = projectSidekick(after.chat);
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.turns).toHaveLength(stopped ? 0 : 1);

    // The filter the person selected is still a filter either way: the key was
    // genuinely observed by this process, so it does not become guessed
    // emptiness because nothing was saved under it.
    expect(filteredTo(repl.terminal, observed)).toBe(true);
    expect(sessionsColumn(repl.terminal).some((line) => line.includes("xmd:v1:"))).toBe(true);

    execution = yield* mountedExecution(repl);
    yield* click(repl.terminal, "[exit]");
    yield* awaited("the command leaving", () => repl.outcome() !== undefined);
  });

  // Cold, over the files that process left. A key no canonical turn was saved
  // under is not a key at all: it was this process's observation, and a
  // location naming it is refused rather than answered with an apparently
  // empty conversation. The control's key *was* saved, so it resolves.
  const cold = yield* useMountedHost({ dataRoot });
  const location = `xmd://repl/${execution}/sessions?session=${encodeURIComponent(observed)}`;
  if (stopped) {
    const refused = yield* refusing(cold, location);
    expect(refused).toContain(observed);
  } else {
    const reopened = yield* useMountedRepl({ host: cold, location });
    yield* awaiting(reopened.terminal, "the saved conversation filtering cold", (one) =>
      filteredTo(one, observed),
    );
  }
  expect(cold.fake.created).toEqual([]);
  expect(cold.fake.prompts).toEqual([]);
}

describe("Tier SS — the filter both sections share", () => {
  it("SS3: one provider key both owners used is one choice, and keeps both rows", function* () {
    // A real entry history with real agent conversations in it, and a Sidekick
    // turn that names the same provider conversation one of those entry turns
    // named. Two owners, one key.
    const events = yield* agentReferenceEvents();
    const model = projectRepl(events);
    if (!model.ok) {
      throw model.error;
    }
    const shared = model.value.sessions[0]?.sessionKey;
    if (shared === undefined) {
      throw new Error("this reference history retained no agent conversation");
    }
    const reading = sidekickReading({
      conversation: "chat-1",
      reading: "chat-1",
      turns: Object.freeze([
        {
          key: "sidekick:chat-1:response:1",
          conversation: "chat-1",
          agent: MOUNTED_AGENT,
          turn: 1,
          title: "shared key ask",
          state: "completed",
          running: false,
          failed: false,
          sessionKey: shared,
          text: "Shared answer.",
          failure: undefined,
        },
      ]),
      availability: Object.freeze({
        chats: Object.freeze(["chat-1"]),
        sessions: Object.freeze([shared]),
        refusal: undefined,
      }),
    });

    // Unfiltered: the key is offered once, however many owners used it. Two
    // controls for one conversation would be two ways to choose the same thing.
    const all = yield* sessionsKeys(reading, { events });
    expect(all.filter((key) => key === `sessions:conversation:${shared}`)).toHaveLength(1);

    // Chosen: both owners' rows for that conversation are in the reading, each
    // in its own section, and neither section reports itself empty.
    const filtered = yield* sessionsKeys(reading, { events, session: shared });
    expect(filtered).toContain("sessions:section:entries");
    expect(filtered).toContain("sessions:section:sidekick");
    expect(filtered).toContain("sessions:sidekick:chat-1:response:1");
    expect(filtered).not.toContain("sessions:entries:none");
    expect(filtered).not.toContain("sessions:sidekick:none");
    // The entry section really does hold a row of its own under that filter.
    expect(filtered.some((key) => key.startsWith("sessions:turn:"))).toBe(true);
  });

  it("SS3: a live key filters its own unsaved row, and survives the cycle ending", function* () {
    const gate = appendGate();
    const host = yield* useMountedHost({ gate });
    const repl = yield* useMountedRepl({ host });
    // A turn whose adapter names it, so its completion really carries a
    // checkpoint — which is what makes a publication association exist at all.
    repl.fake.script({ reply: "<Output>Said it.</Output>\n", turnId: "sk-turn-1" });

    // The canonical append held: the provider has answered, its publication
    // association has named a conversation, and nothing is acknowledged yet.
    // The append that carries the canonical Prompt, which is the one whose
    // acknowledgement makes a turn saved — not the conversation record this
    // history writes before anything is asked of a provider.
    const appended = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes("agent_prompt"),
    );
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "say it");
    // This screen has two Sends — the entry draft's and this composer's — so
    // the column the Sidekick's own pane begins at is what names which one.
    // Clicking the leftmost would submit a draft instead of sending a message.
    yield* click(repl.terminal, "[send]", sidekickColumn(repl.terminal));
    yield* appended.started();

    // The key its own publication named is offered as a filter, and the live
    // row it belongs to is shown under it — while that row is still unsaved.
    yield* openFilter(repl.terminal);
    const offered = sessionsColumn(repl.terminal).find((line) => line.includes("xmd:v1:"));
    if (offered === undefined) {
      throw new Error(
        `no conversation was offered. rows=${JSON.stringify(sessionsColumn(repl.terminal))}`,
      );
    }
    const key = offered.trim();
    // The row's own text is the key's headline, shortened to the column it is
    // drawn in; the key itself is what the selector names afterwards.
    const named = /xmd:v1:[0-9a-f:]+/.exec(offered)?.[0] ?? "";
    expect(named).not.toBe("");
    yield* click(repl.terminal, key);
    yield* awaiting(repl.terminal, "the filter being applied", (one) => filteredTo(one, named));
    // The turn is still there under it: a key an exact publication established
    // is membership for its own live row, acknowledged or not.
    expect(columnShows(sessionsColumn(repl.terminal), "say it")).toBe(true);
    // And nothing is saved: the append is still in flight.
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["say it"]);

    // The append let go so the cycle can come down, and then Stop. What this
    // row is about is the filter surviving that; the boundary *before* the
    // append is acknowledged has its own paired row above, where the hold is
    // the operation rather than the Promise the host was handed.
    appended.release();
    yield* click(repl.terminal, "[stop]");
    yield* awaiting(repl.terminal, "the Sidekick going idle", (one) => shows(one, "[send]"));

    // The filter the person selected is still a filter — the key was genuinely
    // observed, so it does not become guessed emptiness — and the conversation
    // is still offered.
    expect(filteredTo(repl.terminal, named)).toBe(true);
    expect(sessionsColumn(repl.terminal).some((line) => line.includes("xmd:v1:"))).toBe(true);
  });

  it("SS3: Stop before the canonical append leaves the key local and nothing saved", function* () {
    yield* stoppedBeforeAppend(true);
  });

  it("SS3: control — released rather than stopped, that boundary saves its turn", function* () {
    yield* stoppedBeforeAppend(false);
  });

  it("SS3: a Sidekick key is selectable at an entry checkpoint that precedes it", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss3-");
    let execution = "";
    let marker = "";
    let entryKey = "";
    let chatKey = "";

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      const repl = yield* useMountedRepl({ host });
      repl.fake.script({ reply: "ENTRY-REPLY" });
      repl.fake.script({ reply: "<Output>Chat answer.</Output>\n" });

      // One entry with no Agent work of its own, which settles and leaves a
      // recorded checkpoint behind it.
      yield* submitEntry(repl, TWO_STEP_ENTRY);
      yield* settledEntry(repl.terminal, 1, "ok");
      const first = yield* mountedReading(repl);
      marker = first.model.checkpoints[first.model.checkpoints.length - 1]?.marker ?? "";
      expect(marker).not.toBe("");

      // Then an entry whose own Prompt opens a provider conversation, and a
      // Sidekick turn in a chat of its own. Both happen entirely after that
      // checkpoint.
      yield* focusDraft(repl.terminal);
      repl.terminal.bytes(new TextEncoder().encode(promptEntry("later-entry")));
      yield* settled(60);
      repl.terminal.feed("\r");
      yield* awaiting(repl.terminal, "the second entry's turn being recorded", (one) =>
        columnShows(sessionsColumn(one), "later-entry \u00b7 completed, recorded"),
      );
      yield* sendMessage(repl, "chat ask");
      yield* awaiting(repl.terminal, "the chat reply", (one) => shows(one, "Chat answer."));

      execution = yield* mountedExecution(repl);
      const read = yield* mountedReading(repl);
      entryKey = read.model.turns.map((one) => one.sessionKey).find((one) => one.length > 0) ?? "";
      const chat = projectSidekick(read.chat);
      if (!chat.ok) {
        throw chat.error;
      }
      chatKey =
        chat.value.turns.map((one) => one.sessionKey).find((one) => one !== undefined) ?? "";
      expect(entryKey).not.toBe("");
      expect(chatKey).not.toBe("");
      expect(entryKey).not.toBe(chatKey);

      yield* click(repl.terminal, "[exit]");
      yield* awaited("the command leaving", () => repl.outcome() !== undefined);
    });

    const cold = yield* useMountedHost({ dataRoot });
    // The Sidekick's own key, beside a checkpoint that precedes its
    // conversation entirely. It resolves, because freezing a prefix freezes
    // *entry* facts and a chat has no position in that history.
    const reopened = yield* useMountedRepl({
      host: cold,
      location:
        `xmd://repl/${execution}/sessions?at=${encodeURIComponent(marker)}` +
        `&inspect&session=${encodeURIComponent(chatKey)}`,
    });
    expect(filteredTo(reopened.terminal, chatKey)).toBe(true);
    expect(columnShows(sessionsColumn(reopened.terminal), "chat ask")).toBe(true);
    // The entry prefix really is frozen there: the entry whose turn carries
    // the other key was admitted after this position, so it is not in the
    // reading at all.
    expect(columnLacks(sessionsColumn(reopened.terminal), "later-entry")).toBe(true);

    // And the entry-only key is still refused at that prefix: nothing here
    // widens what the selected prefix retained.
    const refused = yield* refusing(
      cold,
      `xmd://repl/${execution}/sessions?at=${encodeURIComponent(marker)}` +
        `&inspect&session=${encodeURIComponent(entryKey)}`,
    );
    expect(refused).toContain(entryKey);
    expect(refused).toContain("had started at this history position");
  });
});

describe("Tier SS — what reaches the screen, and at every size", () => {
  it("SS7: a held turn's every material fact arrives with nothing pressed", function* () {
    const repl = yield* useMountedRepl();
    // One turn whose pieces this case steps through, so each boundary in the
    // transport is one the screen is read at.
    repl.fake.script({
      deltas: ["<Output>Half", " said.</Output>\n"],
      holdsEachPiece: true,
    });

    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "hold it");
    // This screen has two Sends — the entry draft's and this composer's — so
    // the column the Sidekick's own pane begins at is what names which one.
    // Clicking the leftmost would submit a draft instead of sending a message.
    yield* click(repl.terminal, "[send]", sidekickColumn(repl.terminal));
    yield* repl.fake.streamingTurns(1);

    // From here nothing is typed, clicked or submitted, and this is what says
    // so: a claim about the screen moving on its own is only a claim if no
    // keystroke could have caused it.
    const fed = repl.terminal.fed;
    yield* awaiting(repl.terminal, "the turn being announced", (one) =>
      columnShows(sessionsColumn(one), "hold it"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // It is announced with no Output of its own: the row exists because the
    // turn does, and this is the phase it is in rather than a reply.
    expect(columnShows(sessionsColumn(repl.terminal), "hold it \u00b7 generating")).toBe(true);
    // And the message box is empty, which is the second material fact: the
    // text was taken by the turn that is now running, and nothing was pressed
    // to clear it.
    expect(messageText(repl.terminal)).toBe("");

    repl.fake.releaseDeltas();
    yield* awaiting(repl.terminal, "the saved turn and its reply arriving", (one) =>
      columnShows(sessionsColumn(one), "hold it · completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    expect(saidBySidekick(repl.terminal, `Half said.`)).toBe(true);
  });

  it("SS7: a saved Prompt and a reply still being evaluated are two facts, unpressed", function* () {
    const repl = yield* useMountedRepl();
    // A reply whose program prepares and submits an entry, so the response's
    // own evaluation waits for that entry — which is the interval between the
    // provider's turn being saved and the reply it produced existing.
    repl.fake.script({
      reply: [
        '<Let as="code" select="code">',
        "````xmd",
        // An entry that asks this provider, so the entry's own turn is the
        // thing the Sidekick's evaluation is waiting for.
        promptEntry("held entry").trimEnd(),
        "````",
        "</Let>",
        "<REPL.EntryInput>{code}</REPL.EntryInput>",
        "<REPL.Submit />",
        "",
      ].join("\n"),
    });
    // The entry's own turn, held: the entry runs, asks this provider, and waits
    // here. Nothing in the Sidekick's cycle can proceed past it.
    repl.fake.script({ held: true, reply: "ENTRY-ANSWER" });

    yield* sendMessage(repl, "evaluate it");
    yield* repl.fake.holdingTurns(1);

    // From here nothing is typed or clicked.
    const fed = repl.terminal.fed;
    yield* awaiting(repl.terminal, "the reply being evaluated", (one) =>
      columnShows(sessionsColumn(one), "evaluate it \u00b7 evaluating the reply"),
    );
    expect(repl.terminal.fed).toBe(fed);

    // The provider's turn really is saved, and no reply has been published
    // against it: the two facts the row is separating are both on disk.
    const held = yield* mountedReading(repl);
    expect(
      held.chat.filter(
        // Narrowed by the discriminant the record already carries.
        (record) => record.kind === "event" && record.event.includes("agent_prompt"),
      ),
    ).toHaveLength(1);
    expect(held.chat.some((record) => record.kind === "response")).toBe(false);

    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the reply settling under the same row", (one) =>
      columnShows(sessionsColumn(one), "evaluate it · completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // One row for that turn throughout: the outcome replaced what it says.
    expect(columnCount(sessionsColumn(repl.terminal), "evaluate it")).toBe(1);
  });

  it("SS7: control — an ordinary entry turn reaches the Sessions reading the same way", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: "ENTRY-REPLY" });

    yield* submitEntry(repl, promptEntry("control-ask"));
    const fed = repl.terminal.fed;
    yield* awaiting(repl.terminal, "the entry turn being recorded with no keystroke", (one) =>
      columnShows(sessionsColumn(one), "control-ask · completed, recorded"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // One list, and this turn is the entry's own: the row says whose work it is
    // and which conversation it was in, which is where that fact lives now —
    // the headings over blocks of rows were taken away deliberately. Nothing of
    // the Sidekick's is in it, because the Sidekick has done none.
    const listed = sessionsColumn(repl.terminal);
    expect(columnShows(listed, "Entry agents")).toBe(false);
    expect(columnShows(listed, MOUNTED_AGENT)).toBe(true);
    expect(columnCount(listed, "control-ask")).toBe(1);
  });

  it("SS7: three profiles keep a populated older reading, its window and the way home", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration({
      model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    const TURNS = 6;
    for (let number = 1; number <= TURNS; number += 1) {
      repl.fake.script({ reply: `<Output>OLD-${number}</Output>\n` });
    }
    repl.fake.script({ reply: "<Output>Current answer.</Output>\n" });

    for (let number = 1; number <= TURNS; number += 1) {
      yield* sendMessage(repl, `old-${number}`);
      yield* repliesSaved(repl, number);
    }

    // A real replacement, so the populated chat is a nonactive one.
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    yield* focusOn(repl.terminal, `> Agent: `);
    for (let press = 0; press < MOUNTED_AGENT.length; press += 1) {
      repl.terminal.feed("\x7f");
      yield* settled(8);
    }
    yield* typing(repl.terminal, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the replacement control", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
      shows(one, "No messages yet."),
    );
    yield* sendMessage(repl, "current ask");
    yield* awaiting(repl.terminal, "the current reply", (one) => shows(one, "Current answer."));

    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "my q");

    // The last turn of the populated older chat, reached through the Sessions
    // section's own window control and then activated.
    for (let press = 0; press < 40; press += 1) {
      if (sessionsColumn(repl.terminal).some((line) => line.includes(`old-${TURNS} `))) {
        break;
      }
      yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, LATER));
    }
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, `old-${TURNS} `));
    yield* awaiting(repl.terminal, "the older chat opening on that turn", (one) =>
      rowsShow(paneColumn(one), `OLD-${TURNS}`),
    );

    for (const size of PROFILES) {
      const rows = yield* readingAt(repl.terminal, size);
      // The way out is in the footer at every size, found by the row it is
      // actually on. How many rows a footer takes is the composition's
      // business, and this one says what it has to say in one compact History
      // row and one of directions below it.
      expect((rows()[footerRow(rows())] ?? "").includes("[exit]")).toBe(true);
      // The chat being read is the older one, opened at the turn that was
      // chosen — the window is placed on it rather than left at whichever end
      // it happened to be — and the way home is reachable at every size.
      expect(rowsShow(rows(), `OLD-${TURNS}`)).toBe(true);
      expect(rowsShow(rows(), "[Back to current chat]")).toBe(true);
      // Read-only: no composer, no Send and no Configure for a chat nobody may
      // continue — and so the partial message is not drawn either. Asked of
      // that pane rather than of the screen: the entry draft has a Send of its
      // own in a different column, and a question about this chat's controls
      // that found that one would answer about the wrong destination.
      expect(rowsShow(conversationPane(rows(), size), "[send]")).toBe(false);
      expect(rowsShow(rows(), `[configure `)).toBe(false);
      if (size.columns >= 120) {
        // The one Transcript list, the pane's own tab, and both window
        // controls, where the frame has columns for them. Whose work a row is
        // is said on the row — the headings over blocks of them are gone.
        expect(rowsShow(rows(), "Entry agents")).toBe(false);
        expect(rowsShow(rows(), "TRANSCRIPT")).toBe(true);
        expect(rowsShow(rows(), PANE_TABS.sidekick)).toBe(true);
        expect(rowsShow(rows(), EARLIER)).toBe(true);
        expect(rowsShow(rows(), LATER)).toBe(true);
        // The entry draft is this screen's and is drawn beside this reading.
        expect(blockSays(draftTextIn(rows()), "my entry")).toBe(true);
        continue;
      }
      // A narrow frame routes one outlet and this route is reading the chat, so
      // the draft is in no cell of it. It is read where it is drawn, which is
      // what the widest size above has already done.
      expect(rows().some((line) => line.includes(DRAFT_PROMPT))).toBe(false);
    }

    // Home again, at the widest size: the current chat, its controls and the
    // partial message this screen was holding all the way through.
    yield* readingAt(repl.terminal, PROFILES[0]);
    yield* click(repl.terminal, "[Back to current chat]");
    yield* awaiting(repl.terminal, "the current chat coming back", (one) =>
      rowsShow(paneColumn(one), "Current answer."),
    );
    expect(messageText(repl.terminal)).toBe("my q");
    expect(draftText(repl.terminal)).toBe("my entry");
  });

  it("SS7: three profiles keep both sections, the window, Back and both texts", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: "<Output>Older answer.</Output>\n" });
    yield* sendMessage(repl, "older ask");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Older answer."));
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "my q");

    for (const size of PROFILES) {
      const rows = yield* readingAt(repl.terminal, size);
      // The way out is in the footer at every size, found by the row it is
      // actually on. How many rows a footer takes is the composition's
      // business, and this one says what it has to say in one compact History
      // row and one of directions below it.
      expect((rows()[footerRow(rows())] ?? "").includes("[exit]")).toBe(true);
      if (size.columns >= 120) {
        // Both texts survive every size: neither is a property of the frame.
        // Both are drawn here, each in its own destination's block, with the
        // one Transcript list, the pane's own tab and the window controls where
        // the frame places them — and no headings over blocks of rows, because
        // whose work a row is is said on the row.
        expect(blockSays(draftTextIn(rows()), "my entry")).toBe(true);
        expect(messageTextIn(rows()).includes("my q")).toBe(true);
        expect(rowsShow(rows(), "Entry agents")).toBe(false);
        expect(rowsShow(rows(), "TRANSCRIPT")).toBe(true);
        expect(rowsShow(rows(), PANE_TABS.sidekick)).toBe(true);
        expect(rowsShow(rows(), EARLIER)).toBe(true);
        expect(rowsShow(rows(), LATER)).toBe(true);
        continue;
      }
      // A narrow frame routes one outlet, and the Sidekick is the one this
      // reading asked for — so the chat's text is drawn and the draft is in no
      // cell. Neither is lost: the draft is read by going back to the entries,
      // which is the outlet that has it, and the chat is still holding its own
      // when the frame is wide enough to draw both again.
      expect(messageTextIn(rows()).includes("my q")).toBe(true);
      expect(rows().some((line) => line.includes(DRAFT_PROMPT))).toBe(false);
      yield* openCatalog(repl.terminal);
      yield* closeCatalog(repl.terminal);
      yield* awaiting(repl.terminal, "the draft back on the narrow outlet", (one) =>
        blockSays(draftTextIn(screenOf(one)), "my entry"),
      );
    }

    // Back at the widest size, read the older chat and prove the read-only
    // controls are absent from the screen at every size it is drawn at.
    const widest = yield* readingAt(repl.terminal, PROFILES[0]);
    expect(rowsShow(widest(), "older ask")).toBe(true);
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, "older ask"));
    yield* awaiting(repl.terminal, "the selector standing", (one) =>
      rowsShow(paneColumn(one), "[Back to current chat]"),
    );
    for (const size of PROFILES) {
      const rows = yield* readingAt(repl.terminal, size);
      if (size.columns >= 120) {
        // The current chat *is* the chat being read here, so it keeps its own
        // controls — and Back is reachable beside them, outside the window.
        expect(rowsShow(rows(), "[Back to current chat]")).toBe(true);
      }
      expect((rows()[footerRow(rows())] ?? "").includes("[exit]")).toBe(true);
    }
  });
});

/**
 * Tier CF — a chat keeps every message whole, and follows the newest (#883).
 *
 * Two demonstrated problems, from the Product Owner's own report. A message
 * with its own line breaks was drawn as one row and overflowed into the row
 * beneath it, so the next exchange painted over the rest of it. And a chat
 * whose window had filled kept showing its first screenful, so an
 * acknowledged reply never arrived on screen.
 *
 * Both are read off the real mounted terminal at the sizes a person uses, with
 * the saved history beside the screen: what a chat holds and what it shows are
 * two assertions, and the point of these rows is that the second one stops losing
 * the first.
 */
describe("Tier CF — complete chat messages, and the newest ones in view", () => {
  /** The pane's rows without the divider they begin at, blank rows dropped. */
  function chatRows(terminal: Terminal): string[] {
    return paneColumn(terminal).map((row) => (row.startsWith("│") ? row.slice(1) : row).trim());
  }

  /**
   * Where one of the chat pane's own controls is.
   *
   * Searched inside the pane's columns, because the sidebar's two readings draw
   * controls with exactly these labels: a click found by label alone scrolls
   * whichever list happens to come first on the row.
   */
  function paneCoordinate(
    terminal: Terminal,
    label: string,
  ): { readonly column: number; readonly row: number } {
    for (const [row, text] of screenOf(terminal).entries()) {
      const at = text.indexOf(label, INSPECTION_FROM);
      if (at !== -1) {
        return { column: at, row };
      }
    }
    throw new Error(`no chat row shows ${label}. rows=${JSON.stringify(chatRows(terminal))}`);
  }

  /**
   * The chat's own rows, between the two controls that move them.
   *
   * The reading alone: the pane's title, its tabs, its composer and the focus
   * marker on it are not where somebody is reading, and a comparison that
   * included them would answer about focus instead of about the reading.
   */
  function chatBody(terminal: Terminal): string[] {
    const rows = chatRows(terminal);
    const from = rows.indexOf(EARLIER_CONTROL);
    const to = rows.indexOf(LATER_CONTROL);
    if (from === -1 || to === -1) {
      throw new Error(`this pane drew no window controls. rows=${JSON.stringify(rows)}`);
    }
    return rows.slice(from + 1, to);
  }

  /**
   * Which row one piece of a message ends on.
   *
   * By suffix, because a message's first row carries who said it while its own
   * later lines carry nothing: `scribe: one-A` and `one-B` are both rows of the
   * same reply, and only the second is the bare text.
   */
  function rowAt(rows: readonly string[], part: string): number {
    return rows.findIndex((row) => row.endsWith(part));
  }

  it("CF1: a message with its own lines keeps every one of them when the next arrives", function* () {
    const repl = yield* useMountedRepl();
    // Explicit breaks, a blank line, and a line wider than the pane — which at
    // 160 columns is 36 columns of chat, so this one has to be cut.
    const wide = "a-very-long-line-that-cannot-fit-this-pane-and-must-be-cut-across-rows";
    const first = ["one-A", "one-B", "", "one-C", wide].join("\n");
    repl.fake.script({ reply: `<Output>${first}</Output>\n` });
    yield* sendMessage(repl, "first");
    yield* awaiting(repl.terminal, "the first reply drawing", (one) => shows(one, "one-A"));

    // Every authored line is its own row, in the order they were written, and
    // the over-wide one was cut rather than truncated.
    const before = chatRows(repl.terminal);
    for (const part of ["one-A", "one-B", "one-C"]) {
      expect([part, before.some((row) => row.endsWith(part))]).toEqual([part, true]);
    }
    expect(before.join("")).toContain(wide);
    expect(rowAt(before, "one-A")).toBeLessThan(rowAt(before, "one-B"));
    // The blank line somebody wrote is a row of its own, not a line dropped to
    // save space.
    expect(before[rowAt(before, "one-B") + 1]).toBe("");

    // A second exchange. Nothing of the first may be overwritten by it.
    repl.fake.script({ reply: "<Output>two-A\ntwo-B</Output>\n" });
    yield* sendMessage(repl, "second");
    yield* awaiting(repl.terminal, "the second reply drawing", (one) => shows(one, "two-A"));

    const after = chatRows(repl.terminal);
    for (const part of ["one-A", "one-B", "one-C", "two-A", "two-B"]) {
      expect([part, after.some((row) => row.endsWith(part))]).toEqual([part, true]);
    }
    expect(after.join("")).toContain(wide);
    // In order, and on rows of their own: the second message begins after the
    // first one's last row rather than on top of it.
    expect(rowAt(after, "one-C")).toBeLessThan(rowAt(after, "two-A"));
    expect(rowAt(after, "two-A")).toBeLessThan(rowAt(after, "two-B"));

    // The pane's own chrome and both composers are untouched by any of it.
    expect(panePresented(repl.terminal)).toBe("sidekick");
    expect(shows(repl.terminal, "[send]")).toBe(true);
    expect(maybeDraftRow(repl.terminal)).not.toBe(undefined);

    // And what was saved is complete, whatever the window is showing.
    const read = yield* mountedReading(repl);
    const replies = read.chat.filter((record) => record.kind === "response");
    expect(replies).toHaveLength(2);
    expect(JSON.stringify(replies[0])).toContain("one-C");
  });

  it("CF2: a chat whose window filled shows its newest reply, at every size", function* () {
    const repl = yield* useMountedRepl();
    for (let number = 1; number <= 12; number += 1) {
      repl.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
      yield* sendMessage(repl, `ask-${number}`);
    }
    // Acknowledged on disk, which is what makes the screen's answer a claim
    // about a chat rather than about a script.
    const read = yield* mountedReading(repl);
    expect(read.chat.filter((record) => record.kind === "response")).toHaveLength(12);

    // The newest reply, with nothing pressed to bring it into view.
    const fed = repl.terminal.fed;
    yield* awaiting(repl.terminal, "the newest reply at 160x36", (one) =>
      saidBySidekick(one, `ANSWER-12`),
    );
    expect(repl.terminal.fed).toBe(fed);
    // The first exchange has moved up out of the window, and that is following
    // rather than loss: it is still in the history that was just read.
    expect(chatRows(repl.terminal)).not.toContain(`[S] ANSWER-1`);
    expect(JSON.stringify(read.chat)).toContain("ANSWER-1");

    // The same at the medium size.
    const medium = yield* resizeTo(repl.terminal, { columns: 120, rows: 30 });
    expect(rowsShow(medium(), `[S] ANSWER-12`)).toBe(true);

    // And in the narrow outlet, asked for explicitly: a narrow frame has no
    // tab to activate, so the route is taken while there is one and survives
    // the shrink.
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    expect(rowsShow(narrow(), `[S] ANSWER-12`)).toBe(true);

    // Back at the wide size, the earlier messages are reachable by the chat's
    // own control, which is what "they moved up" has to mean: they went up,
    // they did not go away.
    yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* awaiting(repl.terminal, "the wide chat again", (one) =>
      rowsShow(paneColumn(one), `[S] ANSWER-12`),
    );
    let reached = false;
    for (let press = 0; press < 40 && !reached; press += 1) {
      yield* clickAt(repl.terminal, paneCoordinate(repl.terminal, EARLIER_CONTROL));
      yield* settled(12);
      reached = chatRows(repl.terminal).includes(`[S] ANSWER-1`);
    }
    expect(reached).toBe(true);
  });

  /**
   * One execution with two real conversations, each long enough to scroll.
   *
   * Through the product, like the SS tier's own two-chat fixture: messages,
   * an agent replacement that opens the second conversation, then messages in
   * that one. Both overflow their window, because a chat that fits has no
   * reading position to lose.
   */
  function* twoLongChats(repl: MountedRepl, each: number): Operation<void> {
    repl.fake.configuration({
      model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    for (let number = 1; number <= each; number += 1) {
      // Two lines each, so ten exchanges overflow the window: a chat that fits
      // has no reading position to lose, and these rows are about losing one.
      repl.fake.script({ reply: `<Output>OLD-${number}\nmore</Output>\n` });
      yield* sendMessage(repl, `old-${number}`);
    }
    yield* awaiting(repl.terminal, "the older chat's last reply", (one) =>
      saidBySidekick(one, `OLD-${each}`),
    );

    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    yield* nameAgent(repl, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the control saying it starts a new conversation", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
      shows(one, "No messages yet."),
    );

    for (let number = 1; number <= each; number += 1) {
      repl.fake.script({ reply: `<Output>NEW-${number}\nmore</Output>\n` });
      yield* sendMessage(repl, `new-${number}`);
    }
    yield* awaiting(repl.terminal, "the current chat's last reply", (one) =>
      saidBySidekick(one, `NEW-${each}`),
    );
  }

  /** Open the older chat from the Sessions reading, by one of its own turns. */
  function* readOlder(repl: MountedRepl, turn: string): Operation<void> {
    let found = false;
    for (let press = 0; press < 60 && !found; press += 1) {
      found = sessionsColumn(repl.terminal).some((line) => line.includes(turn));
      if (!found) {
        yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, LATER_CONTROL));
      }
    }
    expect(found).toBe(true);
    yield* clickAt(repl.terminal, sessionsCoordinate(repl.terminal, turn));
  }

  it("CF-P1: scrolling an older chat leaves the current chat's own reading alone", function* () {
    const repl = yield* useMountedRepl();
    yield* twoLongChats(repl, 10);

    // The current chat is at its tail, which is where following put it.
    expect(chatRows(repl.terminal)).toContain(`[S] NEW-10`);

    // An older chat, opened read-only and then scrolled: a position taken in a
    // chat somebody is only reading.
    yield* readOlder(repl, "old-1 ");
    yield* awaiting(repl.terminal, "the older chat opening", (one) =>
      rowsShow(paneColumn(one), `[S] OLD-`),
    );
    let moved = false;
    for (let press = 0; press < 40 && !moved; press += 1) {
      yield* clickAt(repl.terminal, paneCoordinate(repl.terminal, EARLIER_CONTROL));
      yield* settled(12);
      moved = !chatRows(repl.terminal).includes(`[S] OLD-10`);
    }
    expect(moved).toBe(true);

    // Back. The current chat returns to its own reading — still following, so
    // still showing its latest reply — because the chat that was scrolled was
    // somebody else's.
    yield* click(repl.terminal, "[Back to current chat]", 96);
    yield* awaiting(repl.terminal, "the current chat returning", (one) =>
      rowsShow(paneColumn(one), `[S] NEW-`),
    );
    expect(chatRows(repl.terminal)).toContain(`[S] NEW-10`);
  });

  it("CF-P1: control — a deliberate current reading also survives the visit", function* () {
    const repl = yield* useMountedRepl();
    yield* twoLongChats(repl, 10);

    // A position taken deliberately in the *current* chat, away from its tail.
    let scrolled = false;
    for (let press = 0; press < 40 && !scrolled; press += 1) {
      yield* clickAt(repl.terminal, paneCoordinate(repl.terminal, EARLIER_CONTROL));
      yield* settled(12);
      scrolled = !chatRows(repl.terminal).includes(`[S] NEW-10`);
    }
    expect(scrolled).toBe(true);
    const held = chatBody(repl.terminal);

    // Visit an older chat and come back: the reading somebody chose is the
    // reading they return to, neither re-followed nor moved by the visit.
    yield* readOlder(repl, "old-1 ");
    yield* awaiting(repl.terminal, "the older chat opening", (one) =>
      rowsShow(paneColumn(one), `[S] OLD-`),
    );
    yield* click(repl.terminal, "[Back to current chat]", 96);
    yield* awaiting(repl.terminal, "the current chat returning", (one) =>
      rowsShow(paneColumn(one), `[S] NEW-`),
    );
    expect(chatBody(repl.terminal)).toEqual(held);
  });

  it("CF-E1: a held reply grows into another row, and settles in the same item", function* () {
    const repl = yield* useMountedRepl();
    // Both composers hold something first, so what settlement does to them is
    // something there is to observe.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");

    // Enough literal Output rows to overflow the chat window, then one more
    // row behind them — two pieces, the second held until this row lets it go.
    const first = `<Output>BEGIN\n${Array.from({ length: 30 }, (_, at) => `ROW-${at + 1}`).join("\n")}`;
    repl.fake.script({
      deltas: [first, "\nTAIL-LAST</Output>\n"],
      holdsEachPiece: true,
      holdAfter: 2,
    });

    yield* sendMessage(repl, "grow");
    yield* repl.fake.streamingTurns(1);
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "later");

    // The first piece's own newest row, the window having followed it there.
    yield* awaiting(repl.terminal, "the preview's latest row", (one) =>
      rowsShow(paneColumn(one), "ROW-30"),
    );
    const fed = repl.terminal.fed;
    // Nothing is saved: this is a preview, and the provider is still holding.
    expect(
      (yield* mountedReading(repl)).chat.filter((one) => one.kind === "response"),
    ).toHaveLength(0);
    // Its own earlier rows moved up rather than being drawn over.
    expect(rowsShow(paneColumn(repl.terminal), "BEGIN")).toBe(false);

    // It grows across another visual row on its own, with nothing pressed.
    repl.fake.releaseDeltas();
    yield* awaiting(repl.terminal, "the grown preview's new last row", (one) =>
      rowsShow(paneColumn(one), "TAIL-LAST"),
    );
    expect(repl.terminal.fed).toBe(fed);
    expect(
      (yield* mountedReading(repl)).chat.filter((one) => one.kind === "response"),
    ).toHaveLength(0);

    // Released, it settles as the same item: one response, still showing its
    // own final row, with both composers exactly as they were left.
    repl.fake.releaseDeltas();
    // The Sidekick's own control, in the Sidekick's own pane. This screen has
    // two Sends — the entry draft's is beside its field and is there whatever
    // the Sidekick is doing — so a `[send]` found anywhere says nothing about
    // whether this turn has finished, and a row that waited on one went on to
    // count a reply the provider had not acknowledged yet.
    yield* awaiting(
      repl.terminal,
      "the Sidekick's own control going back to Send",
      (one) =>
        rowsShow(sidekickPaneIn(screenOf(one)), "[send]") &&
        !rowsShow(sidekickPaneIn(screenOf(one)), "[stop]"),
    );
    // And the reply itself, acknowledged: the control coming back is the pane
    // saying it is idle, and the record is what says the turn was kept.
    yield* repliesSaved(repl, 1);
    const read = yield* mountedReading(repl);
    const responses = read.chat.filter((one) => one.kind === "response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ response: "response:1", hasOutput: true });
    expect(rowsShow(paneColumn(repl.terminal), "TAIL-LAST")).toBe(true);
    expect(repl.terminal.fed).toBe(fed);
    expect(draftText(repl.terminal)).toBe("mine");
    expect(messageText(repl.terminal)).toBe("later");
  });

  it("CF3: a reading somebody scrolled to stays put while the next reply saves", function* () {
    const repl = yield* useMountedRepl();
    for (let number = 1; number <= 12; number += 1) {
      repl.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
      yield* sendMessage(repl, `ask-${number}`);
    }
    yield* awaiting(repl.terminal, "the newest reply", (one) => saidBySidekick(one, `ANSWER-12`));

    // Deliberately reading further back, until the newest reply is no longer
    // the one in view. Counted by what the pane holds rather than by presses:
    // how far there is to scroll is a measured thing.
    let scrolled = false;
    for (let press = 0; press < 40 && !scrolled; press += 1) {
      yield* clickAt(repl.terminal, paneCoordinate(repl.terminal, EARLIER_CONTROL));
      yield* settled(12);
      scrolled = !chatRows(repl.terminal).includes(`[S] ANSWER-12`);
    }
    expect(scrolled).toBe(true);
    const held = chatRows(repl.terminal);

    // A real next exchange, held at the transport and then released: the reply
    // is saved while this reading is somewhere else.
    repl.fake.script({ held: true, reply: "<Output>ANSWER-13</Output>\n" });
    yield* sendMessage(repl, "ask-13");
    yield* repl.fake.holdingTurns(1);
    repl.fake.releaseTurn();
    yield* settled(80);

    // Saved, and this reading did not jump to it.
    const read = yield* mountedReading(repl);
    expect(JSON.stringify(read.chat)).toContain("ANSWER-13");
    expect(chatRows(repl.terminal)).not.toContain(`[S] ANSWER-13`);
    expect(chatRows(repl.terminal)).toEqual(held);

    // Reaching the end again resumes following, so the arrival after it is
    // shown without anything being pressed for it.
    let back = false;
    for (let press = 0; press < 60 && !back; press += 1) {
      yield* clickAt(repl.terminal, paneCoordinate(repl.terminal, LATER_CONTROL));
      yield* settled(12);
      back = chatRows(repl.terminal).includes(`[S] ANSWER-13`);
    }
    expect(back).toBe(true);

    repl.fake.script({ reply: "<Output>ANSWER-14</Output>\n" });
    yield* sendMessage(repl, "ask-14");
    yield* awaiting(repl.terminal, "following having resumed", (one) =>
      saidBySidekick(one, `ANSWER-14`),
    );
  });
});

/**
 * Tier MC — Message Sidekick wraps, and grows as you type (#883).
 *
 * The field was one row: wrapping text drew over the row beneath it and a
 * pasted document showed its last line behind a count of the rest. It is now a
 * block — its name and focus marker above the rows its value was fitted into —
 * up to six rows of value, then showing the newest of them.
 *
 * Read off the real mounted terminal, with the measured chat capacity beside
 * it: the composer grows by taking rows from the chat, so what it costs is a
 * states as much as what it shows.
 */
describe("Tier MC — the message composer wraps and grows", () => {
  /** The composer's own rows, as a person reads them. */
  function composer(terminal: Terminal): readonly string[] {
    return messageRows(terminal).map((own) => own.trim());
  }

  /** How many rows of chat this frame is drawing, between its two controls. */
  function chatCapacity(terminal: Terminal): number {
    // The pane this size draws the chat in, which at a narrow frame is the
    // routed outlet and so the whole of it: a slicer that always cut at the
    // right column of a shared width read nothing at all there, and answered
    // that the chat had no rows when it had the screen.
    const rows = conversationPane(screenOf(terminal), terminal.size).map((line) =>
      (line.startsWith("│") ? line.slice(1) : line).trim(),
    );
    const from = rows.indexOf(EARLIER_CONTROL);
    const to = rows.indexOf(LATER_CONTROL);
    return from === -1 || to === -1 ? 0 : to - from - 1;
  }

  /** A populated chat that is following, which is what the composer eats into. */
  function* populated(repl: MountedRepl, exchanges: number): Operation<void> {
    for (let number = 1; number <= exchanges; number += 1) {
      repl.fake.script({ reply: `<Output>SAID-${number}</Output>\n` });
      yield* sendMessage(repl, `ask-${number}`);
    }
    yield* awaiting(repl.terminal, "the newest reply", (one) =>
      saidBySidekick(one, `SAID-${exchanges}`),
    );
  }

  it("MC5: the value wraps into rows of its own, and the chat gives them room", function* () {
    const repl = yield* useMountedRepl();
    yield* populated(repl, 10);
    const before = chatCapacity(repl.terminal);
    expect(before).toBeGreaterThan(1);
    // One blank value row before anything is typed: the box is a place on the
    // screen whether or not it holds anything.
    yield* focusMessage(repl.terminal);
    expect(composer(repl.terminal)).toEqual([""]);

    // Past one measured line, and then text carrying a newline, a blank line
    // and a wide/combining character.
    yield* typing(
      repl.terminal,
      "a question whose words have to wrap onto another row of the pane",
    );
    const wrapped = composer(repl.terminal);
    expect(wrapped.length).toBeGreaterThan(1);
    // Disjoint rows: rejoining them recovers what was typed, with no row
    // repeating another's text.
    expect(wrapped.join(" ")).toContain("a question whose words");
    expect(wrapped.join(" ")).toContain("another row of the pane");

    repl.terminal.bytes(new TextEncoder().encode("\nx\n\né́ 広い"));
    yield* settled(60);
    const pasted = composer(repl.terminal);
    expect(pasted.length).toBeGreaterThan(wrapped.length);
    // The explicit break, the blank line and the graphemes are all rows of it.
    expect(pasted).toContain("x");
    expect(pasted).toContain("");
    // Each wide character, rather than the pair as one substring: this
    // terminal's own cell reconstruction interleaves a combining mark with
    // the characters beside it, so adjacency here would be a claim about the
    // reader. That the characters reached the composer's rows is the claim.
    expect(pasted.join(" ")).toContain("広");
    expect(pasted.join(" ")).toContain("い");

    // It grew by taking rows from the chat, and the chat is still following:
    // its newest reply is the row at the bottom.
    const after = chatCapacity(repl.terminal);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(1);
    expect(saidBySidekick(repl.terminal, `SAID-10`)).toBe(true);

    // The name, the controls and the footer are all where they were.
    expect(shows(repl.terminal, MESSAGE_PROMPT)).toBe(true);
    expect(shows(repl.terminal, "[send]")).toBe(true);
    expect(shows(repl.terminal, "[history]")).toBe(true);
    expect(shows(repl.terminal, "[exit]")).toBe(true);

    // Backspace over ordinary trailing text shrinks it again, and the draft is
    // untouched by any of it.
    expect(draftText(repl.terminal)).toBe("");
    for (let press = 0; press < 12; press += 1) {
      repl.terminal.feed("\x7f");
      yield* settled(10);
    }
    expect(composer(repl.terminal).length).toBeLessThan(pasted.length);
    expect(draftText(repl.terminal)).toBe("");
  });

  it("MC6: six rows at most, and Send carries the original text once", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.script({ reply: "<Output>Understood.</Output>\n" });

    // A value far past six fitted rows, with its own newlines in it.
    const lines = Array.from({ length: 9 }, (_, at) => `LINE-${at + 1}`);
    const typed = lines.join("\n");
    yield* focusMessage(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(typed));
    yield* settled(60);

    // Exactly six value rows under the one fixed name row, and the end of the
    // text — where somebody is typing — is what they show.
    const shown = composer(repl.terminal);
    expect(shown).toHaveLength(6);
    expect(shown[shown.length - 1]).toBe("LINE-9");
    expect(shown).not.toContain("LINE-1");
    expect(shows(repl.terminal, MESSAGE_PROMPT)).toBe(true);

    // Send carries the original string, whitespace and newlines included, and
    // the rows that were off the screen are in it.
    const saving = heldMessageRecord(gate);
    yield* click(repl.terminal, "[send]", INSPECTION_FROM);
    yield* saving.started();

    // A newer wrapped edit behind the held append keeps its text and height.
    yield* focusMessage(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode("NEWER-1\nNEWER-2\nNEWER-3"));
    yield* settled(60);
    const newer = composer(repl.terminal);
    expect(newer.length).toBeGreaterThan(1);

    saving.release();
    yield* awaiting(repl.terminal, "the reply arriving", (one) => shows(one, "Understood."));

    // Exactly one message, and it is the literal text Send captured.
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual([typed]);
    expect(repl.fake.prompts).toHaveLength(1);
    expect(repl.fake.prompts[0]).toContain("LINE-1");
    expect(repl.fake.prompts[0]).toContain("LINE-9");
    expect(repl.fake.prompts[0]).not.toContain("NEWER-1");

    // The newer edit survived the acknowledgement, with its own height.
    expect(composer(repl.terminal)).toEqual(newer);
  });

  it("MC6: control — an acknowledged Send leaves one blank value row", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: "<Output>Done.</Output>\n" });
    yield* focusMessage(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode("one\ntwo\nthree"));
    yield* settled(60);
    expect(composer(repl.terminal).length).toBeGreaterThan(1);

    yield* click(repl.terminal, "[send]", INSPECTION_FROM);
    yield* awaiting(repl.terminal, "the reply arriving", (one) => shows(one, "Done."));
    // Cleared, and back to the one blank row the box starts at.
    expect(composer(repl.terminal)).toEqual([""]);
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["one\ntwo\nthree"]);
  });

  it("MC7: the value, its focus and its height survive every size and a held turn", function* () {
    const repl = yield* useMountedRepl();
    yield* populated(repl, 8);
    yield* focusMessage(repl.terminal);
    const typed = Array.from({ length: 8 }, (_, at) => `ROW-${at + 1}`).join("\n");
    repl.terminal.bytes(new TextEncoder().encode(typed));
    yield* settled(60);
    expect(composer(repl.terminal)).toHaveLength(6);
    expect(focusedField(repl.terminal, MESSAGE_PROMPT)).toBe(true);

    // Medium: the value and the focus survive, and the height is this size's.
    const medium = yield* resizeTo(repl.terminal, { columns: 120, rows: 30 });
    expect(messageTextIn(medium())).toContain("ROW-8");
    expect(rowsShow(medium(), "[send]")).toBe(true);
    const atMedium = composer(repl.terminal).length;
    expect(atMedium).toBeGreaterThan(1);
    expect(atMedium).toBeLessThanOrEqual(6);

    // Narrow, asked for explicitly: the cap is what this screen can leave the
    // chat. How many rows that is belongs to the composition — this outlet
    // keeps three rows of chrome where the one this row was written against
    // kept seven, so twenty rows now allow the whole cap — and what the cap is
    // *for* is that the chat keeps a row of its own, which is asserted below.
    yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    const narrow = yield* resizeTo(repl.terminal, { columns: 72, rows: 20 });
    expect(messageTextIn(narrow())).toContain("ROW-8");
    const atNarrow = composer(repl.terminal).length;
    expect(atNarrow).toBeGreaterThanOrEqual(1);
    expect(atNarrow).toBeLessThanOrEqual(6);
    // Send and at least one chat row are still there to reach.
    expect(rowsShow(narrow(), "[send]")).toBe(true);
    expect(chatCapacity(repl.terminal)).toBeGreaterThanOrEqual(1);

    // And the one outlet is inset too: its body begins two cells in, with the
    // gutter beside it holding nothing. The accepted table's 72x20 row.
    const label = screenOf(repl.terminal).find((line) => line.includes(MESSAGE_PROMPT));
    if (label === undefined) {
      throw new Error("the narrow outlet drew no message box");
    }
    // Measured from the prompt rather than from a marker's room. The field
    // wears one `>` now, drawn in the first of its own cells, where the row
    // this was written against reserved three cells in front of the prompt for
    // `>> ` — so the body begins where the inset ends whether or not it has
    // focus, and the gutter beside it holds nothing either way.
    const begins = label.indexOf(MESSAGE_PROMPT);
    expect(begins).toBe(2);
    // And nothing of any other control is in front of it: what is there is the
    // field's own marker, which it wears only while it has focus.
    expect([">", ""]).toContain(label.slice(0, begins).trim());

    // Below the minimum, and back. Resized rather than waited on a whole
    // frame: a refused size draws one sentence and no frame to wait for.
    const from = repl.terminal.presented.length;
    repl.terminal.resized(TOO_SMALL);
    yield* awaiting(repl.terminal, "the refusal this size draws", () =>
      rowsShow(replay(repl.terminal.presented.slice(from)), `${NARROW.columns}x`),
    );
    expect(rowsShow(replay(repl.terminal.presented.slice(from)), "[send]")).toBe(false);
    const recovered = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    expect(messageTextIn(recovered())).toContain("ROW-8");
    expect(composer(repl.terminal)).toHaveLength(6);

    // A tab round trip keeps it, and so does a held turn it is edited behind.
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(repl.terminal, "the inspector", (one) => panePresented(one) === "bindings");
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the chat again", (one) => panePresented(one) === "sidekick");
    expect(messageText(repl.terminal)).toContain("ROW-8");

    repl.fake.script({ held: true, reply: "<Output>Held answer.</Output>\n" });
    yield* sendMessage(repl, "go");
    yield* repl.fake.holdingTurns(1);
    const asked = repl.fake.prompts.length;
    yield* focusMessage(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode("while-busy-1\nwhile-busy-2"));
    yield* settled(60);
    // It grew while the turn is in flight, and sent nothing: the request the
    // provider is holding is the one it was given.
    expect(composer(repl.terminal).length).toBeGreaterThan(1);
    expect(repl.fake.prompts).toHaveLength(asked);
    expect(repl.fake.prompts[asked - 1]).not.toContain("while-busy-1");
    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the held reply arriving", (one) => shows(one, "Held answer."));
    expect(messageText(repl.terminal)).toContain("while-busy-2");
  });
});

/**
 * Tier HI — what a submission reserves, after a historical opening (HI1–HI3).
 *
 * A session keeps its model projected at the location it opened at, which is
 * right for what a frozen screen shows and wrong for what the next entry is
 * called. Opening at the first of two entries, returning to the live head and
 * submitting has to reserve the third entry, and the intent, the admitted
 * entry, the receipt and the output-read target all have to name that one.
 *
 * The whole journey is the mounted command: a real repository on disk, the
 * real session, the real Sidekick owner, with only the terminal and the agent
 * transport replaced. The head-opening arm is the control, and it is the same
 * path without the historical opening.
 */
describe("Tier HI — a submission reserves from the acknowledged history", () => {
  /** Two small entries, each agent-free and its own literal line. */
  const FIRST = "<Output>the first entry</Output>";
  const SECOND = "<Output>the second entry</Output>";
  /** What a reply submits afterwards, distinct from both. */
  const THIRD = "<Output>the third entry</Output>";

  /**
   * Run one entry as the person, and wait for the history to hold it.
   *
   * Both halves, because the screen alone cannot say it: the source is typed
   * into the draft, so the text this entry prints is on screen from the moment
   * it was typed — waiting for that would return while the entry was still
   * being admitted, and a row reading the recorded entries next would read the
   * one before it. What settles this is the recorded model holding the entry,
   * which is the fact every assertion below is about.
   */
  function* runs(
    repl: MountedRepl,
    source: string,
    shown: string,
    recorded: number,
  ): Operation<void> {
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, source);
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, `the entry printing ${JSON.stringify(shown)}`, (one) =>
      shows(one, shown),
    );
    yield* held(repl, recorded);
  }

  /** Wait until the recorded model holds this many entries. */
  function* held(repl: MountedRepl, recorded: number): Operation<void> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const reading = yield* mountedReading(repl);
      if (reading.model.entries.length >= recorded) {
        return;
      }
      yield* sleep(10);
    }
    const reading = yield* mountedReading(repl);
    throw new Error(
      `the history never recorded ${recorded} entries; it holds ${reading.model.entries.length}`,
    );
  }

  /**
   * Leave one command, and hand back the location it ended at.
   *
   * Through `[exit]`, so it is the location the product hands a person to copy
   * rather than a string assembled here. Both arms reopen with one of these:
   * the execution has to be named for the second process to find it at all,
   * which is why the control is a head location and not an absent one.
   */
  function* leaving(repl: MountedRepl): Operation<string> {
    yield* click(repl.terminal, "[exit]");
    yield* awaited("the command returning its outcome", () => repl.outcome() !== undefined);
    const outcome = repl.outcome();
    if (outcome === undefined || !outcome.ok) {
      throw new Error(`this command refused rather than leaving: ${String(outcome?.error)}`);
    }
    return outcome.value.location;
  }

  /**
   * The first entry's own outcome, as the History drawer names it.
   *
   * An outcome row carries no entry number — `pointLabel` says that only for
   * an admission — so the recorded ordinal is what tells the first entry's
   * outcome from the second's. Two entries write four positions: admitted,
   * outcome, admitted, outcome.
   */
  const FIRST_OUTCOME = "2 · Entry outcome recorded";

  /** Freeze the screen at a recorded position, through History. */
  function* freezeAt(repl: MountedRepl, position: string): Operation<void> {
    yield* click(repl.terminal, "[history]");
    yield* awaiting(repl.terminal, "the History drawer opening", (one) => shows(one, position));
    yield* click(repl.terminal, position);
    yield* awaiting(repl.terminal, "the screen freezing at that position", (one) =>
      shows(one, "[live]"),
    );
  }

  /**
   * A reply that submits this source as an entry.
   *
   * The source travels as a binding rather than as markup written inside the
   * control: a reply that writes an entry's constructs inline is a generated
   * fragment writing structure the language does not allow there, which the
   * language refuses before any entry is reserved.
   */
  function submitting(source: string): string {
    return [
      '<Let as="code" select="code">',
      "````xmd",
      source,
      "````",
      "</Let>",
      "<REPL.EntryInput>{code}</REPL.EntryInput>",
      "<REPL.Submit />",
      "",
    ].join("\n");
  }

  /**
   * The last Submit intent this chat wrote down, which is the one under test.
   *
   * Read from the records the product actually appended rather than from the
   * owner: a reservation is the thing a reopening reconciles against, so what
   * matters is the bytes on disk.
   */
  function lastSubmit(chat: readonly SidekickRecord[]): NonNullable<ControlRecord["submit"]> {
    for (let at = chat.length - 1; at >= 0; at -= 1) {
      const held = chat[at];
      if (held?.kind === "control" && held.submit !== undefined) {
        return held.submit;
      }
    }
    throw new Error("this chat wrote down no Submit intent");
  }

  for (const arm of [
    { name: "opened at the first entry", historical: true },
    { name: "control: opened at the head", historical: false },
  ]) {
    it(`HI1: ${arm.name}, a reply's Submit names the entry it actually ran`, function* () {
      const dataRoot = yield* useTemporary("xmd-repl-hi1-");
      let location: string | undefined;

      // Two completed entries, and the location to come back at.
      yield* scoped(function* (): Operation<void> {
        const host = yield* useMountedHost({ dataRoot });
        const repl = yield* useMountedRepl({ host });
        yield* runs(repl, FIRST, "the first entry", 1);
        yield* runs(repl, SECOND, "the second entry", 2);
        expect((yield* mountedReading(repl)).model.entries).toHaveLength(2);
        if (arm.historical) {
          yield* freezeAt(repl, FIRST_OUTCOME);
        }
        location = yield* leaving(repl);
      });

      yield* scoped(function* (): Operation<void> {
        const host = yield* useMountedHost({ dataRoot });
        if (location === undefined) {
          throw new Error("the first process handed back no location");
        }
        const repl = yield* useMountedRepl({ host, location });

        // Back to the live head, which is where a submission is allowed at all.
        //
        // The copied location carries the History drawer that was open when it
        // was copied, and the drawn drawer owns the keys and its own controls —
        // so the footer's way back is not reachable until it is closed.
        if (arm.historical) {
          yield* awaiting(repl.terminal, "the frozen screen offering the way back", (one) =>
            shows(one, "[live]"),
          );
          yield* click(repl.terminal, "[close]");
          yield* awaiting(repl.terminal, "the drawer closing", (one) => !shows(one, "[close]"));
          yield* click(repl.terminal, "[live]");
          yield* awaiting(
            repl.terminal,
            "the live head coming back",
            (one) => !shows(one, "[live]"),
          );
        }

        repl.fake.script({ reply: submitting(THIRD) });
        yield* sendMessage(repl, "run one more");
        yield* awaiting(repl.terminal, "the third entry printing", (one) =>
          shows(one, "the third entry"),
        );

        const read = yield* mountedReading(repl);
        const intent = lastSubmit(read.chat);
        // The entry that actually ran, and what the person is told about it.
        expect(read.model.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
        expect(read.model.entries[2]?.source).toBe(THIRD);
        // The intent, which is what a reopening reconciles against.
        expect([intent.entry, intent.ordinal]).toEqual(["entry-3", 2]);
        expect(intent.source).toBe(THIRD);
        // And the receipt and the read target name the same entry. Read from
        // the retained feedback, which is the exact text the next turn was
        // sent — the same records the reported attribution was found in.
        const feedback = read.chat
          .flatMap((one) => (one.kind === "feedback" ? [one.text] : []))
          .join("\n");
        expect(feedback).toContain("Entry entry-3 completed.");
        expect(feedback).toContain("Read what it printed with <REPL.Entry.Output entry={3} />.");
        // The admitted entry's own number, whichever position the screen was
        // opened at: a receipt keyed to what somebody is reading would name
        // the first entry in the historical arm.
        expect(feedback).not.toContain("entry={1}");
      });
    });
  }

  /**
   * An entry that is admitted and then fails, rather than refused before it.
   *
   * The distinction is the row: a source refused during preflight never
   * becomes an entry, so it could not show whether the receipt names the right
   * one. This one admits, runs and throws.
   */
  const FAILING = ["```js eval", 'throw new Error("the third entry failed");', "```"].join("\n");

  it("HI2: a failed entry's intent, receipt and read target all name that entry", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-hi2-");
    let location = "";

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      const repl = yield* useMountedRepl({ host });
      yield* runs(repl, FIRST, "the first entry", 1);
      yield* runs(repl, SECOND, "the second entry", 2);
      yield* freezeAt(repl, FIRST_OUTCOME);
      location = yield* leaving(repl);
    });

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      const repl = yield* useMountedRepl({ host, location });
      yield* click(repl.terminal, "[close]");
      yield* awaiting(repl.terminal, "the drawer closing", (one) => !shows(one, "[close]"));
      yield* click(repl.terminal, "[live]");
      yield* awaiting(repl.terminal, "the live head coming back", (one) => !shows(one, "[live]"));

      repl.fake.script({ reply: submitting(FAILING) });
      yield* sendMessage(repl, "run one that fails");
      yield* settledEntry(repl.terminal, 3, "err");

      const read = yield* mountedReading(repl);
      const intent = lastSubmit(read.chat);
      // Three entries, the third this one, and the earlier two untouched.
      expect(read.model.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
      expect(read.model.entries[2]?.source).toBe(FAILING);
      expect(read.model.entries[2]?.terminal?.status).toBe("err");
      expect(read.model.entries[0]?.terminal?.status).toBe("ok");
      expect(read.model.entries[1]?.terminal?.status).toBe("ok");
      // The intent names the entry that actually ran and failed.
      expect([intent.entry, intent.ordinal]).toEqual(["entry-3", 2]);
      expect(intent.source).toBe(FAILING);
      // And so do its own failed receipt and its read target, rather than a
      // refusal sentence naming no entry at all.
      const feedback = read.chat
        .flatMap((one) => (one.kind === "feedback" ? [one.text] : []))
        .join("\n");
      expect(feedback).toContain("Entry entry-3 failed.");
      expect(feedback).toContain("It failed:");
      // A failed entry is pointed at its saved evidence, by the number of the
      // entry the submission admitted — not by the position the screen was
      // frozen at before it went back to the head.
      expect(feedback).toContain(
        "Inspect its saved evidence with <REPL.Entry.Journal entry={3} />.",
      );
      expect(feedback).not.toContain("entry={1}");
      expect(feedback).not.toContain("entry={2}");
    });
  });

  /**
   * HI2b — the receipt is delivered while an earlier position is selected.
   *
   * HI2 above reopens at a recorded position and goes back live before it
   * submits, so what it establishes is attribution after a historical
   * reopening. This is the other half: the entry is admitted at the live
   * head, its own outcome is held inside the host before it can be
   * appended, the screen is frozen at an earlier recorded position while it
   * waits, and only then is the failure released. The receipt is therefore
   * composed and delivered with a different entry selected, which is the one
   * state in which a receipt keyed to the screen would name the wrong entry.
   */
  it("HI2b: a failure released while an earlier position is selected still names its own entry", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    yield* runs(repl, FIRST, "the first entry", 1);
    yield* runs(repl, SECOND, "the second entry", 2);

    /**
     * The third entry's own outcome, held inside the host before it lands.
     *
     * Registered before the message is sent and decided at append time:
     * waiting for the entry to be admitted and *then* asking to hold would
     * be racing the record it means to hold. The two entries before it have
     * already closed, so the next close on this file is this entry's.
     */
    const outcome = gate.holdNext(
      (path, record) => path.endsWith(ENTRIES_FILE) && record.includes('"type":"close"'),
    );

    repl.fake.script({ reply: submitting(FAILING) });
    repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    yield* sendMessage(repl, "run one that fails");
    yield* outcome.started();

    // Frozen at the first entry's recorded outcome, with the submission
    // still waiting for its own. The drawer is closed and the head is
    // deliberately *not* returned to.
    yield* freezeAt(repl, FIRST_OUTCOME);
    yield* click(repl.terminal, "[close]");
    yield* awaiting(repl.terminal, "the drawer closing", (one) => !shows(one, "[close]"));
    expect(shows(repl.terminal, "[live]")).toBe(true);

    outcome.release();
    yield* awaiting(repl.terminal, "the reply that follows the failure", (one) =>
      shows(one, "Noted."),
    );
    // Still frozen when the receipt was composed and delivered: the control
    // that goes back to the head is still the one being offered.
    expect(shows(repl.terminal, "[live]")).toBe(true);

    const read = yield* mountedReading(repl);
    const intent = lastSubmit(read.chat);
    expect(read.model.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(read.model.entries[2]?.terminal?.status).toBe("err");
    expect(intent.entry).toBe("entry-3");

    // The retained feedback names the entry the submission admitted, with
    // the exact instruction, and neither of the entries that already exist —
    // one of which is the one being read.
    const feedback = read.chat
      .flatMap((one) => (one.kind === "feedback" ? [one.text] : []))
      .join("\n");
    expect(feedback).toContain("Entry entry-3 failed.");
    expect(feedback).toContain("Inspect its saved evidence with <REPL.Entry.Journal entry={3} />.");
    expect(feedback).not.toContain("entry={1}");
    expect(feedback).not.toContain("entry={2}");

    // And the immediate rendering is the same words, because one renderer
    // produces both: what the control returned where it was written and what
    // the next turn was sent are one receipt.
    expect(
      renderReceipt({
        entry: intent.entry,
        status: "failed",
        failure: "the third entry failed",
        read: { entry: intent.entry },
      }),
    ).toContain("Inspect its saved evidence with <REPL.Entry.Journal entry={3} />.");
  });

  /**
   * HI3 — the person's own Run, across the same transition.
   *
   * The person's reservation is private: it writes no Submit intent and has no
   * display of its own, so what is asserted here is the entry that was
   * actually admitted and the draft that was cleared. That the *calculation*
   * behind it reads the same acknowledged basis the Sidekick reads is
   * established by the source — `program.ts`'s submit action and
   * `admission.ts` now both take their count from `reading(undefined)` — and
   * deliberately not by an inspection API added to show it.
   */
  it("HI3: frozen, Run establishes nothing; live, it admits the next entry", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-hi3-");
    let location = "";

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      const repl = yield* useMountedRepl({ host });
      yield* runs(repl, FIRST, "the first entry", 1);
      yield* runs(repl, SECOND, "the second entry", 2);
      yield* freezeAt(repl, FIRST_OUTCOME);
      location = yield* leaving(repl);
    });

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      const repl = yield* useMountedRepl({ host, location });
      yield* click(repl.terminal, "[close]");
      yield* awaiting(repl.terminal, "the drawer closing", (one) => !shows(one, "[close]"));

      // Still frozen: a Run from here establishes nothing. The draft keeps its
      // text, because a refusal is not a submission.
      expect(shows(repl.terminal, "[live]")).toBe(true);
      yield* focusDraft(repl.terminal);
      yield* typing(repl.terminal, THIRD);
      repl.terminal.feed("\r");
      yield* settled(60);
      expect((yield* mountedReading(repl)).model.entries).toHaveLength(2);
      expect(draftText(repl.terminal)).toContain(THIRD);

      // Live again, and the same Run admits the next entry — the third, with
      // the source that was typed, and the draft cleared by the entry it became.
      yield* click(repl.terminal, "[live]");
      yield* awaiting(repl.terminal, "the live head coming back", (one) => !shows(one, "[live]"));
      yield* focusDraft(repl.terminal);
      repl.terminal.feed("\r");
      yield* awaiting(repl.terminal, "the third entry printing", (one) =>
        shows(one, "the third entry"),
      );
      // Cleared by the entry it became, which is a frame of its own: the
      // submission and the redraw that drops the text are not one step.
      yield* awaiting(
        repl.terminal,
        "the draft being cleared by its entry",
        (one) => !draftText(one).includes(THIRD),
      );

      const read = yield* mountedReading(repl);
      expect(read.model.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
      expect(read.model.entries[2]?.source).toBe(THIRD);
    });
  });
});

/**
 * Tier UH — the two tabs as controls, through the mounted program.
 *
 * The arrangement changed and the controls did not: each tab keeps its key, its
 * action, its pointer target and its place in the traversal, and neither label
 * carries the word the amendment removed. Driven through the mounted program
 * rather than the presenter, because what is being asked is whether a person
 * can still reach both readings by pointer and by keyboard.
 *
 * The hidden Sidekick's own question notice is observed by Tier MQ, which holds
 * a real pending question against this same harness; it is not repeated here.
 */
describe("Tier UH — both pane tabs still select, by pointer and by keyboard", () => {
  it("UH2: pointer and keyboard each reach both tabs, and neither composer loses text", function* () {
    const repl = yield* useMountedRepl();

    // Text in both destinations first, so switching has something to lose.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "my entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "my question");

    // The Sidekick is the default reading, and both names are on the screen
    // whichever one that is. Spelled the way the staged panes spell their own
    // tabs — in capitals — rather than the way a person says them.
    expect(panePresented(repl.terminal)).toBe("sidekick");
    for (const label of [PANE_TABS.bindings, PANE_TABS.sidekick]) {
      expect([label, shows(repl.terminal, label)]).toEqual([label, true]);
    }
    expect(shows(repl.terminal, "[selected]")).toBe(false);

    // By keyboard: Tab until the tab holds focus, then Enter. Focus landing on
    // it is what makes this the keyboard path rather than a dispatch.
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(
      repl.terminal,
      "Bindings being selected",
      (one) => panePresented(one) === "bindings",
    );
    expect(focusedOn(repl.terminal, PANE_TABS.bindings)).toBe(true);
    // Focus on a tab is not selection of it: the other tab can hold focus
    // without the reading changing under it.
    yield* focusOn(repl.terminal, PANE_TABS.sidekick);
    expect(focusedOn(repl.terminal, PANE_TABS.sidekick)).toBe(true);
    expect(panePresented(repl.terminal)).toBe("bindings");

    // By pointer: the same control, reached at its own cell. Its box is its own
    // label now, so a click on the name is a click on the tab bearing it.
    yield* click(repl.terminal, PANE_TABS.sidekick);
    yield* awaiting(
      repl.terminal,
      "the chat coming back",
      (one) => panePresented(one) === "sidekick",
    );
    yield* click(repl.terminal, PANE_TABS.bindings);
    yield* awaiting(repl.terminal, "Bindings again", (one) => panePresented(one) === "bindings");

    // And neither composer was edited by any of it.
    yield* click(repl.terminal, PANE_TABS.sidekick);
    yield* awaiting(
      repl.terminal,
      "the chat once more",
      (one) => panePresented(one) === "sidekick",
    );
    expect(messageText(repl.terminal)).toContain("my question");
    expect(draftText(repl.terminal)).toBe("my entry");
  });

  it("UH5: an open History drawer still says Esc closes, and closing keeps both texts", function* () {
    const repl = yield* useMountedRepl();

    // Text in both destinations, and an entry selected, so closing has
    // something to preserve.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "kept entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "kept question");
    expect(panePresented(repl.terminal)).toBe("sidekick");

    // A real route drawer, opened the way a person opens it.
    yield* activate(repl.terminal, "[history]");
    yield* awaiting(repl.terminal, "the History drawer", (one) => shows(one, "[close]"));

    // The directions are still legible in front of it, including the way out.
    // This is the claim the accepted envelope exists for: the drawer begins
    // below the whole fitted block rather than on top of its first row.
    expect(shows(repl.terminal, "Esc closes")).toBe(true);

    // Closed once, by that very key.
    repl.terminal.feed("\x1b");
    yield* awaiting(repl.terminal, "the drawer closing", (one) => !shows(one, "[close]"));

    // And nothing it was in front of was disturbed: the same reading is
    // selected and neither composer was edited.
    expect(panePresented(repl.terminal)).toBe("sidekick");
    expect(messageText(repl.terminal)).toContain("kept question");
    expect(draftText(repl.terminal)).toBe("kept entry");
  });

  it("BP3: both bodies stay usable through their own controls, and narrow gains no inset", function* () {
    const repl = yield* useMountedRepl();

    // A real entry first, so the Transcript has a reading with controls around
    // it — submitting consumes the draft, so the texts below are typed after.
    yield* submitEntry(repl, promptEntry("read-entry"));
    yield* settledEntry(repl.terminal, 1, "ok");
    // Chosen in the catalog, which is where this screen keeps those rows: a
    // drawer over the reading, opened to point at one, and the choice closes it.
    yield* openCatalog(repl.terminal);
    yield* click(repl.terminal, "1.");
    yield* awaiting(
      repl.terminal,
      "the catalog closing behind the choice",
      (one) => !catalogShowing(one),
    );

    // Then text in both destinations, so the round trip below has something of
    // each to preserve.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "kept entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "kept question");

    // The Sessions reading is reached by its own control, in the column the
    // inset narrowed: a row built to the pane instead of the body would have
    // published a target reaching into the gutter.
    // Behind the selector, which is where one list with the conversations as its
    // filter keeps them: opening it is what puts the choices on the screen.
    yield* openFilter(repl.terminal);
    const choice = coordinateOf(repl.terminal, "All conversations");
    if (choice === undefined) {
      throw new Error("the filter offered no way back to every conversation");
    }
    // Inside the Transcript's own column, which is this row's claim: a row
    // built to the pane instead of the body would have published a target
    // reaching into the gutter.
    expect(choice.column).toBeLessThan(workspaceTranscriptWidth(repl.terminal.size) ?? 0);
    yield* clickAt(repl.terminal, choice);
    // And the press landed. Choosing is the whole of what the chooser is for,
    // so it closes behind the choice rather than staying open over the reading
    // it just changed.
    yield* awaiting(
      repl.terminal,
      "the chooser closing behind the choice",
      (one) => !columnShows(sessionsColumn(one), "All conversations"),
    );

    // And the Transcript scrolls by its *own* control at both shared sizes. The
    // reading is narrower than it was, so its later rows are reached rather than
    // drawn — which is what these two controls are for. Found by the column it
    // is in: each of the three readings on this screen draws a pair of its own.
    for (const size of [
      { columns: 120, rows: 30 },
      { columns: 160, rows: 36 },
    ]) {
      yield* resizeTo(repl.terminal, size);
      // The Transcript is the leftmost column of the staged screen, so its own
      // controls are the ones inside its width.
      const left = 0;
      const right = workspaceTranscriptWidth(size) ?? 0;
      const at = screenOf(repl.terminal).flatMap((line, row) => {
        const column = line.indexOf(LATER);
        return column >= left && column < right ? [{ column, row }] : [];
      })[0];
      if (at === undefined) {
        throw new Error(`the ${size.columns}x${size.rows} transcript drew no ${LATER}`);
      }
      yield* clickAt(repl.terminal, at);
      // Pressed, and it wrote nothing. How far a short reading moves is its own
      // business — that a narrowed body's later rows are still *reachable* is
      // BP2's claim, against a reading long enough to need it. What matters
      // here is that this column's own control is where a pointer can reach it
      // and that pressing it edits neither composer nor the selection.
      expect([size.columns, draftText(repl.terminal)]).toEqual([size.columns, "kept entry"]);
      expect([size.columns, messageText(repl.terminal).includes("kept question")]).toEqual([
        size.columns,
        true,
      ]);
      expect([size.columns, yield* markedEntry(repl.terminal, "1.")]).toEqual([size.columns, true]);
    }

    // Narrow routes one outlet and is given no inset of its own, so its own
    // surface controls are still what it offers.
    const narrow = yield* resizeTo(repl.terminal, NARROW);
    expect(rowsShow(narrow(), "Entries")).toBe(true);

    // Back, with both texts where they were left and the same reading selected.
    const wide = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    expect(paneShown(wide())).toBe("sidekick");
    expect(messageTextIn(wide())).toContain("kept question");
    expect(blockSays(draftTextIn(wide()), "kept entry")).toBe(true);
  });

  it("UH4: resizing through narrow and back keeps both texts, and narrow grows no tabs", function* () {
    const repl = yield* useMountedRepl();
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "kept entry");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "kept question");

    // Medium keeps the three columns and the one header row.
    const medium = yield* resizeTo(repl.terminal, { columns: 120, rows: 30 });
    for (const label of [PANE_TABS.bindings, PANE_TABS.sidekick]) {
      expect([label, rowsShow(medium(), label)]).toEqual([label, true]);
    }
    expect(rowsShow(medium(), "[selected]")).toBe(false);

    // Narrow routes one outlet and heads no shared column, so it grows neither
    // the tab row nor a gap: its own surface controls are its headings.
    const narrow = yield* resizeTo(repl.terminal, NARROW);
    expect(rowsShow(narrow(), "Entries")).toBe(true);
    expect(rowsShow(narrow(), "[selected]")).toBe(false);

    // And back, with both texts where they were left.
    const wide = yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    expect(rowsShow(wide(), PANE_TABS.bindings)).toBe(true);
    expect(messageTextIn(wide())).toContain("kept question");
    expect(blockSays(draftTextIn(wide()), "kept entry")).toBe(true);
  });
});

/**
 * #971 A3: one mounted screen carried through every supported size and back.
 *
 * One presenter, one tree and one grid throughout, because what is under test
 * is what survives a resize rather than what a fresh frame can draw: the
 * reading, the selection, both texts, and the control a keystroke reaches.
 *
 * The sizes below the minimum are part of the journey. That frame draws one
 * sentence and places no control at all, and the one after it has to bring the
 * reading back — a screen that recovered into something else would be a resize
 * that lost somebody's work.
 */
describe("Tier A3 — the staged screen resized, and recovered", () => {
  it("A3: 160 to 120 to 72, below the minimum, and back", function* () {
    // The fixture's entries compile their own eval blocks, which is what this
    // file's other rows get from the program they run.
    yield* useTempFileCompiler();
    // The journal read at a position somebody moved to, rather than at its
    // head. Both halves come from one call, because a route may only name the
    // position its own model was projected at: a marker set on the model of
    // the present is a route resolution refuses.
    const { model, at: selected } = yield* checkpointSelected();
    // Seeded once, and the only reading in this journey: that retained
    // position, the entry and nested scope it holds, and two texts no default
    // supplies. A frame that rebuilt the fixture's own state instead of
    // carrying this one would be visibly a different screen.
    const state = seededState(model);
    const presenter = yield* usePresenter(CHECKPOINT_SIZE);
    const first = yield* commitCheckpoint(presenter, { model, state });
    expect(first.focused).toBe("footer:input");
    const scopes = state.route.scopes;
    const at = state.route.at;
    expect(scopes.length).toBe(2);

    // The position is a real one: a marker this journal retained, named by the
    // route, and the one its model was projected at. All three, because any
    // two of them agreeing on `undefined` would say only that this reading is
    // of the present.
    expect(typeof at).toBe("string");
    expect(at).toBe(selected);
    expect(at).toBe(model.selection);
    expect(model.checkpoints.map((one) => one.marker)).toContain(selected);
    expect(selected.length).toBeGreaterThan(0);

    // And the screen says which reading it is showing: a position behind HEAD
    // marks the History band, which a reading of the present does not.
    const banded = (frame: CheckpointFrame): string => {
      const bounds = frame.observed.regionOf("box:history");
      if (bounds === undefined) {
        throw new Error("this frame published no History band");
      }
      return presenter.grid.textIn(bounds).join(" ");
    };
    expect(banded(first)).toContain("reading earlier");

    // The key the tree answered with, carried from size to size. Passing it is
    // what tells the fixture not to let the Draft take focus again:
    // re-offering it at every size would be restoring focus rather than
    // keeping whatever a resize left focused.
    let held = first.focused;

    /** The same reading at one more size, committed into the same tree. */
    const resized = function* (size: ReplTerminalSize) {
      presenter.resize(size);
      const committed = yield* commitCheckpoint(presenter, {
        model,
        state,
        size,
        ...(held === undefined ? {} : { focused: held }),
      });
      held = committed.focused;
      return committed;
    };

    for (const size of [CHECKPOINT_MEDIUM, CHECKPOINT_NARROW]) {
      const where = `${size.columns}x${size.rows}`;
      const committed = yield* resized(size);
      // The reading is the same reading: same entry, same nested scope, same
      // recorded position, and both texts exactly as they were typed.
      expect({ where, scopes: committed.view.state.route.scopes }).toEqual({ where, scopes });
      expect({ where, at: committed.view.state.route.at }).toEqual({ where, at });
      expect({ where, draft: committed.view.state.draft }).toEqual({
        where,
        draft: SEEDED_DRAFT,
      });
      expect({ where, message: committed.view.state.message }).toEqual({
        where,
        message: SEEDED_MESSAGE,
      });
      // And it is still showing the retained reading rather than the present,
      // wherever the row has the cells to say so. The band is content, so it
      // is cut at the room its own measured controls leave it; at 72 columns
      // this reading's band is longer than that room, and what falls off is
      // the phrase below. That the row cannot hold it is an appearance
      // question for the image review these sizes are already waiting on —
      // what this journey holds is that the reading itself does not change.
      const band = banded(committed);
      expect({ where, drawn: band.length > 0 }).toEqual({ where, drawn: true });
      if (size.columns >= CHECKPOINT_MEDIUM.columns) {
        expect({ where, banded: band.includes("reading earlier") }).toEqual({
          where,
          banded: true,
        });
      }
      // The Draft is still on this screen, so focus is still on it.
      expect({ where, focused: committed.focused }).toEqual({ where, focused: "footer:input" });
      expect({
        where,
        drawn: committed.observed.boundsOf("footer:input") !== undefined,
      }).toEqual({ where, drawn: true });
    }

    // A control narrowing removed is not merely hidden: it is in no cell, no
    // frame map and no mounted node, so nothing can activate it.
    const narrow = presenter.last();
    if (narrow === undefined) {
      throw new Error("this journey committed no narrow frame");
    }
    for (const key of ["tray:queue", "follow", "sidekick:stop"]) {
      expect({ key, mounted: narrow.keys.includes(key) }).toEqual({ key, mounted: false });
      expect({ key, drawn: narrow.boundsOf(key) !== undefined }).toEqual({ key, drawn: false });
    }

    // Below the minimum the frame is its own refusal: one sentence, and not one
    // control anywhere on it.
    const refused = yield* resized(CHECKPOINT_BELOW);
    expect(refused.observed.committed.manifest.profile).toBe("too-small");
    expect(refused.observed.targets.length).toBe(0);
    expect(refused.observed.committed.manifest.actions).toBe(undefined);
    const said = presenter.grid
      .textIn({ x: 0, y: 0, width: CHECKPOINT_BELOW.columns, height: CHECKPOINT_BELOW.rows })
      .join(" ");
    expect(said).toContain(`${NARROW.columns}x${NARROW.rows}`);

    // And growing the window brings the same reading back.
    const recovered = yield* resized(CHECKPOINT_SIZE);
    expect(recovered.view.state.route.scopes).toEqual(scopes);
    expect(recovered.view.state.route.at).toEqual(at);
    expect(recovered.view.state.draft).toBe(SEEDED_DRAFT);
    expect(recovered.view.state.message).toBe(SEEDED_MESSAGE);
    expect(recovered.focused).toBe("footer:input");
    expect(recovered.observed.boundsOf("footer:input")).not.toBe(undefined);
    expect(banded(recovered)).toContain("reading earlier");
    for (const key of ["tray:todo", "sidekick:stop"]) {
      expect({ key, drawn: recovered.observed.boundsOf(key) !== undefined }).toEqual({
        key,
        drawn: true,
      });
    }
    // The shared queue's tray and the Follow control a recovered frame used to
    // bring back with it are DQ0 and DF1 in
    // `fixtures/repl/deferred-presentation.json`: this build offers neither, at
    // any size, before or after a refusal.
    for (const key of ["tray:queue", "follow"]) {
      expect({ key, drawn: recovered.observed.boundsOf(key) !== undefined }).toEqual({
        key,
        drawn: false,
      });
    }
  });
});

/**
 * #971 R3: the Sidekick's question, opened and typed into at a new size.
 *
 * The question is compiled from a closed object schema by the product's own
 * parser, so the form this screen draws is one the REPL's form language
 * actually supports — a form asserted into shape would draw fields the parser
 * would have refused.
 *
 * And it is opened the way a person opens it: the action the control carries,
 * through the reducer, against what the frame measured. A test that set
 * `asking` itself would be asserting the drawer rather than reaching it, and
 * would not notice a control that stopped being able to.
 */
describe("Tier R3 — the Sidekick's parsed question at a constrained size", () => {
  it("R3: the drawer opens through its own action and its field takes text", function* () {
    yield* useTempFileCompiler();
    const model = yield* checkpointModel();
    // The narrowest size this screen supports, with the conversation routed to
    // the one outlet it has: the drawer has least to work with here.
    const size = CHECKPOINT_NARROW;
    const presenter = yield* usePresenter(size);
    const routed = {
      model,
      size,
      live: CHECKPOINT_ASKING,
      sidekick: true,
    } as const;

    // One ordinary string field, as the parser read it.
    expect(CHECKPOINT_QUESTION_FORM.fields.map((one) => one.name)).toEqual(["rule"]);
    const field = "rule";

    // The question is announced where it can be answered.
    const asked = yield* commitCheckpoint(presenter, routed);
    expect(asked.observed.boundsOf("sidekick:answer")).not.toBe(undefined);
    expect(asked.view.live.sidekick?.question?.key).toBe(CHECKPOINT_QUESTION);

    /**
     * The same reducer the keystroke reaches, against what this frame measured
     * and which of the Sidekick's drawers it presented. Both are the frame's
     * own answers: a form held open in state while the screen shows something
     * else owns no keystroke, so a field action reduced without the frame that
     * drew the field is refused.
     */
    const act = (
      state: ReplState,
      action: Parameters<typeof reduceRepl>[1],
      frame: CheckpointFrame,
    ) =>
      reduceRepl(
        state,
        action,
        model,
        CHECKPOINT_ASKING,
        frame.observed.committed.admission,
        presentedDrawer(frame.view),
      ).state;

    // Opened by the action its own control carries, not by a fixture.
    const opened = act(
      checkpointState(model, routed),
      { kind: "open-sidekick-question", question: CHECKPOINT_QUESTION },
      asked,
    );
    expect({ key: opened.asking?.key, open: opened.asking?.open }).toEqual({
      key: CHECKPOINT_QUESTION,
      open: true,
    });

    // Drawn, the drawer carries that one field.
    const drawn = yield* commitCheckpoint(presenter, {
      ...routed,
      state: opened,
      focused: asked.focused,
    });
    expect(drawn.observed.boundsOf("drawer:open")).not.toBe(undefined);
    expect(drawn.observed.boundsOf(`drawer:field:${field}`)).not.toBe(undefined);

    // The field takes the focus text acts on, and then the text.
    const answered = "half up, to the cent";
    const selected = act(
      opened,
      { kind: "select-sidekick-field", question: CHECKPOINT_QUESTION, field },
      drawn,
    );
    expect(selected.asking?.form.field).toBe(field);
    const typed = act(selected, { kind: "type", text: answered, field }, drawn);
    // The question this is an answer to is still the question that was asked.
    expect({
      key: typed.asking?.key,
      value: typed.asking?.form.values[field],
    }).toEqual({ key: CHECKPOINT_QUESTION, value: answered });

    // And the screen says so, in the row the value belongs to.
    const held = yield* commitCheckpoint(presenter, {
      ...routed,
      state: typed,
      focused: drawn.focused,
    });
    const row = held.observed.boundsOf(`drawer:field:${field}`);
    if (row === undefined) {
      throw new Error("the field that took the text is no longer drawn");
    }
    expect(presenter.grid.textIn(row).join(" ")).toContain("half up");
  });
});
