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
import { readQuestionForm } from "../../../src/repl/elicitation.ts";
import type { ReplQuestionForm } from "../../../src/repl/elicitation.ts";
import type {
  ReplLive,
  ReplQueuedMessage,
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

/** The size the accepted checkpoint is reviewed at. */
export const CHECKPOINT_SIZE: ReplTerminalSize = Object.freeze({ columns: 160, rows: 36 });

/** The medium review size, whose staged proportions are a proposal. */
export const CHECKPOINT_MEDIUM: ReplTerminalSize = Object.freeze({ columns: 120, rows: 30 });

/** The narrow review size, which routes one outlet. */
export const CHECKPOINT_NARROW: ReplTerminalSize = Object.freeze({ columns: 72, rows: 20 });

/** One size below the narrow minimum, where the frame refuses and recovers. */
export const CHECKPOINT_BELOW: ReplTerminalSize = Object.freeze({ columns: 71, rows: 19 });

/** The three named review sizes, largest first. */
export const CHECKPOINT_SIZES: readonly ReplTerminalSize[] = Object.freeze([
  CHECKPOINT_SIZE,
  CHECKPOINT_MEDIUM,
  CHECKPOINT_NARROW,
]);

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
    // A reading whose final entry admitted none selects that entry alone. The
    // accepted screen's entry does admit one, and its own case says so.
    return Object.freeze([entry.key]);
  }
  return Object.freeze([entry.key, nested.key]);
}

/** How one checkpoint reading differs from the accepted 160x36 one. */
export interface CheckpointOptions {
  /**
   * The exact state to read, where a caller is carrying one of its own.
   *
   * A resize journey supplies this: it seeds a reading once and then carries it
   * from size to size, so what the screen keeps is a person's own reading
   * rather than the default this fixture would build again.
   */
  readonly state?: ReplState;
  /**
   * The key the mounted tree already holds focus on, where it holds one.
   *
   * Supplied after the opening frame, so a later frame composes from the tree's
   * own answer instead of letting the Draft take focus a second time.
   */
  readonly focused?: string;
  readonly size?: ReplTerminalSize;
  /** Which surface a narrow frame routes; wider frames show all three columns. */
  readonly surface?: "sessions" | "entries";
  /** Set to route a narrow outlet to the Sidekick, as `view=sidekick` does. */
  readonly sidekick?: true;
  /** A reading of its own, for the state and overflow screens. */
  readonly model?: ReplModel;
  readonly live?: ReplLive;
  readonly workspace?: ReplWorkspace;
}

/**
 * One entry that fails: its root closes `err` having recorded nothing to show.
 *
 * A schema outside the REPL's own form language, which is the refusal the
 * existing style fixtures use for the same purpose.
 */
const FAILING = [
  "# A refused question",
  "",
  '<Elicit schema={{ type: "number" }} as="answer">Outside the form language.</Elicit>',
  "",
].join("\n");

/** One entry that was stopped part-way, and what it had done by then. */
const STOPPED = [
  "```js eval",
  'output("Rounding tax once, after the items are summed.");',
  "```",
  "",
].join("\n");

/** Where the last root close of one journal is. */
function lastClose(events: readonly DurableEvent[]): number {
  const closes = events
    .map((event, at) => ({ event, at }))
    .filter((one) => one.event.type === "close");
  const last = closes[closes.length - 1];
  if (last === undefined) {
    throw new Error("this journal holds no close");
  }
  return last.at;
}

/**
 * Four entries whose outcomes are the four a reading can hold at once, with the
 * fourth still running.
 *
 * Every one of them really executed. The third's root close is rewritten as a
 * cancelled one — the shape an interrupted entry's record has, and the same
 * rewrite the entries regressions use — because an entry that stopped is a
 * record this screen must be able to read, not an execution a fixture can
 * perform.
 */
export function* checkpointStateModel(): Operation<ReplModel> {
  const first = new InMemoryStream();
  yield* runEntry(first, COMPLETED);
  const afterFirst = yield* first.readAll();

  const second = new InMemoryStream([...afterFirst]);
  yield* runEntry(second, FAILING, entryInitialBindings(projected(afterFirst)));
  const afterSecond = yield* second.readAll();

  const third = new InMemoryStream([...afterSecond]);
  yield* runEntry(third, STOPPED, entryInitialBindings(projected(afterSecond)));
  const ran = yield* third.readAll();
  const stopped = ran.map((event, at) =>
    at === lastClose(ran) ? { ...event, result: { status: "cancelled" as const } } : event,
  );

  const fourth = new InMemoryStream([...stopped]);
  yield* runEntry(fourth, RUNNING_SOURCE, entryInitialBindings(projected(stopped)));
  const whole = yield* fourth.readAll();
  return projected(whole.slice(0, lastClose(whole)));
}

