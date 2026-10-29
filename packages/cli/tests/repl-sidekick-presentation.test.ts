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
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { ensure, scoped, sleep, until, withResolvers } from "effection";
import { API } from "@executablemd/runtime";
import { join } from "node:path";

import {
  appendGate,
  awaited,
  awaitedFact,
  mountedExecution,
  mountedReading,
  MOUNTED_AGENT,
  operationGate,
  OTHER_MOUNTED_AGENT,
  useMountedHost,
} from "./support/mounted-repl.ts";
import type { AppendGate, MountedHost, MountedRepl } from "./support/mounted-repl.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { useReplPage } from "./support/mounted-page.ts";
import type { PageFrame, ReplPage } from "./support/mounted-page.ts";
import {
  catalogOpen,
  closeCatalog,
  composerRows,
  configure,
  conversationArea,
  draft,
  drawer,
  entryMarked,
  entrySettles,
  form,
  frameAt,
  openCatalog,
  paste,
  pressSidekickSend,
  routeToSidekick,
  saidByPerson,
  saidBySidekick,
  scrollUntil,
  selectPane,
  shownPane,
  shows,
  sidekick,
  sidekickIdle,
  sidekickShows,
  transcriptCount,
  transcriptRow,
  transcriptRows,
  transcriptShows,
  unwrapped,
} from "./support/repl-page-adapters.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  readSidekickRecords,
  SIDEKICK_FILE,
} from "../src/repl/sidekick/history.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { sidekickChatRows, sidekickTurnRows } from "../src/repl/program.ts";
import { projectSidekick, SAVED_WITHOUT_REPLY } from "../src/repl/sidekick/model.ts";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplSidekickChatRow } from "../src/repl/application.ts";
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
 * Real time for an assertion that something did not happen.
 *
 * A provider that has not been asked and a pair that has not been published
 * change nothing on the screen and publish no event: there is nothing to wait
 * for, so the assertion is given a window in which to be wrong.
 */
function* lingering(): Operation<void> {
  yield* sleep(100);
}

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

/** The column the pane that owns the Sidekick's form begins at, by width. */
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

/**
 * Whether History's own drawer is the one up.
 *
 * It covers the body, so its close lands left of the pane the Sidekick's own
 * drawers belong to.
 */
function historyDrawn(frame: PageFrame): boolean {
  const close = frame.control("drawer:close");
  return (
    close !== undefined &&
    close.bounds.x < paneEnvelope(frame.size.columns) &&
    frame
      .area("box:drawer:layer")
      ?.rows()
      .some((line) => /^\s*History\b/.test(line)) === true
  );
}

/** The three drawable profiles this slice is mounted at. */
const PROFILES: readonly ReplTerminalSize[] = [
  { columns: 160, rows: 36 },
  { columns: 120, rows: 30 },
  { columns: 72, rows: 20 },
];

/** The narrowest size the REPL draws, which routes one outlet. */
const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };

/** Below the minimum, which is the refusal rather than a smaller screen. */
const TOO_SMALL: ReplTerminalSize = { columns: 60, rows: 15 };

/**
 * Whether the catalog marks this entry as the one being read.
 *
 * Asked in the catalog, which is where that marker is. The selection is a
 * standing fact about the reading and the catalog is a drawer over it, so this
 * opens the drawer for the marker and puts it away again — and the drawer hands
 * focus back to the control that opened it, which is why a row asking this asks
 * it after whatever it has to say about focus.
 */
function* markedEntry(page: ReplPage, entry: string): Operation<boolean> {
  yield* openCatalog(page);
  const found = entryMarked(page.frame(), entry);
  yield* closeCatalog(page);
  return found;
}

/** One entry holding one Prompt, which is an entry whose Agent work is real. */
function promptEntry(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}

/** Admit one entry through the draft, the way a person does. */
function* submitEntry(page: ReplPage, source: string): Operation<void> {
  yield* paste(page, draft(page), source);
  yield* page.key("Enter");
}

/**
 * Ask the Sidekick something, the way a person asks it.
 *
 * Its tab when its box does not already hold focus, then its box and its own
 * Send. Done when the box has taken the message.
 */
function* ask(page: ReplPage, text: string): Operation<void> {
  if (page.frame().focused !== "sidekick:message") {
    yield* routeToSidekick(page);
  }
  yield* sidekick(page).send(text);
}

/** Wait until this command's chat history holds at least this many replies. */
function* repliesSaved(repl: MountedRepl, count: number): Operation<void> {
  yield* awaitedFact(`this chat saving ${count} replies`, function* () {
    const read = yield* mountedReading(repl);
    return read.chat.filter((one) => one.kind === "response").length >= count;
  });
}

/** Replace the agent from Configure, which opens a second conversation. */
function* startNewConversation(page: ReplPage): Operation<void> {
  yield* configure(page).open();
  yield* configure(page).agent.replace(OTHER_MOUNTED_AGENT);
  yield* page.until("the control saying it starts a new conversation", (one) =>
    shows(one, "[start new conversation]"),
  );
  yield* configure(page).apply();
  yield* configure(page).closed();
  yield* page.until("the new conversation starting empty", (one) => shows(one, "No messages yet."));
}

/** Select the Transcript row that shows this text. */
function* chooseTurn(page: ReplPage, text: string): Operation<void> {
  const row = transcriptRow(page.frame(), text);
  if (row === undefined) {
    throw new Error(`no Transcript row shows ${JSON.stringify(text)}. ${page.describe()}`);
  }
  yield* page.press(row);
}

/** The chat window's own rows: between its two scroll controls, trimmed, blank rows kept. */
function chatRows(frame: PageFrame): string[] {
  return (frame.area("box:inspection:viewport")?.rows() ?? []).map((line) => line.trim());
}

/** Where the first row showing this text is among these rows, or -1. */
function rowIndex(rows: readonly string[], text: string): number {
  return rows.findIndex((line) => line.includes(text));
}

/**
 * Whether the Sidekick's pane says this, across the rows a sentence was paid out over.
 *
 * A reason is fitted into as many rows as its words need, so a phrase in one
 * legitimately straddles a cut; whether it does is a fact about the width.
 */
function chatSays(frame: PageFrame, text: string): boolean {
  const rows = chatRows(frame);
  const wanted = unwrapped(text);
  return rows.some((line) => line.includes(text)) || unwrapped(rows.join(" ")).includes(wanted);
}

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

/** Leave one mounted command, and hand back the location it ended at. */
function* leaving(page: ReplPage): Operation<string> {
  yield* page.press("footer:exit");
  yield* awaited("the command returning its outcome", () => page.repl.outcome() !== undefined);
  const outcome = page.repl.outcome();
  if (outcome === undefined || !outcome.ok) {
    throw new Error(`this command refused rather than leaving: ${String(outcome?.error)}`);
  }
  return outcome.value.location;
}

/** Hold the record that saves a person's message to this chat history. */
function heldMessageRecord(gate: AppendGate) {
  return gate.holdNext(
    (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"message"'),
  );
}

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
function filteredTo(frame: PageFrame, key: string): boolean {
  const selector = frame.control("transcript:selector")?.text;
  if (selector === undefined) {
    return false;
  }
  for (let kept = key.length; kept >= 8; kept -= 1) {
    const shown = kept === key.length ? key : `${key.slice(0, kept)}…`;
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
function* openFilter(page: ReplPage): Operation<void> {
  if (page.frame().has("sessions:all")) {
    return;
  }
  yield* page.focus("transcript:selector");
  yield* page.key("Enter");
  yield* page.until("the conversations being offered", (one) => one.has("sessions:all"));
}
describe("Tier MP — one Sidekick per command, acquired without working", () => {
  it("M1: a fresh command shows its Sidekick, asks the agent nothing, and keeps focus on the draft", function* () {
    const page = yield* useReplPage();
    const { fake } = page.repl;

    // The pane is the Sidekick by default: its body is the one drawn, beside
    // both tabs in the header.
    const first = page.frame();
    expect(shownPane(first)).toBe("sidekick");
    expect([first.has("tab:bindings"), first.has("tab:sidekick")]).toEqual([true, true]);
    for (const label of ["BINDINGS", "No messages yet.", "message the sidekick", "[send]"]) {
      expect([label, shows(first, label)]).toEqual([label, true]);
    }
    expect(first.control("sidekick:send")?.text).toBe("[send]");
    // Acquiring it did no work: no runtime, no session, no turn.
    expect([fake.created, fake.ensured, fake.prompts, fake.started]).toEqual([[], [], [], false]);

    // A startup focus claim is resolved by the frame that carries it, which is
    // not always the first one drawn. Nothing is pressed either way.
    yield* page.until(
      "the draft holding focus with nothing pressed",
      (one) => one.focused === "footer:input",
    );
    expect(page.frame().focused).not.toBe("sidekick:message");

    // Selecting the Sidekick is what focuses its box, and still asks the agent nothing.
    yield* routeToSidekick(page);
    expect([fake.ensured, fake.prompts]).toEqual([[], []]);
  });

  it("M1: a legacy execution is reopened unchanged, and publishes no pair", function* () {
    const host = yield* useMountedHost();
    // One execution in the older single-file shape, holding a real history —
    // which is what every execution written before the pair existed is.
    const execution = "legacy-one";
    const path = yield* legacyExecution(host.root, execution);
    const before = yield* until(readFile(path, "utf8"));
    const files = yield* held(host.root);

    const page = yield* useReplPage({
      host,
      location: `xmd://repl/${execution}/entries`,
    });
    const repl = page.repl;

    // It opened, and its Sidekick is there with nothing in it.
    yield* page.until("the empty Sidekick", (one) => shows(one, "No messages yet."));
    // The file is exactly as it was and no pair was published: reopening a chat
    // writes nothing, and neither does looking at the Sidekick.
    expect(yield* until(readFile(path, "utf8"))).toBe(before);
    yield* routeToSidekick(page);
    expect(yield* held(host.root)).toEqual(files);
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
  });
});

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

    const page = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    const repl = page.repl;
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
    yield* paste(page, draft(page), TWO_STEP_ENTRY);
    yield* page.key("Enter");
    yield* running.started();

    // The entry is admitted and is still going: its source left the draft, and
    // the record it is writing has not landed. Waited for, because the
    // admission clears the draft in the frame after it and this row is about
    // *that* the source left rather than about which frame carried it away.
    yield* page.until("the admitted source leaving the draft", () => draft(page).text() === "");

    // Now ask the Sidekick, through its own box and its own control.
    yield* routeToSidekick(page);
    yield* sidekick(page).composer.type("explain");
    expect(sidekick(page).composer.text()).toContain("explain");
    // This screen has two Sends — the entry draft's and this composer's — and
    // the Sidekick's own is the one named by its key.
    yield* pressSidekickSend(page);
    yield* lingering();

    // Nothing has been asked of the provider, because the history it would be
    // written to does not exist yet: no session established and no turn sent.
    expect(repl.fake.ensured).toEqual([]);
    expect(repl.fake.prompts).toEqual([]);
    expect(running.released).toBe(false);
    // And no pair: the publication is what the message is waiting on.
    expect(yield* published(host.root)).toEqual([]);

    // The keyboard is nobody else's while all of that waits. The message box
    // still takes what is typed into it, and the draft is still the draft.
    yield* sidekick(page).composer.type("!");
    expect(sidekick(page).composer.text()).toContain("explain!");
    yield* draft(page).type("next");
    expect(draft(page).text()).toBe("next");

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
    yield* page.until("the reply arriving", (one) => shows(one, "Noted."));
    expect(repl.fake.prompts).toHaveLength(1);
    expect(repl.fake.ensured).toHaveLength(1);
    // Exactly the text Send captured, not what the box held by the time the
    // storage handoff finished. The preservation rule itself is M4's; what this
    // row needs is that the turn carried the message that was sent.
    expect(repl.fake.prompts[0]).toContain("explain");
    expect(repl.fake.prompts[0]).not.toContain("explain!");
    // Saved once in the history too, and shown as the person's own message.
    expect(chatMessages(yield* readSidekickRecords(pair.sidekick))).toEqual(["explain"]);
    expect(saidByPerson(page.frame(), "explain")).toBe(true);

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

describe("Tier MP — the message box is cleared by the message that was saved", () => {
  it("M4: a delayed acknowledgement clears what was sent and keeps what came after", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    const { fake } = repl;
    fake.script({ reply: FILLING_REPLY });
    fake.script({ reply: "<Output>Understood.</Output>\n" });
    // Typing in the draft pauses the Sidekick's automatic replacement of it.
    yield* draft(page).type("mine");

    const saving = heldMessageRecord(gate);
    yield* sidekick(page).composer.type("ask");
    yield* pressSidekickSend(page);
    yield* saving.started();
    // Both texts move on while the save is in flight, and each is a newer claim.
    yield* sidekick(page).composer.type("!");
    yield* draft(page).type("X");
    saving.release();
    yield* page.until("the reply arriving", (one) => shows(one, "Understood."));

    // Saved and sent is the text Send captured, not what the box held later.
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["ask"]);
    expect(fake.prompts[0]).toContain("ask");
    expect(fake.prompts[0]).not.toContain("ask!");
    // The acknowledgement cleared its own revision and nothing newer.
    expect(sidekick(page).composer.text()).toContain("ask!");
    expect(draft(page).text()).toBe("mineX");
    // The newer draft edit refused the reply's fill, and the reply was told so.
    expect(fake.prompts[1] ?? "").toContain("taken the shared draft over");
  });

  it("M4: control — with nothing typed after it, the same message clears the box", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    const { fake } = repl;
    fake.script({ reply: FILLING_REPLY });
    fake.script({ reply: "<Output>Understood.</Output>\n" });
    yield* draft(page).type("mine");

    const saving = heldMessageRecord(gate);
    yield* sidekick(page).composer.type("ask");
    yield* pressSidekickSend(page);
    yield* saving.started();
    saving.release();
    yield* page.until("the reply arriving", (one) => shows(one, "Understood."));

    expect(sidekick(page).composer.text()).not.toContain("ask");
    // The released takeover let the fill through, which is only true because
    // the acknowledgement was applied before the reply asked to fill.
    expect(fake.prompts[1] ?? "").toContain("Entry input updated.");
    expect(fake.prompts[1] ?? "").not.toContain("taken the shared draft over");
    expect(draft(page).text()).toContain("Replaced by the reply.");
  });
});

describe("Tier MP — a working Sidekick, and what reaches the screen while it works", () => {
  it("M5: while generation is held, Stop is the control and Send cannot start a second cycle", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    const { fake } = repl;
    fake.script({ held: true, reply: "<Output>Done.</Output>\n" });

    yield* routeToSidekick(page);
    yield* sidekick(page).composer.type("ask");
    // Two Enters in one chunk ask for a second cycle before the first has
    // remounted the row; the reservation the first took refuses it.
    yield* page.type("\r\r");
    yield* fake.holdingTurns(1);
    expect(fake.prompts).toHaveLength(1);
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["ask"]);

    // This pane's Send is gone and its Stop is there; the draft keeps its own.
    yield* page.until("the pane working, with Stop as its control", (one) =>
      saidBySidekick(one, "working"),
    );
    expect(sidekick(page).working()).toBe(true);
    expect(page.frame().has("sidekick:stop")).toBe(true);
    expect(page.frame().has("sidekick:send")).toBe(false);
    expect(page.frame().has("draft:send")).toBe(true);
    // And the box is still a box while the reply comes back.
    yield* sidekick(page).composer.type("then this");

    fake.releaseTurn();
    yield* page.until("the reply arriving", (one) => shows(one, "Done."));
    yield* page.until("this pane's Send coming back", sidekickIdle);
    // Finishing sends nothing: text prepared while busy is still only prepared.
    expect(sidekick(page).composer.text()).toContain("then this");
    expect(fake.prompts).toHaveLength(1);
  });

  it("M5: the first reply appears while its follow-up is held, with nothing pressed", function* () {
    const page = yield* useReplPage();
    const { terminal, fake } = page.repl;
    // The Output answers; the read is what owes a next turn, which is held.
    fake.script({ reply: ["<Output>First answer.</Output>", "<REPL.Bindings />", ""].join("\n") });
    fake.script({ held: true, reply: "<Output>Second answer.</Output>\n" });

    yield* sidekick(page).send("ask");
    yield* fake.holdingTurns(1);
    const fed = terminal.fed;
    yield* page.until("the first reply arriving with no keystroke", (one) =>
      saidBySidekick(one, "First answer."),
    );
    expect(terminal.fed).toBe(fed);
    // Still working, and still the one cycle.
    expect(sidekick(page).working()).toBe(true);
    expect(shows(page.frame(), "Second answer.")).toBe(false);
    expect(fake.prompts).toHaveLength(2);

    fake.releaseTurn();
    yield* page.until("the follow-up answering", (one) => saidBySidekick(one, "Second answer."));
    yield* page.until("this pane's Send coming back", sidekickIdle);
    expect(fake.prompts).toHaveLength(2);
  });

  it("M5: control — an ordinary entry's own progress reaches the screen with no further key", function* () {
    const page = yield* useReplPage();
    const { terminal, fake } = page.repl;
    yield* paste(page, draft(page), TWO_STEP_ENTRY);
    yield* page.key("Enter");
    const fed = terminal.fed;
    yield* page.until("the entry's output arriving with no keystroke", (one) =>
      shows(one, "the released step"),
    );
    expect(terminal.fed).toBe(fed);
    expect([fake.ensured, fake.prompts]).toEqual([[], []]);
  });
});

