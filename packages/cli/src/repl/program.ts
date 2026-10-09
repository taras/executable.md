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
  spawn,
  type Subscription,
  withResolvers,
} from "effection";
import type { ReplExecutionProfile } from "../repl-profile.ts";

import {
  admissionFor,
  admitsSubmission,
  admitted,
  answered,
  elicitWithdrawn,
  ENTRIES_WINDOW,
  entriesRowCount,
  focusSettled,
  initialState,
  permissionSettled,
  permissionWithdrawn,
  presentationFor,
  readinessOf,
  readingOf,
  reduceRepl,
  refusedView,
  stateFor,
  viewFor,
  withoutAbsentEntry,
  withoutLiveDrawers,
} from "./application.ts";
import type { Json, NormalizedIssue } from "@executablemd/core";
import type {
  ReplAction,
  ReplFormMessage,
  ReplIntent,
  ReplLive,
  ReplMeasuredWidths,
  ReplPresentation,
  ReplPresentationContext,
  ReplState,
  ReplView,
} from "./application.ts";
import { decodeLocation, encodeLocation, resolveLocation } from "./route.ts";
import { replRepository } from "./journal.ts";
import type { ReplExecution } from "./journal.ts";
import { lifecycleRefusal, openReplSession } from "./session.ts";
import type { ReplSession } from "./session.ts";
import { useReplFrames } from "./frame.ts";
import type { ReplFrames } from "./frame.ts";
import { committedOps, flatten, profileFor, skeletonOps } from "./layout.ts";
import { prepareReading } from "./fitting.ts";
import { readingLines } from "./source-reading.ts";
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
  /** The location to reopen, or none to start a fresh execution. */
  readonly location?: string;
  /** The repository root. Defaults to this host's per-user data directory. */
  readonly root?: string;
  /** Everything this command settled before it opened a terminal. */
  readonly profile: ReplExecutionProfile;
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
  const repository = replRepository(root);

  // Opening a retained history reads and validates the whole file, and a file
  // that is not one raises. That is a location this command cannot show rather
  // than a failure of the command, so it becomes the refusal screen — with no
  // session, no provider and no observer ever created.
  let execution: ReplExecution;
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

  const opened = yield* openReplSession({
    execution,
    includes: options.profile.includes,
    installations: options.profile.installations,
    permissionMode: options.profile.permissionMode,
    ...(state.route.at === undefined ? {} : { selection: state.route.at }),
  });

  if (!opened.ok) {
    // A history that cannot be projected mounts the refusal and nothing else:
    // no provider, no observer, no execution task, and no append.
    return yield* refuse(state, opened.error.message);
  }

  return yield* drive(opened.value, state, execution, options);
}

/**
 * Whether the retained history can answer everything this route names.
 *
 * Projected from the file as it stands rather than from a session, because a
 * session is the thing this is deciding whether to open. The prefix a route
 * selects, the scopes it walks and the drawers it opens are all answers the
 * retained records already hold.
 */
