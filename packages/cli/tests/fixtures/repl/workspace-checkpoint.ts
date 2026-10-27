/**
 * The one controlled reading the #971 staged workspace screen is reviewed at.
 *
 * Two entries run for real over one journal: the first settles `ok` with output
 * of its own, and the second is truncated before its root closes, which is what
 * a prefix read while an entry is running holds. Everything else is the inert
 * view data a frame is handed — a live overlay, a Sidekick reading and the
 * staged workspace presentation — so the screen is drawn by the production
 * pipeline from facts rather than from a picture of one.
 *
 * Frozen: the same reading every time it is asked for, and no network, native
 * Agent or filesystem effect is needed to build it.
 */

import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { fileURLToPath } from "node:url";
import type { Operation } from "effection";

import { entryInitialBindings, projectRepl } from "../../../src/repl/model.ts";
import type { ReplModel } from "../../../src/repl/model.ts";
import { EntrySegmentStream } from "../../../src/repl/entries.ts";
import { initialState, NO_AGENT, viewFor, withWorkspace } from "../../../src/repl/application.ts";
import type {
  ReplLive,
  ReplSidekickChatRow,
  ReplSidekickReading,
  ReplState,
  ReplView,
  ReplWorkspace,
} from "../../../src/repl/application.ts";
import { NO_LIFECYCLE } from "../../../src/repl/lifecycle.ts";
import { navigationOf } from "../../../src/repl/navigation.ts";
import type { ReplTerminalSize } from "../../../src/repl/terminal.ts";
import type { Observed, Presenter } from "./presentation.ts";

/** The size the checkpoint is reviewed at. */
export const CHECKPOINT_SIZE: ReplTerminalSize = Object.freeze({ columns: 160, rows: 36 });

/** The execution the reading belongs to, which the identity row names. */
export const CHECKPOINT_EXECUTION = "checkout-repair";

/**
 * Where the component the running entry invokes is read from.
 *
 * This directory: `Checklist.md` beside this file is an existing fixture
 * component, so the nested scope the screen selects is admitted by a real
 * import of a real file rather than by a record written by hand.
 */
const CHECKPOINT_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));

/** The completed entry: it binds a value and renders output of its own. */
const COMPLETED = [
  "```js eval",
  'const subtotal = "40.00";',
  'output("cart.total is now computed from subtotal and tax.");',
  "```",
  "",
  "Subtotal: {subtotal}",
  "",
].join("\n");

/**
 * The running entry's exact source.
 *
 * It invokes one component, so the entry admits a nested scope the screen can
 * select and show as a breadcrumb. One line is longer than the selected work's
 * pane, so it wraps at a measured word boundary, and a run of spaces inside it
 * must survive the reading.
 */
export const RUNNING_SOURCE = [
  "# Review the checkout total",
  "",
  "```js eval",
  'output("Reading checkout.md and architecture.md");',
  "```",
  "",
  '<Checklist title="Checkout total" steps={3} />',
  "",
  "Compute the total once,    after the items are summed, so that checkout.md and cart.md can never disagree about what the customer pays.",
  "",
].join("\n");

/** The line of {@link RUNNING_SOURCE} that must wrap, exactly as written. */
export const WRAPPING_LINE =
  "Compute the total once,    after the items are summed, so that checkout.md and cart.md can never disagree about what the customer pays.";

/** The Draft: three rows of value, the middle one blank. */
export const CHECKPOINT_DRAFT = [
  "<Checkout cart={cart} />",
  "",
  '<PriceSummary items={cart.items} currency="USD" />',
].join("\n");

/** What is typed in the Sidekick's composer and has not been sent. */
export const CHECKPOINT_MESSAGE = "Also say what an empty cart renders.";

/** The queued message long enough to wrap between its origin and its X. */
export const WRAPPING_QUEUED =
  "Post the Architect's requested changes as a review comment on PR #212, quoting each one in full.";