describe("Tier MP — the Sidekick at every size it is drawn at", () => {
  /** Both destinations with their own text, the Sidekick selected explicitly as a route. */
  function* composed(page: ReplPage, drafted: string, message: string): Operation<void> {
    yield* draft(page).type(drafted);
    yield* routeToSidekick(page);
    yield* sidekick(page).composer.type(message);
  }

  it("M7: all three profiles keep both texts, the footer and one body", function* () {
    const page = yield* useReplPage();
    // Short, because the medium profile's right pane is narrow and a field
    // draws one row there.
    yield* composed(page, "note", "ask");

    for (const size of PROFILES) {
      const drawn = yield* frameAt(page, size);
      expect(drawn.rows.length).toBe(size.rows);
      expect(drawn.has("footer:exit")).toBe(true);
      expect(shows(drawn, "[exit]")).toBe(true);
      // One body and one message box in the pane this route reads, and that
      // pane's one Send; the draft keeps its own beside it.
      expect(sidekick(page).composer.text()).toContain("ask");
      expect(drawn.rows.filter((line) => line.includes("message the sidekick"))).toHaveLength(1);
      expect(
        conversationArea(drawn)
          ?.rows()
          .filter((line) => line.includes("[send]")),
      ).toHaveLength(1);
      if (size.columns > NARROW.columns) {
        expect(draft(page).text()).toContain("note");
        continue;
      }
      // Narrow routes its one outlet to the Sidekick, so the draft is in no
      // cell — and going to the entries, then wide again, shows it was held.
      expect(drawn.has("footer:input")).toBe(false);
      yield* openCatalog(page);
      yield* closeCatalog(page);
      yield* page.until(
        "the draft back on the narrow outlet",
        (one) => one.has("footer:input") && draft(page).text().includes("note"),
      );
      const recovered = yield* frameAt(page, PROFILES[0]);
      expect(recovered.has("sidekick:message")).toBe(true);
      expect(sidekick(page).composer.text()).toContain("ask");
      expect(draft(page).text()).toContain("note");
    }
  });

  it("M7: selecting Bindings removes the Sidekick's body and its input targets", function* () {
    const page = yield* useReplPage();
    yield* composed(page, "my entry", "my question");

    yield* selectPane(page, "bindings");
    const bindings = page.frame();
    expect(bindings.has("sidekick:message")).toBe(false);
    expect(shows(bindings, "message the sidekick")).toBe(false);
    expect(bindings.area("box:inspection")?.shows("[send]")).toBe(false);
    expect(draft(page).text()).toContain("my entry");

    // The message is process-local, and looking at something else keeps it.
    yield* routeToSidekick(page);
    expect(sidekick(page).composer.text()).toContain("my question");
  });

  it("M7: a default Sidekick shrinks to narrow Entries, and an explicit one stays", function* () {
    const page = yield* useReplPage();
    // Nothing activated: the Sidekick is a default reading, not a route.
    expect(shownPane(page.frame())).toBe("sidekick");
    const narrow = yield* page.resize(NARROW);
    expect(shows(narrow, "Entries")).toBe(true);
    expect(shownPane(narrow)).toBe("bindings");

    // Selected explicitly, it is a route, and it survives the shrink.
    yield* page.resize(PROFILES[0]);
    yield* routeToSidekick(page);
    yield* sidekick(page).composer.type("kept");
    const kept = yield* page.resize(NARROW);
    expect(shownPane(kept)).toBe("sidekick");
    expect(sidekick(page).composer.text()).toContain("kept");
    const expanded = yield* page.resize(PROFILES[0]);
    expect(shownPane(expanded)).toBe("sidekick");
    expect(sidekick(page).composer.text()).toContain("kept");
  });

  it("M7: an older entry stays frozen while the Sidekick works, and Bindings still reads it", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    const { fake } = repl;
    yield* paste(page, draft(page), TWO_STEP_ENTRY);
    yield* page.key("Enter");
    yield* page.until("the released step", (one) => shows(one, "the released step"));
    yield* entrySettles(page, 1, "ok");
    // Selected in the catalog, which closes behind the choice.
    yield* openCatalog(page);
    yield* page.press("entry:entry-1");
    yield* page.until("the catalog closing", (one) => !catalogOpen(one));

    // A reply that runs a second entry: the chat and the catalog move, and the
    // position somebody is reading does not.
    fake.script({
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
    fake.script({ reply: "<Output>Both ran.</Output>\n" });
    yield* sidekick(page).send("run two");
    yield* page.until("the second entry being reported", (one) => saidBySidekick(one, "Both ran."));
    expect(yield* markedEntry(page, "entry-1")).toBe(true);
    expect((yield* mountedReading(repl)).model.entries).toHaveLength(2);
    expect(shows(page.frame(), "the released step")).toBe(true);

    // Bindings still switches, and reads that same entry.
    yield* selectPane(page, "bindings");
    expect(yield* markedEntry(page, "entry-1")).toBe(true);
    expect(shows(page.frame(), "the released step")).toBe(true);
    expect(page.frame().has("sidekick:message")).toBe(false);

    // And back to the Sidekick, with the chat it had.
    yield* routeToSidekick(page);
    expect(saidBySidekick(page.frame(), "Both ran.")).toBe(true);
    expect(saidByPerson(page.frame(), "run two")).toBe(true);
  });

  it("M7: a terminal below the minimum refuses, and recovers with both texts", function* () {
    const page = yield* useReplPage();
    yield* composed(page, "my entry", "my question");
    // A refusal is the whole of its own screen: no pane's control is on it.
    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.profile).toBe("too-small");
    expect(refused.keys()).toEqual([]);
    expect(shows(refused, "message the sidekick")).toBe(false);
    expect(shows(refused, "[send]")).toBe(false);

    yield* page.resize(PROFILES[0]);
    expect(draft(page).text()).toContain("my entry");
    expect(sidekick(page).composer.text()).toContain("my question");
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
  const page = yield* useReplPage({
    host,
  });
  const repl = page.repl;

  yield* sidekick(page).send("run this");
  yield* reached.operation;

  let edited: string | undefined;
  if (edit) {
    // Through the mounted input, while the preflight is held: this is somebody
    // typing into the shared draft after the reply reserved it. They are typing
    // *after* the fill the same reply made, so what they end up owning is that
    // source with their own text on the end of it.
    yield* draft(page).type("mine now");
    edited = draft(page).text();
    expect(edited).toContain("mine now");
  }

  allow.resolve();
  yield* page.until("the response completing", (one) => shows(one, "Done."));

  const read = yield* mountedReading(repl);
  return {
    entries: read.model.entries.map((entry) => entry.key),
    draft: draft(page).text(),
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
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    repl.fake.script({ reply: askingReply("Approve the plan?") });
    repl.fake.script({ reply: "<Output>Noted.</Output>\n" });

    // The record that files this question, held open before the question is
    // published: the intent goes down before anybody is asked, so holding it
    // holds the asking itself.
    const filing = heldElicitIntent(gate);

    // One ordinary entry of this person's, so there is a History position and a
    // catalog row for the arrival below to leave alone.
    yield* paste(page, draft(page), TWO_STEP_ENTRY);
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    // Chosen in the catalog, which is where this screen keeps those rows: a
    // drawer over the reading, opened to point at one, and the choice closes it.
    yield* openCatalog(page);
    yield* page.press("entry:entry-1");
    yield* page.until("the catalog closing behind the choice", (one) => !catalogOpen(one));

    // Then the message that will ask, sent from the Sidekick's own box.
    yield* sidekick(page).send("review it");
    yield* filing.started();

    // And now somebody walks away from the Sidekick: Bindings selected, an
    // entry being read, their own text in the draft.
    yield* selectPane(page, "bindings");
    yield* draft(page).type("mine");
    expect(draft(page).text()).toBe("mine");

    // Nothing is pressed from here. The question has to announce itself.
    const fed = repl.terminal.fed;
    filing.release();
    yield* page.until("the question announcing itself with no keystroke", (one) =>
      shows(one, "SIDEKICK (question)"),
    );
    expect(repl.terminal.fed).toBe(fed);

    // It took nothing over. The tab is still Bindings, focus is still the
    // draft, both texts are still theirs, and the entry they were reading is
    // still the one selected.
    expect(shownPane(page.frame())).toBe("bindings");
    expect(page.frame().focused).toBe("footer:input");
    expect(draft(page).text()).toBe("mine");
    expect(yield* markedEntry(page, "entry-1")).toBe(true);
    // And no form is open: arrival opens no drawer.
    expect(form(page).isOpen()).toBe(false);

    // Selecting the Sidekick shows the notice and the way in, and still opens
    // nothing — opening is a separate deliberate act.
    yield* selectPane(page, "sidekick");
    yield* page.until("the notice in the pane", (one) => one.has("sidekick:answer"));
    expect(shows(page.frame(), "[answer sidekick]")).toBe(true);
    expect(form(page).isOpen()).toBe(false);
    expect(sidekick(page).composer.text().includes("review it")).toBe(false);

    // This act, and only this act, opens the form.
    yield* page.press("sidekick:answer");
    yield* page.until("the form opening", () => form(page).isOpen());
    expect(shows(page.frame(), "Approve the plan?")).toBe(true);
    expect(shows(page.frame(), "decision: approve | reject")).toBe(true);
  });

  it("MQ1: control — an ordinary entry's question announces itself the same way", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;

    // An entry that asks. Its own provider, in the session's own scope, and its
    // own announcement: this is the wakeup that is not the Sidekick's.
    yield* paste(page, draft(page), ENTRY_ASKS);
    yield* page.key("Enter");

    const fed = repl.terminal.fed;
    yield* page.until(
      "the entry's question announcing itself with no keystroke",
      (one) => one.control("footer:asked")?.text.includes("[answer]") === true,
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

describe("Tier MQ — the question form lives in the pane that owns it", () => {
  it("MQ4: the form stays inside its own pane at every size, and survives a refusal", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.script({ reply: askingReply("Fill this in.", LONG_SCHEMA) });
    repl.fake.script({ reply: "<Output>Got it.</Output>\n" });

    // Their own text in both composers, which none of what follows may touch.
    yield* draft(page).type("mine");
    yield* routeToSidekick(page);
    yield* sidekick(page).send("ask");
    yield* sidekick(page).composer.type("later");

    // The notice this screen gives: the control that opens the question, in the
    // pane that owns it.
    yield* page.until("the question announcing itself", (one) => one.has("sidekick:answer"));
    yield* page.press("sidekick:answer");
    yield* page.until(
      "the form opening",
      (one) => one.has("drawer:value:one") && shows(one, "Fill this in."),
    );

    // Something typed into it, so every size below is preserving a partial
    // answer rather than an empty form.
    yield* form(page).value("one").type("first");
    expect(shows(page.frame(), "one: first")).toBe(true);

    // Not every field fits: the last one and the way to submit are outside the
    // window, so they are no node, no cell and no target.
    expect(shows(page.frame(), "last:")).toBe(false);
    expect(page.frame().has("drawer:value:last")).toBe(false);
    expect(page.frame().has("drawer:form:submit")).toBe(false);
    expect(shows(page.frame(), "[submit]")).toBe(false);
    // And real scrolling reaches them, one row at a time through the control
    // that moves this window.
    yield* scrollUntil(
      page,
      { window: "drawer", control: "drawer:scroll:down", toward: "more" },
      (one) => one.has("drawer:form:submit"),
    );
    expect(shows(page.frame(), "[submit]")).toBe(true);
    expect(shows(page.frame(), "last:")).toBe(true);
    expect(page.frame().has("drawer:value:last")).toBe(true);

    // And back to the top, through the control that moves it the other way, so
    // what follows is about the pane rather than about where the window is.
    yield* scrollUntil(
      page,
      { window: "drawer", control: "drawer:scroll:up", toward: "less" },
      (one) => shows(one, "Fill this in."),
    );
    expect(shows(page.frame(), "Fill this in.")).toBe(true);

    for (const size of PROFILES) {
      yield* frameAt(page, size);
      const drawn = yield* page.until(`the form at ${size.columns}x${size.rows}`, (one) =>
        shows(one, "Fill this in."),
      );
      const envelope = paneEnvelope(size.columns);
      const layer = drawn.area("box:drawer:layer");
      const footer = drawn.control("footer:exit");
      if (layer === undefined || footer === undefined) {
        throw new Error(`the form at ${size.columns}x${size.rows} drew no drawer or no way out`);
      }

      // Inside the pane that owns it. Compared against the reference envelope
      // rather than against the production rectangle: a test that asked the
      // code where it put the drawer would agree with it however wrong it was.
      expect(layer.bounds.x).toBeGreaterThanOrEqual(envelope);
      expect(layer.bounds.x + layer.bounds.width).toBeLessThanOrEqual(size.columns);
      expect(layer.shows("Fill this in.")).toBe(true);
      for (const key of ["drawer:close", "drawer:scroll:up", "drawer:value:one"]) {
        expect([key, layer.contains(key)]).toEqual([key, true]);
        expect([key, conversationArea(drawn)?.contains(key)]).toEqual([key, true]);
      }
      // Above this screen's own footer, which the form never covers. Read from
      // the row the way out is actually drawn on rather than from a count: how
      // many rows a footer takes is the layout's, and what this asserts is that
      // the drawer stays off it.
      expect(layer.bounds.y + layer.bounds.height).toBeLessThanOrEqual(footer.bounds.y);
      // The footer is still the footer.
      expect(shows(drawn, "[exit]")).toBe(true);
      // No entry form is drawn beside it: one question drawer at a time.
      expect(drawn.rows.filter((line) => line.includes("[close]")).length).toBe(1);
      // What was typed is still in it.
      expect(shows(drawn, "one: first")).toBe(true);
      // And the draft is still the draft, read where it is drawn: a narrow
      // frame routes one outlet, and this form belongs to the reading that has
      // it — so the draft is in no cell there, which the resize below proves is
      // not the same as lost.
      if (size.columns > NARROW.columns) {
        expect(draft(page).text()).toContain("mine");
      } else {
        expect(drawn.has("footer:input")).toBe(false);
      }
    }

    // Too small to draw: a refusal, and the form is not in it.
    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.profile).toBe("too-small");
    expect(shows(refused, `${NARROW.columns}x`)).toBe(true);
    expect(shows(refused, "[close]")).toBe(false);
    expect(refused.keys()).toEqual([]);

    // Back to narrow, then wide: the question, its partial value and both
    // composers are all exactly as they were.
    const narrow = yield* page.resize(NARROW);
    yield* page.until("the form coming back at 72x20", (one) => shows(one, "Fill this in."));
    expect(shows(narrow, "one: first") || shows(page.frame(), "one: first")).toBe(true);
    const wide = yield* page.resize(PROFILES[0]);
    yield* page.until("the form coming back at 160x36", (one) => shows(one, "Fill this in."));
    expect(shows(wide, "one: first") || shows(page.frame(), "one: first")).toBe(true);
    expect(draft(page).text()).toContain("mine");

    // The form holds focus while it is open, so the way out of this reading is
    // its own close — which is the same precedence the entry's drawer has.
    yield* page.press("drawer:close");
    yield* page.until("the form closing", (one) => one.has("sidekick:answer"));
    expect(page.frame().has("drawer:close")).toBe(false);

    // Leaving the reading takes the notice and the way in with it, and coming
    // back brings them back — with the value still in the form behind them.
    yield* selectPane(page, "bindings");
    const onBindings = page.frame();
    expect(onBindings.has("drawer:close")).toBe(false);
    expect(onBindings.has("sidekick:answer")).toBe(false);
    expect(shows(onBindings, "Fill this in.")).toBe(false);

    yield* selectPane(page, "sidekick");
    yield* page.until("the notice still in the pane", (one) => one.has("sidekick:answer"));
    // Coming back selects the reading and nothing more: the form is not put
    // back on the screen by returning to the pane it was open in.
    expect(page.frame().has("drawer:close")).toBe(false);
    // And the pane's own body is back, with both composers exactly as they were.
    expect(sidekick(page).composer.text().includes("later")).toBe(true);
    expect(draft(page).text()).toBe("mine");
    yield* page.press("sidekick:answer");
    yield* page.until("the form reopening", (one) => shows(one, "Fill this in."));
    expect(shows(page.frame(), "one: first")).toBe(true);
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
function* askedAndOpen(explicit: boolean): Operation<ReplPage> {
  const page = yield* useReplPage();
  page.repl.fake.script({ reply: askingReply("Sidekick asks.", ONE_FIELD) });
  if (explicit) {
    yield* selectPane(page, "sidekick");
  }
  // Traversal rather than activation in the default arm: activating the tab is
  // what would make this a route, and this arm is about the default reading.
  yield* page.focus("sidekick:message");
  expect(page.frame().focused).toBe("sidekick:message");
  yield* sidekick(page).composer.type("ask");
  yield* pressSidekickSend(page);
  yield* page.until("the question opener", (one) => one.has("sidekick:answer"));
  yield* page.press("sidekick:answer");
  yield* page.until("the form opening", () => form(page).isOpen());
  yield* form(page).value("message").type("partial");
  expect(shows(page.frame(), "message: partial")).toBe(true);
  return page;
}

/**
 * Open History over this command, close it once, and say whether the question
 * form came back.
 *
 * One close action, as a person presses it: a drawer that needed two would be
 * one whose close acted on something underneath it.
 */
function* historyOver(page: ReplPage): Operation<boolean> {
  yield* page.press("footer:history");
  yield* page.until("History's own drawer", historyDrawn);
  yield* page.press("drawer:close");
  yield* page.until("History leaving its rectangle", (one) => !historyDrawn(one));
  return page.frame().has("drawer:form:submit");
}

describe("Tier MQ — what is on the screen owns the keys and the controls", () => {
  it("Q-P1: a form hidden by a resize does not consume Draft typing", function* () {
    const page = yield* askedAndOpen(false);

    // Narrow routes one outlet, and with no explicit view it is Entries — so
    // this question is pending, its partial answer is stored, and neither is
    // on the screen.
    const narrow = yield* page.resize(NARROW);
    expect(narrow.has("drawer:form:submit")).toBe(false);
    expect(shows(narrow, "[submit]")).toBe(false);

    // The draft is the visible input, so it is the one that takes the keys.
    yield* draft(page).type("ordinary");
    expect(draft(page).text()).toBe("ordinary");

    // And the form it did not reach is exactly as it was left. Expanding shows
    // it again — a resize hides a form, it does not close one — and what is in
    // it is still the partial answer, not the draft typed over the top of it.
    const wide = yield* page.resize({ columns: 160, rows: 36 });
    yield* page.until("the form back in its pane", (one) => one.has("drawer:form:submit"));
    expect(shows(wide, "partialordinary")).toBe(false);
    expect(shows(page.frame(), "message: partial")).toBe(true);
    expect(draft(page).text()).toBe("ordinary");
  });

  it("Q-P1: control — an explicitly selected form still edits its own field", function* () {
    const page = yield* askedAndOpen(true);

    // Explicit activation made the Sidekick a route, so narrow keeps it — and
    // the form is what the screen is showing.
    const narrow = yield* page.resize(NARROW);
    expect(narrow.has("drawer:form:submit")).toBe(true);
    expect(narrow.has("footer:input")).toBe(false);

    yield* form(page).value("message").type(" more");
    expect(shows(page.frame(), "message: partial more")).toBe(true);
    // And the draft, which is not the visible input, took none of it.
    yield* page.resize({ columns: 160, rows: 36 });
    expect(draft(page).text()).toBe("");
  });

  it("Q-P2: History over an open form closes once and leaves the form waiting", function* () {
    const page = yield* askedAndOpen(true);

    // One close, acting on the drawer that owns the modal. The command is still
    // running afterwards, which a focus claim made outside that modal would
    // have ended.
    expect(yield* historyOver(page)).toBe(true);
    expect(page.repl.outcome()).toBe(undefined);
    // And the question is still the one it was, with what was typed in it.
    expect(shows(page.frame(), "Sidekick asks.")).toBe(true);
    expect(shows(page.frame(), "message: partial")).toBe(true);
  });

  it("Q-P2: control — History closes the same way with no form open", function* () {
    const page = yield* askedAndOpen(true);
    yield* page.press("drawer:close");
    yield* page.until("the question opener again", (one) => one.has("sidekick:answer"));

    // The same one close, and nothing of the Sidekick's comes back because
    // nothing of it was open.
    expect(yield* historyOver(page)).toBe(false);
    expect(page.repl.outcome()).toBe(undefined);
    expect(page.frame().has("sidekick:answer")).toBe(true);
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

  /** Open Configure from its header control, and wait for what it advertises. */
  function* configureOpened(page: ReplPage): Operation<void> {
    yield* configure(page).open();
    yield* page.until("the advertised models", (one) => shows(one, "Balanced"));
  }

  /** Configure is closed, and focus is on the control that opened it. */
  function openerFocused(frame: PageFrame): boolean {
    return !shows(frame, "[refresh]") && frame.focused === "sidekick:configure";
  }

  it("CFG6: Configure stays inside its pane at every size, and survives a refusal", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    // An explicit Sidekick route, so narrow keeps this pane rather than Entries.
    yield* draft(page).type("note");
    yield* routeToSidekick(page);
    yield* sidekick(page).composer.type("ask");
    yield* configureOpened(page);
    yield* configure(page).chooseModel("fast");

    for (const size of PROFILES) {
      yield* frameAt(page, size);
      const drawn = yield* page.until(`Configure at ${size.columns}x${size.rows}`, (one) =>
        shows(one, "(x) Fast"),
      );
      // Against the accepted envelope rather than the production rectangle: a
      // test that asked the code where it put the drawer would agree with it.
      const envelope = paneEnvelope(size.columns);
      const layer = drawn.area("box:drawer:layer");
      const footer = drawn.control("footer:exit");
      if (layer === undefined || footer === undefined) {
        throw new Error(`Configure at ${size.columns}x${size.rows} drew no drawer or no way out`);
      }
      expect(layer.bounds.x).toBeGreaterThanOrEqual(envelope);
      expect(layer.bounds.x + layer.bounds.width).toBeLessThanOrEqual(size.columns);
      for (const key of ["drawer:close", "drawer:configure:refresh"]) {
        expect([key, layer.contains(key)]).toEqual([key, true]);
        expect([key, conversationArea(drawn)?.contains(key)]).toEqual([key, true]);
      }
      expect(layer.bounds.y + layer.bounds.height).toBeLessThanOrEqual(footer.bounds.y);
      expect(drawn.rows.filter((line) => line.includes("[close]"))).toHaveLength(1);
      expect(shows(drawn, "[exit]")).toBe(true);
      // Narrow routes its one outlet to this pane, so the draft is in no cell there.
      if (size.columns > NARROW.columns) {
        expect(draft(page).text()).toContain("note");
      } else {
        expect(drawn.has("footer:input")).toBe(false);
      }
    }

    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.profile).toBe("too-small");
    expect(shows(refused, "[refresh]")).toBe(false);
    // Back: the drawer, its unapplied choice and the draft are as they were.
    yield* page.resize(PROFILES[0]);
    yield* page.until("Configure coming back", (one) => shows(one, "[refresh]"));
    expect(shows(page.frame(), "(x) Fast")).toBe(true);
    expect(draft(page).text()).toContain("note");
    // Escape hands focus back to the opener, and the box Configure covered still holds its text.
    yield* page.key("Escape");
    yield* page.until("Configure closing, focus back on its opener", openerFocused);
    expect(sidekick(page).composer.text()).toContain("ask");
  });

  it("CFG6: Tab and Shift+Tab move inside Configure, and Close or Escape return to its opener", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* draft(page).type("note");
    yield* configureOpened(page);

    yield* page.focus("drawer:configure:agent");
    yield* page.key("Tab");
    yield* page.until(
      "the first choice",
      (one) => one.focused === "drawer:configure:model:balanced",
    );
    yield* page.key("Tab");
    yield* page.until("the second choice", (one) => one.focused === "drawer:configure:model:fast");
    yield* page.key("Backtab");
    yield* page.until(
      "Shift+Tab to the first",
      (one) => one.focused === "drawer:configure:model:balanced",
    );
    // A sentinel typed at a choice edits nothing behind the drawer, and the
    // Escape after it gives focus back to the control that opened Configure.
    yield* page.type("zz");
    yield* page.key("Escape");
    yield* page.until("Configure closing, focus back on its opener", openerFocused);
    expect([draft(page).text(), sidekick(page).composer.text().includes("zz")]).toEqual([
      "note",
      false,
    ]);

    yield* configureOpened(page);
    yield* page.press("drawer:close");
    yield* page.until("Configure closing, focus back on its opener", openerFocused);
    // From there, a composer is reached the ordinary way.
    yield* draft(page).type("-more");
  });

  it("CFG6: a choice below the drawer's window is reached by scrolling to it", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
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
    yield* page.press("sidekick:configure");
    yield* page.until("the advertised models", (one) => shows(one, "Model 1"));
    const last = `drawer:configure:model:model-${many.length}`;
    // Genuinely off the window: not drawn, and so not targetable either.
    expect(shows(page.frame(), `( ) Model ${many.length}`)).toBe(false);
    expect(page.frame().has(last)).toBe(false);

    // Scrolled with the drawer's own control, a line at a time, until it is
    // on the screen. Bounded, so a drawer that cannot move fails here rather
    // than scrolling for ever.
    yield* configure(page).scrollTo(last);

    // And it is a real choice once it is reachable: selected, applied, saved.
    yield* configure(page).chooseModel(`model-${many.length}`);
    expect(shows(page.frame(), `(x) Model ${many.length}`)).toBe(true);
    // Choosing it says what effort has not been read for it, so the content
    // grew by a line and Apply is below the window again.
    yield* configure(page).scrollTo("drawer:configure:apply");
    yield* configure(page).apply();
    yield* configure(page).closed();
    yield* page.until("Configure closing on the save", (one) => one.has("sidekick:send"));
    yield* awaitedFact("the preference being saved", function* () {
      return (yield* mountedReading(repl)).chat.some((record) => record.kind === "preferences");
    });
    const read = yield* mountedReading(repl);
    const saved = read.chat.filter((record) => record.kind === "preferences");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ model: `model-${many.length}` });
  });

  it("CFG6: a half-filled Sidekick question keeps its values across Configure", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Ready.</Output>\n" });
    repl.fake.script({
      reply: `<Elicit schema={${JSON.stringify(ASKS)}} as="answer">Approve the plan?</Elicit>\n`,
    });
    repl.fake.script({ reply: "<Output>Thanks for deciding.</Output>\n" });

    // One conversation, and one read of what it offers before it goes busy: a
    // pending question is a turn in flight, and inspection is one of the
    // things a working conversation cannot do.
    yield* sidekick(page).send("hello");
    yield* page.until("the first reply", (one) => shows(one, "Ready."));
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* configureOpened(page);
    yield* configure(page).close();

    yield* sidekick(page).send("review it");
    // The notice this screen gives: the control that opens the question, in the
    // pane that owns it.
    yield* page.until("the question announcing itself", (one) => one.has("sidekick:answer"));
    yield* page.press("sidekick:answer");
    yield* page.until("the form opening", () => form(page).isOpen());

    // Half an answer: one field filled, the other deliberately left as it is.
    yield* form(page).value("decision").type("approve");
    yield* form(page).value("message").type("ok");
    expect(shows(page.frame(), "message: ok")).toBe(true);

    // Configure, over the top of it, used for something real and then closed.
    yield* form(page).close();
    yield* page.until("the form closing", () => !form(page).isOpen());
    yield* configure(page).open();
    yield* page.until("the choices already advertised", (one) => shows(one, "Balanced"));
    yield* configure(page).chooseModel("fast");
    yield* configure(page).close();

    // The question is still pending and still half-answered: two drawers of
    // this pane are two separate things being filled in, and neither holds the
    // other's values.
    yield* page.until("the way in to the question", (one) => one.has("sidekick:answer"));
    yield* page.press("sidekick:answer");
    yield* page.until("the form reopening", () => form(page).isOpen());
    expect(shows(page.frame(), "decision: approve")).toBe(true);
    expect(shows(page.frame(), "message: ok")).toBe(true);

    // And finishing it from there answers the question that was asked. The
    // reopened form opens on its first line, so the field being completed is
    // selected rather than assumed.
    yield* form(page).value("message").type("ay");
    yield* page.until("the completed value", (one) => shows(one, "message: okay"));
    yield* form(page).submit();
    yield* page.until("the reply that was waiting", (one) => shows(one, "Thanks for deciding."));
    expect(JSON.parse(repl.fake.prompts[2] ?? "")).toEqual({
      decision: "approve",
      message: "okay",
    });
  });

  it("CFG6: control — an explicitly selected narrow Sidekick draws Configure and takes its keys", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* draft(page).type("note");
    // Explicitly selected, which narrow honours: its outlet goes to this pane.
    yield* routeToSidekick(page);
    yield* configureOpened(page);
    const narrow = yield* page.resize(NARROW);
    yield* page.until("Configure at the narrow size", (one) => shows(one, "[refresh]"));
    expect(shows(narrow, "Balanced") || shows(page.frame(), "Balanced")).toBe(true);

    // Its own field takes the keys here, and the draft is in no cell of this outlet.
    yield* configure(page).agent.enter("-two");
    yield* page.until("the name being edited", () =>
      shows(page.frame(), `Agent: ${MOUNTED_AGENT}-two`),
    );
    expect(page.frame().has("footer:input")).toBe(false);
    yield* page.press("drawer:close");
    yield* page.until("Configure closing", (one) => !shows(one, "[refresh]"));
    yield* openCatalog(page);
    yield* closeCatalog(page);
    yield* page.until(
      "the draft on the narrow outlet",
      (one) => one.has("footer:input") && draft(page).text() === "note",
    );
  });

  it("CFG6: History over Configure closes once, and a hidden Configure takes no keys", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    yield* draft(page).type("note");
    yield* configureOpened(page);

    // History owns the modal while it is open: one close is History's.
    yield* page.press("footer:history");
    yield* page.until("History's own drawer", historyDrawn);
    yield* page.press("drawer:close");
    yield* page.until("History closing", (one) => !historyDrawn(one));
    expect(repl.outcome()).toBe(undefined);
    expect(shows(page.frame(), "[refresh]")).toBe(true);

    // With no explicit route narrow shows Entries, and the visible Draft takes the keys.
    expect(shows(yield* page.resize(NARROW), "[refresh]")).toBe(false);
    yield* draft(page).type("-more");
    yield* page.resize(PROFILES[0]);
    yield* page.until("Configure coming back", (one) => shows(one, "[refresh]"));
    expect(shows(page.frame(), "Balanced")).toBe(true);
    expect(shows(page.frame(), `${MOUNTED_AGENT}-more`)).toBe(false);
  });

  it("CX3: Escape closes History first, and Configure under its own rule after", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    yield* draft(page).type("note");
    yield* configureOpened(page);
    // Chosen and not applied, so what each Escape keeps or discards is visible.
    yield* configure(page).chooseModel("fast");

    yield* page.press("footer:history");
    yield* page.until("History's own drawer", historyDrawn);
    yield* page.key("Escape");
    yield* page.until("History closing", (one) => !historyDrawn(one));
    expect(repl.outcome()).toBe(undefined);
    expect(shows(page.frame(), "[refresh]")).toBe(true);
    expect(shows(page.frame(), "(x) Fast")).toBe(true);

    // The next Escape is Configure's: nothing saved, and the choice goes with it.
    yield* page.key("Escape");
    yield* page.until("Configure closing", (one) => !shows(one, "[refresh]"));
    expect((yield* mountedReading(repl)).chat.some((one) => one.kind === "preferences")).toBe(
      false,
    );
    expect(draft(page).text()).toBe("note");
    yield* configureOpened(page);
    expect(shows(page.frame(), "(x) Fast")).toBe(false);
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
    const page = yield* useReplPage();
    page.repl.fake.configuration({ model: { selected: "model-1", choices: many }, effort: {} });
    // Opened without asserting its controls: with a list this long some of them
    // are below the window, which is what makes this window real.
    yield* page.press("sidekick:configure");
    yield* page.until("the advertised models", (one) => shows(one, "Model 1"));

    /**
     * The same questions at whichever size the pane is being drawn at.
     *
     * Each size chooses a different model, because a choice made at one size is
     * still made at the next: looking for an unselected row that an earlier
     * pass had already marked would be looking for a row this drawer is right
     * not to be drawing.
     */
    const reading = function* (choice: number): Operation<void> {
      const frame = page.frame();
      // Both of Configure's own controls, drawn in its pane and targetable
      // there: a label nothing can be aimed at is not a control.
      expect(frame.control("drawer:scroll:up")?.text).toContain("[↑ scroll up]");
      expect(frame.control("drawer:scroll:down")?.text).toContain("[↓ scroll down]");
      // And neither of the words that belong to a recorded order. Asked of the
      // pane rather than of the screen, because the sidebar's own reading is
      // drawn on the same rows and still says them.
      expect(conversationArea(frame)?.shows("[↑ earlier]")).toBe(false);
      expect(conversationArea(frame)?.shows("[↓ later]")).toBe(false);
      // The scope control keeps its own vocabulary: Sessions is a reading of
      // what happened, so Earlier and Later are the right words for it.
      expect(frame.control("sessions:earlier")?.text).toContain("[↑ earlier]");

      // And the control really scrolls: the choice below the window is reached
      // through it, and is a choice once it is there.
      const below = `drawer:configure:model:model-${choice}`;
      expect(frame.has(below)).toBe(false);
      yield* configure(page).scrollTo(below);
      yield* configure(page).chooseModel(`model-${choice}`);
      expect(shows(page.frame(), `(x) Model ${choice}`)).toBe(true);
      // Back up through the other one, to the first choice again — which also
      // leaves the window where the next size finds it.
      yield* scrollUntil(
        page,
        { window: "drawer", control: "drawer:scroll:up", toward: "less" },
        (one) => one.has("drawer:configure:model:model-1"),
      );
    };

    yield* reading(many.length);
    // The same pane at the medium profile, by a real resize rather than a
    // second program: one command owns this terminal.
    yield* page.resize(PROFILES[1]);
    yield* page.until("Configure at the medium profile", (one) => shows(one, "Model 1"));
    yield* reading(many.length - 1);
  });
});