/** The schema this screen's question is asked through. */
const QUESTION_SCHEMA: Json = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["rule"],
  properties: Object.freeze({
    rule: Object.freeze({ type: "string", title: "Rounding rule" }),
  }),
});

/** The key the live question and the open form both name. */
export const CHECKPOINT_QUESTION = "ask-1";

/**
 * The Sidekick's waiting question, as the product's own parser reads it.
 *
 * Compiled from the schema above through `readQuestionForm`, so the form this
 * screen draws is one the REPL's form language actually supports — a form
 * asserted into shape would draw fields the parser would have refused.
 */
export const CHECKPOINT_QUESTION_FORM: ReplQuestionForm = readQuestionForm(QUESTION_SCHEMA);

/** The same Sidekick, with a question of its own waiting to be answered. */
export const CHECKPOINT_ASKING: ReplLive = Object.freeze({
  ...CHECKPOINT_LIVE,
  sidekick: Object.freeze({
    ...CHECKPOINT_SIDEKICK,
    question: Object.freeze({
      key: CHECKPOINT_QUESTION,
      message: "Which rounding rule should the tax use?",
      form: CHECKPOINT_QUESTION_FORM,
    }),
  }),
});

/**
 * More pending messages than the tray can show at once, and every outcome a
 * reading can hold associated with the conversation.
 *
 * Two entries behind each exchange, which is what lets one screen show a
 * completed, a failed, an interrupted and a running association together
 * rather than asking for four screens of one outcome each.
 */
export const OVERFLOW_WORKSPACE: ReplWorkspace = Object.freeze({
  queueOffset: 0,
  ...CHECKPOINT_WORKSPACE,
  work: Object.freeze([
    Object.freeze({ message: "chat:response:1", entry: "entry-1" }),
    Object.freeze({ message: "chat:response:1", entry: "entry-2" }),
    Object.freeze({ message: "chat:response:2", entry: "entry-3" }),
    Object.freeze({ message: "chat:response:2", entry: "entry-4" }),
  ]),
  queued: Object.freeze([
    ...CHECKPOINT_WORKSPACE.queued,
    Object.freeze({
      key: "q4",
      origin: Object.freeze({ kind: "ui" as const }),
      text: "Re-run the checkout tests once the draft is submitted.",
    }),
    Object.freeze({
      key: "q5",
      origin: Object.freeze({ kind: "acp" as const, attachment: "ci-bot" }),
      text: "Summarize what changed in checkout.md for the release notes.",
    }),
    Object.freeze({
      key: "q6",
      origin: Object.freeze({ kind: "ui" as const }),
      text: "Then say what an empty cart renders.",
    }),
  ]),
});

/** The same tray, moved so a message the first window hid is the one shown. */
export function queueAt(offset: number): ReplWorkspace {
  return Object.freeze({ ...OVERFLOW_WORKSPACE, queueOffset: offset });
}

/**
 * More queued messages than the tray's budget, each short enough to be one row.
 *
 * The other way a tray overflows, and the one that decides where its width
 * comes from. `OVERFLOW_WORKSPACE` overflows because six messages wrap into
 * twenty rows: before anything is fitted it is six rows, which the tray has
 * room for. These nine are nine rows before fitting and nine after, so the
 * tray is already over its budget in the pass that is still asking how wide a
 * queued message's text may be — and a queue measured at no width is a queue
 * with no fitted rows for any later pass to admit.
 */
export function crowdedQueue(count: number, offset = 0): ReplWorkspace {
  const first = OVERFLOW_WORKSPACE.queued[0];
  if (first === undefined) {
    throw new Error("this tray holds no message to crowd");
  }
  return Object.freeze({
    ...OVERFLOW_WORKSPACE,
    queueOffset: offset,
    queued: Object.freeze(
      Array.from({ length: count }, (_, at) =>
        Object.freeze({ ...first, key: `crowd-${at}`, text: `queued note ${at}` }),
      ),
    ),
  });
}

/** The last queued message, which no window at any review size shows first. */
export function lastQueued(): ReplQueuedMessage {
  const last = OVERFLOW_WORKSPACE.queued[OVERFLOW_WORKSPACE.queued.length - 1];
  if (last === undefined) {
    throw new Error("this tray holds no messages");
  }
  return last;
}

