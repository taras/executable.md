import { useSidekickAttachment } from "../sidekick-acp/server.ts";
import { SidekickTransport } from "../sidekick-acp/protocol.ts";
import { testForSidekick } from "./sidekick/admission.ts";
/**
 * The command, as one scope.
 *
 * One scope owns the repository, the session, the keyed tree, the acknowledged
 * frame stream, the renderer and the terminal, and it ends all of them together.
 * Everything below it is either a kernel that was settled in an earlier slice or
 * the pure application reduction — this module only arranges them, decides when a
 * frame is owed, and performs the effects a component asked for and cannot do.
 *
 * ## Nothing is drawn on a clock
 *
 * A frame is owed when something that a frame shows has changed: the session
 * reprojected, the document printed, a question arrived, expansion moved, the
 * terminal resized, or a normalized event
 * produced an action. Each of those wakes the loop; nothing polls, and when
 * nothing has changed no subscription is held and no timer exists. The
 * subscription is taken for the frame it is about to draw and released after it,
 * so demand and drawing are the same fact.
 *
 * ## Acknowledged after present, never before
 *
 * The order is snapshot, commit, lay out, render, present, retain the frame map,
 * then acknowledge. Acknowledging earlier would tell the stream a timestamp had
 * been applied while the bytes for it were still being written, which is the
 * drift the acknowledgement exists to prevent. Anything that fails before the
 * present releases demand without applying the frame — and raises, because the
 * scope that owns the terminal is the only thing that puts its modes back, and
 * a screen that cannot be redrawn must not be left in raw mode showing a
 * picture that will never change again.
 */

import {
  Err,
  type Operation,
  Ok,
  type Result,
  scoped,
  race,
  spawn,
  type Subscription,
  type Task,
  withResolvers,
} from "effection";
import type { ReplExecutionProfile, ReplProfileAssembly } from "../repl-profile.ts";

import {
  admissionFor,
  admitsSubmission,
  admitted,
  answered,
  applied,
  askingFor,
  elicitWithdrawn,
  ENTRIES_WINDOW,
  entriesRowCount,
  filled,
  focusSettled,
  initialState,
  instructed,
  permissionSettled,
  offering,
  permissionWithdrawn,
  presentationFor,
  presentedDrawer,
  previewedMessage,
  MESSAGE_VALUE_ROWS,
  footerSentence,
  guidanceSentence,
  readinessOf,
  readingOf,
  SIDEBAR_BODY,
  SIDEKICK_BODY,
  SIDEKICK_WINDOW,
  chatLinesFor,
  draftFieldWidth,
  draftLinesOf,
  historyGapWidth,
  historyMapWidth,
  historyProbeOf,
  historySplitOf,
  queueTextWidth,
  draftRowsOf,
  GUIDANCE_ROW,
  QUEUE_TEXT,
  queueLinesOf,
  stagedWorkspace,
  workspaceHeaderLines,
  readsGeometry,
  reduceRepl,
  refusedView,
  replacedAgent,
  stateFor,
  TRANSCRIPT_BODY,
  unavailable,
  viewFor,
  withWorkspace,
  workspaceOf,
  FOCUS_MARKER,
  selectorName,
  selectorRoomOf,
  SELECTOR_MARK,
  withoutAbsentEntry,
  withoutLiveDrawers,
} from "./application.ts";
import type { AgentOptions, Json, NormalizedIssue, SessionConfiguration } from "@executablemd/core";
import { previewGeneratedXmdRoot } from "@executablemd/core/host";
import type { ReplQuestion } from "./elicitation.ts";
import type {
  ReplAction,
  ReplFormMessage,
  ReplIntent,
  ReplLive,
  ReplMeasuredWidths,
  ReplPreparing,
  ReplPresentation,
  ReplPresentationContext,
  ReplPresented,
  ReplSidekickChatRow,
  ReplSidekickQuestion,
  ReplSidekickReading,
  ReplSidekickSetup,
  ReplSidekickTurnRow,
  ReplState,
  ReplView,
} from "./application.ts";
import { decodeLocation, encodeLocation, NO_LIVE, resolveLocation } from "./route.ts";
import type { ReplSidekickAvailability } from "./route.ts";
import { entryKey } from "./entries.ts";
// The one gate, shared with the reduction. A pure decision module: the root
// adds the slot it owns and nothing else crosses it.
import {
  admitting as newAdmitting,
  blocking,
  coldReservation,
  coldWorkspaceEntry,
  retainResolution,
  submitForSidekick,
  take,
} from "./sidekick/admission.ts";
import type { Admitting, ColdReservation, Reported } from "./sidekick/admission.ts";
import { fillable, stillAdmissible } from "./sidekick/gate.ts";
import type { DraftFacts, Instruction, Reservation } from "./sidekick/gate.ts";
import { rootReads } from "./sidekick/requests.ts";
import type { RootReading } from "./sidekick/requests.ts";
import type { SubmitReceipt } from "./sidekick/controls.ts";
import { pairedReplRepository } from "./sidekick/repository.ts";
import type { SidekickWriter } from "./sidekick/history.ts";
import { pairedLocation } from "./sidekick/history.ts";
import { cwd } from "@executablemd/runtime";
import type {
  PairedChatStorage,
  PairedReplExecution,
  PairedReplRepository,
} from "./sidekick/repository.ts";
import { useSidekickOwner } from "./sidekick/owner.ts";
import { createSidekickAdmission, useSidekickDispatch } from "./sidekick/dispatch.ts";
import type { SidekickDispatch } from "./sidekick/dispatch.ts";
import type { SidekickLiveTurn, SidekickOwner, SidekickPreview } from "./sidekick/owner.ts";
import { projectSidekick, retryable, SAVED_WITHOUT_REPLY } from "./sidekick/model.ts";
import type { SidekickReading, SidekickSavedTurn } from "./sidekick/model.ts";
import type { ReplExecution } from "./journal.ts";
import { lifecycleRefusal, openReplSession } from "./session.ts";
import type { ReplReading, ReplSession, ReplSubmission } from "./session.ts";
import { useReplFrames } from "./frame.ts";
import type { ReplFrames } from "./frame.ts";
import { committedOps, flatten, profileFor, routeDrawerRect, skeletonOps } from "./layout.ts";
import {
  createFitStore,
  createPlainFitStore,
  fitCells,
  fitPlain,
  prepareReading,
} from "./fitting.ts";
import type { ReplFittedLabel, ReplFitStore, ReplPlainFitStore } from "./fitting.ts";
import { prepareRail } from "./history-rail.ts";
import { readingLines } from "./source-reading.ts";
import { sourceRuns } from "./presentation-text.ts";
import type { ReplBounds, ReplBox, ReplLayoutManifest, ReplRegion } from "./layout.ts";
import { capacityOf, NOTHING_ADMITTED } from "./layout-admission.ts";
import type { ReplAdmission } from "./layout-admission.ts";
import { resolvePointer, useReplRenderer } from "./renderer.ts";
import type { ReplDrawnBox, ReplMeasured, ReplRendered, ReplRenderer } from "./renderer.ts";
import { useReplScreen } from "./screen.ts";
import type { ReplScreen, ReplScreenEvent } from "./screen.ts";
import type { ReplInputEvent } from "./description.ts";
import { useReplTree } from "./reconcile.ts";
import type { ReplTree } from "./reconcile.ts";
import { projectRepl } from "./model.ts";
import type { ReplModel } from "./model.ts";
import { useReplRoot } from "./storage.ts";
import { ReplTerminal } from "./terminal.ts";
import type { ReplTerminalSize } from "./terminal.ts";

/**
 * What one `xmd repl` invocation was asked to do.
 *
 * Two invocation facts and one profile. What a REPL execution may resolve, the
 * ceiling a generated fragment runs under and how a permission request is
 * answered are decided by the command before this runs, and are read here rather
 * than assembled again: one profile means the second entry of a session cannot
 * run under different rules from the first.
 */
export interface ReplProgramOptions {
  readonly sidekickAcp?: string;
  /** The location to reopen, or none to start a fresh execution. */
  readonly location?: string;
  /** The repository root. Defaults to this host's per-user data directory. */
  readonly root?: string;
  /** Everything this command settled before it opened a terminal. */
  readonly profile: ReplExecutionProfile | ReplProfileAssembly;
}

/** What the command reports when it ends. */
export interface ReplOutcome {
  /** The canonical location the screen was showing when it ended. */
  readonly location: string;
  /** Why it ended without a session, when that is what happened. */
  readonly refusal: string | undefined;
}

/**
 * Run one REPL.
 *
 * Refusals come back as `Err` rather than as a thrown error, because a person
 * naming an unreadable location has not caused a failure — they have asked for
 * something this command cannot show, and the difference decides whether a
 * terminal was ever opened.
 */
export function* runReplProgram(options: ReplProgramOptions): Operation<Result<ReplOutcome>> {
  // Before a path is formed, a file is opened or a terminal is touched: what the
  // caller named has to be a location this grammar defines.
  if (options.location !== undefined) {
    const decoded = decodeLocation(options.location);
    if (!decoded.ok) {
      return decoded;
    }
  }

  let state: ReplState =
    options.location === undefined ? initialState("pending") : yield* stateOf(options.location);

  // A terminal, before a directory is formed or a file exists. Raw mode is the
  // first thing that fails over a pipe, and it fails several steps after this
  // command has already created an execution — leaving an empty history behind
  // for a session that was never going to open. Asked here, "there is no
  // terminal" is a refusal instead of wreckage.
  if (!(yield* ReplTerminal.operations.interactive())) {
    return Err(
      new ReplRefusedError(
        "the REPL runs where a terminal is: it is not available over a pipe.",
        encodeLocation(state.route),
      ),
    );
  }

  const root = options.root ?? (yield* useReplRoot());
  // Paired, so a new execution publishes its chat history beside its entries
  // from the start and an older single-file one opens exactly as it is. Which
  // shape this execution is in travels on it as `chat`, for the Sidekick owner
  // to read; nothing here starts a conversation or writes a chat record.
  const repository = pairedReplRepository(root);

  // Opening a retained history reads and validates the whole file, and a file
  // that is not one raises. That is a location this command cannot show rather
  // than a failure of the command, so it becomes the refusal screen — with no
  // session, no provider and no observer ever created.
  let execution: PairedReplExecution;
  try {
    execution =
      options.location === undefined
        ? yield* repository.create()
        : yield* repository.open(requireExecution(options.location));
  } catch (error) {
    return yield* refuse(state, error instanceof Error ? error.message : String(error));
  }
  if (options.location === undefined) {
    state = initialState(execution.id);
  }

  // The route, against what the file already holds — *before* anything replays.
  //
  // Opening a session starts or resumes the execution, and replay that gets
  // past the retained prefix appends. A location naming a scope this history
  // never had is a typo, and discovering it after replay has run means the typo
  // grew the file: the run happened, records landed, and the answer the person
  // gets is still that their URL was wrong. Everything the route names comes
  // from records that are already on disk, so the question has an answer here,
  // where the only cost of the wrong URL is being told so.
  if (options.location !== undefined) {
    const reachable = yield* resolvable(execution, state);
    if (!reachable.ok) {
      return yield* refuse(state, reachable.error.message);
    }
  }

  const workspace = pairedLocation(root, execution.id).directory;
  const profile =
    "finalize" in options.profile ? yield* options.profile.finalize(workspace) : options.profile;
  const projectCwd = profile.projectCwd ?? (yield* cwd());
  let unresolved: ColdReservation | undefined;
  let resumedWorkspaceEntry: string | undefined;
  if (execution.chat.form === "paired") {
    const projected = projectRepl(yield* execution.stream.readAll());
    if (!projected.ok) {
      return yield* refuse(state, projected.error.message);
    }
    const cold = yield* coldReservation(
      execution.chat.records,
      projected.value.entries,
      execution.chat.location.entries,
    );
    if (!cold.ok) {
      return yield* refuse(state, blocking(cold.error));
    }
    const placement = yield* coldWorkspaceEntry(
      execution.chat.records,
      projected.value.entries,
      execution.chat.location.entries,
    );
    if (!placement.ok) {
      return yield* refuse(state, blocking(placement.error));
    }
    unresolved = cold.value;
    resumedWorkspaceEntry = placement.value;
  }

  const opened = yield* openReplSession({
    execution,
    projectCwd,
    workspace,
    ...(resumedWorkspaceEntry === undefined ? {} : { resumedWorkspaceEntry }),
    includes: profile.includes,
    mounts: profile.mounts,
    installations: profile.installations,
    generated: profile.generated,
    permissionMode: profile.permissionMode,
    ...(profile.entryInstallation === undefined
      ? {}
      : { entryInstallation: profile.entryInstallation }),
    ...(state.route.at === undefined ? {} : { selection: state.route.at }),
  });

  if (!opened.ok) {
    // A history that cannot be projected mounts the refusal and nothing else:
    // no provider, no observer, no execution task, and no append.
    return yield* refuse(state, opened.error.message);
  }

  // The repository goes with it. Establishing a pair for an execution still
  // held in the older single file replaces the execution this command owns, so
  // the thing that can do it is the thing that owns it — and it is passed
  // privately rather than reached from anywhere a view or a reply could.
  return yield* drive(
    opened.value,
    state,
    execution,
    { ...options, profile: { ...profile, projectCwd } },
    repository,
    unresolved,
    workspace,
  );
}

/**
 * Whether the retained history can answer everything this route names.
 *
 * Projected from the file as it stands rather than from a session, because a
 * session is the thing this is deciding whether to open. The prefix a route
 * selects, the scopes it walks and the drawers it opens are all answers the
 * retained records already hold.
 */
function* resolvable(execution: PairedReplExecution, state: ReplState): Operation<Result<void>> {
  const projected = projectRepl(yield* execution.stream.readAll(), state.route.at);
  if (!projected.ok) {
    return projected;
  }
  // The chat records this execution was *opened* with, which is the whole of
  // what its Sidekick history holds before anything explicit happens. No
  // conversation is opened to obtain them and no provider is created: a
  // selector naming a chat nobody ever held has to be answered here, where the
  // only cost of the wrong URL is being told so, rather than after resumption
  // has appended to somebody's history.
  const chat = coldSidekick(execution);
  const resolved = resolveLocation(projected.value, state.route, {
    ...NO_LIVE,
    ...(chat === undefined ? {} : { sidekick: chat }),
  });
  return resolved.ok ? Ok(undefined) : Err(resolved.error);
}

/**
 * What this execution's saved Sidekick history says, read cold.
 *
 * None for an execution still held in the older single file: it has no chat
 * history at all, so there is no saved chat to select and reading one does not
 * upgrade it — a location naming one refuses. A pair this version cannot read
 * keeps its own refusal, which is the established storage answer rather than a
 * manufactured empty reading.
 *
 * Nothing live is here, and that is deliberate: a cold open holds no owner, so
 * an exclusively ephemeral provider key the files never recorded is a key this
 * execution cannot establish.
 */
function coldSidekick(execution: PairedReplExecution): ReplSidekickAvailability | undefined {
  if (execution.chat.form !== "paired") {
    return undefined;
  }
  const read = projectSidekick(execution.chat.records);
  return read.ok
    ? sidekickAvailability(read.value)
    : Object.freeze({
        chats: Object.freeze([]),
        sessions: Object.freeze([]),
        refusal: read.error.message,
      });
}

/** The execution segment of a location that has already been decoded once. */
function requireExecution(location: string): string {
  const decoded = decodeLocation(location);
  if (!decoded.ok) {
    throw decoded.error;
  }
  return decoded.value.execution;
}