describe("Tier SS — Sessions shows two owners, each in its own order", () => {
  it("SS1: both sections hold their own work, settled in the order each finishes", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
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

    yield* submitEntry(page, promptEntry("ask-entry"));
    yield* repl.fake.holdingTurns(1);
    yield* ask(page, "ask side");
    yield* repl.fake.streamingTurns(1);

    // One list, which is the reading the person who accepted this screen asked
    // for, holding both owners' work. The headings over blocks of rows are
    // gone, so whose work a row is is said on the row.
    const listed = yield* page.until(
      "both owners' turns in the one list",
      (one) => transcriptShows(one, "ask-entry") && transcriptShows(one, "ask side"),
    );
    expect(transcriptRows(listed).some((line) => line.includes("Entry agents"))).toBe(false);
    expect(transcriptShows(listed, "ask-entry")).toBe(true);
    expect(transcriptShows(listed, "ask side")).toBe(true);
    // The Sidekick's row says which agent answered and in which conversation —
    // never whichever agent happens to be selected. Read from the row, because
    // one list of two owners' work has no other place to say it.
    expect(transcriptShows(listed, MOUNTED_AGENT)).toBe(true);

    // The later-started turn released first. Its evaluated reply is recorded
    // while the entry's turn is still generating, so the two owners settle in
    // their own order and each section keeps its own.
    repl.fake.releaseDeltas();
    yield* page.until("the Sidekick turn being saved", (one) =>
      transcriptShows(one, "ask side · completed"),
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
    yield* page.until("the entry turn being recorded", (one) =>
      transcriptShows(one, "ask-entry · completed, recorded"),
    );

    // One stable row per turn: exactly one row in each section names its own
    // turn, before and after publication.
    const settledRows = page.frame();
    expect(transcriptCount(settledRows, "ask side")).toBe(1);
    expect(transcriptCount(settledRows, "ask-entry")).toBe(1);

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
    const page = yield* useReplPage();
    const repl = page.repl;
    // A reply that answers and reads something, so the exchange owes an
    // automatic follow-up.
    repl.fake.script({
      reply: ["<Output>First answer.</Output>", "<REPL.Bindings />", ""].join("\n"),
    });
    // That follow-up, held before its first delta: it has said nothing, it
    // will render nothing for the person, and it carries a response's results
    // rather than anything anybody typed.
    repl.fake.script({ held: true, reply: "<REPL.Bindings />\n" });

    yield* ask(page, "read it");
    // Waited for, so the loop has drawn the frame the first reply produced and
    // has nothing queued: from here the only thing that can put the follow-up
    // on the screen is the canonical boundary announcing that it began.
    yield* page.until("the first reply arriving", (one) => saidBySidekick(one, "First answer."));
    yield* repl.fake.holdingTurns(1);
    const fed = repl.terminal.fed;

    yield* page.until("the held follow-up being announced", (one) =>
      transcriptShows(one, "Automatic feedback \u00b7 generating"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // It is agent work, labelled as such: the machine input it carries is not
    // a person's words and is nowhere on the screen.
    expect(transcriptShows(page.frame(), "Automatic feedback · generating")).toBe(true);
    expect(shows(page.frame(), "REPL.Bindings")).toBe(false);

    repl.fake.releaseTurn();
    // It stays a turn. The reply rendered nothing for the person, which is work
    // rather than silence: Sessions is where that turn's own account of itself
    // is, so this row does not disappear and it shows no source.
    yield* page.until("the follow-up being saved", (one) =>
      transcriptShows(one, "Automatic feedback · completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    expect(shows(page.frame(), "REPL.Bindings")).toBe(false);
    expect(transcriptCount(page.frame(), "Automatic feedback")).toBe(1);
    expect(transcriptCount(page.frame(), "read it")).toBe(1);
  });

  it("SS7: a fresh Transcript says nothing is retained, and an unreadable chat history is refused with its reason", function* () {
    // The compatibility control: a fresh command draws one list with one
    // placeholder and no section headings, and its Sidekick is there with
    // nothing in it.
    yield* scoped(function* (): Operation<void> {
      const fresh = yield* useReplPage();
      expect(transcriptShows(fresh.frame(), "(none retained)")).toBe(true);
      for (const heading of ["Entry agents", "No entry turns", "No Sidekick turns"]) {
        expect([
          heading,
          transcriptRows(fresh.frame()).some((line) => line.includes(heading)),
        ]).toEqual([heading, false]);
      }
      expect(shows(fresh.frame(), "No messages yet.")).toBe(true);
    });

    // And a chat history this version cannot read says why, rather than
    // claiming the Sidekick has done no work: the person is told which record
    // cannot be read, and sees no empty Sidekick standing in for it.
    const host = yield* useMountedHost();
    const first = yield* useReplPage({ host });
    first.repl.fake.script({ reply: "<Output>Said once.</Output>\n" });
    yield* ask(first, "say once");
    yield* first.until("the reply", (one) => saidBySidekick(one, "Said once."));
    yield* first.until("the Sidekick at rest", sidekickIdle);
    const execution = yield* mountedExecution(first.repl);
    yield* first.press("footer:exit");
    yield* awaited("the first command leaving", () => first.repl.outcome() !== undefined);
    const history = pairPaths(host.root, execution).sidekick;
    yield* until(appendFile(history, "{not a record\n"));

    const refused = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    const frame = yield* refused.until(
      "the reason the chat history is refused",
      (one) => shows(one, "chat history holds a record this") && shows(one, "cannot read (record"),
    );
    expect(frame.has("footer:exit")).toBe(true);
    expect(frame.has("sidekick:message")).toBe(false);
    expect(shows(frame, "No messages yet.")).toBe(false);
    expect(shows(frame, "(none retained)")).toBe(false);
  });
});

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
    page: ReplPage,
    /**
     * Also leave a turn the provider failed in the older chat.
     *
     * For the row about a *current* failure arriving while that chat is being
     * read: the older chat then holds a reply and an attempt of its own, so
     * what the current one does to them is something there is to observe.
     */
    withOlderFailure = false,
  ): Operation<void> {
    const repl = page.repl;
    repl.fake.configuration({
      model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    repl.fake.script({ reply: "<Output>Older answer.</Output>\n" });
    if (withOlderFailure) {
      repl.fake.script({ reply: "<Output>Older attempt.</Output>\n", stopReason: "max_tokens" });
    }
    repl.fake.script({ reply: "<Output>Newer answer.</Output>\n" });

    yield* ask(page, "older ask");
    yield* page.until("the older chat's reply", (one) => shows(one, "Older answer."));
    yield* page.until("the Sidekick at rest", sidekickIdle);
    if (withOlderFailure) {
      yield* ask(page, "older failed");
      yield* page.until("the older chat's failed attempt", (one) =>
        transcriptShows(one, "older failed · failed"),
      );
      yield* page.until("the Sidekick at rest", sidekickIdle);
    }

    yield* startNewConversation(page);

    yield* ask(page, "newer ask");
    yield* page.until("the newer chat's reply", (one) => shows(one, "Newer answer."));
    yield* page.until("the Sidekick at rest", sidekickIdle);
  }

  it("SS4: activating an older turn opens its chat read-only, and Back comes home", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    yield* twoChats(page);

    // An unsent message, typed and left. It is the current chat's, and
    // reading an older one must not consume or lose it.
    yield* sidekick(page).composer.type("not sent yet");
    expect(sidekick(page).composer.text()).toBe("not sent yet");
    // And a selected entry, so the left surface can be shown to survive.
    const entries = (yield* mountedReading(repl)).model.entries.length;
    expect(entries).toBe(0);

    const before = repl.fake.prompts.length;
    const sessionsBefore = repl.fake.ensured.length;
    const chatBefore = (yield* mountedReading(repl)).chat.length;

    // The older turn, activated from the Sessions reading by the mounted
    // control. Nothing here reaches the owner.
    yield* page.until("the older turn being listed", (one) => transcriptShows(one, "older ask"));
    yield* chooseTurn(page, "older ask");

    // Its own chat is what is drawn: the older reply is there, the newer one
    // is not, and the agent it says answered is the one that did.
    const reading = yield* page.until("the older chat opening", (one) =>
      sidekickShows(one, "Older answer."),
    );
    expect(sidekickShows(reading, "Newer answer.")).toBe(false);
    expect(sidekickShows(reading, "[S] Older answer.")).toBe(true);

    // Read-only, and absent rather than refused: no composer, no Send, no
    // Stop, no Configure and no Retry addressing it.
    for (const key of [
      "sidekick:message",
      "sidekick:send",
      "sidekick:stop",
      "sidekick:configure",
      "sidekick:retry",
    ]) {
      expect([key, reading.has(key)]).toEqual([key, false]);
    }
    expect(sidekickShows(reading, "message the sidekick")).toBe(false);
    expect(sidekickShows(reading, "[send]")).toBe(false);
    expect(sidekickShows(reading, "[stop]")).toBe(false);
    expect(sidekickShows(reading, "[configure")).toBe(false);
    expect(sidekickShows(reading, "[retry]")).toBe(false);
    // And the way back is there, outside the scrolling transcript.
    expect(reading.has("sidekick:back")).toBe(true);
    expect(sidekickShows(reading, "[Back to current chat]")).toBe(true);

    // Selecting a reading started nothing, wrote nothing and stopped nothing.
    expect(repl.fake.prompts).toHaveLength(before);
    expect(repl.fake.ensured).toHaveLength(sessionsBefore);
    expect((yield* mountedReading(repl)).chat).toHaveLength(chatBefore);
    expect((yield* mountedReading(repl)).model.entries).toHaveLength(entries);

    // Back restores the current chat and the message that was never sent.
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) => sidekickShows(one, "Newer answer."));
    expect(sidekick(page).composer.text()).toBe("not sent yet");
    expect(page.frame().has("sidekick:send")).toBe(true);
    expect(page.frame().has("sidekick:back")).toBe(false);
    expect(sidekickShows(page.frame(), "[Back to current chat]")).toBe(false);
  });

  it("SS4: the active chat keeps its controls, and a current update leaves the reading alone", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    yield* twoChats(page);

    // A held follow-up in the *current* chat, so an update really arrives
    // while an older chat is being read.
    repl.fake.script({ held: true, reply: "<Output>Arrived later.</Output>\n" });
    yield* sidekick(page).composer.type("one more");
    yield* pressSidekickSend(page);
    yield* repl.fake.holdingTurns(1);

    // Now read the older chat.
    yield* chooseTurn(page, "older ask");
    yield* page.until("the older chat opening", (one) => sidekickShows(one, "Older answer."));

    const fed = repl.terminal.fed;
    repl.fake.releaseTurn();
    // The current chat's own reply lands. The Sessions reading says so, and
    // the chat being read is still the older one: background work never
    // retargets a chat somebody explicitly selected.
    yield* page.until("the current reply being recorded", (one) =>
      transcriptShows(one, "one more · completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    expect(sidekickShows(page.frame(), "Older answer.")).toBe(true);
    expect(sidekickShows(page.frame(), "Arrived later.")).toBe(false);
    expect(page.frame().has("sidekick:message")).toBe(false);

    // Back, and the current chat has its controls and the reply that arrived.
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) =>
      sidekickShows(one, "Arrived later."),
    );
    expect(page.frame().has("sidekick:send")).toBe(true);
    expect(page.frame().control("sidekick:configure")?.text).toBe(
      `[configure ${OTHER_MOUNTED_AGENT}]`,
    );
  });

  it("SS4: a pending question and its partial answer survive reading an older chat", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    yield* twoChats(page);

    // The current conversation asks something, and the follow-up it will owe
    // once that question is answered.
    repl.fake.script({ reply: askingReply("Approve the plan?") });
    repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    yield* ask(page, "review it");
    // The notice this screen gives: the control that opens the question, in the
    // pane that owns it.
    yield* page.until("the question announcing itself", (one) => one.has("sidekick:answer"));
    yield* page.press("sidekick:answer");
    yield* page.until(
      "the form opening",
      (one) => form(page).isOpen() && shows(one, "Approve the plan?"),
    );

    // A partial answer: the first field filled and the rest of the form not.
    yield* form(page).value("decision").type("appr");
    expect(shows(page.frame(), "decision: appr")).toBe(true);

    // Closed, which leaves the question pending and keeps what was typed. The
    // form is a modal while it is open, so this is the state somebody walks
    // away from a question in.
    yield* form(page).close();
    yield* page.until("the notice coming back", (one) => one.has("sidekick:answer"));
    expect(form(page).isOpen()).toBe(false);
    // Where the way in is, so pressing exactly there afterwards asks whether
    // anything is still a target at that cell.
    const answer = page.frame().control("sidekick:answer")?.bounds;
    if (answer === undefined) {
      throw new Error(`the question's way in is not placed. ${page.describe()}`);
    }

    // Now read a chat this Sidekick is no longer continuing.
    yield* chooseTurn(page, "older ask");
    yield* page.until("the older chat opening", (one) => sidekickShows(one, "Older answer."));

    // The question's notice, its form and every way to reach either are gone
    // from this screen — and so are the controls that would act on a chat
    // nobody may continue.
    const reading = page.frame();
    for (const absent of [
      "Approve the plan?",
      "decision: appr",
      "[submit]",
      "[answer sidekick]",
      "message the sidekick",
    ]) {
      expect([absent, shows(reading, absent)]).toEqual([absent, false]);
    }
    for (const key of ["sidekick:answer", "drawer:form:submit", "sidekick:message"]) {
      expect([key, reading.has(key)]).toEqual([key, false]);
    }
    // The controls that would act on the chat are absent from the pane that
    // reads it. Asked of that pane rather than of the screen: the entry draft
    // has a Send and a Stop of its own in a different column, and a question
    // about this chat's controls that found those would be about the wrong
    // destination.
    for (const absent of ["[send]", "[stop]"]) {
      expect([absent, sidekickShows(reading, absent)]).toEqual([absent, false]);
    }

    // And nothing is a target at the cell that control occupied: a press there
    // reaches no node, so no form opens and the reading does not move.
    page.repl.terminal.feed(`\x1b[<0;${answer.x + 1};${answer.y + 1}M`);
    yield* lingering();
    expect(form(page).isOpen()).toBe(false);
    expect(sidekickShows(page.frame(), "Older answer.")).toBe(true);
    // The exchange is still waiting: no reply was published and no second
    // question was invented by visiting.
    expect(shows(page.frame(), "Noted.")).toBe(false);

    // The one input on this screen is the ordinary draft, and typing goes
    // there. A hidden form that had taken the keys would be holding this text.
    yield* draft(page).type("my entry");
    expect(draft(page).text()).toBe("my entry");

    // Back, and the question is exactly where it was: still pending, still
    // only announced, and the deliberate draft edit is the one thing changed.
    yield* page.press("sidekick:back");
    yield* page.until("the notice coming home", (one) => one.has("sidekick:answer"));
    expect(draft(page).text()).toBe("my entry");
    expect(form(page).isOpen()).toBe(false);

    // Reopened deliberately, it is the same question holding the same partial
    // answer: visiting answered nothing, consumed nothing and replaced nothing.
    yield* page.press("sidekick:answer");
    yield* page.until("the form reopening", (one) => shows(one, "Approve the plan?"));
    expect(shows(page.frame(), "decision: appr")).toBe(true);
    expect(shows(page.frame(), "Noted.")).toBe(false);
    expect(draft(page).text()).toBe("my entry");
  });

  it("SS2: a current failure read beside an older chat leaves its items alone", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    // The older chat holds a reply *and* an attempt of its own, which are the
    // two items a current failure could reach into.
    yield* twoChats(page, true);

    // A failing turn in the current chat, held partway through so its own
    // account is live rather than saved while the older chat is being read.
    repl.fake.script({
      deltas: ["<Output>Current half.</Output>\n", "<REPL.Bindings />\n"],
      holdAfter: 1,
      stopReason: "refusal",
    });
    yield* sidekick(page).composer.type("goes wrong");
    yield* pressSidekickSend(page);
    yield* repl.fake.streamingTurns(1);

    // Read the older chat while that failure is in flight.
    yield* chooseTurn(page, "older ask");
    yield* page.until("the older chat opening", (one) => sidekickShows(one, "Older answer."));

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
    expect(sidekickShows(page.frame(), "goes wrong")).toBe(false);
    expect(sidekickShows(page.frame(), "Current half.")).toBe(false);
    expect(sidekickShows(page.frame(), "Older answer.")).toBe(true);
    // And this chat's own unfinished attempt is in it too. What the screen says
    // about an attempt the provider stopped is that it is unfinished and why:
    // the reply it had begun was never evaluated, so there is no output of it to
    // show, and the row gives the stop reason rather than inventing one. The
    // item itself is in `before` above, with an identity of its own.
    expect(sidekickShows(page.frame(), "(unfinished)")).toBe(true);
    expect(chatSays(page.frame(), "max_tokens")).toBe(true);
    // What that window is showing now, kept: the failure below is compared
    // against the reading somebody was actually looking at. The Sidekick's own
    // working state is the pane's rather than this reading's — it legitimately
    // stops saying so when the current turn ends — so it is not one of the rows
    // being compared, and the exact items are compared as records above.
    const reading = (frame: PageFrame): readonly string[] =>
      chatRows(frame).filter((line) => line !== "" && line !== "[S] working");
    const looking = reading(page.frame());

    // Let it fail for real, still reading the older chat.
    repl.fake.releaseDeltas();
    yield* page.until("the current turn failing", (one) =>
      transcriptShows(one, "goes wrong · failed"),
    );

    // The older chat's items are exactly the items they were: the current
    // failure took none of their keys, replaced none of them and dropped none.
    expect(yield* olderRows()).toEqual(before);
    // And the window is still the window: row for row, the reading somebody was
    // looking at is the reading they are still looking at.
    expect(reading(page.frame())).toEqual(looking);
    expect(sidekickShows(page.frame(), "goes wrong")).toBe(false);
    expect(sidekickShows(page.frame(), "Current half.")).toBe(false);

    // And the current chat's own account of it is there when somebody goes back.
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) => sidekickShows(one, "goes wrong"));
    // Its own account of what became of it: the provider stopped this turn, so
    // the row says that and why. The half it had begun streaming was never
    // evaluated, and this screen does not show an output nothing produced.
    expect(chatSays(page.frame(), "refusal")).toBe(true);
  });
});