/** The staged workspace presentation the checkpoint shows. */
export const CHECKPOINT_WORKSPACE: ReplWorkspace = Object.freeze({
  follow: true,
  tray: "queue",
  queued: Object.freeze([
    Object.freeze({
      key: "q1",
      origin: Object.freeze({ kind: "ui" as const }),
      text: "When that finishes, explain the requested changes.",
    }),
    Object.freeze({
      key: "q2",
      origin: Object.freeze({ kind: "acp" as const, attachment: "ci-bot" }),
      text: WRAPPING_QUEUED,
    }),
    Object.freeze({
      key: "q3",
      origin: Object.freeze({ kind: "ui" as const }),
      text: "Then put a fix for the empty-cart case in the draft.",
    }),
  ]),
  work: Object.freeze([
    Object.freeze({ message: "chat:response:1", entry: "entry-1" }),
    Object.freeze({ message: "chat:response:2", entry: "entry-2" }),
  ]),
});

const CONVERSATION = "chat";

function person(turn: number, text: string, origin: ReplSidekickChatRow["origin"]) {
  return Object.freeze({
    key: `${CONVERSATION}:message:${turn}`,
    conversation: CONVERSATION,
    turn,
    kind: "person" as const,
    text,
    hasOutput: false,
    failure: undefined,
    origin,
  });
}

function reply(turn: number, text: string) {
  return Object.freeze({
    key: `${CONVERSATION}:response:${turn}`,
    conversation: CONVERSATION,
    turn,
    kind: "reply" as const,
    text,
    hasOutput: true,
    failure: undefined,
  });
}

/**
 * The Sidekick's reading: two exchanges, one from this screen and one from an
 * attached client, each with explicit evaluated Output, and a Send still active.
 */
export const CHECKPOINT_SIDEKICK: ReplSidekickReading = Object.freeze({
  agent: "claude",
  busy: true,
  refusal: undefined,
  question: undefined,
  requested: undefined,
  verified: undefined,
  conversation: CONVERSATION,
  reading: CONVERSATION,
  current: true,
  availability: Object.freeze({
    chats: Object.freeze([CONVERSATION]),
    sessions: Object.freeze(["sess-sidekick-41ab"]),
    refusal: undefined,
  }),
  chat: Object.freeze([
    person(1, "Checkout fails: cart.total is not bound. Can you fix it?", { kind: "ui" }),
    reply(
      1,
      "The API response has subtotal and tax but no total, so I computed it in checkout.md.",
    ),
    person(2, "Ask the Architect to review checkout.md before I merge.", {
      kind: "acp",
      attachment: "ci-bot",
    }),
    reply(2, "I started the Architect review and will say what it asks for."),
  ]),
  turns: Object.freeze([
    Object.freeze({
      key: "chat:turn:1",
      conversation: CONVERSATION,
      agent: "claude",
      turn: 1,
      title: "Checkout fails: cart.total is not bound. Can you fix it?",
      state: "completed",
      running: false,
      failed: false,
      sessionKey: "sess-sidekick-41ab",
      text: "The API response has subtotal and tax but no total.",
      failure: undefined,
    }),
    Object.freeze({
      key: "chat:turn:2",
      conversation: CONVERSATION,
      agent: "claude",
      turn: 2,
      title: "Ask the Architect to review checkout.md before I merge.",
      state: "waiting on Entry 2",
      running: true,
      failed: false,
      sessionKey: "sess-sidekick-41ab",
      text: "I started the Architect review.",
      failure: undefined,
    }),
  ]),
});

/**
 * This process running the second entry: partial output on the overlay and one
 * entry agent turn streaming in its own provider conversation.
 */
export const CHECKPOINT_LIVE: ReplLive = Object.freeze({
  output: "Reading checkout.md and architecture.md",
  question: undefined,
  expansion: "playing",
  pausable: true,
  running: true,
  lifecycle: NO_LIFECYCLE,
  sidekick: CHECKPOINT_SIDEKICK,
  agent: Object.freeze({
    ...NO_AGENT,
    turns: Object.freeze([
      Object.freeze({
        key: "turn:architect:1",
        entry: "entry-2",
        prompt: "Review checkout.md against architecture.md and list each requested change.",
        state: "active" as const,
        text: "Reading checkout.md and architecture.md",
        agent: "codex",
        sessionKey: "sess-architect-7f2c",
        agentSessionId: undefined,
        status: undefined,
        stopReason: undefined,
        failure: undefined,
      }),
    ]),
    slots: Object.freeze([
      Object.freeze({
        key: "turn:architect:1",
        entry: "entry-2",
        order: 1,
        durable: undefined,
        last: undefined,
      }),
    ]),
  }),
});