function* stateOf(location: string): Operation<ReplState> {
  const read = stateFor(location);
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

/**
 * Show one refusal until the person leaves.
 *
 * A screen, because a refusal a caller cannot see is a command that exited
 * silently; and only a screen, because there is nothing behind it to act on.
 */
function* refuse(state: ReplState, reason: string): Operation<Result<ReplOutcome>> {
  yield* scoped(function* (): Operation<void> {
    const screen = yield* useReplScreen();
    const events: Subscription<ReplScreenEvent, void> = yield* screen.events();
    const tree = yield* useReplTree<ReplAction>();
    const frames = yield* useReplFrames();
    const size = yield* screen.size();
    const renderer = yield* useReplRenderer({ columns: size.columns, rows: size.rows });

    // Drawn, then drawn again with where focus actually settled: the marker comes
    // from the tree's own answer, and the tree answers only after a commit.
    let focused: string | undefined;
    // Composed per frame rather than built once, so a terminal that moves while
    // this screen is being drawn is redrawn at the size it moved to.
    const compose: ReplCompose = function* (at) {
      return refusedView(state, reason, at, focused);
    };
    let shown = (yield* paint(frames, tree, renderer, screen, compose)).rendered;
    const settle = function* (): Operation<void> {
      const now = keyOfFocus(tree);
      if (now === focused) {
        return;
      }
      focused = now;
      shown = (yield* paint(frames, tree, renderer, screen, compose)).rendered;
    };
    yield* settle();

    while (true) {
      const next = yield* events.next();
      if (next.done === true || next.value.kind === "eof") {
        return;
      }
      if (next.value.kind === "resize") {
        // A refusal recovers on resize like any other screen: the terminal
        // growing is the remedy for the one refusal that has no other. The
        // frame reads the size itself, so there is nothing to hand it here.
        shown = (yield* paint(frames, tree, renderer, screen, compose)).rendered;
        continue;
      }
      if (next.value.kind === "pointer") {
        // Resolved against the frame that produced these coordinates, like every
        // other pointer: this screen has a control on it, and a control a pointer
        // cannot reach is one half of a control.
        const aimed = resolvePointer(shown, next.value.at);
        if (aimed !== undefined && (yield* leaves(tree, aimed))) {
          return;
        }
        yield* settle();
        continue;
      }
      if (next.value.kind !== "input") {
        continue;
      }
      if (yield* leaves(tree, next.value.event)) {
        return;
      }
      // Escape as well, because the one screen with no control placed on it — a
      // window too small to draw in — offers this and nothing else. Control-C
      // leaves from here for the same reason it leaves anywhere: this is still a
      // running command, and the key is answered by whoever owns the ending
      // rather than by a control that may not have been placed. The outcome is
      // unchanged, so leaving a refusal this way is still a refusal.
      if (
        next.value.event.kind === "key" &&
        (next.value.event.key === "Escape" || next.value.event.key === "Interrupt")
      ) {
        return;
      }
      // Drawn again, because Tab moved focus and a marker nobody redrew is a
      // control a person cannot see themselves reaching.
      yield* settle();
    }
  });
  return Err(new ReplRefusedError(reason, encodeLocation(state.route)));
}

/**
 * Whether this event asked to leave, according to the screen that is mounted.
 *
 * Through the tree, so the refusal screen's control means the same thing there as
 * it does everywhere else and a pointer on it asks for what Enter on it asks for.
 */
function* leaves(tree: ReplTree<ReplAction>, event: ReplInputEvent): Operation<boolean> {
  const dispatched = yield* tree.dispatch(event);
  return (
    dispatched.ok &&
    dispatched.value.outcome === "action" &&
    dispatched.value.action.kind === "exit"
  );
}

/** A location this command cannot show. */
export class ReplRefusedError extends Error {
  readonly location: string;
  constructor(message: string, location: string) {
    super(message);
    this.name = "ReplRefusedError";
    this.location = location;
  }
}

/**
 * Everything that has changed since the last frame.
 *
 * A queue rather than a stream subscription, because what the loop needs is not
 * the next event but *every* event that has arrived: one burst of input is one
 * frame, and a subscription hands them over one at a time with no way to ask
 * whether more are already waiting.
 */
interface Wakes {
  send(wake: Wake): void;
  close(): void;
  /** Everything waiting, or nothing at all when the sources have ended. */
  take(): Operation<readonly Wake[]>;
}

function queued(): Wakes {
  const waiting: Wake[] = [];
  let ended = false;
  let ready = withResolvers<void>();
  return {
    send(wake: Wake): void {
      waiting.push(wake);
      ready.resolve();
    },
    close(): void {
      ended = true;
      ready.resolve();
    },
    *take(): Operation<readonly Wake[]> {
      while (waiting.length === 0) {
        if (ended) {
          return [];
        }
        yield* ready.operation;
        ready = withResolvers<void>();
      }
      return waiting.splice(0, waiting.length);
    },
  };
}

/** What woke the loop. */
type Wake =
  | { readonly kind: "screen"; readonly event: ReplScreenEvent }
  | { readonly kind: "session" };

/**
 * What a reopened history still owes, and what the screen is true of now.
 *
 * Three things the submit path needs and cannot read for itself: whether a
 * disagreement between the two files forbids admitting anything, the write that
 * answers a reservation a dead process left, and a fresh reading of the draft
 * for the recheck at the entry's actual start.
 */
interface Reopening {
  /** Why nothing may be admitted, when that is the case. */
  readonly blocked: string | undefined;
  /** Retain any unanswered reservation. Acts on nothing it finds. */
  settle(): Operation<void>;
  /** The draft facts as they stand, read when they are asked for. */
  facts(): DraftFacts;
}

/**
 * The root's own end of what a reply asks for.
 *
 * {@link RootReading} is what a reply's requests see; the drain below is what
 * the loop does about the one of them that writes. They are one object because
 * they are one owner: the thing that answers a reply about the draft is the
 * thing that holds it.
 *
 * The conversation half — which response asked, and the reservation its Submit
 * binds — is not here. A submission is written into the chat history that asked
 * for it, so it belongs to the owner of that conversation rather than to the
 * loop, and the loop's part in it is the slot it already keeps.
 */
interface SidekickRoot extends RootReading {
  /**
   * Apply every fill a reply has asked for, and answer each of them.
   *
   * Drained by the loop rather than applied from inside the response, for the
   * reason every other report is: the draft is the loop's, and one writer is
   * the whole point of having a loop. A reply's request waits here, so a fill
   * that has returned is a fill the draft actually holds — which is what makes
   * the submission after it reserve the text the reply just wrote rather than
   * whatever was there before.
   */
  applyFills(): void;
}

/** Run the screen for one opened session. */
function* drive(
  session: ReplSession,
  start: ReplState,
  // The paired shape, because reopening has to ask the chat history whether a
  // previous process left a reservation unanswered. A legacy execution has no
  // chat history to have left one in.
  opened: PairedReplExecution,
  options: ReplProgramOptions & { readonly profile: ReplExecutionProfile },
  /** Where this execution lives, for the one write that replaces it. */
  repository: PairedReplRepository,
  cold: ColdReservation | undefined,
  workspace: string,
): Operation<Result<ReplOutcome>> {
  let state = start;
  /**
   * The execution as it stands, which an upgrade replaces.
   *
   * Reassigned exactly once, by the handoff an explicit message asks for: a
   * legacy execution becomes a paired one, keeping its id, its route, its entry
   * task and the same movable writer. Everything that reads storage reads this
   * rather than the object this function was handed, because the original is
   * the superseded one from that moment on.
   */
  let execution: PairedReplExecution = opened;
  // One session for the whole command: it owns the file, the observer and each
  // entry task in turn, so submitting an entry does not replace it.
  const current: ReplSession = session;
  // One prepared reading, never a model beside a navigation that arrived
  // separately. Everything below assigns both halves together or neither.
  let reading: ReplReading = { model: session.model, navigation: session.navigation };
  let rendered: ReplRendered | undefined;
  /**
   * The Sidekick question whose form the frame on screen is presenting.
   *
   * Kept beside the frame it was read from, because that is the frame a person
   * is acting against: which input a key reaches depends on what was drawn when
   * it was pressed, and the state alone cannot say — a form held open is not a
   * form on screen.
   */
  let presenting: ReplPresented | undefined;
  // The reading geometry this command has already measured. Owned here, so it
  // lives exactly as long as the command does and no frame outside it can
  // reach one process's cuts.
  const fits = createFitStore();
  // The chat's own line cuts, in storage of its own beside that one. Two stores
  // rather than one slot shared: the entry reading's geometry reserves a rail
  // and a status column that plain text has neither of, and one slot would make
  // the two evict each other every time a reader looked at the other pane.
  const chatFits = createPlainFitStore();
  // And the composer's own, for the same reason again: its lines are not the
  // chat's, and settling them into the chat's store would evict the chat on
  // every keystroke.
  const messageFits = createPlainFitStore();
  // And the directions', which change when focus or readiness does.
  const guidanceFits = createPlainFitStore();

  const outcome = yield* scoped(function* (): Operation<Result<ReplOutcome>> {
    const screen = yield* useReplScreen();
    const events: Subscription<ReplScreenEvent, void> = yield* screen.events();
    const tree = yield* useReplTree<ReplAction>();
    const frames = yield* useReplFrames();
    const size = yield* screen.size();
    const renderer = yield* useReplRenderer({ columns: size.columns, rows: size.rows });

    // One queue, so the loop has exactly one place it waits — and so a burst is
    // one frame. A paste arrives as hundreds of text events in a few chunks; a
    // loop that drew after each of them would draw hundreds of frames nobody
    // sees, and the person would watch their document appear a character at a
    // time.
    const wakes = queued();
    const shutdown = withResolvers<void>();
    let ending = false;

    yield* spawn(function* reading(): Operation<void> {
      while (true) {
        const next = yield* events.next();
        if (next.done === true) {
          ending = true;
          shutdown.resolve();
          wakes.close();
          return;
        }
        if (
          next.value.kind === "eof" ||
          (next.value.kind === "input" &&
            next.value.event?.kind === "key" &&
            next.value.event.key === "Interrupt")
        ) {
          ending = true;
          shutdown.resolve();
        }
        wakes.send({ kind: "screen", event: next.value });
      }
    });

    yield* watch(current, wakes);

    /**
     * Whether the refusal now standing is one the readiness gave.
     *
     * Loop-local, because it is bookkeeping about what is being presented rather
     * than a fact about the execution: it belongs to neither the model, the
     * route, nor the state the reducer answers with, and nothing durable or
     * canonical carries it.
     */
    let refusedByReadiness = false;

    /**
     * The next entry slot, and the submission preparing to take it.
     *
     * Loop-local for the same reason the readiness bookkeeping above is: it is
     * about what this screen has in flight, and nothing durable or canonical
     * carries it. One slot, so the person and a reply contend for it rather
     * than each believing they hold the draft.
     */
    const admitting: Admitting = newAdmitting();

    /**
     * The fills a reply has asked for and the loop has not applied yet.
     *
     * A queue with an answer attached, rather than a flag: the request suspends
     * until its fill has actually landed, so two fills in one response land in
     * the order the response wrote them and a submission after one reserves the
     * text it put there.
     */
    const fills: { readonly source: string; settle(outcome: Result<void>): void }[] = [];

    /**
     * What a reply reads, and what the root does about the draft it writes.
     *
     * Assembled here because this is where the state is. The reads answer from
     * the acknowledged head rather than from `reading` — the prefix a person
     * has navigated to — because where somebody is looking is not a fact about
     * the history, and a reply handed the selected prefix would write an entry
     * against bindings that were replaced several entries ago.
     */
    const sidekickRoot: SidekickRoot = {
      // The reads, from the module a reply's requests are built over, rather
      // than a second implementation of them here. What a reply is told has to
      // be the same whether it is asked through the loop or through a proof.
      ...rootReads(current, options.profile),
      *fill(source: string): Operation<Result<void>> {
        const answer = withResolvers<Result<void>>();
        fills.push({ source, settle: answer.resolve });
        wakes.send({ kind: "session" });
        return yield* answer.operation;
      },
      applyFills(): void {
        for (const held of fills.splice(0)) {
          // Decided at the moment it is applied rather than when it was asked
          // for: a person can take the draft over while a response is still
          // being evaluated, and the answer a reply is owed is about the draft
          // it is actually replacing.
          const allowed = fillable(state);
          if (!allowed.ok) {
            held.settle(allowed);
            continue;
          }
          state = filled(state, held.source);
          held.settle(Ok(undefined));
        }
      },
    };

    /**
     * A reservation a previous process left unanswered, and what became of it.
     *
     * Read once, from records that were already on disk, before this screen
     * admits anything. A reply's Submit is written down before the slot it took
     * is acted on, so a process that stopped in between left a question the
     * entry history can answer — and it has to be answered before anything else
     * takes that slot, or the answer stops being findable.
     *
     * Held rather than resolved here, because resolving it is a write and
     * reopening a history writes nothing. It is retained at the first explicit
     * mutating action, which is where a person has asked for something.
     */
    let unresolved = cold;

    /**
     * Write down any unanswered reservation, before this action takes effect.
     *
     * Called by every path that admits, because every one of them is an
     * explicit mutating action and the finding has to be on disk before the
     * slot it is about is reused. It acts on nothing it finds: an entry that was
     * never admitted is not submitted now, and one that was is not re-run.
     */
    function* settleReservation(): Operation<void> {
      const held = unresolved;
      if (held === undefined || execution.chat.form !== "paired") {
        return;
      }
      // Cleared first, so a failed append is not retried by the next keystroke
      // ahead of the action that asked for it. The finding is still in the file
      // it came from, so the next process asks the same question again.
      unresolved = undefined;
      yield* retainResolution(execution.chat.writer, held);
    }

    /**
     * The draft facts as they stand, for a question asked now or asked later.
     *
     * A function rather than a value because the two callers want different
     * moments of it: the reduction reserves against the text the person
     * submitted, and the recheck at the entry's actual start wants whatever is
     * true by then. A copy taken at the keystroke and reused for both would
     * make the second one answer the first one's question.
     */
    function draftFacts(): DraftFacts {
      return {
        live: state.route.at === undefined,
        revisions: state.revisions,
        takenOver: state.takenOver,
        draft: state.draft,
      };
    }

    /**
     * Why nothing may be admitted while a storage handoff is in progress.
     *
     * An upgrade publishes a pair for an execution still held in the older
     * single file and moves the entry writer to it. An entry admitted in that
     * window would be admitted against a file that is about to be superseded,
     * so the root holds new admissions rather than racing them — the entry
     * already running keeps going through the same movable writer, which is
     * what the handoff exists to preserve.
     */
    let upgrading: string | undefined;

    /** What reopening still requires, and what the screen is now true of. */
    const reopening: Reopening = {
      get blocked(): string | undefined {
        return upgrading;
      },
      settle: settleReservation,
      facts: draftFacts,
    };

    const admissions = createSidekickAdmission();

    /** The chat writer as it stands, for a departure that has to join a write. */
    function chatWriter(): SidekickWriter | undefined {
      return execution.chat.form === "paired" ? execution.chat.writer : undefined;
    }

    /**
     * Let go of the configuration job this screen admitted, truthfully.
     *
     * Established before the loop returns and before anything is cancelled,
     * because this scope is what owns the writer and the provider: once it
     * unwinds they are gone. A save whose record has reached the file is
     * *joined* — its bytes are on their way and this writer's memory of them is
     * not there yet, so letting go between the two would leave the file holding
     * a record nothing acknowledged and the next append free to overtake it. A
     * job still waiting its turn has written nothing, so it is cancelled and
     * publishes nothing.
     */
    function* releasing(): Operation<void> {
      const held = admissions.configuration;
      if (held === undefined) {
        return;
      }
      admissions.releaseConfiguration(held);
      const task = held.task;
      if (task === undefined) {
        return;
      }
      if (held.kind === "save" && chatWriter()?.appending === "preferences") {
        yield* task;
        return;
      }
      yield* task.halt();
    }

    /**
     * What the Sidekick's own work has for the loop, in the order it arrived.
     *
     * The same discipline as the submission reports and the fills: the state is
     * the loop's, so work that happened elsewhere asks here and waits. An
     * acknowledgement in particular has to be applied before the fills queued
     * behind it, because a reply that filled the draft did so after the message
     * that produced it was saved.
     */
    const sidekickReports: (
      | { readonly kind: "acknowledged"; readonly held: Instruction; settle(): void }
      | { readonly kind: "refused"; readonly refusal: string }
      | {
          readonly kind: "inspected";
          readonly conversation: string | undefined;
          /** The model its effort levels were read for, as the read asked. */
          readonly model: string | undefined;
          readonly read: Result<AgentOptions>;
        }
      | {
          readonly kind: "unavailable";
          readonly conversation: string | undefined;
          readonly reason: string;
        }
      | {
          /**
           * A preference save answered.
           *
           * Its own member rather than one answer shape for everything Apply
           * does: a replacement asks for no model and no effort, so one shape
           * for both would make its success indistinguishable from a save that
           * asked for nothing.
           */
          readonly kind: "saved";
          /** The conversation and the selection that asked, so a late one is ignored. */
          readonly conversation: string | undefined;
          readonly revision: number;
          readonly answer: Result<void>;
        }
      | {
          /** A replacement answered, by the selection that asked for it. */
          readonly kind: "replaced";
          readonly conversation: string | undefined;
          readonly revision: number;
          readonly answer: Result<void>;
        }
    )[] = [];

    function applySidekickReports(): void {
      for (const report of sidekickReports.splice(0)) {
        if (report.kind === "acknowledged") {
          state = instructed(state, report.held);
          report.settle();
          continue;
        }
        if (report.kind === "inspected") {
          state = offering(state, report.conversation, report.model, report.read, sidekick.agent);
          continue;
        }
        if (report.kind === "unavailable") {
          state = unavailable(state, report.conversation, report.reason);
          continue;
        }
        if (report.kind === "saved") {
          state = applied(state, report.conversation, report.revision, report.answer);
          continue;
        }
        if (report.kind === "replaced") {
          // The same drawer transition, plus the one thing a replacement
          // changes that a preference does not: which conversation is current.
          // A reader who was explicitly in the chat that was replaced is put in
          // the new one; a failure leaves them exactly where they were.
          state = replacedAgent(state, report.conversation, report.revision, report.answer);
          continue;
        }
        state = Object.freeze({ ...state, refusal: report.refusal });
      }
    }

    /**
     * This execution's own Sidekick, acquired once.
     *
     * Here, in the screen's own scope, after the slot, the fills and the
     * reopening callbacks exist and before the first frame is composed. It
     * belongs to the execution rather than to an entry, a tab, a History
     * position or a turn — so changing any of those reaches this same
     * conversation, and nothing creates a second one.
     *
     * Acquiring it projects the acknowledged chat and does nothing else: no
     * provider, no options inspection, no prompt, no control and no upgrade. A
     * chat history this version cannot read stays an explicit refusal.
     */
    const sidekick: SidekickOwner = yield* useSidekickOwner({
      assembly: options.profile.sidekickAssembly,
      workspace,
      chat: execution.chat,
      *establish(): Operation<Result<PairedChatStorage>> {
        const held = execution.chat;
        if (held.form === "paired") {
          return Ok(held);
        }
        // Held from here, so nothing is admitted against the file that is about
        // to be superseded. An entry already running is untouched: it writes
        // through the movable writer, which the handoff moves.
        upgrading = "this execution's chat history is being published; the next entry waits for it";
        try {
          execution = yield* repository.upgrade(execution);
        } catch (error) {
          return Err(error instanceof Error ? error : new Error(String(error)));
        } finally {
          upgrading = undefined;
          // The screen says something different now: there is a chat history
          // where there was none.
          wakes.send({ kind: "session" });
        }
        const established = execution.chat;
        if (established.form !== "paired") {
          return Err(
            new Error(
              "this execution's chat history was not published, so there is nothing for the " +
                "Sidekick to write to",
            ),
          );
        }
        return Ok(established);
      },
      root: sidekickRoot,
      test: (path) =>
        testForSidekick(path, {
          held: admitting,
          session: current,
          testing: options.profile.testing,
          ...(reopening.blocked === undefined ? {} : { blocked: reopening.blocked }),
        }),
      submit(at, journal): Operation<Result<SubmitReceipt>> {
        return submitForSidekick(at, {
          session: {
            // The whole acknowledged history, read at the moment the
            // reservation asks for it. `current.model` is the projection of
            // the location this session was *opened* at, which is right for
            // what a frozen screen shows and wrong for what the next entry is
            // called: opening at an earlier position would otherwise reserve a
            // slot two entries ago and name an entry that already exists.
            entries() {
              const read = current.reading(undefined);
              if (!read.ok) {
                return read;
              }
              return Ok(
                read.value.model.entries.map((entry) => ({
                  key: entry.key,
                  source: entry.source,
                })),
              );
            },
            admits: () => current.admits(),
            // The start check travels through to the session, which is the only
            // thing that knows when this entry actually starts: it asks after
            // the preflight, and a reply's submission is held to the same terms
            // there as a person's Run.
            submit: (source, starting) => current.submit(source, undefined, starting, true),
          },
          // Asked rather than carried: a reply's submission is reserved against
          // the draft as it stands when it asks — the same moment a person's
          // Run is — and asked again, from the same place, when its entry
          // starts.
          facts: draftFacts,
          held: admitting,
          journal,
          // The writer as it stands, which an upgrade may have moved. The
          // original object would be a writer to a superseded path.
          writer: execution.stream,
          woke: () => {
            wakes.send({ kind: "session" });
          },
        });
      },
      revision: () => admissions.message?.instruction?.message ?? state.revisions.message,
      draft: () => state.draft,
      *acknowledge(revision: number): Operation<void> {
        const held = admissions.message?.instruction;
        if (held === undefined || held.message !== revision) {
          // Not a cycle this screen started, so there is nothing of this
          // screen's to clear. It answers rather than refusing: the message is
          // saved either way, and the owner is not waiting for permission.
          return;
        }
        const answer = withResolvers<void>();
        sidekickReports.push({ kind: "acknowledged", held, settle: answer.resolve });
        wakes.send({ kind: "session" });
        yield* answer.operation;
      },
    });

    const dispatch = yield* useSidekickDispatch({
      owner: sidekick,
      admission: admissions,
      execution: execution.id,
      workspace,
      changed: () => wakes.send({ kind: "session" }),
    });
    if (options.sidekickAcp !== undefined) {
      try {
        if (ending) {
          return Ok({ location: exitLocation(state), refusal: undefined });
        }
        if (!(yield* SidekickTransport.expect()).supported()) {
          return Err(new Error("Sidekick ACP requires a same-user POSIX Unix socket."));
        }
        const read = sidekick.reading;
        if (!read.ok) {
          return read;
        }
        if (read.value.active === undefined) {
          const initial = yield* dispatch.send(
            "Initialize this Sidekick for an ACP attachment. Reply briefly in an Output region " +
              "that you are ready, without submitting an entry or changing the draft.",
          );
          if (!initial.ok) {
            return initial;
          }
          const completed = yield* race([
            initial.value.completion,
            (function* (): Operation<undefined> {
              yield* shutdown.operation;
              return undefined;
            })(),
          ]);
          if (completed === undefined) {
            return Ok({ location: exitLocation(state), refusal: undefined });
          }
          if (!completed.ok) {
            return completed;
          }
        }
        if (ending) {
          return Ok({ location: exitLocation(state), refusal: undefined });
        }
        yield* useSidekickAttachment(options.sidekickAcp, {
          owner: sidekick,
          dispatch,
          reads: sidekickRoot,
          execution: execution.id,
          cwd: options.profile.projectCwd ?? workspace,
        });
      } catch (error) {
        return Err(error instanceof Error ? error : new Error("Sidekick attachment refused."));
      }
    }

    /**
     * This process's own name for each Sidekick question it has seen.
     *
     * Keyed on the exact pending object, because that is what an answer has to
     * target: a reply may answer one question and ask another with the same
     * words and the same schema, and text, shape or a count would all name
     * whichever one happened to be pending when a keystroke arrived. Weak, so
     * a question that has ended is forgotten with it; counted, so two live
     * questions never share a name.
     */
    const questionNames = new WeakMap<ReplQuestion, string>();
    let questionsNamed = 0;

    /** What this screen calls the Sidekick's pending question, if it has one. */
    function askingNow(): ReplSidekickQuestion | undefined {
      const pending = sidekick.questions.pending;
      if (pending === undefined) {
        return undefined;
      }
      let key = questionNames.get(pending);
      if (key === undefined) {
        questionsNamed += 1;
        key = `sidekick-question:${questionsNamed}`;
        questionNames.set(pending, key);
      }
      return Object.freeze({ key, message: pending.message, form: pending.form });
    }

    /**
     * What this execution's Sidekick says, for one state's own reading.
     *
     * The state rather than the loop's, because a navigation that has not been
     * adopted yet composes its candidate against its own selector: the reading
     * a route is being validated at has to be the reading that route names.
     */
    function sidekickReading(held: ReplState): ReplSidekickReading {
      return sidekickReadingOf(sidekick, askingNow(), held.route.sidekick);
    }

    /**
     * The question this key names, and only while it is still the pending one.
     *
     * The check an answer turns on: a key for a question that has been answered,
     * withdrawn or replaced names nothing, so a keystroke that arrived late
     * submits nothing rather than answering whatever is open now.
     */
    function askedBy(key: string): ReplQuestion | undefined {
      const pending = sidekick.questions.pending;
      if (pending === undefined || questionNames.get(pending) !== key) {
        return undefined;
      }
      return pending;
    }

    // Its own questions, into the same queue. A reply asking one is published
    // by a provider in the owner's scope while the loop is waiting on a key
    // that is not coming: without this the question would sit unannounced until
    // somebody happened to press something. Subscribed before any message can
    // publish one, and released with this scope.
    yield* spawn(function* asking(): Operation<void> {
      const changes = yield* sidekick.questions.changes;
      while (true) {
        const next = yield* changes.next();
        if (next.done === true) {
          return;
        }
        wakes.send({ kind: "session" });
      }
    });

    // Its own changes, into the one queue the loop waits on. A reply arriving,
    // an automatic follow-up starting, a cycle failing and a joined Stop are
    // all things no keystroke announces — without this they would sit unseen
    // until the person happened to press a key. The notification carries
    // nothing and grants nothing: the loop reads the owner afresh.
    yield* spawn(function* chat(): Operation<void> {
      const changes = yield* sidekick.changes;
      while (true) {
        const next = yield* changes.next();
        if (next.done === true) {
          return;
        }
        wakes.send({ kind: "session" });
      }
    });

    /**
     * Apply whatever the submission work finished with.
     *
     * Drained by the loop rather than applied from inside that work, because
     * the draft and the reading are the loop's: one writer is the whole point
     * of having a loop. Called once per batch, after the wakes in it have been
     * taken, so a submission that finished while nobody was typing is applied
     * on the same pass as one that finished under a keystroke.
     *
     * It is the last word on the refusal showing, because it is the newest
     * fact: an action taken earlier in the batch did not know how this ended.
     */
    function applyReports(): void {
      for (const report of admitting.reported.splice(0)) {
        if (admitting.held === report.held) {
          admitting.held = undefined;
        }
        if (report.kind === "admitted") {
          reading = { model: current.model, navigation: current.navigation };
          // The entry exists now, so the draft that became it is finished — and
          // only the revision it was taken from. Somebody who typed while the
          // preflight was running keeps what they typed.
          state = admitted(state, report.held);
          continue;
        }
        // A refusal leaves the draft exactly as it was and the history as it
        // was: nothing was admitted, so there is nothing to undo.
        //
        // Two different refusals arrive here and only one of them goes stale.
        // The readiness refusing is true of a moment: the entry it named
        // finishes and it stops being true. A document that cannot be admitted
        // is true of the document, and readiness moving on does not make it
        // admissible — dropping that one would take away the only explanation
        // of why the draft is still sitting there.
        state = Object.freeze({ ...state, refusal: report.refusal });
        refusedByReadiness = report.byReadiness;
      }
    }

    /**
     * Mount the controls this screen now offers, without drawing a frame.
     *
     * The two steps a commit takes before it draws — measure, then apply the
     * admitted descriptions — and no others. Nothing is presented, no target
     * map is published and no frame is acknowledged: the batch still owns the
     * frame it paints at the end, and a pointer arriving later in this burst is
     * still resolved against the frame that produced its coordinates, so a
     * control mounted here cannot be activated by stale coordinates.
     *
     * It exists because a burst is one frame but not one tree. Run and the
     * Shift-Tab that reaches back for Pause arrive together, and the tree is
     * what answers the second of them.
     */
    function* remount(): Operation<void> {
      const at = yield* screen.size();
      const ready = yield* prepareFrame(
        renderer,
        yield* build(
          state,
          reading,
          current,
          at,
          focused,
          preparingOf(admitting),
          sidekickReading(state),
        ),
        fits,
        chatFits,
        messageFits,
        guidanceFits,
      );
      if (!ready.ok) {
        throw ready.error;
      }
      // Only what was admitted, exactly as a commit mounts it: a control the
      // measured row cannot hold whole is not in the tree here either, so what
      // the next key can reach is what the next frame will draw.
      const applied = yield* tree.apply(ready.value.presentation.descriptions);
      if (!applied.ok) {
        throw applied.error;
      }
    }

    /**
     * Take one normalized event through the tree and apply whatever it asked for.
     *
     * One place, because a keystroke and a pointer landing on the same control
     * mean the same thing: two copies of this sequence is two places an outcome
     * can be forgotten in, and a pointer that quietly skipped one of them would be
     * a control that behaves differently depending on how it was reached.
     *
     * Answers with whether the person asked to leave. Ending the command is the
     * loop's to do — it owns the scope — so this reports it rather than performing
     * it.
     */
    function* act(event: ReplInputEvent): Operation<boolean> {
      const dispatched = yield* tree.dispatch(event);
      if (!dispatched.ok || dispatched.value.outcome !== "action") {
        // A traversal has already moved focus in the tree. Taking it now means
        // the frame below is composed with the focus that is actually held —
        // the alternative is a frame marking the control the reader has just
        // left, followed by a second whole frame correcting it.
        if (dispatched.ok && dispatched.value.outcome === "focus") {
          focused = keyOfFocus(tree);
        }
        return false;
      }
      // Measured for the size and the reading this action is being answered at,
      // before the action runs. A scroll moves from the clamp the screen is
      // showing, so the capacity it moves within has to be this frame's and not
      // the one a resize or a filter left behind. This preparation subscribes to
      // no frame and acknowledges nothing — it is a question about geometry.
      //
      // Only the actions that ask the question pay for the answer. Typing into
      // the draft moves no window, and measuring the reading beside it was the
      // single most expensive thing a keystroke did.
      let geometry = NOTHING_ADMITTED;
      if (readsGeometry(dispatched.value.action)) {
        const ready = yield* prepareFrame(
          renderer,
          yield* build(
            state,
            reading,
            current,
            yield* screen.size(),
            focused,
            preparingOf(admitting),
            sidekickReading(state),
          ),
          fits,
          chatFits,
          messageFits,
          guidanceFits,
        );
        if (!ready.ok) {
          throw ready.error;
        }
        geometry = ready.value.admission;
      }
      const transition = reduceRepl(
        state,
        dispatched.value.action,
        reading.model,
        liveOf(current, preparingOf(admitting), sidekickReading(state)),
        geometry,
        presenting,
      );
      state = transition.state;
      const performed = yield* perform(
        transition.intent,
        current,
        execution,
        options,
        wakes,
        // The facts the reduction just decided on, not a fresh read: the slot
        // is reserved against the text the person actually submitted.
        draftFacts(),
        admitting,
        reopening,
        {
          owner: sidekick,
          dispatch,
          refuse(refusal: string): void {
            sidekickReports.push({ kind: "refused", refusal });
          },
          asked: askedBy,
          *admit(kind, conversation, work): Operation<string | undefined> {
            const busy = admissions.occupied(kind);
            if (busy !== undefined) {
              return busy;
            }
            // The conversation it names has to be the one this owner is
            // continuing, checked before the job starts rather than stored and
            // trusted: a drawer opened for one conversation cannot be applied
            // to another, and a reply that finished and opened a new one while
            // somebody was reaching for Apply would otherwise be configured by
            // it.
            if (conversation !== undefined) {
              const known = sidekick.reading;
              if (!known.ok || known.value.active !== conversation) {
                return "the Sidekick is no longer on that conversation.";
              }
            }
            // Reserved before the spawn, so nothing between the check above and
            // the task below can take the job.
            const reserved = admissions.configure(kind, conversation);
            if (!reserved.ok) {
              return reserved.error.message;
            }
            const job = reserved.value;
            job.task = yield* spawn(function* (): Operation<void> {
              try {
                yield* work();
              } finally {
                admissions.releaseConfiguration(job);
                wakes.send({ kind: "session" });
              }
            });
            return undefined;
          },
          inspected(conversation, model, read): void {
            sidekickReports.push({ kind: "inspected", conversation, model, read });
          },
          unavailable(conversation, reason): void {
            sidekickReports.push({ kind: "unavailable", conversation, reason });
          },
          saved(conversation, revision, answer): void {
            sidekickReports.push({ kind: "saved", conversation, revision, answer });
          },
          replaced(conversation, revision, answer): void {
            sidekickReports.push({ kind: "replaced", conversation, revision, answer });
          },
          retrying(conversation, message): Result<{ text: string; held: Instruction }> {
            const blocked = admissions.occupied("message");
            if (blocked !== undefined) {
              // Refused before the saved text is even resolved: a retry that
              // wrote its record and then failed would leave this history
              // claiming a request nobody could have sent.
              return Err(new Error(blocked));
            }
            const known = sidekick.reading;
            if (!known.ok) {
              return known;
            }
            const saved = retryable(known.value, conversation, message);
            if (!saved.ok) {
              return saved;
            }
            // The same one cycle a Send takes, at the draft revision this
            // instruction was given at: a retry is an explicit instruction, so
            // it acknowledges before a reply's fill under the existing rule.
            const held: Instruction = {
              message: state.revisions.message,
              draft: state.revisions.draft,
              // Out of the history, not out of the box: this acknowledgement
              // clears no message text, because it never carried any.
              from: "saved",
            };
            return Ok({ text: saved.value, held });
          },
        },
        (refusal: string): void => {
          sidekickReports.push({ kind: "refused", refusal });
        },
      );
      if (performed.answered !== undefined) {
        // The question took it, so the drawer that was asking is over. The model
        // here is the history without this answer in it yet, which is what makes
        // the record it adds recognisable.
        state = answered(state, reading.model, performed.answered);
      }
      if (performed.settled !== undefined) {
        // The authority answered it, so the request is gone and the drawer over it
        // goes too.
        state = permissionSettled(state, performed.settled);
      }
      if (performed.messages !== undefined) {
        // Still the same question. What the schema said goes under the form, and
        // every value stays where it was typed.
        state = Object.freeze({
          ...state,
          form: Object.freeze({ ...state.form, messages: Object.freeze([...performed.messages]) }),
        });
      }
      if (performed.askingAnswered === true) {
        // The question took it, so the form is over and its drawer with it.
        // Focus goes back to the box: the answer control has gone, and the
        // Sidekick's own composer is where somebody is next.
        state = Object.freeze({
          ...state,
          asking: undefined,
          restore: Object.freeze({ kind: "message" }),
          refusal: undefined,
        });
      }
      if (performed.askingMessages !== undefined && state.asking !== undefined) {
        // Still the same question. What the schema said goes under that form,
        // and every value stays where it was typed.
        state = Object.freeze({
          ...state,
          asking: Object.freeze({
            ...state.asking,
            form: Object.freeze({
              ...state.asking.form,
              messages: Object.freeze([...performed.askingMessages]),
            }),
          }),
        });
      }
      if (performed.refusal !== undefined) {
        state = Object.freeze({ ...state, refusal: performed.refusal });
        refusedByReadiness = performed.refusedByReadiness === true;
      } else if (transition.state.refusal === undefined) {
        // The action was taken, or refused for its own reasons and then cleared.
        // Either way whatever the readiness last refused is not what is showing.
        refusedByReadiness = false;
      }
      if (performed.remounted === true) {
        // Before this call returns, so the next event of the burst is dispatched
        // against the controls that are now offered rather than the ones that
        // were. Waiting for the end-of-batch paint is too late: the key that
        // reaches for the new control has already been taken out of the queue.
        yield* remount();
      }
      return performed.exited === true;
    }

    let focused: string | undefined;
    // Composed per frame: every branch below leaves `state` and `reading` such
    // that this reproduces the view it resolved, at whatever size the terminal
    // turns out to be when the frame is drawn. It recomposes from the reading
    // that was resolved, never from the session again: a resize between
    // resolution and commit would otherwise pair this content with navigation
    // taken from a later snapshot.
    let broken: string | undefined;
    const compose: ReplCompose = function* (at): Operation<ReplView> {
      return broken === undefined
        ? yield* build(
            state,
            reading,
            current,
            at,
            focused,
            preparingOf(admitting),
            sidekickReading(state),
          )
        : refusedView(state, broken, at, focused);
    };
    const first = yield* paint(
      frames,
      tree,
      renderer,
      screen,
      compose,
      fits,
      chatFits,
      messageFits,
      guidanceFits,
    );
    rendered = first.rendered;
    presenting = presentedDrawer(first.view);
    // The first frame has the same obligation as every other one: draw again
    // only if the tree settled focus somewhere the frame did not mark.
    const settled = keyOfFocus(tree);
    if (settled !== focused) {
      focused = settled;
      const marked = yield* paint(
        frames,
        tree,
        renderer,
        screen,
        compose,
        fits,
        chatFits,
        messageFits,
        guidanceFits,
      );
      rendered = marked.rendered;
      presenting = presentedDrawer(marked.view);
    }

    while (true) {
      const taken = yield* wakes.take();
      if (taken.length === 0) {
        return Ok({ location: exitLocation(state), refusal: undefined });
      }

      // What stands now, to return to if what is attempted does not resolve.
      const standing = state;
      let ended = false;
      /** Whether the person asked to leave, as opposed to input having ended. */
      let departing = false;
      for (const wake of taken) {
        // Leaving was decided earlier in this batch, and everything after it is
        // input that arrived before the decision. A wake reader hands over
        // everything the terminal had, so a submission typed ahead of the
        // interrupt is in the same batch as it — and acting on one would start an
        // entry, answer a question or settle a permission on behalf of somebody
        // who has already asked to stop. The decision is enforced here because
        // this is the only place that sees the rest of the batch.
        if (departing) {
          break;
        }
        if (wake.kind === "session") {
          reading = { model: current.model, navigation: current.navigation };
        } else if (wake.event.kind === "eof") {
          ended = true;
        } else if (wake.event.kind === "resize") {
          renderer.resize(wake.event.size);
        } else if (wake.event.kind === "pointer") {
          // Resolved only against the frame that produced these coordinates. A
          // stale frame, a node the tree has removed and a target behind a drawer
          // all reach nothing, and the drop happens without an action.
          const aimed =
            rendered === undefined ? undefined : resolvePointer(rendered, wake.event.at);
          if (aimed !== undefined) {
            if (yield* act(aimed)) {
              departing = true;
            }
          }
        } else if (wake.event.kind === "input") {
          const delivered = wake.event.event;
          if (delivered === undefined) {
            continue;
          }
          // Control-C, from wherever it was pressed. Taken here rather than
          // through the tree because no node claims it: ending is this owner's
          // outcome, and a key answered by whichever row happened to have focus
          // would stop meaning the same thing from one screen to the next.
          if (delivered.kind === "key" && delivered.key === "Interrupt") {
            departing = true;
            continue;
          }
          // A window too small to draw in shows a refusal and places no cell, so
          // the `[exit]` control a person would reach for is deliberately not in
          // the frame. Escape is the way out it offers instead, and it is taken
          // here rather than through the tree, which is still holding a screen
          // nothing can show — and would answer Escape by closing a drawer the
          // person cannot see.
          if (
            profileFor(yield* screen.size()) === "too-small" &&
            delivered.kind === "key" &&
            delivered.key === "Escape"
          ) {
            departing = true;
            continue;
          }
          if (yield* act(delivered)) {
            departing = true;
          }
        }
      }

      // Before the reports, because a fill raises the draft revision and an
      // admission clears only the revision it admitted: applied in this order, a
      // reply that filled the draft while its own submission was being prepared
      // keeps what it wrote, exactly as a person typing in that window does.
      // The acknowledgement first: a reply that filled the draft did so after
      // the message that produced it was saved, so the instruction that message
      // settles is applied before the fill queued behind it. Then the fills,
      // then the admissions — a fill raises the draft revision and an admission
      // clears only the revision it admitted, so in this order a reply that
      // filled while its own submission was being prepared keeps what it wrote.
      applySidekickReports();
      sidekickRoot.applyFills();
      applyReports();
      // And the question, once this batch has been applied: a question that
      // ended takes its form and its presentation with it, a different one
      // starts empty, and the same one keeps both — through close, tab changes,
      // History selection and resizing alike. Here rather than in a reduction
      // because publication is the owner's, not a keystroke's.
      state = askingFor(state, askingNow());

      if (departing) {
        // The configuration job first, before the return below unwinds the scope
        // that owns the writer and the provider. A save already reaching the
        // file is seen through to its record and this writer's memory of it; one
        // still waiting its turn is cancelled and publishes nothing.
        yield* releasing();
        // Asked for, so there is nothing more to show: the next thing this person
        // sees is their shell. Returning here unwinds the scope that owns the
        // session, the observer, every entry task, the reader and the frame
        // subscription, and joins all of them before the outcome is handed back.
        //
        // Before the frame rather than after it, because a frame is drawn on an
        // acknowledged tick and a settled screen schedules no timer — so a last
        // frame nobody will look at can wait for a tick that never comes, and a
        // person who asked to leave would still be here.
        return Ok({ location: exitLocation(state), refusal: undefined });
      }

      // A request nobody answered can still stop existing: the turn that was
      // waiting was torn down, or it published. The drawer over it can then
      // resolve to nothing, so it is withdrawn here rather than left to fail
      // resolution — and nothing claims a choice or a denial, because none was
      // made.
      if (
        state.permission !== undefined &&
        !current.agent.requests.some((request) => request.key === state.permission)
      ) {
        state = permissionWithdrawn(state);
      }

      // A question that has gone while its drawer was up. Teardown and a
      // settlement elsewhere can both end one, and the drawer over it then
      // resolves to nothing — so it is withdrawn here rather than left to fail
      // resolution, and nothing becomes an answer, because none was given.
      if (
        state.route.drawers.some((drawer) => drawer.kind === "live-elicit") &&
        current.overlay.question === undefined
      ) {
        state = elicitWithdrawn(state);
      }

      // A route that names a history position needs the model projected *at* that
      // position: a prefix is a different reading of the same file rather than a
      // filter over the head. Reprojected, then verified — and a route that does
      // not resolve there leaves the standing one exactly as it was.
      //
      // One reading answers both halves, taken before the size read below it.
      // The size read suspends, and a record can arrive while it does: content
      // taken before it and navigation taken after it would describe two
      // different files on one screen.
      const attempted = reproject(state, reading, current);
      const drawnAt = yield* screen.size();
      // The whole file, including the part before the position asked for, is
      // unreadable. There is no prefix for a notice to stand beside, so what
      // this draws is the refused view itself — the same screen a cold open
      // of the same file shows — and the standing reading is not adopted.
      broken = attempted.broken?.message;
      let adopting = attempted.state;
      let candidate = attempted.reading;
      let built =
        broken !== undefined
          ? undefined
          : viewFor(
              adopting,
              candidate.model,
              liveOf(current, preparingOf(admitting), sidekickReading(adopting)),
              drawnAt,
              focused,
              candidate.navigation,
            );
      if (built !== undefined && !built.ok) {
        // A position earlier than the selected entry's admission has no such
        // entry in it. The position is what was asked for, so the invalid entry
        // and scope suffix goes and nothing guesses a replacement — the draft,
        // the surface, the conversation filter and the marker all stand.
        const cleared = withoutAbsentEntry(adopting, candidate.model);
        if (cleared !== undefined) {
          const without = viewFor(
            cleared,
            candidate.model,
            liveOf(current, preparingOf(admitting), sidekickReading(cleared)),
            drawnAt,
            focused,
            candidate.navigation,
          );
          if (without.ok) {
            adopting = cleared;
            built = without;
          }
        }
      }
      if (broken !== undefined) {
        state = Object.freeze({ ...standing, refusal: broken });
      } else if (built !== undefined && built.ok) {
        state = adopting;
        reading = candidate;
        // The readiness may have moved while that refusal was on the screen: the
        // entry it named has finished, or the teardown it named has completed.
        // A refusal that is no longer true is worse than no refusal, because it
        // contradicts the sentence above it — and a person reading both has to
        // guess which half of their screen is current.
        if (
          refusedByReadiness &&
          state.refusal !== undefined &&
          admitsSubmission(readinessOf(built.value))
        ) {
          state = Object.freeze({ ...state, refusal: undefined });
          refusedByReadiness = false;
        }
      } else if (built !== undefined) {
        // The route did not resolve at that position. The standing reading is
        // kept and the reason is said beside it: unlike the refusal above,
        // there *is* a reading to stand beside.
        state = Object.freeze({ ...standing, refusal: built.error.message });
        const back = reproject(state, reading, current);
        if (back.broken === undefined) {
          reading = back.reading;
        }
      }
      const painted = yield* paint(
        frames,
        tree,
        renderer,
        screen,
        compose,
        fits,
        chatFits,
        messageFits,
        guidanceFits,
      );
      rendered = painted.rendered;
      presenting = presentedDrawer(painted.view);
      // Focus is read against the view that was committed, which a resize may
      // have rebuilt from the one resolved above.
      const view = painted.view;
      // Focus is the tree's answer, and the tree only answers after the commit —
      // so a frame built before it can be marking the wrong control. When it has
      // moved, draw once more with where it actually is. Otherwise the marker is
      // always one keystroke behind, and a person reaching for a control would be
      // acting on the one after it.
      let settledFocus = keyOfFocus(tree);
      // A focus claim this commit satisfied is spent here, at the commit that
      // satisfied it: what the tree answers is the only thing that says whether
      // the control a claim named actually took it.
      state = focusSettled(view, settledFocus, painted.admission);
      if (settledFocus !== focused) {
        focused = settledFocus;
        const again = yield* paint(
          frames,
          tree,
          renderer,
          screen,
          compose,
          fits,
          chatFits,
          messageFits,
          guidanceFits,
        );
        rendered = again.rendered;
        presenting = presentedDrawer(again.view);
        settledFocus = keyOfFocus(tree);
        state = focusSettled(again.view, settledFocus, again.admission);
        focused = settledFocus;
      }
      if (ended) {
        // Ending is a lifecycle outcome, whether end of input or `[exit]` brought
        // it about: the last frame is drawn, and then the command is over. Nothing
        // is appended for it, and returning here unwinds the scope that owns the
        // session, the observer, every entry task and the terminal.
        return Ok({ location: exitLocation(state), refusal: undefined });
      }
    }
  });

  return outcome;
}

/**
 * The location to print on the way out.
 *
 * The route a person left, minus the drawers only this process could have
 * mounted. A waiting question and a pending request are in no history, so a
 * location naming one reopens into a refusal — which makes the one thing this
 * command prints the one thing it cannot be handed back. Everything a second
 * process can reconstruct stays: the position, the surface, the selected entry,
 * the conversation filter and the draft.
 */
function exitLocation(state: ReplState): string {
  return encodeLocation(withoutLiveDrawers(state).route);
}

/**
 * The model the route asks for, projected at the position it names.
 *
 * Returns the state unchanged when the file cannot be read at that position, with
 * the reason, so a caller can decide between adopting and restoring rather than
 * being handed a half-applied navigation.
 */
function reproject(
  state: ReplState,
  reading: ReplReading,
  session: ReplSession,
): {
  readonly state: ReplState;
  readonly reading: ReplReading;
  readonly broken: Error | undefined;
} {
  const read = session.reading(state.route.at);
  // A file this process can no longer read is not a position to carry on at.
  // It is returned rather than folded into a route notice, because the two
  // are different screens: a notice stands beside a reading, and this has
  // none to stand beside.
  return read.ok
    ? { state, reading: read.value, broken: undefined }
    : { state, reading, broken: read.error };
}

/** The key of whatever holds focus now, or none. */
function keyOfFocus(tree: ReplTree<ReplAction>): string | undefined {
  const node = tree.focused();
  return node === undefined ? undefined : tree.keyOf(node);
}

/**
 * This process's overlay, as the application reads it.
 *
 * Everything this process knows and no record holds. What a reading frozen at
 * a recorded position leaves out of it is stated once, in `viewFor`, rather
 * than decided again here.
 */
function liveOf(
  session: ReplSession,
  preparing?: ReplPreparing,
  /** What this execution's Sidekick says, where the screen has one. */
  sidekick?: ReplSidekickReading,
): ReplLive {
  return {
    output: session.overlay.output,
    question: session.overlay.question,
    expansion: session.expansion.state,
    pausable: session.controller !== undefined,
    running: session.live,
    agent: session.agent,
    lifecycle: session.lifecycle,
    // Only where a submission is actually in flight, because the facts and the
    // capability come from different owners: the session answers for the entry
    // it is running, and this screen answers for the submission it has not got
    // an answer about yet.
    ...(preparing === undefined ? {} : { preparing }),
    ...(sidekick === undefined ? {} : { sidekick }),
  };
}

/** How far one chat's setup got, as its own conversation record says. */
function setupOf(
  known: SidekickReading,
  reading: string | undefined,
): ReplSidekickSetup | undefined {
  const found = known.conversations.find((one) => one.id === reading);
  if (found === undefined) {
    return undefined;
  }
  return Object.freeze({ phase: found.phase, failure: found.failure });
}

/**
 * What the Sidekick says, as detached rows the screen can draw.
 *
 * Read afresh every time a frame is built, and copied out of the owner's
 * projection rather than carried: a snapshot held beside the loop would be one
 * frame behind the chat it is drawing. Only the active conversation's chat, in
 * record order — a reader is in one conversation, and the earlier ones are its
 * history rather than its transcript.
 *
 * Nothing here is a capability. No handle, no response, no operation and no
 * writer: a row carries what it says and the root is the only thing that can
 * act on it.
 */
function sidekickReadingOf(
  owner: SidekickOwner,
  /** The question this conversation is waiting on, as the screen names it. */
  question: ReplSidekickQuestion | undefined,
  /**
   * The saved chat this location selected, or none to follow the current one.
   *
   * The route's, because which chat is read is a route decision and this is
   * where the two readings are composed. It is validated before a session is
   * opened and again by every navigation, so a selector that reaches here
   * names a chat this history actually holds.
   */
  selected: string | undefined,
): ReplSidekickReading {
  const read = owner.reading;
  if (!read.ok) {
    return Object.freeze({
      chat: Object.freeze([]),
      turns: Object.freeze([]),
      busy: owner.busy,
      agent: owner.agent,
      refusal: read.error.message,
      question,
      // An unreadable history says nothing about what was asked for or applied.
      // Reporting a remembered preference beside a refusal would be reporting
      // it out of a history this process can no longer read.
      requested: undefined,
      verified: undefined,
      conversation: undefined,
      reading: undefined,
      // An unreadable history establishes no chat's setup either.
      setup: undefined,
      // There is no chat to be current, and nothing a location may name: a
      // refusal is carried through as the refusal it is rather than as an
      // execution that happens to hold no conversations.
      current: true,
      availability: Object.freeze({
        chats: Object.freeze([]),
        sessions: Object.freeze([]),
        refusal: read.error.message,
      }),
    });
  }
  const active = read.value.active;
  // Which chat these rows are of. The selector pins it; omission follows the
  // current association, which is what a person who has not chosen is reading.
  const reading = selected ?? active;
  return Object.freeze({
    chat: sidekickChatRows(read.value, owner.previewing),
    // What the replies of this history actually did to this execution's
    // entries, as the coordinates their records hold. Detached from the chat
    // beside it: a row is what a conversation said, and these are what one of
    // them admitted.
    submits: Object.freeze(
      read.value.submits.map((one) =>
        Object.freeze({
          conversation: one.conversation,
          response: one.response,
          ordinal: one.ordinal,
          entry: one.entry,
          source: one.source,
          settled: one.settled,
          admitted: one.admitted,
        }),
      ),
    ),
    turns: sidekickTurnRows(read.value, owner.live),
    busy: owner.busy,
    // The agent of the chat being read, which is that chat's own: a
    // conversation never changes agent in place, so an older one says what
    // actually answered in it rather than what is selected now.
    agent: read.value.conversations.find((one) => one.id === reading)?.agent ?? owner.agent,
    refusal: undefined,
    question,
    // What was asked for, read back out of the history rather than out of
    // anything this process remembered.
    requested: requestedBy(read.value, active),
    // And what an agent was actually verified on, which is Core's own saved
    // account of a turn that started. Two different facts, shown as two.
    verified: read.value.conversations.find((one) => one.id === active)?.verified,
    conversation: active,
    reading,
    // The setup facts of the chat being read, which an older or interrupted
    // one carries as much as the current one does.
    setup: setupOf(read.value, reading),
    // Omission follows the current chat, so it is always current — including
    // before this Sidekick has opened one at all, where the composer is for
    // the conversation the first message would establish. An explicit selector
    // is current only where it names the actual active association; every
    // other saved chat is a reading of acknowledged history and is read-only.
    current: selected === undefined || selected === active,
    availability: sidekickAvailability(read.value, owner.observed, owner.live),
  });
}

/**
 * What a location may name about one Sidekick reading.
 *
 * One function for the cold validation before a session is opened and for the
 * running screen, so a key a filter offers is a key a location resolves and a
 * chat a row opens is a chat a copied location reopens.
 *
 * Saved chats come from this history's own order. Provider conversations come
 * from the saved turns that actually name one, then from this owner's exact
 * live facts — an ephemeral key stays known for the owner's lifetime so a
 * selected filter does not become guessed emptiness when its attempt stops,
 * and a cold reader of the files establishes none of it.
 */
function sidekickAvailability(
  known: SidekickReading,
  observed: readonly string[] = [],
  live: SidekickLiveTurn | undefined = undefined,
): ReplSidekickAvailability {
  const sessions: string[] = [];
  for (const turn of known.turns) {
    if (turn.sessionKey !== undefined && !sessions.includes(turn.sessionKey)) {
      sessions.push(turn.sessionKey);
    }
  }
  for (const key of [...observed, ...(live?.sessionKey === undefined ? [] : [live.sessionKey])]) {
    if (!sessions.includes(key)) {
      sessions.push(key);
    }
  }
  return Object.freeze({
    chats: Object.freeze(known.conversations.map((one) => one.id)),
    sessions: Object.freeze(sessions),
    refusal: undefined,
  });
}

/**
 * The Sessions rows one Sidekick reading and the turn in flight compose into.
 *
 * Exported for the same reason the chat rows are: this is where the screen's
 * own account of a Sidekick turn is decided — which rows exist, and which of
 * them are the same item — and that is worth checking without a
 * terminal under it.
 *
 * The live row carries the response it was registered under, and a saved turn
 * that produced an evaluated reply carries that same response from its own
 * record — so one turn is one row from the moment it began to the account that
 * replaces it, with nothing inferred. A saved turn with no response record is
 * addressed by the turn it was, except while this process is the one that
 * attempted it: then the row somebody is already watching keeps its identity,
 * which is the same bridge the chat rows use.
 */
export function sidekickTurnRows(
  known: SidekickReading,
  live: SidekickLiveTurn | undefined,
): readonly ReplSidekickTurnRow[] {
  const addressed =
    live !== undefined && live.turn !== null
      ? { conversation: live.conversation, turn: live.turn, response: live.response }
      : undefined;
  const rows: ReplSidekickTurnRow[] = known.turns.map((turn) => {
    const own =
      turn.reply?.response ??
      (addressed !== undefined &&
      addressed.conversation === turn.conversation &&
      addressed.turn === turn.turn
        ? addressed.response
        : undefined);
    const failed = turn.status !== "completed" || turn.reply?.failure !== undefined;
    return Object.freeze({
      key:
        own === undefined
          ? `sidekick:turn:${turn.conversation}:${turn.turn}`
          : `sidekick:${turn.conversation}:${own}`,
      conversation: turn.conversation,
      agent: turn.agent,
      turn: turn.turn,
      title: titleOf(turn.asked, turn.title),
      state: savedState(turn),
      running: false,
      failed,
      sessionKey: turn.sessionKey,
      // What it said to a person: the evaluated Output where a reply recorded
      // one, and the literal Output of what an unfinished attempt streamed.
      // Never its source, its chapters or its feedback envelope.
      text: turn.reply?.hasOutput === true ? turn.reply.output : (turn.incomplete?.output ?? ""),
      failure: turn.reply?.failure ?? turn.incomplete?.failure,
    });
  });
  if (live === undefined) {
    return Object.freeze(rows);
  }
  // The turn in flight, where the acknowledged history does not already hold
  // the row it belongs to. One row either way: the live row carries the key
  // its acknowledged counterpart will, so the two are never both drawn.
  const key = `sidekick:${live.conversation}:${live.response}`;
  if (!rows.some((row) => row.key === key)) {
    rows.push(
      Object.freeze({
        key,
        conversation: live.conversation,
        agent: live.agent,
        turn: live.turn,
        title: titleOf(live.asked, live.title),
        state:
          live.phase === "pending"
            ? "asking"
            : live.phase === "generating"
              ? "generating"
              : "evaluating the reply",
        running: true,
        failed: false,
        sessionKey: live.sessionKey,
        text: live.output,
        failure: undefined,
      }),
    );
  }
  return Object.freeze(rows);
}

/** What one Sidekick turn is called, from what it was actually asked for. */
function titleOf(asked: "person" | "automatic" | undefined, title: string | undefined): string {
  if (asked === "automatic") {
    // Agent work, said as agent work. Its request is this host's own account of
    // what a previous reply did, so it is labelled and never quoted.
    return "Automatic feedback";
  }
  // A turn whose request this history cannot bound says so. Substituting the
  // most recent message would attribute somebody's words to a turn that may
  // never have carried them.
  return title ?? "(request not recorded)";
}

/**
 * How far one saved Sidekick turn got, in words a reader can act on.
 *
 * Three answers, because those are the three a reader has to tell apart. A
 * turn that failed or was cancelled is that, in its own terms. A turn whose
 * evaluated reply was recorded is the result they came for. And a completed
 * turn with no evaluated-response record is neither: the provider finished and
 * nothing says the program it returned was ever run, so the row says exactly
 * that rather than reporting a reply nobody recorded.
 */
function savedState(turn: SidekickSavedTurn): string {
  if (turn.status !== "completed") {
    return turn.status;
  }
  if (turn.reply === undefined) {
    return SAVED_WITHOUT_REPLY;
  }
  return turn.reply.failure === undefined ? "completed" : "reply failed";
}

/**
 * The chat rows one reading and whatever is being said right now compose into.
 *
 * Exported because this is where the screen's own account of a response is
 * decided — which rows exist, and which of them are the same item — and that
 * is worth checking without a terminal under it. It reads facts and
 * returns frozen display data: no record, no handle, no writer, no source.
 */
export function sidekickChatRows(
  known: SidekickReading,
  /** What the response in flight is saying, where one is saying anything. */
  previewing: SidekickPreview | undefined,
): readonly ReplSidekickChatRow[] {
  const active = known.active;
  /**
   * The item this process already has on the screen for a saved attempt.
   *
   * Display bookkeeping and nothing else: a failed turn produces no response
   * record, so the only thing that can keep the row somebody is already
   * watching is this process's own memory of which response it registered for
   * the request that became that turn. Acknowledgement says what the item is
   * showing; it does not rename it. A reader without a live item of its own —
   * a cold reopen, another command — has none of this and addresses the same
   * attempt by the turn it was, which is truthful and distinct either way.
   *
   * It names one conversation as well as one turn. Every chat is composed here,
   * each numbering its turns from one, so a name matched on the number alone
   * would reach the same ordinal in an older chat — and an older chat whose
   * message and turn counts diverged may already hold a saved reply under
   * exactly that response.
   */
  const addressed =
    previewing !== undefined && previewing.conversation === active && previewing.turn !== null
      ? {
          conversation: previewing.conversation,
          turn: previewing.turn,
          response: previewing.response,
        }
      : undefined;
  const chat: ReplSidekickChatRow[] = known.chat
    // Every chat, because which of them is drawn is the reading the location
    // selects: an older chat is read-only and still has to be readable, and a
    // list filtered to the active association could not show one.
    .map((item) => {
      if (item.kind === "incomplete") {
        // What that turn actually streamed, read as a root by the pure preview
        // reader. The record crossed the durable disclosure gate on its way in,
        // so projecting it starts no scan, no provider and no write — and what
        // comes out is literal Output or nothing, never source.
        const projected = previewGeneratedXmdRoot(item.text);
        return Object.freeze({
          // The item this attempt is already being shown in, where this process
          // is the one that attempted it in this chat, and otherwise the saved
          // turn's own identity. A response name is never *recovered* from a
          // turn, and never carried across chats: the
          // owner names a response from the history's own next ordinal, which
          // counts saved requests as well as attempted turns, and Core numbers
          // its turns independently — so an interrupted message is all it takes
          // for the two to differ, and inferring one from the other hands this
          // attempt somebody else's row.
          key:
            addressed !== undefined &&
            addressed.conversation === item.conversation &&
            addressed.turn === item.turn
              ? itemKey(item.conversation, addressed.response)
              : attemptKey(item.conversation, item.turn),
          conversation: item.conversation,
          turn: item.turn,
          kind: item.kind,
          text: projected.ok ? projected.value.output : "",
          hasOutput: false,
          failure: item.failure,
          // The request this attempt failed, where the history can establish
          // which one it was. Asked of the same resolver the activation will
          // use, so a row that offers a retry is a row whose retry can start.
          ...retryOf(known, item.conversation, item.turn),
        });
      }
      if (item.kind === "saved") {
        // A turn the provider finished and whose evaluated reply nobody
        // recorded. Addressed by the turn it was, because that is the only
        // thing its own records hold: there is no response record to name it
        // by, and the response this process registered is this process's name.
        return Object.freeze({
          key: `chat:${item.conversation}:turn:${item.turn}:saved`,
          conversation: item.conversation,
          turn: item.turn,
          kind: item.kind,
          text: item.status,
          hasOutput: false,
          failure: undefined,
          automatic: item.automatic,
        });
      }
      return Object.freeze({
        key:
          item.kind === "person"
            ? messageKey(item.conversation, item.message)
            : itemKey(item.conversation, item.response),
        conversation: item.conversation,
        turn: item.turn,
        kind: item.kind,
        ...(item.kind === "person" ? { origin: item.origin } : {}),
        text: item.text,
        hasOutput: item.kind === "reply" ? item.hasOutput : false,
        // The reply's own retained failure, carried through rather than
        // dropped. Whether a failure is visible is a fact about the evaluation,
        // so it cannot depend on whether the response that failed happened to
        // select any Output.
        failure: item.kind === "reply" ? item.failure : undefined,
        // And the request it answered, where this history establishes one: a
        // reply that says nothing to a person draws no row of its own, and the
        // request is the visible thing a reader sent to that turn can be shown.
        ...(item.kind === "reply" ? requestOf(known, item.conversation, item.turn) : {}),
      });
    });
  // What the response in flight is saying, where the acknowledged history does
  // not already hold the item it belongs to. One item either way: a live row
  // carries the key its acknowledged counterpart will, so the two are never
  // both mounted.
  if (previewing !== undefined && previewing.conversation === active) {
    // Its own identity, settled before the request was handed over and never
    // changed by what became of it: the saved account above takes this row's
    // place by being *in* it, which is why this one is simply not drawn again.
    const key = itemKey(previewing.conversation, previewing.response);
    if (!chat.some((row) => row.key === key)) {
      chat.push(
        Object.freeze({
          key,
          conversation: previewing.conversation,
          turn: previewing.turn,
          kind: "preview",
          text: previewing.output,
          hasOutput: true,
          failure: undefined,
          incomplete: previewing.incomplete,
        }),
      );
    }
  }
  return Object.freeze(chat);
}

/**
 * One attempt's own identity on the screen, by the turn it was.
 *
 * A saved turn is the only thing a reader can address a failed attempt by when
 * it has no live item for it: the attempt produced no response record, and the
 * response the owner had registered is this process's own name rather than
 * anything the history holds. So a cold reopen, or any other command reading
 * this history, says this — and says it of an attempt whichever response the
 * process that made it had in mind.
 */
function attemptKey(conversation: string, turn: number): string {
  return `chat:${conversation}:turn:${turn}:incomplete`;
}

/**
 * One response's own identity on the screen, from its first word to its reply.
 *
 * Process-local view data. The response is registered before the request is
 * handed over and is what the reply records, so Preview, the evaluation and
 * that reply are one item without anything being inferred. It names nothing
 * durable, and it is not a turn — an attempt it ends up showing stays in this
 * item while this process is showing it, and is addressed by the turn it was
 * by everyone else, because that is what its own record holds.
 */
function itemKey(conversation: string, response: string): string {
  return `chat:${conversation}:${response}`;
}

/** One saved message's own identity on the screen, by the ID it was written with. */
function messageKey(conversation: string, message: number): string {
  return `chat:${conversation}:message:${message}`;
}

/**
 * The person request one reply answered, as the row that holds it.
 *
 * For the reveal a Sessions selection asks for, and for nothing else. A
 * successful reply that said nothing to a person has no row of its own, so the
 * visible associated context is the request it answered — its own, or, for a
 * turn carrying a previous response's results, the person request that chain
 * began with. Read from the projection's own request boundaries rather than
 * matched on text or ordinal, and absent wherever the history cannot bound it.
 */
function requestOf(
  known: SidekickReading,
  conversation: string,
  turn: number,
): { readonly request?: string } {
  const answered = known.answers.find(
    (one) => one.conversation === conversation && one.turn === turn,
  );
  return answered === undefined ? {} : { request: messageKey(conversation, answered.message) };
}

/**
 * The saved request one failed turn belongs to, where that is established.
 *
 * Nothing where it is not. A turn whose association is unknown, one that did
 * not fail, or one whose conversation is no longer being continued offers no
 * retry — so a row that shows the control is a row whose control can start,
 * rather than one that refuses when it is pressed.
 */
function retryOf(
  known: SidekickReading,
  conversation: string,
  turn: number,
): { readonly retry?: { readonly conversation: string; readonly message: number } } {
  const asked = known.chat.find(
    (item) => item.kind === "person" && item.conversation === conversation && item.turn === turn,
  );
  if (asked === undefined || asked.kind !== "person") {
    return {};
  }
  return retryable(known, conversation, asked.message).ok
    ? { retry: { conversation, message: asked.message } }
    : {};
}

/** What one conversation has been asked to run under, where it has been. */
function requestedBy(
  known: SidekickReading,
  conversation: string | undefined,
): SessionConfiguration | undefined {
  const asked = known.preferences;
  if (conversation === undefined || asked === undefined || asked.conversation !== conversation) {
    return undefined;
  }
  const request: SessionConfiguration = {
    ...(asked.model === null ? {} : { model: asked.model }),
    ...(asked.effort === null ? {} : { effort: asked.effort }),
  };
  return request.model === undefined && request.effort === undefined ? undefined : request;
}

/**
 * What the screen says about the submission in flight, if there is one.
 *
 * Read from the reservation each time rather than stored beside it: the
 * reservation is the one record of what is being prepared, and a copy of its
 * pause request would be a second answer to "has this been asked to stop".
 */
function preparingOf(admitting: Admitting): ReplPreparing | undefined {
  const held = admitting.held;
  return held === undefined ? undefined : { requested: held.pausing };
}

/** The view for the state that stands, or a refusal naming why there is none. */
function* build(
  state: ReplState,
  reading: ReplReading,
  session: ReplSession,
  size: ReplTerminalSize,
  focused: string | undefined,
  preparing?: ReplPreparing,
  /**
   * What this execution's Sidekick says, read when the frame is asked for.
   *
   * The reading rather than the owner: naming the pending question is the
   * loop's, because the name has to be the same one every frame and every
   * action uses, and only the loop holds that mapping.
   */
  sidekick?: ReplSidekickReading,
): Operation<ReplView> {
  // Both halves from the reading that was resolved, never from the session
  // again. A resize recomposes at a new size, not at a new snapshot.
  const view = viewFor(
    state,
    reading.model,
    liveOf(session, preparing, sidekick),
    size,
    focused,
    reading.navigation,
  );
  // The staged composition, on the screen a person is actually working in.
  // What it shows is read from this execution rather than supplied — the
  // reading this frame was resolved at, and what this execution's Sidekick
  // acknowledged doing to it: see `workspaceOf`.
  return view.ok
    ? withWorkspace(view.value, workspaceOf(reading.model, sidekick))
    : refusedView(state, view.error.message, size);
}

/** Wake the loop whenever this session's history or overlay moves. */
function* watch(session: ReplSession, wakes: Wakes): Operation<void> {
  // How far an Agent turn has got is a fact no record carries until the turn
  // has ended: a queued turn, the text streaming into one, and a permission
  // request waiting on somebody are all live-only. Without this the surface
  // showing them is drawn only when something else happens to wake the loop, so
  // a turn a person is watching appears already finished.
  //
  // Subscribed here, in the scope that outlives the spawn, and drained there.
  // A spawned body starts a turn after the spawn returns, and a turn is long
  // enough for the first of those changes to be sent to nobody.
  const agents = yield* session.agentChanges;
  yield* spawn(function* conversations(): Operation<void> {
    while (true) {
      const next = yield* agents.next();
      if (next.done === true) {
        return;
      }
      wakes.send({ kind: "session" });
    }
  });
  yield* spawn(function* projections(): Operation<void> {
    const changes = yield* session.changes;
    while (true) {
      const next = yield* changes.next();
      if (next.done === true) {
        return;
      }
      wakes.send({ kind: "session" });
    }
  });
  yield* spawn(function* printing(): Operation<void> {
    // Output is the one thing a frame shows that leaves no record behind, so
    // nothing else will ever announce it. A document that only writes
    // reprojects nothing, asks nothing and expands nothing; without this its
    // text would sit in the overlay until some unrelated event happened to
    // draw a frame, and a run that printed and then finished would show it all
    // at the end, which is the opposite of what an overlay is for.
    const changes = yield* session.outputs;
    while (true) {
      const next = yield* changes.next();
      if (next.done === true) {
        return;
      }
      wakes.send({ kind: "session" });
    }
  });
  yield* spawn(function* questions(): Operation<void> {
    const changes = yield* session.elicitation.changes;
    while (true) {
      const next = yield* changes.next();
      if (next.done === true) {
        return;
      }
      wakes.send({ kind: "session" });
    }
  });
  yield* spawn(function* expansion(): Operation<void> {
    const changes = yield* session.expansion.states;
    while (true) {
      const next = yield* changes.next();
      if (next.done === true) {
        return;
      }
      wakes.send({ kind: "session" });
    }
  });
}

/**
 * One normalized issue as a form message.
 *
 * The field is read from the issue's own instance path, so a message sits under
 * the field it is about. An issue about the object as a whole — a missing
 * required name — carries no field and is shown against the form.
 */
function reported(outcome: { readonly issues: readonly NormalizedIssue[] }): ReplFormMessage[] {
  return outcome.issues.map((issue) => {
    const named = /^\/([^/]+)/.exec(issue.instancePath)?.[1];
    const missing =
      issue.keyword === "required" && isObject(issue.params)
        ? issue.params["missingProperty"]
        : undefined;
    const field = named ?? (typeof missing === "string" ? missing : undefined);
    return { ...(field === undefined ? { field: undefined } : { field }), message: issue.message };
  });
}

function isObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What performing one intent produced. */
interface Performed {
  /**
   * The exact object a question took, when one did and is now over.
   *
   * The object rather than a flag: the record it causes appends later, and this
   * is what will tell that record apart from every other answer in the history.
   */
  readonly answered?: Json;
  /**
   * Why the object it was given is not yet an answer.
   *
   * The question is untouched and still pending; these go back into application
   * state so the form a person is looking at can say what is wrong with it.
   */
  readonly messages?: readonly ReplFormMessage[];
  /**
   * Whether the Sidekick's own question took the object it was given.
   *
   * A flag rather than the object, unlike the entry's: an entry's answer
   * appends a record this screen then focuses, and the Sidekick's is delivered
   * to the reply by the existing feedback cycle — there is nothing here for the
   * screen to go and find.
   */
  readonly askingAnswered?: true;
  /** Why the Sidekick's form is not yet an answer, for the form to say. */
  readonly askingMessages?: readonly ReplFormMessage[];
  /**
   * The turn a permission request was really settled for, when one was.
   *
   * Only a successful authority call reports one: the drawer closes because the
   * request it was opened over is gone, and focus returns to the turn that was
   * waiting.
   */
  readonly settled?: string;
  /**
   * Whether the person asked to leave.
   *
   * The same lifecycle outcome end of input produces, so it is reported rather
   * than acted on here: ending the command means returning from the loop that
   * owns the scope, and a helper that tore the scope down from inside it would be
   * cancelling the task it was running in.
   */
  readonly exited?: true;
  /** Why it could not be done, for the screen to say. */
  readonly refusal?: string;
  /**
   * Whether that refusal was this execution's readiness refusing a submission.
   *
   * Reported rather than recognized from the message, because what becomes of a
   * refusal depends on where it came from. One the readiness gave is true only
   * of the moment it was given — the entry it named finishes, the teardown it
   * named completes — so the loop drops it once a submission would be admitted,
   * rather than leave the screen explaining that Entry 1 has not finished above
   * a sentence announcing that Entry 2 may start. Every other refusal is about
   * the action somebody took and stands until they take another.
   */
  readonly refusedByReadiness?: true;
  /**
   * Whether this action changed which controls the screen offers.
   *
   * Reported so the loop can mount them before it dispatches the next event of
   * the same burst. A burst is one frame — that is what keeps a paste from
   * drawing a hundred of them — but it is *not* one tree: a person who presses
   * Run and reaches straight back for Pause sends both keys before anything is
   * drawn, and a tree still describing the screen as it was before Run would
   * answer the second key with whatever control used to be there.
   *
   * Only the actions that change the offer report it. Nothing is redrawn and no
   * frame is acknowledged; the batch still owns the frame it paints at the end.
   */
  readonly remounted?: true;
}

/**
 * Do the one thing a component asked for and cannot do itself.
 *
 * The session is the authority for its own history, so admitting an entry is the
 * one action that produces a different session rather than a different view. A
 * refusal comes back rather than being swallowed: a person who pressed Enter is
 * owed either an entry or a reason.
 */
function* perform(
  intent: ReplIntent,
  session: ReplSession,
  execution: ReplExecution,
  options: ReplProgramOptions,
  wakes: Wakes,
  /**
   * The draft facts the gate decides on, as the reduction that produced this
   * intent saw them. Carried rather than re-derived: a root that read the draft
   * again could reserve a different text from the one the person submitted.
   */
  facts: DraftFacts,
  /** The slot, which the loop owns. */
  admitting: Admitting,
  /** What a reopened history still requires, and the state as it stands. */
  reopening: Reopening,
  /**
   * This execution's Sidekick, and the one cycle the screen reserves for it.
   *
   * The owner is handed in rather than reached: the loop acquired it and the
   * loop owns the task its work is spawned on, so this performs the asking and
   * owns neither the conversation nor the slot.
   */
  chat: {
    readonly owner: SidekickOwner;
    readonly dispatch: SidekickDispatch;
    /** Say why the Sidekick refused, on the next pass of the loop. */
    refuse(refusal: string): void;
    /**
     * Start one explicit configuration job, or say why it cannot start.
     *
     * Reserved synchronously before anything is spawned: two activations in one
     * input burst find the job taken rather than both starting, and a person
     * whose action refuses is told rather than left watching a queue.
     */
    admit(
      kind: "inspect" | "save" | "replace",
      conversation: string | undefined,
      work: () => Operation<void>,
    ): Operation<string | undefined>;
    /**
     * The pending question this key names, or none because it names no longer.
     *
     * The root's own mapping, asked rather than carried: which object a name
     * belongs to is the loop's, and a copy handed down here would answer for a
     * question that had already ended.
     */
    asked(question: string): ReplQuestion | undefined;
    /** Apply what an explicit inspection advertised, for the conversation it was read of. */
    inspected(
      conversation: string | undefined,
      model: string | undefined,
      read: Result<AgentOptions>,
    ): void;
    /** Say in the drawer why an explicit action could not start at all. */
    unavailable(conversation: string | undefined, reason: string): void;
    /**
     * Apply what a preference save answered: closes on success, says why on failure.
     *
     * The selection that asked travels rather than the values it asked with: a
     * drawer reopened on the saved preference holds the same values, and an
     * answer may not close it.
     */
    saved(conversation: string | undefined, revision: number, answer: Result<void>): void;
    /** Apply what a replacement answered, for the selection that asked for it. */
    replaced(conversation: string | undefined, revision: number, answer: Result<void>): void;
    /**
     * The exact text of the saved failed request this names, or why not.
     *
     * Resolved here, against the history as it stands, and reserving the one
     * message cycle in the same breath: a retry that resolved its text and then
     * waited would be sending whatever that message id meant by the time it
     * started.
     */
    retrying(conversation: string, message: number): Result<{ text: string; held: Instruction }>;
  },
  /**
   * Say why something this performed refused, on the next pass of the loop.
   *
   * For the work that is spawned and answers later: the record a person reads
   * is the screen's, and a refusal decided after this returned has no
   * `Performed` left to travel on.
   */
  refuse: (refusal: string) => void,
): Operation<Performed> {
  switch (intent.kind) {
    case "none":
      return {};
    case "exit":
      // Nothing. No append, no close, no cancellation, no denial, no answer: a
      // person leaving has not decided anything that was waiting, and an entry
      // whose root never closed stays unfinished because that is what it is.
      return { exited: true };
    case "pause": {
      // The live entry first, always. An entry that is already expanding keeps
      // its own control, so a submission sitting refused behind it cannot
      // retarget Pause at a successor — and the reservation below is only ever
      // the target while there is no expansion to stop.
      const expanding = session.controller;
      if (expanding !== undefined) {
        expanding.pause();
        wakes.send({ kind: "session" });
        return {};
      }
      if (admitting.held !== undefined) {
        // Recorded against the exact reservation, and read again when that
        // submission's entry starts. Asking twice records the same request, so
        // Pause is idempotent; it withdraws nothing and cancels no work.
        admitting.held.pausing = true;
        wakes.send({ kind: "session" });
        // The row beside Pause now says `pausing` rather than `preparing`, and
        // the next event in this burst is dispatched against what is mounted.
        return { remounted: true };
      }
      // Neither a live expansion nor a preparation: the reduction refuses this
      // before it reaches here, so there is nothing to ask and nothing to say.
      wakes.send({ kind: "session" });
      return {};
    }
    case "continue":
      session.controller?.resume();
      wakes.send({ kind: "session" });
      return {};
    case "send-message": {
      const admitted = yield* chat.dispatch.send(intent.text, intent.held);
      if (!admitted.ok) {
        return { refusal: admitted.error.message };
      }
      yield* spawn(function* (): Operation<void> {
        const sent = yield* admitted.value.completion;
        if (!sent.ok) {
          chat.refuse(sent.error.message);
        }
        wakes.send({ kind: "session" });
      });
      // The row beside the box is `[stop]` now rather than `[send]`, and the
      // next event in this burst is dispatched against what is mounted.
      return { remounted: true };
    }
    case "stop-sidekick": {
      // Spawned for the same reason Send is: Stop joins everything the
      // Sidekick had in flight — the generation, the response's controls, the
      // wait for an entry's outcome — and returns only once all of it has come
      // down. A person who pressed it keeps a usable keyboard while it does.
      const exchange = chat.dispatch.current;
      yield* spawn(function* (): Operation<void> {
        if (exchange !== undefined) {
          yield* exchange.cancel();
        }
        wakes.send({ kind: "session" });
      });
      return { remounted: true };
    }
    case "stop-entry": {
      // Spawned, for the reason the Sidekick's Stop is: this joins everything
      // that entry owned — its root's own cancelled ending, its outcome, its
      // output consumer, its Agent attachment — and answers only once all of
      // it has come down. A person who pressed it keeps a usable keyboard
      // while it does, and the screen wakes when it is over.
      //
      // The key is the one the frame drew the control against. Whether that is
      // still the entry running, whether the history has acknowledged it and
      // whether a stop may start at all are the session's answers, not this
      // branch's: a refusal comes back and is shown rather than guessed at
      // here.
      const stopping = intent.entry;
      yield* spawn(function* (): Operation<void> {
        const stopped = yield* session.stopEntry(stopping);
        if (!stopped.ok) {
          refuse(stopped.error.message);
        }
        wakes.send({ kind: "session" });
      });
      // The row beside the field is what this frame left mounted; the next
      // event in this burst is dispatched against that.
      return { remounted: true };
    }
    case "answer": {
      // An object the schema rejects is not an answer: the question stays open,
      // nothing is appended, and the drawer stays up holding what was filled in
      // so it can be corrected. Only a valid object ends the question, and the
      // route has to end with it.
      //
      // The schema decides, through the same compiled validator the request
      // carries. Nothing here reads the form or judges a value.
      const outcome = session.overlay.question?.submit(intent.values);
      wakes.send({ kind: "session" });
      if (outcome === undefined) {
        return {};
      }
      return outcome.kind === "answered"
        ? { answered: outcome.answer }
        : { messages: reported(outcome) };
    }
    case "answer-sidekick": {
      // The one question this key names, checked here and nowhere else. A key
      // for a question that has since been answered, withdrawn or replaced
      // names nothing — so a keystroke that arrived late submits nothing rather
      // than answering whatever is open now with values typed for something
      // else.
      const asked = chat.asked(intent.question);
      wakes.send({ kind: "session" });
      if (asked === undefined) {
        return {};
      }
      // The schema decides, through the same compiled validator the request
      // carries, and the existing canonical operation writes the answer. This
      // reads no form and judges no value.
      const outcome = asked.submit(intent.values);
      return outcome.kind === "answered"
        ? { askingAnswered: true }
        : { askingMessages: reported(outcome) };
    }
    case "inspect-configuration": {
      const asked = intent.model;
      const refused = yield* chat.admit("inspect", intent.conversation, function* () {
        // Explicitly asked for, and it is the one thing here that really
        // contacts the agent: the provider takes a session of its own for it,
        // sends no prompt and journals nothing. The model travels because
        // effort belongs to one: asked about a model, the agent answers with
        // that model's levels.
        const read = yield* chat.owner.options(asked === undefined ? undefined : { model: asked });
        chat.inspected(intent.conversation, asked, read);
      });
      if (refused !== undefined) {
        // Said in the drawer, which is what the person pressed: a reason that
        // appeared beside the chat instead would read as the control doing
        // nothing at all.
        chat.unavailable(intent.conversation, refused);
        wakes.send({ kind: "session" });
        return {};
      }
      return { remounted: true };
    }
    case "save-configuration": {
      const desired = {
        ...(intent.model === undefined ? {} : { model: intent.model }),
        ...(intent.effort === undefined ? {} : { effort: intent.effort }),
      };
      const refused = yield* chat.admit("save", intent.conversation, function* () {
        // A record in this history and nothing else: no handle, no provider
        // call and no turn. So it is taken while a message cycle runs, and the
        // turn already in flight keeps the settings it was handed.
        const saved = yield* chat.owner.configure(desired);
        chat.saved(intent.conversation, intent.revision, saved);
      });
      if (refused !== undefined) {
        chat.unavailable(intent.conversation, refused);
        wakes.send({ kind: "session" });
        return {};
      }
      return { remounted: true };
    }
    case "replace-agent": {
      const refused = yield* chat.admit("replace", intent.conversation, function* () {
        // Stop first, and joined, whenever there is something running. An
        // established conversation never changes agent in place, so what was in
        // flight has to come down before another conversation starts — and
        // `select()` refuses outright while it is still up, which is why this
        // waits rather than trying and reporting the refusal.
        if (chat.owner.busy) {
          yield* chat.owner.stop();
        }
        // Explicitly a new conversation. The old chat and its association stay
        // where they are; a failed setup leaves the old one active and says why.
        const switched = yield* chat.owner.select(intent.agent);
        chat.replaced(intent.conversation, intent.revision, switched);
      });
      if (refused !== undefined) {
        chat.unavailable(intent.conversation, refused);
        wakes.send({ kind: "session" });
        return {};
      }
      return { remounted: true };
    }
    case "retry-message": {
      // The same one cycle a Send reserves, synchronously and before anything
      // is spawned: a second Retry in the same burst finds it held.
      const asked = chat.retrying(intent.conversation, intent.message);
      if (!asked.ok) {
        return { refusal: asked.error.message };
      }
      const admitted = yield* chat.dispatch.send(asked.value.text, asked.value.held);
      if (!admitted.ok) {
        return { refusal: admitted.error.message };
      }
      yield* spawn(function* (): Operation<void> {
        const sent = yield* admitted.value.completion;
        if (!sent.ok) {
          chat.refuse(sent.error.message);
        }
        wakes.send({ kind: "session" });
      });
      return { remounted: true };
    }
    case "settle-permission": {
      // The authority's answer, once. It is asked here and nowhere else: a
      // surface that could settle a request would hold the capability that
      // denies one, and this is the only thing that has it.
      //
      // An unknown, stale or already-settled key settles nothing and says so by
      // answering false, and the drawer stays exactly as it is — a screen that
      // closed on a call that did nothing would be claiming a decision.
      const settled =
        intent.option === undefined
          ? session.permissions.dismiss(intent.request)
          : session.permissions.choose(intent.request, intent.option);
      wakes.send({ kind: "session" });
      return settled ? { settled: intent.turn } : {};
    }
    case "submit": {
      // The slot first, and synchronously: nothing between this decision and
      // the reservation suspends, so a second submitter arriving in the same
      // turn finds the slot held rather than taking it alongside.
      if (reopening.blocked !== undefined) {
        // The two files disagree about what became of a reservation a previous
        // process took, and admitting on top of that would be choosing between
        // them. The draft stays exactly where it is.
        return { refusal: reopening.blocked };
      }
      // Named from the acknowledged history as it stands, which is what a
      // reopening reconciles the reservation against — and the same basis the
      // Sidekick reserves on, so the two submitters cannot disagree about what
      // the next entry is called. Not `session.model`: that is the projection
      // of wherever this session was opened, and merely having opened at an
      // earlier position does not rename the next entry.
      const acknowledged = session.reading(undefined);
      if (!acknowledged.ok) {
        // Read and refused, before the slot is touched. A history this process
        // cannot read is not an empty one.
        return { refusal: acknowledged.error.message };
      }
      const preceding = acknowledged.value.model.entries.length;
      const taken = take(
        "person",
        facts,
        {
          entry: entryKey(preceding + 1),
          ordinal: preceding,
        },
        admitting,
      );
      if (!taken.ok) {
        return { refusal: taken.error.message };
      }
      const held = taken.value;
      // Spawned, so the loop returns to the keyboard now. Preflight suspends —
      // a component read, an import, a provider — and the person who pressed
      // Run must be able to keep typing, press Stop, or walk back through the
      // history while it does.
      //
      // Attached to the loop's own task rather than to this call, so the work
      // outlives the keystroke that asked for it and dies with the command.
      yield* spawn(function* () {
        // The session this command already owns, rather than a second one. It
        // holds the one observer on the file and the one entry task, so an
        // entry is admitted *into* it — there is nothing here to watch again.
        //
        // Readiness stays the session's to answer, and it answers it again at
        // the moment the entry actually starts. This gate decided the slot and
        // the draft; it does not hold a second opinion about whether the entry
        // before this one has finished.
        // The pause request goes with the submission, as a question the entry
        // asks when it starts rather than a flag copied now: Pause can be
        // pressed throughout the preflight this call is about to suspend in.
        // Before the entry this action is about to admit, so the question the
        // next process would ask is answered while its answer is still
        // findable. It submits nothing and re-runs nothing.
        yield* reopening.settle();
        const submitted = yield* session.submit(
          held.source,
          () => held.pausing,
          // Asked at the entry's actual start, against the draft as it is by
          // then. Everything the reservation rested on can have moved while the
          // preflight was suspended — the person may have walked to a frozen
          // position or typed into the draft — and admitting on the strength of
          // the earlier answer admits what nobody is asking for any more.
          () => stillAdmissible(held, reopening.facts()),
        );
        admitting.reported.push(
          submitted.ok
            ? { kind: "admitted", held, submission: submitted.value }
            : {
                kind: "refused",
                held,
                refusal: lifecycleRefusal(submitted.error) ?? submitted.error.message,
                byReadiness: lifecycleRefusal(submitted.error) !== undefined,
              },
        );
        wakes.send({ kind: "session" });
      });
      // The slot is held, so Pause has a target: the control has to be mounted
      // before the next event of this burst is dispatched, or a person who
      // pressed Run and reached straight back for Pause reaches past it.
      return { remounted: true };
    }
  }
}

/**
 * Draw one frame, in the one order this product allows.
 *
 * The subscription is taken for this frame and released with the scope, so
 * holding one *is* owing a frame: nothing is subscribed while the screen is
 * quiet, and a failure before the present releases the demand without applying
 * the timestamp.
 *
 * ## A frame that cannot be drawn ends the screen
 *
 * Failing to subscribe, to reconcile or to render raises. It does not hand back
 * the frame before it: the terminal is in raw mode and on the alternate screen,
 * and a command that keeps both while showing a picture it can no longer
 * update has taken the person's terminal and stopped telling them anything.
 * Raising unwinds the scope that owns the terminal, which is the only thing
 * that puts the modes back.
 *
 * ## A frame the terminal invalidated is deferred, never presented
 *
 * Every preparation is revalidated against the size the terminal reports now,
 * without exception, and an invalidated one is abandoned before anything is
 * mounted. The work of rebuilding is bounded *per frame* rather than overall:
 * a frame whose whole budget went to preparations the terminal outran releases
 * its subscription without applying the timestamp and the next frame starts
 * again from the size that is there. Nothing presents geometry measured for a
 * terminal that has already changed, and nothing ends because a window moved.
 */
function* paint(
  frames: ReplFrames,
  tree: ReplTree<ReplAction>,
  renderer: ReplRenderer,
  screen: ReplScreen,
  compose: ReplCompose,
  store?: ReplFitStore,
  chat?: ReplPlainFitStore,
  message?: ReplPlainFitStore,
  guidance?: ReplPlainFitStore,
): Operation<ReplPainted> {
  while (true) {
    const painted = yield* prepared(
      frames,
      tree,
      renderer,
      screen,
      compose,
      store,
      chat,
      message,
      guidance,
    );
    if (painted !== undefined) {
      return painted;
    }
    // Deferred, not given up on and not presented stale. The subscription went
    // with the scope and the timestamp was never applied, so the stream is not
    // held by a frame nobody drew — and the next one is prepared for whatever
    // size the terminal has settled on by then.
  }
}

/**
 * One frame's worth of attempts: the painted frame, or none to defer.
 *
 * Scoped, so the subscription this frame owes is released however it leaves —
 * presented, deferred or cancelled.
 */
function* prepared(
  frames: ReplFrames,
  tree: ReplTree<ReplAction>,
  renderer: ReplRenderer,
  screen: ReplScreen,
  compose: ReplCompose,
  store?: ReplFitStore,
  chat?: ReplPlainFitStore,
  message?: ReplPlainFitStore,
  guidance?: ReplPlainFitStore,
): Operation<ReplPainted | undefined> {
  return yield* scoped(function* (): Operation<ReplPainted | undefined> {
    const held = yield* frames.subscribe({ owner: "repl", participants: [["repl"]] });
    if (!held.ok) {
      throw held.error;
    }
    const tick = yield* held.value.next();

    for (let attempt = 0; attempt < PREPARATIONS; attempt += 1) {
      // The size this frame is for, read now and told to both engines before
      // anything is measured against it.
      const size = yield* screen.size();
      renderer.resize(size);
      const view = yield* compose(size);

      // 1. Measure. 2. Admit. 3. Reconcile exactly what was admitted. 4. Draw.
      //
      // The current size is handed to every attempt. There is no last attempt
      // that skips it: a frame drawn from a measurement the terminal has
      // already invalidated publishes targets naming rows nobody can see, and
      // presenting it would put that on the screen as though it were current.
      const committed = yield* commitReplFrame(
        tree,
        renderer,
        view,
        tick.delta,
        undefined,
        () => screen.size(),
        store,
        chat,
        message,
        guidance,
      );
      if (committed.ok) {
        // 5. Present the copied bytes. 6. The caller retains the returned map.
        // And only then 7. acknowledge that this timestamp has been applied.
        yield* screen.present(committed.value.rendered.output);
        held.value.acknowledge();
        return {
          rendered: committed.value.rendered,
          view,
          admission: committed.value.admission,
        };
      }
      if (!isStaleFrame(committed.error)) {
        throw committed.error;
      }
      // The terminal moved while this frame was being prepared. Nothing was
      // mounted and nothing was published — abandonment costs exactly nothing —
      // so build the frame again for the size that is actually there. Resizing
      // is ordinary: a person dragging a window corner produces a stream of
      // these, and a command that ended on one would be a command that cannot
      // be resized.
    }
    // Every attempt this frame had was invalidated. Deferred to the next frame,
    // which is the only answer that neither presents what the terminal has
    // already contradicted nor stops drawing.
    return undefined;
  });
}

/** One painted frame, and the view it actually drew. */
interface ReplPainted {
  readonly rendered: ReplRendered;
  /**
   * The view this frame drew.
   *
   * Handed back because a resize may have rebuilt it: whoever reads focus out of
   * the commit has to read it against the view that was committed, not the one
   * they first composed.
   */
  readonly view: ReplView;
  /**
   * What this frame admitted.
   *
   * Handed back because settling a focus request has to keep what the request
   * moved: a window the request scrolled to show a row is the window a person is
   * now looking at, and the offset this process holds has to become that one
   * before the request is spent.
   */
  readonly admission: ReplAdmission;
}

/**
 * How one frame's view is built, for whatever size the terminal is now.
 *
 * A view is built for one exact size, so whoever paints has to be able to build
 * it again when that size moves. Handing the frame a way to compose its view is
 * what makes a resize recoverable rather than fatal.
 */
type ReplCompose = (size: ReplTerminalSize) => Operation<ReplView>;

/**
 * How many preparations one frame may spend on a size that moved under it.
 *
 * Bounded per frame rather than overall, so a terminal resizing faster than
 * this product can draw gives up its subscription instead of the loop: the
 * budget is what this frame owes the stream, and exhausting it defers to the
 * next frame rather than presenting a measurement the terminal has already
 * contradicted.
 */
const PREPARATIONS = 8;

/** The one failure a caller recovers from by building the frame again. */
export class ReplStaleFrameError extends Error {
  override name = "ReplStaleFrameError";
}

/**
 * Whether one failure is a size that moved rather than a frame that cannot be
 * drawn.
 *
 * Read from the name rather than with `instanceof`, because a class identity is
 * not reliable across separately loaded copies of a module and this decides
 * whether the command carries on or ends.
 */
export function isStaleFrame(error: Error): boolean {
  return error.name === "ReplStaleFrameError";
}

/** What one committed frame measured, admitted and drew. */
export interface ReplCommitted {
  readonly rendered: ReplRendered;
  readonly manifest: ReplLayoutManifest;
  readonly admission: ReplAdmission;
}

/**
 * Measure, admit, reconcile and draw one view. The frame's whole middle.
 *
 * Everything between holding a frame's demand and presenting its bytes, in the
 * one order this product allows, and in one place: the screen's own paint and
 * any other caller that needs a committed frame go through here, so there is no
 * second assembly of these four steps to disagree with this one.
 *
 * It subscribes to nothing and acknowledges nothing. Presentation and
 * acknowledgement belong to whoever is holding the frame.
 */
export function* commitReplFrame(
  tree: ReplTree<ReplAction>,
  renderer: ReplRenderer,
  view: ReplView,
  deltaTime: number,
  pointer: { readonly x: number; readonly y: number; readonly down: boolean } | undefined,
  /**
   * The terminal's size now, for revalidating what the measurement assumed.
   *
   * Measurement suspends, and a size that moved while it did makes every
   * capacity it reported describe a terminal that no longer exists. A caller
   * that can rebuild its view supplies this; one that cannot — a test holding
   * one exact size — leaves it out.
   */
  sizeNow?: () => Operation<ReplTerminalSize>,
  store?: ReplFitStore,
  chat?: ReplPlainFitStore,
  message?: ReplPlainFitStore,
  guidance?: ReplPlainFitStore,
): Operation<Result<ReplCommitted>> {
  // Measure before anything is mounted: this asks the engine how much room each
  // region has, so what a window shows is the frame's answer rather than this
  // boundary's guess. It mounts nothing and publishes nothing.
  const prepared = yield* prepareFrame(renderer, view, store, chat, message, guidance);
  if (!prepared.ok) {
    return prepared;
  }
  // Revalidated here: after the measurement, and before anything is mounted.
  // This is the last moment abandoning the frame is free — one statement later
  // the tree holds controls measured for a terminal that has already changed,
  // and the targets published from them would name rows nobody can see.
  if (sizeNow !== undefined) {
    const now = yield* sizeNow();
    if (now.columns !== view.size.columns || now.rows !== view.size.rows) {
      return Err(
        new ReplStaleFrameError(
          `this frame was measured for ${view.size.columns}x${view.size.rows} and the ` +
            `terminal is now ${now.columns}x${now.rows}`,
        ),
      );
    }
  }

  // Only what was admitted is offered, so a row outside a window mounts nothing
  // and a control the row cannot hold whole is not in the tree.
  const { presentation, admission } = prepared.value;
  const applied = yield* tree.apply(presentation.descriptions);
  if (!applied.ok) {
    return applied;
  }

  // Bind the admitted manifest to the revision just reconciled, and draw its
  // contributed cells. What an element says is the cell its own mounted node
  // produced; a box whose node is not mounted is not drawn at all.
  const mounted = new Set(tree.mounted());
  const nodeByKey = new Map<string, string>();
  for (const node of mounted) {
    const key = tree.keyOf(node);
    if (key !== undefined) {
      nodeByKey.set(key, node);
    }
  }
  const cells = new Map<string, string>();
  for (const cell of tree.frame().cells) {
    cells.set(cell.node, cell.cell);
  }
  const root = presentation.manifest.root;
  // Read after the reconcile that settled it and handed on, never stored: the
  // tree owns focus, and decoration is the one thing that needs to know where it
  // ended up. A row's own `>` cue is the view's and is therefore a frame behind;
  // this is the frame's own answer.
  const drawn = yield* renderer.draw({
    ops: committedOps(root, nodeByKey, mounted, cells, tree.focused()),
    boxes: drawnBoxesOf(root, nodeByKey, mounted),
    // Every region and every viewport, so where one landed is a fact the frame
    // carries rather than something a later caller works out again.
    // Every structural box the manifest placed: the regions, the viewports, the
    // action row and the band's own rows. None of them is a target — a region is
    // not something a person activates — but where each one landed is the only
    // honest answer to how much room it had, so the frame carries it.
    regions: flatten(root)
      .filter((box) => box.key === undefined)
      .map((box) => box.id),
    tree: tree.frame().id,
    size: view.size,
    deltaTime,
    pointer,
  });
  if (!drawn.ok) {
    return drawn;
  }
  return Ok({ rendered: drawn.value, manifest: presentation.manifest, admission });
}

/** Which boxes this frame may publish a target for, and under which node. */
function drawnBoxesOf(
  root: ReplBox,
  nodeByKey: ReadonlyMap<string, string>,
  mounted: ReadonlySet<string>,
): readonly ReplDrawnBox[] {
  const found: ReplDrawnBox[] = [];
  for (const box of flatten(root)) {
    if (box.key === undefined) {
      continue;
    }
    const node = nodeByKey.get(box.key);
    if (node === undefined || !mounted.has(node)) {
      continue;
    }
    found.push({ id: node, node, control: box.control });
  }
  return found;
}

/** The chat window this frame published, or a name nothing measured. */
function sidekickViewportOf(manifest: ReplLayoutManifest): string {
  const slot = manifest.viewports.find((one) => one.window === SIDEKICK_WINDOW);
  return slot === undefined ? "box:no-chat-window" : slot.id;
}

/** What one bounded preparation measured, and the frame it decided on. */
export interface ReplPrepared {
  readonly context: ReplPresentationContext;
  readonly presentation: ReplPresentation;
  readonly admission: ReplAdmission;
}

/** One measuring context, which describes every scrolling viewport empty. */
function measuringAt(
  widths: ReplMeasuredWidths | undefined,
  entriesWindowed: boolean,
  entriesRows: number | undefined,
  /**
   * How many rows the contextual guidance block takes in this pass.
   *
   * Blank, like the composer's below: the count is the geometry question and
   * the words are not, and the pass that asks how wide the surface is cannot
   * already have fitted them to it.
   */
  guidanceRows = 1,
  /**
   * How many rows of the message's own value this pass is asking about.
   *
   * Blank rows: their count is the geometry question and their text is not,
   * and a pass still asking how wide the pane is would be fitting text to
   * nothing. One of them for the minimum composer, which is what the height
   * below is chosen against.
   */
  messageRows = 1,
  /**
   * Where a route drawer goes, once this preparation has settled it.
   *
   * Absent until the guidance block has been fitted and measured. The passes
   * before that answer widths and counts and admit nothing into a drawer, so
   * the rectangle the size states is the right one for them.
   */
  drawer: ReplBounds | undefined = undefined,
): ReplPresentationContext {
  return {
    widths,
    admission: NOTHING_ADMITTED,
    measuring: true,
    entriesWindowed,
    entriesRows,
    capture: "capture",
    // The measuring pass describes no width-dependent text, so it has no
    // fitted reading, preview or chat either: text prepared against a width
    // this pass is still asking for would be text fitted to nothing.
    reading: undefined,
    preview: undefined,
    chat: undefined,
    message: Object.freeze(Array.from({ length: Math.max(1, messageRows) }, () => "")),
    guidance: Object.freeze(Array.from({ length: Math.max(1, guidanceRows) }, () => "")),
    refusal: undefined,
    rail: undefined,
    drawer,
  };
}

/**
 * The row below the whole fitted guidance block, as the engine placed it.
 *
 * Read from the boxes the frame actually published rather than counted from the
 * column's parts: the block is as many rows as its words need at this width, and
 * a second arithmetic for where it ends is a second answer to a question the
 * measurement has already given. Half-open, so a layer beginning here covers
 * none of it.
 *
 * None where this frame drew no guidance — a refusal gives its own explanation
 * in that position instead, and a frame below the minimum draws neither.
 */
function guidanceBottomOf(
  manifest: ReplLayoutManifest,
  measured: ReplMeasured,
): number | undefined {
  let bottom: number | undefined;
  for (const box of flatten(manifest.root)) {
    if (box.key === undefined) {
      continue;
    }
    if (box.key !== "guidance" && !box.key.startsWith("guidance:row:")) {
      continue;
    }
    // Guidance drawn below the body is in no drawer's way.
    if (box.region === "footer") {
      continue;
    }
    const bounds = measured.boundsOf(box.id);
    if (bounds === undefined) {
      continue;
    }
    const edge = Math.ceil(bounds.y + bounds.height);
    bottom = bottom === undefined ? edge : Math.max(bottom, edge);
  }
  return bottom;
}

/**
 * Measure one view at its own size, and decide what the frame admits.
 *
 * Bounded, and in a fixed order, because each answer the engine gives is what
 * the next question needs. The region widths come first, since the text a row
 * holds has to fit one. Then the Entries catalog is measured without its window
 * controls, because whether it needs them is what decides whether they take a
 * row away from it. Then every region is measured once more with everything that
 * stays put in place — headings, both window controls, the complete action
 * labels — and what is left over is what the moving windows get.
 *
 * None of these renders is a committed frame. They mount nothing, publish no
 * target, acknowledge nothing and leave the drawn display exactly as it was,
 * which is why they run on the measuring engine and their bytes are discarded.
 */
export function* prepareFrame(
  renderer: ReplRenderer,
  view: ReplView,
  /**
   * Where this process keeps the reading geometry it has already measured.
   *
   * Absent for a caller holding one frame — a test, or a measurement taken
   * for its own sake — which measures everything every time.
   */
  store?: ReplFitStore,
  /**
   * Where this command is holding the chat cuts it has already measured.
   *
   * Separate from `store` and for the same reason it exists: a typed key moves
   * neither the entry reading nor the chat, and refitting every chat line was
   * what a keystroke came to cost once a conversation had any length to it.
   */
  chatStore?: ReplPlainFitStore,
  /**
   * Where this command is holding the message's own cuts.
   *
   * Its own storage, never the chat's: settling composer lines into the chat
   * store would evict the whole chat on every keystroke, which is the cost
   * that store exists to avoid.
   */
  messageStore?: ReplPlainFitStore,
  /**
   * Where this command is holding the directions' own cuts.
   *
   * The guidance block and a refusal's explanation both, because a frame gives
   * one or the other and never both. Its own storage again: directions change
   * when focus or readiness does, which is not when the chat changes, and one
   * store for both would evict the chat every time a reader moved.
   */
  guidanceStore?: ReplPlainFitStore,
): Operation<Result<ReplPrepared>> {
  // No widths at all for the pass that answers what the widths are. Every row
  // whose text has to fit a region is left out of it, because a growing column
  // takes its minimum from its widest child: one unbounded row would make the
  // column wider than its share and squeeze the column beside it, and the number
  // this pass reports would be the number that row caused.
  //
  // The tray's own row is the exception, and it is the reason this pass says
  // so: the width this pass reports for a queued message's text is read off
  // that row's box, and a tray already holding more rows than its column
  // allocated it would otherwise describe none — leaving the queue no width to
  // fit against, and so no fitted rows for any later pass to admit. It is a
  // blank row until something has been fitted, so it makes no column wider.
  const probe = presentationFor(view, {
    ...measuringAt(undefined, false, undefined),
    queueProbe: true,
  });
  const first = yield* renderer.measure(skeletonOps(probe.manifest.root), view.size);
  if (!first.ok) {
    return first;
  }
  const widths = widthsOf(probe.manifest, first.value);

  // The staged queue, fitted to the text column its first message measured.
  // Before every pass below, because each message is as many rows as its text
  // needs and the chat above it is what is left.
  const queueLines = queueLinesOf(view);
  const queued =
    queueLines === undefined || (widths.queue ?? 0) < 1
      ? Ok(undefined)
      : yield* fitPlain(renderer, view.size, queueLines, widths.queue ?? 0);
  if (!queued.ok) {
    return queued;
  }
  // The Transcript's selector, fitted once. Before the header rows below,
  // because what this answers is how wide that control is and the wrap decision
  // is made against it — and before every pass after that, because a label one
  // pass measured and another spelled differently is a control drawn where
  // nothing measured it.
  //
  // Through the engine and at grapheme boundaries. The name is a provider's
  // session key, which nothing in this product bounds and whose cells are not
  // its code units in either direction: measured, twenty-five wide characters
  // declared twenty-nine cells and needed fifty-four, and combining accents
  // declared more than they used and published a target over the column beside
  // them.
  const selectorRoom = selectorRoomOf(widths);
  let selector: ReplFittedLabel | undefined;
  if (selectorRoom !== undefined && selectorRoom > 0) {
    const fitted = yield* fitCells(
      renderer,
      view.size,
      selectorName(view),
      SELECTOR_MARK,
      // What is left once this screen's own marker room in front of every
      // control's label has had its two cells.
      Math.max(0, selectorRoom - FOCUS_MARKER),
    );
    if (!fitted.ok) {
      return fitted;
    }
    selector = fitted.value;
  }
  // Which staged headers need two rows, asked of the engine rather than
  // counted: each header's one-row text is fitted to the width the engine
  // measured for it, and a header whose text needs more than one row is drawn
  // as two rows of its own pane's body.
  const headerLines = workspaceHeaderLines(
    view,
    { ...measuringAt(widths, false, undefined), ...(selector === undefined ? {} : { selector }) },
    widths,
  );
  const wrapped = new Set<string>();
  for (const line of headerLines) {
    const fitted = yield* fitPlain(
      renderer,
      view.size,
      [{ key: line.key, text: line.text }],
      line.room,
    );
    if (!fitted.ok) {
      return fitted;
    }
    if (fitted.value.length > 1) {
      wrapped.add(line.key);
    }
  }
  // What the Draft's field has left, once this frame's own heading row and the
  // control beside it have been measured. Settled here, before anything is
  // mounted, and carried into every pass after it — the field is stated in the
  // measuring ops and in the committed ops alike, because a width the two
  // passes disagreed about is a control drawn where nothing measured it.
  let field: number | undefined;
  let messageText: number | undefined;
  let historyRoom: number | undefined;
  let historySpace: number | undefined;
  /**
   * How the non-wide History row divides itself, in whole cells.
   *
   * Copied out of one bounded measurement of the row's two parts asked on their
   * own, before anything is admitted, and then stated in every pass after it.
   * A `fit` child answers about the room its parent was given, so a map fitted
   * beside the controls takes the room first and every control comes back on
   * part of a cell; measuring them apart is what makes the split whole.
   */
  let historyParts: { readonly map: number; readonly actions: number } | undefined;
  const queuing = (context: ReplPresentationContext): ReplPresentationContext => ({
    ...context,
    ...(queued.value === undefined ? {} : { queue: queued.value }),
    ...(wrapped.size === 0 ? {} : { headers: wrapped }),
    ...(historySpace === undefined ? {} : { historyGap: historySpace }),
    ...(field === undefined ? {} : { draftField: field }),
    ...(messageText === undefined ? {} : { queueText: messageText }),
    ...(historyRoom === undefined ? {} : { historyMap: historyRoom }),
    ...(historyParts === undefined ? {} : { historySplit: historyParts }),
    ...(selector === undefined ? {} : { selector }),
  });

  // The catalog without its controls: if it fits, it keeps its natural footprint
  // and the column keeps the rows those controls would have taken.
  const trial = presentationFor(view, queuing(measuringAt(widths, false, undefined)));
  const second = yield* renderer.measure(skeletonOps(trial.manifest.root), view.size);
  if (!second.ok) {
    return second;
  }
  const catalog = entriesRowCount(view.model);
  const windowed = catalog > capacityOf(second.value.boundsOf(entriesViewportOf(trial.manifest)));
  const entriesRows = windowed ? undefined : catalog;

  // The directions, fitted to the surface they are drawn on. Before the frame
  // below, because they are fixed content: the room the composer may grow into
  // is what is left once they have taken theirs.
  const guidanceRoom = widths.guidance ?? widths.surfaceBody;
  const guidance =
    widths.surfaceBody < 1 || guidanceRoom < 1
      ? Ok(undefined)
      : yield* fitPlain(
          renderer,
          view.size,
          [{ key: "guidance", text: footerSentence(view) }],
          guidanceRoom,
          guidanceStore,
        );
  if (!guidance.ok) {
    return guidance;
  }
  const guidanceRows =
    guidance.value === undefined
      ? undefined
      : Object.freeze(guidance.value.map((own) => `${" ".repeat(own.indent)}${own.text}`));
  // A refusal's own explanation, through the same fitter. It and the guidance
  // never share a frame — a refusal is the whole of what its screen says — so
  // one store holds whichever of them this frame is giving.
  const refused =
    view.refusal === undefined || widths.surfaceBody < 1
      ? Ok(undefined)
      : yield* fitPlain(
          renderer,
          view.size,
          [{ key: "refusal", text: view.refusal }],
          widths.surfaceBody,
          guidanceStore,
        );
  if (!refused.ok) {
    return refused;
  }
  const refusalRows =
    refused.value === undefined
      ? undefined
      : Object.freeze(refused.value.map((own) => `${" ".repeat(own.indent)}${own.text}`));
  // The width probe. Its only question is how wide a fitted control is, so it
  // is the one pass that puts a queued row in the tray — and it is deliberately
  // not the pass anything is admitted from.
  const probed = presentationFor(view, {
    ...queuing(measuringAt(widths, windowed, entriesRows, guidanceRows?.length ?? 1)),
    queueProbe: true,
  });
  const fitted = yield* renderer.measure(skeletonOps(probed.manifest.root), view.size);
  if (!fitted.ok) {
    return fitted;
  }
  field = draftFieldWidth(probed.manifest, (id) => fitted.value.boundsOf(id)?.width);
  messageText = queueTextWidth(
    probed.manifest,
    (id) => fitted.value.boundsOf(id)?.width,
    widths.body,
  );
  // What the accepted wide row's gap is, from the row and the map this frame
  // measured. Taken here, from the pass that already holds a fitted map and
  // the whole footer, and before anything is admitted: the question is how to
  // divide the room the map leaves, which no admitted set changes.
  historySpace = historyGapWidth((id) => fitted.value.boundsOf(id)?.width);
  historyRoom = historyMapWidth(
    probed.manifest,
    (id) => fitted.value.boundsOf(id)?.width,
    view.size.columns,
  );
  // And how the non-wide row divides itself, from its two parts asked on their
  // own. One bounded measurement of a tree that mounts nothing and publishes no
  // target: a fitted row holding exactly the offered control nodes with their
  // own labels and gap, and a fitted row holding the map's own runs. What is
  // copied out is two whole widths, before the next engine call takes the
  // engine's memory of this one.
  //
  // Not a loop, and not derived from the row that was compressed: the question
  // is what these things need, and a rectangle one of them was squeezed into is
  // the answer this replaces.
  if (profileFor(view.size) !== "wide") {
    const parts = historyProbeOf(probed.manifest, view.size);
    if (parts !== undefined) {
      const apart = yield* renderer.measure(skeletonOps(parts), view.size);
      if (!apart.ok) {
        return apart;
      }
      historyParts = historySplitOf((id) => apart.value.boundsOf(id)?.width, view.size.columns);
    }
  }
  // Where a route drawer goes, now that the block it must stay clear of has
  // been fitted and placed. The guidance is as many rows as its words need, so
  // this is read from the rows the frame published rather than counted here.
  //
  // One more measurement under that envelope, and only when it actually moved:
  // the drawer's own window admits rows against this rectangle, so the pass
  // that counts them has to be a pass that knows where it starts. Bounded, not
  // a loop — a floating layer takes no row out of any column's flow, so the
  // guidance it was moved clear of cannot move because it moved.
  const workspace = stagedWorkspace(view) !== undefined;
  const envelope = routeDrawerRect(
    view.size,
    guidanceBottomOf(probed.manifest, fitted.value),
    workspace,
  );
  // The structural skeleton, under that envelope: every scrolling viewport
  // empty, with the controls that sit around it already in place. This is the
  // measurement an admission may be derived from, which is why it is measured
  // again rather than reusing the probe above — the probe was holding a row
  // inside the tray's viewport so the engine would size that row's control,
  // and a viewport stretched by its own contents reports the room its contents
  // wanted. Bounded: one pass, never a loop.
  const measured = presentationFor(
    view,
    queuing(measuringAt(widths, windowed, entriesRows, guidanceRows?.length ?? 1, 1, envelope)),
  );
  const third = yield* renderer.measure(skeletonOps(measured.manifest.root), view.size);
  if (!third.ok) {
    return third;
  }
  // The entry reading, fitted to the transcript's measured inner width. It
  // happens here — after the widths are known and before anything is admitted —
  // because the rows it produces are what the window has to admit and what the
  // descriptions have to say. Preparing it later would admit a count from one
  // list and describe another.
  //
  // Independent probe elements, so nothing about this measurement touches the
  // tree the frame is about to draw.
  //
  // A profile with no pane for it has no reading: a frame refused for being too
  // small publishes no transcript and no routed outlet, so there is no measured
  // region to fit one to. That is different from a pane too narrow to hold a
  // grapheme, which is a refusal and stays one.
  const reading =
    widths.surfaceBody < 1
      ? Ok(undefined)
      : yield* prepareReading(
          renderer,
          view.size,
          readingLines(readingOf(view)),
          widths.surfaceBody,
          store,
        );
  if (!reading.ok) {
    return reading;
  }
  // The open question's message, fitted to the drawer's own width. Prepared
  // here for the same reason the reading is: a drawer row is one row, so a
  // long preview line is only reachable if it was cut into rows before the
  // window counted them.
  // Whichever question the presented drawer is showing: the entry's where a
  // route drawer is open, and the Sidekick's own where its pane-local form is.
  const asked = previewedMessage(view);
  const preview =
    asked === undefined || widths.drawer < 1
      ? Ok(undefined)
      : yield* fitPlain(
          renderer,
          view.size,
          asked.split("\n").map((text, offset) => ({
            key: `message:${offset}`,
            text,
            runs: sourceRuns(text),
          })),
          widths.drawer,
        );
  if (!preview.ok) {
    return preview;
  }
  // The chat, fitted to the pane that holds it. The width is the pane's own:
  // wide and medium draw the chat in the right-hand column, and a narrow frame
  // routes it into the one outlet it has, which is the width the lists use.
  // The body's own width, which is the pane less its gutter — and what every
  // row inside the inset is built to.
  const chatRoom = widths.body;
  // And only where this frame has a chat window to put it in, which the frame
  // it just measured already answers. A wide frame showing Bindings still has a
  // positive inspection width and describes no chat row at all, so fitting one
  // there measured text nobody was going to draw — and measured it again on
  // every keystroke. Showing or revealing the chat publishes that window again,
  // and this is the pass that fits it against the geometry it has now.
  const presentsChat = measured.manifest.viewports.some((slot) => slot.window === SIDEKICK_WINDOW);
  const chatLines = chatRoom < 1 || !presentsChat ? undefined : chatLinesFor(view);
  const chat =
    chatLines === undefined
      ? Ok(undefined)
      : yield* fitPlain(renderer, view.size, chatLines, chatRoom, chatStore);
  if (!chat.ok) {
    return chat;
  }
  // The message's own value, cut to the same pane. Its rows are what the
  // composer is as tall as, so this is fitted before the height is chosen and
  // the height is chosen before the chat is admitted against what is left.
  //
  // Soft wrapping is display only: the string below is the one the person is
  // editing, and the cuts put no newline into it.
  // The composer exists where the chat being read is the one being continued:
  // an older chat is read-only and has none. The reading's own fact, not a
  // second pane rule.
  const composing = presentsChat && view.live.sidekick?.current === true;
  const messageLines =
    chatRoom < 1 || !composing
      ? undefined
      : view.state.message.split("\n").map((own, at) => ({ key: `message:${at}`, text: own }));
  const message =
    messageLines === undefined
      ? Ok(undefined)
      : yield* fitPlain(renderer, view.size, messageLines, chatRoom, messageStore);
  if (!message.ok) {
    return message;
  }
  // How tall the composer may be on this screen, and how tall it is.
  //
  // `C` is the chat capacity of the frame just measured, which carries the
  // label and exactly one value row — the minimum composer. Growing to `h`
  // value rows takes `h - 1` rows from the chat, so `h` at most `C` leaves it
  // one row. Six is the accepted cap, and the fitted rows may be fewer.
  const capacity = capacityOf(third.value.boundsOf(sidekickViewportOf(measured.manifest)));
  const fittedRows = message.value?.length ?? 0;
  const height =
    message.value === undefined
      ? 1
      : Math.max(1, Math.min(fittedRows, MESSAGE_VALUE_ROWS, Math.max(1, capacity)));
  // The newest rows, because the end is where somebody is typing.
  const shown =
    message.value === undefined
      ? undefined
      : Object.freeze(message.value.slice(fittedRows - height).map((own) => own.text));
  // One more structural measurement when the composer is taller than the
  // minimum, so the capacity the chat is admitted against is the capacity of
  // the frame that will actually be drawn. Bounded: one pass, never a loop.
  const geometry =
    shown === undefined || shown.length <= 1
      ? third
      : yield* renderer.measure(
          skeletonOps(
            presentationFor(
              view,
              queuing(
                measuringAt(
                  widths,
                  windowed,
                  entriesRows,
                  guidanceRows?.length ?? 1,
                  shown.length,
                  envelope,
                ),
              ),
            ).manifest.root,
          ),
          view.size,
        );
  if (!geometry.ok) {
    return geometry;
  }
  const placed =
    shown === undefined || shown.length <= 1
      ? measured
      : presentationFor(
          view,
          queuing(
            measuringAt(
              widths,
              windowed,
              entriesRows,
              guidanceRows?.length ?? 1,
              shown.length,
              envelope,
            ),
          ),
        );
  // The History band, measured against the terminal's own width. Prepared
  // beside the reading: where a mark lands is a proportion of the rail's
  // measured columns, so the pass that asks how wide the band is cannot
  // already have placed anything on it.
  // Below the minimum there is no band to measure: that frame is one
  // sentence and publishes no footer at all, so preparing a rail for it
  // would turn a refusal the product already handles into a measurement
  // failure.
  const rail =
    profileFor(view.size) === "too-small"
      ? Ok(undefined)
      : yield* prepareRail(
          renderer,
          view.size,
          view.navigation,
          view.state.route.at,
          view.size.columns,
        );
  if (!rail.ok) {
    return rail;
  }
  // The staged Draft's own value, fitted to the selected work it sits in. A
  // fixed number of rows, so no measurement above depends on it.
  const draftLines = draftLinesOf(view);
  const drafted =
    draftLines === undefined || widths.surfaceBody < 1
      ? Ok(undefined)
      : yield* fitPlain(renderer, view.size, draftLines, widths.surfaceBody);
  if (!drafted.ok) {
    return drafted;
  }
  const admission = admissionFor({
    view,
    manifest: placed.manifest,
    widths,
    reading: reading.value,
    preview: preview.value,
    chat: chat.value,
    queue: queued.value,
    boundsOf: (id: string) => geometry.value.boundsOf(id),
  });
  const context: ReplPresentationContext = {
    widths,
    admission,
    measuring: false,
    entriesWindowed: windowed,
    entriesRows,
    capture: "capture",
    reading: reading.value,
    preview: preview.value,
    chat: chat.value,
    message: shown,
    guidance: guidanceRows,
    refusal: refusalRows,
    rail: rail.value,
    drawer: envelope,
    draftField: field,
    queueText: messageText,
    historyMap: historyRoom,
    historyGap: historySpace,
    historySplit: historyParts,
    selector,
    draft: drafted.value === undefined ? undefined : draftRowsOf(drafted.value),
    queue: queued.value,
    headers: wrapped.size === 0 ? undefined : wrapped,
  };
  return Ok({ context, admission, presentation: presentationFor(view, context) });
}

/** Which region's width the text that must fit one is bounded by. */
function widthsOf(manifest: ReplLayoutManifest, measured: ReplMeasured): ReplMeasuredWidths {
  // The inside of a pane where the pane has edges, and the pane itself where it
  // has none. A row written to the outer bound of a bordered pane is as wide as
  // the pane *and* its edges, which is two columns more room than it has — and a
  // row wider than its column widens that column and publishes a hit box
  // reaching into the one beside it. The outer bounds stay in `regions`, which
  // is what the pane geometry contract keeps asking.
  // The pane's own content, asked for by what it answers rather than by which
  // box happens to come first. Every shared column publishes two: the pane the
  // heading band spans, and the body inset inside it that the rows under that
  // heading are built to. A lookup that took either one would build a header as
  // narrow as the reading beneath it, or a reading as wide as its heading.
  const paneOf = (...names: readonly ReplRegion[]): number => {
    for (const name of names) {
      const inside = manifest.contents.find(
        (content) => content.region === name && content.kind === "pane",
      );
      if (inside !== undefined) {
        return widthOf(measured, inside.id);
      }
      const found = manifest.regions.find((region) => region.region === name);
      if (found !== undefined) {
        return widthOf(measured, found.id);
      }
    }
    return 0;
  };
  /**
   * One named body's own width, or the pane's where this frame drew no body.
   *
   * By its own id and not by its region, because the narrow outlet is one
   * region for all three readings: a frame routing the Sidekick there publishes
   * that chat's inset body under `content`, and a lookup by region would hand
   * the Transcript's directions the chat's width. Falling back to the pane is
   * what keeps the narrow outlet's rows exactly as wide as they have always
   * been — it draws no Transcript or sidebar inset and is not given one.
   */
  const bodyOf = (id: string, ...names: readonly ReplRegion[]): number => {
    const found = manifest.contents.find((content) => content.id === id);
    return found === undefined ? paneOf(...names) : widthOf(measured, found.id);
  };
  return {
    // Narrow has one routed outlet and no columns, so every row that would land
    // in a column lands there instead.
    surface: paneOf("transcript", "content"),
    list: paneOf("sidebar", "content"),
    inspection: paneOf("inspection", "content"),
    // Each column's body, which is its pane less the gutter on each side.
    surfaceBody: bodyOf(TRANSCRIPT_BODY, "transcript", "content"),
    listBody: bodyOf(SIDEBAR_BODY, "sidebar", "content"),
    body: bodyOf(SIDEKICK_BODY, "inspection", "content"),
    drawer: widthOf(measured, manifest.viewports.find((slot) => slot.region === "drawer")?.id),
    queue: widthOf(measured, manifest.contents.find((content) => content.id === QUEUE_TEXT)?.id),
    guidance: guidanceWidthOf(manifest, measured),
  };
}

/**
 * The guidance row's own width, where a frame draws the guidance below the body.
 *
 * None otherwise, so the guidance is fitted to the selected work it is part of.
 */
function guidanceWidthOf(manifest: ReplLayoutManifest, measured: ReplMeasured): number | undefined {
  const drawn = flatten(manifest.root).some((box) => box.id === GUIDANCE_ROW);
  return drawn ? widthOf(measured, GUIDANCE_ROW) : undefined;
}

function widthOf(measured: ReplMeasured, id: string | undefined): number {
  if (id === undefined) {
    return 0;
  }
  return Math.max(0, Math.floor(measured.boundsOf(id)?.width ?? 0));
}

/** The Entries viewport's structural id, or one nothing measures. */
function entriesViewportOf(manifest: ReplLayoutManifest): string {
  return manifest.viewports.find((slot) => slot.window === ENTRIES_WINDOW)?.id ?? "";
}