describe("Tier SS — an older chat, from a frame that measures no chat", () => {
  it("SS4: a turn past the chat's window is revealed, and this screen keeps its own", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
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
      yield* ask(page, `ask-${number}`);
      // Waited for in the history rather than on the screen: a chat window
      // stays where it was put, so a reply past it is saved without being
      // drawn — which is the whole reason this chat needs revealing.
      yield* repliesSaved(repl, number);
    }

    // A real agent replacement, so the twelve-turn chat is genuinely older.
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* startNewConversation(page);
    yield* ask(page, "newer ask");
    yield* page.until("the newer reply", (one) => shows(one, "Newer answer."));
    yield* page.until("the Sidekick at rest", sidekickIdle);

    // A real entry, selected, and a partial message left in the composer. Both
    // belong to this screen and neither belongs to the chat about to be read.
    yield* submitEntry(page, promptEntry("kept-entry"));
    yield* entrySettles(page, 1, "ok");
    yield* draft(page).type("my entry");
    yield* sidekick(page).composer.type("half typed");

    // The pane put on Bindings, which is the other frame that measures no chat
    // window at all: the selection below is answered by a frame that has no
    // offset to compute, so the chat's own measurement is what places the turn.
    yield* selectPane(page, "bindings");
    expect(page.frame().has("sidekick:earlier")).toBe(false);
    expect(page.frame().has("sidekick:later")).toBe(false);

    // The Sessions reading is windowed too, so the row for the last turn is
    // reached with that section's own control rather than assumed to be drawn.
    yield* scrollUntil(
      page,
      { window: "sessions", control: "sessions:later", toward: "more" },
      (one) => transcriptRow(one, `ask-${TURNS} `) !== undefined,
    );
    expect(transcriptShows(page.frame(), `ask-${TURNS} `)).toBe(true);
    yield* chooseTurn(page, `ask-${TURNS} `);

    // The chat opens on the turn that was chosen: its own evaluated reply is on
    // the screen, and the first turn of that chat — which is what offset zero
    // shows — is not.
    const revealed = yield* page.until("the chosen turn being revealed", (one) =>
      sidekickShows(one, `ANSWER-${TURNS}`),
    );
    expect(chatRows(revealed).some((line) => /ANSWER-1\b/.test(line))).toBe(false);
    // Read-only, with the way home outside the window that moved.
    expect(revealed.has("sidekick:back")).toBe(true);
    expect(sidekickShows(revealed, "[Back to current chat]")).toBe(true);
    expect(revealed.has("sidekick:message")).toBe(false);
    expect(revealed.has("sidekick:send")).toBe(false);
    expect(revealed.has("sidekick:configure")).toBe(false);
    // And the two texts this screen owns are still exactly what was typed:
    // visiting a read-only chat consumed neither.
    expect(draft(page).text()).toBe("my entry");

    // Back, and this screen has its own again — the entry that was selected,
    // the current chat's controls and the partial message.
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) => sidekickShows(one, "Newer answer."));
    expect(sidekick(page).composer.text()).toBe("half typed");
    expect(draft(page).text()).toBe("my entry");
    expect(page.frame().control("sidekick:configure")?.text).toBe(
      `[configure ${OTHER_MOUNTED_AGENT}]`,
    );
    expect(shows(page.frame(), "kept-entry")).toBe(true);
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
  /** Sessions is windowed too, so each row is reached with its own control. */
  function* reach(page: ReplPage, label: string): Operation<void> {
    yield* scrollUntil(
      page,
      { window: "sessions", control: "sessions:earlier", toward: "less" },
      (one) => transcriptRow(one, label) !== undefined,
      60,
    );
  }

  it("ER4: a silent turn reveals the request it answered, and composes no anchor", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
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

    yield* ask(page, "run it");
    yield* repliesSaved(repl, 2);
    yield* ask(page, "say it");
    yield* repliesSaved(repl, 3);
    for (let number = 1; number <= TURNS; number += 1) {
      // Waited for in the history rather than on the screen: a chat window
      // stays where it was put, so a reply past it is saved without being drawn.
      yield* ask(page, `ask-${number}`);
      yield* repliesSaved(repl, 3 + number);
    }

    // A real agent replacement, so the chat holding those turns is genuinely an
    // older one and the reading below is of a chat this screen is not continuing.
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* startNewConversation(page);
    yield* ask(page, "newer ask");
    yield* page.until("the newer reply", (one) => shows(one, "Newer answer."));
    yield* page.until("the Sidekick at rest", sidekickIdle);

    // Both texts this screen owns, left partly typed, and a real entry selected.
    yield* submitEntry(page, promptEntry("kept-entry"));
    yield* entrySettles(page, 1, "ok");
    yield* draft(page).type("my entry");
    yield* sidekick(page).composer.type("half typed");

    // The turn whose own reply said nothing. Its Sessions row is a completed
    // turn, which is what it is.
    yield* reach(page, "run it · completed");
    expect(transcriptShows(page.frame(), "run it · completed")).toBe(true);
    yield* chooseTurn(page, "run it ");
    const opened = yield* page.until("the request that turn answered", (one) =>
      sidekickShows(one, "[U] run it"),
    );
    // The window moved to it. An older chat left to itself follows its newest
    // rows, so the newest reply being absent is what says this one was placed.
    expect(sidekickShows(opened, "ANSWER-10")).toBe(false);
    // And nothing was composed to land on. The next row is the next request:
    // no empty row, no bare agent name and no sentence about the absence stands
    // between the two turns whose replies said nothing.
    // Asked of the rows that say something. A blank row between items is this
    // chat's own separator and stands between every pair of them, so counting
    // it would be counting the chat's spacing as composed content.
    const said = chatRows(page.frame()).filter((line) => line !== "");
    expect(rowIndex(said, "[U] say it")).toBe(rowIndex(said, "[U] run it") + 1);
    expect(sidekickShows(page.frame(), "answered without saying")).toBe(false);
    expect(sidekickShows(page.frame(), "Nothing to add.")).toBe(false);
    // The chat being read is the one that holds that turn, and not the chat
    // this screen is continuing.
    expect(sidekickShows(page.frame(), "Newer answer.")).toBe(false);
    expect(page.frame().has("sidekick:back")).toBe(true);
    expect(draft(page).text()).toBe("my entry");

    // Back, and then the automatic follow-up: its own reply said nothing too,
    // and the request its chain began with is a person's, not the machine input
    // it carried.
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) => sidekickShows(one, "Newer answer."));
    yield* reach(page, "Automatic fee");
    yield* chooseTurn(page, "Automatic fee");
    yield* page.until("the request that chain began with", (one) =>
      sidekickShows(one, "[U] run it"),
    );
    expect(sidekickShows(page.frame(), "ANSWER-10")).toBe(false);
    expect(sidekickShows(page.frame(), "answered without saying")).toBe(false);

    // And the control: a turn that did say something is revealed at its own
    // Output, which is still the first thing a reveal prefers.
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) => sidekickShows(one, "Newer answer."));
    yield* reach(page, "say it · completed");
    yield* chooseTurn(page, "say it ");
    yield* page.until("that turn's own Output", (one) => sidekickShows(one, "SPOKE-ALOUD"));

    // Every turn is still in Sessions with its own title and status, and both
    // texts this screen owns are still exactly what was typed.
    const sessions = page.frame();
    expect(transcriptShows(sessions, "run it · completed")).toBe(true);
    expect(transcriptShows(sessions, "Automatic feedback · completed")).toBe(true);
    expect(transcriptShows(sessions, "say it · completed")).toBe(true);
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) => sidekickShows(one, "Newer answer."));
    expect(draft(page).text()).toBe("my entry");
    expect(sidekick(page).composer.text()).toBe("half typed");
    expect(shows(page.frame(), "kept-entry")).toBe(true);
  });

  it("ER5: the same chat reopened cold makes the same decisions, and costs nothing", function* () {
    const host = yield* useMountedHost();
    const first = yield* useReplPage({ host });
    // The three exchanges this correction is about, in one history: a reply
    // that ran a control and said nothing, with the automatic follow-up
    // carrying its result saying nothing either; a reply that failed with no
    // Output, and the correction it was given; and one that spoke.
    first.repl.fake.script({ reply: "<REPL.Bindings />\n" });
    first.repl.fake.script({ reply: "Nothing to add.\n" });
    first.repl.fake.script({ reply: "<REPL.Delete />\n" });
    first.repl.fake.script({ reply: "<Output>Fixed it.</Output>\n" });
    first.repl.fake.script({ reply: "<Output>SPOKE-ALOUD</Output>\n" });
    // And enough ordinary turns after them to fill the chat's window, so the
    // three above are reached cold by selecting them rather than by being
    // drawn wherever the reopened window happened to land.
    const TURNS = 8;
    for (let number = 1; number <= TURNS; number += 1) {
      first.repl.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
    }

    yield* ask(first, "run it");
    yield* repliesSaved(first.repl, 2);
    yield* ask(first, "break it");
    yield* repliesSaved(first.repl, 4);
    yield* ask(first, "say it");
    yield* repliesSaved(first.repl, 5);
    for (let number = 1; number <= TURNS; number += 1) {
      yield* ask(first, `ask-${number}`);
      yield* repliesSaved(first.repl, 5 + number);
    }
    const execution = yield* mountedExecution(first.repl);
    // What this host's provider was asked for by the command that really ran.
    // The reopen below shares the same fake, so what it must add is nothing.
    const asked = first.repl.fake.prompts.length;
    const opened = first.repl.fake.ensured.length;
    yield* first.press("footer:exit");
    yield* awaited("the first command returning", () => first.repl.outcome() !== undefined);
    const written = yield* until(readFile(pairPaths(host.root, execution).sidekick, "utf8"));

    // The same history, opened cold by another command.
    const again = yield* useReplPage({
      host,
      location: `xmd://repl/${execution}/entries`,
    });
    yield* again.until("the reopened chat", (one) => sidekickShows(one, "ANSWER-8"));

    // The failure is still a failure, with the reason this history holds — read
    // from the record rather than from anything a live process remembered.
    yield* reach(again, "break it ");
    yield* chooseTurn(again, "break it ");
    yield* again.until("the recorded failure", (one) =>
      sidekickShows(one, `${MOUNTED_AGENT} (failed):`),
    );
    // Its own recorded reason, in the words the record holds, and not a status
    // this screen composed. Read as the prefix that fits: a reveal lands its
    // row at the foot of the window, so the rest of a wrapped reason is below
    // it rather than missing.
    expect(sidekickShows(again.frame(), "(failed): a generated fragment")).toBe(true);
    // The turn that spoke still speaks.
    yield* reach(again, "say it ");
    yield* chooseTurn(again, "say it ");
    yield* again.until("that turn's own Output", (one) => sidekickShows(one, "SPOKE-ALOUD"));
    // And the two silent replies are still absent, with the request they
    // answered still what their selection reveals.
    yield* reach(again, "run it · completed");
    yield* chooseTurn(again, "run it ");
    yield* again.until("the request that turn answered", (one) => sidekickShows(one, "[U] run it"));
    expect(sidekickShows(again.frame(), "ANSWER-8")).toBe(false);
    yield* reach(again, "Automatic fee");
    yield* chooseTurn(again, "Automatic fee");
    yield* again.until("the request that chain began with", (one) =>
      sidekickShows(one, "[U] run it"),
    );
    expect(sidekickShows(again.frame(), "ANSWER-8")).toBe(false);
    expect(sidekickShows(again.frame(), "answered without saying")).toBe(false);
    expect(sidekickShows(again.frame(), "Nothing to add.")).toBe(false);
    expect(sidekickShows(again.frame(), "REPL.Bindings")).toBe(false);

    // Reading it cost nothing: no turn, no session, not one byte.
    expect(again.repl.fake.prompts).toHaveLength(asked);
    expect(again.repl.fake.ensured).toHaveLength(opened);
    expect(yield* until(readFile(pairPaths(host.root, execution).sidekick, "utf8"))).toBe(written);
  });
});