function* runEntry(
  physical: DurableStream,
  source: string,
  initialBindings: Readonly<Record<string, Json>> = {},
): Operation<void> {
  const view = new EntrySegmentStream(physical);
  try {
    const execution = yield* executeInstalled(
      { ...inlineSource(source), stream: view, includes: [CHECKPOINT_DIRECTORY] },
      [],
      { initialBindings },
    );
    yield* collect(execution);
  } catch {
    // How far an entry got is the record the catalog reads.
  }
}

function projected(events: readonly DurableEvent[]): ReplModel {
  const result = projectRepl(events);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * The journal: a completed first entry, then a second that has not closed.
 *
 * The second runs whole in a stream of its own and is cut before its root's
 * close, so its segment is exactly what a prefix read mid-run holds.
 */
export function* checkpointModel(): Operation<ReplModel> {
  const physical = new InMemoryStream();
  yield* runEntry(physical, COMPLETED);
  const settled = yield* physical.readAll();
  const running = new InMemoryStream([...settled]);
  yield* runEntry(running, RUNNING_SOURCE, entryInitialBindings(projected(settled)));
  const whole = yield* running.readAll();
  const closes = whole
    .map((event, at) => ({ event, at }))
    .filter((one) => one.event.type === "close");
  const last = closes[closes.length - 1];
  return projected(whole.slice(0, last.at));
}

/**
 * The entry and the nested scope this screen selects, read from the model.
 *
 * The running entry and the first scope its own import admitted — real keys
 * from the projected history, so a fixture that stopped admitting that scope
 * fails here instead of quietly selecting the entry's root.
 */
export function checkpointScopes(model: ReplModel): readonly string[] {
  const entry = model.entries[model.entries.length - 1];
  if (entry === undefined) {
    throw new Error("this checkpoint model admitted no entry");
  }
  const nested = entry.scope.scopes[0];
  if (nested === undefined) {
    throw new Error(`${entry.key} admitted no nested scope for this checkpoint to select`);
  }
  return Object.freeze([entry.key, nested.key]);
}

/** The state the checkpoint reads: the nested scope selected, both texts typed. */
export function checkpointState(model: ReplModel): ReplState {
  const base = initialState(CHECKPOINT_EXECUTION);
  return Object.freeze({
    ...base,
    draft: CHECKPOINT_DRAFT,
    message: CHECKPOINT_MESSAGE,
    route: Object.freeze({
      ...base.route,
      right: "sidekick" as const,
      scopes: checkpointScopes(model),
    }),
  });
}

/**
 * The checkpoint view of one model, as the control named by `focused` holds it.
 *
 * `focused` is the key the *mounted tree* answered with, never a label chosen
 * here: a view says which control the cue is drawn on, and the tree is what
 * decides where a keystroke lands.
 */
export function checkpointViewOf(model: ReplModel, focused: string | undefined): ReplView {
  const resolved = viewFor(
    checkpointState(model),
    model,
    CHECKPOINT_LIVE,
    CHECKPOINT_SIZE,
    focused,
    navigationOf(model.checkpoints, "live"),
  );
  if (!resolved.ok) {
    throw resolved.error;
  }
  return withWorkspace(resolved.value, CHECKPOINT_WORKSPACE);
}

/** One committed checkpoint screen, and the facts it was committed from. */
export interface CheckpointFrame {
  readonly model: ReplModel;
  readonly view: ReplView;
  /** The key the mounted tree holds focus on, as the tree answered. */
  readonly focused: string | undefined;
  readonly observed: Observed;
}

/**
 * Commit the checkpoint screen, in the two frames the product itself takes.
 *
 * The first frame carries no focused key, so the Draft's own claim takes focus
 * exactly as it does when a command opens. The tree is then asked where focus
 * actually ended up, and the frame under review is composed with that answer —
 * so the cue drawn on the Draft is the cue of the control a keystroke reaches,
 * rather than a label a fixture asserted into the view.
 *
 * One presenter, one tree and one grid throughout, because this renderer writes
 * diffs: the screen is what the frames have left in the grid together.
 */
export function* commitCheckpoint(presenter: Presenter): Operation<CheckpointFrame> {
  const model = yield* checkpointModel();
  yield* presenter.commit(checkpointViewOf(model, undefined));
  const node = presenter.tree.focused();
  const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
  const view = checkpointViewOf(model, focused);
  const observed = yield* presenter.commit(view);
  return { model, view, focused, observed };
}