function* resolvable(execution: ReplExecution, state: ReplState): Operation<Result<void>> {
  const projected = projectRepl(yield* execution.stream.readAll(), state.route.at);
  if (!projected.ok) {
    return projected;
  }
  const resolved = resolveLocation(projected.value, state.route);
  return resolved.ok ? Ok(undefined) : Err(resolved.error);
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

/** Run the screen for one opened session. */
function* drive(
  session: ReplSession,
  start: ReplState,
  execution: ReplExecution,
  options: ReplProgramOptions,
): Operation<Result<ReplOutcome>> {
  let state = start;
  // One session for the whole command: it owns the file, the observer and each
  // entry task in turn, so submitting an entry does not replace it.
  const current: ReplSession = session;
  let model: ReplModel = session.model;
  let rendered: ReplRendered | undefined;

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

    yield* spawn(function* reading(): Operation<void> {
      while (true) {
        const next = yield* events.next();
        if (next.done === true) {
          wakes.close();
          return;
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
        return false;
      }
      // Measured for the size and the reading this action is being answered at,
      // before the action runs. A scroll moves from the clamp the screen is
      // showing, so the capacity it moves within has to be this frame's and not
      // the one a resize or a filter left behind. This preparation subscribes to
      // no frame and acknowledges nothing — it is a question about geometry.
      const ready = yield* prepareFrame(
        renderer,
        yield* build(state, model, current, yield* screen.size(), focused),
      );
      if (!ready.ok) {
        throw ready.error;
      }
      const transition = reduceRepl(
        state,
        dispatched.value.action,
        model,
        liveOf(current),
        ready.value.admission,
      );
      state = transition.state;
      const performed = yield* perform(transition.intent, current, execution, options, wakes);
      if (performed.submitted === true) {
        model = current.model;
        // The entry exists now, so the draft that became it is finished.
        state = admitted(state);
      }
      if (performed.answered !== undefined) {
        // The question took it, so the drawer that was asking is over. The model
        // here is the history without this answer in it yet, which is what makes
        // the record it adds recognisable.
        state = answered(state, model, performed.answered);
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
      if (performed.refusal !== undefined) {
        state = Object.freeze({ ...state, refusal: performed.refusal });
        refusedByReadiness = performed.refusedByReadiness === true;
      } else if (transition.state.refusal === undefined) {
        // The action was taken, or refused for its own reasons and then cleared.
        // Either way whatever the readiness last refused is not what is showing.
        refusedByReadiness = false;
      }
      return performed.exited === true;
    }

    let focused: string | undefined;
    // Composed per frame: every branch below leaves `state` and `model` such
    // that this reproduces the view it resolved, at whatever size the terminal
    // turns out to be when the frame is drawn.
    const compose: ReplCompose = (at) => build(state, model, current, at, focused);
    rendered = (yield* paint(frames, tree, renderer, screen, compose)).rendered;
    focused = keyOfFocus(tree);
    // The first frame has the same obligation as every other one.
    rendered = (yield* paint(frames, tree, renderer, screen, compose)).rendered;

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
          model = current.model;
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

      if (departing) {
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
      // Resolution settles `state` and `model`; the view itself is composed per
      // frame, because a resize between here and the commit rebuilds it.
      const attempted = yield* reproject(state, model, execution);
      const drawnAt = yield* screen.size();
      let adopting = attempted.state;
      let built = viewFor(adopting, attempted.model, liveOf(current), drawnAt, focused);
      if (!built.ok) {
        // A position earlier than the selected entry's admission has no such
        // entry in it. The position is what was asked for, so the invalid entry
        // and scope suffix goes and nothing guesses a replacement — the draft,
        // the surface, the conversation filter and the marker all stand.
        const cleared = withoutAbsentEntry(adopting, attempted.model);
        if (cleared !== undefined) {
          const without = viewFor(cleared, attempted.model, liveOf(current), drawnAt, focused);
          if (without.ok) {
            adopting = cleared;
            built = without;
          }
        }
      }
      if (built.ok) {
        state = adopting;
        model = attempted.model;
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
      } else {
        // The reason the *reprojection* refused, when there was one: it is the
        // first thing that went wrong, and the resolution failure below it is a
        // consequence of still holding the older reading.
        state = Object.freeze({
          ...standing,
          refusal: attempted.state.refusal ?? built.error.message,
        });
        const back = yield* reproject(state, model, execution);
        model = back.model;
      }
      const painted = yield* paint(frames, tree, renderer, screen, compose);
      rendered = painted.rendered;
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
        const again = yield* paint(frames, tree, renderer, screen, compose);
        rendered = again.rendered;
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
function* reproject(
  state: ReplState,
  model: ReplModel,
  execution: ReplExecution,
): Operation<{ readonly state: ReplState; readonly model: ReplModel }> {
  if (state.route.at === model.selection) {
    return { state, model };
  }
  const projected = projectRepl(yield* execution.stream.readAll(), state.route.at);
  return projected.ok
    ? { state, model: projected.value }
    : { state: Object.freeze({ ...state, refusal: projected.error.message }), model };
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
function liveOf(session: ReplSession): ReplLive {
  return {
    output: session.overlay.output,
    question: session.overlay.question,
    expansion: session.expansion.state,
    pausable: session.controller !== undefined,
    running: session.live,
    agent: session.agent,
    lifecycle: session.lifecycle,
  };
}

/** The view for the state that stands, or a refusal naming why there is none. */
function* build(
  state: ReplState,
  model: ReplModel,
  session: ReplSession,
  size: ReplTerminalSize,
  focused: string | undefined,
): Operation<ReplView> {
  const view = viewFor(state, model, liveOf(session), size, focused);
  return view.ok ? view.value : refusedView(state, view.error.message, size);
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
  /** Whether a submission admitted one more entry into this session. */
  readonly submitted?: true;
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
): Operation<Performed> {
  switch (intent.kind) {
    case "none":
      return {};
    case "exit":
      // Nothing. No append, no close, no cancellation, no denial, no answer: a
      // person leaving has not decided anything that was waiting, and an entry
      // whose root never closed stays unfinished because that is what it is.
      return { exited: true };
    case "pause":
      session.controller?.pause();
      wakes.send({ kind: "session" });
      return {};
    case "continue":
      session.controller?.resume();
      wakes.send({ kind: "session" });
      return {};
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
      // The session this command already owns, rather than a second one. It
      // holds the one observer on the file and the one entry task, so an entry
      // is admitted *into* it — there is nothing here to watch again.
      const submitted = yield* session.submit(intent.source);
      wakes.send({ kind: "session" });
      if (!submitted.ok) {
        // A refusal leaves the draft exactly as it was and the history as it
        // was: nothing was admitted, so there is nothing to undo.
        //
        // Two different refusals arrive here and only one of them goes stale.
        // The readiness refusing is true of a moment: the entry it named
        // finishes and it stops being true. A document that cannot be admitted
        // is true of the document, and readiness moving on does not make it
        // admissible — dropping that one would take away the only explanation of
        // why the draft is still sitting there.
        //
        // Read from the structural mark the throw site installed, not from the
        // class and not from the name: `instanceof` answers no across loaded
        // copies, and `name` is writable, so any error at all could claim to be
        // a refusal this session never gave.
        //
        // And the *reason* comes from the mark as well, not from `message`. The
        // mark carries the sentence the session normalized when it refused;
        // `message` is an ordinary writable property that anything holding the
        // error can change afterwards. Showing one and authenticating the other
        // would let the screen display text the session never said.
        const readiness = lifecycleRefusal(submitted.error);
        return readiness === undefined
          ? { refusal: submitted.error.message }
          : { refusal: readiness, refusedByReadiness: true };
      }
      return { submitted: true };
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
): Operation<ReplPainted> {
  while (true) {
    const painted = yield* prepared(frames, tree, renderer, screen, compose);
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
      const committed = yield* commitReplFrame(tree, renderer, view, tick.delta, undefined, () =>
        screen.size(),
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
   * Handed back because settling a focus claim has to keep what the claim
   * moved: a window the claim scrolled to show a row is the window a person is
   * now looking at, and the offset this process holds has to become that one
   * before the claim is spent.
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
): Operation<Result<ReplCommitted>> {
  // Measure before anything is mounted: this asks the engine how much room each
  // region has, so what a window shows is the frame's answer rather than this
  // boundary's guess. It mounts nothing and publishes nothing.
  const prepared = yield* prepareFrame(renderer, view);
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
): ReplPresentationContext {
  return {
    widths,
    admission: NOTHING_ADMITTED,
    measuring: true,
    entriesWindowed,
    entriesRows,
    capture: "capture",
    // The measuring pass describes no width-dependent text, so it has no
    // fitted reading either: a reading prepared against a width this pass is
    // still asking for would be a reading fitted to nothing.
    reading: undefined,
  };
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
): Operation<Result<ReplPrepared>> {
  // No widths at all for the pass that answers what the widths are. Every row
  // whose text has to fit a region is left out of it, because a growing column
  // takes its minimum from its widest child: one unbounded row would make the
  // column wider than its share and squeeze the column beside it, and the number
  // this pass reports would be the number that row caused.
  const probe = presentationFor(view, measuringAt(undefined, false, undefined));
  const first = yield* renderer.measure(skeletonOps(probe.manifest.root), view.size);
  if (!first.ok) {
    return first;
  }
  const widths = widthsOf(probe.manifest, first.value);

  // The catalog without its controls: if it fits, it keeps its natural footprint
  // and the column keeps the rows those controls would have taken.
  const trial = presentationFor(view, measuringAt(widths, false, undefined));
  const second = yield* renderer.measure(skeletonOps(trial.manifest.root), view.size);
  if (!second.ok) {
    return second;
  }
  const catalog = entriesRowCount(view.model);
  const windowed = catalog > capacityOf(second.value.boundsOf(entriesViewportOf(trial.manifest)));
  const entriesRows = windowed ? undefined : catalog;

  const measured = presentationFor(view, measuringAt(widths, windowed, entriesRows));
  const third = yield* renderer.measure(skeletonOps(measured.manifest.root), view.size);
  if (!third.ok) {
    return third;
  }
  // Every answer this pass gave, copied out before anything else is measured.
  // The engine's reported geometry is only valid until the next render, and the
  // reading below renders probes — so a `boundsOf` read afterwards answers from
  // a tree the frame never described. Measured: it reported capacities from the
  // probe pass, which admitted a question drawer short of the one on screen and
  // took a field's Tab stop away with it.
  const geometry = new Map<string, ReplBounds>();
  for (const one of flatten(measured.manifest.root)) {
    const bounds = third.value.boundsOf(one.id);
    if (bounds !== undefined) {
      geometry.set(one.id, bounds);
    }
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
    widths.surface < 1
      ? Ok(undefined)
      : yield* prepareReading(renderer, view.size, readingLines(readingOf(view)), widths.surface);
  if (!reading.ok) {
    return reading;
  }
  const admission = admissionFor({
    view,
    manifest: measured.manifest,
    widths,
    reading: reading.value,
    boundsOf: (id: string) => geometry.get(id),
  });
  const context: ReplPresentationContext = {
    widths,
    admission,
    measuring: false,
    entriesWindowed: windowed,
    entriesRows,
    capture: "capture",
    reading: reading.value,
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
  const of = (...names: readonly ReplRegion[]): number => {
    for (const name of names) {
      const inside = manifest.contents.find((content) => content.region === name);
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
  return {
    // Narrow has one routed outlet and no columns, so every row that would land
    // in a column lands there instead.
    surface: of("transcript", "content"),
    list: of("sidebar", "content"),
    inspection: of("inspection", "content"),
    drawer: widthOf(measured, manifest.viewports.find((slot) => slot.region === "drawer")?.id),
  };
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