describe("Tier SS — a real gap, and a turn nothing answered", () => {
  it("SS6: an interrupted first message leaves every later row its own identity", function* () {
    const host = yield* useMountedHost();
    let page = yield* useReplPage({ host });
    let repl = page.repl;
    // The accepted divergence, produced the way it really happens: a first
    // message whose generation is stopped, so this history's own response
    // ordinals run ahead of Core's turn numbers from then on.
    repl.fake.script({ reply: "<Output>Unrecorded.</Output>\n", held: true });
    yield* ask(page, "unrecorded");
    yield* repl.fake.holdingTurns(1);
    yield* page.until("the held first generation", (one) => one.has("sidekick:stop"));
    yield* sidekick(page).stop();
    yield* page.until("Stop finishing", sidekickIdle);
    const execution = yield* mountedExecution(repl);
    yield* page.press("footer:exit");
    yield* awaited("the first command closing", () => repl.outcome() !== undefined);

    // A second process over the same files: a reply that is saved, then a turn
    // the provider does not finish.
    page = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    repl = page.repl;
    repl.fake.script({ reply: "<Output>Saved reply.</Output>\n" });
    yield* ask(page, "saved ask");
    yield* page.until("the saved reply", (one) => saidBySidekick(one, `Saved reply.`));
    repl.fake.script({ reply: "<Output>Half said.</Output>\n", stopReason: "max_tokens" });
    yield* ask(page, "failed ask");
    yield* page.until("the failed turn being accounted for", (one) =>
      transcriptShows(one, "failed ask · failed"),
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
    expect(transcriptCount(page.frame(), "saved ask ")).toBe(1);
    expect(transcriptCount(page.frame(), "failed ask ")).toBe(1);
  });

  it("SS6: a real automatic turn nobody answered opens as its own inert anchor", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss6-anchor-");
    const gate = appendGate();
    let execution = "";

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot, gate });
      const page = yield* useReplPage({ host });
      const repl = page.repl;
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
      yield* ask(page, "read it");
      yield* answered.started();
      execution = yield* mountedExecution(repl);
      // And the process ends with that record never written: the provider
      // finished its turn, its canonical record is saved, and nothing says the
      // program it returned was ever run.
    });

    // Cold, over those files.
    const cold = yield* useMountedHost({ dataRoot });
    const reopened = yield* useReplPage({
      host: cold,
      location: `xmd://repl/${execution}/sessions`,
    });
    // The Sessions row says what became of it, as far as a 32-column section
    // holds the sentence; the whole of it is in the chat below.
    yield* reopened.until("the automatic turn's saved status", (one) =>
      transcriptShows(one, "Automatic feedback · Turn"),
    );
    // Its machine input is nowhere: a response's own results are not chat.
    expect(shows(reopened.frame(), "REPL.Bindings")).toBe(false);

    // Selected, it opens the chat on its own inert anchor rather than on a
    // reply nobody recorded or on nothing at all.
    yield* chooseTurn(reopened, "Automatic feedback");
    yield* reopened.until("the inert anchor in the chat", (one) =>
      sidekickShows(one, "Automatic feedback · Turn saved"),
    );
    // The whole status, as the pane pays it out over the rows it has.
    //
    // Re-anchored for #883's chat fitting. This asserted two rows, the second
    // of them carrying the sentence's whole tail — which is what an unfitted
    // row produced by overflowing into the row beneath it. The pane now cuts
    // the sentence at its own word boundaries against the width it measured,
    // so a sentence this wide is three rows. The status is unchanged and is read
    // the way the rows actually hold it: consecutive rows of the anchor whose
    // text, rejoined, is exactly the status.
    // Without the mark that says who said it. That mark is this pane's own
    // attribution rather than a word of the sentence — asserted on its own
    // below, because an anchor nobody is said to have written is a different
    // fact from this one.
    const anchor = chatRows(reopened.frame()).map((row) =>
      row.replace(/^\s*\[[US]\]\s/, "").trim(),
    );
    const opens = rowIndex(anchor, "Automatic feedback");
    expect(opens).toBeGreaterThanOrEqual(0);
    expect(saidBySidekick(reopened.frame(), "Automatic feedback")).toBe(true);
    expect(
      anchor
        .slice(opens, opens + 3)
        .join(" ")
        .trim(),
    ).toBe(`Automatic feedback · ${SAVED_WITHOUT_REPLY}`);
    expect(SAVED_WITHOUT_REPLY).toBe("Turn saved; no evaluated reply recorded.");
    expect(sidekickShows(reopened.frame(), "First answer.")).toBe(true);
    expect(shows(reopened.frame(), "REPL.Bindings")).toBe(false);
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

  it("SS5: the same older chat is selected read-only, with no provider work and no writes", function* () {
    const dataRoot = yield* useTemporary("xmd-repl-ss5-");
    let copied = "";
    let execution = "";
    let root = "";
    let before: { entries: string; sidekick: string } | undefined;

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      root = host.root;
      const page = yield* useReplPage({ host });
      const repl = page.repl;
      repl.fake.configuration({
        model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
        effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
      });
      repl.fake.script({ reply: "<Output>Older answer.</Output>\n" });
      repl.fake.script({ reply: "<Output>Newer answer.</Output>\n" });

      yield* ask(page, "older ask");
      yield* page.until("the older reply", (one) => shows(one, "Older answer."));
      yield* page.until("the Sidekick at rest", sidekickIdle);
      yield* startNewConversation(page);
      yield* ask(page, "newer ask");
      yield* page.until("the newer reply", (one) => shows(one, "Newer answer."));
      yield* page.until("the Sidekick at rest", sidekickIdle);

      // The older chat, opened from its own Sessions row, and the location
      // that view ends at.
      yield* chooseTurn(page, "older ask");
      yield* page.until("the older chat opening", (one) => sidekickShows(one, "Older answer."));
      execution = yield* mountedExecution(repl);
      before = yield* pairBytes(host.root, execution);
      copied = yield* leaving(page);
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
    const reopened = yield* useReplPage({ host: second, location: copied });

    // The same older chat is what it is reading, read-only.
    const reading = yield* reopened.until("the older chat", (one) =>
      sidekickShows(one, "Older answer."),
    );
    expect(sidekickShows(reading, "Newer answer.")).toBe(false);
    expect(reading.has("sidekick:message")).toBe(false);
    expect(reading.has("sidekick:send")).toBe(false);
    expect(sidekickShows(reading, "message the sidekick")).toBe(false);
    expect(sidekickShows(reading, "[send]")).toBe(false);
    expect(reading.has("sidekick:back")).toBe(true);
    expect(sidekickShows(reading, "[Back to current chat]")).toBe(true);

    // And it asked nobody anything: no runtime, no session, no prompt. Pure
    // reading is what reopening a chat is.
    expect(second.fake.created).toEqual([]);
    expect(second.fake.ensured).toEqual([]);
    expect(second.fake.prompts).toEqual([]);
    // Both files are byte-identical: reading appends nothing.
    expect(yield* pairBytes(root, execution)).toEqual(before);

    // Back works, and the current association is the one the history holds —
    // the chat the replacement opened, not the one that was being read.
    yield* reopened.press("sidekick:back");
    yield* reopened.until("the current chat coming back", (one) =>
      sidekickShows(one, "Newer answer."),
    );
    expect(reopened.frame().control("sidekick:configure")?.text).toBe(
      `[configure ${OTHER_MOUNTED_AGENT}]`,
    );
    expect(yield* pairBytes(root, execution)).toEqual(before);
  });

  it("SS5: selecting another surface and coming back does not forget the pinned chat", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "<Output>Only answer.</Output>\n" });
    yield* ask(page, "only ask");
    yield* page.until("the reply", (one) => shows(one, "Only answer."));
    yield* page.until("the Sidekick at rest", sidekickIdle);

    // Explicitly selecting the chat that is also the current one: it keeps its
    // usual controls, because it *is* the active association.
    yield* chooseTurn(page, "only ask");
    yield* page.until("the selector standing", (one) => one.has("sidekick:back"));
    expect(page.frame().has("sidekick:message")).toBe(true);
    expect(page.frame().has("sidekick:send")).toBe(true);

    // Bindings, and back. The selection is kept for returning to.
    yield* selectPane(page, "bindings");
    yield* selectPane(page, "sidekick");
    yield* page.until("the chat coming back", (one) => sidekickShows(one, "Only answer."));
    expect(page.frame().has("sidekick:back")).toBe(true);

    // And the Entries catalog, and back. Entries opens a drawer over the
    // reading rather than routing to a column of its own, so it is put away
    // before the pane beneath it is reached for — a modal owns the keyboard
    // while it is up, and Tab through one would be Tab through a modal.
    yield* openCatalog(page);
    yield* closeCatalog(page);
    yield* selectPane(page, "sidekick");
    yield* page.until("the chat coming back again", (one) => sidekickShows(one, "Only answer."));
    expect(page.frame().has("sidekick:back")).toBe(true);
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
      const page = yield* useReplPage({ host });
      const repl = page.repl;
      repl.fake.configuration({
        model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
        effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
      });
      repl.fake.script({ reply: "<Output>The only answer.</Output>\n" });
      // The replacement agent cannot be started here, so its setup really
      // fails: the association before it is preserved and the chat it opened
      // is left on disk as the failure it was.
      repl.fake.unavailable(OTHER_MOUNTED_AGENT, new Error("that agent will not start here"));

      yield* ask(page, "only ask");
      yield* page.until("the reply", (one) => shows(one, "The only answer."));
      yield* page.until("the Sidekick at rest", sidekickIdle);
      yield* configure(page).open();
      yield* configure(page).agent.replace(OTHER_MOUNTED_AGENT);
      yield* page.until("the replacement control", (one) => shows(one, "[start new conversation]"));
      yield* configure(page).apply();
      yield* page.until("the reason the replacement gave", (one) => shows(one, "will not start"));
      execution = yield* mountedExecution(repl);
      before = yield* pairBytes(host.root, execution);
      yield* page.press("footer:exit");
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
    const reopened = yield* useReplPage({
      host: cold,
      location:
        `xmd://repl/${execution}/sessions?view=sidekick&right=sidekick` +
        `&sidekick=${encodeURIComponent(failed)}`,
    });

    // It opens, and what it says is that chat's own setup status with the
    // agent's own reason — not an absence of messages, and not the current
    // chat's conversation.
    const reading = yield* reopened.until("the failed chat's own status", (one) =>
      sidekickShows(one, "Setup failed:"),
    );
    // The agent's own words, as far as a pane this wide holds them: the whole
    // reason is established from the record above, and this is the screen
    // carrying it rather than a sentence of this product's own.
    expect(sidekickShows(reading, "Setup failed: that agent will")).toBe(true);
    expect(sidekickShows(reading, "The only answer.")).toBe(false);
    // Read-only, like every chat that is not the active association.
    expect(reading.has("sidekick:message")).toBe(false);
    expect(reading.has("sidekick:send")).toBe(false);
    expect(sidekickShows(reading, "message the sidekick")).toBe(false);
    expect(sidekickShows(reading, "[send]")).toBe(false);
    expect(reading.has("sidekick:back")).toBe(true);
    expect(sidekickShows(reading, "[Back to current chat]")).toBe(true);

    // And reading it ran nothing and wrote nothing.
    expect(cold.fake.created).toEqual([]);
    expect(cold.fake.ensured).toEqual([]);
    expect(cold.fake.prompts).toEqual([]);
    expect(yield* pairBytes(root, execution)).toEqual(before);

    // Back comes home to the association the failed replacement preserved.
    yield* reopened.press("sidekick:back");
    yield* reopened.until("the preserved chat coming back", (one) =>
      sidekickShows(one, "The only answer."),
    );
    expect(reopened.frame().control("sidekick:configure")?.text).toBe(
      `[configure ${MOUNTED_AGENT}]`,
    );
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
      const page = yield* useReplPage({ host });
      const repl = page.repl;
      repl.fake.script({ reply: "<Output>Chat answer.</Output>\n" });
      // The entry's own turn, held: the entry is running and waiting on this
      // provider when the process below it goes away.
      repl.fake.script({ held: true, reply: "ENTRY-NEVER" });

      yield* ask(page, "chat ask");
      yield* page.until("the chat reply", (one) => shows(one, "Chat answer."));
      yield* submitEntry(page, promptEntry("unfinished-entry"));
      // The barrier: the entry really is asking, so it is genuinely unfinished
      // rather than waiting to start.
      yield* repl.fake.holdingTurns(1);
      execution = yield* mountedExecution(repl);
      // And the process ends here, with that entry still in flight. Nothing is
      // pressed: leaving cleanly is what the row above does.
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
    const opened = yield* useReplPage({
      host: cold,
      location: `xmd://repl/${execution}/entries?view=sidekick`,
    });
    yield* opened.until("the chat this execution really holds", (one) =>
      shows(one, "Chat answer."),
    );
    expect(opened.repl.outcome()).toBe(undefined);
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
      const page = yield* useReplPage({ host });
      const repl = page.repl;
      repl.fake.script({ reply: "<Output>Only answer.</Output>\n" });
      yield* ask(page, "only ask");
      yield* page.until("the reply", (one) => shows(one, "Only answer."));
      yield* submitEntry(page, TWO_STEP_ENTRY);
      yield* entrySettles(page, 1, "ok");
      execution = yield* mountedExecution(repl);
      before = yield* pairBytes(host.root, execution);
      yield* page.press("footer:exit");
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
    const page = yield* useReplPage({ host, location });
    // The refusal screen offers a way out and no draft, which is what says it
    // is the refusal rather than a reading.
    yield* page.until(
      `the refusal screen for ${location}`,
      (one) => one.has("footer:exit") && !one.has("footer:input"),
    );
    yield* page.key("Escape");
    yield* awaited("the refused command returning", () => page.repl.outcome() !== undefined);
    const settledOutcome = page.repl.outcome();
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
    const page = yield* useReplPage({ host });
    const repl = page.repl;
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
    yield* ask(page, "stop me");
    yield* appending.started();
    expect(observed).not.toBe("");
    expect(appending.holding).toBe(true);

    // The key is offered and chosen while the turn is still unsaved.
    yield* openFilter(page);
    yield* page.until("the live turn's conversation being offered", (one) =>
      transcriptRows(one).some((line) => line.includes("xmd:v1:")),
    );
    const offered = transcriptRow(page.frame(), "xmd:v1:");
    if (offered === undefined) {
      throw new Error(`no conversation was offered. ${page.describe()}`);
    }
    yield* page.press(offered);
    yield* page.until("the filter being applied", (one) => filteredTo(one, observed));

    if (stopped) {
      // Stop, with that append's own operation still suspended. This is the
      // boundary: the provider answered, the publication named its
      // conversation, and the record that would have made the turn saved is
      // one this process is now taking back rather than one it will write.
      yield* sidekick(page).stop();
      yield* page.until("the Sidekick going idle", sidekickIdle);
      // The operation came down without appending, and nothing is holding any
      // more: Stop joined it rather than leaving a write scheduled.
      yield* awaited("the held append's operation coming down", () => appending.abandoned);
      expect(appending.holding).toBe(false);
    } else {
      appending.release();
      yield* page.until("the turn being saved", (one) =>
        transcriptShows(one, "stop me · completed"),
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
    expect(filteredTo(page.frame(), observed)).toBe(true);
    expect(transcriptRows(page.frame()).some((line) => line.includes("xmd:v1:"))).toBe(true);

    execution = yield* mountedExecution(repl);
    yield* page.press("footer:exit");
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
    const reopened = yield* useReplPage({ host: cold, location });
    yield* reopened.until("the saved conversation filtering cold", (one) =>
      filteredTo(one, observed),
    );
  }
  expect(cold.fake.created).toEqual([]);
  expect(cold.fake.prompts).toEqual([]);
}

