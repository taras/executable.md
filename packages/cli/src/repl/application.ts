/**
 * Own screen state and reduce semantic actions against one resolved model prefix
 * and this process's live overlay. Components receive detached view data, with
 * no session, repository, route mutator or host operation.
 *
 * A frozen prefix fills nothing from the live head: no output, waiting question
 * or pause capability. Navigation resolves a whole candidate route before
 * adoption; a refusal preserves the standing route, selection and draft.
 */

import { VIEWPORT } from "./components/viewport.ts";

import { boundaries, caretFor, eraseAt, insertAt } from "./caret.ts";
import type { ReplCaret } from "./caret.ts";

import type { MessageOrigin } from "./sidekick/history.ts";
import { Ok, type Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { AgentOption, AgentOptions, SessionConfiguration } from "@executablemd/core";

import {
  describe as describeNode,
  fields,
  readDescription,
  runText,
  tokenRuns,
} from "./description.ts";
import type { ReplComponent, ReplDescription, ReplTokenRun, ReplViewData } from "./description.ts";
import {
  actionRowProps,
  bandProps,
  bodyProps,
  insetBodyProps,
  headerBandProps,
  headerRowProps,
  headerTitleProps,
  box,
  columnProps,
  COLUMN_TOP_GAP,
  stackProps,
  CONTROL_PROPS,
  drawerLayerProps,
  drawerRect,
  sidekickDrawerRect,
  footerProps,
  inspectionWidth,
  paneColumnProps,
  paneContentProps,
  paneProps,
  NARROW,
  profileFor,
  refusalProps,
  refusalText,
  rootProps,
  rowProps,
  sharedColumnRows,
  sidebarWidth,
  tabProps,
  tabRowProps,
  viewportProps,
  bandRowProps,
  BODY_GUTTER,
  fittedPartProps,
  fittedRowProps,
  flatten,
  GROWING_STACK_PROPS,
  inlineActionRowProps,
  partsRowProps,
  SPACER_PROPS,
  statedActionRowProps,
  statedPartProps,
  WORKSPACE_DRAFT_GAP,
  WORKSPACE_DRAFT_ROWS,
  WORKSPACE_LIST_GUTTER,
  WORKSPACE_QUEUE_ROWS,
  workspaceBodyRows,
  TAB_GAP,
  workspaceBlockProps,
  bandBlockProps,
  workspaceBodyProps,
  workspaceColumnProps,
  workspaceConversationWidth,
  workspaceHeaderProps,
  workspaceInsideWidth,
  workspaceTranscriptWidth,
  workspaceWorkWidth,
} from "./layout.ts";
import type {
  ReplBounds,
  ReplBox,
  ReplBoxProps,
  ReplLayoutManifest,
  ReplRegion,
  ReplViewportSlot,
} from "./layout.ts";
import {
  admitActions,
  admitRows,
  capacityOf,
  NOTHING_ADMITTED,
  scrolled,
} from "./layout-admission.ts";
import type { ReplAdmission, ReplWindow } from "./layout-admission.ts";
import { ORDINARY, REPL_PALETTE, styleOf } from "./presentation-style.ts";
import { placeScreen } from "./screen-regions.ts";
import type { ReplPresentationRole, ReplRowStyle } from "./presentation-style.ts";
import { jsonRuns, sourceRuns } from "./presentation-text.ts";
import { HEAD_LABELS, NO_NAVIGATION, numbered, pointLabel } from "./navigation.ts";
import type { ReplHistoryNavigation } from "./navigation.ts";
import { blankBand, EMPTY_BAND } from "./history-rail.ts";
import type { ReplPreparedRail } from "./history-rail.ts";
import { entryReading, NO_READING } from "./source-reading.ts";
import type { ReplReading } from "./source-reading.ts";
import { readingRuns } from "./fitting.ts";
import type {
  ReplEditor,
  ReplFittedLabel,
  ReplFittedLine,
  ReplPreparedReading,
  ReplPreparedRow,
} from "./fitting.ts";
// The one gate, reached from here as well as from the root. A pure decision
// module: no session, no repository, no resolver and no authority crosses it,
// so the reduction stays a reduction while still refusing on exactly the terms
// the root admits on.
import { cleared, clearedMessage, edited, initialRevisions, submittable } from "./sidekick/gate.ts";
import type { Instruction, Reservation, Revisions, Submitter } from "./sidekick/gate.ts";
import type { ReplTerminalSize } from "./terminal.ts";
import { decodeLocation, encodeLocation, resolveLocation, surfaceForDrawer } from "./route.ts";
import type {
  ReplDrawerRef,
  ReplLiveAvailability,
  ReplRoute,
  ReplSelection,
  ReplSidekickAvailability,
  ReplSurface,
} from "./route.ts";
import type {
  ReplAgentPermission,
  ReplAgentTurn,
  ReplEntry,
  ReplModel,
  ReplRow,
  ReplScope,
} from "./model.ts";
import type { ReplFormField, ReplQuestion, ReplQuestionForm } from "./elicitation.ts";
import type {
  ReplAgentReading,
  ReplAgentSlot,
  ReplLiveChoice,
  ReplLivePermission,
  ReplLiveTurn,
  ReplLiveTurnState,
} from "./agent.ts";
import type { ExpansionState } from "./expansion.ts";
import type { ReplTree } from "./reconcile.ts";
import {
  DRAWER,
  READING,
  FIELD,
  fieldParts,
  fieldLabel,
  fieldText,
  focusPrefixed,
  LINE,
  REFUSAL,
  SELECT_ROW,
} from "./components/rows.ts";
import type { ReplAction, ReplFieldPurpose } from "./components/actions.ts";
import { NO_LIFECYCLE } from "./lifecycle.ts";
import type { ReplLifecycleReading } from "./lifecycle.ts";

export type { ReplAction };

/** What this process holds that the Journal does not. */
export interface ReplLive {
  /** Output no recorded outcome has replaced yet. */
  readonly output: string;
  /** The question waiting right now, or none. */
  readonly question: ReplQuestion | undefined;
  readonly expansion: ExpansionState;
  /** Whether this process holds the continuations, and so may pause at all. */
  readonly pausable: boolean;
  /**
   * The submission being prepared for the next entry, where there is one.
   *
   * Present from the moment a submission reserves the next slot until its entry
   * exists or its refusal arrives. It is what makes Pause available during a
   * preflight that suspends: the person who pressed Run can ask that entry to
   * stop before it expands anything, without waiting to find out whether it
   * was admitted.
   *
   * Absent — rather than a preparation nothing is preparing — because the
   * difference between "a submission is in flight" and "none is" is the whole
   * fact. Preparation is not execution: an entry that does not exist yet is not
   * running, paused, admitted or settled, and this adds no history-head state.
   */
  readonly preparing?: ReplPreparing;
  /**
   * Whether an entry's execution is still running in this process.
   *
   * The durable side cannot answer this. A root close is recorded the moment the
   * document settles, while the task that produced it is still unwinding — so a
   * screen reading only `model.settled` would offer the next entry during a
   * teardown that has not finished, and announce readiness the session would
   * refuse. Readiness is a fact about both halves, and this is the live half.
   */
  readonly running: boolean;
  /**
   * What this process knows about Agent work no record holds yet.
   *
   * Empty for a replay, a document with no Agent work and a frozen prefix — a
   * live reading describes work this process is doing, and none of those is.
   */
  readonly agent: ReplAgentReading;
  /**
   * What this process is doing element by element, for the entry that is open.
   *
   * Empty wherever a live reading has nothing to say: a replay, a document
   * with no element in flight, and every frozen prefix. What is here is what
   * this process watched happen, which is why retained syntax and a recorded
   * admission add nothing to it.
   */
  readonly lifecycle: ReplLifecycleReading;
  /**
   * What this process's Sidekick says, where this screen has one.
   *
   * Optional because a frame can be built without one — a measurement, a
   * refusal, a proof about the reducer — and an absent Sidekick draws no chat
   * rather than an empty one.
   */
  readonly sidekick?: ReplSidekickReading;
}

/**
 * One row of acknowledged chat, as the screen reads it.
 *
 * Detached values. A row carries no record, no response handle and no operation,
 * so what is drawn is what the chat history says and a component cannot reach
 * past it. `key` is its mounted identity, which is what keeps focus on the row a
 * reader left it on when the next reply arrives.
 */
export interface ReplSidekickChatRow {
  readonly origin?: MessageOrigin;
  /**
   * The saved request this failed attempt could be asked again, or none.
   *
   * Present only where the history establishes which request failed — a turn
   * whose association is unknown, or one that did not fail, offers nothing,
   * because asking again would be guessing about a turn that really happened.
   */
  readonly retry?: { readonly conversation: string; readonly message: number };
  /**
   * The row holding the person request this reply answered, or none.
   *
   * Present only on a `reply`, and only where the history's own request
   * boundaries establish which request this turn carried. It exists for the
   * one case where this row is not drawn: a successful reply that said nothing
   * to a person contributes no utterance, and a reader sent to that turn is
   * shown the request it answered rather than a row nothing drew. Derived
   * presentation, never an identity anything durable holds.
   */
  readonly request?: string;
  readonly key: string;
  /**
   * The chat this row belongs to.
   *
   * Every chat's rows are composed, and which of them is drawn is the reading
   * this location selects — because selecting a saved chat has to be able to
   * show a chat this process is not continuing, and a reading that held only
   * the current one could not.
   */
  readonly conversation: string;
  /**
   * The saved turn this row is about, or none where none is established.
   *
   * None is unknown rather than unsent, exactly as the history's own reading
   * has it: a request whose canonical record never landed may well have been
   * accepted. It is what a selected turn is found by, because a title names
   * nothing — two turns may read identically.
   */
  readonly turn: number | null;
  /**
   * Whose turn this was, and what kind of account it is.
   *
   * `incomplete` is deliberately its own kind rather than a reply with a flag:
   * it is source nobody finished writing, performed no control, and saying it
   * was a reply would present an attempt as an account of one.
   *
   * `preview` is what a turn is saying *now*: literal Output from source that
   * has arrived and has been cleared, with nothing evaluated, nothing performed
   * and nothing saved. It is not a reply and is never presented as one — and it
   * carries the same `key` the reply that replaces it will, so a response is
   * one item on the screen from its first word to its last.
   *
   * `saved` is the inert one: a turn the provider finished and whose evaluated
   * reply nobody recorded. It is the turn, in its own place, saying exactly
   * that — never a reply rebuilt from its source and never a person's words.
   */
  readonly kind: "person" | "reply" | "incomplete" | "preview" | "saved";
  readonly text: string;
  /** Whether a reply selected person-facing chat at all. */
  readonly hasOutput: boolean;
  /** Why an incomplete attempt stopped, in the terms its record holds. */
  readonly failure: string | undefined;
  /**
   * A live candidate whose generation ended with nothing saved.
   *
   * Only on a `preview` row. What the agent said is still true; what is not
   * true is that any turn, acceptance or recorded failure came of it, so the
   * row says it did not finish instead of reporting either.
   */
  readonly incomplete?: boolean;
  /**
   * A saved turn that carried a previous response's results.
   *
   * Only on a `saved` row, and what makes it readable as agent work rather
   * than as something a person said: its request is this host's own account of
   * what a reply did, so it is labelled rather than quoted.
   */
  readonly automatic?: boolean;
}

/**
 * What this process's Sidekick says about itself, as the screen reads it.
 *
 * Facts, not a capability: the screen draws them and produces ordinary actions,
 * and the root is the only thing that can act. Absent — rather than an empty
 * chat — where a frame is built without one, because "this screen has no
 * Sidekick" and "this Sidekick has said nothing" are different, and an empty
 * reading would present the first as the second.
 */
/**
 * One Sidekick turn as the Sessions surface shows it, live or saved.
 *
 * Beside {@link ReplSessionTurn} rather than folded into it, because the two
 * have different owners: an entry turn is read at the history position its
 * record holds, and a Sidekick turn is read by opening the chat that contains
 * it. One type for live and saved work for the same reason the entry one is —
 * a person is looking at one turn either way, and `key` survives publication so
 * the row they had focus on is the same row afterwards.
 */
export interface ReplSidekickTurnRow {
  /** The mounted identity: this process's response, or the saved turn's own. */
  readonly key: string;
  /** The chat this turn belongs to, which is what activating it opens. */
  readonly conversation: string;
  /** The agent that answered in that chat, from that chat and this turn. */
  readonly agent: string;
  /** Its canonical ordinal, or none for work no record holds yet. */
  readonly turn: number | null;
  /**
   * What this turn is called.
   *
   * A person's exact saved message, or that it was automatic feedback. A
   * machine input, a bootstrap, a reference chapter and a control argument are
   * none of them something anybody said, so none of them appears here.
   */
  readonly title: string;
  /** How far it has got, in the owner's own terms. */
  readonly state: string;
  /** Whether it is work in flight rather than a saved account of work. */
  readonly running: boolean;
  /** Whether it failed, so the row reads as the failure it is. */
  readonly failed: boolean;
  /**
   * The provider conversation this turn names, or none.
   *
   * None has no filter membership at all, which is a different answer from an
   * empty conversation: such a turn appears under All and nowhere else.
   */
  readonly sessionKey: string | undefined;
  /** What it said to a person, which may be nothing. */
  readonly text: string;
  /** Why it did not succeed, when it did not. */
  readonly failure: string | undefined;
}

/**
 * How far one chat's own setup got, for a chat being read rather than continued.
 *
 * A conversation is `activated` before it may be prompted. One left `prepared`
 * was interrupted while it was being set up, and a `failed` one preserved the
 * association before it and kept the reason. Either is a real saved chat a
 * location may select and a reader may open — and what such a chat holds is
 * that status, not an absence of messages, so the pane says it.
 */
export interface ReplSidekickSetup {
  readonly phase: "prepared" | "activated" | "failed";
  /** Why setup failed, where a reason was recorded. */
  readonly failure: string | undefined;
}

/**
 * One acknowledged Submit, as the coordinates that identify what it admitted.
 *
 * A detached reading of a record this history already holds, carrying no
 * handle, no source to re-run and nothing a caller could reach a writer
 * through: which chat and which response performed the control, which entry
 * slot it reserved, which entry key it named and the exact source it reserved
 * that slot with.
 *
 * All five, because a retained intent is not by itself an admission. The slot
 * says where in this history the reservation was taken, the key says what it
 * named, and the source says what it reserved — an entry that is not the one
 * this reservation named, or not at the slot it took, or not holding the source
 * it reserved, is a different entry and this Submit admitted nothing a reader
 * may be shown.
 */
export interface ReplSidekickSubmit {
  readonly conversation: string;
  readonly response: string;
  /** How many entries preceded the reservation, which names the slot. */
  readonly ordinal: number;
  readonly entry: string;
  readonly source: string;
  /** Whether this history retained what became of it. */
  readonly settled: boolean;
  /**
   * Whether that retained outcome observed an entry this control admitted.
   *
   * The history's own answer, written by the only thing that knew: a Submit
   * observes its entry once it has one to observe, a submission refused before
   * any entry started observes nothing, and a late reconciliation of a
   * reservation nobody resolved writes the entry it found or nothing where it
   * found the slot was never taken.
   *
   * Separate from whether what was admitted then succeeded. An entry that ran
   * and failed was still admitted by the control that submitted it.
   */
  readonly admitted: boolean;
}

export interface ReplSidekickReading {
  /**
   * Every Submit this history acknowledged, in its own record order.
   *
   * Beside the chat rather than inside it, because they answer different
   * questions: a chat row is what a conversation said, and this is what a reply
   * of that conversation actually did to this execution's entries. Absent is a
   * reading that establishes none — not a reading that establishes there were
   * none, which is why nothing reads its absence as an empty list of facts.
   */
  readonly submits?: readonly ReplSidekickSubmit[];
  /**
   * Every chat's acknowledged rows, oldest first, each naming its own chat.
   *
   * All of them rather than the current one's, because the reading this screen
   * draws is the chat the location selects — and that may be a chat this
   * Sidekick is no longer continuing.
   */
  readonly chat: readonly ReplSidekickChatRow[];
  /** Whether a cycle is running, so a second Send refuses rather than queueing. */
  readonly busy: boolean;
  /** The agent the chat being read was held with. */
  readonly agent: string;
  /**
   * Every Sessions row this execution's Sidekick holds, in its history's order.
   *
   * Across every chat, because that is what the section shows: Sidekick work
   * outlives an agent change, and a list that stopped at the current chat would
   * lose the conversations somebody came to Sessions to find.
   */
  readonly turns: readonly ReplSidekickTurnRow[];
  /**
   * The chat whose rows are drawn, which is the selected one or the current one.
   *
   * None where this Sidekick has held none at all.
   */
  readonly reading: string | undefined;
  /**
   * Whether that chat is the one this Sidekick is actually continuing.
   *
   * What decides whether the pane has its usual controls. A chat that is not
   * the active association is read-only: it has no composer, no Send, no
   * Retry, no Configure and no pending question addressing it, because a
   * reading of acknowledged history is not a conversation anybody may continue.
   */
  readonly current: boolean;
  /**
   * What a location may name about this Sidekick, for resolving one.
   *
   * The same facts the route validates against and the same ones the filter
   * offers, so a key a control offers is a key a location resolves.
   */
  readonly availability: ReplSidekickAvailability;
  /**
   * Why this chat cannot be read, when that is the answer.
   *
   * A refusal rather than an empty chat: showing somebody no conversation for a
   * file that holds one is the single answer that cannot be corrected later.
   */
  readonly refusal: string | undefined;
  /**
   * The question this conversation is waiting on an answer to, or none.
   *
   * Facts and a name, never the question itself: `submit` is the root's, and a
   * component holding it would be a second way to answer, answerable to nobody.
   */
  readonly question: ReplSidekickQuestion | undefined;
  /** The conversation these facts are about, for a control that names it. */
  readonly conversation: string | undefined;
  /**
   * How far the setup of the chat being read got, or none where there is no
   * such chat to say it of.
   *
   * The chat being *read*, not the active association: a reader who opened an
   * interrupted or failed chat is owed that chat's own status, and the active
   * one's would describe a different conversation.
   *
   * Optional as well as absent, like the location's own Sidekick availability:
   * a reading assembled without it establishes no chat's setup, which is the
   * same thing absence means. Nothing reads it as a default.
   */
  readonly setup?: ReplSidekickSetup | undefined;
  /**
   * What this conversation has been *asked* to run under, or none.
   *
   * A preference somebody saved, read back out of the history. It says what
   * was requested and nothing more: the next turn is where it is applied, and
   * an agent may still refuse it there.
   */
  readonly requested: SessionConfiguration | undefined;
  /**
   * What this conversation was last actually running under, or none.
   *
   * Core's own saved account of a turn that started. Shown beside the request
   * rather than instead of it, because they answer different questions: one is
   * what somebody asked for, the other is what an agent was verified on. Where
   * there is no saved verification, there is nothing to show.
   */
  readonly verified: SessionConfiguration | undefined;
}

/**
 * The Sidekick's pending question, as the screen reads it.
 *
 * `key` is this process's own name for the exact pending object. It has to be:
 * a reply may answer one question and ask another with the same words and the
 * same schema, so text, shape or a count would all name whichever question
 * happened to be pending by the time a keystroke arrived.
 */
export interface ReplSidekickQuestion {
  readonly key: string;
  readonly message: string;
  readonly form: ReplQuestionForm;
}

/**
 * One submission on its way to becoming an entry, as the screen reads it.
 *
 * Facts, not a capability: the screen says what is being prepared and produces
 * the ordinary Pause action, and the root resolves that action against whatever
 * the target actually is. A preparation that handed the screen something to
 * call would be a second way to stop expansion, answerable to nobody.
 */
export interface ReplPreparing {
  /**
   * Whether Pause has already been asked for and has not yet stopped anything.
   *
   * It stays true across the handoff to the entry: the request is answered when
   * that entry holds, not when it starts, so a screen that cleared this at
   * startup would say `preparing` again about work already asked to stop.
   */
  readonly requested: boolean;
}

/**
 * One live or retained Sessions turn. Publication changes its source of facts;
 * `key` preserves mounted identity and focus across that transition.
 */
export interface ReplSessionTurn {
  /** The mounted identity: this process's slot, or a record's own marker. */
  readonly key: string;
  readonly prompt: string;
  /** `retained` once a record holds it, and the live states until then. */
  readonly state: ReplLiveTurnState | "retained";
  readonly text: string;
  readonly agent: string | undefined;
  /**
   * The conversation this turn joined, or none.
   *
   * None means the provider has not said yet — a queued turn — or never did.
   * Either way there is no conversation to filter it by, and the authored
   * Session name is not one.
   */
  readonly sessionKey: string | undefined;
  readonly status: "completed" | "failed" | "cancelled" | undefined;
  readonly stopReason: string | undefined;
  readonly failure: string | undefined;
  /** The history position this turn is recorded at, once it has one. */
  readonly marker: string | undefined;
  /** The request waiting on this turn right now, when one is. */
  readonly request: ReplLivePermission | undefined;
  /** What this turn was granted, once its record holds the audit. */
  readonly audits: readonly ReplAgentPermission[];
}

/**
 * Order turns by Prompt scheduling, not publication: concurrent providers can
 * publish a later Prompt first. Unobserved turns belong to the replayed prefix
 * and precede observed slots, whose own scheduling order is retained.
 */
function chronology(model: ReplModel, live: ReplLive): readonly ReplSessionTurn[] {
  const observed = new Set<string>();
  for (const slot of live.agent.slots) {
    if (slot.durable !== undefined) {
      observed.add(correlation(slot.entry, slot.durable));
    }
  }
  const shown: ReplSessionTurn[] = [];
  for (const turn of model.turns) {
    if (!observed.has(correlation(turn.entry, turn.name))) {
      shown.push(retainedTurn(turn.marker, turn));
    }
  }
  for (const slot of [...live.agent.slots].sort((left, right) => left.order - right.order)) {
    const turn = resolved(slot, model, live);
    if (turn !== undefined) {
      shown.push(turn);
    }
  }
  return Object.freeze(shown);
}

/**
 * Correlate by each slot's and record's own entry plus durable Prompt name.
 * Names restart in every entry, so name alone conflates repeated source; the
 * current entry, sequence and completion order cannot identify a publication.
 */
function correlation(entry: string, name: string): string {
  return `${entry}\u0000${name}`;
}

/** What one observed slot shows now: its record, or the turn as it still stands. */
function resolved(
  slot: ReplAgentSlot,
  model: ReplModel,
  live: ReplLive,
): ReplSessionTurn | undefined {
  if (slot.durable === undefined) {
    const turn = live.agent.turns.find((candidate) => candidate.key === slot.key);
    return turn === undefined ? undefined : liveTurn(slot.key, turn, live);
  }
  const record = model.turns.find(
    (candidate) => candidate.entry === slot.entry && candidate.name === slot.durable,
  );
  if (record !== undefined) {
    // Keyed by the slot, not by the marker: this is the row it already was.
    return retainedTurn(slot.key, record);
  }
  // Accounted for here before the history it belongs to was projected. The facts
  // it had are still the facts, and a row that vanished for this one frame is
  // the turn a person was reading disappearing under them.
  return slot.last === undefined ? undefined : liveTurn(slot.key, slot.last, live);
}

function liveTurn(key: string, turn: ReplLiveTurn, live: ReplLive): ReplSessionTurn {
  return Object.freeze({
    key,
    prompt: turn.prompt,
    state: turn.state,
    text: turn.text,
    agent: turn.agent,
    sessionKey: turn.sessionKey,
    status: turn.status,
    stopReason: turn.stopReason,
    failure: turn.failure,
    marker: undefined,
    request: live.agent.requests.find((request) => request.turn === turn.key),
    audits: Object.freeze([]),
  });
}

function retainedTurn(key: string, turn: ReplAgentTurn): ReplSessionTurn {
  return Object.freeze({
    key,
    prompt: turn.input,
    state: "retained",
    text: turn.text,
    agent: turn.agent,
    sessionKey: turn.sessionKey.length === 0 ? undefined : turn.sessionKey,
    status: turn.status,
    stopReason: turn.stopReason,
    failure: turn.failure,
    marker: turn.marker,
    // A record cannot be waiting on anybody: what it holds is what it was
    // granted, and it is read rather than answered.
    request: undefined,
    audits: turn.permissions,
  });
}

/**
 * The conversations this screen offers to filter by, earliest turn first.
 *
 * Earliest, never latest activity: a list that reordered itself when a provider
 * streamed would move the control somebody was reaching for.
 */
function conversations(turns: readonly ReplSessionTurn[]): readonly string[] {
  const keys: string[] = [];
  for (const turn of turns) {
    const key = turn.sessionKey;
    if (key !== undefined && key.length > 0 && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return Object.freeze(keys);
}

/** A process running no Agent work, which is what a frozen view also shows. */
export const NO_AGENT: ReplAgentReading = Object.freeze({
  turns: Object.freeze([]),
  requests: Object.freeze([]),
  slots: Object.freeze([]),
});

/** One thing the last submission said was wrong, as a reader sees it. */
export interface ReplFormMessage {
  /** The field it belongs to, or none for the object as a whole. */
  readonly field: string | undefined;
  readonly message: string;
}

/**
 * Form state is process-local and discarded when the question or drawer ends.
 * Values are keyed by field so editing one cannot overwrite another.
 */
export interface ReplFormState {
  readonly carets?: Readonly<Record<string, ReplCaret>>;
  /** What has been typed into each field so far, by field name. */
  readonly values: Readonly<Record<string, string>>;
  /** Which field text and Backspace act on, or none yet. */
  readonly field: string | undefined;
  /** What the last submission was told was wrong. */
  readonly messages: readonly ReplFormMessage[];
  /** How far the read-only message region has been scrolled, in lines. */
  readonly offset: number;
}

/**
 * What one explicit inspection advertised, and what it was read for.
 *
 * Bound to the conversation, the agent and — for effort — the exact model it
 * was read against. Effort levels belong to a model, so a list read for one
 * model says nothing about another; and a result that arrives after somebody
 * has selected something else is a result for a question nobody is asking any
 * more. Keeping the identity beside the choices is what lets a late one be
 * ignored rather than drawn.
 */
export interface ReplOffered {
  readonly conversation: string;
  readonly agent: string;
  /** The models this agent offers, as it names them. */
  readonly models: readonly ReplOfferedChoice[];
  /** The effort levels of one exact model, when they have been read. */
  readonly effort:
    | { readonly model: string; readonly levels: readonly ReplOfferedChoice[] }
    | undefined;
}

/** One value a provider offers, in the provider's own words. */
export interface ReplOfferedChoice {
  /** The exact id a configuration names, which is what is saved. */
  readonly id: string;
  /** What the agent calls it for a reader, which is never what is saved. */
  readonly name: string;
  readonly description: string | undefined;
  /** The heading the agent filed it under, for an agent that groups them. */
  readonly group: string | undefined;
}

/**
 * The Configure drawer's own state, while this screen has one.
 *
 * Process-local, like the question form beside it: which choices somebody has
 * made and not yet applied, what the last Apply was told, and what an
 * inspection advertised are all facts about this process holding a drawer open.
 * None of it is in the location or in any record, and reopening initializes
 * from the saved preferences rather than from anything remembered here.
 *
 * `conversation` binds the whole of it. A replacement, or any other change of
 * active conversation, invalidates these choices rather than carrying them
 * over: they were made about an agent and a conversation, and neither survives
 * being pointed at another one.
 */
export interface ReplConfiguring {
  readonly caret?: ReplCaret;
  readonly conversation: string | undefined;
  readonly open: boolean;
  /** The agent name as typed, exactly — never a value chosen from a list. */
  readonly agent: string;
  /** The model this would ask for, or none because it asks for no change. */
  readonly model: string | undefined;
  /** The effort this would ask for, which belongs to `model`. */
  readonly effort: string | undefined;
  /** Whether the agent field is the one text acts on. */
  readonly naming: boolean;
  /** Why the last Apply did not happen, for the drawer to say. */
  readonly refusal: string | undefined;
  /** What an explicit inspection advertised, where one has answered. */
  readonly offered: ReplOffered | undefined;
  /** Whether an explicit inspection is being waited on right now. */
  readonly reading: boolean;
  /**
   * Which selection this is, counted up and never reused.
   *
   * An Apply's answer belongs to the selection that asked for it, and *which*
   * one that was cannot be told from its values: a drawer deliberately
   * reopened on the saved preference holds the same model and effort as the
   * Apply that saved it, and a drawer whose agent was edited while a save ran
   * holds the same model and effort it was applied with. So an Apply carries
   * this number, and an answer naming an earlier one leaves the drawer alone.
   */
  readonly revision: number;
}

/** A Configure drawer nobody has opened. */
export const NOT_CONFIGURING: ReplConfiguring = Object.freeze({
  conversation: undefined,
  open: false,
  agent: "",
  model: undefined,
  effort: undefined,
  naming: false,
  refusal: undefined,
  offered: undefined,
  reading: false,
  revision: 0,
});

/**
 * The Sidekick's own question form, and whether its drawer is showing.
 *
 * Beside the entry's form rather than sharing it. The two are two questions
 * with two owners: an entry's form is discarded when its drawer closes, and
 * this one is not — somebody who closes the Sidekick's form to read the
 * transcript has not thrown their half-filled answer away. Sharing one slot
 * would make either rule wrong for the other owner.
 *
 * `key` binds the form to the exact question it was filled in for, so a reply
 * that asks again starts empty rather than inheriting the last one's values.
 * None of it is durable and none of it is in the route.
 */
export interface ReplAsking {
  /** The question this form belongs to, by the view's own name for it. */
  readonly key: string;
  /** Whether its drawer is presented right now. */
  readonly open: boolean;
  readonly form: ReplFormState;
}

/** A form nobody has touched. */
export const EMPTY_FORM: ReplFormState = Object.freeze({
  values: Object.freeze({}),
  field: undefined,
  messages: Object.freeze([]),
  offset: 0,
});

/**
 * Which control focus goes back to, because the drawer that held it went.
 *
 * Freedom restores the control that was focused before a modal was pushed, which
 * is where focus *was* rather than where the question now is: answering leaves a
 * retained invocation to look at, and dismissing leaves one still being asked.
 * Both are named here rather than resolved, because which row that is depends on
 * what is mounted and only the view knows that.
 */
export type ReplFocusRestore =
  /**
   * The control that opens the Sidekick's question, while it still has one.
   *
   * Where somebody was when they opened the form, which is where closing it
   * puts them back — rather than at the top of a pane they have to walk down
   * again to reopen the thing they just closed.
   */
  | { readonly kind: "sidekick-answer" }
  /**
   * The control that opens Configure, once its drawer has gone.
   *
   * Where somebody was when they opened it, which is where closing puts them
   * back rather than at the top of a pane they have to walk down again.
   */
  | { readonly kind: "sidekick-configure" }
  /**
   * The invocation whose answer this was, once its record is projected.
   *
   * Named by what it caused rather than by where it sits: the record appends
   * after the drawer is gone, so the row does not exist yet at the moment the
   * association is recorded. `known` is every answer already retained when this one was
   * taken and `answer` is exactly what was sent, which together name one
   * record — not the newest one, and not an answer somebody else caused.
   */
  | {
      readonly kind: "answered";
      readonly known: readonly string[];
      readonly answer: Json;
    }
  /** The invocation still asking, now that its drawer is not up. */
  | { readonly kind: "asked" }
  /**
   * The turn a permission drawer was answering for.
   *
   * The turn rather than the request: the request is gone — that is what
   * answering it means — and the turn it was waiting on is the thing still on
   * screen to come back to.
   */
  | { readonly kind: "turn"; readonly turn: string }
  /**
   * The Sidekick's own box, for somebody who has just asked to read it.
   *
   * Explicit activation only. A reader who selected the Sidekick is going to
   * type into it, and leaving focus on the draft would send their first
   * sentence to their document. Cold default visibility states no such thing:
   * the pane is simply the one showing, and the draft still holds focus.
   */
  | { readonly kind: "message" }
  /**
   * A row of a windowed list somebody moved to past the window's edge.
   *
   * Spent by the commit that focuses it, like every restoration: the window
   * moves to show it in the frame that focuses it, and keeps that position.
   */
  | { readonly kind: "reveal"; readonly key: string };

/**
 * The saved turn a selection asked to be shown, until a frame can show it.
 *
 * Process-local root state, beside the window offsets and never in the
 * location: it names a turn, which is a durable fact, but *being brought into
 * view* is a fact about this screen, and a location carrying one would promise
 * a scroll position the process reading it has not fitted.
 *
 * It is retained rather than resolved on the spot because the frame a selection
 * is answered in is not the frame the turn is read in. A Sessions reading at a
 * size with no room for the chat beside it, and a pane showing Bindings, have
 * measured no chat window at all — so the offset that would put this turn on
 * screen is not a number that frame knows. The destination's own measurement
 * places it, and until then the request is kept exactly as it was asked.
 */
export interface ReplSidekickReveal {
  /** The chat the turn belongs to, which is the chat now being read. */
  readonly conversation: string;
  /** The turn, by the canonical ordinal its own records carry. */
  readonly turn: number;
}

/**
 * How far each windowed reading is scrolled, in rows.
 *
 * Process-local, and deliberately not in the route: where somebody scrolled to
 * is not a place another process can be sent to, and a location carrying it
 * would reopen somewhere else at a row describing a different reading. Two
 * separate numbers because the windows are open at once — a wide frame carries
 * both readings in its sidebar, and a drawer scrolls the request it is asking
 * while the reading behind it keeps the row it was left on.
 *
 * Each is clamped where it is read, because publication, a filter, a background
 * change and a resize all change how many rows there are with nobody pressing
 * anything.
 */
export interface ReplViewports {
  /** Rows the Sessions reading is scrolled by. */
  readonly sessions: number;
  /**
   * Rows the Sidekick pane is scrolled by, one entry per chat it has read.
   *
   * Keyed by chat because reading an older one is reading somewhere else: a
   * single offset let scrolling a read-only chat decide where the current chat
   * returned to, and somebody who came back found their newest reply gone.
   *
   * Process-local like the rest, and deliberately not in the location: a copied
   * location restores the chat somebody selected and promises no scroll offset,
   * because a row number describes a reading the other process has not fitted.
   */
  readonly sidekick: Readonly<Record<string, number>>;
  /**
   * Which chats are following their newest rows rather than holding a place.
   *
   * A flag and not a row number, because what "the bottom" is changes every
   * time a message arrives: a stored offset could only ever describe the bottom
   * the list had when it was stored, which is one message ago. Following is
   * where a chat starts; scrolling up is how somebody leaves it, and reaching
   * the end again is how they return.
   *
   * Keyed by chat, like the offsets beside it and for the same reason: reading
   * an older chat is reading somewhere else, and scrolling it must not decide
   * where the current one comes back to.
   */
  readonly sidekickFollowing: Readonly<Record<string, boolean>>;
  /** Rows the Entries catalog is scrolled by. */
  readonly entries: number;
  /** Rows the open permission drawer is scrolled by. */
  readonly permission: number;
  /** Rows the Configure drawer is scrolled by. */
  readonly configure: number;
  /**
   * Rows each retained drawer reading is scrolled by, one per reading.
   *
   * Keyed by what the reading **is** — the execution, the prefix being read, and
   * the binding or occurrence being shown — rather than by the drawer's title or
   * its position in the stack. Two bindings with the same name in different
   * scopes are different readings and keep different offsets, and revisiting one
   * finds its own position again instead of wherever the last drawer was left.
   *
   * Process-local, like every other window: no location, record or Journal holds
   * one, so a location read in another process opens each reading at its start.
   */
  readonly readings: Readonly<Record<string, number>>;
}

/** Every window at its first row, which is where a fresh reading starts. */
export const AT_TOP: ReplViewports = Object.freeze({
  sessions: 0,
  sidekick: Object.freeze({}),
  sidekickFollowing: Object.freeze({}),
  entries: 0,
  permission: 0,
  configure: 0,
  readings: Object.freeze({}),
});

/** Everything typed and not yet committed anywhere. */
export interface ReplState {
  readonly heldHistory?: true;
  readonly draftCaret?: ReplCaret;
  readonly messageCaret?: ReplCaret;
  readonly route: ReplRoute;
  /**
   * The text of the entry that would be submitted next.
   *
   * Execution-wide, and independent of what is selected: an admitted entry is
   * immutable, so this is always the *next* one. It survives a refused
   * submission, remains editable while an entry is running and while a history
   * position is being inspected, and leaves only when it has become an entry.
   */
  readonly draft: string;
  /** The form being filled into the waiting question. */
  readonly form: ReplFormState;
  /**
   * The Sidekick's own question form, while it has one to fill in.
   *
   * Process-local and absent from the location: which question is open, what
   * has been typed into it and what was wrong with the last attempt are facts
   * about this process holding a suspended request, and a printed location that
   * carried them would describe a screen nobody else can be shown.
   */
  readonly asking: ReplAsking | undefined;
  /**
   * The Configure drawer, while this screen has one.
   *
   * Beside the question form rather than sharing it: they are alternative
   * contents of the same pane, and one is not a state of the other. Both are
   * process-local and absent from the location.
   */
  readonly configuring: ReplConfiguring;
  /** Why the last action changed nothing, or none. */
  readonly refusal: string | undefined;
  /**
   * The pending permission request this screen has selected, or none.
   *
   * This process's own opaque key, never a location: which request is being
   * answered is a fact about the process holding it, and a key in a URL would
   * publish a live identity nothing else can use.
   */
  readonly permission: string | undefined;
  /**
   * Where focus starts again, for the one commit after a drawer went.
   *
   * One-shot and process-local. A focus request repeated every frame would drag focus
   * back after every Tab, so the next action clears it: from then on focus is
   * the tree's, which is the only thing that knows where it is.
   */
  readonly restore: ReplFocusRestore | undefined;
  /** How far each windowed reading is scrolled. */
  readonly viewports: ReplViewports;
  /**
   * The saved turn a Sessions selection asked to be brought into view, or none.
   *
   * Held until something else moves that window — a scroll, a different
   * selection, or going back to the current chat — because the frame that can
   * place it is the one that measures the chat it is in.
   */
  readonly revealing: ReplSidekickReveal | undefined;
  /**
   * What the Sidekick's own message box holds.
   *
   * Beside the shared draft rather than in it: they are two texts with two
   * owners, and the one thing a shared draft must never do is lose what
   * somebody is typing to something typed elsewhere.
   */
  readonly message: string;
  /**
   * A monotonic revision for each of them, raised by every edit.
   *
   * What makes "the thing I admitted" nameable after the fact. Process-local,
   * like the viewports: a revision counts edits in this run and means nothing
   * in another, so a location never carries one.
   */
  readonly revisions: Revisions;
  /**
   * Whether a person has taken the shared draft over.
   *
   * Set by an edit a person made and cleared by the next explicit instruction
   * to the Sidekick. While it stands, the Sidekick's automatic replacement and
   * submission are paused — not refused forever, and not silently resumed.
   */
  readonly takenOver: boolean;
  /**
   * Whether the Transcript's conversation selector is showing its choices.
   *
   * Process-local, like the question form and the Configure drawer: whether a
   * chooser happens to be open is a fact about somebody standing in front of
   * this terminal, and a location that carried it would describe a screen
   * rather than a reading. Which conversation is *chosen* is the route's
   * {@link ReplRoute.session}, and closing the chooser leaves it alone.
   */
  readonly filtering: boolean;
  /**
   * Whether the Entries catalog is open over this reading.
   *
   * Process-local, beside the question form and the conversation chooser, and
   * for the same reason: a drawer somebody has open is a fact about them
   * standing in front of this terminal, not part of the location. A printed
   * location carries which entry and which scope are being read — the
   * destinations — and never the overlay somebody reached them through.
   *
   * It is a presentation and nothing more. Opening it selects the Entries
   * reading and changes no scope, no marker, no filter and neither draft; what
   * changes a destination is activating a row in it.
   */
  readonly catalog: boolean;
}

/** What the root must perform, because a component cannot. */
export type ReplIntent =
  | { readonly kind: "none" }
  /**
   * Admit this exact source as the next entry.
   *
   * The revision travels with it, because the root reserves the slot against
   * it and a later admission clears only the revision it admitted. A source
   * alone would be a text with no way to say which edit it was.
   */
  | { readonly kind: "submit"; readonly source: string; readonly revision: number }
  /**
   * Ask the Sidekick for this exact text, at these exact revisions.
   *
   * All three travel together for the reason the submission's revision does:
   * the root saves the text and later clears the box it came from, and it has
   * to clear the edit it sent rather than whatever is there by then. The draft
   * revision comes too, because the same instruction hands the shared draft
   * back — and only if the person has not taken it back since.
   */
  | {
      readonly kind: "send-message";
      readonly text: string;
      readonly held: Instruction;
    }
  /** Stop the Sidekick's own work, and join it. */
  | { readonly kind: "stop-sidekick" }
  /**
   * Stop this exact entry, and join everything it owned.
   *
   * The key travels with it because the root performs this against a session
   * that may have moved on: the frame that drew the control knew which entry
   * it was drawing against, and that is the entry a person pressed Stop on.
   */
  | { readonly kind: "stop-entry"; readonly entry: string }
  | { readonly kind: "pause" }
  | { readonly kind: "continue" }
  | { readonly kind: "answer"; readonly values: Readonly<Record<string, string>> }
  /**
   * Answer the Sidekick's own pending question, by the name this view gave it.
   *
   * The key travels so the root can check it still names the exact question it
   * holds before submitting anything: a reply that answered one question and
   * asked another would otherwise be handed the values typed for the first.
   */
  | {
      readonly kind: "answer-sidekick";
      readonly question: string;
      readonly values: Readonly<Record<string, string>>;
    }
  /**
   * Ask this conversation's agent what it offers, explicitly.
   *
   * The conversation travels so a result that arrives after it has been
   * replaced can be ignored rather than drawn: choices belong to the
   * conversation and the agent they were read for.
   */
  | {
      readonly kind: "inspect-configuration";
      readonly conversation: string | undefined;
      /**
       * The model whose effort levels this reads, or none for what is current.
       *
       * Effort belongs to a model, so a read has to say which model it is
       * asking about — and the answer is bound to that model when it arrives,
       * because levels read for one model are not another's.
       */
      readonly model: string | undefined;
    }
  /**
   * Save this complete preference for the conversation it was chosen in.
   *
   * The whole of what was asked for, never a patch: an omitted member asks for
   * no change to that setting, and nothing here resets one.
   */
  | {
      readonly kind: "save-configuration";
      readonly conversation: string | undefined;
      /** The selection that asked, so its answer cannot be applied to another. */
      readonly revision: number;
      readonly model?: string;
      readonly effort?: string;
    }
  /**
   * Start a new conversation with this agent, by the exact name entered.
   *
   * The conversation it was asked *from* and the selection that asked travel
   * with it, so a late outcome cannot close or overwrite a drawer that has
   * since been reopened, edited or pointed somewhere else.
   */
  | {
      readonly kind: "replace-agent";
      readonly agent: string;
      readonly conversation: string | undefined;
      /** The selection that asked, so its answer cannot be applied to another. */
      readonly revision: number;
    }
  /** Send the saved failed request this names again, as a new message. */
  | {
      readonly kind: "retry-message";
      readonly conversation: string;
      readonly message: number;
    }
  /**
   * Answer one pending permission request with one option it offered.
   *
   * Scalars only, and the turn it belongs to comes along because the root needs
   * it after the request is gone: answering removes the request, and focus has
   * to land on the turn that was waiting.
   */
  | {
      readonly kind: "settle-permission";
      readonly request: string;
      readonly option: string | undefined;
      readonly turn: string;
    }
  /**
   * End the command.
   *
   * The root's to perform because only the root owns the scope that holds the
   * session, the observer, each entry task and the terminal. Nothing is appended
   * for it: ending is the absence of further work, not an outcome.
   */
  | { readonly kind: "exit" };

/**
 * The field name the Sidekick's message box emits its text under.
 *
 * Named, because a field name is what tells typing where to go: focus belongs
 * to the mounted tree and the action vocabulary does not, so a control that
 * emitted bare text would have its characters delivered to whichever
 * destination the application last recorded. One spelling, used by the row that
 * draws the box and the reduction that answers it.
 */
export const MESSAGE_FIELD = "message";

/** One reduction: the state that stands now, and what the root owes. */
export interface ReplTransition {
  readonly state: ReplState;
  readonly intent: ReplIntent;
}

/** One complete reading of the product, ready to describe. */
export interface ReplView {
  readonly state: ReplState;
  readonly model: ReplModel;
  /**
   * Every position the history retained, and what the head is doing.
   *
   * The explicit exception to this view being a reading of one prefix: the
   * band is a map of the whole recorded order, because the positions after
   * the selected one are where a reader can go next. It is a marker and a
   * kind each — nothing a later position holds crosses — and it reaches the
   * band and the History drawer only. Every other pane gets the prefix.
   */
  readonly navigation: ReplHistoryNavigation;
  readonly selection: ReplSelection;
  readonly live: ReplLive;
  /** The canonical location this view is at. */
  readonly location: string;
  /**
   * Why there is no view at all, when that is what happened.
   *
   * Only that. A refusal of one *action* is `state.refusal` and belongs in the
   * footer beside the control that was refused — replacing the whole screen with
   * it would take away the thing the person was working on in order to explain
   * why it did not change.
   */
  readonly refusal: string | undefined;
  /**
   * How much terminal there is.
   *
   * Carried because what a row may contain depends on where it will be put: a
   * row longer than its region is reflowed into rows the layout never allocated,
   * so whoever writes one has to know how wide it will be.
   */
  readonly size: ReplTerminalSize;
  /**
   * The key of the control that held focus when this view was built.
   *
   * Derived, and therefore one frame behind: focus belongs to the mounted tree,
   * and the tree is what answers where it is. A person has to be able to see
   * which control their next keystroke reaches, so the marker is part of the view
   * rather than something the renderer decorates.
   */
  readonly focused: string | undefined;
  /** Whether this renderer has yet to commit a frame. */
  readonly initialPresentation?: boolean;
  /**
   * The staged workspace composition's own presentation, where a caller gave one.
   *
   * Inert: what Follow shows, which tray is selected, the messages waiting
   * behind the active exchange and which entry a Sidekick message submitted. No
   * owner, writer, reservation or provider is reachable through it. The root
   * never supplies it, so the screen a command draws is the ordinary
   * composition; a wide view carrying it is drawn as the #971 composition under
   * image review.
   */
  readonly workspace?: ReplWorkspace;
}

/** One message waiting behind the active exchange, as the staged screen lists it. */
export interface ReplQueuedMessage {
  readonly key: string;
  readonly origin: MessageOrigin;
  readonly text: string;
}

/** The entry one Sidekick message submitted, shown after that message as work. */
interface ReplAssociatedWork {
  /** The chat row the work follows, by the key the reading gives that row. */
  readonly message: string;
  /** The entry, by its catalog key. Its state and output are read from the model. */
  readonly entry: string;
}

/** What the staged workspace composition shows that no reading holds yet. */
export interface ReplWorkspace {
  /**
   * Whether this execution offers Follow at all, and how it stands.
   *
   * Absent is a build that does not have the continuation Follow would govern.
   * Its control is then not drawn: a checkbox for behaviour that is not here
   * would be a choice somebody could make and nothing would happen, and
   * drawing it unchecked would say this execution had turned something off.
   */
  readonly follow?: boolean;
  /**
   * Which trays this execution offers, in the order they are named.
   *
   * Absent is TODO alone, which is what a build without the shared queue
   * holds. A tab for a queue that does not exist is a tab a reader can select
   * and find nothing behind.
   */
  readonly trays?: readonly ("todo" | "queue")[];
  readonly tray: "todo" | "queue";
  readonly queued: readonly ReplQueuedMessage[];
  readonly work: readonly ReplAssociatedWork[];
  /**
   * How far the tray's own window is scrolled through those messages.
   *
   * Part of this inert presentation rather than of the screen's state, for the
   * reason the rest of it is: nothing here admits, orders, withdraws or holds a
   * message. Admission clamps it against the room the frame measured, so a
   * value past the end shows the last messages rather than nothing.
   */
  readonly queueOffset?: number;
}

/** The same view, drawn as the staged workspace composition where it is wide. */
export function withWorkspace(view: ReplView, workspace: ReplWorkspace): ReplView {
  return Object.freeze({ ...view, workspace });
}

/**
 * What the ordinary root's own screen stages, from what it actually holds.
 *
 * Everything here is a fact this reading already carries or a part of the
 * screen that is honestly empty. Nothing is supplied so that a control has
 * something to point at:
 *
 * - **Associated work** is the association between a chat row and the entry
 *   that row's evaluation admitted. It is read out of the acknowledged
 *   Submits this history already holds — see {@link associatedWork} — so a
 *   reply that really admitted an entry shows that entry's own state and
 *   output after it, and a reply that admitted nothing shows nothing. No
 *   message is given an entry it did not submit.
 * - **Queued messages** are the shared queue's, and there is no shared queue
 *   here. An empty tray is what this execution holds; a populated one would be
 *   a fiction in a screen somebody is working from.
 * - **Follow** is not offered. What it governs — a reply that evaluates and
 *   admits a round, and the continuation after it — is a later delivery, and
 *   a checkbox for behaviour this build does not have would be a choice that
 *   does nothing however it was drawn. Its accepted setting is kept in the
 *   delivery record, not advertised here.
 * - **QUEUE** is not offered either, and for the same reason: there is no
 *   shared queue in this build, and a tab a reader can select and find nothing
 *   behind is worse than no tab.
 *
 * So the tray is TODO, which is the inactive placeholder it has always been.
 */
export function workspaceOf(
  /**
   * The reading this frame is drawn from, which is the selected prefix.
   *
   * An association is only ever shown for an entry this reading holds: a
   * person standing at an earlier position is reading a history in which the
   * later entry was never admitted, and a row for it there would be a row
   * about something that has not happened in the history they are looking at.
   */
  model?: ReplModel,
  /** What this execution's Sidekick acknowledged, where the frame has one. */
  sidekick?: ReplSidekickReading,
): ReplWorkspace {
  return Object.freeze({
    tray: "todo" as const,
    queued: Object.freeze([]),
    work: associatedWork(model, sidekick),
  });
}

/**
 * The entries this reading's own acknowledged Submits admitted, by the row
 * that performed each one.
 *
 * Every association is an identity this history already holds, matched whole.
 * A reply names the chat and the response it was, which is the row's own key;
 * a Submit record names the slot it reserved, the entry key it named and the
 * exact source it reserved that slot with. An entry is this Submit's work when
 * the reading holds one at that slot, under that key, with that source — all
 * three, because any one of them alone would hand a reply somebody else's
 * entry:
 *
 * - the **slot** alone would follow admission order, so a Submit whose
 *   reservation was never honoured would take whatever landed there next;
 * - the **key** alone would survive a prefix that admitted a different entry
 *   under the same ordinal name;
 * - the **source** alone is not an identity at all — two entries may hold the
 *   same source, and often do.
 *
 * And the three of them together are still not enough, because a person may
 * type the very source a refused reply reserved and run it themselves at the
 * same slot. So what the control itself came to is asked first, from the
 * observation its own outcome retained.
 *
 * So a reservation nobody honoured, a refusal whose slot was later reused, a
 * startup that never admitted, and an entry outside the selected prefix each
 * produce no row, which is the truthful answer in all four cases.
 *
 * Nothing here reads a receipt's prose, infers from the latest entry, its order
 * or its title, or supplies an entry for a reply that admitted none. What the
 * row then *says* — running, completed, failed, interrupted, and whatever that
 * entry actually printed — is read from the model where it is drawn, never from
 * a reply's wording.
 */
function associatedWork(
  model: ReplModel | undefined,
  sidekick: ReplSidekickReading | undefined,
): readonly ReplAssociatedWork[] {
  if (model === undefined || sidekick === undefined || sidekick.submits === undefined) {
    return Object.freeze([]);
  }
  const found: ReplAssociatedWork[] = [];
  for (const submit of sidekick.submits) {
    // What this history says became of the control itself, before anything is
    // asked about the slot. A settled Submit that observed no entry admitted
    // none — it was refused before one started, or a reopening found the slot
    // it reserved was never taken — and the slot being occupied afterwards is
    // not an account of what this control did. Measured: a Submit refused in
    // preflight, whose exact reserved source was then typed in and run by hand
    // at the same slot under the same key, was credited with that person's
    // entry and its output.
    //
    // An *unsettled* one is the other state and not the same one: this process
    // is still in the submission, so what it admitted is the entry it reserved
    // and the row says what that entry is doing. A reopening never reads one —
    // the cold path resolves a reservation nobody answered, and what it finds
    // is retained as the outcome this reads.
    if (submit.settled && !submit.admitted) {
      continue;
    }
    const admitted = model.entries[submit.ordinal];
    if (
      admitted === undefined ||
      admitted.key !== submit.entry ||
      admitted.source !== submit.source
    ) {
      continue;
    }
    // The row that performed it, by the identity a reply is drawn under. A
    // response this reading composed no row for is a response nothing on this
    // screen could put the work after.
    const message = `chat:${submit.conversation}:${submit.response}`;
    if (!sidekick.chat.some((row) => row.key === message)) {
      continue;
    }
    if (found.some((one) => one.message === message && one.entry === admitted.key)) {
      continue;
    }
    found.push(Object.freeze({ message, entry: admitted.key }));
  }
  return Object.freeze(found);
}

/** The trays one execution offers, which is TODO alone unless it says more. */
function traysOf(workspace: ReplWorkspace): readonly ("todo" | "queue")[] {
  return workspace.trays ?? ["todo"];
}

/** Whether this execution offers the shared queue's tray at all. */
function offersQueue(workspace: ReplWorkspace): boolean {
  return traysOf(workspace).includes("queue");
}

/**
 * Whether this view is drawn as the staged workspace composition.
 *
 * At every profile this product draws at, and only with a reading to draw: a
 * refusal is the whole of its own screen, and below the minimum there is no
 * frame to compose at all. The wide proportions are accepted; the medium and
 * narrow ones are proposals under image review.
 */
function staged(view: ReplView): ReplWorkspace | undefined {
  if (view.refusal !== undefined || profileFor(view.size) === "too-small") {
    return undefined;
  }
  return view.workspace;
}

/** The staged presentation one view carries, for a caller outside this module. */
export function stagedWorkspace(view: ReplView): ReplWorkspace | undefined {
  return staged(view);
}

/**
 * The state after an entry was admitted.
 *
 * The draft leaves the state and the location together, because what was typed is
 * now the entry and a location carrying both would describe two different things
 * at once.
 */
export function admitted(state: ReplState, held?: Reservation): ReplState {
  // Only the revision that was admitted is cleared. A person who typed while a
  // slow preflight was running has a newer one, and that edit survives — which
  // is the difference between clearing "the draft" and clearing "the draft I
  // admitted". With no reservation to compare against there is nothing that
  // could have moved, so the draft goes as it always did.
  const draft = held === undefined ? "" : cleared(held, state).draft;
  return Object.freeze({
    ...state,
    draft,
    route: Object.freeze({ ...state.route, draft: draft.length === 0 ? undefined : draft }),
    refusal: undefined,
  });
}

/**
 * The state after a question accepted its answer.
 *
 * `model` is the history as it stood *before* the answer and `answer` is the
 * object the question took, because together they name the record this answer is
 * about to add.
 *
 * The question is over, so the drawer that was asking it is over too. Leaving
 * `+elicit` in the route would print a location naming a drawer the topology no
 * longer mounts — a URL that describes a screen nobody can be shown — and
 * leaving the typed text in `answer` would offer it again as though it were
 * still waiting to be sent.
 */
export function answered(state: ReplState, model: ReplModel, answer: Json): ReplState {
  return Object.freeze({
    ...state,
    form: EMPTY_FORM,
    // The answer is what there is to look at now, so focus goes to the
    // invocation that has it rather than wherever the drawer was opened from.
    // Which invocation that is cannot be read yet: its record appends after this,
    // so the claim carries what will identify it when it arrives.
    restore: Object.freeze({ kind: "answered", known: retainedAnswers(model), answer }),
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze(state.route.drawers.filter((drawer) => drawer.kind !== "live-elicit")),
    }),
    refusal: undefined,
  });
}

/**
 * The state after a permission request was really settled.
 *
 * Only a successful authority call reaches this: the drawer goes because the
 * request it was opened over is gone, and focus returns to the turn that was
 * waiting rather than to wherever the drawer was opened from.
 */
export function permissionSettled(state: ReplState, turn: string): ReplState {
  return Object.freeze({
    ...state,
    permission: undefined,
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze(
        state.route.drawers.filter((drawer) => drawer.kind !== "live-permission"),
      ),
    }),
    restore: Object.freeze({ kind: "turn", turn }),
    // The drawer is over, so the window over it is too: the next request opens
    // at its own first row rather than at wherever this one was read to.
    viewports: Object.freeze({ ...state.viewports, permission: 0 }),
    refusal: undefined,
  });
}

/**
 * The state after the request a drawer was opened over stopped existing.
 *
 * Teardown and publication can both remove a request nobody answered. The drawer
 * it left behind can resolve to nothing, so it is withdrawn — and nothing here
 * reports a choice or a denial, because none was made.
 */
export function permissionWithdrawn(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    permission: undefined,
    route: Object.freeze({
      ...state.route,
      drawers: Object.freeze(
        state.route.drawers.filter((drawer) => drawer.kind !== "live-permission"),
      ),
    }),
    viewports: Object.freeze({ ...state.viewports, permission: 0 }),
  });
}

/**
 * The state to adopt at a history position the selected entry predates, or none.
 *
 * A prefix earlier than an entry's admission holds no such entry, so the entry
 * and the nested scopes beneath it name nothing there. The position is what was
 * asked for, so what goes is the suffix that has become invalid — and nothing
 * guesses another entry in its place, because the person chose a position
 * rather than a selection.
 *
 * Everything else stands: the draft, the surface, the conversation filter and
 * the marker itself. The drawers that go are the two that open over a scope; the
 * History drawer is how a person reached this position and belongs to no scope
 * at all.
 *
 * Only at a frozen position, and only when the entry is really absent. A
 * directly opened location naming an entry its prefix never admitted refuses
 * whole rather than arriving somewhere adjacent, and that path never comes here.
 */
export function withoutAbsentEntry(state: ReplState, model: ReplModel): ReplState | undefined {
  const selected = state.route.scopes[0];
  if (state.route.at === undefined || selected === undefined) {
    return undefined;
  }
  if (model.entries.some((entry) => entry.key === selected)) {
    return undefined;
  }
  return Object.freeze({
    ...state,
    route: Object.freeze({
      ...state.route,
      scopes: Object.freeze([]),
      drawers: Object.freeze(
        state.route.drawers.filter(
          (drawer) => drawer.kind === "history" || drawer.kind === "live-permission",
        ),
      ),
    }),
  });
}

/** The empty route one fresh execution starts at. */
export function initialRoute(execution: string): ReplRoute {
  return Object.freeze({
    execution,
    surface: "entries",
    scopes: Object.freeze([]),
    drawers: Object.freeze([]),
    at: undefined,
    inspect: false,
    draft: undefined,
    session: undefined,
    // A fresh execution has selected no reading and no pane of its own: what it
    // shows is its surface, and a narrow frame therefore opens on Entries
    // rather than on a Sidekick nobody asked for.
    view: undefined,
    right: undefined,
    // And it has selected no saved chat, so the Sidekick it shows is the chat
    // it is actually in rather than one named on its behalf.
    sidekick: undefined,
  });
}

/** The state one fresh execution starts in. */
export function initialState(execution: string): ReplState {
  return Object.freeze({
    route: initialRoute(execution),
    draft: "",
    form: EMPTY_FORM,
    asking: undefined,
    configuring: NOT_CONFIGURING,
    refusal: undefined,
    permission: undefined,
    restore: undefined,
    viewports: AT_TOP,
    revealing: undefined,
    message: "",
    revisions: initialRevisions(),
    takenOver: false,
    filtering: false,
    catalog: false,
  });
}

/** Read one location into the state it names. */
export function stateFor(location: string): Result<ReplState> {
  const decoded = decodeLocation(location);
  if (!decoded.ok) {
    return decoded;
  }
  return Ok(
    Object.freeze({
      route: decoded.value,
      draft: decoded.value.draft ?? "",
      form: EMPTY_FORM,
      asking: undefined,
      configuring: NOT_CONFIGURING,
      refusal: undefined,
      permission: undefined,
      restore: undefined,
      // Never decoded: a window position is this process's, so a location read
      // here opens the reading at its first row rather than at a row the
      // process that wrote the location happened to be on. A location names a
      // chat and never a turn to reveal in it, for the same reason.
      viewports: AT_TOP,
      revealing: undefined,
      // Never decoded either, and for a stronger reason. A revision counts the
      // edits of one run, so a number from another process names a text this
      // one has never held; a takeover is a fact about somebody typing here.
      // Reading a location starts both over, which is what makes the Sidekick
      // free to act again and the draft it finds the only one there is.
      message: "",
      revisions: initialRevisions(),
      takenOver: false,
      // Closed, for the same reason: a reader arriving at a location is shown
      // the conversation it names, not somebody else's open chooser.
      filtering: false,
      // And closed for the same reason again: a location names where somebody
      // got to, never the overlay they opened on the way.
      catalog: false,
    }),
  );
}

/**
 * Build one view, or say why there is none.
 *
 * The selection is resolved here and nowhere else, so every surface below reads
 * the same exact model objects rather than looking them up again and possibly
 * differently.
 */
export function viewFor(
  state: ReplState,
  model: ReplModel,
  live: ReplLive,
  size: ReplTerminalSize,
  focused?: string,
  navigation: ReplHistoryNavigation = NO_NAVIGATION,
): Result<ReplView> {
  // This process is the only thing that can say a question is waiting, so it
  // says so here rather than leaving resolution to infer it from a history that
  // does not record it.
  const resolved = resolveLocation(model, state.route, availabilityOf(state, live));
  if (!resolved.ok) {
    return resolved;
  }
  // A frozen prefix shows nothing of the present. Stated once, here, rather
  // than remembered at each surface that would otherwise reach for the overlay.
  const shown: ReplLive =
    state.route.at === undefined
      ? live
      : {
          output: "",
          question: undefined,
          expansion: live.expansion,
          pausable: false,
          // A frozen prefix is a reading of the file, not of this process: it
          // fills nothing from the live head, and what the head is doing is not
          // a fact about the position being inspected.
          running: false,
          agent: NO_AGENT,
          // And the elements this process is expanding are the head's, not
          // this position's: a reading frozen before them describes a file
          // that had not reached them yet.
          lifecycle: NO_LIFECYCLE,
          // No preparation either, which is why it is left out rather than
          // carried over: a submission in flight belongs to the live head, and
          // the position being inspected is not where it will land. Submitting
          // from here is refused, so Pause offered here would be a control over
          // work this reading cannot reach.
          //
          // The Sidekick is kept, and that is the one exception. Freezing a
          // prefix freezes the *entry* history: a chat is a separate file with
          // no position in this one, so a reading frozen at an entry checkpoint
          // is not a reading of an earlier chat — and dropping it would make
          // somebody's current conversation disappear for the length of a
          // History selection.
          ...(live.sidekick === undefined ? {} : { sidekick: live.sidekick }),
        };
  return Ok(
    Object.freeze({
      state,
      model,
      navigation,
      selection: resolved.value,
      live: shown,
      location: encodeLocation(state.route),
      // Not `state.refusal`: a view exists, and what one action refused is said in
      // the footer rather than in place of everything.
      refusal: undefined,
      size,
      focused,
    }),
  );
}

/** The one view a cold open that cannot be projected gets. */
export function refusedView(
  state: ReplState,
  reason: string,
  size: ReplTerminalSize = NARROW,
  focused?: string,
): ReplView {
  return Object.freeze({
    state,
    model: EMPTY_MODEL,
    // A refusal navigates nowhere: there is no validated reading to draw a
    // rail from, and a stale one beside a refusal would be the worst of both.
    navigation: NO_NAVIGATION,
    selection: Object.freeze({
      route: state.route,
      surface: state.route.surface,
      entry: undefined,
      ancestry: Object.freeze([]),
      scope: undefined,
      session: undefined,
      sidekick: undefined,
      drawers: Object.freeze([]),
    }),
    live: Object.freeze({
      output: "",
      question: undefined,
      expansion: "playing",
      pausable: false,
      running: false,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    }),
    location: encodeLocation(state.route),
    refusal: reason,
    size,
    // Where focus actually is, once a commit has said: this screen has a control
    // on it, and a marker that named a different node would draw it on nothing.
    focused: focused ?? "refusal",
  });
}

/**
 * What this process can say about state no history holds.
 *
 * `permission` is not "a request is waiting": it is "the request this screen has
 * selected is still waiting". A drawer opens over one exact request, so a route
 * that named one which has since settled resolves to nothing rather than to
 * whatever is pending now.
 *
 * `sessions` is the conversations live turns have actually started under. A
 * queued turn has none yet, and the authored Session name, the Prompt name and
 * the agent are not conversations — inferring one from them would offer a filter
 * for a key the provider never issued.
 */
function availabilityOf(state: ReplState, live: ReplLive): ReplLiveAvailability {
  const selected = state.permission;
  const keys: string[] = [];
  for (const turn of live.agent.turns) {
    const key = turn.sessionKey;
    if (key !== undefined && key.length > 0 && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return {
    elicit: live.question !== undefined,
    permission:
      selected !== undefined && live.agent.requests.some((request) => request.key === selected),
    sessions: Object.freeze(keys),
    // The Sidekick's own, passed through rather than derived here: the chat is
    // a separate history, so the facts a location may name about it come from
    // the reading that was composed for this frame and from nowhere else. A
    // frame built without a Sidekick passes none, and a selector then refuses.
    ...(live.sidekick === undefined ? {} : { sidekick: live.sidekick.availability }),
  };
}

const EMPTY_MODEL: ReplModel = Object.freeze({
  selection: undefined,
  head: true,
  entries: Object.freeze([]),
  settled: false,
  terminal: undefined,
  checkpoints: Object.freeze([]),
  transcript: Object.freeze([]),
  turns: Object.freeze([]),
  sessions: Object.freeze([]),
});

/**
 * Whether answering this action needs the frame's measured admission.
 *
 * The four scrolls, and nothing else: every other branch of `reduceRepl`
 * decides from the state, the model and this process's overlay alone. It
 * lives here because the reducer is what reads `admission`, so a fifth
 * branch that starts reading one is written next to the answer about it.
 *
 * The root measures a frame before the action when this is true. For a
 * keystroke into the draft it is false, and measuring the reading beside that
 * draft would be work for an answer nothing consults.
 */
export function readsGeometry(action: ReplAction): boolean {
  return (
    action.kind === "viewport-wheel" ||
    action.kind === "reading-key" ||
    action.kind === "scroll" ||
    // The Sidekick form's own window, for the same reason: how far it may
    // travel is what this frame measured, and an unmeasured frame has admitted
    // nothing to clamp against.
    action.kind === "scroll-sidekick-question" ||
    action.kind === "scroll-sidekick" ||
    action.kind === "scroll-configure" ||
    action.kind === "scroll-sessions" ||
    action.kind === "scroll-entries" ||
    action.kind === "scroll-reading"
  );
}

/**
 * Answer one action.
 *
 * Total over the union, and pure: nothing here appends, opens, pauses or
 * answers. What needs doing comes back as an intent for the root to perform, so
 * the decision and the effect are separable and the decision is testable alone.
 */
export function reduceRepl(
  given: ReplState,
  action: ReplAction,
  model: ReplModel,
  live: ReplLive,
  // What the frame measured and admitted, for the decisions that depend on it:
  // how far each window may move, and from where. It is the same answer the
  // descriptions were built from, so a scroll cannot clamp against a capacity
  // the screen is not showing. A caller that states none moves no window — an
  // unmeasured frame has admitted nothing.
  admission: ReplAdmission = NOTHING_ADMITTED,
  /**
   * The editable drawer that frame presented, including its question owner.
   *
   * A frame-derived fact like the admission beside it, and for the same reason:
   * what a key means depends on what was on the screen when it was pressed, and
   * only the frame knows that. A caller that states none presents no form,
   * which is the safe answer — typing then reaches the visible input.
   */
  presented: ReplPresented | undefined = undefined,
): ReplTransition {
  // Whoever pressed this key has moved on from wherever the last drawer put
  // focus, so the claim does not outlive the commit it was made for.
  const state =
    given.restore === undefined ? given : Object.freeze({ ...given, restore: undefined });
  const answering = state.route.drawers.some((drawer) => drawer.kind === "live-elicit");
  // The Sidekick's form, while its drawer is the one presented. One question
  // drawer is open at a time, so this is also what says the keystrokes below
  // belong to this form rather than to the entry's or to either composer.
  const asking = openAsking(
    state,
    live,
    presented?.kind === "question" ? presented.question : undefined,
  );
  // Configure, while its drawer is what is drawn. The frame's own answer rather
  // than the held flag, exactly as the question form above: a drawer open in
  // state behind another pane, another tab or a route drawer is state and not
  // presentation, and it owns no keystroke. It decides both the one text
  // destination this drawer has — before either composer, because a field in a
  // drawer holding focus is where the keys a person presses are going — and
  // whether Escape is addressed to this drawer.
  const configuring = presented?.kind === "configure" && state.configuring.open;

  switch (action.kind) {
    case "noop":
      return settled(state);
    case "viewport-wheel": {
      const window = admission.windows.get(action.window);
      if (window === undefined || window.capacity < 1) {
        return settled(given);
      }
      const requested = scrolled(window, action.direction === "up" ? -3 : 3);
      const focus = window.focus;
      const next =
        focus === undefined
          ? requested
          : Math.min(
              Math.max(requested, Math.max(0, focus.to - window.capacity)),
              Math.min(focus.from, Math.max(0, window.total - window.capacity)),
            );
      if (next === window.from) {
        return settled(given);
      }
      const kind =
        action.window === SIDEKICK_WINDOW
          ? "scroll-sidekick"
          : action.window === SESSIONS_WINDOW
            ? "scroll-sessions"
            : action.window === ENTRIES_WINDOW
              ? "scroll-entries"
              : action.window === READING_WINDOW
                ? "scroll-reading"
                : action.window === DRAWER_WINDOW
                  ? presented?.kind === "configure"
                    ? "scroll-configure"
                    : asking !== undefined
                      ? "scroll-sidekick-question"
                      : state.catalog
                        ? "scroll-entries"
                        : "scroll"
                  : undefined;
      return kind === undefined
        ? settled(given)
        : reduceRepl(state, { kind, delta: next - window.from }, model, live, admission, presented);
    }
    case "reading-key": {
      const name =
        action.reading === "selected"
          ? READING_WINDOW
          : action.reading === "chat"
            ? SIDEKICK_WINDOW
            : DRAWER_WINDOW;
      const window = admission.windows.get(name);
      if (window === undefined || action.reading === "empty") {
        return settled(state);
      }
      const delta =
        action.key === "Home"
          ? -window.total
          : action.key === "End"
            ? window.total
            : (action.key === "ArrowUp" || action.key === "PageUp" ? -1 : 1) *
              (action.key === "PageUp" || action.key === "PageDown"
                ? Math.max(1, window.capacity - 1)
                : 1);
      const kind =
        action.reading === "selected"
          ? "scroll-reading"
          : action.reading === "chat"
            ? "scroll-sidekick"
            : presented?.kind === "configure"
              ? "scroll-configure"
              : asking !== undefined
                ? "scroll-sidekick-question"
                : state.catalog
                  ? "scroll-entries"
                  : "scroll";
      return reduceRepl(state, { kind, delta }, model, live, admission, presented);
    }
    // Typing is always typing the *next* entry. Which entry is selected, and
    // whether one is running, decide nothing here: an admitted entry is
    // immutable, so there is never an entry these keystrokes could be editing.
    case "type":
    case "erase":
    case "move-caret":
      return editCaret(state, live, action, configuring, asking, answering, presented);
    case "reveal":
      return settled({ ...state, restore: Object.freeze({ kind: "reveal", key: action.key }) });
    case "submit": {
      // The one gate, over the part of its facts this reduction can see.
      // Inspection freezes durable state, not the draft, and submitting from a
      // frozen position would have to choose an inheritance boundary that is
      // not the live head — so the gate refuses it here on exactly the terms it
      // refuses a reply's request at the root.
      const drafted = submittable("person", {
        live: state.route.at === undefined,
        revisions: state.revisions,
        takenOver: state.takenOver,
        draft: state.draft,
      });
      if (!drafted.ok) {
        return refuse(state, drafted.error.message);
      }
      // The draft stays until the entry exists. Clearing it here would lose
      // somebody's document to a preflight refusal, which is the one moment they
      // most need it back — and whether this is a moment to submit at all is the
      // session's to answer, because only it knows whether the entry before this
      // one has both settled and joined.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "submit", source: state.draft, revision: state.revisions.draft },
      };
    }
    case "send-message": {
      // Nothing to ask for. An empty box is not a message, and a Send that
      // sent one would start a turn nobody asked a question in.
      if (state.message.length === 0) {
        return settled(state);
      }
      // Both revisions captured here, in the reduction, because this is the
      // moment the person asked: the text is saved and the box cleared against
      // this edit, and what happens to either of them while the append is in
      // flight belongs to whoever did it.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "send-message",
          text: state.message,
          // This box's own text, so the record that saves it clears this box.
          held: {
            message: state.revisions.message,
            draft: state.revisions.draft,
            from: "composer",
          },
        },
      };
    }
    case "stop-sidekick": {
      // Unguarded, like `exit`. Stopping something that is not running is
      // nothing, and a control that refused on a screen where the work had
      // just finished would be refusing the person's own timing.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "stop-sidekick" },
      };
    }
    case "stop-entry": {
      // The key is carried through exactly as the frame drew it. Which entry
      // is actually running, whether the history has acknowledged it and
      // whether it may be stopped at all are the session's to answer, and
      // answering any of them here would be this screen deciding from a
      // reading instead of from the session that owns the work.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "stop-entry", entry: action.entry },
      };
    }
    case "exit": {
      // No guard, from any state. Leaving is available while an entry runs, while
      // a question waits, while a request is pending and while a position is being
      // inspected — a person who cannot leave the screen they are on has not been
      // given a way out, they have been given four.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "exit" },
      };
    }
    case "select-surface": {
      // Explicitly asking for a surface is also asking to read it, so an
      // explicit Sidekick reading goes: the alternative is somebody activating
      // Entries and staying where they were.
      return navigate(
        hidingAsking(state),
        model,
        { ...state.route, surface: action.surface, drawers: [], view: undefined },
        live,
      );
    }
    case "select-pane": {
      // Selecting the Sidekick selects it as the reading too, because that is
      // what a person who activated it asked to see — and the saved surface,
      // the selected entry and the frozen position all stay exactly as they
      // are, since reading the Sidekick is what somebody comes back from.
      //
      // Bindings is a pane and not a reading, so selecting it puts the saved
      // surface back in front of whoever was reading the Sidekick rather than
      // leaving them on a reading they just navigated away from.
      const moved = navigate(
        hidingAsking(state),
        model,
        {
          ...state.route,
          right: action.pane,
          view: action.pane === "sidekick" ? "sidekick" : undefined,
        },
        live,
      );
      // Somebody who activated the Sidekick is about to type into it. The
      // claim is made only for that activation, and only when the navigation
      // actually happened: a refused route leaves focus where it was.
      return action.pane === "sidekick" && moved.state.route.right === "sidekick"
        ? settled({ ...moved.state, restore: { kind: "message" } })
        : moved;
    }
    case "select-scope": {
      const chosen = navigate(
        state,
        model,
        {
          ...state.route,
          surface: "entries",
          scopes: Object.freeze([...action.scopes]),
          // A drawer named a thing inside the scope that was open. Selecting a
          // different scope cannot keep it.
          drawers: Object.freeze([]),
        },
        live,
      );
      // A choice that was accepted is what the catalog was open for, so it
      // closes behind it and the reading it chose is what a reader is left
      // looking at. A refused one changes nothing, the catalog included: the
      // row they pressed is still there to press again.
      return chosen.state.refusal === undefined
        ? { ...chosen, state: Object.freeze({ ...chosen.state, catalog: false }) }
        : chosen;
    }
    case "open-catalog": {
      // The Entries reading, selected explicitly, and then the overlay over it.
      // Everything else this location names stands: the scope path, the history
      // marker, the conversation filter, the saved chat, both drafts and
      // whatever is running. Resolved through the same navigation every other
      // destination goes through, so a reading this history cannot answer for
      // refuses here rather than opening a catalog over nothing.
      const opened = navigate(
        atFirstEntry(state),
        model,
        { ...state.route, surface: "entries", view: undefined },
        live,
      );
      return opened.state.refusal === undefined
        ? { ...opened, state: Object.freeze({ ...opened.state, catalog: true }) }
        : opened;
    }
    case "close-catalog": {
      // Put away, and nothing else put away with it. The scope being read, the
      // marker, the filter and both drafts are exactly as they were: dismissing
      // a catalog is not choosing anything in it.
      return settled(Object.freeze({ ...state, catalog: false }));
    }
    case "open-drawer": {
      if (action.drawer.kind === "live-elicit") {
        if (state.route.at !== undefined) {
          return refuse(
            state,
            "a historical view cannot answer the question this process is asking. " +
              "Activate [live] to return to the head.",
          );
        }
        if (live.question === undefined) {
          return refuse(state, "nothing is being asked right now.");
        }
      }
      // A drawer belongs to one surface, so activating a control that opens one
      // goes to that surface as part of the same explicit act. The alternative is
      // refusing somebody on the surface they are standing on for asking to see
      // something that exists — which is what a waiting question on Sessions used
      // to be. A surface this crosses starts a fresh stack: a drawer was opened
      // over a surface, and carrying it to another one would stack it over a
      // screen it was never in front of.
      const owning = surfaceForDrawer(action.drawer);
      const crossing = owning !== state.route.surface;
      const heldHistory =
        action.drawer.kind === "history" &&
        (state.route.drawers.length > 0 ||
          state.configuring.open ||
          state.asking?.open === true ||
          state.catalog);
      return navigate(
        heldHistory ? { ...state, heldHistory: true } : state,
        model,
        {
          ...state.route,
          surface: owning,
          // The question belongs to the entry still running, and that is the entry
          // whose transcript it has to be read against.
          scopes:
            action.drawer.kind === "live-elicit"
              ? askingEntry(model, state.route.scopes)
              : state.route.scopes,
          drawers: Object.freeze(
            crossing ? [action.drawer] : [...state.route.drawers, action.drawer],
          ),
        },
        live,
      );
    }
    case "close-drawer": {
      if (state.route.drawers.length === 0 && state.catalog) {
        return settled({ ...state, catalog: false });
      }
      if (state.route.drawers.length === 0) {
        // Escape over Configure closes Configure, by the one transition its own
        // Close control produces. Two ways out of a modal that disagreed about
        // what closing means would be two different closes, and the one a
        // person reaches by habit was the one that did nothing.
        if (configuring) {
          return closedConfigure(state);
        }
        // Escape with no route drawer open closes the Sidekick's form, which is
        // the only other thing that holds focus. The question stays pending and
        // the values stay typed: hiding a form is not abandoning an answer.
        if (asking !== undefined) {
          return settled({
            ...state,
            asking: Object.freeze({ ...asking.held, open: false }),
            restore: Object.freeze({ kind: "sidekick-answer" }),
            refusal: undefined,
          });
        }
        return refuse(state, "no drawer is open.");
      }
      const closing = state.route.drawers[state.route.drawers.length - 1];
      if (closing?.kind === "live-permission") {
        // Dismissing a permission request denies it, and a denial is something
        // only the authority can do. So this closes nothing yet: the drawer goes
        // when the request it was opened over is really gone, and until then a
        // screen that had already closed would be claiming an answer nobody gave.
        const pending =
          state.permission === undefined ? undefined : offered(state, live, state.permission);
        if (pending === undefined) {
          // Nothing left to deny — teardown or publication took it. The drawer is
          // withdrawn rather than answered.
          return settled(permissionWithdrawn(state));
        }
        return {
          state: Object.freeze({ ...state, refusal: undefined }),
          intent: {
            kind: "settle-permission",
            request: pending.key,
            option: undefined,
            turn: pending.turn,
          },
        };
      }
      const remaining = Object.freeze(state.route.drawers.slice(0, -1));
      const closed = navigate(
        {
          ...state,
          heldHistory: remaining.at(-1)?.kind === "history" ? state.heldHistory : undefined,
        },
        model,
        { ...state.route, drawers: remaining },
        live,
      );
      // Dismissing the question's drawer discards what was typed into it. It is
      // not an answer, and keeping it would offer it again as though it were.
      return closing.kind === "live-elicit"
        ? {
            ...closed,
            // Still being asked, so what focus returns to is the invocation that
            // is asking — the one control that opens this drawer again.
            state: Object.freeze({
              ...closed.state,
              form: EMPTY_FORM,
              restore: Object.freeze({ kind: "asked" }),
            }),
          }
        : closed;
    }
    case "select-session": {
      // Only the filter moves: the surface, the scope path, the history marker,
      // the draft and the drawer stack are all left exactly as they stand. A key
      // that names no conversation is refused by the codec's own resolution, so
      // a stale one cannot become an empty Sessions view.
      //
      // The window goes back to the first row, because a filtered reading is a
      // different list: row forty of everything is not row forty of one
      // conversation, and keeping the number would open somewhere nobody chose.
      return navigate(
        chosen(atFirstRow(state)),
        model,
        { ...state.route, session: action.session },
        live,
      );
    }
    case "all-sessions": {
      return navigate(
        chosen(atFirstRow(state)),
        model,
        { ...state.route, session: undefined },
        live,
      );
    }
    case "toggle-session-filter": {
      // Presentation alone. The chosen conversation, the window, the surface,
      // the scope path, the history position and both drafts stay exactly as
      // they stand: putting the choices away is not choosing one of them.
      return settled(Object.freeze({ ...state, filtering: !state.filtering }));
    }
    case "read-sidekick-turn": {
      // The reading moves and nothing else does: the surface, the selected
      // entry, its scopes, the history position, the filter and both drafts
      // stay exactly as they stand. Selecting a reading starts no provider,
      // writes no record and stops no work.
      const chosen = navigate(
        hidingAsking(state),
        model,
        {
          ...state.route,
          view: "sidekick",
          right: "sidekick",
          sidekick: action.conversation,
        },
        live,
      );
      if (chosen.state.refusal !== undefined) {
        return chosen;
      }
      // And the turn asked for, retained until a frame measuring that chat can
      // place it. The frame answering this action is the one being left: a
      // Sessions reading at a size with no room for the chat beside it, and a
      // pane showing Bindings, measured no chat window — so the offset is not
      // a number this frame knows, and the destination's own measurement is
      // what puts the turn on screen.
      //
      // The window itself is left exactly where it was. Nothing guesses a
      // position here; the request is what is kept.
      return settled({
        ...chosen.state,
        revealing:
          action.turn === undefined
            ? undefined
            : Object.freeze({ conversation: action.conversation, turn: action.turn }),
      });
    }
    case "read-current-chat": {
      // Only the selector. The pane stays selected, because this is where
      // somebody came back *to* rather than away from, and the current chat's
      // own window opens where this process left it — which is why the turn
      // that was being revealed in the chat being left goes with it.
      const back = navigate(state, model, { ...state.route, sidekick: undefined }, live);
      return { ...back, state: Object.freeze({ ...back.state, revealing: undefined }) };
    }
    case "scroll-sidekick": {
      const window = admission.windows.get(SIDEKICK_WINDOW);
      // Which chat is being scrolled: the one this frame is reading, which is
      // the only one its measured window describes. A frame with no Sidekick
      // has no window either, so the two are absent together.
      const chat = live.sidekick?.reading;
      if (window === undefined || chat === undefined) {
        return settled({ ...state, refusal: undefined });
      }
      // From the clamp the frame is showing, which is where a pending reveal
      // already put it — and the reveal is spent by this press, because the
      // window is now being moved by the person reading it.
      const moved = scrolled(window, action.delta);
      return settled({
        ...state,
        viewports: Object.freeze({
          ...state.viewports,
          sidekick: Object.freeze({ ...state.viewports.sidekick, [chat]: moved }),
          // Reaching the end is what resumes following, and leaving it is what
          // stops it: the press says where somebody wants to be reading, and a
          // reader standing at the newest row is asking for the newest row.
          // For this chat alone — the one being read.
          sidekickFollowing: Object.freeze({
            ...state.viewports.sidekickFollowing,
            [chat]: moved >= Math.max(0, window.total - window.capacity),
          }),
        }),
        revealing: undefined,
        refusal: undefined,
      });
    }
    case "scroll-sessions": {
      // From the clamp the frame is **showing**, over the window it measured for
      // the size and reading this action is being answered at. A delta added to
      // a stored number instead would spend a press normalizing state nobody can
      // see — a resize or a filter changes what the window holds, and the region
      // is already drawing the clamped position.
      const window = admission.windows.get(SESSIONS_WINDOW);
      if (window === undefined) {
        // Nothing measured a window here, so there is nothing to move. A reading
        // that fits its region is not scrolled; it is shown.
        return settled({ ...state, refusal: undefined });
      }
      return settled({
        ...state,
        viewports: Object.freeze({ ...state.viewports, sessions: scrolled(window, action.delta) }),
        refusal: undefined,
      });
    }
    case "scroll-entries": {
      // The same rule over the catalog's own measured window — whichever
      // window this frame actually measured it in. While the catalog is open
      // over a staged composition the rows are the drawer's, and clamping
      // against a permanent Entries column that screen does not draw would
      // clamp against a capacity nobody measured.
      const window =
        admission.windows.get(state.catalog ? DRAWER_WINDOW : ENTRIES_WINDOW) ??
        admission.windows.get(ENTRIES_WINDOW);
      if (window === undefined) {
        return settled({ ...state, refusal: undefined });
      }
      return settled({
        ...state,
        viewports: Object.freeze({ ...state.viewports, entries: scrolled(window, action.delta) }),
        refusal: undefined,
      });
    }
    case "scroll-reading": {
      // The same rule again, over the window the frame measured for the reading
      // that is showing. Which reading that is decides the offset this moves,
      // so selecting an earlier entry and scrolling it leaves the live entry's
      // own position where the reader left it.
      const window = admission.windows.get(READING_WINDOW);
      if (window === undefined) {
        return settled({ ...state, refusal: undefined });
      }
      const key = entryReadingKeyOf(state);
      return settled({
        ...state,
        viewports: Object.freeze({
          ...state.viewports,
          readings: Object.freeze({
            ...state.viewports.readings,
            [key]: scrolled(window, action.delta),
          }),
        }),
        refusal: undefined,
      });
    }
    case "select-permission": {
      // The key is taken first, because a `+permission` candidate resolves only
      // while the request it names is pending — so the state that navigates has
      // to be the one already holding it. A refusal keeps neither.
      const first = live.agent.requests.find((request) => request.key === action.request)
        ?.choices[0];
      const holding = Object.freeze({
        ...state,
        permission: action.request,
        restore:
          first === undefined
            ? undefined
            : Object.freeze({ kind: "reveal", key: `drawer:permission:choice:${first.optionId}` }),
        viewports: Object.freeze({ ...state.viewports, permission: 0 }),
      });
      // Declared, so the drawer this adds is the one the grammar defines rather
      // than a string this case happens to spell the same way.
      const opening: ReplDrawerRef = { kind: "live-permission" };
      const opened = navigate(
        holding,
        model,
        {
          ...state.route,
          // The surface this drawer belongs to, taken by the act of selecting
          // the request. The grammar answers a permission on Sessions, and the
          // ordinary composition only offers this control there — but the
          // staged composition draws that same list as its Transcript column,
          // so an activation from it would otherwise be refused for standing
          // where the screen put it. Selecting a request is a statement about
          // going to the request, so the location says so.
          surface: "sessions",
          drawers: Object.freeze([...state.route.drawers, opening]),
        },
        live,
      );
      return opened.state.refusal === undefined ? opened : refuse(state, opened.state.refusal);
    }
    case "choose-permission": {
      const pending = offered(state, live, action.request);
      if (pending === undefined) {
        return refuse(state, "that permission request is not the one being answered.");
      }
      if (!pending.choices.some((choice) => choice.optionId === action.option)) {
        // Re-checked against the reading as it stands: a choice drawn one frame
        // ago is not a choice the provider is still offering.
        return refuse(state, "that choice is not one this request offered.");
      }
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "settle-permission",
          request: action.request,
          option: action.option,
          turn: pending.turn,
        },
      };
    }
    case "dismiss-permission": {
      const pending = offered(state, live, action.request);
      if (pending === undefined) {
        return refuse(state, "that permission request is not the one being answered.");
      }
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "settle-permission",
          request: action.request,
          option: undefined,
          turn: pending.turn,
        },
      };
    }
    case "select-marker": {
      // Adopted rather than resolved here: a position is a *different reading* of
      // the file, and this model is the one the view being left was built from.
      // The root reprojects at the named position and verifies there, which is
      // the only place the answer exists.
      return settled({
        ...state,
        route: Object.freeze({ ...state.route, at: action.marker, inspect: true }),
        refusal: undefined,
      });
    }
    case "go-live": {
      return settled({
        ...state,
        route: Object.freeze({
          ...state.route,
          at: undefined,
          inspect: false,
          // A recorded drawer may name something the head no longer selects.
          drawers: Object.freeze([]),
        }),
        refusal: undefined,
      });
    }
    case "pause": {
      // A submission being prepared is as pausable as one already expanding:
      // what Pause asks for is that the entry stop before it expands anything,
      // and the whole window this covers is the one where that entry does not
      // exist yet. Asking twice asks for the same thing, so a request already
      // standing is not refused — it is the same request.
      if (!live.pausable && live.preparing === undefined) {
        return refuse(state, "this process holds no live expansion to pause.");
      }
      return { state: Object.freeze({ ...state, refusal: undefined }), intent: { kind: "pause" } };
    }
    case "continue": {
      if (!live.pausable) {
        return refuse(state, "this process holds no live expansion to continue.");
      }
      if (live.expansion !== "paused") {
        // Nothing is held yet, so there is nothing to release. Resuming here
        // would withdraw a pause that has not finished taking effect.
        return refuse(state, "expansion is not paused, so nothing is held to continue.");
      }
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "continue" },
      };
    }
    case "answer": {
      if (state.route.at !== undefined) {
        return refuse(
          state,
          "a historical view cannot answer the question this process is asking.",
        );
      }
      if (live.question === undefined) {
        return refuse(state, "nothing is being asked right now.");
      }
      // The whole object, however it was assembled. Whether it is an answer is
      // the schema's to say, and the root asks it — a reducer that guessed here
      // would be a second validator disagreeing with the first.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: { kind: "answer", values: state.form.values },
      };
    }
    case "select-field": {
      if (!answering || live.question === undefined) {
        return refuse(state, "nothing is being asked right now.");
      }
      if (!live.question.form.fields.some((one) => one.name === action.field)) {
        return refuse(state, "this question has no such field.");
      }
      return settled({
        ...state,
        form: Object.freeze({ ...state.form, field: action.field }),
        refusal: undefined,
      });
    }
    case "choose": {
      if (!answering || live.question === undefined) {
        return refuse(state, "nothing is being asked right now.");
      }
      const field = live.question.form.fields.find((one) => one.name === action.field);
      if (field === undefined) {
        return refuse(state, "this question has no such field.");
      }
      // Never a value the question did not offer: a stray identifier puts
      // nothing into the form rather than something the schema will reject.
      if (field.choices === undefined || !field.choices.includes(action.option)) {
        return refuse(state, "this field does not offer that value.");
      }
      // Activating an option is an answer attempt, like Enter anywhere else in
      // the form: the value goes in and the whole object is offered. Whether it
      // is an answer is the schema's to say — choosing "Request changes" with no
      // feedback yet leaves the same question open, carrying what it said.
      const chosen = written(state.form, action.field, action.option);
      return {
        state: Object.freeze({ ...state, form: chosen, refusal: undefined }),
        intent: { kind: "answer", values: chosen.values },
      };
    }
    case "open-sidekick-question": {
      const pending = live.sidekick?.question;
      if (pending === undefined || pending.key !== action.question) {
        // The question this control was drawn for is not the one pending now.
        // Opening "whatever is pending" would put somebody in front of a
        // question they never asked to see.
        return refuse(state, "that Sidekick question is no longer waiting.");
      }
      return settled({
        ...state,
        asking: Object.freeze({
          key: pending.key,
          open: true,
          form: state.asking?.key === pending.key ? state.asking.form : EMPTY_FORM,
        }),
        refusal: undefined,
      });
    }
    case "close-sidekick-question": {
      if (state.asking === undefined || !state.asking.open) {
        return refuse(state, "the Sidekick's question form is not open.");
      }
      // Hidden, not discarded. The question is still waiting and the values are
      // still theirs — the entry's close-clears-the-form rule is the entry's,
      // because its drawer *is* its question and this one is a presentation of
      // one that goes on existing without it.
      return settled({
        ...state,
        asking: Object.freeze({ ...state.asking, open: false }),
        restore: Object.freeze({ kind: "sidekick-answer" }),
        refusal: undefined,
      });
    }
    case "select-sidekick-field": {
      if (asking === undefined || asking.key !== action.question) {
        return refuse(state, "that Sidekick question is not open.");
      }
      if (!asking.question.form.fields.some((one) => one.name === action.field)) {
        return refuse(state, "this question has no such field.");
      }
      return settled({
        ...state,
        asking: Object.freeze({
          ...asking.held,
          form: Object.freeze({ ...asking.held.form, field: action.field }),
        }),
        refusal: undefined,
      });
    }
    case "choose-sidekick": {
      if (asking === undefined || asking.key !== action.question) {
        return refuse(state, "that Sidekick question is not open.");
      }
      const field = asking.question.form.fields.find((one) => one.name === action.field);
      if (field === undefined) {
        return refuse(state, "this question has no such field.");
      }
      if (field.choices === undefined || !field.choices.includes(action.option)) {
        return refuse(state, "this field does not offer that value.");
      }
      // The same meaning activation has in the entry's form: the value goes in
      // and the whole object is offered, because whether it is an answer is the
      // schema's to say.
      const chosen = written(asking.held.form, action.field, action.option);
      return {
        state: Object.freeze({
          ...state,
          asking: Object.freeze({ ...asking.held, form: chosen }),
          refusal: undefined,
        }),
        intent: { kind: "answer-sidekick", question: asking.key, values: chosen.values },
      };
    }
    case "answer-sidekick": {
      if (asking === undefined || asking.key !== action.question) {
        return refuse(state, "that Sidekick question is not open.");
      }
      // The whole object, however it was assembled, and the key it belongs to.
      // Whether it is an answer is the schema's to say and the root asks it; a
      // reducer that judged here would be a second validator.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "answer-sidekick",
          question: asking.key,
          values: asking.held.form.values,
        },
      };
    }
    case "open-configure": {
      const active = live.sidekick?.question;
      void active;
      // Bound to the conversation it was asked of. A drawer opened for one
      // conversation cannot be applied to another, so a reply that finished and
      // opened a new one while somebody was reaching for this control opens a
      // drawer about the new one rather than carrying stale choices into it.
      const held = state.configuring;
      return {
        state: Object.freeze({
          ...state,
          // The form and Configure are alternative contents of one pane, so
          // opening this hides that — and hiding it keeps its question, its
          // partial values and its messages exactly as they were.
          asking:
            state.asking === undefined
              ? undefined
              : Object.freeze({ ...state.asking, open: false }),
          configuring: Object.freeze({
            conversation: action.conversation,
            open: true,
            naming: false,
            refusal: undefined,
            // Initialized from what was *saved*, never from what this drawer
            // last held: unapplied selections were discarded when it closed,
            // and the saved preference is the thing a next turn will use.
            agent: live.sidekick?.agent ?? "",
            model: live.sidekick?.requested?.model,
            effort: live.sidekick?.requested?.effort,
            // What the agent advertised, kept across a close for the
            // conversation it was read of. Choices are not selections: a list
            // this agent gave for this conversation is still true, so
            // reopening reuses it rather than asking again — and a different
            // conversation starts with none, because they are not its.
            offered: held.conversation === action.conversation ? held.offered : undefined,
            reading: true,
            // A new selection, even where it opens on exactly the values the
            // last one applied: opening is a deliberate act, and an Apply
            // still in flight was asked by the drawer before this one.
            revision: held.revision + 1,
          }),
          refusal: undefined,
        }),
        // Explicitly asked for, so it explicitly inspects. Opening a drawer is
        // the one moment a person has said they want to know what the agent
        // offers; nothing else here asks.
        intent: {
          kind: "inspect-configuration",
          conversation: action.conversation,
          // The model this drawer is actually showing, which is the saved
          // preference rather than whatever the drawer held last: asking about
          // one model and labelling the answer with another is how an
          // inspection's defaults get relabelled as somebody's saved choice.
          model: live.sidekick?.requested?.model,
        },
      };
    }
    case "refresh-configure": {
      if (!state.configuring.open) {
        return refuse(state, "Configure is not open.");
      }
      return {
        state: Object.freeze({
          ...state,
          configuring: Object.freeze({ ...state.configuring, reading: true, refusal: undefined }),
          refusal: undefined,
        }),
        intent: {
          kind: "inspect-configuration",
          conversation: state.configuring.conversation,
          // The model selected *now*, so what comes back is this model's own
          // effort levels rather than whatever the agent happens to be on.
          model: state.configuring.model,
        },
      };
    }
    case "close-configure": {
      if (!state.configuring.open) {
        return refuse(state, "Configure is not open.");
      }
      return closedConfigure(state);
    }
    case "choose-model": {
      if (!state.configuring.open) {
        return refuse(state, "Configure is not open.");
      }
      const offered = state.configuring.offered;
      if (offered === undefined || !offered.models.some((one) => one.id === action.model)) {
        // Never a value this agent did not offer: a stray id puts nothing in
        // the drawer rather than something the next turn will be refused for.
        return refuse(state, "this agent did not offer that model.");
      }
      return settled({
        ...state,
        configuring: Object.freeze({
          ...state.configuring,
          model: action.model,
          // Effort belongs to a model. Choosing another model leaves the effort
          // of the one before it behind rather than carrying a level that
          // model may not have at all.
          effort: undefined,
          refusal: undefined,
          revision: state.configuring.revision + 1,
        }),
        refusal: undefined,
      });
    }
    case "choose-effort": {
      if (!state.configuring.open) {
        return refuse(state, "Configure is not open.");
      }
      const levels = state.configuring.offered?.effort;
      if (
        levels === undefined ||
        levels.model !== state.configuring.model ||
        !levels.levels.some((one) => one.id === action.effort)
      ) {
        // Only the levels of the model selected now. A list read for another
        // model is not this model's, and an unread one is not a list.
        return refuse(state, "that effort does not belong to the model chosen here.");
      }
      return settled({
        ...state,
        configuring: Object.freeze({
          ...state.configuring,
          effort: action.effort,
          refusal: undefined,
          revision: state.configuring.revision + 1,
        }),
        refusal: undefined,
      });
    }
    case "name-agent": {
      if (!state.configuring.open) {
        return refuse(state, "Configure is not open.");
      }
      return settled({
        ...state,
        configuring: Object.freeze({ ...state.configuring, naming: true, refusal: undefined }),
        refusal: undefined,
      });
    }
    case "apply-configure": {
      if (!state.configuring.open) {
        return refuse(state, "Configure is not open.");
      }
      const held = state.configuring;
      const current = live.sidekick?.agent;
      if (held.agent !== "" && current !== undefined && held.agent !== current) {
        // A different agent is a different conversation, explicitly. The old
        // chat and its association stay; nothing of this drawer's choices goes
        // with it, because they were made about another agent.
        return {
          state: Object.freeze({ ...state, refusal: undefined }),
          intent: {
            kind: "replace-agent",
            agent: held.agent,
            conversation: held.conversation,
            revision: held.revision,
          },
        };
      }
      // The whole of what is asked for, every time, and never a patch: an
      // omitted setting asks for no change to it.
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "save-configuration",
          conversation: held.conversation,
          revision: held.revision,
          ...(held.model === undefined ? {} : { model: held.model }),
          ...(held.effort === undefined ? {} : { effort: held.effort }),
        },
      };
    }
    case "retry-message": {
      return {
        state: Object.freeze({ ...state, refusal: undefined }),
        intent: {
          kind: "retry-message",
          conversation: action.conversation,
          message: action.message,
        },
      };
    }
    case "scroll-sidekick-question": {
      if (asking === undefined) {
        return refuse(state, "the Sidekick's question form is not open.");
      }
      const window = admission.windows.get(DRAWER_WINDOW);
      if (window === undefined) {
        return refuse(state, "this frame has not measured that form yet.");
      }
      return settled({
        ...state,
        asking: Object.freeze({
          ...asking.held,
          form: Object.freeze({
            ...asking.held.form,
            offset: scrolled(window, action.delta),
          }),
        }),
        refusal: undefined,
      });
    }
    case "scroll-configure": {
      // Presented rather than merely open: a drawer behind a route drawer, or
      // one a narrower frame drew nothing of, is not what these controls
      // belong to — and the controls are drawn by the same answer.
      if (presented?.kind !== "configure") {
        return refuse(state, "Configure is not the drawer on screen.");
      }
      const window = admission.windows.get(DRAWER_WINDOW);
      if (window === undefined) {
        return refuse(state, "this frame has not measured that drawer yet.");
      }
      return settled({
        ...state,
        viewports: Object.freeze({
          ...state.viewports,
          configure: scrolled(window, action.delta),
        }),
        refusal: undefined,
      });
    }
    case "scroll": {
      const open = state.route.drawers[state.route.drawers.length - 1];
      if (open === undefined) {
        return refuse(state, "no drawer is open to scroll.");
      }
      // The window the frame measured for the drawer that is open. One viewport
      // moves at a time, because one drawer is read at a time; which offset the
      // new position is stored in is decided by what is being read.
      const window = admission.windows.get(DRAWER_WINDOW);
      if (open.kind === "live-permission") {
        const pending =
          state.permission === undefined ? undefined : offered(state, live, state.permission);
        if (pending === undefined) {
          return refuse(state, "no permission request is being answered.");
        }
        if (window === undefined) {
          return settled({ ...state, refusal: undefined });
        }
        return settled({
          ...state,
          viewports: Object.freeze({
            ...state.viewports,
            permission: scrolled(window, action.delta),
          }),
          refusal: undefined,
        });
      }
      if (open.kind === "live-elicit") {
        if (!answering) {
          return refuse(state, "nothing is being asked right now.");
        }
        if (window === undefined) {
          return settled({ ...state, refusal: undefined });
        }
        return settled({
          ...state,
          form: Object.freeze({ ...state.form, offset: scrolled(window, action.delta) }),
          refusal: undefined,
        });
      }
      // A retained reading: History, a binding's value or a recorded answer.
      // Scrolling one changes that reading's own offset and nothing else — no
      // canonical location, no Journal, no History selection and no answer.
      const reading = readingKeyOf(state, open);
      if (reading === undefined || window === undefined) {
        return settled({ ...state, refusal: undefined });
      }
      return settled({
        ...state,
        viewports: Object.freeze({
          ...state.viewports,
          readings: Object.freeze({
            ...state.viewports.readings,
            [reading]: scrolled(window, action.delta),
          }),
        }),
        refusal: undefined,
      });
    }
  }
}

/**
 * The Sidekick form this screen is presenting, with the question it is for.
 *
 * Both halves or neither: a form whose key names no pending question is a form
 * nobody can answer, so there is nothing for a keystroke to edit. This is also
 * the one place that decides the Sidekick's drawer is the open one, which is
 * what lets every form action below belong to exactly one owner.
 */
function openAsking(
  state: ReplState,
  live: ReplLive,
  /**
   * The question whose form the frame this action was dispatched against was
   * actually presenting, as that frame answered it.
   *
   * Required, and the whole decision. A form may be held open in state while
   * the screen is showing something else entirely — a narrower frame routing
   * its one outlet to Entries, another pane selected, a route drawer in front
   * of it — and keys sent to a visible input would then be swallowed by a form
   * nobody can see. What owns typing is what is drawn, so the frame says so.
   */
  presented: string | undefined,
):
  | {
      readonly key: string;
      readonly held: ReplAsking;
      readonly question: ReplSidekickQuestion;
    }
  | undefined {
  const held = state.asking;
  const question = live.sidekick?.question;
  if (
    held === undefined ||
    !held.open ||
    question === undefined ||
    question.key !== held.key ||
    presented !== held.key
  ) {
    return undefined;
  }
  return { key: held.key, held, question };
}

function editCaret(
  state: ReplState,
  live: ReplLive,
  action: Extract<ReplAction, { readonly kind: "type" | "erase" | "move-caret" }>,
  configuring: boolean,
  asking: ReturnType<typeof openAsking>,
  answering: boolean,
  presented: ReplPresented | undefined,
): ReplTransition {
  if (action.purpose !== undefined) {
    const top = state.route.drawers.at(-1);
    const available =
      !state.heldHistory &&
      !state.catalog &&
      (action.purpose === "sidekick-answer"
        ? top === undefined &&
          asking !== undefined &&
          action.question === asking.key &&
          live.sidekick?.current !== false
        : action.purpose === "answer"
          ? top?.kind === "live-elicit" &&
            live.question !== undefined &&
            presented?.kind === "entry-question" &&
            presented.question === live.question
          : action.purpose === "configure-agent"
            ? top === undefined && configuring
            : top === undefined && presented === undefined && asking === undefined && !configuring);
    if (
      !available ||
      ((action.purpose === "answer" || action.purpose === "sidekick-answer") &&
        action.field === undefined)
    ) {
      return refuse(state, "this field is no longer presented for its owner.");
    }
  }
  const change = (value: string, saved: ReplCaret | undefined): ReplCaret => {
    const caret = caretFor(value, saved);
    if (action.kind === "type") {
      return insertAt(caret, action.text);
    }
    if (action.kind === "erase") {
      return eraseAt(caret);
    }
    return action.caret?.value === value ? caretFor(value, action.caret) : caret;
  };
  if (configuring) {
    const caret = change(state.configuring.agent, state.configuring.caret);
    const next = action.kind === "move-caret" ? state : renaming(state, caret.value).state;
    return settled({ ...next, configuring: { ...next.configuring, caret } });
  }
  if (asking !== undefined || answering) {
    const form = asking?.held.form ?? state.form;
    const declared = asking?.question.form.fields ?? live.question?.form.fields ?? [];
    const field =
      action.field === undefined
        ? (declared.find((one) => one.name === form.field) ?? declared[0])
        : declared.find((one) => one.name === action.field);
    if (field === undefined) {
      return refuse(state, "this question has no such field.");
    }
    const caret = change(form.values[field.name] ?? "", form.carets?.[field.name]);
    const next = action.kind === "move-caret" ? form : written(form, field.name, caret.value);
    const edited = { ...next, field: field.name, carets: { ...next.carets, [field.name]: caret } };
    return asking === undefined
      ? settled({ ...state, form: edited })
      : settled({ ...state, asking: { ...asking.held, form: edited } });
  }
  if (action.field === MESSAGE_FIELD) {
    const caret = change(state.message, state.messageCaret);
    const next = action.kind === "move-caret" ? state : messaging(state, caret.value).state;
    return settled({ ...next, messageCaret: caret });
  }
  const caret = change(state.draft, state.draftCaret);
  const next = action.kind === "move-caret" ? state : drafting(state, caret.value).state;
  return settled({ ...next, draftCaret: caret });
}

/**
 * The same state with the Sidekick's form hidden, keeping everything in it.
 *
 * Selecting another pane or surface takes the form off the screen, and coming
 * back must not put it there again: the question is still waiting and the
 * values are still typed, and reopening it is a deliberate act in both
 * directions. No background event reopens a modal somebody navigated away from.
 */
function hidingAsking(state: ReplState): ReplState {
  if (state.asking === undefined || !state.asking.open) {
    return state;
  }
  return Object.freeze({ ...state, asking: Object.freeze({ ...state.asking, open: false }) });
}

/**
 * The state after one explicit inspection answered.
 *
 * Ignored unless it is still the drawer's own question: a result for a
 * conversation that has since been replaced, or for a drawer that has been
 * closed, is an answer to something nobody is asking any more — and drawing it
 * would put another agent's choices in front of somebody.
 *
 * The effort levels come with the model they were read against, because effort
 * belongs to a model: a list read for one says nothing about another.
 */
export function offering(
  state: ReplState,
  conversation: string | undefined,
  /** The model these effort levels were read for, as the read asked. */
  model: string | undefined,
  read: Result<AgentOptions>,
  agent: string,
): ReplState {
  const held = state.configuring;
  if (!held.open || held.conversation !== conversation) {
    return state;
  }
  if (!read.ok) {
    return Object.freeze({
      ...state,
      configuring: Object.freeze({ ...held, reading: false, refusal: read.error.message }),
    });
  }
  return Object.freeze({
    ...state,
    configuring: Object.freeze({
      ...held,
      reading: false,
      refusal: undefined,
      offered: Object.freeze({
        conversation: conversation ?? "",
        agent,
        // `null` is an agent that offers no model choice at all, which is a
        // different answer from offering choices none of which is yours — so it
        // becomes no selector rather than an empty one.
        models: Object.freeze((read.value.model?.options ?? []).map(offeredChoice)),
        // Tagged with the model the read *asked about*, and kept only while
        // that is still the model selected here. An agent asked about one model
        // answers with that model's levels, so labelling them with whatever is
        // selected by the time they arrive offers a choice the selected model
        // may not have at all.
        effort:
          read.value.effort === null || model === undefined || model !== held.model
            ? undefined
            : Object.freeze({
                model,
                levels: Object.freeze(read.value.effort.options.map(offeredChoice)),
              }),
      }),
    }),
  });
}

/** One provider-authored choice, copied out as the drawer reads it. */
function offeredChoice(choice: AgentOption): ReplOfferedChoice {
  return Object.freeze({
    id: choice.id,
    name: choice.name,
    // The provider's own words, kept as the provider wrote them or absent. A
    // label is never what is saved: the id is.
    description: choice.description ?? undefined,
    group: choice.group?.name ?? undefined,
  });
}

/**
 * The state after an explicit configuration action could not even start.
 *
 * Said in the drawer rather than only beside the chat, because the drawer is
 * what somebody is looking at when they press one of its controls: a reason
 * that appeared somewhere else would read as the control doing nothing.
 */
export function unavailable(
  state: ReplState,
  conversation: string | undefined,
  reason: string,
): ReplState {
  const held = state.configuring;
  if (!held.open || held.conversation !== conversation) {
    return state;
  }
  return Object.freeze({
    ...state,
    configuring: Object.freeze({ ...held, reading: false, refusal: reason }),
  });
}

/**
 * The state after an Apply answered.
 *
 * Success closes Configure, because the choices are saved and there is nothing
 * left in the drawer that is not in the history. A failure keeps every choice
 * and says why, so it can be corrected rather than retyped.
 */
export function applied(
  state: ReplState,
  /** The conversation this Apply was asked of, so a late one cannot close a newer drawer. */
  conversation: string | undefined,
  /** The selection that asked for it, by its own number rather than its values. */
  revision: number,
  answer: Result<void>,
): ReplState {
  const held = state.configuring;
  // Still the drawer this answer is about, and still the selection that asked.
  // A drawer opened again, pointed at another conversation, or edited since is
  // a different selection — closing it on an older answer would take a person
  // out of something they are in the middle of, and comparing values instead
  // cannot tell a deliberate reopen from the Apply that preceded it.
  if (!held.open || held.conversation !== conversation || held.revision !== revision) {
    return state;
  }
  if (!answer.ok) {
    return Object.freeze({
      ...state,
      configuring: Object.freeze({ ...held, refusal: answer.error.message }),
    });
  }
  return Object.freeze({
    ...state,
    configuring: closed(state.configuring),
    restore: Object.freeze({ kind: "sidekick-configure" }),
    refusal: undefined,
  });
}

/**
 * The state after an agent replacement answered.
 *
 * The drawer first, by the same rules every other Apply answers by. Then the
 * reading: a replacement asked for from the chat somebody is explicitly
 * reading leaves that chat behind, so a success clears the selector and puts
 * them in the new current chat — which is the conversation their next message
 * would go to anyway.
 *
 * Only where the selector still names the chat that was replaced. A failure
 * preserves both the reading and the association it was asked of, and a
 * selector pointing somewhere else is a newer deliberate reading that a
 * replacement finishing afterwards must not overwrite.
 */
export function replacedAgent(
  state: ReplState,
  conversation: string | undefined,
  revision: number,
  answer: Result<void>,
): ReplState {
  const settledState = applied(state, conversation, revision, answer);
  if (!answer.ok || conversation === undefined || settledState.route.sidekick !== conversation) {
    return settledState;
  }
  return Object.freeze({
    ...settledState,
    route: Object.freeze({ ...settledState.route, sidekick: undefined }),
  });
}

/**
 * Configure, closed, by whichever of its two exits somebody reached.
 *
 * One transition for both, because closing a drawer is one act: the visible
 * `[close]` control and Escape are two ways to ask for it, not two meanings of
 * it. Written once so they cannot drift — a modal whose keyboard exit discarded
 * something its button kept, or vice versa, would make the way out depend on
 * how a person found it.
 *
 * Closing saves nothing and asks the provider for nothing. What was chosen and
 * not applied is discarded, so reopening starts from the saved preference again
 * — which is the only thing a next turn will use. What the agent advertised
 * stays: a list it gave for this conversation is not a selection somebody made.
 * An Apply already acknowledged is a saved preference and is not touched; it
 * stopped being part of this drawer when it landed.
 *
 * Focus goes back to the control that opened it, which is the one thing on the
 * screen that is about this drawer.
 */
function closedConfigure(state: ReplState): ReplTransition {
  return settled({
    ...state,
    configuring: closed(state.configuring),
    restore: Object.freeze({ kind: "sidekick-configure" }),
    refusal: undefined,
  });
}

/**
 * The state after the agent name in Configure was edited.
 *
 * An exact name rather than a choice from a list: which agents exist is the
 * provider's to answer, and `select()` validates what is typed against the real
 * one. Nothing else in the drawer moves — a name being typed is not a model or
 * an effort being chosen.
 */
function renaming(state: ReplState, agent: string): ReplTransition {
  return settled({
    ...state,
    configuring: Object.freeze({
      ...state.configuring,
      agent,
      naming: true,
      refusal: undefined,
      // The agent is part of what Apply would do, so editing it is a different
      // selection: a save already in flight was asked by the one before it.
      revision: state.configuring.revision + 1,
    }),
    refusal: undefined,
  });
}

/**
 * The drawer with nothing selected, closed, and its advertisements kept.
 *
 * The one shape both ways of leaving Configure produce. Selections go because
 * they were never saved; what the agent offered stays, because it is a fact
 * about this agent and this conversation rather than a choice anybody made.
 */
function closed(held: ReplConfiguring): ReplConfiguring {
  return Object.freeze({
    ...NOT_CONFIGURING,
    conversation: held.conversation,
    offered: held.offered,
    // Kept, so the next drawer counts on from here rather than reusing a
    // number an Apply in flight is still naming.
    revision: held.revision,
  });
}

/**
 * What this process names one pending Sidekick question, and the form for it.
 *
 * Called once per pass of the loop, before anything is drawn. A question that
 * ended takes its form and its presentation with it; a *different* question
 * starts empty, because values typed for one question are not an answer to
 * another; and the same question keeps both, through close, tab changes,
 * History selection and resizing.
 */
export function askingFor(state: ReplState, question: ReplSidekickQuestion | undefined): ReplState {
  if (question === undefined) {
    return state.asking === undefined ? state : Object.freeze({ ...state, asking: undefined });
  }
  if (state.asking?.key === question.key) {
    return state;
  }
  return Object.freeze({
    ...state,
    asking: Object.freeze({ key: question.key, open: false, form: EMPTY_FORM }),
  });
}

/** One field's value replaced, leaving every other field alone. */
function written(form: ReplFormState, field: string, value: string): ReplFormState {
  const carets = { ...form.carets };
  delete carets[field];
  return Object.freeze({
    carets,
    ...form,
    values: Object.freeze({ ...form.values, [field]: value }),
    // A value that has changed makes the last verdict about the old one stale,
    // so the messages go rather than sitting under a form they no longer
    // describe.
    messages: Object.freeze([]),
  });
}

/**
 * The request this action may act on, or none.
 *
 * One request: the one this screen selected *and* the one still pending. An
 * unknown key, a stale key and a key for a request that has since settled all
 * answer none, so nothing is settled on their behalf.
 */
function offered(
  state: ReplState,
  live: ReplLive,
  request: string,
): ReplLivePermission | undefined {
  if (state.permission !== request) {
    return undefined;
  }
  return live.agent.requests.find((candidate) => candidate.key === request);
}

/**
 * One offset, inside the window it is over.
 *
 * The one place either window decides where it is, so what a reducer moves from
 * and what a frame draws cannot be two different rows.
 */
function clamped(offset: number, furthest: number): number {
  return Math.min(Math.max(0, offset), furthest);
}

/**
 * The entry root a live question is answered against.
 *
 * The last entry this prefix admitted, because entries are serial and only that
 * one can still be asking. The scopes already selected are kept when they are
 * already inside it, so opening the drawer from a nested scope of the running
 * entry does not throw away the place somebody was reading.
 */
function askingEntry(model: ReplModel, scopes: readonly string[]): readonly string[] {
  const asking = model.entries[model.entries.length - 1];
  if (asking === undefined) {
    return scopes;
  }
  return scopes[0] === asking.key ? scopes : Object.freeze([asking.key]);
}

/**
 * The same route without the drawers only this process could mount.
 *
 * A waiting question and a pending request exist in this process and in no
 * history, so a location naming one is a location nobody — including this
 * machine, a moment later — can reopen. Printing the route a person left is only
 * useful if it is a route they can come back to, so the live-only members come
 * off on the way out. Nothing is settled to do it: the drawer is removed, not
 * answered, and what the file holds is untouched.
 */
export function withoutLiveDrawers(state: ReplState): ReplState {
  const remaining = state.route.drawers.filter(
    (drawer) => drawer.kind !== "live-elicit" && drawer.kind !== "live-permission",
  );
  if (remaining.length === state.route.drawers.length) {
    return state;
  }
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, drawers: Object.freeze(remaining) }),
  });
}

/**
 * The same state once the question its drawer was asking has gone.
 *
 * Teardown and a settlement elsewhere can both end a question while its drawer is
 * up. The drawer and what was typed into it go, and neither becomes an answer:
 * the form is discarded rather than submitted, because a person who was still
 * filling it in never offered it.
 */
export function elicitWithdrawn(state: ReplState): ReplState {
  const remaining = state.route.drawers.filter((drawer) => drawer.kind !== "live-elicit");
  if (remaining.length === state.route.drawers.length) {
    return state;
  }
  return Object.freeze({
    ...state,
    form: EMPTY_FORM,
    restore: undefined,
    route: Object.freeze({ ...state.route, drawers: Object.freeze(remaining) }),
  });
}

/**
 * Where the chat window has to be for one pending reveal to be in it, or none.
 *
 * As little as it takes, exactly as a restored focus request moves the catalog:
 * a turn above the window brings it up to that turn, one below brings it down
 * until that turn is the last row shown, and a turn the window already holds
 * moves nothing.
 *
 * The capacity is the one the frame asking measured, which is the frame the
 * turn is about to be read in. None where this frame cannot place it: no
 * measured chat window, no reading, or a chat that holds no such turn.
 *
 * The rows are built for the chat the reveal names, through the one builder the
 * description and the measurement both use, so the row this lands on is the row
 * the screen draws.
 */
function revealedAt(
  reveal: ReplSidekickReveal,
  reading: ReplSidekickReading | undefined,
  capacity: number,
  /** The rows this frame fitted, so a reveal lands on a row that is drawn. */
  fitted: readonly ReplFittedLine[] | undefined,
  /**
   * What this process is holding for the chat being read.
   *
   * The same staging the description pass gives the builder. Without it the row
   * list this searches is a *different* list from the one the window counts
   * rows of — measured, a twelve-turn chat the frame drew as 47 rows came back
   * from here as 24, and the index found in the short list named a row the long
   * one has somewhere else. A reveal is an index into the drawn list or it is
   * nothing.
   */
  staging: ReplChatStaging | undefined,
): number | undefined {
  if (capacity < 1 || reading === undefined) {
    return undefined;
  }
  // The turn's own result, not the first row carrying its number. A turn is a
  // request and what came back: the row a reader was sent to see is the
  // evaluated reply, the failure, or the anchor saying nothing was recorded —
  // landing on the request would put the answer below the window's last row.
  const items = reading.chat.filter(
    (item) => item.conversation === reveal.conversation && item.turn === reveal.turn,
  );
  // In the order they answer "what is this turn", and every one of them an item
  // this reading already holds. The request is last and is the one that is not
  // this turn's own result: it is what remains visible of a turn whose
  // successful reply said nothing to anybody, and nothing is composed to serve
  // as an anchor — a turn this history cannot associate reveals nothing, which
  // is the honest answer.
  const candidates = [
    ...items.filter((item) => item.kind !== "person").map((item) => item.key),
    ...items.filter((item) => item.kind === "person").map((item) => item.key),
    ...items.flatMap((item) => (item.request === undefined ? [] : [item.request])),
  ];
  if (candidates.length === 0) {
    return undefined;
  }
  // Focus is not a fact about where a row is, so none is stated: the marker
  // would change what one row's text says and not which row it is.
  const rows = sidekickReadingRows(
    Object.freeze({ ...reading, reading: reveal.conversation }),
    undefined,
    fitted,
    staging,
  );
  // The first candidate this frame actually draws, at its *first* row, which is
  // the one its key is on: a message cut into three rows is revealed from its
  // beginning, not from wherever it ends. Asked of the same rows the screen
  // paints, so a reveal cannot land on a row that does not exist.
  const at = candidates
    .map((key) => rows.findIndex((item) => item.key === `sidekick:${key}`))
    .find((found) => found >= 0);
  if (at === undefined) {
    return undefined;
  }
  return Math.min(Math.max(0, at - capacity + 1), at);
}

/**
 * The same state with the Transcript's conversation choices put away.
 *
 * Choosing one is the whole of what the chooser is for, so it closes behind the
 * choice rather than staying open over the reading it just changed.
 */
function chosen(state: ReplState): ReplState {
  return state.filtering ? Object.freeze({ ...state, filtering: false }) : state;
}

/** The same state with the catalog's own window back at its first row. */
function atFirstEntry(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    viewports: Object.freeze({ ...state.viewports, entries: 0 }),
  });
}

/** The same state with the Sessions reading back at its first row. */
function atFirstRow(state: ReplState): ReplState {
  return Object.freeze({
    ...state,
    viewports: Object.freeze({ ...state.viewports, sessions: 0 }),
  });
}

function settled(state: ReplState): ReplTransition {
  return { state: Object.freeze(state), intent: { kind: "none" } };
}

function refuse(state: ReplState, reason: string): ReplTransition {
  return { state: Object.freeze({ ...state, refusal: reason }), intent: { kind: "none" } };
}

/**
 * The draft, and the canonical query that carries it.
 *
 * Every edit raises the draft's revision, because the revision is how an
 * admission names the text it took. An edit a *person* made also takes the
 * draft over: from here the Sidekick's automatic replacement and submission are
 * paused until the next explicit instruction, which is the one thing that stops
 * a reply overwriting what somebody is in the middle of typing.
 */
function drafting(state: ReplState, draft: string, by: Submitter = "person"): ReplTransition {
  return settled({
    ...state,
    draft,
    // The draft is route state, so the location always says what would be
    // submitted. It is the one thing in the URL that is not yet durable.
    route: Object.freeze({ ...state.route, draft: draft.length === 0 ? undefined : draft }),
    refusal: undefined,
    revisions: edited(state.revisions, "draft"),
    takenOver: by === "person" ? true : state.takenOver,
  });
}

/**
 * The Sidekick's reading, its input and the controls that act on it.
 *
 * Everything here is described from detached facts and answers with an ordinary
 * action: the chat and what a response is saying as it arrives, the box, Send
 * or Stop, the way into a pending question, Configure, and the retry a failed
 * request offers. Nothing stands in for an operation this screen cannot
 * perform — a placeholder promising one is worse than its absence, because a
 * reader cannot tell the difference until they press it.
 */
/**
 * One composed row of the Sidekick's reading: text to read, or a control.
 *
 * Composed before any width is known, because what a message *is* does not
 * depend on how wide the pane turned out to be. A `text` row is one logical
 * line somebody wrote or this screen wrote about them, and the frame cuts it
 * into as many rows as it needs; a `control` is activated rather than read and
 * is never cut, because a label broken over two rows is half a control on each
 * of them.
 */
type ReplChatComposed =
  | {
      readonly kind: "text";
      readonly key: string;
      readonly text: string;
      readonly style: ReplRowStyle;
      /** The origin drawn over the first four cells of its first row, where marked. */
      readonly mark?: ReplOriginMark;
    }
  | { readonly kind: "control"; readonly described: Described };

function sidekickComposedRows(
  reading: ReplSidekickReading | undefined,
  /** The key of whatever holds focus, for the one row that wears the marker. */
  focused: string | undefined,
  /** The staged composition's associated work, where this reading is drawn there. */
  staging?: ReplChatStaging,
): readonly ReplChatComposed[] {
  if (
    staging !== undefined &&
    reading !== undefined &&
    reading.refusal === undefined &&
    (reading.setup === undefined || reading.setup.phase === "activated")
  ) {
    return workspaceChatComposed(reading, staging, focused);
  }
  const items: ReplChatComposed[] = [];
  /** One row of readable text, which a width still has to cut into rows. */
  const text = (key: string, label: string, style: ReplRowStyle): ReplChatComposed =>
    Object.freeze({ kind: "text" as const, key, text: label, style });
  /** One row that is activated rather than read, which is never cut. */
  const control = (described: Described): ReplChatComposed =>
    Object.freeze({ kind: "control" as const, described });
  if (reading === undefined) {
    // No Sidekick on this screen at all. Said rather than drawn as an empty
    // conversation, because the two are different facts.
    items.push(text("sidekick:absent", "  This screen has no Sidekick.", styleOf("metadata")));
    return items;
  }
  if (reading.refusal !== undefined) {
    // An unreadable chat history. The reason stands in the pane rather than
    // being replaced by an empty conversation.
    items.push(text("sidekick:refusal", `  ${reading.refusal}`, styleOf("failed-outcome")));
    return items;
  }
  // The chat this location selected, which is the current one unless it named
  // another. Every chat's rows are composed, so reading an older one is a
  // filter over them rather than a second reading assembled somewhere else.
  const shownChat = reading.chat.filter((item) => item.conversation === reading.reading);
  const setup = reading.setup;
  if (setup !== undefined && setup.phase !== "activated") {
    // What this chat's own setup came to. First, because it is the fact that
    // decides what the rows below it can mean: a chat that was never activated
    // was never prompted, and one whose setup failed kept the reason it did.
    items.push(
      text(
        "sidekick:setup",
        setup.phase === "failed"
          ? `  Setup failed: ${setup.failure ?? "no reason was recorded."}`
          : "  Setup did not finish: this chat was never activated.",
        setup.phase === "failed" ? styleOf("failed-outcome") : styleOf("metadata"),
      ),
    );
  }
  if (shownChat.length === 0) {
    items.push(text("sidekick:empty", "  No messages yet.", styleOf("metadata")));
  }
  for (const item of shownChat) {
    if (item.kind === "person") {
      items.push(
        text(
          `sidekick:${item.key}`,
          `  ${item.origin?.kind === "acp" ? "ACP (" + item.origin.attachment + ")" : "you"}: ${item.text}`,
          styleOf("source"),
        ),
      );
      continue;
    }
    if (item.kind === "preview") {
      // What the agent is saying, as it says it. Labelled, because this is not
      // a reply: nothing has been evaluated, no control has run and no turn is
      // acknowledged — and once one is, this same item becomes that reply.
      //
      // `incomplete` is the other ending. A generation that stopped with
      // nothing saved still said this, so it stays, said as the attempt it is
      // rather than as an answer or a failure anybody recorded.
      items.push(
        text(
          `sidekick:${item.key}`,
          item.incomplete === true
            ? `  ${reading.agent} (unfinished): ${item.text}`
            : `  ${reading.agent} (preview): ${item.text}`,
          item.incomplete === true ? styleOf("failed-outcome") : styleOf("waiting"),
        ),
      );
      continue;
    }
    if (item.kind === "saved") {
      // The turn, inert, where its record sits. A saved Prompt says the
      // provider finished; it says nothing about the program it returned
      // having been evaluated. So this is what a reader lands on when they
      // open the chat at this turn, and it claims nothing more than that.
      items.push(
        text(
          `sidekick:${item.key}`,
          item.automatic === true ? `  Automatic feedback \u00b7 ${item.text}` : `  ${item.text}`,
          styleOf("metadata"),
        ),
      );
      continue;
    }
    if (item.kind === "incomplete") {
      // The attempt, and the way to ask for the same thing again. Offered only
      // where this history can establish *which* saved request failed: the row
      // carries that request's own conversation and message id, because text
      // names nothing and two requests may read identically.
      const asked = item.retry;
      // An attempt, said as one. It performed no control and nobody finished
      // writing it, so it is not presented as a reply and its retained reason
      // travels with it.
      items.push(
        text(
          `sidekick:${item.key}`,
          `  ${reading.agent} (unfinished): ${item.failure ?? "this turn did not complete"}`,
          styleOf("failed-outcome"),
        ),
      );
      if (item.text !== "") {
        // What that turn had actually said, as the literal Output its saved
        // source projects. Said after the reason, because the reason is why
        // there is no more of it.
        items.push(text(`sidekick:${item.key}:said`, `  ${item.text}`, styleOf("source")));
      }
      if (asked !== undefined && reading.current) {
        items.push(
          control(
            row(
              `sidekick:retry:${asked.message}`,
              "[retry]",
              { select: "retry-message", conversation: asked.conversation, message: asked.message },
              styleOf("action"),
              { here: focused },
            ),
          ),
        );
      }
      continue;
    }
    if (item.failure !== undefined) {
      // An evaluated reply that failed, said as the failure it is and never as
      // an answer. The reason is what a reader can act on, so it stands whether
      // or not the response that failed had selected any Output.
      items.push(
        text(
          `sidekick:${item.key}`,
          `  ${reading.agent} (failed): ${item.failure}`,
          styleOf("failed-outcome"),
        ),
      );
      if (item.hasOutput) {
        // And what it had already rendered, after the reason, because the
        // reason is why there is no more of it.
        items.push(text(`sidekick:${item.key}:said`, `  ${item.text}`, styleOf("output")));
      }
      continue;
    }
    if (!item.hasOutput) {
      // A reply that succeeded and selected no person-facing chat said nothing
      // to the person, and contributes nothing to read. The work it did is in
      // Sessions and in its own records; its body is not chat and is
      // deliberately not shown as any — a response's source, its chapters and
      // its feedback envelope are not what it told somebody, and a sentence
      // about the absence is not something it said either.
      continue;
    }
    items.push(text(`sidekick:${item.key}`, `  ${reading.agent}: ${item.text}`, styleOf("output")));
  }
  return items;
}

/**
 * One composed row's own lines, as whoever wrote them wrote them.
 *
 * Split before anything is measured, because a line break is content and a
 * width is not: a message holding three lines holds three lines at every size,
 * and fitting measures each of them against the pane separately. A width-only
 * cut would leave the breaks inside one row's text, which is exactly how a
 * message comes to be drawn over the row below it.
 *
 * The first line keeps the row's own key, so everything that already names
 * that row — a description, a reveal, a test — still finds it. The rest are
 * derived display rows under it, and are not messages, turns or records.
 */
function chatLinesOf(
  key: string,
  text: string,
): readonly { readonly key: string; readonly text: string }[] {
  return text.split("\n").map((own, offset) => ({
    key: offset === 0 ? key : `${key}::${offset}`,
    text: own,
  }));
}

/**
 * Every readable line of the Sidekick's reading, by the key that owns it.
 *
 * What the frame preparation fits. It comes from the same composition the rows
 * below are built from, so the list a width is measured against and the list
 * that is drawn cannot be two different lists.
 */
export function sidekickChatLines(
  reading: ReplSidekickReading | undefined,
  staging?: ReplChatStaging,
): readonly { readonly key: string; readonly text: string }[] {
  return sidekickComposedRows(reading, undefined, staging).flatMap((one) =>
    one.kind === "text" ? chatLinesOf(one.key, one.text) : [],
  );
}

/**
 * The Sidekick's reading, as the rows a frame of this width actually draws.
 *
 * One composition, cut by `fitted`. A message is text somebody wrote and a row
 * is one line of a terminal, and the two are the same thing only while every
 * message is short enough to fit — so a reading drawn without this cut paints
 * its second line over the next message's row, and the window counts one row
 * for something that occupies three.
 *
 * Without a fitted list this returns the composition as it stands, which is
 * what the pass still asking how wide the pane is must get: text fitted to a
 * width nobody has measured yet would be fitted to nothing. Everything that
 * reads these rows — the descriptions, the window's own count and a Sessions
 * reveal — comes through here with the same list, so a drawn row and the row a
 * scroll clamps against are the same row.
 *
 * A cut row is a display row *under* its item: it carries that item's style and
 * a continuation key the fitting derived, and it is not a new message, turn,
 * response or record.
 */
function sidekickReadingRows(
  reading: ReplSidekickReading | undefined,
  /** The key of whatever holds focus, for the one row that wears the marker. */
  focused: string | undefined,
  /** The lines this frame fitted, or none before it has fitted any. */
  fitted?: readonly ReplFittedLine[] | undefined,
  staging?: ReplChatStaging,
): readonly Described[] {
  const composed = sidekickComposedRows(reading, focused, staging);
  const cuts = new Map<string, ReplFittedLine[]>();
  for (const cut of fitted ?? []) {
    const held = cuts.get(cut.line);
    if (held === undefined) {
      cuts.set(cut.line, [cut]);
    } else {
      held.push(cut);
    }
  }
  const rows: Described[] = [];
  for (const one of composed) {
    if (one.kind === "control") {
      rows.push(one.described);
      continue;
    }
    for (const own of chatLinesOf(one.key, one.text)) {
      const pieces = cuts.get(own.key);
      if (pieces === undefined) {
        // No width was asked for, so this line stands as the one line it is.
        rows.push(chatRow(own.key, own.text, one, own.key === one.key));
        continue;
      }
      for (const piece of pieces) {
        // Continuations are drawn at the column their line began at, which is
        // the room the cut already reserved for them: a wrapped message reads
        // as the one message it is, and a row drawn flush left would be as wide
        // as the fitting assumed it was narrow.
        rows.push(
          chatRow(
            piece.key,
            `${" ".repeat(piece.indent)}${piece.text}`,
            one,
            own.key === one.key && !piece.continuation,
          ),
        );
      }
    }
  }
  return rows;
}

/**
 * One drawn row of a composed chat item, with its origin over the first row.
 *
 * Only the first row of a marked item carries the mark, and only where the room
 * it was composed behind is still there: its continuations are set in to the
 * same column instead.
 */
function chatRow(
  key: string,
  label: string,
  one: { readonly style: ReplRowStyle; readonly mark?: ReplOriginMark },
  first: boolean,
): Described {
  const mark = one.mark;
  if (!first || mark === undefined || !label.startsWith(MARKER_ROOM)) {
    return line(key, label, one.style);
  }
  const drawn = `${mark.text}${label.slice(MARKER_ROOM.length)}`;
  return line(key, drawn, one.style, markedRuns(mark, drawn, one.style.role));
}

/**
 * The Sidekick pane's own controls, which stay put while its chat moves.
 *
 * Outside the window deliberately: a composer, a Send and the way back to the
 * current chat are not part of the reading, and a control that scrolled away
 * from whoever was reaching for it is the one thing this layout exists to
 * prevent.
 *
 * What is here depends on *which* chat is being read, and that is the whole of
 * read-only. The active association keeps every control it has; every other
 * saved chat is a reading of acknowledged history, so it has no composer, no
 * Send, no Retry, no Configure, no pending question and no Stop addressing it —
 * absent from the description rather than drawn and refused, because a control
 * a person cannot tell is inert is worse than no control.
 */
function sidekickControls(
  state: ReplState,
  reading: ReplSidekickReading | undefined,
  view: ReplView,
  claim: string | undefined,
  context: ReplPresentationContext,
): readonly Described[] {
  const items: Described[] = [];
  if (reading === undefined) {
    return items;
  }
  // The way back, wherever a selector is standing. It clears only that
  // selector: the pane stays selected, and the current message draft comes
  // back exactly as it was.
  if (state.route.sidekick !== undefined) {
    items.push(
      row(
        "sidekick:back",
        "[Back to current chat]",
        { select: "sidekick-back" },
        styleOf("action"),
        { here: view.focused },
      ),
    );
  }
  if (reading.refusal !== undefined || !reading.current) {
    // A history nobody can read has nothing to send into, and a chat this
    // Sidekick is not continuing is not a conversation anybody may continue.
    return items;
  }
  // What this conversation is with, and the way to change it. In the header,
  // because an agent and its settings are facts about the whole conversation
  // rather than about any one message in it.
  items.push(
    row(
      "sidekick:configure",
      `[configure ${reading.agent}]`,
      {
        select: "configure",
        ...(reading.conversation === undefined ? {} : { conversation: reading.conversation }),
      },
      styleOf("action"),
      { here: view.focused, ...(claim === "sidekick:configure" ? { focus: true } : {}) },
    ),
  );
  // A question this conversation is waiting on an answer to, said in the pane
  // rather than opened over it. Arrival is an announcement: it takes no tab, no
  // focus and no History position, and opening the form is a separate
  // deliberate act — which is what this control is.
  const question = reading.question;
  if (question !== undefined) {
    items.push(line("sidekick:asking", `  ${reading.agent} has a question.`, styleOf("waiting")));
    items.push(
      row(
        "sidekick:answer",
        // Its own words rather than the footer's `[answer]`. An entry may be
        // asking at the same moment, and two controls reading the same thing
        // would leave a reader — and a pointer — unable to tell which question
        // they were reaching for.
        "[answer sidekick]",
        { select: "sidekick-question", question: question.key },
        styleOf("action"),
        { here: view.focused, ...(claim === "sidekick:answer" ? { focus: true } : {}) },
      ),
    );
  }
  // Where a message is typed, named so the row says which of the two
  // destinations it is. It stays editable while the Sidekick is working: a
  // person composing their next question while a reply comes back is the
  // ordinary case, and what they type is not sent by the cycle finishing.
  const claiming = claim === "sidekick:message";
  items.push(
    field("sidekick:message", "> Message Sidekick: ", state.message, "message", styleOf("draft"), {
      field: MESSAGE_FIELD,
      caret: state.messageCaret,
      here: view.focused,
      block: true,
      ...(claiming ? { focus: true } : {}),
    }),
  );
  // The value itself, in the rows a width cut it into. One row for an empty
  // message, because the box a person types into is a place on the screen
  // whether or not anything is in it yet — and these are read, not reached:
  // the field above owns the value, the focus and the keyboard.
  for (const [at, own] of messageValueRows(context).entries()) {
    items.push(line(`sidekick:message:value:${at}`, own, styleOf("draft")));
  }
  if (reading.busy) {
    // Working, so there is nothing for Send to do — a second cycle cannot queue
    // behind the first one — and Stop is the control that is offered instead.
    items.push(line("sidekick:working", `  ${reading.agent} is working...`, styleOf("waiting")));
    items.push(
      row("sidekick:stop", "[stop]", { select: "stop-sidekick" }, styleOf("action"), {
        here: view.focused,
      }),
    );
    return items;
  }
  items.push(
    row("sidekick:send", "[send]", { select: "send-message" }, styleOf("action"), {
      here: view.focused,
    }),
  );
  return items;
}

/**
 * The state after somebody typed into the Sidekick's own message box.
 *
 * It touches neither the draft nor the takeover: the two texts have two owners,
 * and typing a question to the Sidekick is not taking the shared draft over.
 * The message is process-local and absent from the location, so nothing about
 * it is published.
 */
function messaging(state: ReplState, message: string): ReplTransition {
  return settled({
    ...state,
    message,
    refusal: undefined,
    revisions: edited(state.revisions, "message"),
  });
}

/** The state after the Sidekick filled the shared draft with exactly this. */
export function filled(state: ReplState, source: string): ReplState {
  return Object.freeze({ ...drafting(state, source, "sidekick").state, draftCaret: undefined });
}

/**
 * The state after an explicit instruction to the Sidekick was saved.
 *
 * Applied when the message is actually in the chat history, not at the
 * keystroke that asked for it — so it names the revisions it was asked for at
 * and clears only those. A person who typed another message while the append
 * was in flight keeps it, and one who went back to the shared draft keeps the
 * draft: clearing the takeover is what unpauses automatic submission, and an
 * instruction sent before their edit is not what hands it back.
 */
export function instructed(state: ReplState, held: Instruction): ReplState {
  return Object.freeze({
    ...state,
    ...clearedMessage(held, state),
    refusal: undefined,
  });
}

/**
 * Adopt a candidate route, or keep the one that works.
 *
 * Resolved against the model first: a route that selects nothing is not a view
 * with empty regions, it is a navigation that did not happen.
 */
function navigate(
  state: ReplState,
  model: ReplModel,
  candidate: ReplRoute,
  live: ReplLive,
): ReplTransition {
  const route = Object.freeze({ ...candidate });
  // Against `state`, because what a candidate route may name depends on what
  // this screen has selected: a `+permission` drawer resolves only while the
  // selected request is still pending, so whoever selects one navigates from the
  // state that already holds its key.
  const resolved = resolveLocation(model, route, availabilityOf(state, live));
  if (!resolved.ok) {
    return refuse(state, resolved.error.message);
  }
  return settled({ ...state, route, refusal: undefined });
}

/** How a value reads in one line of a list. */
function summarize(value: Json): string {
  const written = JSON.stringify(cut(value)) ?? "null";
  return written.length <= SUMMARY_WIDTH ? written : `${written.slice(0, SUMMARY_WIDTH - 1)}…`;
}

/** How much of a value one line of a list shows. */
const SUMMARY_WIDTH = 20;

/**
 * The same value with every long string cut to more than a summary can show.
 *
 * A binding is as long as whatever the run bound to it, and a captured command
 * output is megabytes. Writing one out to keep its first twenty columns
 * allocated the whole of it, escapes and all, every time a frame was drawn —
 * which is on every keystroke as well as on every record.
 *
 * What a summary shows is unchanged, and that is a property of where the cut
 * is rather than of the shape of the value. Writing a string escapes each
 * character into one or more characters and never into none, so a string cut
 * to {@link SUMMARY_KEEP} characters writes at least that many — and
 * {@link SUMMARY_KEEP} is beyond the columns a summary keeps. A cut therefore
 * moves no character a reader sees, and a value that holds nothing long enough
 * to cut is written exactly as it was.
 */
function cut(value: Json): Json {
  if (typeof value === "string") {
    return value.length <= SUMMARY_KEEP ? value : value.slice(0, SUMMARY_KEEP);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cut);
  }
  const shorter: { [key: string]: Json } = {};
  for (const [key, member] of Object.entries(value)) {
    // Defined rather than assigned, as `detach()` defines the model's own
    // members: `shorter[key] = …` for the key `__proto__` reaches
    // `Object.prototype`'s inherited setter instead of creating a member, and
    // a value parsed from `{"__proto__":{…}}` would read as `{}`.
    Object.defineProperty(shorter, key, {
      value: cut(member),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return shorter;
}

/**
 * How much of one string a summary may need.
 *
 * Twice the columns it keeps, which is more than escaping can consume: the
 * summary keeps `SUMMARY_WIDTH - 1` characters of written text, and this many
 * characters of a string write as at least this many.
 */
const SUMMARY_KEEP = SUMMARY_WIDTH * 2;

/**
 * One long string as rows that fit, in order, losing nothing.
 *
 * Each row is padded to the full width. A renderer writes what changed, so a row
 * whose text got shorter would otherwise keep the tail of what used to be there —
 * and a location with somebody else's characters on the end of it is worse than
 * no location at all.
 */
function chunked(text: string, width: number): readonly string[] {
  if (width < 1) {
    // No surface to write on. A terminal too small to draw in draws a refusal
    // and nothing else, so this row is never placed — but it must still be a row.
    return [text];
  }
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += width) {
    parts.push(text.slice(at, at + width).padEnd(width, " "));
  }
  return parts.length === 0 ? ["".padEnd(width, " ")] : parts;
}

/**
 * A cell the layout can place, with the key its description was given and what
 * the row means.
 *
 * `style` travels with the row because this is where the facts that decide it
 * are: the record's kind, the entry's terminal status, whether the route is
 * pointing at this row. A later pass reading the finished string could only
 * guess, and guessing from text is how arbitrary document output comes to be
 * drawn as a failure because it happens to contain a word.
 */
interface Described {
  readonly key: string;
  readonly description: ReplDescription<ReplAction>;
  readonly style: ReplRowStyle;
  /**
   * The stretches this row's text is made of, where its characters mean
   * different things.
   *
   * Built here, with the text, from the same pieces — so the runs spell exactly
   * what the row draws. A row whose characters all mean one thing carries none.
   */
  readonly runs?: readonly ReplTokenRun[];
}

/**
 * One row's label as runs, padded to the room it has, the padding reading as the
 * row does.
 *
 * The same arithmetic `pad` does, in runs: a row is padded so that what it draws
 * is exactly as wide as the box it was measured in, and the cells it pads with
 * belong to the row rather than to whatever its last stretch happened to be.
 */
function padded(
  parts: readonly ReplTokenRun[],
  room: number,
  token: ReplPresentationRole,
): readonly ReplTokenRun[] {
  const text = runText(parts);
  if (room < 1 || text.length >= room) {
    return parts;
  }
  return tokenRuns([...parts, { text: "".padEnd(room - text.length, " "), token }]);
}

function row(
  key: string,
  label: string,
  select: { readonly [name: string]: Json },
  style: ReplRowStyle,
  options: {
    readonly focus?: true;
    readonly here?: string | undefined;
    /** The key this frame restores focus to, for the row that turns out to be it. */
    readonly claim?: string | undefined;
    /** What this row's label is made of, where it is made of more than one thing. */
    readonly runs?: readonly ReplTokenRun[];
  } = {},
): Described {
  const claims = options.focus === true || options.claim === key;
  // The marker is its own stretch, which is how a focused row keeps every
  // foreground it had and still says where the next keystroke lands.
  const here = options.here === key;
  const runs = tokenRuns([
    { text: focusPrefixed("", here), token: here ? "focus-marker" : style.role },
    ...(options.runs ?? [{ text: label, token: style.role }]),
  ]);
  return {
    key,
    style,
    runs,
    description: describeNode<ReplAction>({
      key,
      component: SELECT_ROW,
      input: { label, ...select, ...(options.here === key ? { focused: true } : {}) },
      ...(claims ? { focus: true } : {}),
    }),
  };
}

/**
 * Which control this frame requests focus for, because a drawer went.
 *
 * Resolved against what is mounted rather than stored: a request naming a row this
 * view does not draw would be focus asked for on behalf of nothing, and the
 * commit that honoured it would throw. So the request is silent for as long as the
 * row it names is not there — the answer's record has not been projected yet —
 * and the hint waits rather than being spent on nothing.
 */
export function focusClaim(view: ReplView): string | undefined {
  const { state, selection, live } = view;
  if (state.restore === undefined) {
    return undefined;
  }
  if (state.restore.kind === "reveal") {
    return state.restore.key;
  }
  if (modalOpen(view)) {
    return undefined;
  }
  if (state.restore.kind === "asked") {
    return live.question === undefined || state.route.at !== undefined ? undefined : "footer:asked";
  }
  if (state.restore.kind === "message") {
    // Silent while the Sidekick is not the reading on screen — a claim naming a
    // row this view does not draw is focus asked for on behalf of nothing.
    const narrow = profileFor(view.size) === "narrow";
    const showing = narrow
      ? state.route.view === "sidekick"
      : (state.route.right ?? "sidekick") === "sidekick";
    return showing ? "sidekick:message" : undefined;
  }
  if (state.restore.kind === "sidekick-configure") {
    // Silent unless this pane is what the screen is showing, for the same
    // reason the opener beside it is: a claim naming a row this view does not
    // draw is focus asked for on behalf of nothing.
    return selection.drawers.length > 0 || !showingSidekick(view)
      ? undefined
      : "sidekick:configure";
  }
  if (state.restore.kind === "sidekick-answer") {
    // The opener, while there is still a question to open. Silent once the
    // question has been answered or withdrawn: the control is gone, and a
    // claim naming it would be focus asked for on behalf of nothing.
    // And while this pane is what the screen is showing. Silent otherwise: once
    // the question has been answered or withdrawn the control is gone, and
    // while a route drawer owns the modal the opener is outside it — a claim on
    // either is focus asked for on behalf of a row this view does not draw,
    // which the commit refuses rather than honours.
    return live.sidekick?.question === undefined ||
      selection.drawers.length > 0 ||
      !showingSidekick(view)
      ? undefined
      : "sidekick:answer";
  }
  if (state.restore.kind === "turn") {
    const turn = state.restore.turn;
    return chronology(view.model, live).some((candidate) => candidate.key === turn)
      ? `sessions:turn:${turn}`
      : undefined;
  }
  // The record this answer caused: one the history did not hold when the answer
  // was taken, holding exactly what was sent. Not the newest record — by the time
  // a frame can draw this row, another invocation may have settled after it.
  const known = new Set(state.restore.known);
  const answer = state.restore.answer;
  const caused = (selection.scope?.elicitations ?? []).find(
    (one) => !known.has(one.marker) && sameJson(one.answer, answer),
  );
  if (caused === undefined) {
    return undefined;
  }
  // A narrow frame has no inspection region, so the record's own row is not one
  // this screen offers. Focus goes to the entry that owns the record instead:
  // the control the reader can see, in the one outlet a narrow frame draws. The
  // claim stays silent while that outlet is showing the other surface, exactly as
  // it does for any row this view does not draw.
  if (profileFor(view.size) === "narrow") {
    if (staged(view) === undefined) {
      const owner = selection.entry?.key;
      return owner === undefined ? undefined : `entry:${owner}`;
    }
    return state.route.surface === "entries" && state.route.view !== "sidekick"
      ? "entries:heading"
      : undefined;
  }
  return `elicit:${caused.marker}`;
}

/**
 * The state after a commit settled focus.
 *
 * A restoration request is one request, not a standing one. It survives the frames
 * between the answer and its record — nothing can be focused that is not there
 * yet — and is spent by the commit that puts focus where it asked. Focus
 * traversal is not an action, so a request nobody retired would pull somebody back
 * after every Tab and traversal would never move.
 */
export function focusSettled(
  view: ReplView,
  focused: string | undefined,
  /**
   * What the frame that satisfied the request admitted.
   *
   * Needed because a request can *move* a window to show the row it names, and
   * the move was computed from the request: spending the request without keeping
   * the move would scroll the catalog straight back and take the row focus has
   * just landed on off the screen. A caller with no committed frame to hand —
   * one asking only whether a request is spent — leaves it out.
   */
  admission?: ReplAdmission,
): ReplState {
  let state = view.state;
  const from = admission?.windows.get(DRAWER_WINDOW)?.from;
  if (from !== undefined && focused?.startsWith("drawer:value:")) {
    if (view.selection.drawers.at(-1)?.kind === "live-elicit" && state.form.offset !== from) {
      state = Object.freeze({ ...state, form: Object.freeze({ ...state.form, offset: from }) });
    } else if (
      presentedAsking(view) !== undefined &&
      state.asking !== undefined &&
      state.asking.form.offset !== from
    ) {
      state = Object.freeze({
        ...state,
        asking: Object.freeze({
          ...state.asking,
          form: Object.freeze({ ...state.asking.form, offset: from }),
        }),
      });
    }
  }
  const claim = focusClaim(view);
  if (state.restore === undefined) {
    return state;
  }
  if (claim === undefined || focused !== claim) {
    return state.restore.kind === "answered"
      ? state
      : Object.freeze({ ...state, restore: undefined });
  }
  // The reveal this frame presented, retained before the claim that caused it is
  // spent. Only a claim on a catalog row can have moved that window, and only
  // the window's own admitted start is kept — the offset this process holds
  // becomes the one a person is actually looking at, so the next frame asks the
  // same question and gets the same answer without a claim to ask it for.
  const revealed =
    claim.startsWith("entry:") || claim.startsWith("scope:")
      ? admission?.windows.get(presentedCatalog(view) ? DRAWER_WINDOW : ENTRIES_WINDOW)?.from
      : undefined;
  const viewports =
    revealed === undefined || revealed === state.viewports.entries
      ? state.viewports
      : Object.freeze({ ...state.viewports, entries: revealed });
  if (state.restore.kind === "reveal" && admission !== undefined) {
    if (claim.startsWith("sessions:")) {
      return Object.freeze({
        ...state,
        restore: undefined,
        viewports: {
          ...viewports,
          sessions: admission.windows.get(SESSIONS_WINDOW)?.from ?? viewports.sessions,
        },
      });
    }
    if (claim.startsWith("drawer:")) {
      const from = admission.windows.get(DRAWER_WINDOW)?.from;
      if (from !== undefined) {
        const open = state.route.drawers.at(-1);
        const key = open === undefined ? undefined : readingKeyOf(state, open);
        return Object.freeze({
          ...state,
          restore: undefined,
          viewports: {
            ...viewports,
            configure: presentedConfiguring(view) === undefined ? viewports.configure : from,
            permission: open?.kind === "live-permission" ? from : viewports.permission,
            readings:
              key === undefined ? viewports.readings : { ...viewports.readings, [key]: from },
          },
        });
      }
    }
  }
  return Object.freeze({ ...state, restore: undefined, viewports });
}

/** Every answer this history already holds, wherever in its entries it holds it. */
function retainedAnswers(model: ReplModel): readonly string[] {
  const markers: string[] = [];
  const walk = (scope: ReplScope): void => {
    for (const elicitation of scope.elicitations) {
      markers.push(elicitation.marker);
    }
    for (const child of scope.scopes) {
      walk(child);
    }
  };
  for (const entry of model.entries) {
    walk(entry.scope);
  }
  return Object.freeze(markers);
}

/** Whether two Json values are the same value, whatever order they were written in. */
function sameJson(left: Json, right: Json): boolean {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((member, index) => sameJson(member, right[index] ?? null));
  }
  const names = Object.keys(left);
  if (names.length !== Object.keys(right).length) {
    return false;
  }
  return names.every((name) => {
    const mine = left[name];
    const theirs = right[name];
    return mine !== undefined && theirs !== undefined && sameJson(mine, theirs);
  });
}

/**
 * Two columns saying whether this row is the one being read.
 *
 * Its own channel, beside the focus marker rather than sharing it: focus is where
 * the next keystroke goes and selection is what the screen is showing, and a
 * reader who has tabbed away from the entry they are reading still needs to know
 * which one that is. Driven by the resolved route, so it survives focus moving,
 * a background repaint and a resize.
 */
function selected(on: boolean): string {
  return on ? "* " : "  ";
}

/**
 * The word beside Pause for a live entry, or none when Pause has no place.
 *
 * Playing expansion says nothing: the control alone is the whole offer, and a
 * word reporting that expansion is working is a word that is always there.
 */
function expansionState(expansion: ExpansionState): string | undefined {
  return expansion === "playing" ? "" : expansion;
}

/**
 * The word beside Pause for a submission still being prepared.
 *
 * `preparing` while nobody has asked it to stop, and `pausing` once somebody
 * has — the same word a live walk that has been asked and has not yet stopped
 * uses, because it is the same situation: the request stands and nothing is
 * held yet. What a person reads does not change under them when the entry they
 * asked to stop finally starts.
 */
function preparingState(preparing: ReplPreparing | undefined): string | undefined {
  if (preparing === undefined) {
    return undefined;
  }
  return preparing.requested ? "pausing" : "preparing";
}

function line(
  key: string,
  label: string,
  style: ReplRowStyle,
  runs?: readonly ReplTokenRun[],
): Described {
  return {
    key,
    style,
    ...(runs === undefined ? {} : { runs }),
    description: describeNode<ReplAction>({ key, component: LINE, input: { label } }),
  };
}

/**
 * What the execution is doing, and what that means for submitting.
 *
 * One value, because the sentence a person reads and the decision about whether
 * a standing refusal still applies are the same judgement. Two functions each
 * deciding it separately is how a screen comes to say "Ready for Entry 2" above
 * a refusal explaining that Entry 1 has not finished.
 */
export type ReplReadiness =
  /** Frozen at an earlier position: nothing here submits, whatever the head does. */
  | { readonly kind: "history" }
  /** No entry and nothing running. */
  | { readonly kind: "first" }
  | { readonly kind: "running"; readonly order: number }
  | { readonly kind: "answer"; readonly order: number }
  | { readonly kind: "permission"; readonly order: number }
  /** Admitted, no outcome, and nothing running it. Nothing may follow. */
  | { readonly kind: "unfinished"; readonly order: number }
  /** The close is recorded and the task that produced it is still unwinding. */
  | { readonly kind: "settling"; readonly order: number }
  | { readonly kind: "ready"; readonly next: number };

/**
 * Read it from both halves: the file, and this process.
 *
 * Derived on the way to a frame and nothing more. It is in no location and no
 * record — a screen that explained itself differently would still be the same
 * execution.
 */
export function readinessOf(view: ReplView): ReplReadiness {
  const { state, model, live } = view;
  if (state.route.at !== undefined) {
    // A frozen position first, before any live fact is read. What the head is
    // doing is not a fact about the prefix being inspected, and a reading that
    // borrowed it would describe an execution this view is not of.
    return { kind: "history" };
  }
  const entries = model.entries;
  const last = entries[entries.length - 1];
  if (last === undefined) {
    return { kind: "first" };
  }
  const order = last.order;
  if (!model.settled) {
    if (live.question !== undefined) {
      return { kind: "answer", order };
    }
    if (live.agent.requests.length > 0) {
      return { kind: "permission", order };
    }
    // Admitted, no outcome, nothing running it: whatever was doing the work is
    // gone and the file still says the entry never finished. The Journal decides
    // that, so no successor can start however idle this looks.
    return live.running ? { kind: "running", order } : { kind: "unfinished", order };
  }
  // The outcome is recorded. Whether anything may follow it is still the live
  // half's to answer: the close is appended while the task that produced it is
  // unwinding, and a submission taken in that window has nowhere to go.
  return live.running ? { kind: "settling", order } : { kind: "ready", next: order + 1 };
}

/** Whether this readiness is one a submission would be admitted into. */
export function admitsSubmission(readiness: ReplReadiness): boolean {
  return readiness.kind === "first" || readiness.kind === "ready";
}

/**
 * The state, as one phrase.
 *
 * First in the row, and before any key guidance, because the row is as wide as
 * the terminal and the terminal decides where it stops: a sentence truncated
 * after "Entry 1 running" still told somebody the thing they could not have
 * worked out, while one truncated after "Tab regions Alt↑↓" told them what the
 * keys do and left them pressing Enter at an entry that cannot accept it.
 */
function statePhrase(readiness: ReplReadiness, narrow: boolean): string {
  switch (readiness.kind) {
    case "history":
      return "History";
    case "first":
      return "Ready for Entry 1";
    case "running":
      return `Entry ${readiness.order} running`;
    case "answer":
      // `question` rather than `waiting for an answer` where the row is 72
      // columns: thirteen columns back, which is the difference between the
      // movement hint being on the screen and being off it.
      return narrow
        ? `Entry ${readiness.order} question`
        : `Entry ${readiness.order} waiting for an answer`;
    case "permission":
      return narrow
        ? `Entry ${readiness.order} permission`
        : `Entry ${readiness.order} waiting for permission`;
    case "unfinished":
      return `Entry ${readiness.order} unfinished`;
    case "settling":
      return `Entry ${readiness.order} settling`;
    case "ready":
      return `Ready for Entry ${readiness.next}`;
  }
}

/**
 * What that state means for the keys, when it means anything.
 *
 * Only the facts a person acts on. A state whose keys work the ordinary way adds
 * nothing here, because a row explaining every state at every moment is one
 * nobody reads.
 */
function stateAdvice(
  readiness: ReplReadiness,
  narrow: boolean,
  /** Whether the list a request is answered from is drawn on this frame. */
  shown: boolean,
): string | undefined {
  switch (readiness.kind) {
    case "history":
      // Named without its brackets: a bracketed label in prose reads as a
      // control, and a person — or a pointer looking for one — would try to
      // activate a sentence.
      return narrow
        ? "Enter unavailable · activate live"
        : "Enter unavailable · activate live to return to the head";
    case "first":
    case "ready":
      return undefined;
    case "running":
      return narrow ? "Enter unavailable" : "Enter unavailable until it finishes";
    case "answer":
      return "activate answer";
    case "permission":
      // Named, not routed to: saying where a request is answered is not the
      // same as going there. Where this frame already draws that list — the
      // staged composition gives it a column of its own — the request is in
      // front of the person and the name of a surface to open would name a
      // control this screen does not have. What is left to say is that the row
      // is a thing to act on.
      return shown ? "activate the request" : "open Sessions";
    case "unfinished":
      return narrow ? "no successor" : "no successor can start";
    case "settling":
      return narrow ? "Enter unavailable" : "Enter unavailable until teardown finishes";
  }
}

/**
 * The state as a drawer says it.
 *
 * A drawer is already the thing that is waiting, so the sentence above it does
 * not have to describe the waiting — it has to name which entry, and leave the
 * row enough columns for the keys. `Entry 1 question` instead of `Entry 1
 * waiting for an answer` is thirteen columns back, which is the difference
 * between `Esc closes` being on a 72-column screen and being off it.
 */
function drawerState(view: ReplView, readiness: ReplReadiness): string {
  const open = view.selection.drawers[view.selection.drawers.length - 1];
  const order = "order" in readiness ? readiness.order : undefined;
  if (order !== undefined && open?.kind === "live-elicit") {
    return `Entry ${order} question`;
  }
  if (order !== undefined && open?.kind === "live-permission") {
    return `Entry ${order} permission`;
  }
  // The compact spelling at every size, because a drawer is already the thing
  // that is waiting: what the row still has to name is which entry.
  return statePhrase(readiness, true);
}

/**
 * What Enter does on the node that actually holds focus.
 *
 * Classified by the focused node first, and by the drawer it sits in only after
 * every node it could be has been ruled out. The order is the whole point: a
 * permission drawer reparents the footer's own way out and way to History into
 * itself, so asking the *drawer* what Enter does would tell somebody standing on
 * `[exit]` that Enter decides a permission — and the next thing they do is press
 * it. A drawer's ring is not all one kind of control, so neither is this answer.
 */
function primaryAction(view: ReplView, narrow: boolean): string {
  const focused = focusClaim(view) ?? view.focused;
  if (focused?.endsWith(":anchor")) {
    return "Enter does nothing";
  }
  if (focused === "footer:history" || focused === "footer:top:history") {
    // Shortened where the row is 72 columns and not otherwise. The control under
    // the cursor is labelled `[history]`, so the narrow form is not vague — it is
    // the one word the label already supplies, given back to the keys.
    return narrow ? "Enter opens" : "Enter opens History";
  }
  if (focused === "footer:exit" || focused === "footer:top:exit") {
    return "Enter exits";
  }
  if (focused === "drawer:close") {
    return "Enter closes";
  }
  if (focused !== undefined && focused.startsWith("drawer:permission:choice:")) {
    // An option the provider offered. Taking it settles the request, and only a
    // control that is one of those may say so.
    return "Enter decides";
  }
  if (focused !== undefined && focused.startsWith("drawer:choice:")) {
    // One offered value. Taking it fills the field rather than answering the
    // question, which still needs submitting.
    return "Enter chooses";
  }
  if (
    focused === "drawer:form:submit" ||
    (focused !== undefined &&
      (focused.startsWith("drawer:field:") || focused.startsWith("drawer:value:")))
  ) {
    // The field the answer is typed into, the row that names it, and the control
    // that sends it: all three are how this question gets answered.
    return "Enter answers";
  }
  // Nothing more specific is known about this node, so this says only what is
  // true of every control. Pointer equivalence is worth saying where there is
  // room for it, and the narrow row has other things to spend those columns on.
  return narrow ? "Enter activates" : "Enter or click activates";
}

/** What joins the parts of the guidance row. */
const GUIDANCE_SEPARATOR = " · ";

/** One part of the guidance row, and whether the row may be drawn without it. */
interface GuidancePart {
  readonly text: string;
  /** A part the row must carry: it is dropped only if nothing else can go. */
  readonly required?: true;
}

/**
 * One row, assembled so that what it must say is what survives.
 *
 * The parts are given in the order they are read, and an optional one is kept
 * only while the row still fits with every required part that follows it. So a
 * row that cannot hold everything loses its least important fact by decision
 * here, in its proper place, rather than its last characters by accident in the
 * renderer — which would cut `Esc closes` in half and leave nothing to say it
 * had been there.
 *
 * It takes a width rather than a size class because the arithmetic has to be
 * total: the parts hold an entry number, so a composition that fits for `Entry 1`
 * is a column longer for `Entry 10`, and this has to keep its promise for an
 * execution of any length.
 */
function fitted(width: number, parts: readonly GuidancePart[]): string {
  const kept: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.required === true) {
      kept.push(part.text);
      continue;
    }
    const after = parts
      .slice(index + 1)
      .filter((one) => one.required === true)
      .map((one) => one.text);
    const candidate = [...kept, part.text, ...after].join(GUIDANCE_SEPARATOR);
    if (candidate.length <= width) {
      kept.push(part.text);
    }
  }
  const said = kept.join(GUIDANCE_SEPARATOR);
  // A floor, not a policy. Choosing the vocabulary by room is what keeps the
  // required parts whole, and the supported sizes never come here. What this
  // refuses is the one outcome that is worse than a shortened sentence: a row
  // longer than its own width, which this engine does not clip but writes over
  // the row beneath.
  return said.length <= width ? said : fitLine([{ text: said, elide: true }], width);
}

/** What the row cannot be drawn without, at the length it would be drawn at. */
function requiredLength(parts: readonly GuidancePart[]): number {
  return parts
    .filter((part) => part.required === true)
    .map((part) => part.text)
    .join(GUIDANCE_SEPARATOR).length;
}

/**
 * What the guidance says, whole, before any width has cut it into rows.
 *
 * Every part it has to say, in the one order it says them: the state, then what
 * focus actually does, then the way out, then movement. Nothing is dropped and
 * nothing is shortened to fit a row, because the block is as many rows as its
 * words need — a direction a reader cannot see is a direction they do not have,
 * and the Transcript sharing its column is not a reason to stop giving it.
 *
 * The vocabulary is the profile's: the long phrases where there is a Transcript
 * column, and the short ones a narrow frame already says. There is no third.
 */
/**
 * Whether this frame says its refusal in the footer's own band.
 *
 * The staged composition keeps every footer control on one compact History row,
 * which leaves a reason a handful of cells and an ellipsis — and a refusal
 * truncated before its meaning is a keystroke that appeared to do nothing. The
 * band below it is the full width of the frame and already pays a sentence out
 * over as many rows as its words need, so that is where the reason goes.
 *
 * The standing hint waits while it does. A hint describes what a person could
 * do; a refusal answers what they just did, and only one of those is news.
 */
function refusalInBand(view: ReplView): boolean {
  return view.state.refusal !== undefined && staged(view) !== undefined;
}

/**
 * What the footer's own sentence says on this frame: the refusal, or the hint.
 *
 * One function for both, asked by the pass that fits the words and by the pass
 * that describes the rows — a second answer is how a band comes to be measured
 * for one sentence and drawn with another.
 */
export function footerSentence(view: ReplView): string {
  return refusalInBand(view)
    ? `! ${(view.state.refusal ?? "").split("\n").join(" ")}`
    : guidanceSentence(view);
}

export function guidanceSentence(view: ReplView): string {
  const narrow = view.size.columns <= NARROW.columns;
  return guidanceParts(view, readinessOf(view), narrow)
    .map((part) => part.text)
    .join(GUIDANCE_SEPARATOR);
}

/**
 * The parts of the guidance row, in the order they are read.
 *
 * `compact` chooses the shorter of the two vocabularies this row already has.
 * It is a question about room rather than about the terminal: the same screen
 * can want the long phrases in one region and the short ones in another.
 *
 * What never moves is the order: the state, then what focus actually does, then
 * the way out, then movement.
 */
function guidanceParts(
  view: ReplView,
  readiness: ReplReadiness,
  compact: boolean,
): readonly GuidancePart[] {
  // Reconciliation honors this claim before drawing. Fitting the old owner's
  // help would move controls again when the focus refresh follows this frame.
  const focused = focusClaim(view) ?? view.focused;
  const modal = modalOpen(view);
  const editing = focused === undefined || focused === "footer:input";
  const narrow = view.size.columns <= NARROW.columns;
  const move: GuidancePart = { text: "Tab regions Alt↑↓" };
  const anchor = focused?.endsWith(":anchor") === true;
  const scrolling: GuidancePart[] = [];
  if (anchor) {
    scrolling.push({
      text: "Up/Down reads one row; PageUp/PageDown reads a page; Home/End reaches the bounds.",
    });
  }
  if (modal && !anchor) {
    scrolling.push({
      text: "In Content: PageUp/PageDown reads more content. Arrows and Home/End keep editing a field.",
    });
  }
  if (anchor || modal) {
    scrolling.push({
      text: "Wheel scrolls the reading under your pointer, three displayed rows per tick. It stops before hiding the focused control.",
    });
  }
  if (modal) {
    // A drawer holds focus, so `Esc closes` is required and movement is not: Tab
    // is discoverable by pressing it, and being shut inside a modal whose way out
    // was cut from the row is not. The state stays, because a question does not
    // stop an entry from running and a reader still needs to know that it is.
    return [
      { text: drawerState(view, readiness), required: true },
      { text: primaryAction(view, compact), required: true },
      { text: "Esc closes", required: true },
      move,
      ...scrolling,
    ];
  }
  const state: GuidancePart = { text: statePhrase(readiness, compact), required: true };
  if (!editing) {
    // No word here about submitting. Enter activates the control that has focus,
    // so a row explaining why Enter cannot submit would describe a key this node
    // does not use that way. The way back to the draft is required — it is the
    // one thing this screen used to say nothing about at all.
    return [
      state,
      { text: primaryAction(view, compact), required: true },
      move,
      { text: compact ? "Tab to draft" : "Tab to the draft to type", required: true },
      ...scrolling,
    ];
  }
  const advice = stateAdvice(readiness, compact, staged(view) !== undefined && !narrow);
  const said: GuidancePart[] =
    advice === undefined ? [state] : [state, { text: advice, required: true }];
  if (readiness.kind === "history") {
    // The draft survives a frozen position and stays editable, but the fact a
    // person needs here is the way back to the head rather than that typing
    // works. The draft row below is visibly holding their text either way.
    return [...said, move];
  }
  // Focus is in the draft. Only here is Enter a submission, and only when the
  // readiness would take one — a row promising it in any other state is the one
  // thing this slice exists to stop saying.
  const enter: GuidancePart[] = admitsSubmission(readiness)
    ? [{ text: "Enter submits", required: true }]
    : [];
  return [...said, ...enter, { text: "Type here" }, move];
}

/**
 * A row of a drawer, padded so the drawer covers what it is in front of.
 *
 * A renderer writes what changed, so a row that only writes its own text leaves
 * whatever was underneath it visible from where its text ends — and a modal you
 * can read the transcript through is not a modal.
 */
function drawerLine(
  key: string,
  label: string,
  width: number,
  style: ReplRowStyle,
  /** What the label is made of, where it is made of more than one thing. */
  runs?: readonly ReplTokenRun[],
): Described {
  const text = width < 1 ? label : label.padEnd(width, " ");
  if (runs === undefined) {
    return line(key, text, style);
  }
  return line(key, text, style, padded(runs, text.length, style.role));
}

function field(
  key: string,
  prompt: string,
  text: string,
  purpose: ReplFieldPurpose,
  style: ReplRowStyle,
  options: {
    readonly focus?: true;
    readonly here?: string | undefined;
    readonly caret?: ReplCaret;
    /** The form field this line edits, for a line that edits one. */
    readonly field?: string;
    /** The Sidekick question this line answers, for a line that answers one. */
    readonly question?: string;
    /** What the value on this line is, for a line showing something classified. */
    readonly classify?: (value: string) => readonly ReplTokenRun[];
    /**
     * Whether this field's value is drawn in rows of its own beneath it.
     *
     * The row is then its name and its focus marker alone. One field still:
     * the value, the focus and the hold on the keyboard are all this node's,
     * and the rows below it are read rather than reached.
     */
    readonly block?: true;
  } = {},
): Described {
  const here = options.here === key;
  const parts = fieldParts(prompt, options.block === true ? "" : text, here);
  const runs = tokenRuns([
    { text: parts.marker, token: here ? "focus-marker" : style.role },
    { text: parts.prompt, token: style.role },
    ...(options.block === true
      ? []
      : [
          { text: parts.earlier, token: style.role },
          ...(options.classify === undefined
            ? [{ text: parts.value, token: style.role }]
            : options.classify(parts.value)),
        ]),
  ]);
  return {
    key,
    style,
    runs,
    description: describeNode<ReplAction>({
      key,
      component: FIELD,
      input: {
        prompt,
        text,
        purpose,
        caret: caretFor(text, options.caret).offset,
        ...(options.caret?.backward === true ? { backward: true } : {}),
        ...(options.caret?.column === undefined ? {} : { column: options.caret.column }),
        ...(options.block === undefined ? {} : { block: options.block }),
        ...(options.field === undefined ? {} : { field: options.field }),
        ...(options.question === undefined ? {} : { question: options.question }),
        ...(options.here === key ? { focused: true } : {}),
      },
      ...(options.focus === undefined ? {} : { focus: options.focus }),
    }),
  };
}

/**
 * Describe the whole screen, for one measured frame.
 *
 * One flat set with keyed children for the drawer, because layout is not
 * nesting: where a row appears is the layout's decision, and the only nesting
 * that matters to the tree is what a modal must contain.
 *
 * The descriptions and the constraints that place them come from `presentationFor`
 * in one walk. This is the same walk asked only for the tree, which is what a
 * caller reconciling without drawing wants.
 */
export function describeApplication(
  view: ReplView,
  context: ReplPresentationContext,
): readonly ReplDescription<ReplAction>[] {
  return presentationFor(view, context).descriptions;
}

/**
 * One reading's rows, and what every one of them means.
 *
 * `rows` is every `Described` this screen built, nested drawer content included,
 * so the style a row was given is available wherever that row's box is made.
 * `items` is the top-level set, in order, which is what the tree reconciles.
 */
interface DescribedScreen {
  readonly items: readonly Described[];
  readonly rows: readonly Described[];
}

function described(view: ReplView, context: ReplPresentationContext): DescribedScreen {
  if (profileFor(view.size) === "too-small") {
    return { items: [], rows: [] };
  }
  if (view.refusal !== undefined) {
    // A reason as long as its sentence, over rows that fit: a refusal is the only
    // thing on this screen, and one clipped to a single row is a refusal that has
    // not been given.
    // Fitted where this frame has fitted it, and chunked where it has not —
    // the pass still asking how wide the surface is has no width to fit to.
    // Each row is padded either way: a renderer writes what changed, so a row
    // whose text got shorter would keep the tail of what used to be there.
    const room = context.widths?.surfaceBody ?? 0;
    const [first, ...rest] =
      context.refusal === undefined
        ? chunked(view.refusal, room)
        : context.refusal.map((own) => (room < 1 ? own : own.padEnd(room, " ")));
    // Where somewhere to go exists, the refusal itself is focusable and takes the
    // claim; otherwise focus starts on the way out. Declared, so the claim is a
    // typed member rather than a literal that has to be asserted into one.
    const claiming: { readonly focus?: true } =
      view.state.route.at === undefined ? {} : { focus: true };
    const items: Described[] = [
      {
        key: "refusal",
        style: styleOf("failed-outcome"),
        description: describeNode<ReplAction>({
          key: "refusal",
          component: REFUSAL,
          input: {
            label: first,
            // Somewhere to go only when there is somewhere: a cold open of a
            // history that cannot be read has no earlier view to return to.
            ...(view.state.route.at === undefined ? {} : { back: "live" }),
          },
          ...claiming,
        }),
      },
    ];
    for (const [offset, part] of rest.entries()) {
      items.push(line(`refusal:${offset}`, part, styleOf("failed-outcome")));
    }
    // And the way out, because this screen offers nothing else to do — at every
    // size this REPL draws at. A valid session that could only be left by a key
    // nobody documented would be one a person has to guess their way out of.
    //
    // Below the minimum there is no frame to place it in: that screen draws its
    // refusal and nothing else, so a control described there would be a focus
    // stop drawing nothing and a target behind nothing. It teaches Escape in the
    // sentence instead, which is the one thing it can offer.
    if (profileFor(view.size) !== "too-small") {
      items.push(
        row(
          "footer:exit",
          "[exit]",
          { select: "exit" },
          styleOf("action"),
          view.state.route.at === undefined
            ? { focus: true, here: view.focused }
            : { here: view.focused },
        ),
      );
    }
    return { items, rows: items };
  }

  const items: Described[] = [];
  const { model, selection, live, state } = view;
  const claim = focusClaim(view);
  // Narrow gives the whole screen to one routed surface, so the other one is not
  // described at all — not drawn small, not clipped, not placed in a region the
  // frame does not have. A node nothing can show is a focus stop that draws
  // nothing and a pointer target behind nothing.
  const narrow = profileFor(view.size) === "narrow";
  const routed = state.route.surface;
  /**
   * Which of the two right readings a wide or medium frame is showing.
   *
   * Sidekick unless Bindings was asked for. A command whose default right pane
   * is the inspector would open on the thing a person most often wants beside
   * their work only by accident — but the default decides a *reading*, not
   * focus: the draft still holds that, so a person who starts typing is typing
   * their entry.
   *
   * Narrow routes one outlet instead, and the Sidekick is one of the three it
   * routes: an explicit `view=sidekick` selects it, and nothing else does.
   */
  const showSidekick = narrow
    ? state.route.view === "sidekick"
    : (state.route.right ?? "sidekick") === "sidekick";
  const showSessions = !narrow || routed === "sessions";
  /**
   * Whether the Sidekick's own question form is covering its pane.
   *
   * What that pane would have drawn is not described where it would be drawn:
   * an opaque modal is in front of it, and a control behind one is a Tab stop
   * and a pointer target with nothing visible on it. The ones a person still
   * needs are reparented into the form, exactly as `[history]` and `[exit]`
   * already are — described once, in the active focus root.
   */
  const covered = presentedAsking(view) !== undefined;
  // The staged composition draws the Transcript of agent work on the left and
  // reaches the catalog through the selected work's breadcrumbs, so the two
  // surface headings and the catalog's own rows have no region in it.
  const workspace = staged(view);

  const showEntry = (!narrow || routed === "entries") && !(narrow && showSidekick);

  const turns = chronology(model, live);
  // Which surface to be on belongs to neither surface. A narrow frame mounts one
  // outlet, so a control that lives inside the outlet can only take somebody
  // where they already are — and the way back would be mounted on the screen
  // they cannot reach. Both controls are described at every size; the route
  // decides which outlet's rows follow them, never whether they exist.
  const inspected = state.route.at !== undefined;
  const toSessions = row(
    "sessions:heading",
    `${selected(routed === "sessions" && !(narrow && showSidekick))}Sessions`,
    { select: "surface", surface: "sessions" },
    styleOf("pane-heading", { selected: routed === "sessions" && !(narrow && showSidekick) }),
    { here: view.focused },
  );
  // The staged screen has no permanent catalog column, so its way to the
  // catalog opens one over the reading. The ordinary composition still routes
  // to its own Entries surface, where the column is already drawn.
  const toEntries = row(
    "entries:heading",
    `${selected(routed === "entries" && !(narrow && showSidekick))}Entries`,
    workspace === undefined ? { select: "surface", surface: "entries" } : { select: "catalog" },
    styleOf("pane-heading", { selected: routed === "entries" && !(narrow && showSidekick) }),
    { here: view.focused },
  );
  // The way between surfaces belongs to neither of them. A narrow frame mounts
  // one outlet, so both controls are described there whichever composition is
  // drawing it; a wider staged frame reaches the catalog through the selected
  // work's own Entries control instead.
  if (workspace === undefined || narrow) {
    items.push(toSessions);
  }
  // In a narrow frame the two are one navigation bar above the routed outlet. In
  // a sidebar each heading stays with the list it names, which is where a reader
  // looks for it.
  if (narrow) {
    items.push(toEntries);
    items.push(
      row(
        "surface:sidekick",
        `${selected(showSidekick)}Sidekick`,
        { select: "pane", pane: "sidekick" },
        styleOf("pane-heading", { selected: showSidekick }),
        { here: view.focused },
      ),
    );
  }
  if (workspace !== undefined) {
    // Each heading belongs to the surface it names, so a narrow frame describes
    // only the one its route is showing: a heading for an outlet this frame has
    // no region for would be a row mounted nowhere. Described ahead of the
    // reading under it, because the order controls are described in is the
    // order the arrows move through them.
    items.push(
      ...workspaceHeadings(view, context.selector, {
        transcript: !narrow || routed === "sessions",
        work: !narrow || (routed === "entries" && !showSidekick),
        entries: !narrow,
      }),
    );
  }
  if (!showSessions) {
    // Nothing: this frame is showing the other surface.
  } else if (live.sidekick === undefined && turns.length === 0) {
    // Present and empty, with one owner. This REPL keeps one execution per
    // invocation, and a Sessions surface that vanished when it held nothing
    // would read as a feature that does not exist. With a Sidekick installed
    // there are two sections instead, and each of them says what it holds.
    items.push(line("sessions:empty", "  (none retained)", styleOf("metadata")));
  } else {
    // One window over the whole reading. Every conversation, turn, fact, audit
    // and request is built in order and then windowed: a list that described all
    // of them would have its tail placed nowhere, and a row layout cannot place
    // is not one a person can see, focus or point at.
    //
    // The window is what the frame measured, not what this boundary could work
    // out from the region's height — the rows above and below it are described
    // here, so only the engine knows what is left for the rows inside.
    const content = sessionRows(
      state,
      turns,
      view.focused,
      claim,
      context.widths?.listBody,
      live.sidekick,
      workspace !== undefined,
    );
    const window = context.admission.windows.get(SESSIONS_WINDOW);
    const reveal =
      window === undefined ? undefined : transcriptReveals(content, window.from, window.count);
    items.push(
      ...shown(content, context, SESSIONS_WINDOW).map((one) => {
        const target = reveal?.get(one.key);
        return target === undefined ? one : revealing(one, target);
      }),
    );
  }
  if (workspace === undefined && !narrow) {
    items.push(toEntries);
  }
  if (showEntry && workspace === undefined) {
    // One window over the whole catalog, for the same reason the Sessions
    // reading has one: a list that described every entry and every nested scope
    // beneath them would have its tail placed nowhere, and a row layout cannot
    // place is not one a person can see, focus or point at. The controls sit
    // outside the thing they move, and exist only where there is more catalog
    // than this frame can hold.
    const catalog = entryContent(
      model,
      view.focused,
      selection.entry?.key,
      context.widths?.listBody,
      claim,
    );
    if (catalog.length === 0) {
      // Present and empty, exactly as the Sessions reading says so: an
      // execution that has submitted nothing still has a catalog, and a column
      // that drew nothing would read as a feature that does not exist.
      //
      // Stated around the window rather than inside it, and in every pass, so
      // the pass that measures this column and the frame that draws it count
      // the same rows. A placeholder described only once the window had been
      // admitted would take a row the measurement had already given away.
      items.push(line("entry:none", "  1. (not submitted)", styleOf("metadata")));
    }

    items.push(...shown(catalog, context, ENTRIES_WINDOW));
  }

  // What each shared column is, said once at the top of it. A pane that named
  // itself only when it held something would be a pane a reader has to recognize
  // by what happens to be in it, and an empty one would read as a gap. They are
  // read rather than activated: nothing here is a control, and the frame places
  // them only where there is a pane to put them in.
  // Not in a narrow frame: it routes one outlet and has neither column, so a
  // title described there would be a mounted node with no box to draw it in.
  // The two surface controls are that frame's own headings.
  if (!narrow) {
    if (workspace === undefined) {
      items.push(line("transcript:heading", "Transcript", styleOf("pane-heading")));
    }
    // Both tabs, always, and they are the right column's heading: the pane named
    // itself above them until the two names together said Sidekick twice when the
    // Sidekick was the reading. One row, each name once, and which of them is
    // selected carried by the styling the two have always differed by.
    // Described in the wide and medium frames only — a narrow frame routes one
    // outlet and reaches the Sidekick through its own surface control.
    for (const pane of ["bindings", "sidekick"] as const) {
      const here = pane === "sidekick" ? showSidekick : !showSidekick;
      items.push(
        row(
          `tab:${pane}`,
          // The name alone: it is the heading of the reading it selects, and a
          // heading that spelled out its own selection would say in the text
          // what the row's own styling already says. Which one is selected is
          // the active style, and keyboard focus stays the separate mark it is.
          // And whether the Sidekick is waiting on an answer, said on the tab
          // while its pane is the hidden one: a question nobody can see
          // announced is a question nobody knows to go and answer.
          `${pane === "sidekick" ? (workspace === undefined ? "Sidekick" : "SIDEKICK") : workspace === undefined ? "Bindings" : "BINDINGS"}${
            pane === "sidekick" && !here && live.sidekick?.question !== undefined
              ? " (question)"
              : ""
          }`,
          { select: "pane", pane },
          styleOf(here ? "pane-heading" : "metadata"),
          { here: view.focused },
        ),
      );
    }
  }
  // The Sidekick's own reading, where it is the one selected. Described for a
  // narrow frame too, because there the Sidekick is an outlet of its own rather
  // than a tab — and in both cases what is drawn is the acknowledged chat, the
  // one box its messages are typed into, and the two controls that act on it.
  if (showSidekick && !covered) {
    // Nothing of this pane's own body while its form is in front of it: an
    // opaque modal covers these rows, and a control behind one is a Tab stop
    // and a pointer target with no cell of its own. What a person still needs
    // from here — Stop, and the way out of the form — the form itself holds.
    //
    // One window over the chat, for the reason the Sessions reading has one: a
    // chat long enough to outgrow its pane has turns only scrolling can reach,
    // and a turn somebody selected from Sessions may be any of them. The
    // controls sit outside the thing they move, and the pane's own controls sit
    // below both.
    //
    // A frame without a Sidekick still keeps the reading anchor's identity.
    if (live.sidekick === undefined) {
      items.push(...sidekickReadingRows(undefined, view.focused));
    } else {
      items.push(
        ...anchored(
          shown(
            sidekickReadingRows(live.sidekick, view.focused, context.chat, chatStagingOf(view)),
            context,
            SIDEKICK_WINDOW,
          ),
          "sidekick:anchor",
          "chat",
          view.focused,
        ),
      );
      items.push(
        ...(workspace === undefined
          ? sidekickControls(state, live.sidekick, view, claim, context)
          : workspaceControls(state, live.sidekick, view, claim, context, workspace)),
      );
    }
  }

  // The transcript of whatever is selected. Selecting an entry *is* selecting a
  // transcript locus, so the rows are that entry's own — not every entry's
  // concatenated, which would make the catalog a list of things that all show
  // the same reading. With nothing selected the whole execution is the locus,
  // which is what a one-entry execution has always shown.
  const inspectable = showEntry;
  // Not until a width has been measured. A reading row is bounded to the region
  // it lands in, and an unbounded one makes that region wider than its share —
  // which would corrupt the very measurement that is about to answer how wide
  // it is.
  const surface = context.widths?.surfaceBody;
  // The entry's own reading: what it produced, then the source that produced
  // it, as the rows the frame fitted to this pane. The controls that move it sit
  // outside the moving content, which is why they are described before the rows
  // rather than among them.
  const prepared = inspectable && surface !== undefined ? context.reading : undefined;
  // Only where there is a reading to move. An execution that has admitted
  // nothing has no output or source to admit.
  if (inspectable && model.entries.length > 0) {
    if (prepared !== undefined) {
      items.push(
        ...anchored(
          shown(readingRows(prepared), context, READING_WINDOW),
          "reading:anchor",
          "selected",
          view.focused,
        ),
      );
    }
  }

  // The inspection controls, and only where there is an inspection region to put
  // them in. A narrow frame has one routed outlet, so a binding row or a recorded
  // answer row described there would be mounted, focusable and placed nowhere — a
  // Tab stop that draws no cell and a pointer target behind nothing. What is
  // selected and which route is showing are unchanged: this is what the frame
  // offers, not what the reader has chosen.
  //
  // Nor while the Sidekick is the reading selected. One pane shows one of its
  // two readings: a binding row described beside the chat would be a focus stop
  // and a pointer target inside a reading nobody asked for, in a column that is
  // showing something else.
  const scope = inspectable && !narrow && !showSidekick ? selection.scope : undefined;
  if (scope !== undefined) {
    for (const binding of scope.bindings) {
      items.push(
        row(
          `binding:${binding.name}`,
          fitControl(
            [{ text: `${binding.name} = ` }, { text: summarize(binding.value), elide: true }],
            context.widths?.inspection,
          ),
          {
            select: "binding",
            name: binding.name,
          },
          // A binding row is a name and the value bound to it, so it reads as the
          // value: the whole reason the column is there is to say what the run
          // produced.
          styleOf("field-value", { inspected }),
          { here: view.focused },
        ),
      );
    }
    for (const elicitation of scope.elicitations) {
      items.push(
        row(
          `elicit:${elicitation.marker}`,
          fitControl(
            [{ text: "answered " }, { text: elicitation.location, elide: true }],
            context.widths?.inspection,
          ),
          {
            select: "recorded-elicit",
            marker: elicitation.marker,
          },
          // Where the answer was given, not the answer itself: the value is in the
          // drawer this row opens.
          styleOf("field-hint", { inspected }),
          { here: view.focused, claim },
        ),
      );
    }
  }

  if (
    !narrow &&
    !showSidekick &&
    !items.some((one) => one.key.startsWith("binding:") || one.key.startsWith("elicit:"))
  ) {
    items.push(
      ...anchored(
        [line("binding:empty", " ", styleOf("metadata"))],
        "binding:anchor",
        "empty",
        view.focused,
      ),
    );
  }

  // The way into history. The band above shows where the positions are; choosing
  // an exact one is a drawer, because a position is something you select and the
  // band is something you read.
  // The one way into history, and one node. While a drawer is mounted it is
  // reparented into the modal branch below rather than drawn again beside it:
  // two nodes with one key would be two controls claiming one name, and leaving
  // it out here would put it outside the active focus root where nothing could
  // reach it.
  const history = row(
    "footer:history",
    "[history]",
    { select: "history" },
    styleOf("action", { inspected }),
    {
      here: view.focused,
    },
  );
  // The way out, on every screen and in every state. Like `[history]` it is one
  // node: while a drawer is mounted it is reparented into the modal branch, so it
  // stays reachable without reaching past the focus trap, and layout still draws
  // it in the footer where it always is.
  const exit = row("footer:exit", "[exit]", { select: "exit" }, styleOf("action"), {
    here: view.focused,
  });
  // Whether the action row holds one control at all. A control the measured row
  // cannot hold whole is not described, so it mounts nothing: describing it and
  // leaving it out of the frame would be a focus stop that draws nothing and a
  // target behind nothing. The measuring pass offers every candidate, because
  // what each one costs is the question that pass is asking.
  const offering = (key: string): boolean =>
    context.measuring || context.admission.actions.has(key);
  // Not below the minimum size: that frame places no cell at all, so a control
  // described there is a focus stop that draws nothing and a target behind
  // nothing. The screen says Escape leaves instead, which is the one way out a
  // window too small to draw in can offer.
  const drawable = profileFor(view.size) !== "too-small";
  const modal = modalOpen(view);
  if (!modal) {
    if (offering("footer:history")) {
      items.push(history);
    }
    if (drawable && offering("footer:exit")) {
      items.push(exit);
    }
  }
  if (state.route.at !== undefined && offering("footer:live")) {
    items.push(
      row("footer:live", "[live]", { select: "live" }, styleOf("action"), { here: view.focused }),
    );
  }
  // One control for both, because a person reaching for Pause is asking for the
  // same thing whether the entry is expanding or still being prepared — and one
  // mounted identity across that transition is what keeps focus where they left
  // it. What the two differ in is what expansion is doing, and that is the state
  // beside the control rather than part of it.
  const pausing = live.pausable ? expansionState(live.expansion) : preparingState(live.preparing);
  if (pausing !== undefined) {
    if (offering("footer:pause")) {
      items.push(
        row("footer:pause", "[pause]", { select: "pause" }, styleOf("action"), {
          here: view.focused,
        }),
      );
    }
    // The state is what expansion is doing, and it is plain text: not part of
    // the button's label, which would rename a control out from under whoever
    // was reaching for it, and not a focus stop, because there is nothing to
    // activate in a word that reports.
    if (pausing.length > 0 && offering("footer:pause-state")) {
      items.push(line("footer:pause-state", pausing, styleOf("status")));
    }
    // Continue releases a continuation, so it exists exactly while one is
    // held. Expansion that is *pausing* holds nothing yet — the walks it asked
    // to stop have not all stopped — and a Continue offered there would cancel
    // the pause somebody just asked for rather than resume anything. A
    // preparation holds nothing either: there is no entry yet, so there is no
    // continuation for Continue to release.
    if (live.pausable && live.expansion === "paused" && offering("footer:continue")) {
      items.push(
        row("footer:continue", "[continue]", { select: "continue" }, styleOf("action"), {
          here: view.focused,
        }),
      );
    }
  }
  if (live.question !== undefined && state.route.at === undefined && offering("footer:asked")) {
    items.push(
      row(
        "footer:asked",
        // One fixed spelling, not a headline. A question's message is as long as
        // its author made it, and the action row is as wide as the terminal: a
        // control whose width came from the message is one the narrowest
        // supported frame drops, and a control that has been dropped is a waiting
        // question nobody can reach. The whole message is in the drawer this
        // opens, which is where there is room for it.
        "[answer]",
        { select: "live-elicit" },
        // What it announces is a question nobody has answered yet, which is why
        // it reads as waiting rather than as one more way out of the screen.
        styleOf("waiting"),
        { here: view.focused, claim },
      ),
    );
  }

  // Bounded to the surface it lands in, like every other row above it. The
  // sentence is as long as the state it describes, and the medium profile's
  // transcript column is narrower than the longest of them — a row wider than
  // its column is one the column beside it loses space to.
  if (surface !== undefined) {
    // One inert block, in the rows this frame fitted its words into. Without a
    // fitted list — the pass still asking how wide the surface is — it is the
    // one row that pass describes, so its own geometry question stays askable.
    const said = context.guidance ?? [footerSentence(view)];
    // A refusal in this band reads as the refusal it is, not as a hint.
    const refusing = refusalInBand(view);
    for (const [at, own] of said.entries()) {
      items.push(
        line(
          at === 0 ? "guidance" : `guidance:row:${at}`,
          own,
          refusing ? styleOf("failed-outcome", { inspected }) : styleOf("status", { inspected }),
        ),
      );
    }
  }

  // Why the last thing asked for changed nothing. Shown rather than swallowed: a
  // refusal nobody can read is a keystroke that appeared to do nothing.
  if (state.refusal !== undefined && !refusalInBand(view) && offering("footer:refused")) {
    // One line: the footer is seven rows and the controls live in them, so a
    // refusal that wrapped would push the draft off the screen it is about.
    //
    // Cut to whatever the measured row had left, with an ellipsis, so a reader
    // can tell a shortened reason from a complete one. The controls come first:
    // a row too narrow for both keeps the way out and loses the sentence.
    const said = `! ${state.refusal.split("\n").join(" ")}`;
    const room =
      context.admission.shortened?.key === "footer:refused"
        ? context.admission.shortened.width
        : undefined;
    items.push(
      line(
        "footer:refused",
        room === undefined || said.length <= room
          ? said
          : `${said.slice(0, Math.max(1, room - 1))}…`,
        styleOf("failed-outcome"),
      ),
    );
  }

  // The draft, which is where typing goes. Always the next entry's text: an
  // admitted entry is immutable, so there is never one these keystrokes could
  // be editing, and a person may go on typing while an entry runs and while a
  // history position is being read.
  //
  // It claims focus only while nothing holds it. A claim is where focus *starts*,
  // not an assertion repeated every frame: the tree re-reads the claim at each
  // commit, and this screen commits on every frame, so a standing claim would
  // drag focus back here after every Tab and traversal would never move at all.
  // A restoration claim is somebody else's: exactly one description may claim
  // focus, and a drawer that just went says which one it is.
  const claiming =
    view.initialPresentation !== false &&
    !modalOpen(view) &&
    view.focused === undefined &&
    claim === undefined;
  if (workspace !== undefined) {
    // With the selected work, which is the surface it is part of. A narrow
    // frame showing the Transcript or the Sidekick has no region to draw it in.
    if (!narrow || (routed === "entries" && !showSidekick)) {
      items.push(...workspaceDraft(view, context, claiming));
    }
  } else {
    items.push(
      field(
        "footer:input",
        // Named, because the row below a reading has to say that it is where typing
        // goes rather than one more line of that reading. The marker in front of it
        // is still the focus cue `fieldText` writes, so this row reads `>> Draft: `
        // while it holds focus and ` > Draft: ` while it does not.
        "> Draft: ",
        state.draft,
        "draft",
        styleOf("draft"),
        claiming
          ? { focus: true, here: view.focused, classify: sourceRuns, caret: state.draftCaret }
          : { here: view.focused, classify: sourceRuns, caret: state.draftCaret },
      ),
    );
  }

  const drawer = drawerFor(view, context, history, exit, drawable);
  if (drawer === undefined) {
    return { items, rows: items };
  }
  items.push(drawer.drawer);
  // The drawer's own rows are inside its description rather than beside it, so
  // they are collected here: a box built for one of them has to be able to ask
  // what that row meant.
  return { items, rows: [...items, ...drawer.rows] };
}

function anchored(
  rows: readonly Described[],
  key: string,
  reading: "selected" | "chat" | "drawer" | "empty",
  focused: string | undefined,
): readonly Described[] {
  const at = rows.findIndex((one) => readDescription(one.description).component === LINE);
  if (at < 0) {
    if (focused !== key || rows.length === 0) {
      return rows;
    }
    // A control-only page retains the focused viewport owner without a painted row.
    return [
      {
        key,
        style: ORDINARY,
        description: describeNode<ReplAction>({
          key,
          component: READING,
          input: { label: "", reading },
        }),
      },
      ...rows,
    ];
  }
  return rows.map((one, index) => {
    if (index !== at) {
      return one;
    }
    const read = readDescription(one.description);
    const label = fields(read.input)?.["label"];
    if (typeof label !== "string") {
      return one;
    }
    const end = boundaries(label)[1] ?? 0;
    return {
      ...one,
      key,
      runs:
        focused === key
          ? tokenRuns([
              { text: label.slice(0, end) || " ", token: "caret" },
              { text: label.slice(end), token: one.style.role },
            ])
          : one.runs,
      description: describeNode<ReplAction>({
        key,
        component: READING,
        input: { label: label || " ", reading },
      }),
    };
  });
}

/**
 * The rows one measured window shows, of a whole ordered reading.
 *
 * Nothing at all while the frame is being measured: a viewport's capacity is
 * what the flow around it left, so the pass that asks describes the region empty
 * and the rows follow once there is an answer. A reading with no measured window
 * shows nothing rather than everything — "show all" is how a list comes to
 * describe rows the frame cannot place.
 */
function shown(
  content: readonly Described[],
  context: ReplPresentationContext,
  window: string,
): readonly Described[] {
  if (context.measuring) {
    return [];
  }
  const held = context.admission.windows.get(window);
  if (held === undefined) {
    return [];
  }
  return content.slice(held.from, held.from + held.count);
}

/**
 * One prepared reading as the rows a description places.
 *
 * Each row's runs are the composed ones — rail, indent, text, and the badge
 * against the pane's right inner edge — so what a description says and what the
 * frame measured are one list rather than two that have to agree.
 */
function readingRows(prepared: ReplPreparedReading): readonly Described[] {
  return prepared.rows.map((one) => {
    const runs = readingRuns(prepared, one);
    return line(`reading:${one.key}`, runText(runs), one.style, runs);
  });
}

/**
 * The reading one view holds, before any width has fitted it.
 *
 * The selected entry's own, and nothing when a prefix admitted none. Live text
 * belongs to the entry producing it — the last one this prefix admitted, since
 * entries are serial — so a reader looking at an earlier entry is given that
 * entry's retained reading rather than text from the run that is still going.
 */
export function readingOf(view: ReplView): ReplReading {
  const key = view.selection.entry?.key;
  const entry =
    key === undefined
      ? view.model.entries[view.model.entries.length - 1]
      : view.model.entries.find((one) => one.key === key);
  if (entry === undefined) {
    return NO_READING;
  }
  return entryReading({
    entry,
    lifecycle: view.live.lifecycle,
    live: livesHere(view.model, view.selection) ? view.live.output : "",
    inspected: view.state.route.at !== undefined,
  });
}

/**
 * The band's five rows, or five empty ones where none was prepared.
 *
 * The measuring pass has no rail — it is the pass that answers how wide the
 * band is — and an unmeasured frame describes no band content, exactly as it
 * describes no windowed content.
 */
function bandRowsOf(
  rail: ReplPreparedRail | undefined,
  columns: number,
): readonly (readonly ReplTokenRun[])[] {
  return rail === undefined ? blankBand(columns) : rail.rows;
}

/**
 * The transcript rows the selected locus holds.
 *
 * An entry's own rows when one is selected, and the whole execution's when none
 * is. The model keeps both, so this chooses between two readings it already
 * holds rather than filtering one into the other.
 */
function transcriptOf(model: ReplModel, selection: ReplSelection): readonly ReplRow[] {
  const key = selection.entry?.key;
  if (key === undefined) {
    return model.transcript;
  }
  return model.entries.find((entry) => entry.key === key)?.transcript ?? model.transcript;
}

/**
 * Whether the entry producing live output is the one being read.
 *
 * Only the last entry a prefix admitted can still be running — entries are
 * serial, and an earlier one settled before this one was admitted. So output
 * this process has not retained belongs there, and nowhere else. Selecting
 * nothing is reading the execution, which includes whatever is running in it.
 */
function livesHere(model: ReplModel, selection: ReplSelection): boolean {
  const key = selection.entry?.key;
  return key === undefined || key === model.entries[model.entries.length - 1]?.key;
}

/**
 * The Sessions reading, as rows.
 *
 * One control per conversation and one per turn, with each turn's own facts
 * beneath it as lines. A turn's control is keyed by its slot, so a turn that
 * publishes keeps the node — and the focus — it already had.
 */
function sessionRows(
  state: ReplState,
  turns: readonly ReplSessionTurn[],
  focused: string | undefined,
  claim: string | undefined,
  /**
   * How wide the frame measured the region these rows land in.
   *
   * None where there is nothing to fit to: counting the reading needs the same
   * rows and no width, because what a label gives up does not change how many
   * rows there are.
   */
  width: number | undefined,
  /**
   * What this execution's Sidekick says, where the screen has one.
   *
   * Absent is no Sidekick installation at all, and the surface then draws
   * exactly the one entry reading it always did — no section headings, and the
   * same empty placeholder. Present is both owners' work: two labelled sections
   * on the Sessions surface, and one combined list in the staged Transcript.
   * Neither interleaves them — the entry turns keep their order and the chat's
   * follow in theirs, because an interleaving would have to assert an order
   * these two files do not share.
   */
  sidekick: ReplSidekickReading | undefined,
  /**
   * Whether these are the staged composition's compact request and reply rows.
   *
   * The same rows, keys and actions, drawn as one list: the Transcript is a
   * single reading, so neither owner is given a heading of its own. The
   * conversation choices belong to the column's selector and are drawn here
   * only while it is open, each request and reply is marked with who it came
   * from, and a conversation is named once above the run of turns that share
   * it.
   */
  compact = false,
): readonly Described[] {
  const items: Described[] = [];
  const filter = state.route.session;
  // Entry keys in their own order, then the Sidekick's in its own, each
  // earliest-observed first and a duplicate offered once. Which section a key
  // came from is not a fact about the key, so one list of choices filters both.
  const offered = [...conversations(turns)];
  for (const key of sidekick?.availability.sessions ?? []) {
    if (!offered.includes(key)) {
      offered.push(key);
    }
  }
  // The Sessions surface keeps its choices above its list; the staged
  // Transcript keeps them behind its selector and shows them while it is open.
  if (offered.length > 0 && (!compact || state.filtering)) {
    // All is a control rather than the absence of one: clearing a filter is
    // something a person does, and a list that could only be narrowed would
    // leave them holding a view they cannot get out of.
    items.push(
      row(
        "sessions:all",
        filter === undefined ? "  All conversations" : "  All conversations (filtered)",
        { select: "all-sessions" },
        styleOf("action", { selected: filter === undefined }),
        { here: focused },
      ),
    );
    for (const key of offered) {
      items.push(
        row(
          `sessions:conversation:${key}`,
          fitControl(
            [{ text: `  ${filter === key ? "> " : ""}` }, { text: headline(key), elide: true }],
            width,
          ),
          { select: "session", session: key },
          styleOf("pane-heading", { selected: filter === key }),
          { here: focused },
        ),
      );
    }
  }
  // Which owner's work this is, said once above each list. Without a Sidekick
  // there is one owner and the surface says so by having no sections at all;
  // with one the Sessions surface names two, in a fixed order, each keeping its
  // own history's order rather than being merged into an order neither file
  // establishes.
  //
  // The staged Transcript names none of them. It is one list — that is the
  // reading it was asked for — and each row still says whose work it is and
  // which conversation it was in, so owner authority is read from the rows
  // rather than asserted by a heading over a block of them.
  if (sidekick !== undefined && !compact) {
    items.push(line("sessions:section:entries", "  Entry agents", styleOf("pane-heading")));
  }
  const entries: Described[] = [];
  let named: string | undefined;
  for (const turn of turns) {
    if (filter !== undefined && turn.sessionKey !== filter) {
      continue;
    }
    if (compact) {
      const whose = [turn.agent, turn.sessionKey].filter((fact) => fact !== undefined).join(" · ");
      if (whose !== "" && whose !== named) {
        entries.push(
          line(
            `sessions:turn:${turn.key}:whose`,
            fitLine([{ text: CONTROL_ROOM }, { text: whose, elide: true }], width),
            styleOf("metadata"),
          ),
        );
      }
      named = whose;
      entries.push(...compactTurn(turn, width, focused, claim));
      continue;
    }
    entries.push(
      row(
        `sessions:turn:${turn.key}`,
        // The state comes last and stays: it is why this row is on the screen,
        // and a prompt nobody bounded must not be what takes it off.
        fitControl(
          [
            { text: "  " },
            { text: headline(turn.prompt), elide: true },
            { text: " · " },
            { text: stateOf(turn), keep: true },
          ],
          width,
        ),
        // A turn is read at the position its record holds; a live one has none
        // to go to yet, so it selects the surface it is already on.
        turn.marker === undefined
          ? { select: "surface", surface: "sessions" }
          : { select: "marker", marker: turn.marker },
        // What was asked and how far it got, which is what this row exists to
        // say. The provider's session key, the path and the stop reason are the
        // subordinate rows below it.
        turnStyle(turn),
        // A settled permission sends focus back to the turn that was waiting, so
        // this is the row that may be claimed.
        { here: focused, claim },
      ),
    );
    if (turn.agent !== undefined || turn.sessionKey !== undefined) {
      const said = [turn.agent, turn.sessionKey].filter((fact) => fact !== undefined);
      entries.push(
        line(
          `sessions:turn:${turn.key}:whose`,
          fitLine([{ text: "    " }, { text: said.join(" · "), elide: true }], width),
          styleOf("metadata"),
        ),
      );
    }
    if (turn.text.length > 0) {
      entries.push(
        line(
          `sessions:turn:${turn.key}:text`,
          fitLine([{ text: "    " }, { text: headline(turn.text), elide: true }], width),
          styleOf("output"),
        ),
      );
    }
    if (turn.stopReason !== undefined) {
      entries.push(
        line(
          `sessions:turn:${turn.key}:stop`,
          fitLine([{ text: "    stopped: " }, { text: turn.stopReason, elide: true }], width),
          styleOf("metadata"),
        ),
      );
    }
    if (turn.failure !== undefined) {
      entries.push(
        line(
          `sessions:turn:${turn.key}:failed`,
          fitLine([{ text: "    " }, { text: headline(turn.failure), elide: true }], width),
          styleOf("failed-outcome"),
        ),
      );
    }
    const request = turn.request;
    if (request !== undefined) {
      // Inline, on the turn that is waiting. Focusable where it can be answered
      // and a plain fact where it cannot: the grammar answers a request on the
      // Sessions surface, and a control that refused when activated would be a
      // target that does nothing. Either way, arriving here opens nothing —
      // somebody activates it.
      const asks: readonly ReplLabelPart[] = [
        { text: "    asks: " },
        { text: headline(request.title ?? request.toolCallId), elide: true },
      ];
      entries.push(
        state.route.surface === "sessions"
          ? row(
              `sessions:request:${request.key}`,
              fitControl(asks, width),
              { select: "permission", request: request.key },
              styleOf("waiting"),
              { here: focused },
            )
          : line(`sessions:request:${request.key}`, fitLine(asks, width), styleOf("waiting")),
      );
    }
    for (const [at, audit] of turn.audits.entries()) {
      // Read, never answered: a record is what a turn was granted, and offering
      // a control here would invite somebody to answer a question nobody asked.
      entries.push(
        line(
          `sessions:audit:${turn.key}:${at}`,
          // The outcome comes last and stays, for the same reason a turn's state
          // does: it is the whole of what a retained audit says.
          fitLine(
            [
              { text: "    granted: " },
              { text: headline(audit.title ?? audit.toolCallId), elide: true },
              { text: " — " },
              { text: outcomeOf(audit), keep: true },
            ],
            width,
          ),
          styleOf("metadata"),
        ),
      );
    }
  }
  items.push(...entries);
  if (sidekick === undefined) {
    // One owner, one list, and exactly the surface this has always been.
    return items;
  }
  if (entries.length === 0 && !compact) {
    // Said rather than left blank: a section that drew nothing would read as a
    // gap, and a reader cannot tell a gap from a list that failed to appear.
    // One list has no section to report empty, so it says so once at the end.
    items.push(line("sessions:entries:none", "    No entry turns.", styleOf("metadata")));
  }
  if (!compact) {
    items.push(line("sessions:section:sidekick", "  Sidekick", styleOf("pane-heading")));
  }
  if (sidekick.refusal !== undefined) {
    // A chat history this version cannot read. Its own reason stands here, and
    // it does not masquerade as a Sidekick that has done no work: showing
    // somebody an empty section for a file that holds their conversations is
    // the one answer that cannot be corrected later.
    items.push(
      line("sessions:sidekick:refusal", `    ${sidekick.refusal}`, styleOf("failed-outcome")),
    );
    return items;
  }
  const chat = sidekick.turns.filter((turn) => filter === undefined || turn.sessionKey === filter);
  if (chat.length === 0) {
    if (compact) {
      // One list, so one placeholder, and only where the whole list is empty.
      // A Transcript that said "no Sidekick turns" under an entry turn it is
      // already showing would be naming a section this reading does not have.
      if (entries.length === 0) {
        items.push(line("sessions:none", `${CONTROL_ROOM}(none retained)`, styleOf("metadata")));
      }
      return items;
    }
    items.push(line("sessions:sidekick:none", "    No Sidekick turns.", styleOf("metadata")));
    return items;
  }
  if (compact) {
    let label: string | undefined;
    for (const turn of chat) {
      const whose = [turn.agent, turn.conversation, turn.sessionKey]
        .filter((fact) => fact !== undefined)
        .join(" \u00b7 ");
      if (whose !== label) {
        items.push(
          line(
            `sessions:${turn.key}:whose`,
            fitLine([{ text: CONTROL_ROOM }, { text: whose, elide: true }], width),
            styleOf("metadata"),
          ),
        );
      }
      label = whose;
      items.push(...compactSidekickTurn(turn, sidekick, width, focused));
    }
    return items;
  }
  for (const turn of chat) {
    items.push(
      row(
        `sessions:${turn.key}`,
        fitControl(
          [
            { text: "    " },
            { text: headline(turn.title), elide: true },
            { text: " \u00b7 " },
            { text: turn.state, keep: true },
          ],
          width,
        ),
        // Activating it opens the chat that contains it and brings it into
        // view. Never a History marker: a Sidekick turn is in no entry
        // position, and navigating to a guessed one would freeze the entry
        // reading at a place this turn says nothing about.
        {
          select: "sidekick-turn",
          conversation: turn.conversation,
          // Its own ordinal where a record holds one, and nothing where none
          // does: work still in flight is opened in its chat without a saved
          // row to reveal, rather than against a number this screen made up.
          ...(turn.turn === null ? {} : { turn: turn.turn }),
        },
        turn.running
          ? styleOf("waiting")
          : turn.failed
            ? styleOf("failed-outcome")
            : styleOf("output"),
        { here: focused },
      ),
    );
    // Whose work this was: this section's own owner, then the chat's agent and
    // the chat itself, then the provider conversation where one is known. Never
    // whichever agent happens to be active now — a conversation does not change
    // agent in place, so its turns say what actually answered in them.
    const whose = ["Sidekick", turn.agent, turn.conversation];
    if (turn.sessionKey !== undefined) {
      whose.push(turn.sessionKey);
    }
    items.push(
      line(
        `sessions:${turn.key}:whose`,
        fitLine([{ text: "      " }, { text: whose.join(" \u00b7 "), elide: true }], width),
        styleOf("metadata"),
      ),
    );
    if (turn.text.length > 0) {
      items.push(
        line(
          `sessions:${turn.key}:text`,
          fitLine([{ text: "      " }, { text: headline(turn.text), elide: true }], width),
          styleOf("output"),
        ),
      );
    }
    if (turn.failure !== undefined) {
      items.push(
        line(
          `sessions:${turn.key}:failed`,
          fitLine([{ text: "      " }, { text: headline(turn.failure), elide: true }], width),
          styleOf("failed-outcome"),
        ),
      );
    }
  }
  return items;
}

/**
 * How many rows the Sessions reading holds, whatever the window shows.
 *
 * Counted by building the same rows the window slices, so the number a scroll
 * clamps against cannot disagree with the list it is clamping: one definition of
 * what the reading is, asked twice.
 */
function sessionContentRows(
  state: ReplState,
  model: ReplModel,
  live: ReplLive,
  compact = false,
): number {
  return sessionRows(
    state,
    chronology(model, live),
    undefined,
    undefined,
    undefined,
    live.sidekick,
    compact,
  ).length;
}

/**
 * The Entries catalog, as rows, in immutable admission order.
 *
 * Admission order and nothing else: not completion, not terminal outcome, not
 * publication and not latest activity. An entry's place in this list is a fact
 * about when it was admitted, so a row cannot move out from under somebody
 * because a later entry finished first.
 *
 * Each row is keyed by its entry's own stable key rather than by where it sits
 * in whatever window is showing, so scrolling moves the window and changes the
 * identity of nothing in it. Its nested scopes follow it, keyed by the path
 * that selects them — which begins with that entry, so two entries holding the
 * same component cannot collide.
 *
 * The outcome comes before the name, because the name is unbounded and the
 * column is not. A sidebar is 28 columns at its narrowest, and this row is the
 * one place a reader is promised an entry's outcome — put it after an
 * arbitrarily long root name and a long enough name takes the promise away.
 */
function entryContent(
  model: ReplModel,
  focused: string | undefined,
  reading: string | undefined,
  /** How wide the frame measured the region these rows land in, if it has. */
  width: number | undefined,
  /**
   * The key this frame restores focus to, for the entry row that turns out to be
   * it.
   *
   * A narrow frame draws no inspection region, so an answer given there is
   * restored to the entry that owns the record rather than to the record's own
   * row — which is the control a reader can actually see.
   */
  claim?: string | undefined,
): readonly Described[] {
  const items: Described[] = [];
  for (const entry of model.entries) {
    items.push(
      row(
        `entry:${entry.key}`,
        // The outcome still comes before the name, and the marker takes the two
        // columns the indent already had — so a row that is not being read is
        // exactly as wide as it was.
        fitControl(
          [
            {
              text: `${selected(reading === entry.key)}${entry.order}. [${outcomeOfEntry(entry)}] `,
            },
            { text: entry.scope.name, elide: true },
          ],
          width,
        ),
        { select: "scope", scopes: [entry.key] },
        entryStyle(entry, reading === entry.key),
        { here: focused, claim },
      ),
    );
    for (const scope of nested(entry.scope, [entry.key])) {
      items.push(
        row(
          `scope:${scope.path.join("/")}`,
          fitControl([{ text: "    " }, { text: scope.label, elide: true }], width),
          { select: "scope", scopes: scope.path },
          styleOf("metadata"),
          { here: focused, claim },
        ),
      );
    }
  }
  return items;
}

/**
 * What one catalog row says this entry came to.
 *
 * Four readings, because those are the four a reader has to tell apart: an
 * entry whose root has not closed is unfinished — running here, or interrupted
 * before it settled — and the three outcomes a root close carries are three
 * different answers rather than one "done".
 */
function outcomeOfEntry(entry: ReplEntry): string {
  return entry.terminal === undefined ? "unfinished" : entry.terminal.status;
}

/**
 * What one catalog row means, read from the outcome its root recorded.
 *
 * The same four readings the row spells out, so the colour and the word cannot
 * disagree. An entry still being read keeps its outcome: being selected says
 * which transcript is on screen, not that the entry came to something else.
 */
function entryStyle(entry: ReplEntry, selected: boolean): ReplRowStyle {
  const terminal = entry.terminal;
  if (terminal === undefined) {
    return styleOf("waiting", { selected });
  }
  if (terminal.status === "ok") {
    return styleOf("successful-outcome", { selected });
  }
  return styleOf(terminal.status === "err" ? "failed-outcome" : "waiting", { selected });
}

/**
 * How far one turn has got, in words a reader can act on.
 *
 * How it ended and whether the history holds it are separate facts, and a turn
 * that has finished is not the same as one that has been recorded: a person
 * looking at the second may go to its position, and a person looking at the
 * first is watching this process.
 */
/**
 * What one turn's row means, read from how far the turn itself has got.
 *
 * The same four readings the row spells out. A turn nobody has answered yet is
 * waiting whatever it will become; one that failed is a failure however it was
 * phrased; and a turn that finished is the result a reader came for.
 */
function turnStyle(turn: ReplSessionTurn): ReplRowStyle {
  if (turn.state === "queued" || turn.state === "active") {
    return styleOf("waiting");
  }
  if (turn.status === "failed" || turn.failure !== undefined) {
    return styleOf("failed-outcome");
  }
  return styleOf("output");
}

function stateOf(turn: ReplSessionTurn): string {
  if (turn.state === "queued") {
    return "queued";
  }
  if (turn.state === "active") {
    return "streaming";
  }
  const ended = turn.status ?? "finished";
  return turn.state === "terminal" ? `${ended}, not recorded yet` : `${ended}, recorded`;
}

/** What a retained audit says happened, without repeating the whole record. */
function outcomeOf(audit: ReplAgentPermission): string {
  if (audit.outcome === "cancelled") {
    return "cancelled";
  }
  const chosen = audit.options.find((option) => option.optionId === audit.selected);
  return chosen === undefined ? "answered" : chosen.name;
}

/**
 * The message the presented drawer is fitting, or none because none is.
 *
 * A held question or permission behind another drawer contributes no text
 * to that drawer's fitted preview.
 */
export function previewedMessage(view: ReplView): string | undefined {
  const open = view.selection.drawers.at(-1);
  if (open?.kind === "live-permission") {
    return view.live.agent.requests.find((request) => request.key === view.state.permission)?.title;
  }
  if (open !== undefined) {
    return open.kind === "live-elicit" ? view.live.question?.message : undefined;
  }
  return presentedAsking(view)?.question.message;
}

/**
 * The Sidekick form this view is presenting, or none.
 *
 * Only while the Sidekick is the selected reading, and only while its key still
 * names the question the owner holds: a form left open behind a tab change is
 * state rather than presentation, and one whose question ended is neither.
 */
function presentedAsking(
  view: ReplView,
): { readonly held: ReplAsking; readonly question: ReplSidekickQuestion } | undefined {
  // A route drawer owns the modal while it is open, and owning it means owning
  // its content, its width, its window, its close and its focus. The Sidekick's
  // form is still *held* underneath — its question is waiting and its values are
  // typed — and none of that makes it the thing on the screen. Answering
  // otherwise gave History's rows the Sidekick's own controls.
  if (view.selection.drawers.length > 0) {
    return undefined;
  }
  const held = view.state.asking;
  const question = view.live.sidekick?.question;
  if (held === undefined || !held.open || question === undefined || question.key !== held.key) {
    return undefined;
  }
  // The pane has to be the one showing. A narrow frame routes one outlet and a
  // wide one two tabs, and in both cases this form lives in the Sidekick's own
  // pane — so when that pane is not what is drawn, neither is this.
  //
  // And the chat being read has to be the one asking. A pending question
  // belongs to the current conversation, so reading an older chat hides the
  // form rather than drawing it over somebody else's transcript. Hidden, not
  // discarded: the question stays pending and every value already typed into
  // it is exactly where it was when the reader comes back.
  return showingSidekick(view) && currentChat(view) ? { held, question } : undefined;
}

/**
 * Whether the chat this view is reading is the one this Sidekick is continuing.
 *
 * True where there is no Sidekick at all, because the question is about the
 * reading rather than about the Sidekick: a frame with none draws none of its
 * controls either way, and answering `false` here would hide things that are
 * not about a chat.
 */
function currentChat(view: ReplView): boolean {
  return view.live.sidekick?.current !== false;
}

/**
 * Which editable drawer this committed view is presenting.
 *
 * One fact rather than two, because what it decides is one thing: where a
 * keystroke goes. A form held open in state while the screen shows something
 * else owns nothing — what owns typing is what is drawn.
 */
export type ReplPresented =
  | { readonly kind: "entry-question"; readonly question: ReplQuestion }
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "configure" };

export function presentedDrawer(view: ReplView): ReplPresented | undefined {
  if (
    !view.state.heldHistory &&
    view.selection.drawers.at(-1)?.kind === "live-elicit" &&
    view.live.question !== undefined
  ) {
    return { kind: "entry-question", question: view.live.question };
  }
  const asking = presentedAsking(view);
  if (asking !== undefined) {
    return { kind: "question", question: asking.question.key };
  }
  return presentedConfiguring(view) === undefined ? undefined : { kind: "configure" };
}

/**
 * Whether the Configure drawer is the thing presented in the Sidekick's pane.
 *
 * The same three conditions the question form answers: no route drawer on top,
 * the drawer actually open, and this pane the one being drawn. Configure and
 * the question form are alternative contents of one pane, so at most one of
 * them is ever open — opening either hides the other's presentation and keeps
 * everything in it.
 */
function presentedConfiguring(view: ReplView): ReplConfiguring | undefined {
  if (view.selection.drawers.length > 0) {
    return undefined;
  }
  const held = view.state.configuring;
  // Configure belongs to the current conversation, so reading an older chat
  // hides it for the same reason it hides the question form: a drawer that
  // configured the conversation somebody is *not* reading would apply a
  // decision to work they are not looking at.
  return held.open && showingSidekick(view) && currentChat(view) ? held : undefined;
}

/**
 * Whether the Entries catalog is the thing presented over this reading.
 *
 * Three conditions, like the Sidekick's own drawers: no route drawer on top of
 * it, the catalog actually open, and a staged composition to float it over.
 * The ordinary composition keeps its permanent Entries column, so there is
 * nothing for an overlay to stand in for there.
 *
 * It takes precedence over the Sidekick's pane-local form and Configure
 * without answering or discarding either: both keep what is in them, and
 * closing this gives them the screen back.
 */
function presentedCatalog(view: ReplView): boolean {
  return view.selection.drawers.length === 0 && view.state.catalog && staged(view) !== undefined;
}

/** Whether this view's Sidekick pane is the one being drawn. */
function showingSidekick(view: ReplView): boolean {
  return profileFor(view.size) === "narrow"
    ? view.state.route.view === "sidekick"
    : (view.state.route.right ?? "sidekick") === "sidekick";
}

/**
 * Whether a modal is holding focus, by either owner.
 *
 * One question is presented at a time, and a route drawer takes precedence:
 * its own explicit close is what a person reaches before they can reach the
 * Sidekick's opener, so an open permission request is never answered or
 * dismissed by something underneath it.
 */
function modalOpen(view: ReplView): boolean {
  return (
    view.selection.drawers.length > 0 ||
    presentedCatalog(view) ||
    presentedAsking(view) !== undefined ||
    presentedConfiguring(view) !== undefined
  );
}

/**
 * The rectangle whichever drawer is presented occupies.
 *
 * One calculation for both, read back by measurement, admission, description,
 * drawing and hit testing: the entry's covers the body, and the Sidekick's
 * covers the pane that owns its question.
 *
 * A route drawer's is the envelope the preparation settled once it had measured
 * the guidance this layer must stay clear of. Taken from the frame's own context
 * rather than recomputed here, so there is one answer to where it is: a second
 * calculation is how a drawer's cells and its targets come to disagree. Before
 * that block has been fitted there is nothing to clear, and the rectangle the
 * size states is what those passes measure.
 *
 * Staged drawers also clear the extra fitted footer rows. Pane-local drawers
 * keep their own origin; route drawers keep their existing inset.
 */
function presentedRect(view: ReplView, context: ReplPresentationContext): ReplBounds | undefined {
  // Which body this layer covers: the staged composition keeps three rows
  // around its body where the ordinary one keeps seven, so a rectangle derived
  // from the other budget would hang off the bottom of this screen.
  const workspace = staged(view) !== undefined;
  // The catalog floats over the body, exactly where a route drawer does: it is
  // a reading of the whole execution rather than of one pane, so a pane-local
  // rectangle would put the list of every entry inside the Sidekick's column.
  const rect =
    view.selection.drawers.length > 0 || presentedCatalog(view)
      ? (context.drawer ?? drawerRect(view.size, workspace))
      : presentedAsking(view) !== undefined || presentedConfiguring(view) !== undefined
        ? sidekickDrawerRect(view.size, workspace)
        : undefined;
  if (rect === undefined || !workspace) {
    return rect;
  }
  return Object.freeze({
    ...rect,
    height: Math.max(0, rect.height - Math.max(0, (context.guidance?.length ?? 1) - 1)),
  });
}

/**
 * The innermost open drawer, as a modal branch holding its own controls.
 *
 * Every reading it can show — a binding's value, a recorded answer, History's
 * positions, a pending permission, the waiting question's form — is built as one
 * ordered list and shown through one measured window. Only what that window
 * holds is described, so a row outside it contributes no mounted node, no drawn
 * cell, no keyboard stop and no pointer target. The title, both window controls
 * and `[close]` stay outside the thing they move, because a control inside a
 * window scrolls away from whoever was reaching for it.
 *
 * Its detail is one child per line rather than one multi-line label, because a
 * cell is a row: a label holding three lines would show one of them, and a reader
 * would have no way to know the other two existed.
 */
function drawerFor(
  view: ReplView,
  context: ReplPresentationContext,
  history: Described,
  exit: Described,
  drawable: boolean,
): { readonly drawer: Described; readonly rows: readonly Described[] } | undefined {
  const held = drawerContent(
    view,
    context.widths?.drawer ?? 0,
    context.preview,
    context.notices,
    context.details,
  );
  if (held === undefined) {
    return undefined;
  }
  const { title, titleStyle, dismissing, entering, content } = held;
  const width = context.widths?.drawer ?? 0;
  // Which owner's drawer this is, for the scroll controls, the editable line
  // the window claims focus for, and `[close]`. One drawer is presented at a
  // time, so this is also what says the Sidekick's own is the one on screen.
  //
  // The catalog's window is the entries window somebody is already scrolling,
  // so its controls carry that reading's own scroll rather than the generic
  // one — the clamp is this drawer's measured capacity either way. It is asked
  // first below because `drawerContent` asks it first: two orders over the same
  // three readings is how a drawer comes to show one window's rows and move
  // another one's. Holding all three at once needs a route none of these
  // controls offers, so this is drift prevented rather than a state anybody
  // has been in.
  const catalog = presentedCatalog(view);
  const asking = presentedAsking(view)?.question.key;
  const configuring = presentedConfiguring(view) !== undefined;
  const overHeld =
    view.selection.drawers.at(-1)?.kind === "history" && view.state.heldHistory === true;
  const rows: Described[] = [];
  const reveals = catalog
    ? (from: number, count: number) => catalogReveals(content, from, count)
    : (from: number, count: number) =>
        flatReveals(
          content.map((one) => one.described),
          from,
          count,
        );
  const admitted = windowed(content, context, entering, view.focused, asking, reveals);
  const readings =
    configuring &&
    view.focused !== "drawer:reading:anchor" &&
    admitted.some((one) => {
      const read = readDescription(one.description);
      return isControl(read.component, read.input);
    })
      ? admitted
      : anchored(admitted, "drawer:reading:anchor", "drawer", view.focused);
  for (const placed of readings) {
    rows.push(placed);
  }

  // The two nodes the footer would have drawn, inside the modal focus root. A
  // modal contains focus, so a way out mounted beside it would be one Tab could
  // not reach — and a drawer a person cannot leave the command from is a drawer
  // that has taken their terminal.
  //
  // Reparented, but still admitted: the action row is where their cells land, so
  // a control that row cannot hold whole is not described here either.
  const offered = (key: string): boolean =>
    context.measuring ||
    context.admission.actions.has(overHeld ? key.replace("footer:", "footer:top:") : key);
  // Stop, where the Sidekick's own pane would have offered it. Its own row of
  // this form rather than the pane's row mounted inside it: a reparented node
  // keeps its focus stop and loses its cell, and a control somebody cannot see
  // is not a control. One node either way — while the form is in front of that
  // pane, the pane describes none of its body.
  if (asking !== undefined || view.selection.drawers.at(-1)?.kind === "live-elicit") {
    rows.push(
      row(
        "drawer:form:submit",
        "[submit]",
        asking === undefined
          ? { select: "form-submit" }
          : { select: "sidekick-form-submit", question: asking },
        styleOf("action"),
        { here: view.focused },
      ),
    );
  }
  if ((asking !== undefined || configuring) && view.live.sidekick?.busy === true) {
    rows.push(
      row("drawer:sidekick:stop", "[stop]", { select: "stop-sidekick" }, styleOf("action"), {
        here: view.focused,
      }),
    );
  }
  if (offered("footer:history")) {
    rows.push(history);
  }
  if (drawable && offered("footer:exit")) {
    rows.push(exit);
  }
  rows.push(
    row(
      "drawer:close",
      "[close]",
      dismissing !== undefined
        ? { select: "permission-dismiss", request: dismissing }
        : catalog
          ? // Putting the catalog away chooses nothing: the scope being read,
            // the marker, the filter and both drafts stand.
            { select: "catalog-close" }
          : // Closing one of the Sidekick's own drawers is not what closing the
            // entry's means. The question form keeps its question and its
            // values; Configure discards what was chosen and not applied, and
            // saves and changes nothing.
            configuring
            ? { select: "configure-close" }
            : asking === undefined
              ? { select: "close" }
              : { select: "sidekick-question-close" },
      styleOf("action"),
      { here: view.focused },
    ),
  );
  const visibleRows = overHeld
    ? rows.map((one) => {
        if (one.key !== "footer:history" && one.key !== "footer:exit") {
          return one;
        }
        const read = readDescription(one.description);
        const key = one.key.replace("footer:", "footer:top:");
        return {
          ...one,
          key,
          description: describeNode<ReplAction>({
            key,
            component: read.component,
            input: read.input,
          }),
        };
      })
    : rows;
  const covered = (one: Described) => {
    const read = readDescription(one.description);
    return describeNode<ReplAction>({
      key: read.key,
      component: read.component,
      input: { ...fields(read.input), covered: true },
    });
  };
  const contentKeys = new Set(readings.map((one) => one.key));
  const viewportRows = visibleRows.filter((one) => contentKeys.has(one.key));
  const fixedRows = visibleRows.filter((one) => !contentKeys.has(one.key));
  const viewport = describeNode<ReplAction>({
    key: "viewport:drawer",
    component: VIEWPORT,
    input: { window: DRAWER_WINDOW },
    children: viewportRows.map((one) => one.description),
  });
  const viewportChildren = [viewport, ...fixedRows.map((one) => one.description)];
  const children = overHeld
    ? [
        covered(history),
        covered(exit),
        describeNode<ReplAction>({
          key: "drawer:history",
          component: DRAWER,
          input: { label: "" },
          modal: true,
          children: viewportChildren,
        }),
      ]
    : viewportChildren;
  const drawer: Described = {
    key: "drawer:open",
    style: titleStyle,
    description: describeNode<ReplAction>({
      key: "drawer:open",
      component: DRAWER,
      input: { label: width < 1 ? title : title.padEnd(width, " ") },
      children,
      modal: true,
    }),
  };
  return { drawer, rows: visibleRows };
}

/** What one drawer reading holds, before any window decides what is shown. */
interface DrawerContent {
  readonly title: string;
  /**
   * What the title is, which is not the same for every drawer.
   *
   * A drawer holding something nobody has answered yet is named in the accent
   * this screen already uses for waiting, so the one drawer a reader has to act
   * on is the one that says so before they have read a word of it.
   */
  readonly titleStyle: ReplRowStyle;
  readonly dismissing: string | undefined;
  readonly entering: boolean;
  readonly content: readonly DrawerRow[];
}

/**
 * Everything the innermost open drawer holds, in order, or none if it has gone.
 *
 * One builder, asked twice: once for the rows a window shows and once for how
 * many rows there are to window. A second counter is how a clamp comes to
 * disagree with the list it is clamping.
 */
/**
 * The rows a question's message is read in.
 *
 * The frame's fitted rows where it prepared them, and the logical lines where
 * it has not — the pass that measures the drawer's width cannot already have
 * fitted text to it. An unfitted pass describes no window content anyway, so
 * the fallback is what a measurement sees and never what a reader does.
 */
function messageRows(
  question: { readonly message: string },
  preview: readonly ReplFittedLine[] | undefined,
): readonly { readonly text: string; readonly runs: readonly ReplTokenRun[] }[] {
  if (preview !== undefined) {
    return preview.map((one) => ({
      text: " ".repeat(one.indent) + one.text,
      runs:
        one.indent === 0
          ? one.runs
          : tokenRuns([{ text: " ".repeat(one.indent), token: "punctuation" }, ...one.runs]),
    }));
  }
  return question.message.split("\n").map((text) => ({ text, runs: sourceRuns(text) }));
}

function drawerContent(
  view: ReplView,
  width: number,
  preview?: readonly ReplFittedLine[] | undefined,
  notices?: ReplPreparedNotices,
  details?: readonly ReplFittedLine[],
): DrawerContent | undefined {
  const open = view.selection.drawers[view.selection.drawers.length - 1];
  if (open === undefined && presentedCatalog(view)) {
    return catalogContent(view, width);
  }
  if (open === undefined) {
    // No route drawer, so this is one of the Sidekick's own two drawers if
    // anything is. Configure first: opening it hides the question form's
    // presentation, so both are never open at once.
    const settings = presentedConfiguring(view);
    if (settings !== undefined) {
      return configureContent(view, settings, width, notices);
    }
    const asking = presentedAsking(view);
    return asking === undefined ? undefined : askingContent(view, asking, width, preview);
  }
  // Every row of this drawer reaches its own right edge. A modal that wrote only
  // its own text would let what it is in front of show through from where that
  // text stopped, because a renderer writes what changed and nothing else.
  const content: DrawerRow[] = [];
  let title: string;
  /** What the title reads as. Ordinary unless this drawer is a question. */
  let titleStyle: ReplRowStyle = styleOf("drawer-title");
  /**
   * The request this drawer's close control denies, when it is one.
   *
   * A permission drawer closes by *answering* — dismissal is the direct denial
   * path the authority owns — so its close control carries the request rather
   * than the generic close action that means "this changed nothing".
   */
  let dismissing: string | undefined;
  /** Whether a field line may take the focus request this drawer opens with. */
  let entering = false;

  if (open.kind === "binding") {
    title = drawerTitle("Binding", open.name, width);
    content.push(
      ...detailRows("drawer:value", open.binding.value, width, styleOf("field-value"), details),
    );
  } else if (open.kind === "recorded-elicit") {
    title = drawerTitle("Recorded answer", open.elicitation.location, width);
    // The whole of what was asked and the whole of what was answered. A drawer is
    // where the retained value is, so a summary here would leave a reader with no
    // way to see what the record actually holds.
    content.push({
      described: drawerLine("drawer:schema", "schema", width, styleOf("field-label")),
    });
    content.push(
      ...detailRows(
        "drawer:schema",
        open.elicitation.schema,
        width,
        styleOf("field-hint"),
        details,
      ),
    );
    content.push({
      described: drawerLine("drawer:answered", "answer", width, styleOf("field-label")),
    });
    content.push(
      ...detailRows(
        "drawer:answer",
        open.elicitation.answer,
        width,
        styleOf("field-value"),
        details,
      ),
    );
  } else if (open.kind === "live-permission") {
    // The request this screen selected, read again here: a drawer draws what is
    // pending now, and the one it was opened over may have been answered or torn
    // down since.
    const request =
      view.state.permission === undefined
        ? undefined
        : view.live.agent.requests.find((candidate) => candidate.key === view.state.permission);
    if (request === undefined) {
      return undefined;
    }
    title = drawerTitle("Permission", request.title, width);
    titleStyle = styleOf("question-title");
    // One window over the whole of it. `options` is the provider's, and nothing
    // bounds how many it offers: a drawer that described every choice would have
    // layout clip the last ones, which are exactly the ones a person scrolled
    // down to find.
    for (const placed of permissionContent(
      view.model,
      view.live,
      request,
      width,
      view.focused,
      preview,
    )) {
      content.push({ described: placed });
    }
    dismissing = request.key;
  } else if (open.kind === "history") {
    title = "History";
    // Every retained position, through the same window. A marker outside it is
    // not described, so it is not a cell, not a target and not a Tab stop —
    // which is what makes reaching the last one a thing the controls do rather
    // than something clipping hides.
    // The whole recorded order, not the selected prefix: the positions after
    // the one being read are where a reader can go next, and a drawer that
    // stopped at the selection would be a list of where they had already
    // been. Every position gets its own row — a group is how the rail *draws*
    // two of them, never how it counts them — and each says what kind it is
    // without reading anything the position holds.
    for (const one of numbered(view.navigation)) {
      content.push({
        described: row(
          `drawer:marker:${one.point.marker}`,
          padControl(pointLabel(one.point, one.ordinal, one.entry), width),
          { select: "marker", marker: one.point.marker },
          styleOf("history", {
            selected: view.state.route.at === one.point.marker,
            inspected: true,
          }),
          { here: view.focused },
        ),
      });
    }
  } else {
    const question = view.live.question;
    if (question === undefined) {
      return undefined;
    }
    const built = formContent(question, view.state.form, width, preview, view.focused, undefined);
    title = built.title;
    titleStyle = built.titleStyle;
    entering = built.entering;
    content.push(...built.content);
  }

  if (content.length === 0) {
    content.push({ described: drawerLine("drawer:empty", " ", width, styleOf("metadata")) });
  }
  return { title, titleStyle, dismissing, entering, content };
}

/**
 * One row of a drawer's ordered content, and what it would take to focus it.
 *
 * A field's editable line is built unfocused and the request is placed afterwards,
 * once the window is known: focusing a row that scrolled out would put focus
 * where nothing is drawn, and which row is first inside the window is not
 * something the loop that builds them can see.
 */
interface DrawerRow {
  readonly described: Described;
  readonly field?: { readonly name: string; readonly value: string };
}

/**
 * A question's form as ordered drawer rows, for whichever owner asked it.
 *
 * One builder for both, because a form is a form: the complete message, the
 * description, every field with its annotation and options, its editable line,
 * every validation message and `[submit]` are the same rows in the same order.
 * What differs is only which question an activation names — the entry's actions
 * mean "the question this session is asking", and the Sidekick's carry the key
 * of the exact question they were drawn for.
 *
 * The keys stay the drawer's own, because one drawer is presented at a time and
 * the frame places rows by the slot their key names.
 */
function formContent(
  question: { readonly message: string; readonly form: ReplQuestionForm },
  held: ReplFormState,
  width: number,
  preview: readonly ReplFittedLine[] | undefined,
  focused: string | undefined,
  /** The Sidekick's question this form answers, or none for the entry's. */
  asking: string | undefined,
): {
  readonly title: string;
  readonly titleStyle: ReplRowStyle;
  readonly entering: boolean;
  readonly content: readonly DrawerRow[];
} {
  const form = question.form;
  const content: DrawerRow[] = [];
  for (const [offset, part] of messageRows(question, preview).entries()) {
    content.push({
      described: drawerLine(
        `drawer:message:${offset}`,
        part.text,
        width,
        styleOf("source"),
        part.runs,
      ),
    });
  }
  if (form.description !== undefined) {
    content.push({
      described: drawerLine("drawer:form:about", form.description, width, styleOf("field-hint")),
    });
  }
  // The same rule inside the modal: the first control claims focus when the
  // drawer opens, and afterwards traversal inside the drawer owns it.
  const entering =
    focused === undefined ||
    (!focused.startsWith("drawer:") &&
      focused !== "footer:history" &&
      focused !== "footer:exit" &&
      !focused.startsWith("footer:top:"));
  for (const one of form.fields) {
    const value = held.values[one.name] ?? "";
    const marked = requiredNow(form, held.values, one) ? "*" : " ";
    const label = one.title ?? one.name;
    // What the field is called and what is in it, on one row and told apart: a
    // reader scanning a form reads down the labels, and a label that looked like
    // its own value would make them read every row to find the one they have
    // not filled in yet.
    const named = padded(
      tokenRuns([
        { text: `${marked}${label}:`, token: "field-label" },
        { text: " ", token: "field-label" },
        { text: value, token: "field-value" },
      ]),
      width - FOCUS_MARKER,
      "field-label",
    );
    content.push({
      described: row(
        `drawer:field:${one.name}`,
        runText(named),
        asking === undefined
          ? { select: "form-field", field: one.name }
          : { select: "sidekick-form-field", field: one.name, question: asking },
        styleOf("field-label"),
        { here: focused, runs: named },
      ),
    });
    if (one.description !== undefined) {
      content.push({
        described: drawerLine(
          `drawer:field:${one.name}:about`,
          `  ${one.description}`,
          width,
          styleOf("field-hint"),
        ),
      });
    }
    if (one.choices !== undefined) {
      // What this field accepts, said once. The controls below are how a value
      // is chosen; this is the line that names the whole set, and it is what a
      // reader scanning the form reads first.
      content.push({
        described: drawerLine(
          `drawer:form:${one.name}`,
          `${one.name}: ${one.choices.join(" | ")}`,
          width,
          styleOf("field-hint"),
        ),
      });
    }
    // Every offered value, each its own control. A form that drew only the
    // first would be offering a choice nobody could make.
    for (const option of one.choices ?? []) {
      content.push({
        described: row(
          `drawer:choice:${one.name}:${option}`,
          padControl(`  ${value === option ? "(x)" : "( )"} ${option}`, width),
          asking === undefined
            ? { select: "form-choice", field: one.name, option }
            : { select: "sidekick-form-choice", field: one.name, option, question: asking },
          styleOf("action", { selected: value === option }),
          { here: focused },
        ),
      });
    }
    // The one editable line for this field, which is where text and Backspace
    // land while it has focus. The first field's line claims focus when the
    // drawer opens — including an enum's, because typing an offered value and
    // pressing Enter is still a way to answer.
    content.push({
      described: field(
        `drawer:value:${one.name}`,
        "  = ",
        value,
        asking === undefined ? "answer" : "sidekick-answer",
        styleOf("field-value"),
        asking === undefined
          ? { here: focused, field: one.name, caret: held.carets?.[one.name] }
          : { here: focused, field: one.name, question: asking, caret: held.carets?.[one.name] },
      ),
      field: { name: one.name, value },
    });
  }
  // What the last submission was told, under the form it is about.
  for (const [offset, message] of held.messages.entries()) {
    content.push({
      described: drawerLine(
        `drawer:invalid:${offset}`,
        message.field === undefined ? message.message : `${message.field}: ${message.message}`,
        width,
        styleOf("failed-outcome"),
      ),
    });
  }
  return {
    title: form.title ?? "Answer",
    titleStyle: styleOf("question-title"),
    entering,
    content,
  };
}

/** One setting, said as a reader reads it: a model and an effort, or neither. */
function settingLine(settings: SessionConfiguration | undefined): string {
  if (settings === undefined) {
    return "none";
  }
  const parts: string[] = [];
  if (settings.model !== undefined) {
    parts.push(`model=${settings.model}`);
  }
  if (settings.effort !== undefined) {
    parts.push(`effort=${settings.effort}`);
  }
  // Short, because this is drawn in a pane and a sentence the frame clips is
  // one a reader cannot finish.
  return parts.length === 0 ? "none" : parts.join(" ");
}

/**
 * Configure, as the drawer that is presenting it.
 *
 * What it says, in order: which agent this conversation is with and the field
 * that would change it, what has been *asked for* and what an agent was last
 * *verified* on, the models it offers, the effort levels of the model selected
 * here, and the three things a person can do — read again, apply, close.
 *
 * Requested and verified are two lines rather than one, because they answer
 * different questions. A preference says what somebody asked for; Core's saved
 * account of a turn that started says what an agent was actually running under.
 * Where there is no saved verification this says so rather than borrowing the
 * request to stand in for it.
 */
/**
 * The Entries catalog, as the rows one drawer window shows.
 *
 * The same rows the permanent column draws, built by the same function from
 * the same reading: immutable admission order, each entry's own key and
 * retained outcome, each nested scope under the entry that holds it, and the
 * exact scope path on every row. The catalog is a *reading* of the selected
 * acknowledged prefix, so an earlier marker shows what that prefix held and
 * nothing of what came after it.
 *
 * An execution with no entry says so once, inertly. A placeholder is not a
 * control: there is nothing to go to.
 */
function catalogContent(view: ReplView, width: number): DrawerContent {
  const rows = entryContent(
    view.model,
    view.focused,
    view.selection.entry?.key,
    width,
    focusClaim(view),
  );
  const content: DrawerRow[] =
    rows.length > 0
      ? rows.map((described) => ({ described }))
      : [
          {
            described: drawerLine(
              "drawer:catalog:none",
              "1. (not submitted)",
              width,
              styleOf("metadata"),
            ),
          },
        ];
  return {
    title: drawerTitle("Entries", undefined, width),
    titleStyle: styleOf("drawer-title"),
    dismissing: undefined,
    entering: false,
    content: Object.freeze(content),
  };
}

/**
 * One notice this Configure drawer says: the row key it is drawn under and the
 * whole text it says, before anything has decided how many rows that takes.
 */
export interface ReplDrawerNotice {
  readonly key: string;
  readonly text: string;
}

/** The indent a drawer notice is set in from the drawer's own edge. */
export const NOTICE_INDENT = "  ";

/**
 * The notices this Configure drawer would say, in the order it says them.
 *
 * One answer for two readers: the preparation that fits them to the interior
 * the frame measured, and the builder that draws the rows that fitting
 * produced. A builder deciding for itself how wide a row may be would be a
 * second opinion about the same text — and the opinion a pure builder can form
 * counts code units rather than cells, which is how a seventy-character token
 * came to be drawn as nothing at all.
 */
export function configureNoticesOf(view: ReplView): readonly ReplDrawerNotice[] {
  const held = presentedConfiguring(view);
  return held === undefined ? [] : noticesOf(view, held);
}

/** The same, for a caller that already has the drawer this view is holding. */
function noticesOf(view: ReplView, held: ReplConfiguring): readonly ReplDrawerNotice[] {
  const reading = view.live.sidekick;
  const found: ReplDrawerNotice[] = [];
  if (held.refusal !== undefined) {
    found.push({ key: "drawer:configure:refusal", text: held.refusal });
  }
  const replacing =
    held.agent !== "" && reading?.agent !== undefined && held.agent !== reading.agent;
  const offered = replacing ? undefined : held.offered;
  if (held.reading) {
    found.push({
      key: "drawer:configure:asking",
      text: "Reading what this agent offers...",
    });
  }
  if (replacing) {
    found.push({
      key: "drawer:configure:replacing",
      text: `${held.agent} has its own settings.`,
    });
  } else if (offered === undefined) {
    found.push({
      key: "drawer:configure:unread",
      text: "What this agent offers has not been read yet.",
    });
  } else if (offered.models.length === 0) {
    found.push({
      key: "drawer:configure:no-models",
      text: "This agent offers no model choice.",
    });
  }
  return Object.freeze(found);
}

function configureContent(
  view: ReplView,
  held: ReplConfiguring,
  width: number,
  notices?: ReplPreparedNotices,
): DrawerContent {
  const content: DrawerRow[] = [];
  const focused = view.focused;
  const reading = view.live.sidekick;
  content.push({
    described: field(
      "drawer:configure:agent",
      "> Agent: ",
      held.agent,
      "configure-agent",
      styleOf("field-value"),
      { here: focused, caret: held.caret },
    ),
  });
  // Exactly what was asked for, and exactly what was verified. The second is
  // not derived from the first: a request an agent has not run under yet is
  // still only a request.
  content.push({
    described: drawerLine(
      "drawer:configure:requested",
      `  Requested: ${settingLine(reading?.requested)}`,
      width,
      styleOf("field-hint"),
    ),
  });
  content.push({
    described: drawerLine(
      "drawer:configure:verified",
      `  Verified: ${settingLine(reading?.verified)}`,
      width,
      styleOf("metadata"),
    ),
  });
  if (held.refusal !== undefined) {
    content.push(
      ...noticeRows(
        "drawer:configure:refusal",
        held.refusal,
        width,
        styleOf("failed-outcome"),
        notices,
      ),
    );
  }
  // A different agent is a different conversation, and these choices were read
  // from the agent this one is with: they cannot be applied to another. So they
  // are not offered while a replacement is what Apply would do — a model nobody
  // can ask for is a control that does nothing.
  const replacing =
    held.agent !== "" && reading?.agent !== undefined && held.agent !== reading.agent;
  const offered = replacing ? undefined : held.offered;
  if (held.reading) {
    // Said beside what is already in hand rather than instead of it. A refresh
    // that hid the list would take away the choices a person is looking at,
    // and already advertised choices stay usable while another read runs.
    content.push(
      ...noticeRows(
        "drawer:configure:asking",
        "Reading what this agent offers...",
        width,
        styleOf("waiting"),
        notices,
      ),
    );
  }
  if (replacing) {
    // Said, so a reader knows why the choices went rather than wondering.
    content.push(
      ...noticeRows(
        "drawer:configure:replacing",
        `${held.agent} has its own settings.`,
        width,
        styleOf("metadata"),
        notices,
      ),
    );
  } else if (offered === undefined) {
    // Nothing read, and nothing invented to stand in for it. While the Sidekick
    // is working an inspection is one of the things its conversation cannot do,
    // so this says so rather than offering a list from somewhere else.
    content.push(
      ...noticeRows(
        "drawer:configure:unread",
        "What this agent offers has not been read yet.",
        width,
        styleOf("metadata"),
        notices,
      ),
    );
  } else if (offered.models.length === 0) {
    // `null` from the provider: an agent that offers no model choice at all,
    // which is a different answer from offering choices none of which is yours.
    content.push(
      ...noticeRows(
        "drawer:configure:no-models",
        "This agent offers no model choice.",
        width,
        styleOf("metadata"),
        notices,
      ),
    );
  } else {
    content.push({
      described: drawerLine("drawer:configure:models", "  Model", width, styleOf("field-label")),
    });
    for (const choice of offered.models) {
      // The provider's own words, and the provider's own id on the action: a
      // label is what a reader reads, and the id is what is saved.
      const named = choice.group === undefined ? choice.name : `${choice.group} · ${choice.name}`;
      content.push({
        described: row(
          `drawer:configure:model:${choice.id}`,
          padControl(`  ${held.model === choice.id ? "(x)" : "( )"} ${named}`, width),
          { select: "configure-model", model: choice.id },
          styleOf("action", { selected: held.model === choice.id }),
          { here: focused },
        ),
      });
      if (choice.description !== undefined) {
        content.push({
          described: drawerLine(
            `drawer:configure:model:${choice.id}:about`,
            `    ${choice.description}`,
            width,
            styleOf("field-hint"),
          ),
        });
      }
    }
  }
  if (offered !== undefined && held.model !== undefined) {
    const levels = offered.effort;
    if (levels === undefined || levels.model !== held.model) {
      // Effort belongs to a model, so levels read for another one are not
      // these. Said rather than filled in from the list beside it: choosing an
      // effort this model may not have is a turn refused later for a reason
      // nobody chose.
      content.push({
        described: drawerLine(
          "drawer:configure:effort-unread",
          // Short enough for the pane this is drawn in: a sentence the frame
          // clips is one a reader cannot finish.
          `  Effort for ${held.model}: not read yet.`,
          width,
          styleOf("metadata"),
        ),
      });
    } else {
      content.push({
        described: drawerLine(
          "drawer:configure:efforts",
          "  Effort",
          width,
          styleOf("field-label"),
        ),
      });
      for (const level of levels.levels) {
        content.push({
          described: row(
            `drawer:configure:effort:${level.id}`,
            padControl(`  ${held.effort === level.id ? "(x)" : "( )"} ${level.name}`, width),
            { select: "configure-effort", effort: level.id },
            styleOf("action", { selected: held.effort === level.id }),
            { here: focused },
          ),
        });
      }
    }
  }
  content.push({
    described: row(
      "drawer:configure:refresh",
      padControl("[refresh]", width),
      { select: "configure-refresh" },
      styleOf("action"),
      { here: focused },
    ),
  });
  content.push({
    described: row(
      "drawer:configure:apply",
      // What Apply would do, said on the control. A different agent is a
      // different conversation, and somebody pressing this has to know that
      // before they press it rather than after.
      padControl(
        replacing
          ? reading?.busy === true
            ? "[stop and start new conversation]"
            : "[start new conversation]"
          : "[apply]",
        width,
      ),
      { select: "configure-apply" },
      styleOf("action"),
      { here: focused },
    ),
  });
  return {
    title: "Configure",
    titleStyle: styleOf("drawer-title"),
    dismissing: undefined,
    entering: focused === undefined || !focused.startsWith("drawer:"),
    content,
  };
}

/** The Sidekick's own question, as the drawer that is presenting it. */
function askingContent(
  view: ReplView,
  asking: { readonly held: ReplAsking; readonly question: ReplSidekickQuestion },
  width: number,
  preview: readonly ReplFittedLine[] | undefined,
): DrawerContent {
  const built = formContent(
    asking.question,
    asking.held.form,
    width,
    preview,
    view.focused,
    asking.question.key,
  );
  return {
    title: built.title,
    titleStyle: built.titleStyle,
    dismissing: undefined,
    entering: built.entering,
    content: built.content,
  };
}

/**
 * One row of a drawer's ordered content, and what it would take to focus it.
 *
 * A field's editable line is built unfocused and the focus request is placed afterwards,
 * once the window is known: focusing a row that scrolled out would put focus
 * where nothing is drawn, and which row is first inside the window is not
 * something the loop that builds them can see.
 */
interface DrawerRow {
  readonly described: Described;
  readonly field?: { readonly name: string; readonly value: string };
}

/**
 * The rows one drawer's measured window shows.
 *
 * Nothing while the frame is being measured, because the window is what that
 * pass is asking about. The drawer's opening focus request goes to the first field
 * line the window actually holds.
 */
function windowed(
  content: readonly DrawerRow[],
  context: ReplPresentationContext,
  entering: boolean,
  focused: string | undefined,
  /** The Sidekick question these rows answer, or none for the entry's. */
  asking: string | undefined,
  /** Which admitted rows have logical neighbours the window is not showing. */
  reveals?: (from: number, count: number) => ReadonlyMap<string, Readonly<Record<string, string>>>,
): readonly Described[] {
  if (context.measuring) {
    return [];
  }
  const held = context.admission.windows.get(DRAWER_WINDOW);
  if (held === undefined) {
    return [];
  }
  const rows = content.slice(held.from, held.from + held.count);
  const index = entering ? rows.findIndex((candidate) => candidate.field !== undefined) : -1;
  const beyond = reveals?.(held.from, held.count);
  return rows.map((candidate, at) => {
    const named = candidate.field;
    if (at !== index || named === undefined) {
      const reveal = beyond?.get(candidate.described.key);
      return reveal === undefined ? candidate.described : revealing(candidate.described, reveal);
    }
    const read = readDescription(candidate.described.description);
    return {
      ...candidate.described,
      description: describeNode<ReplAction>({
        key: read.key,
        component: read.component,
        input: {
          ...fields(read.input),
          ...(beyond?.get(candidate.described.key) === undefined
            ? {}
            : { reveal: beyond.get(candidate.described.key) }),
        },
        focus: true,
      }),
    };
  });
}

/** The same row, told which keys reach a neighbour outside its window. */
function revealing(described: Described, reveal: Readonly<Record<string, string>>): Described {
  const read = readDescription(described.description);
  return {
    ...described,
    description: describeNode<ReplAction>({
      key: read.key,
      component: read.component,
      input: { ...fields(read.input), reveal },
      layout: read.layout,
      ...(read.focus ? { focus: true } : {}),
    }),
  };
}

function flatReveals(
  rows: readonly Described[],
  from: number,
  count: number,
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const controls = rows
    .map((one, at) => ({ one, at }))
    .filter(({ one }) => {
      const read = readDescription(one.description);
      return isControl(read.component, read.input);
    });
  const found = new Map<string, Readonly<Record<string, string>>>();
  for (const [index, row] of controls.entries()) {
    if (row.at < from || row.at >= from + count) {
      continue;
    }
    const targets: Record<string, string> = {};
    for (const [step, arrow, alt] of [
      [-1, "ArrowUp", "Alt+ArrowUp"],
      [1, "ArrowDown", "Alt+ArrowDown"],
    ] satisfies readonly (readonly [number, string, string])[]) {
      const other = controls[index + step];
      if (other !== undefined && (other.at < from || other.at >= from + count)) {
        targets[arrow] = other.one.key;
        targets[alt] = other.one.key;
      }
    }
    found.set(row.one.key, targets);
  }
  return found;
}

function transcriptReveals(rows: readonly Described[], from: number, count: number) {
  const found = new Map(flatReveals(rows, from, count));
  const turns = rows
    .map((one, at) => ({ one, at }))
    .filter(({ one }) => {
      const read = readDescription(one.description);
      const input = fields(read.input);
      return (
        isControl(read.component, read.input) &&
        (one.key.startsWith("sessions:turn:") || input?.["select"] === "sidekick-turn")
      );
    });
  for (const [index, row] of turns.entries()) {
    if (row.at < from || row.at >= from + count) {
      continue;
    }
    const targets = { ...found.get(row.one.key) };
    delete targets["ArrowUp"];
    delete targets["ArrowDown"];
    for (const [step, key] of [
      [-1, "ArrowUp"],
      [1, "ArrowDown"],
    ] satisfies readonly (readonly [number, string])[]) {
      const other = turns[index + step];
      if (other !== undefined && (other.at < from || other.at >= from + count)) {
        targets[key] = other.one.key;
      }
    }
    const end = turns[index + 1]?.at ?? rows.length;
    const childAt = rows.findIndex(
      (one, at) => at > row.at && at < end && one.key.startsWith("sessions:request:"),
    );
    const child = rows[childAt];
    if (child !== undefined && (childAt < from || childAt >= from + count)) {
      targets["ArrowRight"] = child.key;
    }
    found.set(row.one.key, targets);
  }
  for (const [at, row] of rows.entries()) {
    if (!row.key.startsWith("sessions:request:") || at < from || at >= from + count) {
      continue;
    }
    const targets = { ...found.get(row.key) };
    delete targets["ArrowUp"];
    delete targets["ArrowDown"];
    const parent = turns.findLast((one) => one.at < at);
    if (parent !== undefined && (parent.at < from || parent.at >= from + count)) {
      targets["ArrowLeft"] = parent.one.key;
    }
    found.set(row.key, targets);
  }
  return found;
}

/** One catalog row's path: its entry, then each scope down to its own. */
function catalogPath(key: string): readonly string[] | undefined {
  if (key.startsWith("entry:")) {
    return [key.slice("entry:".length)];
  }
  return key.startsWith("scope:") ? key.slice("scope:".length).split("/") : undefined;
}

/**
 * Which admitted catalog rows have a logical neighbour outside the window.
 *
 * The neighbours are the catalog's own structure, read from the whole ordered
 * list: the next and previous row under the same parent for Down and Up, the
 * first scope beneath for Right, the parent for Left, and the next and previous
 * row in the list for Alt+Down and Alt+Up. Only a neighbour the window does not
 * hold is named; one it holds is mounted, and the tree moves to it itself.
 */
function catalogReveals(
  content: readonly DrawerRow[],
  from: number,
  count: number,
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const keys = content.map((one) => one.described.key);
  const paths = keys.map(catalogPath);
  const shown = (at: number): boolean => at >= from && at < from + count;
  const parentOf = (path: readonly string[]): string => path.slice(0, -1).join("/");
  const found = new Map<string, Readonly<Record<string, string>>>();
  for (let at = from; at < from + count && at < keys.length; at += 1) {
    const path = paths[at];
    if (path === undefined) {
      continue;
    }
    const sibling = (step: -1 | 1): number | undefined => {
      for (let other = at + step; other >= 0 && other < keys.length; other += step) {
        const there = paths[other];
        if (there === undefined || there.length < path.length) {
          return undefined;
        }
        if (there.length === path.length) {
          return parentOf(there) === parentOf(path) ? other : undefined;
        }
      }
      return undefined;
    };
    const child = paths[at + 1]?.length === path.length + 1 ? at + 1 : undefined;
    let parent: number | undefined;
    for (let other = at - 1; other >= 0 && path.length > 1; other -= 1) {
      if (paths[other]?.join("/") === parentOf(path)) {
        parent = other;
        break;
      }
    }
    const targets: Record<string, number | undefined> = {
      ArrowDown: sibling(1),
      ArrowUp: sibling(-1),
      ArrowRight: child,
      ArrowLeft: parent,
      "Alt+ArrowDown": at + 1 < keys.length ? at + 1 : undefined,
      "Alt+ArrowUp": at > 0 ? at - 1 : undefined,
    };
    const reveal: Record<string, string> = {};
    for (const [key, target] of Object.entries(targets)) {
      if (target !== undefined && !shown(target)) {
        reveal[key] = keys[target];
      }
    }
    if (Object.keys(reveal).length > 0) {
      found.set(keys[at], Object.freeze(reveal));
    }
  }
  return found;
}

/**
 * Everything a permission drawer holds inside its window, in order.
 *
 * The kind, the call, whose turn is waiting, every choice the provider offered
 * and what closing does — one ordered whole rather than a fixed head and a
 * scrolling tail, because a reader who has scrolled to the choices no longer
 * needs the line saying which call they are for taking up a row.
 */
function permissionContent(
  model: ReplModel,
  live: ReplLive,
  request: ReplLivePermission,
  width: number,
  focused: string | undefined,
  preview?: readonly ReplFittedLine[],
): readonly Described[] {
  const content: Described[] = [];
  // Only the provider's explanation, never rawInput or the request object.
  if (request.title !== undefined) {
    for (const [offset, part] of messageRows({ message: request.title }, preview).entries()) {
      content.push(
        drawerLine(
          `drawer:permission:message:${offset}`,
          part.text,
          width,
          styleOf("source"),
          part.runs,
        ),
      );
    }
  }
  if (request.kind !== undefined) {
    content.push(
      drawerLine("drawer:permission:kind", `  ${request.kind}`, width, styleOf("field-label")),
    );
  }
  content.push(
    drawerLine(
      "drawer:permission:call",
      `  call ${request.toolCallId}`,
      width,
      styleOf("metadata"),
    ),
  );
  // Whose turn is waiting, so a decision is not made about an anonymous one.
  const waiting = chronology(model, live).find((candidate) => candidate.key === request.turn);
  if (waiting !== undefined) {
    const whose =
      waiting.sessionKey === undefined
        ? headline(waiting.prompt)
        : `${headline(waiting.prompt)} · ${waiting.sessionKey}`;
    content.push(drawerLine("drawer:permission:turn", `  ${whose}`, width, styleOf("metadata")));
  }
  // Every choice the provider offered, in its order, each one its own control.
  for (const choice of request.choices) {
    content.push(
      row(
        `drawer:permission:choice:${choice.optionId}`,
        padControl(`[${choice.name}]${lasting(choice.kind)}`, width),
        { select: "permission-choice", request: request.key, option: choice.optionId },
        styleOf("action"),
        { here: focused },
      ),
    );
  }
  // Said rather than implied: dismissing is a denial of this request, and the
  // session goes on running either way.
  content.push(
    drawerLine(
      "drawer:permission:dismissal",
      "  Escape or close denies this request; the session keeps running.",
      width,
      styleOf("field-hint"),
    ),
  );
  return content;
}

/**
 * How many rows that drawer holds, whatever its window shows.
 *
 * The same builder, asked for its length: what a scroll clamps against is the
 * list it is clamping.
 */
function permissionContentRows(
  model: ReplModel,
  live: ReplLive,
  request: ReplLivePermission,
): number {
  return permissionContent(model, live, request, 0, undefined).length;
}

/**
 * What a lasting choice lasts for.
 *
 * This Agent session, and said so: a person reading "always" in a terminal has
 * every reason to think it means their machine, and nothing here can make a rule
 * that outlives the conversation asking.
 */
function lasting(kind: ReplLiveChoice["kind"]): string {
  return kind === "allow_always" || kind === "reject_always" ? " for this Agent session" : "";
}

/** The first line of a message, for a control that is one row tall. */
/**
 * One drawer's title: what kind of reading it is, and which one.
 *
 * The kind first, because it is the fixed part and the part a reader is looking
 * for — a drawer called `plan` says nothing about whether it holds a binding or
 * an answer. The name is whatever the record carries, so it is elided before the
 * word it belongs to is: losing the end of a long name costs a reader less than
 * losing what they are looking at.
 */
function drawerTitle(kind: string, name: string | undefined, width: number): string {
  if (name === undefined || name.length === 0) {
    return kind;
  }
  return fitLine(
    [{ text: `${kind} · ` }, { text: name, elide: true }],
    width < 1 ? undefined : width,
  );
}

function headline(message: string): string {
  const [first = ""] = message.split("\n");
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function pad(label: string, width: number): string {
  return width < 1 ? label : label.padEnd(width, " ");
}

/** One piece of a row's label, and whether a long one gives up its columns. */
interface ReplLabelPart {
  readonly text: string;
  /**
   * This part is a name nothing in this product bounds.
   *
   * How long a root name, a prompt, a tool call or a provider session key is
   * belongs to whoever wrote it, so these are the parts that shorten when a row
   * cannot hold the whole label. The rest is the row's own vocabulary and stays.
   */
  readonly elide?: true;
  /**
   * This part is the fact the row exists to carry.
   *
   * A row too narrow for its own vocabulary keeps this and loses the rest,
   * never the other way round: a sidebar is thirty-two columns and a turn's
   * state can be twenty-seven of them, so there are rows where the name and the
   * state cannot both be there. Which one a reader can act on is the state.
   */
  readonly keep?: true;
}

/**
 * One row's label, fitted to the room the frame measured for its row.
 *
 * A row's rectangle bounds its box and not its characters: the engine draws the
 * text it is given and clips none of it, so a label wider than its row paints
 * into the column beside it — or onto the row below — while the target map still
 * publishes the row's own bounds. A reader then sees a turn's state somewhere it
 * cannot be pointed at, over a cell belonging to something else.
 *
 * Fitted by part rather than cut at the end, because the end is where a row says
 * what it is *about*: the state a turn is in, the outcome an audit recorded.
 * Cutting there takes the one fact the row exists to carry and keeps the name
 * that pushed it off.
 */
function fitLabel(
  parts: readonly ReplLabelPart[],
  width: number | undefined,
  reserved: number,
): string {
  const whole = parts.map((part) => part.text).join("");
  // Unmeasured. The passes that answer what the widths are describe no windowed
  // row, so a row that reaches a person always has a width; a caller counting
  // rows has none and needs none, because fitting changes no count.
  if (width === undefined || width < 1) {
    return whole;
  }
  const room = width - reserved;
  if (whole.length <= room) {
    return whole;
  }
  const elidable = parts.filter((part) => part.elide === true);
  const bounded = parts.reduce(
    (total, part) => total + (part.elide === true ? 0 : part.text.length),
    0,
  );
  if (elidable.length === 0 || bounded >= room) {
    const kept = parts
      .filter((part) => part.keep === true)
      .map((part) => part.text)
      .join("");
    if (kept === "" || kept.length >= room) {
      // Nothing here is a name, or nothing was named as the fact to keep, or
      // keeping it would take the whole row. The row keeps what it can.
      return whole.slice(0, Math.max(0, room));
    }
    // The row's own vocabulary does not fit. What it named survives whole — a
    // state cut in half is a row saying something untrue — and the names keep
    // what is left in front of it, because two rows that are only their state
    // are two rows a reader cannot tell apart.
    const names = elidable.map((part) => part.text).join(" ");
    return `${elided(names, room - kept.length - 1)} ${kept}`;
  }
  const share = Math.floor((room - bounded) / elidable.length);
  let spare = room - bounded - share * elidable.length;
  const given = new Map<ReplLabelPart, number>();
  for (const part of elidable) {
    const extra = spare > 0 ? 1 : 0;
    spare -= extra;
    given.set(part, share + extra);
  }
  return parts
    .map((part) => (part.elide === true ? elided(part.text, given.get(part) ?? 0) : part.text))
    .join("");
}

/** One name in the columns it was given, with a mark where it was cut. */
function elided(text: string, room: number): string {
  if (text.length <= room) {
    return text;
  }
  return room < 1 ? "" : `${text.slice(0, room - 1)}\u2026`;
}

/** A selectable row's label, fitted to its measured row behind the marker. */
function fitControl(parts: readonly ReplLabelPart[], width: number | undefined): string {
  return fitLabel(parts, width, FOCUS_MARKER);
}

/** A plain line's label, fitted to its measured row. */
function fitLine(parts: readonly ReplLabelPart[], width: number | undefined): string {
  return fitLabel(parts, width, 0);
}

/**
 * Pad one *control's* label so the row it draws is exactly as wide as its box.
 *
 * A control is marked when it holds focus, and the marker is two columns wide, so
 * a label padded to the full width draws two columns past the box it is in. The
 * overflow is clipped, which means the last two columns of the box are never
 * written — and what was behind the drawer there stays on the screen.
 */
function padControl(label: string, width: number): string {
  return pad(label, width - FOCUS_MARKER);
}

/** The two columns `marked()` puts in front of a control's label. */
export const FOCUS_MARKER = 2;

/**
 * Whether this field is required as the form currently stands.
 *
 * The root's own `required`, plus whatever the one conditional adds while its
 * field holds the value it tests for. Presentation only — what actually decides
 * is the compiled schema, which judges the assembled object.
 */
function requiredNow(
  form: ReplQuestionForm,
  values: Readonly<Record<string, string>>,
  field: ReplFormField,
): boolean {
  if (field.required) {
    return true;
  }
  const condition = form.condition;
  if (condition === undefined || values[condition.field] !== condition.equals) {
    return false;
  }
  return condition.requires.some((one) => one.name === field.name);
}

function detailLines(key: string, value: Json, style: ReplRowStyle) {
  return (JSON.stringify(value, undefined, 2) ?? "null").split("\n").map((text, offset) => ({
    key: `${key}:${offset}`,
    text,
    runs: style.role === "field-value" ? jsonRuns(text) : tokenRuns([{ text, token: style.role }]),
  }));
}

export function retainedDetailsOf(view: ReplView) {
  const open = view.selection.drawers.at(-1);
  if (open?.kind === "binding") {
    return detailLines("drawer:value", open.binding.value, styleOf("field-value"));
  }
  if (open?.kind === "recorded-elicit") {
    return [
      ...detailLines("drawer:schema", open.elicitation.schema, styleOf("field-hint")),
      ...detailLines("drawer:answer", open.elicitation.answer, styleOf("field-value")),
    ];
  }
  return [];
}

function detailRows(
  key: string,
  value: Json,
  width: number,
  style: ReplRowStyle,
  prepared: readonly ReplFittedLine[] | undefined,
): readonly DrawerRow[] {
  const rows =
    prepared === undefined
      ? detailLines(key, value, style).map((one) => ({ ...one, indent: 0 }))
      : prepared.filter((one) => one.line.startsWith(`${key}:`));
  return rows.map((one) => ({
    described: drawerLine(
      one.key,
      " ".repeat(one.indent) + one.text,
      width,
      style,
      tokenRuns([{ text: " ".repeat(one.indent), token: style.role }, ...one.runs]),
    ),
  }));
}

/**
 * The rows one notice was fitted onto, keyed by the row it is drawn under.
 *
 * Prepared by the pass that has the drawer's measured interior and the engine
 * to ask about graphemes; consumed here, so row counting, the window's
 * admission, its scroll offsets and the final descriptions are all the same
 * answer rather than four.
 */
export type ReplPreparedNotices = ReadonlyMap<string, readonly string[]>;

/**
 * Say one notice in a drawer, on the rows the frame fitted it onto.
 *
 * A drawer row is one row, so a notice longer than the drawer's interior has
 * to be broken somewhere. It is broken by the engine, at this frame's measured
 * width and on the original graphemes — measured, a 30-cell drawer was given a
 * 72-cell `configuration refused:` notice and drew none of its token, and a
 * row of twelve spaced CJK words measured 48 cells inside 30.
 *
 * Unprepared is the unmeasured pass, which describes no width-dependent text
 * and bounds nothing: the notice stands as the one line it is, exactly as
 * every other row of this module stands when no width has been answered yet.
 */
function noticeRows(
  key: string,
  text: string,
  width: number,
  style: ReplRowStyle,
  notices?: ReplPreparedNotices,
): readonly DrawerRow[] {
  const prepared = notices?.get(key);
  const rows = prepared === undefined ? [`${NOTICE_INDENT}${text}`] : prepared;
  return rows.map((row, offset) => ({
    described: drawerLine(offset === 0 ? key : `${key}:${offset}`, row, width, style),
  }));
}

/** Every nested scope beneath one, with the key path that selects it. */
/** One selectable nested scope: what to call it, and the path that selects it. */
interface NestedScope {
  readonly label: string;
  readonly path: string[];
}

function nested(scope: ReplScope, path: readonly string[]): readonly NestedScope[] {
  const found: NestedScope[] = [];
  for (const child of scope.scopes) {
    const here = [...path, child.key];
    found.push({ label: `${child.kind} ${child.name}`, path: here });
    found.push(...nested(child, here));
  }
  return found;
}

/** One line of a transcript record, and what that line is. */
interface TranscriptLine {
  readonly text: string;
  readonly style: ReplRowStyle;
}

/**
 * One transcript record, as the lines it is drawn in and what each of them is.
 *
 * Decided together, because a root close draws two different things. A root that
 * recorded a result shows that result — the rendered document, which is what a
 * reader came for — and a root that recorded none shows the outcome it closed
 * with instead. One role chosen from the record's kind alone paints a whole
 * rendered document in the accent that belongs to the word `ok`.
 *
 * Read from the typed fields as each line is built, never from the string that
 * came out: a document whose own output contains the word `failed` is still
 * output, and a root that closed `err` is a failure whatever it rendered.
 */
function transcriptLines(entry: ReplRow, width: number): readonly TranscriptLine[] {
  if (entry.kind !== "terminal") {
    return lined(
      describeRow(entry, width),
      entry.kind === "output" ? styleOf("output") : styleOf("metadata"),
    );
  }
  // Three outcomes rather than one "done", and a cancellation is not a failure:
  // it is a reading that stopped.
  const outcome =
    entry.status === "ok"
      ? styleOf("successful-outcome")
      : styleOf(entry.status === "err" ? "failed-outcome" : "waiting");
  const shown =
    entry.output.length > 0
      ? lined(entry.output, styleOf("output"))
      : lined(`closed ${entry.status}`, outcome);
  // Only a failure that recorded a reason, and only for a failure: an `ok`, a
  // cancellation and an entry that never settled have no reason to show, and
  // inventing text for them would describe a failure that did not happen.
  if (entry.status !== "err" || entry.message === undefined) {
    return shown;
  }
  // Its own line, so the outcome and the reason are two rows a window can scroll
  // rather than one row a region has to clip in the middle.
  return [...shown, { text: failedLine(entry.message, width), style: styleOf("failed-outcome") }];
}

/**
 * One string as the rows it is drawn in, each under one role.
 *
 * A cell is a row, so a record holding several lines of text becomes several
 * cells. A cell given more than one line would show only the first, which is the
 * whole of what a reader would then believe was there.
 */
function lined(text: string, style: ReplRowStyle): readonly TranscriptLine[] {
  return text.split("\n").map((one) => ({ text: one, style }));
}

/**
 * One ordinary transcript row, as a line that fits where it will be drawn.
 *
 * A root close is not one of these: what it draws depends on whether it recorded
 * a result, so the two cannot share a single string.
 *
 * The rows naming *where something came from* are bounded here. A path, a
 * component's name and a generated fragment's source are as long as somebody
 * else made them, and this engine clips no text — so a row longer than its pane
 * is drawn over the row beneath it, and the reader loses a line they were given
 * to keep one nobody bounded. The fixed part of each row is kept and the
 * unbounded part gives up its columns first, with the mark that says it was
 * shortened; the whole of it stays in the Journal, which is where something
 * unbounded belongs.
 *
 * What a document and a provider *said* is not bounded here. That text is the
 * thing a reader came for, and shortening it would be this screen editing the
 * content it exists to show.
 */
function describeRow(
  entry: Exclude<ReplRow, { readonly kind: "terminal" }>,
  width: number,
): string {
  const room = width < 1 ? undefined : width;
  switch (entry.kind) {
    case "entry":
      return fitLine([{ text: "entry " }, { text: entry.path, elide: true }], room);
    case "scope":
      return fitLine([{ text: `${entry.scope} ` }, { text: entry.name, elide: true }], room);
    case "binding":
      return `${entry.scope} bound ${entry.names.join(", ")}`;
    case "output":
      return entry.text;
    case "generated":
      // A fragment's source is read as the document it is: the Agent journey
      // reads the branch a program did *not* take off this screen, which only
      // whole source can show. Bounding it to one row is a decision about what
      // this screen owes a reader, not a formatting choice.
      return `generated ${entry.decision}${entry.source === undefined ? "" : `: ${entry.source}`}`;
    case "elicit":
      return `answered ${entry.location} ${summarize(entry.answer)}`;
    case "agent":
      // The status stays whatever the name costs: a row that said which agent
      // and not how it ended would have kept the part nobody bounded and lost
      // the part this row exists to carry.
      return fitLine(
        [
          { text: "agent " },
          { text: entry.turn.agent, elide: true },
          { text: ` ${entry.turn.status}`, keep: true },
        ],
        room,
      );
    case "effect":
      return `${entry.type} ${entry.status}`;
  }
}

/** What a failure row is introduced by, counted because it is part of the row. */
const FAILED_PREFIX = "failed: ";

/**
 * One recorded failure, as a single line that fits where it will be drawn.
 *
 * A message is whatever the thing that failed said, and what failed may be a
 * compiler: the measured ones run to hundreds of characters and embed a whole
 * `data:` URI of the generated module. Two things follow. It is flattened,
 * because every newline in a transcript row becomes another cell and a reason
 * that paid itself out over forty of them would push the footer and every
 * control below the screen. And it is cut to the region, *including* its own
 * introduction — bounding only the message would hand a 76-column row to a
 * 64-column column, where the renderer cuts it again and takes the ellipsis with
 * it, so the row would end mid-word with nothing saying it had been shortened.
 *
 * The whole of it stays in the Journal, which is where something unbounded
 * belongs.
 */
function failedLine(message: string, width: number): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  // A reason that is only whitespace says nothing a reader can act on, and
  // `failed:` with nothing after it reads like the text went missing.
  const said = flattened.length === 0 ? "(no reason recorded)" : flattened;
  const line = `${FAILED_PREFIX}${said}`;
  if (width < 1 || line.length <= width) {
    return line;
  }
  // One column for the mark that says there is more.
  return `${line.slice(0, Math.max(FAILED_PREFIX.length, width - 1))}…`;
}

/** The Sessions reading's window. */
export const SESSIONS_WINDOW = "sessions";

/**
 * The Sidekick chat's own window.
 *
 * Its own, because the panes are open at once: a wide frame carries the
 * Sessions reading in its sidebar and a chat in its inspection pane, and one
 * offset meaning either would move whichever the reducer guessed.
 */
export const SIDEKICK_WINDOW = "sidekick";
/** The Entries catalog's window. */
export const ENTRIES_WINDOW = "entries";
/** The open drawer's content window, whichever reading it is showing. */
export const DRAWER_WINDOW = "drawer";

/**
 * The staged tray's own window, over the messages waiting behind the exchange.
 *
 * Its own, because the conversation above it is a separate reading with a
 * separate offset: one window meaning either would move whichever the frame
 * measured last.
 */
export const QUEUE_WINDOW = "queue";
/** The entry reading's window: output and source together, in the transcript. */
export const READING_WINDOW = "reading";
/** The action row's own structural id, which admission measures against. */
export const ACTION_ROW = "box:footer:actions";
/** The right pane's tab row, which is also that column's header. */
export const TAB_ROW = "box:inspection:tabs";

/**
 * The Sidekick's inset body, by the id the frame measures it under.
 *
 * Named here because two things read it: the box that publishes the inset, and
 * the pass that asks the engine how wide what is inside it came out.
 */
export const SIDEKICK_BODY = "box:inspection:body";

/**
 * The Transcript's inset body, by the id the frame measures it under.
 *
 * Named for the same reason the Sidekick's is: the box that publishes the inset
 * and the pass that asks how wide what is inside it came out are two readers of
 * one id.
 */
export const TRANSCRIPT_BODY = "box:transcript:body";

/** The sidebar's inset body, which its two groups share the width of. */
export const SIDEBAR_BODY = "box:sidebar:body";

/**
 * How wide each region that text must fit is, as the engine measured it.
 *
 * Asked by whoever has to *write* something that must land in one: a row longer
 * than its region is reflowed into rows the layout never allocated, and a
 * sentence shorter than its region leaves the text it covers showing through
 * from where it stops. Measured rather than recomputed, because a second width
 * calculator is a second answer to a question with one.
 */
export interface ReplMeasuredWidths {
  /**
   * The surface carrying content: the transcript column, or the narrow outlet.
   *
   * The pane itself, which is what its heading band spans. The rows beneath that
   * heading are inset from it and use {@link ReplMeasuredWidths.surfaceBody}.
   */
  readonly surface: number;
  /** The column the Sessions reading and the Entries catalog share. */
  readonly list: number;
  /** The bindings and recorded-answer column. */
  readonly inspection: number;
  /**
   * The Transcript's own body, inside its pane's gutter.
   *
   * What the guidance, a refusal's explanation, the retained reading and the
   * controls around it are built to. Narrower than the pane, because a heading
   * says what a column is across its whole width and what a person reads is
   * inset from it. Falls back to the pane where a frame draws no inset body,
   * which is the narrow outlet.
   */
  readonly surfaceBody: number;
  /**
   * The sidebar's own body, inside the same gutter.
   *
   * What the Sessions rows, the Entries catalog and both windows' controls are
   * built to. The two groups are inset identically, so this is one answer for
   * the column rather than one per reading.
   */
  readonly listBody: number;
  /**
   * The Sidekick's own body, inside its pane's gutter.
   *
   * Narrower than the pane it is in, which is why it is measured separately:
   * the header rows span the column while the chat, the composer and the
   * controls below them are inset from it. One answer for all of those, so a
   * fitted row, the count a window admits and a pointer target cannot
   * disagree about how wide the body is.
   */
  readonly body: number;
  /** The drawer's own interior. */
  readonly drawer: number;
  /**
   * The staged queue's text column, between a message's origin and its remove
   * control. Zero where the frame draws no queue.
   */
  readonly queue?: number;
  /** The row the guidance is drawn in, where a frame draws it apart from the work. */
  readonly guidance?: number;
}

/**
 * What one paint has measured and admitted.
 *
 * The same value reaches the description builder and the reducer, so what a
 * scroll clamps against is what the screen is showing.
 */
export interface ReplPresentationContext {
  readonly editors?: ReadonlyMap<string, ReplEditor>;
  /**
   * The region widths this frame measured, or none before it has measured any.
   *
   * The first measurement's whole job is to answer this, and text is what makes
   * that answer unreliable: a column that grows into what is left still takes
   * its minimum from its content, so one unbounded row makes the column wider
   * than its share and squeezes the column beside it. Measured: an unwrapped
   * canonical location made a 92-column transcript report 128 and paint over the
   * inspection column. So the pass that asks describes no width-dependent text
   * at all, and every pass after it has a width to bound that text to.
   */
  readonly widths: ReplMeasuredWidths | undefined;
  readonly admission: ReplAdmission;
  /**
   * Whether this is the pass that asks the engine for geometry.
   *
   * It describes every scrolling viewport empty and offers every candidate
   * action control, so the answer it gets back describes the region rather than
   * whatever is currently overflowing it. Its descriptions are never reconciled.
   */
  readonly measuring: boolean;
  /** Whether the Entries catalog reserves its two window controls. */
  readonly entriesWindowed: boolean;
  /**
   * The catalog's own height when it fits, or none when it is windowed.
   *
   * Carried rather than counted from the rows this pass describes, because the
   * measuring pass describes none: a viewport sized by what the skeleton holds
   * would be a viewport of nothing.
   */
  readonly entriesRows: number | undefined;
  /**
   * Whether the drawer layer takes the engine's pointer off what it covers.
   *
   * Narrowing the engine's own hit test, and nothing more: a pointer is resolved
   * against this frame's detached bounds and containment is the reconciler's, so
   * turning this off must not make a control behind the modal reachable.
   */
  readonly capture: "capture" | "passthrough";
  /**
   * The entry reading this frame prepared, or none before it has prepared one.
   *
   * One immutable list of fitted rows, built once per frame from engine answers
   * and shared by everything downstream: the row count, the window's capacity,
   * the descriptions and the boxes all read it, so a prepared row and a drawn
   * row cannot disagree about what was prepared. The measuring pass has none,
   * which is why it describes none.
   */
  readonly reading: ReplPreparedReading | undefined;
  /**
   * The open question's message, fitted to the drawer's own width.
   *
   * Prepared beside the reading and for the same reason: a drawer row is one
   * row, so a long line of somebody's preview can only be shown whole if it
   * was cut into rows before the window counted them. Scrolling reveals
   * prepared rows; it cannot recover the rest of an unprepared one.
   */
  readonly preview: readonly ReplFittedLine[] | undefined;
  /**
   * The Sidekick's chat, fitted to the width of the pane it is drawn in.
   *
   * Prepared for the same reason the reading and the drawer's preview are: a
   * chat row is one row, so a message with its own line breaks — or one simply
   * wider than the pane — is only readable whole if it was cut into rows before
   * anything counted them. Everything downstream shares this one list, so the
   * rows drawn, the number the window clamps against and the row a Sessions
   * reveal lands on are all the same rows.
   */
  readonly chat: readonly ReplFittedLine[] | undefined;
  /**
   * The rows this frame is drawing of the message's own value, or none.
   *
   * Already cut to the pane's measured width and already windowed to what this
   * screen allows, so the list is exactly the rows to draw and its length is
   * the height they take. A measuring pass carries as many blank rows as it is
   * asking the geometry of: their count is the question, and their text would
   * be text fitted to a width nobody has answered yet.
   *
   * The value itself is untouched. These are display rows: soft wrapping puts
   * no newline into the string Send carries.
   */
  readonly message: readonly string[] | undefined;
  /**
   * The rows this frame is drawing the contextual guidance in, or none.
   *
   * Fitted to the surface it is drawn on, because it is one block of
   * directions rather than one row: the words are the same at every width and
   * the number of rows they need is not. A measuring pass carries one blank
   * row, which is the geometry question it is asking.
   */
  readonly guidance: readonly string[] | undefined;
  /**
   * The rows this frame is drawing a refusal's own explanation in, or none.
   *
   * Word-aware and engine-measured, like every other block of text here. A
   * reason cut at a code unit breaks a word in half for no reason a reader can
   * see, and the reason is the whole of what a refusal has to give.
   */
  readonly refusal: readonly string[] | undefined;
  /**
   * The History band this frame measured, or none before it has measured one.
   *
   * Prepared beside the reading: where a mark lands is a proportion of the
   * rail's measured columns, so the pass that asks how wide the band is
   * cannot already have placed anything on it.
   */
  readonly rail: ReplPreparedRail | undefined;
  /**
   * Where a route drawer goes once the guidance it must clear has been measured.
   *
   * One rectangle, settled by the preparation that measured the fitted guidance
   * block and then read back by everything: the layer's own box, the window its
   * rows are admitted against, the cells it paints and the targets it publishes.
   * Absent in the passes that run before the block has been fitted, which fall
   * back to the rectangle the size alone states — those passes answer widths and
   * counts, and nothing is admitted into a drawer from them.
   */
  readonly drawer: ReplBounds | undefined;
  /**
   * The rows the staged Draft draws of the draft's own value, or none.
   *
   * Fitted to the selected work's measured width and windowed to the newest
   * rows the Draft has room for. The value itself is untouched.
   */
  readonly draft?: readonly string[] | undefined;
  /**
   * The staged queue's messages, fitted to the width their rows measured.
   *
   * A measuring pass carries none, and each message is then one blank row: the
   * count is the geometry question and the text would be fitted to nothing.
   */
  readonly queue?: readonly ReplFittedLine[] | undefined;
  /**
   * How wide the Draft's field is, once its row and its control are measured.
   *
   * Derived from the engine's answers for this exact frame — the heading row's
   * width, the control's own fitted width and the row's declared gap — never
   * from a label's characters. Absent before that measurement, where the field
   * grows and the pass is only answering widths.
   */
  readonly draftField?: number | undefined;
  /**
   * How wide a queued message's text is, once its control has been measured.
   *
   * Derived the way the Draft's field is, and for the same reason: the row
   * holds the text and the control beside it, and a grown remainder is not
   * always whole.
   */
  readonly queueText?: number | undefined;
  /**
   * The staged headers whose two groups do not fit one row, by their own key.
   *
   * Measured by the preparation against the width the engine gave each header,
   * so a header that wraps does so because a row of this frame could not hold
   * it — not because a count of characters said so. Absent before that
   * measurement, which is the pass that has no widths to ask about yet.
   */
  readonly headers?: ReadonlySet<string> | undefined;
  /**
   * Whether this pass exists only to have a queued row measured.
   *
   * One pass asks how wide that row's text and control are, and a different
   * pass asks how many rows the tray can hold. They cannot be the same pass: a
   * scrolling viewport is measured empty, and an empty viewport holds no row
   * to measure. So a probe draws the sequence's first row and admits nothing,
   * and every other pass leaves the overflowing viewport empty until a window
   * says which rows go in it.
   *
   * Two passes set this, and neither admits anything: the one that answers
   * what the widths are, before the queue has been fitted to any of them, and
   * the one that has the engine size the control beside a fitted row.
   */
  readonly queueProbe?: boolean | undefined;
  /**
   * How the non-wide History row divides itself, in whole cells.
   *
   * Measured once per preparation, from the two parts asked on their own, and
   * then stated in every pass that follows — the empty capacity skeleton, the
   * pass anything is admitted from and the committed description alike. A
   * constraint one pass states and another does not is a control measured where
   * it is not drawn.
   */
  readonly historySplit?: { readonly map: number; readonly actions: number } | undefined;
  /**
   * The Transcript selector's own label and the cells the engine gave it.
   *
   * One answer for both, settled once per preparation and stated in every pass
   * after it — the pass that decides whether this header wraps, the pass
   * anything is admitted from and the committed description alike. The label
   * says a conversation's name, which is a provider's session key and so a
   * name nothing in this product bounds, and neither its length in code units
   * nor a guess at a code point's width is how many cells it takes.
   *
   * None before the frame has measured, which is the pass that establishes the
   * room this is fitted to and fits nothing itself.
   */
  readonly selector?: ReplFittedLabel | undefined;
  /**
   * The drawer's notices, each fitted onto the rows this frame's measured
   * interior has room for. None before the frame has measured one.
   */
  readonly notices?: ReplPreparedNotices | undefined;
  readonly details?: readonly ReplFittedLine[] | undefined;
  /**
   * How wide the History row's map is, once its controls have been measured.
   *
   * Derived the way the Draft's field is, and for the same reason: the row
   * holds the map and the controls beside it, and a map longer than its row is
   * squeezed onto a fraction of a cell. Absent on the accepted wide screen,
   * whose row fits its own map.
   */
  readonly historyMap?: number | undefined;
  /**
   * How wide the accepted wide row's gap is, once its map has been measured.
   *
   * Declared so that the controls beside it are the row's one growing child:
   * two growing siblings halve what the map leaves, and half of an odd number
   * of cells is a position the renderer refuses. Absent until that measurement,
   * and absent at every other profile, whose rows are arranged differently.
   */
  readonly historyGap?: number | undefined;
}

/** One reading's descriptions, paired with where the engine places them. */
export interface ReplPresentation {
  readonly descriptions: readonly ReplDescription<ReplAction>[];
  readonly manifest: ReplLayoutManifest;
}

/**
 * Which reading one retained drawer is showing, as its own identity.
 *
 * Not the title and not the position in the stack: two bindings called `name` in
 * different scopes are different readings and must not share a window position,
 * and a drawer reopened over the same reading must find the position it was left
 * at. The live question and a pending permission have their own offsets already,
 * so they have no key here.
 */
/**
 * The key the entry reading's own offset is stored under.
 *
 * The execution, the prefix being read and which entry's reading it is — so
 * selecting an earlier entry finds that entry's own position again rather than
 * wherever the last one was left, and the same entry read at two history
 * positions is two readings of two different files.
 *
 * Process-local, like every other window: nothing durable holds one, so a
 * location opened in another process starts each reading at its first row.
 */
export function entryReadingKeyOf(state: ReplState): string {
  // `scopes[0]` is the selected entry's key, which is the route's own answer to
  // which entry this is — read from the route rather than resolved against a
  // model, because a reducer answering a keystroke has no business reprojecting
  // a prefix to learn which window it is moving.
  const entry = state.route.scopes[0] ?? "execution";
  return `reading:${state.route.execution}:${state.route.at ?? "head"}:${entry}`;
}

export function readingKeyOf(state: ReplState, open: ReplDrawerRef): string | undefined {
  // The prefix being read is part of the identity: the same binding at two
  // history positions is two readings of two different files.
  const at = state.route.at ?? "head";
  const execution = state.route.execution;
  if (open.kind === "history") {
    return `history:${execution}:${at}`;
  }
  if (open.kind === "binding") {
    return `binding:${execution}:${at}:${state.route.scopes.join("/")}:${open.name}`;
  }
  if (open.kind === "recorded-elicit") {
    return `elicit:${execution}:${at}:${open.marker}`;
  }
  return undefined;
}

/**
 * How far the open drawer's window is scrolled.
 *
 * A new reading starts at its first row; a reading being revisited uses its own
 * stored position, which admission then clamps against what this size and this
 * content actually allow.
 */
export function drawerOffsetOf(state: ReplState, open: ReplDrawerRef | undefined): number {
  if (open === undefined) {
    // The catalog's own, and before the Sidekick's two: it takes the screen
    // from them while it is open, so the window being moved is this one. The
    // entries viewport is where opening it put them — `open-catalog` selects
    // the Entries reading and starts it at its first row — and scrolling here
    // moves that same viewport while the overlay is up.
    if (state.catalog) {
      return state.viewports.entries;
    }
    // No route drawer, so one of the Sidekick's own drawers is being read if
    // any is. Its own offset, because each window is its own.
    if (state.configuring.open) {
      return state.viewports.configure;
    }
    return state.asking?.open === true ? state.asking.form.offset : 0;
  }
  if (open.kind === "live-elicit") {
    return state.form.offset;
  }
  if (open.kind === "live-permission") {
    return state.viewports.permission;
  }
  const reading = readingKeyOf(state, open);
  return reading === undefined ? 0 : (state.viewports.readings[reading] ?? 0);
}

/**
 * The most rows the message's own value may take, before a screen reduces it.
 *
 * Six, and the label is not one of them: a name that scrolled away with the
 * text it names would leave somebody typing into an unlabelled box.
 */
export const MESSAGE_VALUE_ROWS = 6;

/**
 * The message's value, as the rows this frame is drawing of it.
 *
 * The newest rows rather than the first, because the end is where somebody is
 * typing: a box that showed the beginning of a long message would scroll the
 * cursor off itself. What is not drawn is still in the value — this is a
 * window on it, not a shortening of it.
 *
 * One blank row where there is nothing yet, so the box a person types into is
 * a place on the screen before it holds anything.
 */
function messageValueRows(context: ReplPresentationContext): readonly string[] {
  const held = context.message;
  if (held === undefined || held.length === 0) {
    return [""];
  }
  return held;
}

/**
 * Which part of the frame one description belongs to.
 *
 * Read from the key the description was built with, which is the one place the
 * region a row belongs to is decided. A row's slot says whether it moves inside
 * a window or stays put around one — the distinction a measured capacity depends
 * on, because the rows that stay put are exactly what the viewport does not get.
 */
type ReplSlot =
  | "located"
  | "navigation"
  | "pane-heading"
  | "sessions-fixed"
  | "sessions"
  | "entries-fixed"
  | "entries"
  | "reading-fixed"
  | "reading"
  | "transcript"
  | "inspection"
  | "drawer-actions"
  | "drawer"
  | "drawer-title"
  | "action"
  | "status"
  | "draft"
  /** The right pane's two tabs, which stay above whatever it is showing. */
  | "inspection-above"
  /** The Sidekick's own input row and its controls, below its chat. */
  | "inspection-below"
  /** The chat window's own two controls, which surround it. */
  /** The staged composition's own rows, placed by key. */
  | "workspace";
/** The tray window's two controls, which surround it rather than move in it. */

function slotOf(key: string): ReplSlot | undefined {
  if (key === "drawer:open") {
    return "drawer-title";
  }
  if (key === "drawer:close" || key === "drawer:sidekick:stop" || key === "drawer:form:submit") {
    return "drawer-actions";
  }
  if (key.startsWith("drawer:")) {
    return "drawer";
  }
  if (key === "footer:input") {
    return "draft";
  }
  // Status, so it follows every control: a row too narrow for both keeps the way
  // out and loses the sentence, never the other way round. `footer:asked` is a
  // control as well as a status, which is why it is here rather than ahead of
  // them — the drawer it opens is also reachable by Tab.
  if (key === "footer:refused" || key === "footer:asked") {
    return "status";
  }
  if (key.startsWith("footer:")) {
    return "action";
  }
  if (key === "sessions:heading" || key === "entries:heading" || key === "surface:sidekick") {
    return "navigation";
  }
  if (key === "transcript:heading") {
    return "pane-heading";
  }
  // The empty placeholder and both window controls stay put around the window
  // rather than inside it, so a measured viewport is the moving part alone.
  if (key === "sessions:empty") {
    return "sessions-fixed";
  }
  if (key.startsWith("sessions:")) {
    return "sessions";
  }
  if (key === "entry:none") {
    return "entries-fixed";
  }
  if (key.startsWith("entries:") || key.startsWith("entry:") || key.startsWith("scope:")) {
    return "entries";
  }
  if (key.startsWith("reading:")) {
    return "reading";
  }
  if (key.startsWith("line:")) {
    return "transcript";
  }
  if (key.startsWith("tab:")) {
    return "inspection-above";
  }
  if (
    key === "sidekick:message" ||
    key.startsWith("sidekick:message:value:") ||
    key === "sidekick:send" ||
    key === "sidekick:stop" ||
    key === "sidekick:back" ||
    key === "sidekick:working" ||
    key === "sidekick:configure" ||
    key === "sidekick:asking" ||
    key === "sidekick:answer"
  ) {
    return "inspection-below";
  }
  if (key.startsWith("binding:") || key.startsWith("elicit:") || key.startsWith("sidekick:")) {
    return "inspection";
  }
  if (key === "guidance" || key.startsWith("guidance:row:")) {
    return "located";
  }

  if (
    key === "transcript:title" ||
    key === "transcript:selector" ||
    key === "work:crumbs" ||
    key.startsWith("work:crumb:") ||
    key === "work:state" ||
    key === "draft:stop" ||
    key === "draft:send" ||
    key === "follow" ||
    key.startsWith("draft:value:") ||
    key.startsWith("tray:") ||
    key.startsWith("queue:")
  ) {
    return "workspace";
  }
  // Above the surface, where there is a row's full width for a sentence. On the
  // action row it would be one truncated line beside the control.
  if (key === "refusal" || key.startsWith("refusal:")) {
    return "located";
  }
  return undefined;
}

/** One classified candidate: what it is, and what measurement would draw. */
interface ReplCandidate {
  readonly key: string;
  readonly slot: ReplSlot;
  readonly text: string;
  readonly control: boolean;
  readonly style: ReplRowStyle;
  readonly runs: readonly ReplTokenRun[] | undefined;
}

/**
 * Every described row, classified, in the order it was described.
 *
 * Walked rather than read off the committed frame, because measurement happens
 * before anything is mounted: the pass that asks how many rows a region holds
 * cannot consult a tree that does not yet have them.
 */
function candidatesOf(
  descriptions: readonly ReplDescription<ReplAction>[],
  /**
   * What each described row meant, by the key it was described under.
   *
   * The walk below reads the finished descriptions, which no longer carry the
   * facts a role comes from — so the style is carried alongside rather than
   * recovered. A key the screen did not describe has no entry and reads as
   * ordinary prose.
   */
  styles: ReadonlyMap<string, ReplRowStyle>,
  /**
   * What each described row's characters are, by the key it was described under.
   *
   * Carried for the same reason the style is: the finished descriptions no
   * longer hold the pieces a row was built from, and a pass that recovered them
   * from the string would be classifying text it had already lost the facts for.
   */
  runs: ReadonlyMap<string, readonly ReplTokenRun[]>,
  /**
   * The keys this frame described inside the catalog drawer, where it drew one.
   *
   * The catalog shows the same rows the permanent Entries column shows, under
   * the same keys, so that an entry is one identity however a reader reached
   * it. Where the key cannot say which region a row landed in, the composition
   * says — and it says it here rather than by renaming the rows, because a row
   * renamed for the overlay would be a second identity for the same entry.
   */
  catalogRows?: ReadonlySet<string> | undefined,
): readonly ReplCandidate[] {
  const found: ReplCandidate[] = [];
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    const slot =
      fields(read.input)?.["covered"] === true ||
      (read.component === READING && fields(read.input)?.["label"] === "")
        ? undefined
        : catalogRows?.has(read.key) === true
          ? "drawer"
          : slotOf(read.key);
    if (slot !== undefined) {
      found.push({
        key: read.key,
        slot,
        text: measurementTextOf(read.component, read.input),
        control: isControl(read.component, read.input),
        style: styles.get(read.key) ?? ORDINARY,
        runs: runs.get(read.key),
      });
    }
    for (const child of read.children) {
      walk(child);
    }
  };
  for (const description of descriptions) {
    walk(description);
  }
  return found;
}

/**
 * What one row would draw, for the pass that has no mounted node to ask.
 *
 * The same pure formatting the mounted component uses, so a control measured
 * without its focus prefix cannot come out two columns narrower than the one
 * drawn in its place.
 */
function measurementTextOf(component: ReplComponent<ReplAction>, input: ReplViewData): string {
  const named = fields(input);
  const focused = named?.["focused"] === true;
  if (component === FIELD) {
    const shown = named?.["shown"];
    if (typeof shown === "string") {
      return shown;
    }
    const prompt = typeof named?.["prompt"] === "string" ? named["prompt"] : "";
    const text = typeof named?.["text"] === "string" ? named["text"] : "";
    return fieldText(prompt, text, focused);
  }
  const label = typeof named?.["label"] === "string" ? named["label"] : "";
  if (component === SELECT_ROW) {
    return focusPrefixed(label, focused);
  }
  return label;
}

/**
 * Whether one row is a control.
 *
 * Read from what the row *is* — the component it was described with — rather
 * than from how its key happens to be spelled. A turn's own facts, a retained
 * audit, the location somebody copies and the reason the last action changed
 * nothing are lines, and a line has nothing to activate; every control answers
 * Enter, so a pointer on one asks for exactly what Enter there asks for.
 *
 * Spelling could never have decided this. A conversation key carries a provider
 * session key and a field key carries a field name, so a conversation called
 * `text` or a field called `stop` would have lost its pointer to a rule about
 * suffixes — and a row that draws a control and refuses the pointer is a control
 * that is not one.
 */
function isControl(component: ReplComponent<ReplAction>, input: ReplViewData): boolean {
  if (component === SELECT_ROW || component === FIELD) {
    return true;
  }
  // A refusal is a control only when it offers somewhere to go back to.
  return component === REFUSAL && fields(input)?.["back"] !== undefined;
}

/**
 * One stacked row box, keyed by the description whose node draws it.
 *
 * As wide as the region it lands in, which the frame measured. A row that left
 * its width to the flow would take it from its own text instead, and a row
 * wider than its column both widens that column and publishes a hit box
 * reaching into the next one.
 *
 * `surface` is for the rows that are a pane's header chrome rather than part of
 * its reading. It paints the measured width and changes no geometry of its own:
 * the fill is the row's own background rather than a box around it. What the
 * header does cost is one row for its edge, which belongs to the band these rows
 * sit in and is measured there.
 */
function drawerActions(candidates: readonly ReplCandidate[]): ReplBox {
  return box({
    id: "box:drawer:actions",
    region: "drawer",
    props: inlineActionRowProps(),
    children: candidates.map((candidate) =>
      box({
        id: `box:drawer:${candidate.key}`,
        key: candidate.key,
        region: "drawer",
        props: CONTROL_PROPS,
        text: candidate.text,
        control: candidate.control,
        style: candidate.style,
        runs: candidate.runs,
      }),
    ),
  });
}

function rowBox(
  candidate: ReplCandidate,
  region: ReplRegion,
  width: number | undefined,
  surface?: number,
): ReplBox {
  return box({
    id: `box:${region}:${candidate.key}`,
    key: candidate.key,
    region,
    props: surface === undefined ? rowProps(width) : headerRowProps(width, surface),
    text: candidate.text,
    control: candidate.control,
    style: candidate.style,
    runs: candidate.runs,
  });
}

function editorDescription(
  description: ReplDescription<ReplAction>,
  context: ReplPresentationContext,
): ReplDescription<ReplAction> {
  if (context.editors === undefined) {
    return description;
  }
  const read = readDescription(description);
  const editor = context.editors.get(read.key);
  const input = fields(read.input);
  const prompt = input?.["prompt"];
  const focused = input?.["focused"] === true;
  const shown =
    editor === undefined || typeof prompt !== "string" || input?.["block"] === true
      ? undefined
      : fieldLabel(prompt, focused) + editor.display[editor.active].text;
  return describeNode<ReplAction>({
    key: read.key,
    component: read.component,
    input:
      editor === undefined
        ? read.input
        : {
            ...input,
            caret: editor.caret.offset,
            caretRows: editor.rows
              .slice(Math.max(0, editor.active - 1), editor.active + 2)
              .map((row) => ({ stops: row.stops.map((stop) => ({ ...stop })) })),
            ...(shown === undefined ? {} : { shown }),
          },
    layout: read.layout,
    children: read.children.map((child) => editorDescription(child, context)),
    ...(read.modal ? { modal: true } : {}),
    ...(read.focus ? { focus: true } : {}),
  });
}

function editorRuns(
  description: ReplDescription<ReplAction>,
  context: ReplPresentationContext,
): readonly ReplTokenRun[] | undefined {
  const read = readDescription(description);
  const input = fields(read.input);
  const editor = context.editors?.get(read.key);
  const prompt = input?.["prompt"];
  if (editor !== undefined && typeof prompt === "string" && input?.["block"] !== true) {
    const focused = input?.["focused"] === true;
    const own = editor.display[editor.active];
    const role = input?.["purpose"] === "draft" ? "draft" : "field-value";
    return tokenRuns([
      { text: fieldLabel(prompt, focused).slice(0, 1), token: focused ? "focus-marker" : role },
      { text: fieldLabel(prompt, focused).slice(1), token: role },
      ...own.runs,
    ]);
  }
  for (const [prefix, key, count] of [
    ["draft:value:", "footer:input", context.draft?.length ?? 0],
    ["sidekick:message:value:", "sidekick:message", context.message?.length ?? 0],
  ] satisfies readonly (readonly [string, string, number])[]) {
    if (!read.key.startsWith(prefix)) {
      continue;
    }
    const editor = context.editors?.get(key);
    if (editor === undefined) {
      return undefined;
    }
    const at = Number(read.key.slice(prefix.length));
    const from = Math.max(0, Math.min(editor.active, editor.display.length - count));
    const own = editor.display[from + at];
    return own?.runs;
  }
  return undefined;
}

/**
 * One reading's descriptions and the constraints that place them.
 *
 * Built from one walk, so a drawn element and a mounted node cannot drift apart.
 * The measuring pass and the committed pass call this with the same view and
 * differ only in what they were told was admitted — which is what makes the
 * measured region and the region drawn into it the same region.
 */
export function presentationFor(
  view: ReplView,
  context: ReplPresentationContext,
): ReplPresentation {
  const screen = described(view, context);
  const chat =
    profileFor(view.size) !== "too-small" &&
    view.refusal === undefined &&
    showingSidekick(view) &&
    view.live.sidekick !== undefined &&
    presentedAsking(view) === undefined;
  const active = profileFor(view.size) !== "too-small" && view.refusal === undefined;
  const narrow = profileFor(view.size) === "narrow";
  const work =
    active && (!narrow || (view.state.route.surface === "entries" && !showingSidekick(view)));
  const composed: ReplDescription<ReplAction>[] = [];
  const owners = [
    ...(work ? [{ slot: "reading", window: READING_WINDOW }] : []),
    ...(active && (!narrow || (view.state.route.surface === "sessions" && !showingSidekick(view)))
      ? [{ slot: "sessions", window: SESSIONS_WINDOW }]
      : []),
    ...(work && staged(view) === undefined ? [{ slot: "entries", window: ENTRIES_WINDOW }] : []),
    ...(chat ? [{ slot: "inspection", window: SIDEKICK_WINDOW }] : []),
  ];
  const grouped = new Set(owners.map((one) => one.slot));
  for (const item of screen.items) {
    if (!grouped.has(slotOf(item.key) ?? "")) {
      composed.push(editorDescription(item.description, context));
    }
  }
  for (const owner of owners) {
    composed.push(
      describeNode<ReplAction>({
        key: `viewport:${owner.window}`,
        component: VIEWPORT,
        input: { window: owner.window },
        children: screen.items
          .filter((one) => slotOf(one.key) === owner.slot)
          .map((one) => editorDescription(one.description, context)),
      }),
    );
  }
  // Placed only where the tree will hold them: a measuring pass mounts nothing.
  const placedDescriptions = context.measuring
    ? composed
    : placeScreen(composed, { narrow: profileFor(view.size) === "narrow" }, (one) => {
        const read = readDescription(one);
        return read.component === READING || isControl(read.component, read.input);
      });
  const requested = view.state.restore?.kind === "reveal" ? view.state.restore.key : undefined;
  const containsRequest = (items: readonly ReplDescription<ReplAction>[]): boolean =>
    items.some((one) => {
      const read = readDescription(one);
      return read.key === requested || containsRequest(read.children);
    });
  const requestedDescription = (one: ReplDescription<ReplAction>): ReplDescription<ReplAction> => {
    const read = readDescription(one);
    return describeNode<ReplAction>({
      key: read.key,
      component: read.component,
      input: read.input,
      layout: read.layout,
      children: read.children.map(requestedDescription),
      ...(read.modal ? { modal: true } : {}),
      ...(read.key === requested ? { focus: true } : {}),
      ...(read.navigation === undefined ? {} : { navigation: read.navigation }),
    });
  };
  const descriptions =
    requested !== undefined && containsRequest(placedDescriptions)
      ? placedDescriptions.map(requestedDescription)
      : placedDescriptions;
  const styles = new Map<string, ReplRowStyle>();
  const runs = new Map<string, readonly ReplTokenRun[]>();
  for (const one of screen.rows) {
    styles.set(one.key, one.style);
    const edited = editorRuns(one.description, context);
    if (edited !== undefined || one.runs !== undefined) {
      runs.set(one.key, edited ?? one.runs ?? []);
    }
  }
  const size = view.size;
  const profile = profileFor(size);
  // The band the frame measured. The pass that asks how wide it is has none,
  // and describes none: a rail placed against a width still being asked for
  // would be a rail placed on nothing.
  const rail = context.rail;
  if (profile === "too-small") {
    // No cell beyond the sentence, so nothing this frame hides can be pointed
    // at: a control that is not in the frame is not in its target map either.
    return {
      descriptions,
      manifest: Object.freeze({
        profile,
        size: Object.freeze({ ...size }),
        root: box({
          id: "box:root",
          props: rootProps(size),
          children: [
            box({
              id: "box:refusal",
              // No key, because there is no row: below the minimum this is a
              // *layout* refusal, and the sentence is the frame's own rather
              // than something a described node contributed. A view-level
              // refusal at a drawable size is an ordinary row and goes with the
              // rest of them, above the surface.
              region: "refusal",
              props: refusalProps(),
              text: refusalText(size),
            }),
          ],
        }),
        viewports: Object.freeze([]),
        actions: undefined,
        regions: Object.freeze([Object.freeze({ region: "refusal", id: "box:refusal" })]),
        contents: Object.freeze([]),
        history: rail ?? EMPTY_BAND,
      }),
    };
  }

  // Which keys this frame described *inside* the catalog drawer. The catalog
  // reuses the permanent column's rows so that an entry is the same row with
  // the same identity wherever it is read from — which means the key alone no
  // longer says where it lands. While the catalog is open those same nodes
  // belong to the drawer's window, and the permanent column they would
  // otherwise classify into is a region this screen does not draw.
  const catalogRows = presentedCatalog(view)
    ? new Set(
        entryContent(view.model, view.focused, view.selection.entry?.key, undefined).map(
          (one) => one.key,
        ),
      )
    : undefined;
  const candidates = candidatesOf(descriptions, styles, runs, catalogRows);
  const viewports: ReplViewportSlot[] = [];
  const regions: { region: ReplRegion; id: string }[] = [];
  /** The border-free inside of each pane that has edges. */
  const contents: { region: ReplRegion; id: string; kind: "pane" | "body" }[] = [];
  /**
   * How wide one region is, as this frame measured it.
   *
   * The footer is the exception and needs no measurement: it is a growing child
   * of a root fixed at the terminal's own size, so it is the terminal wide.
   */
  const widthOfRegion = (region: ReplRegion): number | undefined => {
    if (region === "footer") {
      return size.columns;
    }
    if (region === "drawer") {
      return context.widths?.drawer;
    }
    if (region === "inspection") {
      return context.widths?.inspection;
    }
    if (region === "transcript") {
      return context.widths?.surface;
    }
    // The sidebar and the narrow outlet both carry the two list readings.
    return context.widths?.list;
  };
  /**
   * How wide a row *under* a heading may be, which is the inset body.
   *
   * Two answers per column and not one: a heading band says what the column is
   * across its whole width, and everything a person reads in it is inset two
   * cells on each side. A row built to the pane would be four cells too wide
   * and would publish a hit box reaching into the gutter it is meant to leave
   * blank. The narrow outlet draws no inset body and answers with its own
   * width, which is what leaves its rows where they have always been.
   */
  const bodyWidthOfRegion = (region: ReplRegion): number | undefined => {
    if (region === "transcript") {
      return context.widths?.surfaceBody;
    }
    if (region === "sidebar") {
      return context.widths?.listBody;
    }
    return widthOfRegion(region);
  };
  const of = (slot: ReplSlot): readonly ReplCandidate[] =>
    candidates.filter((candidate) => candidate.slot === slot);

  /** One list region: the rows that stay put, and the window they surround. */
  const listColumn = (
    region: ReplRegion,
    fixedSlot: ReplSlot,
    rowSlot: ReplSlot,
    window: string,
    rows?: number,
    /**
     * How wide a row in this window may be, where the region alone cannot say.
     *
     * The staged narrow outlet is one region for all three readings, and each
     * of them publishes its own inset body — so the room is that body's, not
     * the outlet's. Absent everywhere else, which keeps every other column
     * reading exactly the width it always did.
     */
    room?: number,
  ): readonly ReplBox[] => {
    const fixed = of(fixedSlot);
    const id = `box:${window}:viewport`;
    const inside = room ?? bodyWidthOfRegion(region);
    viewports.push(Object.freeze({ id, region, window, owner: `viewport:${window}` }));
    return [
      ...fixed.map((candidate) => rowBox(candidate, region, inside)),
      box({
        id,
        region,
        props: viewportProps(rows),
        children: of(rowSlot).map((candidate) => rowBox(candidate, region, inside)),
      }),
    ];
  };

  /**
   * The Sidekick's chat, as a window with its controls around it.
   *
   * Registered only while the Sidekick is the pane being drawn, because the
   * slot it windows is the pane's body and the other reading in it — Bindings —
   * has no offset of its own and must not acquire one. A form covering the
   * pane describes no body either, so there is nothing to window then.
   */
  /**
   * How wide the Sidekick's own body is, which is its pane less the gutter.
   *
   * Every row inside the inset reads this instead of the pane's width: the
   * fitted text, the window's own count and a published hit box all have to
   * agree about the room, and the engine measured it once.
   */
  const bodyWidth = (): number | undefined => context.widths?.body;
  const chatColumn = (region: ReplRegion): readonly ReplBox[] => {
    const rows = of("inspection").map((candidate) => rowBox(candidate, region, bodyWidth()));
    const id = "box:inspection:viewport";
    const windowed =
      showingSidekick(view) &&
      presentedAsking(view) === undefined &&
      view.refusal === undefined &&
      view.live.sidekick !== undefined;
    if (!windowed) {
      return [box({ id, region, props: viewportProps(), children: rows })];
    }
    viewports.push(
      Object.freeze({ id, region, window: SIDEKICK_WINDOW, owner: "viewport:sidekick" }),
    );
    return [box({ id, region, props: viewportProps(), children: rows })];
  };

  const located = of("located").map((candidate) => {
    const region = profile === "narrow" ? "content" : "transcript";
    return rowBox(candidate, region, bodyWidthOfRegion(region));
  });
  const heading = (key: string, region: ReplRegion): readonly ReplBox[] => {
    const found = of("navigation").filter((candidate) => candidate.key === key);
    return found.map((candidate) => rowBox(candidate, region, widthOfRegion(region)));
  };
  /**
   * One pane's own title, where there is a pane to put it in.
   *
   * Inset by the same gutter the body under it has, so the column's name lines
   * up with what it names. The band around it keeps the whole inner width: it
   * draws the header surface and the rule that closes it, and only the row
   * holding the text moves. The row is built to the inset width because that is
   * the box it is in — a row built to the pane would overflow the gutter it was
   * just given.
   */
  const paneTitle = (key: string, region: ReplRegion, surface: number): readonly ReplBox[] => {
    const found = of("pane-heading").filter((candidate) => candidate.key === key);
    if (found.length === 0) {
      return [];
    }
    return [
      box({
        id: `box:${region}:title`,
        region,
        props: headerTitleProps(surface),
        children: found.map((candidate) =>
          rowBox(candidate, region, bodyWidthOfRegion(region), surface),
        ),
      }),
    ];
  };
  /**
   * The right pane's two tabs, in the one row that is also its heading.
   *
   * Side by side rather than stacked, each as wide as its own name, so the
   * column says what it holds in one row and a pointer aimed at a name lands on
   * the tab that bears it. They keep the ids and keys they had when they were
   * rows of their own: the arrangement changed and the controls did not.
   *
   * Nothing where there are no tabs to put in it — a narrow frame describes
   * none, and an empty row would buy that frame a header band it has no heading
   * for.
   */
  const tabRow = (region: ReplRegion, surface: number): readonly ReplBox[] => {
    const tabs = of("inspection-above");
    if (tabs.length === 0) {
      return [];
    }
    return [
      box({
        id: TAB_ROW,
        region,
        props: tabRowProps(surface),
        children: tabs.map((candidate) =>
          box({
            id: `box:${region}:${candidate.key}`,
            key: candidate.key,
            region,
            props: tabProps(surface),
            text: candidate.text,
            control: candidate.control,
            style: candidate.style,
            runs: candidate.runs,
          }),
        ),
      }),
    ];
  };
  /**
   * One column's body, in the gutter that insets it from the pane.
   *
   * Everything under a column's heading: the Sidekick's chat and composer, the
   * Transcript's directions and retained reading, the sidebar's two lists and
   * every window control around them. Published as a content box of its own, so
   * the pass that asks how wide a row in it may be asks the engine about this
   * box rather than about the pane the heading spans.
   *
   * The gutter outside and the room inside, as two boxes — the same division a
   * bordered pane already makes. A measured bound is the only honest answer to
   * how much room the padding left, and reading the padded box's own bounds
   * would answer with the padding still in it.
   */
  const insetBody = (region: ReplRegion, id: string, children: readonly ReplBox[]): ReplBox => {
    contents.push({ region, id, kind: "body" });
    return box({
      id: `${id}:gutter`,
      region,
      props: insetBodyProps(),
      children: [box({ id, region, props: paneContentProps(), children })],
    });
  };
  /**
   * The Sidekick's body, where the Sidekick is the reading being shown.
   *
   * The inset belongs to that reading alone. A binding is a line of source, and
   * indenting it to match a conversation would narrow the thing it quotes by
   * four cells without saying so — so Bindings shares the pane and keeps the
   * body it has always had. That frame publishes no inset body for this column
   * at all, which is what makes the measured body width fall back to the pane
   * the rows actually have.
   */
  const sidekickBody = (region: ReplRegion, children: readonly ReplBox[]): ReplBox => {
    if (!showingSidekick(view)) {
      return box({ id: "box:inspection:reading", region, props: paneContentProps(), children });
    }
    return insetBody(region, SIDEKICK_BODY, children);
  };

  /**
   * One pane's header rows, in the band whose edge closes them.
   *
   * The band is what draws the accepted edge, and it draws nothing when there
   * are no header rows to close — a narrow frame names no pane, so it has no
   * header and buys no rule.
   */
  const headerBand = (
    region: ReplRegion,
    surface: number,
    rows: readonly ReplBox[],
  ): readonly ReplBox[] => {
    if (rows.length === 0) {
      return [];
    }
    return [
      box({
        id: `box:${region}:header`,
        region,
        // The asked-for space above this column's heading, owned by the band so
        // it is painted with the header's own surface: the gap is the top of
        // the band rather than a strip of the reading pushed down. Every row
        // below it keeps the position it had — the band grew by the row the
        // column's content gave up.
        props: headerBandProps(rows.length, surface, COLUMN_TOP_GAP),
        children: rows,
      }),
    ];
  };
  /**
   * One pane with edges, and the border-free box its rows are measured in.
   *
   * The column keeps the width the product gives it; the inside is whatever the
   * engine leaves after the edges, and that inside is what `widthsOf` reads.
   */
  const edgedColumn = (
    region: ReplRegion,
    width: number | undefined,
    surface: number,
    children: readonly ReplBox[],
  ): ReplBox => {
    const id = `box:${region}:content`;
    contents.push({ region, id, kind: "pane" });
    return box({
      id: `box:${region}`,
      region,
      props: paneColumnProps(width, surface),
      // No gap here: a column with a header band has that band own it, so the
      // blank row is painted with the header's surface rather than the body's.
      children: [box({ id, region, props: paneContentProps(), children })],
    });
  };

  const workspace = staged(view);
  if (workspace !== undefined) {
    return workspacePresentation({
      view,
      context,
      descriptions,
      candidates,
      rail,
      listColumn,
      chatColumn,
      viewports,
      regions,
      contents,
    });
  }

  const columns: ReplBox[] = [];
  if (profile === "narrow") {
    // Exactly the routed surface, and nothing else. A narrow screen that stacked
    // every region would be a wide screen with the columns removed: the reader
    // would scroll past three lists to reach the one they asked for, and every
    // row of the other two would still be a target.
    //
    // The Entries surface is the catalog *and* the reading of whichever entry
    // it has selected — the same two things the sidebar and the transcript are
    // at a wider size, stacked because there is one column to put them in. A
    // narrow frame that showed the catalog alone would route a reader to the
    // surface their entry is on and then show them nothing of it.
    //
    // The catalog takes its own height while it fits and its share when it does
    // not, exactly as it does in the sidebar; the reading takes what is left.
    const routed =
      view.state.route.view === "sidekick"
        ? [
            // One outlet, holding the chat and the row its messages are typed
            // into. The reading grows and the input keeps its row, the same
            // division the wide pane makes.
            sidekickBody("content", [
              box({
                id: "box:content:sidekick",
                region: "content",
                props: stackProps("grow"),
                children: chatColumn("content"),
              }),
              ...of("inspection-below").map((candidate) =>
                rowBox(candidate, "content", bodyWidth()),
              ),
            ]),
          ]
        : view.state.route.surface === "sessions"
          ? listColumn("content", "sessions-fixed", "sessions", SESSIONS_WINDOW)
          : [
              box({
                id: "box:content:entries",
                region: "content",
                props: stackProps(
                  context.entriesRows === undefined ? sharedColumnRows(size) : "fit",
                ),
                children: listColumn(
                  "content",
                  "entries-fixed",
                  "entries",
                  ENTRIES_WINDOW,
                  context.entriesRows,
                ),
              }),
              box({
                id: "box:content:reading",
                region: "content",
                props: stackProps("grow"),
                children: listColumn("content", "reading-fixed", "reading", READING_WINDOW),
              }),
            ];
    regions.push({ region: "content", id: "box:content" });
    columns.push(
      box({
        id: "box:content",
        region: "content",
        props: columnProps(undefined),
        children: [
          ...located,
          // Which surface to be on belongs to neither surface, so the way out of
          // an outlet cannot be inside it.
          ...heading("sessions:heading", "content"),
          ...heading("entries:heading", "content"),
          ...heading("surface:sidekick", "content"),
          ...routed,
        ],
      }),
    );
  } else {
    regions.push(
      { region: "sidebar", id: "box:sidebar" },
      { region: "transcript", id: "box:transcript" },
      { region: "inspection", id: "box:inspection" },
    );
    columns.push(
      box({
        id: "box:sidebar",
        region: "sidebar",
        // The asked-for space above this column's first heading. The Entries
        // group below is the column's second reading rather than the top of
        // another column, so it takes no second gap.
        props: paneProps(sidebarWidth(size), REPL_PALETTE.sideSurface, COLUMN_TOP_GAP),
        children: [
          // Two groups, and only one of them grows: the Sessions reading takes
          // whatever the column has left, and the catalog states its own height.
          // Two growing siblings would split the remainder in the engine's
          // arithmetic, which is not whole.
          //
          // A sidebar keeps each heading with the list it names, which is where
          // a reader looks for it.
          box({
            id: "box:sidebar:sessions",
            region: "sidebar",
            props: stackProps("grow"),
            children: [
              ...heading("sessions:heading", "sidebar"),
              // The heading spans the column and the list under it is inset,
              // which is the division every other column already makes. This is
              // the box the sidebar's body width is measured from; the Entries
              // group below is inset identically, so one answer serves both.
              insetBody("sidebar", SIDEBAR_BODY, [
                ...listColumn("sidebar", "sessions-fixed", "sessions", SESSIONS_WINDOW),
              ]),
            ],
          }),
          box({
            id: "box:sidebar:entries",
            region: "sidebar",
            // A catalog that fits takes exactly its own length, so a one-entry
            // execution draws one row instead of claiming half a column it does
            // not need. One that does not takes its share and no more, which is
            // what keeps the two readings in this column independent.
            props: stackProps(context.entriesRows === undefined ? sharedColumnRows(size) : "fit"),
            children: [
              ...heading("entries:heading", "sidebar"),
              box({
                id: "box:sidebar:entries:gutter",
                region: "sidebar",
                props: insetBodyProps(),
                children: [
                  box({
                    id: "box:sidebar:entries:body",
                    region: "sidebar",
                    props: paneContentProps(),
                    children: listColumn(
                      "sidebar",
                      "entries-fixed",
                      "entries",
                      ENTRIES_WINDOW,
                      context.entriesRows,
                    ),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      edgedColumn("transcript", undefined, REPL_PALETTE.centreSurface, [
        ...headerBand(
          "transcript",
          REPL_PALETTE.transcriptHeaderSurface,
          paneTitle("transcript:heading", "transcript", REPL_PALETTE.transcriptHeaderSurface),
        ),
        // Everything under that heading, inset: the directions, the retained
        // reading and the two controls that move it. The band above spans the
        // column, because a column says what it is across its full width.
        insetBody("transcript", TRANSCRIPT_BODY, [
          ...located,
          ...listColumn("transcript", "reading-fixed", "reading", READING_WINDOW),
        ]),
      ]),
      edgedColumn("inspection", inspectionWidth(size), REPL_PALETTE.rightSurface, [
        // The tabs are the header band, closed by the same one edge. They stay
        // above whatever the pane is showing and the Sidekick's own input stays
        // below it, so the moving part is the reading alone: the way between the
        // two readings does not scroll away with one of them, and the box a
        // person types into does not either.
        //
        // This column's header chrome is that one row, so it carries the header
        // surface across the measured width: the two names say both what is here
        // and what can be reached, which is why there is no title above them.
        ...headerBand(
          "inspection",
          REPL_PALETTE.inspectionHeaderSurface,
          tabRow("inspection", REPL_PALETTE.inspectionHeaderSurface),
        ),
        sidekickBody("inspection", [
          ...chatColumn("inspection"),
          ...of("inspection-below").map((candidate) =>
            rowBox(candidate, "inspection", bodyWidth()),
          ),
        ]),
      ]),
    );
  }

  // Whichever drawer is presented, through the one calculation both use: the
  // entry's covers the body and the Sidekick's covers the pane that owns its
  // question. Measurement, admission, description, drawing and hit testing all
  // read it from here, so a cell and a target cannot disagree about where it is.
  const rect = presentedRect(view, context);
  const [title] = of("drawer-title");
  if (rect !== undefined && title !== undefined) {
    const id = `box:${DRAWER_WINDOW}:viewport`;
    viewports.push(
      Object.freeze({ id, region: "drawer", window: DRAWER_WINDOW, owner: "viewport:drawer" }),
    );
    regions.push({ region: "drawer", id: "box:drawer:layer" });
    columns.push(
      box({
        id: "box:drawer:layer",
        region: "drawer",
        props: drawerLayerProps(rect, context.capture),
        children: [
          rowBox(title, "drawer", context.widths?.drawer),
          box({
            id,
            region: "drawer",
            props: viewportProps(),
            children: of("drawer").map((candidate) =>
              rowBox(candidate, "drawer", context.widths?.drawer),
            ),
          }),
          drawerActions(of("drawer-actions")),
        ],
      }),
    );
  }

  const offered = [...of("action"), ...of("status")];
  // Every candidate while measuring, so each one's own width is an answer the
  // engine has given; only the admitted prefix once there is one.
  const placed = offered.filter(
    (candidate) => context.measuring || context.admission.actions.has(candidate.key),
  );
  const [draft] = of("draft");
  regions.push({ region: "footer", id: "box:footer" });

  return {
    descriptions,
    manifest: Object.freeze({
      profile,
      size: Object.freeze({ ...size }),
      root: box({
        id: "box:root",
        props: rootProps(size),
        children: [
          box({
            id: "box:body",
            props: bodyProps(profile !== "narrow"),
            children: columns,
          }),
          box({
            id: "box:footer",
            region: "footer",
            props: footerProps(),
            children: [
              box({
                id: ACTION_ROW,
                region: "footer",
                props: actionRowProps(),
                children: placed.map((candidate) =>
                  box({
                    id: `box:action:${candidate.key}`,
                    key: candidate.key,
                    region: "footer",
                    props: CONTROL_PROPS,
                    text: candidate.text,
                    control: candidate.control,
                    style: candidate.style,
                    runs: candidate.runs,
                  }),
                ),
              }),
              box({
                id: "box:footer:band",
                region: "footer",
                props: bandProps(),
                children: bandRowsOf(rail, size.columns).map((row, at) =>
                  box({
                    id: `box:band:${at}`,
                    region: "footer",
                    props: rowProps(size.columns),
                    text: runText(row),
                    runs: row,
                    // The one part of this screen that is not a mounted row, so
                    // its style comes from the band rather than from a candidate.
                    // Each cell carries its own role; this is the row's base.
                    style: styleOf("history", {
                      inspected: view.state.route.at !== undefined,
                    }),
                  }),
                ),
              }),
              ...(draft === undefined ? [] : [rowBox(draft, "footer", size.columns)]),
            ],
          }),
        ],
      }),
      viewports: Object.freeze(viewports),
      actions: Object.freeze({
        id: ACTION_ROW,
        controls: Object.freeze(
          offered.map((candidate) => ({
            key: candidate.key,
            id: `box:action:${candidate.key}`,
            control: candidate.control,
          })),
        ),
      }),
      regions: Object.freeze(regions.map((region) => Object.freeze(region))),
      contents: Object.freeze(contents.map((content) => Object.freeze(content))),
      history: rail ?? EMPTY_BAND,
    }),
  };
}

/**
 * What this frame admits, from what the engine measured.
 *
 * Capacity is the measured viewport, floored and bounded at zero; the row count
 * is the reading's own, counted by the builder that produces those rows. Nothing
 * here subtracts a heading, a control or a footer: that is the arithmetic the
 * measurement replaced.
 */
export function admissionFor(input: {
  readonly view: ReplView;
  readonly manifest: ReplLayoutManifest;
  readonly widths: ReplMeasuredWidths;
  /** The reading this frame fitted, which is what its window admits rows of. */
  readonly reading?: ReplPreparedReading | undefined;
  /** The presented question or permission text, fitted before admission. */
  readonly preview?: readonly ReplFittedLine[] | undefined;
  /** The chat, fitted, which its own window admits rows of. */
  readonly chat?: readonly ReplFittedLine[] | undefined;
  /** The tray's messages, fitted, which its own window admits rows of. */
  readonly queue?: readonly ReplFittedLine[] | undefined;
  /** The drawer's notices, fitted, which its own window admits rows of. */
  readonly notices?: ReplPreparedNotices | undefined;
  readonly details?: readonly ReplFittedLine[] | undefined;
  readonly boundsOf: (id: string) => ReplBounds | undefined;
}): ReplAdmission {
  const { view, manifest, widths, reading, preview, chat, queue, notices, details, boundsOf } =
    input;
  const windows = new Map<string, ReplWindow>();
  for (const slot of manifest.viewports) {
    const capacity = capacityOf(boundsOf(slot.id));
    // The count first, because a window that follows its newest rows needs to
    // know where they end before it can say where it is.
    const total = totalOf(
      view,
      widths,
      reading,
      preview,
      chat,
      queue,
      notices,
      details,
      slot.window,
    );
    const rows =
      slot.window === DRAWER_WINDOW
        ? drawerContent(view, widths.drawer, preview, notices, details)?.content.map(
            (one) => one.described,
          )
        : slot.window === SIDEKICK_WINDOW
          ? sidekickReadingRows(view.live.sidekick, view.focused, chat, chatStagingOf(view))
          : slot.window === SESSIONS_WINDOW
            ? sessionRows(
                view.state,
                chronology(view.model, view.live),
                view.focused,
                undefined,
                widths.listBody,
                view.live.sidekick,
                staged(view) !== undefined,
              )
            : slot.window === ENTRIES_WINDOW
              ? entryContent(view.model, view.focused, view.selection.entry?.key, widths.listBody)
              : undefined;
    const focused = rows?.findIndex((one) => one.key === view.focused) ?? -1;
    windows.set(slot.window, {
      ...admitRows({
        offset: offsetFor(
          view,
          slot.window,
          capacity,
          total,
          chat,
          widths,
          preview,
          notices,
          details,
        ),
        total,
        capacity,
      }),
      ...(focused < 0 ? {} : { focus: { from: focused, to: focused + 1 } }),
    });
  }
  const actions = manifest.actions;
  if (actions === undefined) {
    return Object.freeze({ windows, actions: new Set<string>(), shortened: undefined });
  }
  const row = admitActions({ row: boundsOf(actions.id), controls: actions.controls, boundsOf });
  return Object.freeze({ windows, actions: row.admitted, shortened: row.shortened });
}

/**
 * How many rows the Entries catalog holds, whatever a window shows.
 *
 * Asked by the preparation that decides whether the catalog needs its window
 * controls at all: a catalog shorter than the room it has keeps its natural
 * footprint and takes no row for a control nothing would scroll.
 *
 * An execution that has submitted nothing holds no catalog rows. Its
 * placeholder is a row this column states around the window, like both window
 * controls, so counting it here would size the window for a row that is not
 * inside it — and the measuring pass and the frame would then disagree about
 * the column by exactly one row.
 */
export function entriesRowCount(model: ReplModel): number {
  return entryContent(model, undefined, undefined, undefined).length;
}

/**
 * How far one window is scrolled, with a row this frame requests focus for shown.
 *
 * The offset this process is holding, moved only as far as it takes to put a
 * requested row inside the window: a request naming a row the window does not hold
 * would be focus asked for on behalf of nothing, and an answer given at a narrow
 * size is restored to the entry that owns it — which may be above or below what
 * the catalog is showing. The window itself is the existing one and the offset is
 * the existing process-local one; nothing new scrolls and nothing is added to the
 * frame.
 */
function offsetFor(
  view: ReplView,
  window: string,
  capacity: number,
  total: number,
  chat: readonly ReplFittedLine[] | undefined,
  widths: ReplMeasuredWidths,
  preview: readonly ReplFittedLine[] | undefined,
  notices: ReplPreparedNotices | undefined,
  details: readonly ReplFittedLine[] | undefined,
): number {
  const held = offsetOf(view, window);
  if (window === SIDEKICK_WINDOW) {
    // The turn a Sessions selection asked to be shown, placed against the chat
    // window *this* frame measured. The frame that answered the selection may
    // have had no chat window at all, so this is where the request becomes an
    // offset; a frame that still cannot place it leaves the window alone.
    //
    // It takes precedence over following: somebody who asked to see one turn
    // asked for that turn and not for whatever arrived since.
    const reveal = view.state.revealing;
    if (reveal !== undefined) {
      const at = revealedAt(reveal, view.live.sidekick, capacity, chat, chatStagingOf(view));
      if (at !== undefined) {
        return at;
      }
      return held;
    }
    // The newest end of the list, recomputed from the rows this frame fitted.
    // A chat that is following is asking for wherever the bottom is *now*,
    // which is why no number for it is stored: appending rows would leave a
    // stored one describing the bottom the list had before they arrived.
    if (view.state.viewports.sidekickFollowing[chatRead(view)] ?? true) {
      return Math.max(0, total - capacity);
    }
    return held;
  }
  const requested = view.state.restore;
  if (
    requested?.kind === "reveal" &&
    capacity > 0 &&
    (window === SESSIONS_WINDOW || window === DRAWER_WINDOW)
  ) {
    const rows =
      window === SESSIONS_WINDOW
        ? sessionRows(
            view.state,
            chronology(view.model, view.live),
            undefined,
            undefined,
            widths.listBody,
            view.live.sidekick,
            staged(view) !== undefined,
          )
        : (drawerContent(view, widths.drawer, preview, notices, details)?.content.map(
            (one) => one.described,
          ) ?? []);
    const at = rows.findIndex((one) => one.key === requested.key);
    if (at >= 0) {
      if (
        window === DRAWER_WINDOW &&
        view.selection.drawers.at(-1)?.kind === "live-permission" &&
        !view.focused?.startsWith("drawer:")
      ) {
        return at;
      }
      return Math.min(Math.max(held, at - capacity + 1), at);
    }
  }
  if (window === DRAWER_WINDOW && capacity > 0) {
    const content = drawerContent(view, widths.drawer, preview, notices, details);
    if (content?.entering === true) {
      const at = content.content.findIndex((one) => one.field !== undefined);
      if (at >= 0) {
        return Math.min(Math.max(held, at - capacity + 1), at);
      }
    }
  }
  const catalog = window === ENTRIES_WINDOW || (window === DRAWER_WINDOW && presentedCatalog(view));
  if (!catalog || capacity < 1) {
    return held;
  }
  const claimed = focusClaim(view);
  if (claimed === undefined || !(claimed.startsWith("entry:") || claimed.startsWith("scope:"))) {
    return held;
  }
  const at = entryContent(view.model, undefined, undefined, undefined).findIndex(
    (item) => item.key === claimed,
  );
  if (at < 0) {
    return held;
  }
  // As little as it takes: a claimed row above the window brings it up to that
  // row, one below brings it down until that row is the last one shown, and a row
  // the window already holds moves nothing.
  return Math.min(Math.max(held, at - capacity + 1), at);
}

/**
 * Which chat this frame is reading, as the key its own position is held under.
 *
 * The reading itself rather than the route's selector: the current chat is the
 * absence of a selector, and an absence is not a key. A frame with no Sidekick
 * reads no chat and has no window to position either.
 */
function chatRead(view: ReplView): string {
  return view.live.sidekick?.reading ?? "";
}

/** How far one window is scrolled, as this process is holding it. */
function offsetOf(view: ReplView, window: string): number {
  if (window === QUEUE_WINDOW) {
    return staged(view)?.queueOffset ?? 0;
  }
  if (window === SESSIONS_WINDOW) {
    return view.state.viewports.sessions;
  }
  if (window === SIDEKICK_WINDOW) {
    return view.state.viewports.sidekick[chatRead(view)] ?? 0;
  }
  if (window === READING_WINDOW) {
    return view.state.viewports.readings[entryReadingKeyOf(view.state)] ?? 0;
  }
  if (window === ENTRIES_WINDOW) {
    return view.state.viewports.entries;
  }
  return drawerOffsetOf(view.state, view.state.route.drawers[view.state.route.drawers.length - 1]);
}

/**
 * How many rows one reading holds, counted by whatever builds those rows.
 *
 * The view's own live overlay, which is the one the descriptions were built
 * from: a frozen prefix shows nothing of the present, so counting against the
 * live head would clamp a historical reading against rows it does not have.
 */
function totalOf(
  view: ReplView,
  widths: ReplMeasuredWidths,
  reading: ReplPreparedReading | undefined,
  preview: readonly ReplFittedLine[] | undefined,
  chat: readonly ReplFittedLine[] | undefined,
  queue: readonly ReplFittedLine[] | undefined,
  notices: ReplPreparedNotices | undefined,
  details: readonly ReplFittedLine[] | undefined,
  window: string,
): number {
  if (window === QUEUE_WINDOW) {
    return queue?.length ?? 0;
  }
  if (window === SESSIONS_WINDOW) {
    return sessionContentRows(view.state, view.model, view.live, staged(view) !== undefined);
  }
  if (window === SIDEKICK_WINDOW) {
    // Counted by the builder that produces those rows, so what a scroll clamps
    // against cannot disagree with the list it is clamping — fitted rows
    // included, because a message that occupies three rows is three rows to
    // scroll past.
    return sidekickReadingRows(view.live.sidekick, undefined, chat, chatStagingOf(view)).length;
  }
  if (window === ENTRIES_WINDOW) {
    return entriesRowCount(view.model);
  }
  // The rows the frame actually fitted, not a count of logical lines: a line
  // that wrapped is several rows, and a window admitting the smaller number
  // would stop short of text it is showing the top of.
  if (window === READING_WINDOW) {
    return reading?.rows.length ?? 0;
  }
  // The same prepared rows the drawing pass consumes, so what this window
  // admits and what it draws cannot disagree about how tall a notice is.
  return drawerContent(view, widths?.drawer ?? 0, preview, notices, details)?.content.length ?? 0;
}

/**
 * The four cells a marked row's origin takes.
 *
 * A marked row is composed behind four blanks and the marker is drawn over
 * them, so the text is measured and wrapped at exactly the width it is drawn
 * at, and its continuation rows are set in to the same column as its first.
 */
const MARKER_ROOM = "    ";

/** The two cells in front of a control's label that its focus marker takes. */
const CONTROL_ROOM = "  ";

/** Who one marked row came from: the marker it shows and the colour it takes. */
interface ReplOriginMark {
  readonly text: string;
  readonly role: ReplPresentationRole;
}

const PERSON_MARK: ReplOriginMark = Object.freeze({ text: "[U] ", role: "origin-person" });
const SIDEKICK_MARK: ReplOriginMark = Object.freeze({ text: "[S] ", role: "origin-sidekick" });
const AGENT_MARK: ReplOriginMark = Object.freeze({ text: "[A] ", role: "origin-agent" });
const ATTACHMENT_MARK: ReplOriginMark = Object.freeze({
  text: "[C] ",
  role: "origin-attachment",
});
const WORK_MARK: ReplOriginMark = Object.freeze({ text: "[R] ", role: "origin-repl" });

/** The mark a message's own origin earns: a person here, or an attached client. */
function originMark(origin: MessageOrigin | undefined): ReplOriginMark {
  return origin?.kind === "acp" ? ATTACHMENT_MARK : PERSON_MARK;
}

/** A label whose first four cells are its origin mark, as the runs that draw it. */
function markedRuns(
  mark: ReplOriginMark,
  label: string,
  role: ReplPresentationRole,
): readonly ReplTokenRun[] {
  return tokenRuns([
    { text: mark.text, token: mark.role },
    { text: label.slice(mark.text.length), token: role },
  ]);
}

/** What the staged chat adds to a reading: the work its messages submitted. */
interface ReplChatStaging {
  readonly model: ReplModel;
  readonly live: ReplLive;
  readonly work: readonly ReplAssociatedWork[];
}

function chatStagingOf(view: ReplView): ReplChatStaging | undefined {
  const workspace = staged(view);
  if (workspace === undefined) {
    return undefined;
  }
  return { model: view.model, live: view.live, work: workspace.work };
}

/**
 * What one entry is doing, in one word and the role that colours it.
 *
 * Read from the entry's own retained outcome, and from this process only for the
 * final entry it is running. An entry with no outcome and nothing running it is
 * unfinished, never assumed to be either.
 */
function workState(
  entry: ReplEntry,
  model: ReplModel,
  live: ReplLive,
): { readonly word: string; readonly style: ReplRowStyle } {
  const terminal = entry.terminal;
  if (terminal !== undefined) {
    if (terminal.status === "ok") {
      return { word: "✓ COMPLETED", style: styleOf("successful-outcome") };
    }
    // An interruption reads as its own outcome rather than as a failure: what
    // the entry completed stands and what it printed is partial, which is not
    // what a run going wrong says.
    return terminal.status === "err"
      ? { word: "× FAILED", style: styleOf("failed-outcome") }
      : { word: "- INTERRUPTED", style: styleOf("interrupted-outcome") };
  }
  const last = model.entries[model.entries.length - 1];
  if (live.running && last?.key === entry.key) {
    return { word: "● ACTIVE", style: styleOf("lifecycle-active") };
  }
  return { word: "UNFINISHED", style: styleOf("metadata") };
}

/** The rows of work one Sidekick message submitted, after that message. */
function workComposed(staging: ReplChatStaging, key: string): readonly ReplChatComposed[] {
  const found: ReplChatComposed[] = [];
  for (const one of staging.work) {
    if (`sidekick:${one.message}` !== key) {
      continue;
    }
    const entry = staging.model.entries.find((candidate) => candidate.key === one.entry);
    if (entry === undefined) {
      // An entry this prefix does not hold is not work this reading can show.
      continue;
    }
    const state = workState(entry, staging.model, staging.live);
    found.push(
      Object.freeze({
        kind: "text" as const,
        key: `sidekick:work:${entry.key}`,
        text: `${MARKER_ROOM}Entry ${entry.order} · ${state.word}`,
        style: state.style,
        mark: WORK_MARK,
      }),
    );
    // The record's own final line break ends its last line rather than adding one.
    const recorded = entry.terminal?.output ?? "";
    const output = recorded.endsWith("\n") ? recorded.slice(0, -1) : recorded;
    if (output !== "") {
      found.push(
        Object.freeze({
          kind: "text" as const,
          key: `sidekick:work:${entry.key}:output`,
          text: output
            .split("\n")
            .map((own) => `${MARKER_ROOM}${own}`)
            .join("\n"),
          style: styleOf("output"),
        }),
      );
    }
  }
  return found;
}

/**
 * The staged chat: each message marked with who it came from, and the work a
 * message submitted shown after it as work rather than as something said.
 *
 * Only explicit evaluated Output is the Sidekick's own row. An entry's state and
 * output are read from the model, never from a reply's wording.
 */
function workspaceChatComposed(
  reading: ReplSidekickReading,
  staging: ReplChatStaging,
  /** The key of whatever holds focus, for the one row that wears the marker. */
  focused: string | undefined,
): readonly ReplChatComposed[] {
  const items: ReplChatComposed[] = [];
  const text = (
    key: string,
    said: string,
    style: ReplRowStyle,
    mark: ReplOriginMark,
  ): ReplChatComposed =>
    Object.freeze({
      kind: "text" as const,
      key,
      text: said
        .split("\n")
        .map((own) => `${MARKER_ROOM}${own}`)
        .join("\n"),
      style,
      mark,
    });
  const shownChat = reading.chat.filter((item) => item.conversation === reading.reading);
  if (shownChat.length === 0) {
    items.push(text("sidekick:empty", "No messages yet.", styleOf("metadata"), SIDEKICK_MARK));
  }
  for (const item of shownChat) {
    const key = `sidekick:${item.key}`;
    if (item.kind === "person") {
      items.push(text(key, item.text, styleOf("source"), originMark(item.origin)));
    } else if (item.kind === "preview") {
      // Said as the attempt it is. Nothing has been evaluated, no control has
      // run and no turn is acknowledged, so this is not a reply yet — and a
      // row that differed from one only by its colour would tell a reader
      // nothing they could read. `(unfinished)` below is the other ending.
      items.push(
        text(
          key,
          item.incomplete === true
            ? `${reading.agent} (unfinished): ${item.text}`
            : `${reading.agent} (preview): ${item.text}`,
          item.incomplete === true ? styleOf("failed-outcome") : styleOf("waiting"),
          SIDEKICK_MARK,
        ),
      );
    } else if (item.kind === "saved") {
      items.push(
        text(
          key,
          item.automatic === true ? `Automatic feedback · ${item.text}` : item.text,
          styleOf("metadata"),
          SIDEKICK_MARK,
        ),
      );
    } else if (item.kind === "incomplete" || item.failure !== undefined) {
      // Said the way the preview above it is said, and the way the ordinary
      // pane says it: who answered, how far it got, then the reason. The mark
      // in front already says this row is the Sidekick's, and the name is what
      // says *which* agent answered in this chat — a conversation does not
      // change agent in place, so a row that left it out would make two chats
      // by two agents read identically.
      items.push(
        text(
          key,
          `${reading.agent} (${item.kind === "incomplete" ? "unfinished" : "failed"}): ${
            item.failure ?? "this turn did not complete"
          }`,
          styleOf("failed-outcome"),
          SIDEKICK_MARK,
        ),
      );
      // And the way to ask for the same thing again, which is the one thing a
      // reader can do about an attempt that did not finish. The ordinary pane
      // offers it on the same condition — a request this history can name, in
      // the conversation it is still continuing — and a staged pane that said
      // the turn failed and then offered nothing would be the same reading
      // with its one action taken away.
      if (item.kind === "incomplete" && item.retry !== undefined && reading.current) {
        items.push(
          Object.freeze({
            kind: "control" as const,
            described: row(
              `sidekick:retry:${item.retry.message}`,
              `${MARKER_ROOM}[retry]`,
              {
                select: "retry-message",
                conversation: item.retry.conversation,
                message: item.retry.message,
              },
              styleOf("action"),
              { here: focused },
            ),
          }),
        );
      }
    } else if (item.hasOutput) {
      items.push(text(key, item.text, styleOf("output"), SIDEKICK_MARK));
    }
    items.push(...workComposed(staging, key));
  }
  if (reading.busy) {
    const running = staging.model.entries.find(
      (entry) =>
        staging.work.some((one) => one.entry === entry.key) &&
        workState(entry, staging.model, staging.live).style.role === "lifecycle-active",
    );
    items.push(
      text(
        "sidekick:status",
        running === undefined ? "working" : `○ waiting for Entry ${running.order}`,
        styleOf("waiting"),
        SIDEKICK_MARK,
      ),
    );
  }
  // One blank row between utterances and the work they started, as the
  // reference separates them. Display only: a gap is no message.
  const spaced: ReplChatComposed[] = [];
  for (const [at, one] of items.entries()) {
    const key = one.kind === "text" ? one.key : one.described.key;
    const continues = one.kind === "text" && key.endsWith(":output");
    if (at > 0 && !continues) {
      spaced.push(
        Object.freeze({ kind: "text" as const, key: `${key}:gap`, text: "", style: ORDINARY }),
      );
    }
    spaced.push(one);
  }
  return spaced;
}

/**
 * The staged left column's own headings, and the selected work's.
 *
 * The Transcript names itself and its conversation selector; the selected work
 * names the entry and the scopes being read as breadcrumbs, with the way to the
 * Entries catalog in front of them and the entry's state at the end.
 *
 * The selector is a control, not a caption: activating it shows the
 * conversations this reading actually holds, as the same choices the Sessions
 * surface offers, and activating it again puts them away. The choices
 * themselves are rows of the list it filters, because that is the thing they
 * move — a chooser drawn in the heading band would be a list of controls in a
 * region measured for one row.
 */
function workspaceHeadings(
  view: ReplView,
  /**
   * The Transcript selector's label, as this frame fitted it.
   *
   * Given rather than computed, because fitting it is measurement: the name it
   * says is a provider's session key, and how many cells that takes is an
   * engine answer about graphemes rather than a count of code units. The same
   * answer is given to every pass, so the row that is measured and the row that
   * is drawn are one row.
   *
   * None before the frame has measured — that pass establishes the room this is
   * fitted to, and a label shortened against no room would be shortened for
   * nothing. It then says the whole name, which is the longest this can be and
   * so the honest thing for a pass asking how much room a column wants.
   */
  selector: ReplFittedLabel | undefined,
  /** Which of the two headings this frame has a region for. */
  shown: {
    readonly transcript: boolean;
    readonly work: boolean;
    /** Whether this heading owns the Entries control, or a surface bar does. */
    readonly entries: boolean;
  },
): readonly Described[] {
  const items: Described[] = [];
  if (shown.transcript) {
    items.push(line("transcript:title", "TRANSCRIPT", styleOf("pane-heading")));
    items.push(
      row(
        "transcript:selector",
        // The label this frame fitted, or the whole name where nothing has
        // measured yet. What this says once a conversation has been chosen is
        // that conversation's name, and a provider's session key is a name
        // nothing here bounds — measured, one of them made this control 58
        // cells wide in a 34-cell column, which overflowed the row and left the
        // engine placing it on a fraction of a cell, and a frame placed on
        // fractions is one this product refuses to draw at all. The chevron
        // stays whatever the name costs: a selector that gave up the mark
        // saying it opens is one nobody can tell is one.
        selector?.text ?? `${selectorName(view)}${SELECTOR_MARK}`,
        { select: "session-filter" },
        styleOf("field-label", { selected: view.state.filtering }),
        { here: view.focused },
      ),
    );
  }
  if (!shown.work) {
    return items;
  }
  if (shown.entries) {
    items.push(
      row(
        "entries:heading",
        "Entries",
        // The catalog, over this reading. The staged composition keeps no
        // permanent column for it, so routing to a surface would be routing to
        // a screen with nothing new on it.
        { select: "catalog" },
        styleOf("navigate"),
        { here: view.focused },
      ),
    );
  }
  const entry =
    view.selection.entry === undefined
      ? view.model.entries[view.model.entries.length - 1]
      : view.model.entries.find((one) => one.key === view.selection.entry?.key);
  if (entry === undefined) {
    items.push(line("work:crumbs", "› No entry yet", styleOf("metadata")));
    return items;
  }
  const names = [
    `Entry ${entry.order}`,
    ...view.selection.ancestry.slice(1).map((one) => one.name),
  ];
  const separator = " › ";
  // Each name with the separator that leads to it. The separator is stated once,
  // on the part it leads to, and the single space after it is the one this row
  // already puts between its parts — so the names drawn in order are the one
  // string this row has always said, and nothing of it is spelled twice.
  const spelled = (at: number): { text: string; runs: readonly ReplTokenRun[] } => {
    const last = at === names.length - 1;
    return {
      text: `${separator.trimStart()}${names[at]}`,
      runs: tokenRuns([
        { text: separator.trimStart(), token: "punctuation" },
        { text: names[at], token: last ? "xmd-tag" : "metadata" },
      ]),
    };
  };
  // Every name but the innermost is somewhere to go: the reading is already at
  // the last one, and a control that selected where you are would be a control
  // that does nothing. Each ancestor selects the prefix of the path that ends
  // at it, which is the same scope path the catalog's own rows select — so
  // reaching one from the trail and reaching it from the catalog are the same
  // act, and the route that comes out says so.
  for (let at = 0; at < names.length - 1; at += 1) {
    const part = spelled(at);
    items.push(
      row(
        `work:crumb:${at}`,
        part.text,
        { select: "scope", scopes: view.state.route.scopes.slice(0, at + 1) },
        styleOf("metadata"),
        { here: view.focused, runs: part.runs },
      ),
    );
  }
  const innermost = spelled(names.length - 1);
  items.push(line("work:crumbs", innermost.text, styleOf("metadata"), innermost.runs));
  const state = workState(entry, view.model, view.live);
  items.push(line("work:state", state.word, state.style));
  return items;
}

/**
 * One entry agent turn as the staged Transcript reads it: the request, marked
 * as the agent's, with its state kept whole, then the reply beneath it.
 *
 * The same keys and the same activation the ordinary rows have, so selecting a
 * turn goes where it always did.
 */
function compactTurn(
  turn: ReplSessionTurn,
  width: number | undefined,
  focused: string | undefined,
  claim: string | undefined,
): readonly Described[] {
  const rows: Described[] = [];
  const style = turnStyle(turn);
  const label = fitControl(
    [
      { text: AGENT_MARK.text },
      { text: headline(turn.prompt), elide: true },
      { text: " · " },
      { text: stateOf(turn), keep: true },
    ],
    width,
  );
  rows.push(
    row(
      `sessions:turn:${turn.key}`,
      label,
      turn.marker === undefined
        ? { select: "surface", surface: "sessions" }
        : { select: "marker", marker: turn.marker },
      style,
      { here: focused, claim, runs: markedRuns(AGENT_MARK, label, style.role) },
    ),
  );
  if (turn.text.length > 0) {
    rows.push(
      line(
        `sessions:turn:${turn.key}:text`,
        fitLine(
          [{ text: `${CONTROL_ROOM}${MARKER_ROOM}` }, { text: headline(turn.text), elide: true }],
          width,
        ),
        styleOf("output"),
      ),
    );
  }
  if (turn.stopReason !== undefined) {
    // What the provider said ended this turn, which is its own fact and not the
    // same answer as the state beside the prompt: `completed, recorded` says
    // this process saw the turn through and retained it, and the reason says
    // why the provider stopped producing. The ordinary list states both; a
    // staged one that kept only the first would drop the provider's own word
    // for what happened.
    rows.push(
      line(
        `sessions:turn:${turn.key}:stop`,
        fitLine(
          [
            { text: `${CONTROL_ROOM}${MARKER_ROOM}stopped: ` },
            { text: turn.stopReason, elide: true },
          ],
          width,
        ),
        styleOf("metadata"),
      ),
    );
  }
  if (turn.failure !== undefined) {
    rows.push(
      line(
        `sessions:turn:${turn.key}:failed`,
        fitLine(
          [
            { text: `${CONTROL_ROOM}${MARKER_ROOM}` },
            { text: headline(turn.failure), elide: true },
          ],
          width,
        ),
        styleOf("failed-outcome"),
      ),
    );
  }
  const request = turn.request;
  if (request !== undefined) {
    // Focusable, because this list is where the request is drawn. The ordinary
    // composition makes it a plain fact off the Sessions surface and a control
    // on it — the surface being the one place a permission is answered. This
    // composition has no second surface: the Transcript is the one list, and a
    // request announced here with no way to reach it would be a screen that
    // said somebody was waiting and offered nothing to do about it.
    const asks: readonly ReplLabelPart[] = [
      { text: `${CONTROL_ROOM}${MARKER_ROOM}asks: ` },
      { text: headline(request.title ?? request.toolCallId), elide: true },
    ];
    rows.push(
      row(
        `sessions:request:${request.key}`,
        fitControl(asks, width),
        { select: "permission", request: request.key },
        styleOf("waiting"),
        { here: focused },
      ),
    );
  }
  return rows;
}

/**
 * One Sidekick turn as the staged Transcript reads it: the message, marked with
 * where it came from, then the reply, marked as the Sidekick's.
 *
 * The origin is the saved message's own, found by its conversation and turn; a
 * turn whose message this reading does not hold is marked as a person's, which
 * is what every message without an attachment is.
 */
function compactSidekickTurn(
  turn: ReplSidekickTurnRow,
  sidekick: ReplSidekickReading,
  width: number | undefined,
  focused: string | undefined,
): readonly Described[] {
  const rows: Described[] = [];
  const asked = sidekick.chat.find(
    (item) =>
      item.kind === "person" &&
      item.conversation === turn.conversation &&
      item.turn !== null &&
      item.turn === turn.turn,
  );
  const mark = originMark(asked?.origin);
  const style = turn.running
    ? styleOf("waiting")
    : turn.failed
      ? styleOf("failed-outcome")
      : styleOf("source");
  const label = fitControl(
    [
      { text: mark.text },
      { text: headline(turn.title), elide: true },
      { text: " · " },
      { text: turn.state, keep: true },
    ],
    width,
  );
  rows.push(
    row(
      `sessions:${turn.key}`,
      label,
      {
        select: "sidekick-turn",
        conversation: turn.conversation,
        ...(turn.turn === null ? {} : { turn: turn.turn }),
      },
      style,
      { here: focused, runs: markedRuns(mark, label, style.role) },
    ),
  );
  if (turn.text.length > 0) {
    const said = fitLine(
      [
        { text: `${CONTROL_ROOM}${SIDEKICK_MARK.text}` },
        { text: headline(turn.text), elide: true },
      ],
      width,
    );
    rows.push(
      line(
        `sessions:${turn.key}:text`,
        said,
        styleOf("output"),
        tokenRuns([
          { text: CONTROL_ROOM, token: "output" },
          ...markedRuns(SIDEKICK_MARK, said.slice(CONTROL_ROOM.length), "output"),
        ]),
      ),
    );
  }
  if (turn.failure !== undefined) {
    rows.push(
      line(
        `sessions:${turn.key}:failed`,
        fitLine(
          [
            { text: `${CONTROL_ROOM}${MARKER_ROOM}` },
            { text: headline(turn.failure), elide: true },
          ],
          width,
        ),
        styleOf("failed-outcome"),
      ),
    );
  }
  return rows;
}

/**
 * The staged Sidekick pane's own controls: the tray above the composer, Follow
 * and the Sidekick's Send or Stop beside it, the waiting messages, and the
 * composer itself.
 *
 * TODO, QUEUE, Follow and each message's remove control are mounted controls
 * that ask the root for nothing: their behaviour is the queue contract's (#964)
 * and the shared TODO's (#901), and none of it is wired here. Send and Stop are
 * the Sidekick's own, with the actions they always had.
 */
function workspaceControls(
  state: ReplState,
  reading: ReplSidekickReading | undefined,
  view: ReplView,
  claim: string | undefined,
  context: ReplPresentationContext,
  workspace: ReplWorkspace,
): readonly Described[] {
  const items: Described[] = [];
  if (reading === undefined) {
    return items;
  }
  if (state.route.sidekick !== undefined) {
    items.push(
      row(
        "sidekick:back",
        "[Back to current chat]",
        { select: "sidekick-back" },
        styleOf("action"),
        {
          here: view.focused,
        },
      ),
    );
  }
  if (reading.refusal !== undefined || !reading.current) {
    return items;
  }
  items.push(
    row(
      "sidekick:configure",
      `[configure ${reading.agent}]`,
      {
        select: "configure",
        ...(reading.conversation === undefined ? {} : { conversation: reading.conversation }),
      },
      styleOf("navigate"),
      { here: view.focused, ...(claim === "sidekick:configure" ? { focus: true } : {}) },
    ),
  );
  const question = reading.question;
  if (question !== undefined) {
    items.push(
      row(
        "sidekick:answer",
        "[answer sidekick]",
        { select: "sidekick-question", question: question.key },
        styleOf("waiting"),
        { here: view.focused, ...(claim === "sidekick:answer" ? { focus: true } : {}) },
      ),
    );
  }
  // Only the trays this execution actually offers, and Follow only where it is
  // offered at all. A build without the shared queue draws no QUEUE tab and no
  // Follow checkbox: a control for behaviour that is not here is a choice
  // somebody can make and nothing happens, however it is drawn.
  // A tray's name is a heading while it is the only tray, not a stop: TODO is
  // inactive until the shared TODO ships, and a control that does nothing is a
  // Tab stop somebody has to step past. Indented as a row is, so it reads in
  // the same cells it always has.
  for (const tray of traysOf(workspace)) {
    const here = workspace.tray === tray;
    items.push(
      line(
        `tray:${tray}`,
        focusPrefixed(tray.toUpperCase(), false),
        styleOf(here ? "pane-heading" : "metadata", { selected: here }),
      ),
    );
  }
  if (workspace.follow !== undefined) {
    items.push(
      row("follow", `[${workspace.follow ? "x" : " "}] Follow`, {}, styleOf("action"), {
        here: view.focused,
      }),
    );
  }
  items.push(
    reading.busy
      ? row("sidekick:stop", "[stop]", { select: "stop-sidekick" }, styleOf("failed-outcome"), {
          here: view.focused,
        })
      : row("sidekick:send", "[send]", { select: "send-message" }, styleOf("action"), {
          here: view.focused,
        }),
  );
  if (workspace.tray === "queue" && offersQueue(workspace)) {
    const window = context.admission.windows.get(QUEUE_WINDOW);
    // Rows rather than messages. The window counts fitted rows, so the
    // description selects the same fitted rows: a slice of messages would put
    // more rows in the tray than it measured room for.
    const sequence = queueSequence(workspace, context.queue);
    // Whether this tray holds more rows than its column allocated it, answered
    // from that declared allocation rather than from a window that has already
    // been admitted. An admitted window is the later of the two answers, and
    // the measurement that produces it needs this one — a capacity measured
    // without the controls that will sit around the viewport is the capacity
    // of a region nobody is going to draw.
    const beside = items.filter(
      (one) => one.key === "sidekick:back" || one.key === "sidekick:answer",
    ).length;
    const overflowing = trayAllocation(view, context, beside) !== undefined;
    // Which rows this pass puts in the tray.
    //
    // A tray whose rows fit has no window and no viewport: its rows are its
    // own content, and every pass describes all of them. An overflowing one is
    // measured empty, because a scrolling viewport stretched by its own
    // contents reports the room its contents wanted rather than the room the
    // column gave it — and the window that admits rows into it is derived from
    // that measurement.
    //
    // The width probe is the single exception, and it is not the pass the
    // admission comes from: it draws the sequence's first row so the engine
    // can say how wide that row's control is, which is what every row's text
    // box is then stated from.
    const shownRows = !overflowing
      ? sequence
      : window !== undefined
        ? sequence.slice(window.from, window.from + window.count)
        : context.queueProbe === true
          ? sequence.slice(0, 1)
          : [];
    for (const one of shownRows) {
      const mark = originMark(one.message.origin);
      const marked = one.first && one.text.startsWith(MARKER_ROOM);
      const said = marked ? `${mark.text}${one.text.slice(MARKER_ROOM.length)}` : one.text;
      items.push(
        line(
          `queue:${one.message.key}:row:${one.offset}`,
          said,
          styleOf("queued"),
          marked ? markedRuns(mark, said, "queued") : undefined,
        ),
      );
      // The control belongs to the row its message begins at and shares it, so
      // it takes no row of the window, and a continuation shown without its
      // beginning offers no control that would act on the wrong message.
      if (one.first) {
        items.push(
          row(
            `queue:${one.message.key}:remove`,
            "X",
            { name: "Remove message" },
            styleOf("metadata"),
            { here: view.focused },
          ),
        );
      }
    }
  }
  const claiming = claim === "sidekick:message";
  items.push(
    field(
      "sidekick:message",
      " › message the sidekick",
      state.message,
      "message",
      styleOf("draft"),
      {
        field: MESSAGE_FIELD,
        caret: state.messageCaret,
        here: view.focused,
        block: true,
        ...(claiming ? { focus: true } : {}),
      },
    ),
  );
  for (const [at, own] of messageValueRows(context).entries()) {
    items.push(line(`sidekick:message:value:${at}`, own, styleOf("draft")));
  }
  return items;
}

/**
 * The selected work's Draft: one field whose heading carries its own Send, or
 * Stop while an entry is running, and whose value takes the rows beneath it.
 *
 * Send asks for exactly what Enter in the field asks for — the same submission
 * action, through the same gate, against the same draft revision — so the two
 * ways of submitting one text are one decision rather than two. Stop carries
 * the key of the entry this frame is actually drawing it for, so what it stops
 * is that entry and not whatever is running by the time the key is pressed. It
 * is offered only at the live head — a frozen reading is of an entry this
 * process may no longer be running, and a Stop there would be aimed at history.
 */
function workspaceDraft(
  view: ReplView,
  context: ReplPresentationContext,
  claiming: boolean,
): readonly Described[] {
  const items: Described[] = [];
  items.push(
    field("footer:input", " DRAFT", view.state.draft, "draft", styleOf("field-label"), {
      caret: view.state.draftCaret,
      here: view.focused,
      block: true,
      ...(claiming ? { focus: true } : {}),
    }),
  );
  // The entry a Stop here would be aimed at: the last one the live head
  // admitted. Entries are serial, so only the last one can still be running —
  // the same rule the entry reading uses to decide whose live output it is
  // showing. A reading with no entry at all has nothing to aim a Stop at, and
  // a frozen position is excluded below, because an entry read there may not be
  // the one this process is running.
  const open = view.model.entries[view.model.entries.length - 1]?.key;
  items.push(
    view.live.running && view.state.route.at === undefined && open !== undefined
      ? row(
          "draft:stop",
          "[stop]",
          { select: "stop-entry", entry: open },
          styleOf("failed-outcome"),
          { here: view.focused },
        )
      : row("draft:send", "[send]", { select: "submit-draft" }, styleOf("action"), {
          here: view.focused,
        }),
  );
  const rows = context.draft ?? ["", "", ""];
  for (const [at, own] of rows.entries()) {
    items.push(line(`draft:value:${at}`, own, styleOf("draft"), sourceRuns(own)));
  }
  return items;
}

/** The text column of the staged queue's first message, which its width is read from. */
export const QUEUE_TEXT = "box:queue:text:0";

/** The staged guidance row's inside, which the guidance is fitted to. */
export const GUIDANCE_ROW = "box:guidance:body";

/** The Draft's heading row, whose measured width its field is derived from. */
export const DRAFT_HEADING = "box:draft:heading";

/**
 * How wide a queued message's text is left beside its control.
 *
 * The row's own measured room, less the width the engine gave that control,
 * less the gap the row declares. None before either has been measured.
 */
export function queueTextWidth(
  manifest: ReplLayoutManifest,
  widthOf: (id: string) => number | undefined,
  room: number | undefined,
): number | undefined {
  const control = flatten(manifest.root).find((one) => one.key?.endsWith(":remove") === true);
  if (control === undefined || room === undefined || room < 1) {
    return undefined;
  }
  const button = widthOf(control.id);
  if (button === undefined || button < 1) {
    return undefined;
  }
  return Math.max(0, room - button - WORKSPACE_DRAFT_GAP);
}

/**
 * How wide the Draft's field is left, for this exact measured frame.
 *
 * The heading row's own measured width, less the width the engine gave the
 * control beside it, less the gap that row declares. None where this frame drew
 * no Draft, or where the measurement has answered for neither box yet.
 */
export function draftFieldWidth(
  manifest: ReplLayoutManifest,
  widthOf: (id: string) => number | undefined,
): number | undefined {
  const control = flatten(manifest.root).find(
    (one) => one.key === "draft:stop" || one.key === "draft:send",
  );
  if (control === undefined) {
    return undefined;
  }
  const heading = widthOf(DRAFT_HEADING);
  const button = widthOf(control.id);
  if (heading === undefined || button === undefined || heading < 1 || button < 1) {
    return undefined;
  }
  return Math.max(0, heading - button - WORKSPACE_DRAFT_GAP);
}

/** The staged History row's map, which is drawn rather than mounted. */
const HISTORY_MAP = "box:history:map";

/** The staged History row, which the map and the controls divide. */
const HISTORY_ROW = "box:history";

/** The gap the accepted wide row keeps between its map and its controls. */
const HISTORY_SPACE = "box:history:space";

/**
 * What the compact History rail calls itself.
 *
 * Shorter than the drawer's own title, because this is one row shared with the
 * footer's controls: the drawer has room to say what its list is ordered by and
 * this has room to say which reading it belongs to.
 */
export const COMPACT_HISTORY_TITLE = "HISTORY";

/** The probe row the offered action group's own intrinsic width is read from. */
export const HISTORY_PROBE_ACTIONS = "box:probe:history:actions";

/** The probe row the History map's own natural width is read from. */
export const HISTORY_PROBE_MAP = "box:probe:history:map";

/**
 * The History row's two parts, measured without each other's pressure.
 *
 * The non-wide row holds the map and the controls side by side, and the engine
 * answers a *fit* child's width under whatever room its parent was given: a map
 * fitted to its own long text takes the room first, the controls are left with
 * less than they need, and what comes back for each of them is a compressed
 * answer on part of a cell. Measured, a 72-cell row gave the map 29 and the
 * controls 43 — and the controls, asked on their own, need 51.
 *
 * So they are asked on their own. One fitted row holding exactly the offered
 * control nodes, their own labels, their own gap and the same leading spacer
 * declared at zero; one fitted row holding the map's own runs. Both carry
 * structural ids, mount nothing and publish no target: the question is how wide
 * these things are, and the answer is the engine's rather than a count of
 * characters.
 *
 * Built from the boxes the real composite built, so the labels measured here
 * are the labels drawn there. What is copied is each child's own text and
 * props — never the rectangle it was squeezed into, which is the number this
 * exists to replace.
 */
export function historyProbeOf(
  manifest: ReplLayoutManifest,
  size: ReplTerminalSize,
): ReplBox | undefined {
  const boxes = flatten(manifest.root);
  const actions = boxes.find((one) => one.id === ACTION_ROW);
  const map = boxes.find((one) => one.id === HISTORY_MAP);
  if (actions === undefined || map === undefined) {
    return undefined;
  }
  const children = actions.children.map((child) =>
    child.id === HISTORY_SPACE
      ? // The leading spacer grows into whatever the row has spare. Declared at
        // zero here, because what is being asked is the minimum the controls
        // need and a growing child would answer with the whole row.
        box({ id: `${HISTORY_PROBE_ACTIONS}:space`, props: statedPartProps(0) })
      : box({
          id: `${HISTORY_PROBE_ACTIONS}:${child.id}`,
          props: child.props,
          text: child.text,
          ...(child.style === undefined ? {} : { style: child.style }),
          ...(child.runs === undefined ? {} : { runs: child.runs }),
        }),
  );
  return box({
    id: "box:probe:history",
    props: rootProps(size),
    children: [
      box({ id: HISTORY_PROBE_ACTIONS, props: fittedRowProps(1), children }),
      box({
        id: HISTORY_PROBE_MAP,
        props: fittedPartProps(),
        text: map.text,
        ...(map.style === undefined ? {} : { style: map.style }),
        ...(map.runs === undefined ? {} : { runs: map.runs }),
      }),
    ],
  });
}

/**
 * How the non-wide History row divides itself, in whole cells.
 *
 * The map yields first and the controls keep what they need: `M` is the map's
 * own natural width, or what the row has left once the controls have theirs,
 * whichever is smaller; `A` is the rest. Both are whole, because both come from
 * whole measurements of complete labels — and the row states them rather than
 * letting two fit children compete, which is what put a control on part of a
 * cell.
 *
 * None where either measurement is missing or came back fractional. A frame
 * that cannot be measured is refused by the existing path rather than drawn
 * from a guess.
 */
export function historySplitOf(
  widthOf: (id: string) => number | undefined,
  room: number,
): { readonly map: number; readonly actions: number } | undefined {
  const needed = widthOf(HISTORY_PROBE_ACTIONS);
  const natural = widthOf(HISTORY_PROBE_MAP);
  if (needed === undefined || natural === undefined || room < 1) {
    return undefined;
  }
  if (!Number.isInteger(needed) || !Number.isInteger(natural)) {
    return undefined;
  }
  const map = Math.min(natural, Math.max(0, room - needed));
  return { map, actions: room - map };
}

/**
 * How wide the accepted wide row's gap is, for this exact measured frame.
 *
 * That row is a fitted map, this gap, and the controls — and the gap and the
 * controls both grow, so the engine divides what the map leaves between them.
 * It divides it in halves, and half of an odd number of cells is not a cell:
 * measured, an ordinary root's 25-cell map left 135, which came out 67.5 and
 * 67.5, and put History at x=92.5 where the renderer refuses to draw it. The
 * accepted fixture's map happens to leave 126, so its halves were whole and
 * nothing said the arrangement only worked for even remainders.
 *
 * So the gap is declared instead, and the controls stay the one growing child.
 * This is an integer budget decided before anything is placed — the engine
 * still measures where each control lands and how many of them there is room
 * for, and every control is still fitted to its own label. The odd cell goes
 * to the controls, which are what somebody is aiming at.
 */
export function historyGapWidth(widthOf: (id: string) => number | undefined): number | undefined {
  const row = widthOf(HISTORY_ROW);
  const map = widthOf(HISTORY_MAP);
  if (row === undefined || map === undefined) {
    return undefined;
  }
  // Both from this frame, and both whole: a width the engine had already
  // divided into halves of a cell is not a budget to divide again.
  if (!Number.isInteger(row) || !Number.isInteger(map)) {
    return undefined;
  }
  return Math.floor(Math.max(0, row - map) / 2);
}

/**
 * How wide the History row's map is left, for this exact measured frame.
 *
 * The row's own width, less the width the engine gave the controls beside it.
 * The map is the one thing on that row that may be shortened: the controls are
 * fitted to their own labels, because a pointer lands on the label somebody is
 * aiming at.
 *
 * It matters where the map is longer than what is left. A fitted box asked for
 * more room than the row has is squeezed by the engine's own arithmetic, and
 * that arithmetic is not whole — measured, a 72-column row holding a reading
 * of a retained position wanted 52 cells of map beside 21 of controls and came
 * back 51.0078125 wide, which the renderer refuses rather than rounds. Stated,
 * the map is cut at a whole cell and keeps the stretches that fall inside it.
 */
export function historyMapWidth(
  manifest: ReplLayoutManifest,
  widthOf: (id: string) => number | undefined,
  room: number | undefined,
): number | undefined {
  if (flatten(manifest.root).every((one) => one.id !== HISTORY_MAP)) {
    return undefined;
  }
  const actions = widthOf(ACTION_ROW);
  if (actions === undefined || room === undefined || room < 1) {
    return undefined;
  }
  // Whole cells, and the odd one to the controls. A measured remainder is not
  // always integral — two growing siblings split what is left fractionally —
  // and a map stated at a fraction leaves its controls sharing a fraction,
  // which the renderer refuses rather than rounding. Rounding *down* here is
  // what gives the controls the whole cell: the band loses a column of map
  // before a control loses part of itself.
  return Math.max(0, Math.floor(room - actions));
}

/**
 * The staged composition's identity row: what this is and which execution.
 *
 * Read from the route, so it names nothing this reading does not hold.
 */
function identityRuns(view: ReplView): readonly ReplTokenRun[] {
  return tokenRuns([
    { text: " XMD REPL", token: "output" },
    { text: "  session ", token: "field-label" },
    { text: view.state.route.execution, token: "source" },
  ]);
}

/**
 * The compact History map: one mark per entry, in admission order, then the head.
 *
 * Built from the whole-file navigation, so it shows positions after the
 * selection too — but only that they exist. An entry inside the selected prefix
 * carries the outcome that prefix holds; a later one carries its number alone.
 * Every exact position, an entry's and every minor one, is reached through the
 * History drawer, which is what the action beside this map opens.
 */
function compactHistoryRuns(view: ReplView): readonly ReplTokenRun[] {
  const runs: { text: string; token: ReplPresentationRole }[] = [
    { text: ` ${COMPACT_HISTORY_TITLE}`, token: "history-title" },
  ];
  const points = numbered(view.navigation);
  const at = view.state.route.at;
  const selectedOrdinal =
    at === undefined ? undefined : points.find((one) => one.point.marker === at)?.ordinal;
  const selectedEntry =
    selectedOrdinal === undefined
      ? undefined
      : points.filter((one) => one.ordinal <= selectedOrdinal).pop()?.entry;
  for (const one of points) {
    if (one.point.kind !== "entry") {
      continue;
    }
    const entry = view.model.entries.find((candidate) => candidate.order === one.entry);
    const chosen = selectedEntry === one.entry;
    runs.push({ text: "  ", token: "history" });
    runs.push({
      text: String(one.entry),
      token: chosen
        ? "history-selected"
        : entry === undefined
          ? "history-entry-later"
          : "history-entry-earlier",
    });
    if (entry === undefined) {
      continue;
    }
    const state = workState(entry, view.model, view.live);
    runs.push({ text: ` ${state.word.slice(0, 1)}`, token: state.style.role });
  }
  const head = view.navigation.head;
  runs.push({ text: "  ── ", token: "history-rail" });
  runs.push({
    text: at === undefined ? HEAD_LABELS[head] : `${HEAD_LABELS[head]} · reading earlier`,
    token: head === "live" ? "history-head-live" : "history-head",
  });
  return tokenRuns(runs);
}

/**
 * The staged composition's headers, as the two groups each of them holds.
 *
 * Named once, because two readers need the same answer: the preparation that
 * measures whether a header's groups fit one row, and the builder that places
 * them. The Draft's own heading is not here — its field grows into whatever its
 * controls leave, so it has nothing to wrap.
 */
/**
 * How many rows an overflowing tray takes, and how many of them are its window.
 *
 * Declared once, from the same parts the manifest places: the tray's own
 * heading rows, the two rows its navigation takes, the window itself, and the
 * composer's fitted rows. A content-fitted tray leaves the column dividing a
 * remainder between a growing body and a fitted block, and that division is not
 * whole — measured, it put the chat body at 18.0078125 rows and every row under
 * it on a fraction of a cell.
 *
 * The window is bounded by {@link WORKSPACE_QUEUE_ROWS} and by what the column
 * has left once its heading, the blank row above its body, the chat's own two
 * controls and one row of chat are taken. Eight is a maximum rather than a
 * promise: a narrower column allows fewer, and one with no room allows none,
 * which admits no queue rows at all.
 *
 * None where the tray's rows fit what it has, so that tray keeps the
 * content-sized placement the accepted screen was reviewed with.
 */
function trayAllocation(
  view: ReplView,
  context: ReplPresentationContext,
  extras: number,
): { readonly tray: number; readonly queue: number } | undefined {
  const workspace = staged(view);
  if (workspace === undefined || workspace.tray !== "queue" || !offersQueue(workspace)) {
    return undefined;
  }
  const wrapped = (id: string): number => (context.headers?.has(`header:${id}`) === true ? 2 : 1);
  const composer = 1 + messageValueRows(context).length;
  const held = queueSequence(workspace, context.queue).length;
  const column = workspaceBodyRows(view.size) - wrapped("conversation") - 1 - 1 - extras;
  const queue = Math.max(0, Math.min(WORKSPACE_QUEUE_ROWS, column - wrapped("tray") - composer));
  if (held <= queue) {
    return undefined;
  }
  return { tray: wrapped("tray") + queue + composer, queue };
}

/** One drawn row of the tray, and the message whose text it carries. */
interface ReplQueuedRow {
  readonly message: ReplQueuedMessage;
  /** Which row of its own message this is; zero is where the message begins. */
  readonly offset: number;
  readonly text: string;
  /** Whether this row begins its message, which is where its control goes. */
  readonly first: boolean;
}

/**
 * Every row the tray's messages occupy, in order, as one sequence.
 *
 * The one list the window counts, slices and draws from, so the rows a capacity
 * is measured against and the rows a frame shows cannot be two different lists.
 * Before the queue is fitted each message is one blank row: that count is the
 * geometry question, and its text would be fitted to nothing.
 */
function queueSequence(
  workspace: ReplWorkspace,
  fitted: readonly ReplFittedLine[] | undefined,
): readonly ReplQueuedRow[] {
  const rows: ReplQueuedRow[] = [];
  for (const message of workspace.queued) {
    const pieces =
      fitted === undefined
        ? [{ text: "", indent: 0 }]
        : fitted.filter((piece) => piece.line === `queue:${message.key}`);
    for (const [offset, piece] of pieces.entries()) {
      const text = `${" ".repeat(piece.indent)}${piece.text}`;
      rows.push(
        Object.freeze({
          message,
          offset,
          text,
          // Where the message begins, which is a fact about the row rather
          // than about its characters: a pass that has fitted no text yet
          // still has a first row, and its control must exist there to be
          // measured.
          first: offset === 0,
        }),
      );
    }
  }
  return Object.freeze(rows);
}

const WORKSPACE_HEADERS: readonly {
  readonly id: string;
  readonly gap: number;
  readonly left: readonly string[];
  readonly right: readonly string[];
  /** The left group where one outlet is routed, if it differs. */
  readonly outletLeft?: readonly string[];
}[] = Object.freeze([
  Object.freeze({
    id: "transcript",
    gap: TAB_GAP,
    left: Object.freeze(["transcript:title"]),
    right: Object.freeze(["transcript:selector"]),
  }),
  Object.freeze({
    id: "work",
    gap: 1,
    // The Entries control where this heading owns it. A narrow frame's surface
    // bar holds that control instead, and one key is one mounted node — so the
    // outlet's own heading is the breadcrumb alone. The breadcrumb itself is a
    // group rather than a key: every name but the innermost is a control that
    // goes to it.
    left: Object.freeze(["entries:heading", "work:crumb:*", "work:crumbs"]),
    outletLeft: Object.freeze(["work:crumb:*", "work:crumbs"]),
    right: Object.freeze(["work:state"]),
  }),
  Object.freeze({
    id: "conversation",
    gap: TAB_GAP,
    left: Object.freeze(["tab:bindings", "tab:sidekick"]),
    right: Object.freeze(["sidekick:configure"]),
  }),
  Object.freeze({
    id: "tray",
    gap: TAB_GAP,
    // Every key this row can hold, in its order. A key the composition did not
    // describe — a tray this execution does not offer, a Follow it does not
    // have — contributes no part, so the row is built from what is actually
    // there rather than from what a wider build would have put there.
    left: Object.freeze(["tray:todo", "tray:queue"]),
    right: Object.freeze(["follow", "sidekick:stop", "sidekick:send"]),
  }),
]);

/** One staged header's two groups, as the frame drawing it holds them. */
function headerGroupsOf(
  id: string,
  outlet: boolean,
):
  | { readonly gap: number; readonly left: readonly string[]; readonly right: readonly string[] }
  | undefined {
  const spec = WORKSPACE_HEADERS.find((one) => one.id === id);
  if (spec === undefined) {
    return undefined;
  }
  return {
    gap: spec.gap,
    left: outlet ? (spec.outletLeft ?? spec.left) : spec.left,
    right: spec.right,
  };
}

/**
 * How many cells the Transcript's selector has to say its name in.
 *
 * Its own row's room, less the one gap the engine puts between that row's
 * growing spacer and it. The header is two rows exactly when its two groups
 * cannot share one, and on a row of its own the selector is the only thing
 * beside that spacer — so this is the width it is given whichever of the two
 * the frame draws: at a shared width the one-row case arises only when the
 * label is short enough to fit beside the title as well.
 *
 * None before the frame has measured, which is the pass that fits nothing.
 */
/**
 * The mark on the Transcript selector that says it opens.
 *
 * Kept whatever the name in front of it costs, because it is the only thing on
 * that row saying the row is a way to something rather than a label.
 */
export const SELECTOR_MARK = " \u25be";

/**
 * Which conversation the Transcript selector names, before anything fits it.
 *
 * The whole name, which is what a frame still measuring should be told: it is
 * the longest this control can be, and a pass asking how much room the column
 * wants should not be answered with a name already given up for a width that
 * pass has not established.
 */
export function selectorName(view: ReplView): string {
  if (view.state.route.session === undefined) {
    return "All sessions";
  }
  // The first line of it, and the whole of that line. A name is one row here,
  // so a name holding a break is read to its first break — but nothing cuts it
  // by length on the way to the fitter. `headline` does, at fifty-nine UTF-16
  // units, and that is a cut in the wrong units made in the wrong place:
  // measured, a key that is one grapheme — an `e` under a hundred combining
  // accents — arrived at the fitter already missing forty-two of them, so the
  // fitter segmented a name this product had altered and reported an honest
  // width for the wrong string. Fitting is where a name gives up columns, and
  // it gives them up at grapheme boundaries against cells the engine measured.
  const [first = ""] = view.state.route.session.split("\n");
  return first;
}

export function selectorRoomOf(widths: ReplMeasuredWidths | undefined): number | undefined {
  return widths === undefined
    ? undefined
    : Math.max(0, headerRoomOf("transcript", widths) - TAB_GAP);
}

/**
 * Every key one header group names, with a trailing `*` standing for a run.
 *
 * The breadcrumb's ancestors are as many as the scopes somebody selected, so
 * the trail cannot be a fixed list of keys. A `*` names the run instead, and it
 * expands in the order the rows were described — which is the order the trail
 * reads in. Asked of what is actually there, so a reading with no nested scope
 * contributes no ancestor and the row is the row it has always been.
 */
function headerKeysOf(
  keys: readonly string[],
  described: readonly { readonly key: string }[],
): readonly string[] {
  return keys.flatMap((key) => {
    if (!key.endsWith("*")) {
      return [key];
    }
    const prefix = key.slice(0, -1);
    const found: string[] = [];
    for (const one of described) {
      if (one.key.startsWith(prefix) && !found.includes(one.key)) {
        found.push(one.key);
      }
    }
    return found;
  });
}

/** Which measured width one staged header's row is built to. */
function headerRoomOf(id: string, widths: ReplMeasuredWidths): number {
  const pane =
    id === "transcript" ? widths.list : id === "work" ? widths.surface : widths.inspection;
  return pane - 2 * WORKSPACE_LIST_GUTTER;
}

/**
 * Each staged header as the one row it would have to be, and the room it has.
 *
 * Fitted by the preparation against the width the engine measured for it: a
 * header whose two groups need more than that row is drawn as two rows
 * instead, which is a row of the pane's own body rather than an overlap, a
 * shortened label or a control left out.
 *
 * The texts are the ones the descriptions carry, read from a pass that has
 * described them — never spelled a second time here, which is how the row that
 * is measured and the row that is drawn stay the same row.
 */
export function workspaceHeaderLines(
  view: ReplView,
  context: ReplPresentationContext,
  widths: ReplMeasuredWidths,
): readonly { readonly key: string; readonly text: string; readonly room: number }[] {
  if (staged(view) === undefined) {
    return [];
  }
  const screen = described(view, context);
  // What each row would draw, answered by the same function the measuring pass
  // asks: a row whose characters all mean one thing carries no runs, and a map
  // built from runs alone would read those rows as empty.
  const text = new Map(
    screen.rows.map((one) => {
      const read = readDescription(one.description);
      return [one.key, measurementTextOf(read.component, read.input)];
    }),
  );
  const said = (keys: readonly string[], gap: number): string =>
    keys
      .map((key) => text.get(key))
      .filter((one): one is string => one !== undefined && one !== "")
      .join(" ".repeat(gap));

  const outlet = profileFor(view.size) === "narrow";
  const lines: { key: string; text: string; room: number }[] = [];
  for (const header of WORKSPACE_HEADERS) {
    const groups = headerGroupsOf(header.id, outlet);
    if (groups === undefined) {
      continue;
    }
    const left = said(headerKeysOf(groups.left, screen.rows), header.gap);
    const right = said(headerKeysOf(groups.right, screen.rows), header.gap);
    if (left === "" || right === "") {
      continue;
    }
    const room = headerRoomOf(header.id, widths);
    if (room < 1) {
      continue;
    }
    lines.push({
      key: `header:${header.id}`,
      // Two gaps, not one: the drawn row is the left group, the spacer that
      // takes what is over, and the right group, and the engine puts its gap on
      // both sides of that spacer. A text that counted one of them would say a
      // row fits in the one case where it is exactly one gap too wide, and the
      // engine would then squeeze a fitted label onto a fraction of a cell.
      text: `${left}${" ".repeat(header.gap * 2)}${right}`,
      room,
    });
  }
  return Object.freeze(lines);
}

/**
 * The staged workspace composition's boxes, from the same classified rows.
 *
 * One identity row, the body, and below it one compact History row carrying the
 * contextual actions and a measured guidance block. The wide and medium profiles give
 * the body three columns — the Transcript of agent work, the selected work with
 * its Draft, and Bindings/Sidekick with the tray above its composer. The narrow
 * profile routes one outlet instead, under the two surface controls, exactly as
 * the ordinary composition does: the surface it is not showing is in no cell,
 * no frame map and no target.
 *
 * The same measured bodies and windows the ordinary composition publishes, so
 * preparation, admission and fitting read them by the same names.
 */
function workspacePresentation(input: {
  readonly view: ReplView;
  readonly context: ReplPresentationContext;
  readonly descriptions: readonly ReplDescription<ReplAction>[];
  readonly candidates: readonly ReplCandidate[];
  readonly rail: ReplPreparedRail | undefined;
  readonly listColumn: (
    region: ReplRegion,
    fixedSlot: ReplSlot,
    rowSlot: ReplSlot,
    window: string,
    rows?: number,
    room?: number,
  ) => readonly ReplBox[];
  readonly chatColumn: (region: ReplRegion) => readonly ReplBox[];
  readonly viewports: ReplViewportSlot[];
  readonly regions: { region: ReplRegion; id: string }[];
  readonly contents: { region: ReplRegion; id: string; kind: "pane" | "body" }[];
}): ReplPresentation {
  const { view, context, descriptions, candidates, rail, viewports, regions, contents } = input;
  const size = view.size;
  const profile = profileFor(size);
  const outlet = profile === "narrow";
  /** Whether this frame is the accepted wide screen, whose row placement is reviewed. */
  const accepted = profile === "wide";
  const of = (slot: ReplSlot): readonly ReplCandidate[] =>
    candidates.filter((candidate) => candidate.slot === slot);
  const byKey = (key: string): readonly ReplCandidate[] =>
    candidates.filter((candidate) => candidate.key === key);
  const startingWith = (prefix: string): readonly ReplCandidate[] =>
    candidates.filter((candidate) => candidate.key.startsWith(prefix));
  /** One part of a row, exactly as wide as what it says. */
  const part = (candidate: ReplCandidate, region: ReplRegion, surface?: number): ReplBox =>
    box({
      id: `box:${region}:${candidate.key}`,
      key: candidate.key,
      region,
      props: fittedPartProps(surface),
      text: candidate.text,
      control: candidate.control,
      style: candidate.style,
      runs: candidate.runs,
    });
  const spacer = (id: string, region: ReplRegion): ReplBox =>
    box({ id, region, props: SPACER_PROPS });
  const header = REPL_PALETTE.paneHeaderSurface;
  /**
   * How wide this header part is stated to be, or none to let it be measured.
   *
   * The Transcript's selector alone, and for two reasons that are really one.
   * A fitted part asks the engine how wide its own text is, and that answer is
   * not always whole: measured, this selector came back 58.005859375 cells wide
   * and, shortened to its column, 32.0078125 — a fraction either way, and a
   * frame placed on fractions is one this product refuses to draw. And the
   * number it should be is already known, because fitting the label is what
   * produced it: {@link ReplFittedLabel} carries the text and the cells the
   * engine gave that text as one answer.
   *
   * Marker room is added here rather than measured. It is this screen's own
   * two cells in front of every control's label, drawn by `row` and not part of
   * the name — the label is fitted to what is left once they have theirs.
   */
  const statedCells = (one: ReplCandidate): number | undefined =>
    one.key === "transcript:selector" && context.selector !== undefined
      ? context.selector.cells + FOCUS_MARKER
      : undefined;
  const parts = (keys: readonly string[], region: ReplRegion, surface?: number): ReplBox[] =>
    keys.flatMap((key) =>
      byKey(key).map((one) => {
        const cells = statedCells(one);
        return cells === undefined
          ? part(one, region, surface)
          : box({
              id: `box:${region}:${one.key}`,
              key: one.key,
              region,
              props: statedPartProps(cells),
              text: one.text,
              control: one.control,
              style: one.style,
              runs: one.runs,
            });
      }),
    );

  /**
   * One staged header, in the one row it fits or the two rows it needs.
   *
   * Two rows keep the groups in their order — the left group's row first, the
   * right group's row under it, still at the trailing edge — so nothing moves
   * out from under a reader who learned where it was at a wider size. The
   * second row is a row of this pane, which is what makes it measured rather
   * than an overlay.
   */
  const headerRows = (id: string, region: ReplRegion, surface: number): readonly ReplBox[] => {
    const spec = headerGroupsOf(id, outlet);
    if (spec === undefined) {
      return [];
    }
    const left = parts(headerKeysOf(spec.left, candidates), region, surface);
    const right = parts(headerKeysOf(spec.right, candidates), region, surface);
    if (left.length === 0 && right.length === 0) {
      return [];
    }
    // The ids the accepted frame published, so a header that still fits one row
    // is the same box it always was. The tray is a row of its own block rather
    // than a pane heading, so it keeps that block's inset instead of a
    // heading's.
    const first =
      id === "conversation"
        ? TAB_ROW
        : id === "tray"
          ? "box:tray:controls"
          : `box:${region}:header`;
    const props = () =>
      id === "tray" ? partsRowProps(1, spec.gap) : workspaceHeaderProps(surface, spec.gap);
    if (
      !(context.headers?.has(`header:${id}`) ?? false) ||
      left.length === 0 ||
      right.length === 0
    ) {
      return [
        box({
          id: first,
          region,
          props: props(),
          children: [...left, spacer(`${first}:space`, region), ...right],
        }),
      ];
    }
    return [
      box({
        id: first,
        region,
        props: props(),
        children: [...left, spacer(`${first}:space`, region)],
      }),
      box({
        id: `${first}:second`,
        region,
        props: props(),
        children: [spacer(`${first}:second:space`, region), ...right],
      }),
    ];
  };

  /** The Transcript of agent work: its heading, and the reading under it. */
  const transcriptColumn = (
    region: ReplRegion,
    body: string,
    inside?: number,
  ): readonly ReplBox[] => {
    contents.push({ region, id: body, kind: "body" });
    return [
      ...headerRows("transcript", region, header),
      box({
        id: `${body}:gutter`,
        region,
        props: workspaceBodyProps(WORKSPACE_LIST_GUTTER, 1, inside),
        children: [
          box({
            id: body,
            region,
            props: paneContentProps(),
            children: input.listColumn(
              region,
              "sessions-fixed",
              "sessions",
              SESSIONS_WINDOW,
              undefined,
              context.widths?.listBody,
            ),
          }),
        ],
      }),
    ];
  };

  /** The selected work: its breadcrumbs and state, its reading, and the Draft. */
  const workColumn = (region: ReplRegion, body: string, inside?: number): readonly ReplBox[] => {
    contents.push({ region, id: body, kind: "body" });
    const draft = of("draft");
    const value = startingWith("draft:value:");
    return [
      ...headerRows("work", region, header),
      box({
        id: `${body}:gutter`,
        region,
        props: workspaceBodyProps(BODY_GUTTER, 1, inside),
        children: [
          box({
            id: body,
            region,
            props: paneContentProps(),
            children: input.listColumn(
              region,
              "reading-fixed",
              "reading",
              READING_WINDOW,
              undefined,
              context.widths?.surfaceBody,
            ),
          }),
        ],
      }),
      ...(draft.length === 0 && value.length === 0
        ? []
        : [
            box({
              id: "box:draft",
              region,
              props: workspaceBlockProps(
                WORKSPACE_DRAFT_ROWS,
                REPL_PALETTE.draftSurface,
                BODY_GUTTER,
              ),
              children: [
                box({
                  id: DRAFT_HEADING,
                  region,
                  props: partsRowProps(1, WORKSPACE_DRAFT_GAP, context.widths?.surfaceBody),
                  children: [
                    ...draft.map((one) =>
                      box({
                        id: `box:${region}:${one.key}`,
                        key: one.key,
                        region,
                        // What this row has left once the engine has measured
                        // the control beside it. Grown instead, the engine
                        // divides that remainder itself and the division is not
                        // always whole — measured, it left this field
                        // 52.00732421875 wide and put the control on a fraction
                        // of a cell. The control is still measured by its own
                        // label, so its hit box is still the label somebody
                        // aims at; only what is left over is stated.
                        props:
                          context.draftField === undefined
                            ? SPACER_PROPS
                            : statedPartProps(context.draftField),
                        text: one.text,
                        control: one.control,
                        style: one.style,
                        // No stretches: this row is drawn in one ink, which is
                        // what the reviewed screen shows — its marker and the
                        // composer's below it both take their own row's style,
                        // bolded where the focus is. Stating a width is what
                        // makes the builder apply a row's stretches, and the
                        // marker would otherwise take the focus ink here; the
                        // width the engine had already divided is the only
                        // thing this was meant to settle.
                      }),
                    ),
                    ...parts(["draft:stop", "draft:send"], region),
                  ],
                }),
                ...value.map((one) => rowBox(one, region, context.widths?.surfaceBody)),
              ],
            }),
          ]),
    ];
  };

  /** Bindings or the Sidekick: the tabs, the reading, and the tray below it. */
  const conversationColumn = (
    region: ReplRegion,
    body: string,
    inside?: number,
  ): readonly ReplBox[] => {
    const showing = showingSidekick(view);
    if (showing) {
      contents.push({ region, id: body, kind: "body" });
    }
    const room = context.widths?.body;
    const tray = [
      ...startingWith("tray:"),
      ...byKey("follow"),
      ...byKey("sidekick:stop"),
      ...byKey("sidekick:send"),
    ];
    const held = staged(view);
    // One box per row this frame described, walked in description order so the
    // rows placed are exactly the rows the window admitted. A box per message
    // reports its whole rectangle even where the window clipped it, and the
    // row after it is then placed over the control below.
    const described = candidates.filter((one) => one.key.startsWith("queue:"));
    let named = false;
    const queueRows: ReplBox[] = [];
    for (const [at, one] of described.entries()) {
      if (one.key.endsWith(":remove")) {
        continue;
      }
      const after = described[at + 1];
      const control =
        after !== undefined && after.key.endsWith(":remove") ? [part(after, region)] : [];
      // The first text box this frame draws is the one the preparation asks
      // how wide a queued message's text may be; the rest carry their own ids.
      const heading = !named;
      if (heading) {
        named = true;
        contents.push({ region, id: QUEUE_TEXT, kind: "body" });
      }
      queueRows.push(
        box({
          id: `box:${region}:${one.key}:row`,
          region,
          props: partsRowProps(1, WORKSPACE_DRAFT_GAP, room),
          children: [
            // The room this row's text has, as a box of its own: what is left
            // once the engine has measured the control beside it, derived the
            // way the Draft's field is — a grown remainder is not always whole,
            // and measured it left this text 51.005859375 wide with the control
            // on a fraction of a cell. The control is still sized by its own
            // label. The row inside keeps the key, so its cell is drawn under
            // the node that owns it while this box stays measurable.
            box({
              id: heading ? QUEUE_TEXT : `box:${region}:${one.key}:text`,
              region,
              props:
                context.queueText === undefined ? SPACER_PROPS : statedPartProps(context.queueText),
              children: [rowBox(one, region, context.widths?.queue)],
            }),
            ...control,
          ],
        }),
      );
    }
    const queueViewport = `box:${QUEUE_WINDOW}:viewport`;
    // The rows this body draws besides its chat and that chat's two controls.
    const extras = byKey("sidekick:back").length + byKey("sidekick:answer").length;
    const allocation = trayAllocation(view, context, extras);
    if (
      held !== undefined &&
      held.tray === "queue" &&
      offersQueue(held) &&
      allocation !== undefined
    ) {
      viewports.push(Object.freeze({ id: queueViewport, region, window: QUEUE_WINDOW }));
    }
    const composer = [...byKey("sidekick:message"), ...startingWith("sidekick:message:value:")];
    return [
      ...headerRows("conversation", region, header),
      box({
        id: showing ? `${body}:gutter` : "box:inspection:reading:gutter",
        region,
        props: workspaceBodyProps(WORKSPACE_LIST_GUTTER, 1, inside),
        children: [
          box({
            id: showing ? body : "box:inspection:reading",
            region,
            props: paneContentProps(),
            children: [
              ...input.chatColumn(region),
              ...byKey("sidekick:back").map((one) => rowBox(one, region, room)),
              ...byKey("sidekick:answer").map((one) => rowBox(one, region, room)),
            ],
          }),
        ],
      }),
      ...(tray.length === 0 && composer.length === 0
        ? []
        : [
            box({
              id: "box:tray",
              region,
              props: workspaceBlockProps(
                allocation?.tray ?? "fit",
                REPL_PALETTE.composerSurface,
                WORKSPACE_LIST_GUTTER,
                inside,
              ),
              children: [
                ...headerRows("tray", region, REPL_PALETTE.composerSurface),
                // A tray whose rows fit places them where the accepted screen
                // has them. One that does not is a window of the rows it was
                // allocated, whose room the engine measures like any other.
                ...(held?.tray === "queue" && offersQueue(held) && allocation !== undefined
                  ? [
                      box({
                        id: queueViewport,
                        region,
                        props: viewportProps(allocation.queue),
                        children: queueRows,
                      }),
                    ]
                  : queueRows),
                ...composer.map((one) => rowBox(one, region, room)),
              ],
            }),
          ]),
    ];
  };

  const columns: ReplBox[] = [];
  if (outlet) {
    // One routed surface, and nothing else. The surface this route did not
    // select is described nowhere, so it is in no cell and no target map.
    regions.push({ region: "content", id: "box:content" });
    const routed = view.state.route.surface;
    const routedRows = showingSidekick(view)
      ? conversationColumn("content", SIDEKICK_BODY, size.columns)
      : routed === "sessions"
        ? transcriptColumn("content", SIDEBAR_BODY, size.columns)
        : workColumn("content", TRANSCRIPT_BODY, size.columns);
    columns.push(
      box({
        id: "box:content",
        region: "content",
        // The whole terminal, stated: a growing outlet takes its minimum from
        // its own content, and a breadcrumb or a control is content.
        props: workspaceColumnProps(size.columns, REPL_PALETTE.applicationSurface, false),
        children: [
          box({
            id: "box:content:surfaces",
            region: "content",
            props: workspaceHeaderProps(header, TAB_GAP),
            children: parts(
              ["sessions:heading", "entries:heading", "surface:sidekick"],
              "content",
              header,
            ),
          }),
          ...routedRows,
        ],
      }),
    );
  } else {
    regions.push(
      { region: "sidebar", id: "box:sidebar" },
      { region: "transcript", id: "box:transcript" },
      { region: "inspection", id: "box:inspection" },
    );
    contents.push({ region: "transcript", id: "box:transcript:content", kind: "pane" });
    contents.push({ region: "inspection", id: "box:inspection:content", kind: "pane" });
    columns.push(
      box({
        id: "box:sidebar",
        region: "sidebar",
        props: workspaceColumnProps(
          workspaceTranscriptWidth(size),
          REPL_PALETTE.transcriptPaneSurface,
          false,
        ),
        children: transcriptColumn(
          "sidebar",
          SIDEBAR_BODY,
          workspaceInsideWidth(workspaceTranscriptWidth(size), false),
        ),
      }),
      box({
        id: "box:transcript",
        region: "transcript",
        props: workspaceColumnProps(
          workspaceWorkWidth(size),
          REPL_PALETTE.applicationSurface,
          true,
        ),
        children: [
          box({
            id: "box:transcript:content",
            region: "transcript",
            // Stated, so the width a header is fitted to is the width its row
            // has: a growing content box reports its own content instead.
            props: workspaceBodyProps(0, 0, workspaceInsideWidth(workspaceWorkWidth(size), true)),
            children: workColumn(
              "transcript",
              TRANSCRIPT_BODY,
              workspaceInsideWidth(workspaceWorkWidth(size), true),
            ),
          }),
        ],
      }),
      box({
        id: "box:inspection",
        region: "inspection",
        props: workspaceColumnProps(
          workspaceConversationWidth(size),
          REPL_PALETTE.conversationSurface,
          true,
        ),
        children: [
          box({
            id: "box:inspection:content",
            region: "inspection",
            props: workspaceBodyProps(
              0,
              0,
              workspaceInsideWidth(workspaceConversationWidth(size), true),
            ),
            children: conversationColumn(
              "inspection",
              SIDEKICK_BODY,
              workspaceInsideWidth(workspaceConversationWidth(size), true),
            ),
          }),
        ],
      }),
    );
  }

  // Whichever drawer is presented, through the one calculation both use.
  const rect = presentedRect(view, context);
  const [title] = of("drawer-title");
  if (rect !== undefined && title !== undefined) {
    const id = `box:${DRAWER_WINDOW}:viewport`;
    viewports.push(
      Object.freeze({ id, region: "drawer", window: DRAWER_WINDOW, owner: "viewport:drawer" }),
    );
    regions.push({ region: "drawer", id: "box:drawer:layer" });
    columns.push(
      box({
        id: "box:drawer:layer",
        region: "drawer",
        props: drawerLayerProps(rect, context.capture),
        children: [
          rowBox(title, "drawer", context.widths?.drawer),
          box({
            id,
            region: "drawer",
            props: viewportProps(),
            children: of("drawer").map((one) => rowBox(one, "drawer", context.widths?.drawer)),
          }),
          drawerActions(of("drawer-actions")),
        ],
      }),
    );
  }

  const offered = [...of("action"), ...of("status")];
  const placed = offered.filter(
    (candidate) => context.measuring || context.admission.actions.has(candidate.key),
  );
  const map = compactHistoryRuns(view);
  const inspected = view.state.route.at !== undefined;
  regions.push({ region: "footer", id: "box:footer" });
  return {
    descriptions,
    manifest: Object.freeze({
      profile,
      size: Object.freeze({ ...size }),
      root: box({
        id: "box:root",
        props: rootProps(size),
        children: [
          box({
            id: "box:identity",
            props: bandRowProps(REPL_PALETTE.chromeSurface),
            children: [
              box({
                id: "box:identity:text",
                props: fittedPartProps(),
                text: runText(identityRuns(view)),
                runs: identityRuns(view),
                style: styleOf("metadata"),
              }),
            ],
          }),
          box({ id: "box:body", props: bodyProps(false), children: columns }),
          box({
            id: "box:footer",
            region: "footer",
            // State the fitted row count: intrinsic stack sizing can place this
            // footer on fractional cells, invalidating every input rectangle.
            props: stackProps(1 + (context.guidance?.length ?? 1)),
            children: [
              box({
                id: "box:history",
                region: "footer",
                props: bandRowProps(REPL_PALETTE.historySurface),
                children: [
                  box({
                    id: HISTORY_MAP,
                    region: "footer",
                    // The accepted wide row fits this map to its own text and
                    // has room for it. Every other profile states it, at the
                    // width this frame measured the row's two parts to need —
                    // the map's own natural width, or what the controls leave,
                    // whichever is smaller. Fitting it there instead makes its
                    // text a minimum that competes with complete control
                    // labels: measured, a 72-cell row gave a 29-cell map its
                    // whole text and left the controls 43 where they need 51,
                    // and every one of them came back on part of a cell.
                    props:
                      accepted || context.historySplit === undefined
                        ? fittedPartProps()
                        : statedPartProps(context.historySplit.map),
                    text: runText(map),
                    runs: map,
                    style: styleOf("history", { inspected }),
                  }),
                  // The accepted wide screen divides what the map leaves
                  // between a gap and this row, which is where its controls
                  // were reviewed. Two growing siblings split a remainder in
                  // the engine's own arithmetic and that arithmetic is not
                  // whole — measured, a 72-column row placed a control at
                  // x=41.9921875 — so every other profile states one growing
                  // child and puts the controls at the trailing edge. Whether
                  // the wide screen should follow them is a question for the
                  // image review, not one to answer by moving an accepted row.
                  ...(accepted
                    ? [
                        context.historyGap === undefined
                          ? spacer(HISTORY_SPACE, "footer")
                          : box({
                              id: HISTORY_SPACE,
                              region: "footer",
                              props: statedPartProps(context.historyGap),
                            }),
                      ]
                    : []),
                  box({
                    id: ACTION_ROW,
                    region: "footer",
                    // Stated at what the offered controls actually need, so the
                    // engine is dividing a row that is big enough rather than
                    // compressing fitted children into one that is not. The
                    // leading spacer inside it absorbs whatever is genuinely
                    // spare, and every control stays fitted to its own label.
                    props: accepted
                      ? actionRowProps()
                      : context.historySplit === undefined
                        ? inlineActionRowProps()
                        : statedActionRowProps(context.historySplit.actions),
                    children: [
                      ...(accepted ? [] : [spacer(HISTORY_SPACE, "footer")]),
                      ...placed.map((candidate) =>
                        box({
                          id: `box:action:${candidate.key}`,
                          key: candidate.key,
                          region: "footer",
                          props: CONTROL_PROPS,
                          text: candidate.text,
                          control: candidate.control,
                          style: candidate.style,
                          runs: candidate.runs,
                        }),
                      ),
                    ],
                  }),
                ],
              }),
              box({
                id: "box:guidance",
                region: "footer",
                props: bandBlockProps(REPL_PALETTE.chromeSurface, WORKSPACE_LIST_GUTTER),
                children: [
                  box({
                    id: GUIDANCE_ROW,
                    region: "footer",
                    props: GROWING_STACK_PROPS,
                    children: of("located").map((one) =>
                      rowBox(one, "footer", context.widths?.guidance),
                    ),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      viewports: Object.freeze(viewports),
      actions: Object.freeze({
        // The box whose trailing edge bounds this row. Where the controls are a
        // group as wide as itself, that edge is the band's rather than the
        // group's — a group bounded by its own width would admit every control
        // it was offered, however little room the row had.
        id: accepted ? ACTION_ROW : "box:history",
        controls: Object.freeze(
          offered.map((candidate) => ({
            key: candidate.key,
            id: `box:action:${candidate.key}`,
            control: candidate.control,
          })),
        ),
      }),
      regions: Object.freeze(regions.map((region) => Object.freeze(region))),
      contents: Object.freeze(contents.map((content) => Object.freeze(content))),
      history: rail ?? EMPTY_BAND,
    }),
  };
}

/** How many rows of the draft's own value the staged Draft shows. */
const DRAFT_VALUE_ROWS = WORKSPACE_DRAFT_ROWS - 1;

/** The chat lines this view's frame fits, the staged composition's included. */
export function chatLinesFor(
  view: ReplView,
): readonly { readonly key: string; readonly text: string }[] {
  return sidekickChatLines(view.live.sidekick, chatStagingOf(view));
}

/** The staged queue's messages as the lines its text column fits, or none. */
export function queueLinesOf(
  view: ReplView,
): readonly { readonly key: string; readonly text: string }[] | undefined {
  const workspace = staged(view);
  if (
    workspace === undefined ||
    workspace.tray !== "queue" ||
    !offersQueue(workspace) ||
    !showingSidekick(view)
  ) {
    return undefined;
  }
  return workspace.queued.map((message) => ({
    key: `queue:${message.key}`,
    text: `${MARKER_ROOM}${message.text}`,
  }));
}

/**
 * The draft's own lines as the staged Draft fits them, or none.
 *
 * The newest ones, because those are the ones drawn. See below.
 */
export function draftLinesOf(view: ReplView):
  | readonly {
      readonly key: string;
      readonly text: string;
      readonly runs: readonly ReplTokenRun[];
    }[]
  | undefined {
  if (staged(view) === undefined) {
    return undefined;
  }
  const lines = view.state.draft.split("\n");
  // Only the lines this block can draw. Every line is fitted on its own and
  // every one of them is at least one row — a blank line included — so the last
  // `DRAFT_VALUE_ROWS` lines already hold at least as many rows as the Draft
  // shows, and the newest rows of those are the newest rows of the whole draft.
  // The lines above them are measured through the engine only to be dropped:
  // typing into a three-hundred-line draft cost 61.9ms a key at 160x36 against
  // 12.2ms before this block existed, almost all of it in cuts nothing drew.
  const drawn = lines.slice(Math.max(0, lines.length - DRAFT_VALUE_ROWS));
  const from = lines.length - drawn.length;
  // Keyed by where the line is in the draft, not by where it is in this list:
  // the key names the line somebody is editing.
  return drawn.map((text, at) => ({
    key: `draft:${from + at}`,
    text,
    runs: sourceRuns(text),
  }));
}

/**
 * The Draft's rows this frame draws: the newest that fit, then blank rows.
 *
 * The newest, because the end is where somebody is typing. Always exactly as
 * many rows as the Draft has, so the block's height is the same whatever the
 * draft holds.
 */
export function draftRowsOf(fitted: readonly ReplFittedLine[]): readonly string[] {
  const drawn = fitted.map((one) => `${" ".repeat(one.indent)}${one.text}`);
  const newest = drawn.slice(Math.max(0, drawn.length - DRAFT_VALUE_ROWS));
  return Object.freeze([
    ...newest,
    ...Array.from({ length: DRAFT_VALUE_ROWS - newest.length }, () => ""),
  ]);
}
export type { ReplDrawerRef };