/**
 * The same reading with its conversation held at one position.
 *
 * The chat ordinarily follows its newest rows, so a reader looking at an
 * earlier outcome has stopped following: this is that reader's own state.
 */
export function chatAt(
  model: ReplModel,
  offset: number,
  options: CheckpointOptions = {},
): ReplState {
  const base = checkpointState(model, { ...options, state: undefined });
  const chat = CHECKPOINT_SIDEKICK.reading ?? "";
  return Object.freeze({
    ...base,
    viewports: Object.freeze({
      ...base.viewports,
      sidekick: Object.freeze({ ...base.viewports.sidekick, [chat]: offset }),
      sidekickFollowing: Object.freeze({ ...base.viewports.sidekickFollowing, [chat]: false }),
    }),
  });
}

/** The state the checkpoint reads: the nested scope selected, both texts typed. */
export function checkpointState(model: ReplModel, options: CheckpointOptions = {}): ReplState {
  if (options.state !== undefined) {
    return options.state;
  }
  const base = initialState(CHECKPOINT_EXECUTION);
  return Object.freeze({
    ...base,
    draft: CHECKPOINT_DRAFT,
    message: CHECKPOINT_MESSAGE,
    route: Object.freeze({
      ...base.route,
      right: "sidekick" as const,
      surface: options.surface ?? base.route.surface,
      ...(options.sidekick === true ? { view: "sidekick" as const } : {}),
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
export function checkpointViewOf(
  model: ReplModel,
  focused: string | undefined,
  options: CheckpointOptions = {},
): ReplView {
  const resolved = viewFor(
    checkpointState(model, options),
    model,
    options.live ?? CHECKPOINT_LIVE,
    options.size ?? CHECKPOINT_SIZE,
    focused,
    navigationOf(model.checkpoints, "live"),
  );
  if (!resolved.ok) {
    throw resolved.error;
  }
  return withWorkspace(resolved.value, options.workspace ?? CHECKPOINT_WORKSPACE);
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
 * The first frame carries no focused key, so the Draft takes focus on its own
 * exactly as it does when a command opens. The tree is then asked where focus
 * actually ended up, and the frame under review is composed with that answer —
 * so the cue drawn on the Draft is the cue of the control a keystroke reaches,
 * rather than a label a fixture asserted into the view.
 *
 * One presenter, one tree and one grid throughout, because this renderer writes
 * diffs: the screen is what the frames have left in the grid together.
 */
export function* commitCheckpoint(
  presenter: Presenter,
  options: CheckpointOptions = {},
): Operation<CheckpointFrame> {
  const model = options.model ?? (yield* checkpointModel());
  // The opening frame, where the Draft's own claim takes focus — and only
  // where nobody is carrying focus already. A caller resizing a screen passes
  // the tree's current answer instead, because offering the opening claim again
  // at every size would restore the Draft rather than keep what was focused.
  if (options.focused === undefined) {
    yield* presenter.commit(checkpointViewOf(model, undefined, options));
  }
  const node = presenter.tree.focused();
  const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
  const view = checkpointViewOf(model, focused, options);
  const observed = yield* presenter.commit(view);
  return { model, view, focused, observed };
}

/**
 * One reading a person has actually moved to, seeded once.
 *
 * The exact position this model holds, the entry and nested scope selected
 * under it, and texts neither composer started with — so a frame that rebuilt
 * the default reading instead of carrying this one is visibly a different
 * screen.
 */
export function seededState(model: ReplModel, options: CheckpointOptions = {}): ReplState {
  const base = checkpointState(model, { ...options, state: undefined });
  return Object.freeze({
    ...base,
    draft: SEEDED_DRAFT,
    message: SEEDED_MESSAGE,
    // The position this model was projected at, which is the only one
    // resolution accepts: a route naming any other marker is refused until the
    // prefix it names has been projected, and inspecting one needs a position
    // to inspect. An earlier retained marker is not an option for this screen
    // either — a view frozen at a prefix shows nothing of the present, and the
    // question, the tray and the running entry this screen is made of are all
    // present rather than recorded.
    route: Object.freeze({ ...base.route, at: model.selection }),
  });
}

/** The Draft text the seeded reading carries, which no default supplies. */
export const SEEDED_DRAFT = "<Checkout cart={cart} coupon={coupon} />";

/** The composer text the seeded reading carries. */
export const SEEDED_MESSAGE = "And say what the coupon does to the total.";