describe("Tier SS — the filter both sections share", () => {
  it("SS3: each owner's provider key is one choice of its own, and filters to that owner's row", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    // An entry turn and a Sidekick turn, each in a provider conversation of its
    // own. A turn the adapter names, so the Sidekick's completion carries a
    // checkpoint and its publication association really names a conversation.
    repl.fake.script({ reply: "ENTRY-REPLY" });
    repl.fake.script({ reply: "<Output>Shared answer.</Output>\n", turnId: "sk-turn-1" });

    yield* submitEntry(page, promptEntry("entry-ask"));
    yield* page.until("the entry turn being recorded", (one) =>
      transcriptShows(one, "entry-ask · completed, recorded"),
    );
    yield* ask(page, "chat ask");
    yield* page.until("the chat turn being saved", (one) =>
      transcriptShows(one, "chat ask · completed"),
    );
    yield* page.until("the Sidekick at rest", sidekickIdle);

    // Unfiltered: each key is offered once, however many rows used it. Two
    // controls for one conversation would be two ways to choose the same thing.
    yield* openFilter(page);
    const choices = page
      .frame()
      .keys()
      .filter((key) => key.startsWith("sessions:conversation:"));
    expect(choices).toHaveLength(2);
    expect(new Set(choices).size).toBe(2);

    // Chosen: the rows of the owner that used that conversation stay, and the
    // other owner's row, which used a different one, goes.
    const prefix = "sessions:conversation:";
    const [entryChoice, chatChoice] = choices;
    yield* page.press(entryChoice);
    yield* page.until(
      "the chooser closing behind the entry's conversation",
      (one) => !one.has("sessions:all"),
    );
    expect(filteredTo(page.frame(), entryChoice.slice(prefix.length))).toBe(true);
    expect(transcriptShows(page.frame(), "entry-ask")).toBe(true);
    expect(transcriptRows(page.frame()).some((line) => line.includes("chat ask"))).toBe(false);

    yield* openFilter(page);
    yield* page.press(chatChoice);
    yield* page.until(
      "the chooser closing behind the chat's conversation",
      (one) => !one.has("sessions:all"),
    );
    expect(filteredTo(page.frame(), chatChoice.slice(prefix.length))).toBe(true);
    expect(transcriptShows(page.frame(), "chat ask")).toBe(true);
    expect(transcriptRows(page.frame()).some((line) => line.includes("entry-ask"))).toBe(false);

    // Both rows come back when the filter is cleared.
    yield* openFilter(page);
    yield* page.press("sessions:all");
    yield* page.until(
      "both owners' rows",
      (one) => transcriptShows(one, "entry-ask") && transcriptShows(one, "chat ask"),
    );
  });

  it("SS3: a live key filters its own unsaved row, and survives the cycle ending", function* () {
    const gate = appendGate();
    const host = yield* useMountedHost({ gate });
    const page = yield* useReplPage({ host });
    const repl = page.repl;
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
    yield* routeToSidekick(page);
    yield* sidekick(page).composer.type("say it");
    yield* pressSidekickSend(page);
    yield* appended.started();

    // The key its own publication named is offered as a filter, and the live
    // row it belongs to is shown under it — while that row is still unsaved.
    yield* openFilter(page);
    const offered = transcriptRow(page.frame(), "xmd:v1:");
    if (offered === undefined) {
      throw new Error(`no conversation was offered. ${page.describe()}`);
    }
    // The row's own text is the key's headline, shortened to the column it is
    // drawn in; the key itself is what the selector names afterwards.
    const named = /xmd:v1:[0-9a-f:]+/.exec(page.frame().control(offered)?.text ?? "")?.[0] ?? "";
    expect(named).not.toBe("");
    yield* page.press(offered);
    yield* page.until("the filter being applied", (one) => filteredTo(one, named));
    // The turn is still there under it: a key an exact publication established
    // is membership for its own live row, acknowledged or not.
    expect(transcriptShows(page.frame(), "say it")).toBe(true);
    // And nothing is saved: the append is still in flight.
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["say it"]);

    // The append let go so the cycle can come down, and then Stop. What this
    // row is about is the filter surviving that; the boundary *before* the
    // append is acknowledged has its own paired row above, where the hold is
    // the operation rather than the Promise the host was handed.
    appended.release();
    yield* sidekick(page).stop();
    yield* page.until("the Sidekick going idle", sidekickIdle);

    // The filter the person selected is still a filter — the key was genuinely
    // observed, so it does not become guessed emptiness — and the conversation
    // is still offered.
    expect(filteredTo(page.frame(), named)).toBe(true);
    expect(transcriptRows(page.frame()).some((line) => line.includes("xmd:v1:"))).toBe(true);
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
      const page = yield* useReplPage({ host });
      const repl = page.repl;
      repl.fake.script({ reply: "ENTRY-REPLY" });
      repl.fake.script({ reply: "<Output>Chat answer.</Output>\n" });

      // One entry with no Agent work of its own, which settles and leaves a
      // recorded checkpoint behind it.
      yield* submitEntry(page, TWO_STEP_ENTRY);
      yield* entrySettles(page, 1, "ok");
      const first = yield* mountedReading(repl);
      marker = first.model.checkpoints[first.model.checkpoints.length - 1]?.marker ?? "";
      expect(marker).not.toBe("");

      // Then an entry whose own Prompt opens a provider conversation, and a
      // Sidekick turn in a chat of its own. Both happen entirely after that
      // checkpoint.
      yield* submitEntry(page, promptEntry("later-entry"));
      yield* page.until("the second entry's turn being recorded", (one) =>
        transcriptShows(one, "later-entry · completed, recorded"),
      );
      yield* ask(page, "chat ask");
      yield* page.until("the chat reply", (one) => shows(one, "Chat answer."));
      yield* page.until("the Sidekick at rest", sidekickIdle);

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

      yield* page.press("footer:exit");
      yield* awaited("the command leaving", () => repl.outcome() !== undefined);
    });

    const cold = yield* useMountedHost({ dataRoot });
    // The Sidekick's own key, beside a checkpoint that precedes its
    // conversation entirely. It resolves, because freezing a prefix freezes
    // *entry* facts and a chat has no position in that history.
    const reopened = yield* useReplPage({
      host: cold,
      location:
        `xmd://repl/${execution}/sessions?at=${encodeURIComponent(marker)}` +
        `&inspect&session=${encodeURIComponent(chatKey)}`,
    });
    yield* reopened.until("the chat's key filtering", (one) => filteredTo(one, chatKey));
    expect(transcriptShows(reopened.frame(), "chat ask")).toBe(true);
    // The entry prefix really is frozen there: the entry whose turn carries
    // the other key was admitted after this position, so it is not in the
    // reading at all.
    expect(transcriptRows(reopened.frame()).some((line) => line.includes("later-"))).toBe(false);

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
    const page = yield* useReplPage();
    const repl = page.repl;
    // One turn whose pieces this case steps through, so each boundary in the
    // transport is one the screen is read at.
    repl.fake.script({
      deltas: ["<Output>Half", " said.</Output>\n"],
      holdsEachPiece: true,
    });

    yield* routeToSidekick(page);
    yield* sidekick(page).composer.type("hold it");
    yield* pressSidekickSend(page);
    yield* repl.fake.streamingTurns(1);

    // From here nothing is typed, clicked or submitted, and this is what says
    // so: a fact about the screen moving on its own is only one if no
    // keystroke could have caused it.
    const fed = repl.terminal.fed;
    yield* page.until("the turn being announced", (one) =>
      transcriptShows(one, "hold it · generating"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // It is announced with no Output of its own: the row exists because the
    // turn does, and this is the phase it is in rather than a reply.
    expect(transcriptShows(page.frame(), "hold it · generating")).toBe(true);
    // And the message box is empty, which is the second material fact: the
    // text was taken by the turn that is now running, and nothing was pressed
    // to clear it.
    yield* page.until("the message box taken", () => sidekick(page).composer.text() === "");

    repl.fake.releaseDeltas();
    yield* page.until("the saved turn and its reply arriving", (one) =>
      transcriptShows(one, "hold it · completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    expect(saidBySidekick(page.frame(), `Half said.`)).toBe(true);
  });

  it("SS7: a saved Prompt and a reply still being evaluated are two facts, unpressed", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
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

    yield* ask(page, "evaluate it");
    yield* repl.fake.holdingTurns(1);

    // From here nothing is typed or clicked.
    const fed = repl.terminal.fed;
    yield* page.until("the reply being evaluated", (one) =>
      transcriptShows(one, "evaluate it · evaluating the reply"),
    );
    expect(repl.terminal.fed).toBe(fed);

    // The provider's turn really is saved, and no reply has been published
    // against it: the two facts the row is separating are both on disk.
    const saved = yield* mountedReading(repl);
    expect(
      saved.chat.filter(
        // Narrowed by the discriminant the record already carries.
        (record) => record.kind === "event" && record.event.includes("agent_prompt"),
      ),
    ).toHaveLength(1);
    expect(saved.chat.some((record) => record.kind === "response")).toBe(false);

    repl.fake.releaseTurn();
    yield* page.until("the reply settling under the same row", (one) =>
      transcriptShows(one, "evaluate it · completed"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // One row for that turn throughout: the outcome replaced what it says.
    expect(transcriptCount(page.frame(), "evaluate it")).toBe(1);
  });

  it("SS7: control — an ordinary entry turn reaches the Sessions reading the same way", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "ENTRY-REPLY" });

    yield* submitEntry(page, promptEntry("control-ask"));
    const fed = page.repl.terminal.fed;
    yield* page.until("the entry turn being recorded with no keystroke", (one) =>
      transcriptShows(one, "control-ask · completed, recorded"),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    // One list, and this turn is the entry's own: the row says whose work it is
    // and which conversation it was in, which is where that fact lives now —
    // the headings over blocks of rows were taken away deliberately. Nothing of
    // the Sidekick's is in it, because the Sidekick has done none.
    const listed = page.frame();
    expect(transcriptRows(listed).some((line) => line.includes("Entry agents"))).toBe(false);
    expect(transcriptShows(listed, MOUNTED_AGENT)).toBe(true);
    expect(transcriptCount(listed, "control-ask")).toBe(1);
  });

  it("SS7: three profiles keep a populated older reading, its window and the way home", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
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
      yield* ask(page, `old-${number}`);
      yield* repliesSaved(repl, number);
    }

    // A real replacement, so the populated chat is a nonactive one.
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* startNewConversation(page);
    yield* ask(page, "current ask");
    yield* page.until("the current reply", (one) => shows(one, "Current answer."));
    yield* page.until("the Sidekick at rest", sidekickIdle);

    yield* draft(page).type("my entry");
    yield* sidekick(page).composer.type("my q");

    // The last turn of the populated older chat, reached through the Sessions
    // section's own window control and then activated.
    yield* scrollUntil(
      page,
      { window: "sessions", control: "sessions:later", toward: "more" },
      (one) => transcriptRow(one, `old-${TURNS} `) !== undefined,
    );
    yield* chooseTurn(page, `old-${TURNS} `);
    yield* page.until("the older chat opening on that turn", (one) =>
      sidekickShows(one, `OLD-${TURNS}`),
    );

    for (const size of PROFILES) {
      const rows = yield* frameAt(page, size);
      // The way out is in the footer at every size. How many rows a footer takes
      // is the composition's business, and this one says what it has to say in
      // one compact History row and one of directions below it.
      expect(rows.area("box:footer")?.contains("footer:exit")).toBe(true);
      // The chat being read is the older one, opened at the turn that was
      // chosen — the window is placed on it rather than left at whichever end
      // it happened to be — and the way home is reachable at every size.
      const pane = conversationArea(rows);
      expect(pane?.shows(`OLD-${TURNS}`)).toBe(true);
      expect(pane?.shows("[Back to current chat]")).toBe(true);
      expect(rows.has("sidekick:back")).toBe(true);
      // Read-only: no composer, no Send and no Configure for a chat nobody may
      // continue — and so the partial message is not drawn either. Asked of
      // that pane rather than of the screen: the entry draft has a Send of its
      // own in a different column, and a question about this chat's controls
      // that found that one would answer about the wrong destination.
      expect(pane?.shows("[send]")).toBe(false);
      expect(rows.has("sidekick:send")).toBe(false);
      expect(rows.has("sidekick:message")).toBe(false);
      expect(rows.has("sidekick:configure")).toBe(false);
      expect(shows(rows, "[configure ")).toBe(false);
      if (size.columns >= 120) {
        // The one Transcript list, the pane's own tab, and both window
        // controls, where the frame has columns for them. Whose work a row is
        // is said on the row — the headings over blocks of them are gone.
        expect(shows(rows, "Entry agents")).toBe(false);
        expect(shows(rows, "TRANSCRIPT")).toBe(true);
        expect(rows.has("tab:sidekick")).toBe(true);
        expect(rows.has("sidekick:earlier")).toBe(true);
        expect(rows.has("sidekick:later")).toBe(true);
        // The entry draft is this screen's and is drawn beside this reading.
        expect(draft(page).text()).toContain("my entry");
        continue;
      }
      // A narrow frame routes one outlet and this route is reading the chat, so
      // the draft is in no cell of it. It is read where it is drawn, which is
      // what the widest size above has already done.
      expect(rows.has("footer:input")).toBe(false);
    }

    // Home again, at the widest size: the current chat, its controls and the
    // partial message this screen was holding all the way through.
    yield* frameAt(page, PROFILES[0]);
    yield* page.press("sidekick:back");
    yield* page.until("the current chat coming back", (one) =>
      sidekickShows(one, "Current answer."),
    );
    expect(sidekick(page).composer.text()).toBe("my q");
    expect(draft(page).text()).toBe("my entry");
  });

  it("SS7: three profiles keep both sections, the window, Back and both texts", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "<Output>Older answer.</Output>\n" });
    yield* ask(page, "older ask");
    yield* page.until("the reply", (one) => shows(one, "Older answer."));
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* draft(page).type("my entry");
    yield* sidekick(page).composer.type("my q");

    for (const size of PROFILES) {
      const rows = yield* frameAt(page, size);
      // The way out is in the footer at every size. How many rows a footer takes
      // is the composition's business, and this one says what it has to say in
      // one compact History row and one of directions below it.
      expect(rows.area("box:footer")?.contains("footer:exit")).toBe(true);
      if (size.columns >= 120) {
        // Both texts survive every size: neither is a property of the frame.
        // Both are drawn here, each in its own destination's block, with the
        // one Transcript list, the pane's own tab and the window controls where
        // the frame places them — and no headings over blocks of rows, because
        // whose work a row is is said on the row.
        expect(draft(page).text()).toContain("my entry");
        expect(sidekick(page).composer.text()).toContain("my q");
        expect(shows(rows, "Entry agents")).toBe(false);
        expect(shows(rows, "TRANSCRIPT")).toBe(true);
        expect(rows.has("tab:sidekick")).toBe(true);
        expect(rows.has("sidekick:earlier")).toBe(true);
        expect(rows.has("sidekick:later")).toBe(true);
        continue;
      }
      // A narrow frame routes one outlet, and the Sidekick is the one this
      // reading asked for — so the chat's text is drawn and the draft is in no
      // cell. Neither is lost: the draft is read by going back to the entries,
      // which is the outlet that has it, and the chat is still holding its own
      // when the frame is wide enough to draw both again.
      expect(sidekick(page).composer.text()).toContain("my q");
      expect(rows.has("footer:input")).toBe(false);
      yield* openCatalog(page);
      yield* closeCatalog(page);
      yield* page.until(
        "the draft back on the narrow outlet",
        (one) => one.has("footer:input") && draft(page).text().includes("my entry"),
      );
    }

    // Back at the widest size, read the older chat and prove the read-only
    // controls are absent from the screen at every size it is drawn at.
    const widest = yield* frameAt(page, PROFILES[0]);
    expect(transcriptShows(widest, "older ask")).toBe(true);
    yield* chooseTurn(page, "older ask");
    yield* page.until("the selector standing", (one) => one.has("sidekick:back"));
    for (const size of PROFILES) {
      const rows = yield* frameAt(page, size);
      if (size.columns >= 120) {
        // The current chat *is* the chat being read here, so it keeps its own
        // controls — and Back is reachable beside them, outside the window.
        expect(rows.has("sidekick:back")).toBe(true);
        expect(conversationArea(rows)?.shows("[Back to current chat]")).toBe(true);
      }
      expect(rows.area("box:footer")?.contains("footer:exit")).toBe(true);
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
  /** Whether the pane the conversation is read in shows the text. */
  function paneShows(frame: PageFrame, text: string): boolean {
    return conversationArea(frame)?.shows(text) ?? false;
  }

  /** Scroll the chat window toward its earlier rows until the frame holds what the case is after. */
  function* readBack(page: ReplPage, holds: (frame: PageFrame) => boolean): Operation<PageFrame> {
    return yield* scrollUntil(
      page,
      { window: "sidekick", control: "sidekick:earlier", toward: "less" },
      holds,
    );
  }

  /** Scroll the chat window toward its newest rows until the frame holds what the case is after. */
  function* readForward(
    page: ReplPage,
    holds: (frame: PageFrame) => boolean,
  ): Operation<PageFrame> {
    return yield* scrollUntil(
      page,
      { window: "sidekick", control: "sidekick:later", toward: "more" },
      holds,
    );
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
    const page = yield* useReplPage();
    const repl = page.repl;
    // Explicit breaks, a blank line, and a line wider than the pane — which at
    // 160 columns is narrower than this one, so it has to be cut.
    const wide = "a-very-long-line-that-cannot-fit-this-pane-and-must-be-cut-across-rows";
    const first = ["one-A", "one-B", "", "one-C", wide].join("\n");
    repl.fake.script({ reply: `<Output>${first}</Output>\n` });
    yield* ask(page, "first");
    yield* page.until("the first reply drawing", (one) => paneShows(one, "one-A"));

    // Every authored line is its own row, in the order they were written, and
    // the over-wide one was cut rather than truncated.
    const before = chatRows(page.frame());
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
    yield* ask(page, "second");
    yield* page.until("the second reply drawing", (one) => paneShows(one, "two-B"));

    const after = chatRows(page.frame());
    for (const part of ["one-A", "one-B", "one-C", "two-A", "two-B"]) {
      expect([part, after.some((row) => row.endsWith(part))]).toEqual([part, true]);
    }
    expect(after.join("")).toContain(wide);
    // In order, and on rows of their own: the second message begins after the
    // first one's last row rather than on top of it.
    expect(rowAt(after, "one-C")).toBeLessThan(rowAt(after, "two-A"));
    expect(rowAt(after, "two-A")).toBeLessThan(rowAt(after, "two-B"));

    // The pane's own chrome and both composers are untouched by any of it.
    expect(shownPane(page.frame())).toBe("sidekick");
    expect(page.frame().has("sidekick:message")).toBe(true);
    expect(page.frame().has("draft:send")).toBe(true);
    expect(page.frame().has("footer:input")).toBe(true);

    // And what was saved is complete, whatever the window is showing.
    yield* repliesSaved(repl, 2);
    const read = yield* mountedReading(repl);
    const replies = read.chat.filter((record) => record.kind === "response");
    expect(replies).toHaveLength(2);
    expect(JSON.stringify(replies[0])).toContain("one-C");
  });

  it("CF2: a chat whose window filled shows its newest reply, at every size", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    for (let number = 1; number <= 12; number += 1) {
      repl.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
      yield* ask(page, `ask-${number}`);
    }
    // Acknowledged on disk, which is what makes the screen's answer a fact
    // about a chat rather than about a script.
    yield* repliesSaved(repl, 12);
    const read = yield* mountedReading(repl);
    expect(read.chat.filter((record) => record.kind === "response")).toHaveLength(12);

    // The newest reply, with nothing pressed to bring it into view.
    const fed = repl.terminal.fed;
    yield* page.until("the newest reply at 160x36", (one) =>
      chatRows(one).includes("[S] ANSWER-12"),
    );
    expect(repl.terminal.fed).toBe(fed);
    // The first exchange has moved up out of the window, and that is following
    // rather than loss: it is still in the history that was just read.
    expect(chatRows(page.frame())).not.toContain(`[S] ANSWER-1`);
    expect(JSON.stringify(read.chat)).toContain("ANSWER-1");

    // The same at the medium size.
    const medium = yield* page.resize({ columns: 120, rows: 30 });
    expect(paneShows(medium, `[S] ANSWER-12`)).toBe(true);

    // And in the narrow outlet, asked for explicitly: a narrow frame has no
    // tab to activate, so the route is taken while there is one and survives
    // the shrink.
    yield* routeToSidekick(page);
    const narrow = yield* page.resize(NARROW);
    expect(paneShows(narrow, `[S] ANSWER-12`)).toBe(true);

    // Back at the wide size, the earlier messages are reachable by the chat's
    // own control, which is what "they moved up" has to mean: they went up,
    // they did not go away.
    yield* page.resize({ columns: 160, rows: 36 });
    yield* page.until("the wide chat again", (one) => paneShows(one, `[S] ANSWER-12`));
    yield* readBack(page, (one) => chatRows(one).includes(`[S] ANSWER-1`));
  });

  /**
   * One execution with two real conversations, each long enough to scroll.
   *
   * Through the product, like the SS tier's own two-chat fixture: messages,
   * an agent replacement that opens the second conversation, then messages in
   * that one. Both overflow their window, because a chat that fits has no
   * reading position to lose.
   */
  function* twoLongChats(page: ReplPage, each: number): Operation<void> {
    const repl = page.repl;
    repl.fake.configuration({
      model: { selected: "balanced", choices: [{ id: "balanced", name: "Balanced" }] },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    for (let number = 1; number <= each; number += 1) {
      // Two lines each, so ten exchanges overflow the window: a chat that fits
      // has no reading position to lose, and these rows are about losing one.
      repl.fake.script({ reply: `<Output>OLD-${number}\nmore</Output>\n` });
      yield* ask(page, `old-${number}`);
    }
    yield* page.until("the older chat's last reply", (one) => saidBySidekick(one, `OLD-${each}`));
    yield* page.until("the Sidekick at rest", sidekickIdle);

    yield* startNewConversation(page);

    for (let number = 1; number <= each; number += 1) {
      repl.fake.script({ reply: `<Output>NEW-${number}\nmore</Output>\n` });
      yield* ask(page, `new-${number}`);
    }
    yield* page.until("the current chat's last reply", (one) => saidBySidekick(one, `NEW-${each}`));
    yield* page.until("the Sidekick at rest", sidekickIdle);
  }

  /** Open the older chat from the Sessions reading, by one of its own turns. */
  function* readOlder(page: ReplPage, turn: string): Operation<void> {
    yield* scrollUntil(
      page,
      { window: "sessions", control: "sessions:later", toward: "more" },
      (one) => transcriptRow(one, turn) !== undefined,
      60,
    );
    yield* chooseTurn(page, turn);
  }

  it("CF-P1: scrolling an older chat leaves the current chat's own reading alone", function* () {
    const page = yield* useReplPage();
    yield* twoLongChats(page, 10);

    // The current chat is at its tail, which is where following put it.
    expect(chatRows(page.frame())).toContain(`[S] NEW-10`);
    expect(page.frame().windows.get("sidekick")?.more).toBe(false);

    // An older chat, opened read-only and then scrolled: a position taken in a
    // chat somebody is only reading.
    yield* readOlder(page, "old-1 ");
    yield* page.until("the older chat opening", (one) => paneShows(one, `[S] OLD-`));
    yield* readBack(page, (one) => !chatRows(one).includes(`[S] OLD-10`));

    // Back. The current chat returns to its own reading — still following, so
    // still showing its latest reply — because the chat that was scrolled was
    // somebody else's.
    yield* page.press("sidekick:back");
    yield* page.until("the current chat returning", (one) => paneShows(one, `[S] NEW-`));
    expect(chatRows(page.frame())).toContain(`[S] NEW-10`);
  });

  it("CF-P1: control — a deliberate current reading also survives the visit", function* () {
    const page = yield* useReplPage();
    yield* twoLongChats(page, 10);

    // A position taken deliberately in the *current* chat, away from its tail.
    yield* readBack(page, (one) => !chatRows(one).includes(`[S] NEW-10`));
    const held = chatRows(page.frame());

    // Visit an older chat and come back: the reading somebody chose is the
    // reading they return to, neither re-followed nor moved by the visit.
    yield* readOlder(page, "old-1 ");
    yield* page.until("the older chat opening", (one) => paneShows(one, `[S] OLD-`));
    yield* page.press("sidekick:back");
    yield* page.until("the current chat returning", (one) => paneShows(one, `[S] NEW-`));
    expect(chatRows(page.frame())).toEqual(held);
  });

  it("CF-E1: a held reply grows into another row, and settles in the same item", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    // Both composers hold something first, so what settlement does to them is
    // something there is to observe.
    yield* draft(page).type("mine");

    // Enough literal Output rows to overflow the chat window, then one more
    // row behind them — two pieces, the second held until this row lets it go.
    const first = `<Output>BEGIN\n${Array.from({ length: 30 }, (_, at) => `ROW-${at + 1}`).join("\n")}`;
    repl.fake.script({
      deltas: [first, "\nTAIL-LAST</Output>\n"],
      holdsEachPiece: true,
      holdAfter: 2,
    });

    yield* ask(page, "grow");
    yield* repl.fake.streamingTurns(1);
    yield* sidekick(page).composer.type("later");

    // The first piece's own newest row, the window having followed it there.
    yield* page.until("the preview's latest row", (one) => paneShows(one, "ROW-30"));
    const fed = repl.terminal.fed;
    // Nothing is saved: this is a preview, and the provider is still holding.
    expect(
      (yield* mountedReading(repl)).chat.filter((one) => one.kind === "response"),
    ).toHaveLength(0);
    // Its own earlier rows moved up rather than being drawn over.
    expect(paneShows(page.frame(), "BEGIN")).toBe(false);

    // It grows across another visual row on its own, with nothing pressed.
    repl.fake.releaseDeltas();
    yield* page.until("the grown preview's new last row", (one) => paneShows(one, "TAIL-LAST"));
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
    yield* page.until("the Sidekick's own control going back to Send", sidekickIdle);
    // And the reply itself, acknowledged: the control coming back is the pane
    // saying it is idle, and the record is what says the turn was kept.
    yield* repliesSaved(repl, 1);
    const read = yield* mountedReading(repl);
    const responses = read.chat.filter((one) => one.kind === "response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ response: "response:1", hasOutput: true });
    expect(paneShows(page.frame(), "TAIL-LAST")).toBe(true);
    expect(repl.terminal.fed).toBe(fed);
    expect(draft(page).text()).toBe("mine");
    expect(sidekick(page).composer.text()).toBe("later");
  });

  it("CF3: a reading somebody scrolled to stays put while the next reply saves", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    for (let number = 1; number <= 12; number += 1) {
      repl.fake.script({ reply: `<Output>ANSWER-${number}</Output>\n` });
      yield* ask(page, `ask-${number}`);
    }
    yield* page.until("the newest reply", (one) => chatRows(one).includes(`[S] ANSWER-12`));
    yield* page.until("the Sidekick at rest", sidekickIdle);

    // Deliberately reading further back, until the newest reply is no longer
    // the one in view.
    yield* readBack(page, (one) => !chatRows(one).includes(`[S] ANSWER-12`));
    const held = chatRows(page.frame());

    // A real next exchange, held at the transport and then released: the reply
    // is saved while this reading is somewhere else.
    repl.fake.script({ held: true, reply: "<Output>ANSWER-13</Output>\n" });
    yield* ask(page, "ask-13");
    yield* repl.fake.holdingTurns(1);
    repl.fake.releaseTurn();
    yield* page.until("the next reply being saved", (one) =>
      transcriptShows(one, "ask-13 · completed"),
    );

    // Saved, and this reading did not jump to it.
    const read = yield* mountedReading(repl);
    expect(JSON.stringify(read.chat)).toContain("ANSWER-13");
    expect(chatRows(page.frame())).not.toContain(`[S] ANSWER-13`);
    expect(chatRows(page.frame())).toEqual(held);

    // Reaching the end again resumes following, so the arrival after it is
    // shown without anything being pressed for it.
    yield* readForward(page, (one) => chatRows(one).includes(`[S] ANSWER-13`));

    repl.fake.script({ reply: "<Output>ANSWER-14</Output>\n" });
    yield* ask(page, "ask-14");
    yield* page.until("following having resumed", (one) => paneShows(one, `[S] ANSWER-14`));
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
 * state as much as what it shows.
 */
describe("Tier MC — the message composer wraps and grows", () => {
  /** The composer's own rows, as a person reads them. */
  function composer(page: ReplPage): readonly string[] {
    return composerRows(page.frame());
  }

  /** How many rows of chat this frame is drawing, between its two controls. */
  function chatCapacity(frame: PageFrame): number {
    return frame.area("box:inspection:viewport")?.bounds.height ?? 0;
  }

  /** Put these bytes into the focused composer as one chunk, and wait for the last cell of them to show. */
  function* pastedInto(page: ReplPage, text: string, lastCell: string): Operation<void> {
    page.repl.terminal.bytes(new TextEncoder().encode(text));
    yield* page.until(`the composer holding ${JSON.stringify(lastCell)}`, (one) =>
      composerRows(one).join(" ").includes(lastCell),
    );
  }

  /** A populated chat that is following, which is what the composer eats into. */
  function* populated(page: ReplPage, exchanges: number): Operation<void> {
    for (let number = 1; number <= exchanges; number += 1) {
      page.repl.fake.script({ reply: `<Output>SAID-${number}</Output>\n` });
      yield* ask(page, `ask-${number}`);
    }
    yield* page.until("the newest reply", (one) => chatRows(one).includes(`[S] SAID-${exchanges}`));
    yield* page.until("the Sidekick at rest", sidekickIdle);
  }

  it("MC5: the value wraps into rows of its own, and the chat gives them room", function* () {
    const page = yield* useReplPage();
    yield* populated(page, 10);
    const before = chatCapacity(page.frame());
    expect(before).toBeGreaterThan(1);
    // One blank value row before anything is typed: the box is a place on the
    // screen whether or not it holds anything.
    yield* page.focus("sidekick:message");
    expect(composer(page)).toEqual([""]);

    // Past one measured line, and then text carrying a newline, a blank line
    // and a wide/combining character.
    yield* paste(
      page,
      sidekick(page).composer,
      "a question whose words have to wrap onto another row of the pane",
    );
    const wrapped = composer(page);
    expect(wrapped.length).toBeGreaterThan(1);
    // Disjoint rows: rejoining them recovers what was typed, with no row
    // repeating another's text.
    expect(wrapped.join(" ")).toContain("a question whose words");
    expect(wrapped.join(" ")).toContain("another row of the pane");

    yield* pastedInto(page, "\nx\n\né́ 広い", "い");
    const pasted = composer(page);
    expect(pasted.length).toBeGreaterThan(wrapped.length);
    // The explicit break, the blank line and the graphemes are all rows of it.
    expect(pasted).toContain("x");
    expect(pasted).toContain("");
    // Each wide character, rather than the pair as one substring: this
    // terminal's own cell reconstruction interleaves a combining mark with
    // the characters beside it, so adjacency here would be an assertion about
    // the reader. That the characters reached the composer's rows is the point.
    expect(pasted.join(" ")).toContain("広");
    expect(pasted.join(" ")).toContain("い");

    // It grew by taking rows from the chat, and the chat is still following:
    // its newest reply is the row at the bottom.
    const after = chatCapacity(page.frame());
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(1);
    expect(chatRows(page.frame())).toContain(`[S] SAID-10`);

    // The name, the controls and the footer are all where they were.
    expect(page.frame().has("sidekick:message")).toBe(true);
    expect(shows(page.frame(), "message the sidekick")).toBe(true);
    expect(page.frame().has("sidekick:send")).toBe(true);
    expect(page.frame().has("footer:history")).toBe(true);
    expect(page.frame().has("footer:exit")).toBe(true);

    // Backspace over ordinary trailing text shrinks it again, and the draft is
    // untouched by any of it.
    expect(draft(page).text()).toBe("");
    for (let press = 0; press < 12; press += 1) {
      yield* page.key("Backspace");
    }
    yield* page.until("the composer shrinking", (one) => composerRows(one).length < pasted.length);
    expect(draft(page).text()).toBe("");
  });

  it("MC6: six rows at most, and Send carries the original text once", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    repl.fake.script({ reply: "<Output>Understood.</Output>\n" });

    // A value far past six fitted rows, with its own newlines in it.
    const lines = Array.from({ length: 9 }, (_, at) => `LINE-${at + 1}`);
    const typed = lines.join("\n");
    yield* paste(page, sidekick(page).composer, typed);

    // Exactly six value rows under the one fixed name row, and the end of the
    // text — where somebody is typing — is what they show.
    const shown = composer(page);
    expect(shown).toHaveLength(6);
    expect(shown[shown.length - 1]).toBe("LINE-9");
    expect(shown).not.toContain("LINE-1");
    expect(page.frame().has("sidekick:message")).toBe(true);
    expect(shows(page.frame(), "message the sidekick")).toBe(true);

    // Send carries the original string, whitespace and newlines included, and
    // the rows that were off the screen are in it.
    const saving = heldMessageRecord(gate);
    yield* pressSidekickSend(page);
    yield* saving.started();

    // A newer wrapped edit behind the held append keeps its text and height.
    yield* paste(page, sidekick(page).composer, "NEWER-1\nNEWER-2\nNEWER-3");
    const newer = composer(page);
    expect(newer.length).toBeGreaterThan(1);

    saving.release();
    yield* page.until("the reply arriving", (one) => shows(one, "Understood."));

    // Exactly one message, and it is the literal text Send captured.
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual([typed]);
    expect(repl.fake.prompts).toHaveLength(1);
    expect(repl.fake.prompts[0]).toContain("LINE-1");
    expect(repl.fake.prompts[0]).toContain("LINE-9");
    expect(repl.fake.prompts[0]).not.toContain("NEWER-1");

    // The newer edit survived the acknowledgement, with its own height.
    expect(composer(page)).toEqual(newer);
  });

  it("MC6: control — an acknowledged Send leaves one blank value row", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.script({ reply: "<Output>Done.</Output>\n" });
    yield* paste(page, sidekick(page).composer, "one\ntwo\nthree");
    expect(composer(page).length).toBeGreaterThan(1);

    yield* pressSidekickSend(page);
    yield* page.until("the reply arriving", (one) => shows(one, "Done."));
    // Cleared, and back to the one blank row the box starts at.
    expect(composer(page)).toEqual([""]);
    expect(chatMessages((yield* mountedReading(repl)).chat)).toEqual(["one\ntwo\nthree"]);
  });

  it("MC7: the value, its focus and its height survive every size and a held turn", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    yield* populated(page, 8);
    const typed = Array.from({ length: 8 }, (_, at) => `ROW-${at + 1}`).join("\n");
    yield* paste(page, sidekick(page).composer, typed);
    expect(composer(page)).toHaveLength(6);
    expect(page.frame().focused).toBe("sidekick:message");

    // Medium: the value and the focus survive, and the height is this size's.
    const medium = yield* page.resize({ columns: 120, rows: 30 });
    expect(sidekick(page).composer.text()).toContain("ROW-8");
    expect(medium.has("sidekick:send")).toBe(true);
    const atMedium = composer(page).length;
    expect(atMedium).toBeGreaterThan(1);
    expect(atMedium).toBeLessThanOrEqual(6);

    // Narrow, asked for explicitly: the cap is what this screen can leave the
    // chat. How many rows that is belongs to the composition — this outlet
    // keeps three rows of chrome where the one this row was written against
    // kept seven, so twenty rows now allow the whole cap — and what the cap is
    // *for* is that the chat keeps a row of its own, which is asserted below.
    yield* page.resize({ columns: 160, rows: 36 });
    yield* routeToSidekick(page);
    const narrow = yield* page.resize(NARROW);
    yield* page.until("the composer at the narrow size", (one) => one.has("sidekick:message"));
    expect(sidekick(page).composer.text()).toContain("ROW-8");
    const atNarrow = composer(page).length;
    expect(atNarrow).toBeGreaterThanOrEqual(1);
    expect(atNarrow).toBeLessThanOrEqual(6);
    // Send and at least one chat row are still there to reach.
    expect(page.frame().has("sidekick:send")).toBe(true);
    expect(chatCapacity(page.frame())).toBeGreaterThanOrEqual(1);

    // And the one outlet keeps its gutter: the field's own marker is drawn in
    // the first cell of its control, and the cell in front of it holds nothing.
    // The accepted table's 72x20 row.
    const field = page.frame().control("sidekick:message");
    if (field === undefined) {
      throw new Error(`the narrow outlet drew no message box. ${page.describe()}`);
    }
    expect(field.bounds.x).toBe(1);
    expect(
      page
        .frame()
        .within({ x: 0, y: field.bounds.y, width: field.bounds.x, height: 1 })
        .rows()
        .join(""),
    ).toBe("");
    expect(narrow.profile).toBe("narrow");

    // Below the minimum, and back.
    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.profile).toBe("too-small");
    expect(shows(refused, `${NARROW.columns}x`)).toBe(true);
    expect(shows(refused, "[send]")).toBe(false);
    yield* page.resize({ columns: 160, rows: 36 });
    expect(sidekick(page).composer.text()).toContain("ROW-8");
    expect(composer(page)).toHaveLength(6);

    // A tab round trip keeps it, and so does a held turn it is edited behind.
    yield* selectPane(page, "bindings");
    yield* selectPane(page, "sidekick");
    expect(sidekick(page).composer.text()).toContain("ROW-8");

    repl.fake.script({ held: true, reply: "<Output>Held answer.</Output>\n" });
    yield* ask(page, "go");
    yield* repl.fake.holdingTurns(1);
    const asked = repl.fake.prompts.length;
    yield* paste(page, sidekick(page).composer, "while-busy-1\nwhile-busy-2");
    // It grew while the turn is in flight, and sent nothing: the request the
    // provider is holding is the one it was given.
    expect(composer(page).length).toBeGreaterThan(1);
    expect(repl.fake.prompts).toHaveLength(asked);
    expect(repl.fake.prompts[asked - 1]).not.toContain("while-busy-1");
    repl.fake.releaseTurn();
    yield* page.until("the held reply arriving", (one) => shows(one, "Held answer."));
    expect(sidekick(page).composer.text()).toContain("while-busy-2");
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
  function* runs(page: ReplPage, source: string, shown: string, recorded: number): Operation<void> {
    yield* draft(page).type(source);
    yield* page.key("Enter");
    yield* page.until("the draft being consumed by its entry", () => draft(page).text() === "");
    yield* page.until(`the entry printing ${JSON.stringify(shown)}`, (one) => shows(one, shown));
    yield* awaitedFact(`the history recording ${recorded} entries`, function* () {
      return (yield* mountedReading(page.repl)).model.entries.length >= recorded;
    });
    // And the rail marking it settled, which the recorded model does not imply.
    // The band carries the entry from the moment it is admitted and widens
    // again when its outcome lands, and that width is what places the footer's
    // own controls: measured at 160x36, [history] sits at column 92 with no
    // entry, 94 while the first is running, 96 once it settled, 97 and then 98
    // for the second. A row that acted on the running frame would aim a press
    // at a cell the control has already left and wait for a drawer that never
    // opens, which is how this tier failed under Bun on the runner.
    yield* entrySettles(page, recorded, "ok");
  }

  /** Wait until the retained feedback holds a receipt that says this. */
  function* receiptSaved(repl: MountedRepl, said: string): Operation<void> {
    yield* awaitedFact(`the receipt saying ${JSON.stringify(said)} being saved`, function* () {
      return (yield* mountedReading(repl)).chat.some(
        (one) => one.kind === "feedback" && one.text.includes(said),
      );
    });
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
  function* freezeAt(page: ReplPage, position: string): Operation<void> {
    yield* page.press("footer:history");
    yield* page.until("the History drawer opening", (one) => shows(one, position));
    yield* drawer(page).choose(position);
    yield* page.until("the screen freezing at that position", (one) => one.has("footer:live"));
  }

  /** Put the History drawer a copied location carries away, which leaves the screen frozen. */
  function* closeHistory(page: ReplPage): Operation<void> {
    yield* page.until("the frozen screen offering the way back", (one) => one.has("footer:live"));
    yield* page.press("drawer:close");
    yield* page.until("the drawer closing", (one) => !one.has("drawer:close"));
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
        const page = yield* useReplPage({ host });
        yield* runs(page, FIRST, "the first entry", 1);
        yield* runs(page, SECOND, "the second entry", 2);
        expect((yield* mountedReading(page.repl)).model.entries).toHaveLength(2);
        if (arm.historical) {
          yield* freezeAt(page, FIRST_OUTCOME);
        }
        location = yield* leaving(page);
      });

      yield* scoped(function* (): Operation<void> {
        const host = yield* useMountedHost({ dataRoot });
        if (location === undefined) {
          throw new Error("the first process handed back no location");
        }
        const page = yield* useReplPage({ host, location });
        const repl = page.repl;

        // Back to the live head, which is where a submission is allowed at all.
        //
        // The copied location carries the History drawer that was open when it
        // was copied, and the drawn drawer owns the keys and its own controls —
        // so the footer's way back is not reachable until it is closed.
        if (arm.historical) {
          yield* closeHistory(page);
          yield* page.press("footer:live");
          yield* page.until("the live head coming back", (one) => !one.has("footer:live"));
        }

        repl.fake.script({ reply: submitting(THIRD) });
        yield* ask(page, "run one more");
        yield* page.until("the third entry printing", (one) => shows(one, "the third entry"));
        yield* receiptSaved(repl, "Entry entry-3 completed.");

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
      const page = yield* useReplPage({ host });
      yield* runs(page, FIRST, "the first entry", 1);
      yield* runs(page, SECOND, "the second entry", 2);
      yield* freezeAt(page, FIRST_OUTCOME);
      location = yield* leaving(page);
    });

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      const page = yield* useReplPage({ host, location });
      const repl = page.repl;
      yield* closeHistory(page);
      yield* page.press("footer:live");
      yield* page.until("the live head coming back", (one) => !one.has("footer:live"));

      repl.fake.script({ reply: submitting(FAILING) });
      yield* ask(page, "run one that fails");
      yield* entrySettles(page, 3, "err");
      yield* receiptSaved(repl, "Entry entry-3 failed.");

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
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    yield* runs(page, FIRST, "the first entry", 1);
    yield* runs(page, SECOND, "the second entry", 2);

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
    yield* ask(page, "run one that fails");
    yield* outcome.started();

    // Frozen at the first entry's recorded outcome, with the submission
    // still waiting for its own. The drawer is closed and the head is
    // deliberately *not* returned to.
    yield* freezeAt(page, FIRST_OUTCOME);
    yield* page.press("drawer:close");
    yield* page.until("the drawer closing", (one) => !one.has("drawer:close"));
    expect(page.frame().has("footer:live")).toBe(true);

    outcome.release();
    yield* page.until("the reply that follows the failure", (one) => shows(one, "Noted."));
    // Still frozen when the receipt was composed and delivered: the control
    // that goes back to the head is still the one being offered.
    expect(page.frame().has("footer:live")).toBe(true);

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
      const page = yield* useReplPage({ host });
      yield* runs(page, FIRST, "the first entry", 1);
      yield* runs(page, SECOND, "the second entry", 2);
      yield* freezeAt(page, FIRST_OUTCOME);
      location = yield* leaving(page);
    });

    yield* scoped(function* (): Operation<void> {
      const host = yield* useMountedHost({ dataRoot });
      const page = yield* useReplPage({ host, location });
      const repl = page.repl;
      yield* closeHistory(page);

      // Still frozen: a Run from here establishes nothing. The draft keeps its
      // text, because a refusal is not a submission.
      expect(page.frame().has("footer:live")).toBe(true);
      yield* draft(page).type(THIRD);
      yield* page.key("Enter");
      yield* lingering();
      expect((yield* mountedReading(repl)).model.entries).toHaveLength(2);
      expect(draft(page).text()).toContain(THIRD);

      // Live again, and the same Run admits the next entry — the third, with
      // the source that was typed, and the draft cleared by the entry it became.
      yield* page.press("footer:live");
      yield* page.until("the live head coming back", (one) => !one.has("footer:live"));
      yield* page.focus("footer:input");
      yield* page.key("Enter");
      yield* page.until("the third entry printing", (one) => shows(one, "the third entry"));
      // Cleared by the entry it became, which is a frame of its own: the
      // submission and the redraw that drops the text are not one step.
      yield* page.until(
        "the draft being cleared by its entry",
        () => !draft(page).text().includes(THIRD),
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
    const page = yield* useReplPage();

    // Text in both destinations first, so switching has something to lose.
    yield* draft(page).type("my entry");
    yield* sidekick(page).composer.type("my question");

    // The Sidekick is the default reading, and both names are on the screen
    // whichever one that is. Spelled the way the staged panes spell their own
    // tabs — in capitals — rather than the way a person says them.
    expect(shownPane(page.frame())).toBe("sidekick");
    expect(page.frame().control("tab:bindings")?.text).toContain("BINDINGS");
    expect(page.frame().control("tab:sidekick")?.text).toContain("SIDEKICK");
    expect(shows(page.frame(), "[selected]")).toBe(false);

    // By keyboard: Tab until the tab holds focus, then Enter. Focus landing on
    // it is what makes this the keyboard path rather than a dispatch.
    yield* selectPane(page, "bindings");
    expect(page.frame().focused).toBe("tab:bindings");
    // Focus on a tab is not selection of it: the other tab can hold focus
    // without the reading changing under it.
    yield* page.focus("tab:sidekick");
    expect(page.frame().focused).toBe("tab:sidekick");
    expect(shownPane(page.frame())).toBe("bindings");

    // By pointer: the same control, reached at its own cell. Its box is its own
    // label now, so a click on the name is a click on the tab bearing it.
    yield* page.press("tab:sidekick");
    yield* page.until("the chat coming back", (one) => shownPane(one) === "sidekick");
    yield* page.press("tab:bindings");
    yield* page.until("Bindings again", (one) => shownPane(one) === "bindings");

    // And neither composer was edited by any of it.
    yield* page.press("tab:sidekick");
    yield* page.until("the chat once more", (one) => shownPane(one) === "sidekick");
    expect(sidekick(page).composer.text()).toContain("my question");
    expect(draft(page).text()).toBe("my entry");
  });

  it("UH5: an open History drawer still says Esc closes, and closing keeps both texts", function* () {
    const page = yield* useReplPage();

    // Text in both destinations, and an entry selected, so closing has
    // something to preserve.
    yield* draft(page).type("kept entry");
    yield* sidekick(page).composer.type("kept question");
    expect(shownPane(page.frame())).toBe("sidekick");

    // A real route drawer, opened the way a person opens it.
    yield* page.focus("footer:history");
    yield* page.key("Enter");
    yield* page.until("the History drawer", (one) => one.has("drawer:close"));

    // The directions are still legible in front of it, including the way out.
    // This is the point the accepted envelope exists for: the drawer begins
    // below the whole fitted block rather than on top of its first row.
    expect(shows(page.frame(), "Esc closes")).toBe(true);

    // Closed once, by that very key.
    yield* page.key("Escape");
    yield* page.until("the drawer closing", (one) => !one.has("drawer:close"));

    // And nothing it was in front of was disturbed: the same reading is
    // selected and neither composer was edited.
    expect(shownPane(page.frame())).toBe("sidekick");
    expect(sidekick(page).composer.text()).toContain("kept question");
    expect(draft(page).text()).toBe("kept entry");
  });

  it("BP3: both bodies stay usable through their own controls, and narrow gains no inset", function* () {
    const page = yield* useReplPage();

    // A real entry first, so the Transcript has a reading with controls around
    // it — submitting consumes the draft, so the texts below are typed after.
    yield* submitEntry(page, promptEntry("read-entry"));
    yield* entrySettles(page, 1, "ok");
    // Chosen in the catalog, which is where this screen keeps those rows: a
    // drawer over the reading, opened to point at one, and the choice closes it.
    yield* openCatalog(page);
    yield* page.press("entry:entry-1");
    yield* page.until("the catalog closing behind the choice", (one) => !catalogOpen(one));

    // Then text in both destinations, so the round trip below has something of
    // each to preserve.
    yield* draft(page).type("kept entry");
    yield* sidekick(page).composer.type("kept question");

    // The Sessions reading is reached by its own control, in the column the
    // inset narrowed: a row built to the pane instead of the body would have
    // published a target reaching into the gutter.
    // Behind the selector, which is where one list with the conversations as its
    // filter keeps them: opening it is what puts the choices on the screen.
    yield* openFilter(page);
    // Inside the Transcript's own column, which is this row's point: a row
    // built to the pane instead of the body would have published a target
    // reaching into the gutter.
    expect(page.frame().area("box:sidebar")?.contains("sessions:all")).toBe(true);
    yield* page.press("sessions:all");
    // And the press landed. Choosing is the whole of what the chooser is for,
    // so it closes behind the choice rather than staying open over the reading
    // it just changed.
    yield* page.until("the chooser closing behind the choice", (one) => !one.has("sessions:all"));

    // And the Transcript scrolls by its *own* control at both shared sizes. The
    // reading is narrower than it was, so its later rows are reached rather than
    // drawn — which is what these two controls are for. Found by its key: each
    // of the three readings on this screen draws a pair of its own.
    for (const size of [
      { columns: 120, rows: 30 },
      { columns: 160, rows: 36 },
    ]) {
      const drawn = yield* page.resize(size);
      // The Transcript is the leftmost column of the staged screen, so its own
      // controls are the ones inside its column.
      expect([size.columns, drawn.area("box:sidebar")?.contains("sessions:later")]).toEqual([
        size.columns,
        true,
      ]);
      yield* page.press("sessions:later");
      yield* lingering();
      // Pressed, and it wrote nothing. How far a short reading moves is its own
      // business — that a narrowed body's later rows are still *reachable* is
      // BP2's point, against a reading long enough to need it. What matters
      // here is that this column's own control is where a pointer can reach it
      // and that pressing it edits neither composer nor the selection.
      expect([size.columns, draft(page).text()]).toEqual([size.columns, "kept entry"]);
      expect([size.columns, sidekick(page).composer.text().includes("kept question")]).toEqual([
        size.columns,
        true,
      ]);
      expect([size.columns, yield* markedEntry(page, "entry-1")]).toEqual([size.columns, true]);
    }

    // Narrow routes one outlet and is given no inset of its own, so its own
    // surface controls are still what it offers.
    const narrow = yield* page.resize(NARROW);
    expect(shows(narrow, "Entries")).toBe(true);

    // Back, with both texts where they were left and the same reading selected.
    const wide = yield* page.resize({ columns: 160, rows: 36 });
    expect(shownPane(wide)).toBe("sidekick");
    expect(sidekick(page).composer.text()).toContain("kept question");
    expect(draft(page).text()).toContain("kept entry");
  });

  it("UH4: resizing through narrow and back keeps both texts, and narrow grows no tabs", function* () {
    const page = yield* useReplPage();
    yield* draft(page).type("kept entry");
    yield* sidekick(page).composer.type("kept question");

    // Medium keeps the three columns and the one header row.
    const medium = yield* page.resize({ columns: 120, rows: 30 });
    for (const key of ["tab:bindings", "tab:sidekick"]) {
      expect([key, medium.has(key)]).toEqual([key, true]);
    }
    expect(shows(medium, "BINDINGS")).toBe(true);
    expect(shows(medium, "SIDEKICK")).toBe(true);
    expect(shows(medium, "[selected]")).toBe(false);

    // Narrow routes one outlet and heads no shared column, so it grows neither
    // the tab row nor a gap: its own surface controls are its headings.
    const narrow = yield* page.resize(NARROW);
    expect(shows(narrow, "Entries")).toBe(true);
    expect(shows(narrow, "[selected]")).toBe(false);
    expect(narrow.has("tab:bindings")).toBe(false);
    expect(narrow.has("tab:sidekick")).toBe(false);

    // And back, with both texts where they were left.
    const wide = yield* page.resize({ columns: 160, rows: 36 });
    expect(shows(wide, "BINDINGS")).toBe(true);
    expect(sidekick(page).composer.text()).toContain("kept question");
    expect(draft(page).text()).toContain("kept entry");
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
 * And it is opened the way a person opens it: by the control the notice
 * carries, at the narrowest size with the conversation routed to its one
 * outlet. A test that set `asking` itself would be asserting the drawer rather
 * than reaching it, and would not notice a control that stopped being able to.
 */
describe("Tier R3 — the Sidekick's parsed question at a constrained size", () => {
  it("R3: the drawer opens through its own action and its field takes text", function* () {
    const page = yield* useReplPage();
    // One ordinary string field, as the parser reads it.
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["rule"],
      properties: { rule: { type: "string", title: "Rounding rule" } },
    };
    page.repl.fake.script({
      reply: askingReply("Which rounding rule should the tax use?", schema),
    });
    page.repl.fake.script({ reply: "<Output>Noted.</Output>\n" });

    // The narrowest size this screen supports, with the conversation routed to
    // the one outlet it has: the drawer has least to work with here.
    yield* routeToSidekick(page);
    const narrow = yield* page.resize(NARROW);
    expect(narrow.profile).toBe("narrow");
    yield* ask(page, "which rule");

    // The question is announced where it can be answered.
    const asked = yield* page.until("the question announcing itself", (one) =>
      one.has("sidekick:answer"),
    );
    expect(asked.profile).toBe("narrow");
    expect(form(page).isOpen()).toBe(false);

    // Opened by the control that announces it.
    yield* page.press("sidekick:answer");
    const drawn = yield* page.until("the drawer opening", (one) => one.has("drawer:field:rule"));
    expect(drawer(page).isOpen()).toBe(true);
    expect(shows(drawn, "Which rounding rule should the tax use?")).toBe(true);
    // Drawn, the drawer carries that one field.
    expect(drawn.keys().filter((key) => key.startsWith("drawer:field:"))).toEqual([
      "drawer:field:rule",
    ]);

    // The field takes the focus text acts on, and then the text.
    const answered = "half up, to the cent";
    yield* form(page).value("rule").type(answered);
    expect(page.frame().focused).toBe("drawer:value:rule");

    // The question this is an answer to is still the question that was asked,
    // and the screen says so in the row the value belongs to.
    expect(form(page).value("rule").text()).toContain("half up");
    expect(shows(page.frame(), "Which rounding rule should the tax use?")).toBe(true);
  });
});
