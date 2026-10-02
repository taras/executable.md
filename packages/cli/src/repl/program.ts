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
  admitted,
  answered,
  focusSettled,
  permissionSettled,
  permissionWithdrawn,
  describeApplication,
  initialState,
  reduceRepl,
  refusedView,
  replSurface,
  stateFor,
  viewFor,
  withoutAbsentEntry,
} from "./application.ts";
import type { Json, NormalizedIssue } from "@executablemd/core";
import type {
  ReplAction,
  ReplFormMessage,
  ReplIntent,
  ReplLive,
  ReplState,
  ReplView,
} from "./application.ts";
import { decodeLocation, encodeLocation, resolveLocation } from "./route.ts";
import { replRepository } from "./journal.ts";
import type { ReplExecution } from "./journal.ts";
import { openReplSession } from "./session.ts";
import type { ReplSession } from "./session.ts";
import { useReplFrames } from "./frame.ts";
import type { ReplFrames } from "./frame.ts";
import { layout } from "./layout.ts";
import { resolvePointer, snapshotRender, useReplRenderer } from "./renderer.ts";
import type { ReplRendered, ReplRenderer } from "./renderer.ts";
import { useReplScreen } from "./screen.ts";
import type { ReplScreen, ReplScreenEvent } from "./screen.ts";
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
  const view = refusedView(state, reason);
  yield* scoped(function* (): Operation<void> {
    const screen = yield* useReplScreen();
    const events: Subscription<ReplScreenEvent, void> = yield* screen.events();
    const tree = yield* useReplTree<ReplAction>();
    const frames = yield* useReplFrames();
    const size = yield* screen.size();
    const renderer = yield* useReplRenderer({ columns: size.columns, rows: size.rows });

    yield* paint(frames, tree, renderer, screen, view);
    while (true) {
      const next = yield* events.next();
      if (next.done === true || next.value.kind === "eof") {
        return;
      }
      if (next.value.kind === "resize") {
        // A refusal recovers on resize like any other screen: the terminal
        // growing is the remedy for the one refusal that has no other.
        renderer.resize(next.value.size);
        yield* paint(frames, tree, renderer, screen, view);
        continue;
      }
      if (
        next.value.kind === "input" &&
        next.value.event.kind === "key" &&
        next.value.event.key === "Escape"
      ) {
        return;
      }
    }
  });
  return Err(new ReplRefusedError(reason, encodeLocation(state.route)));
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
  /** The question whose drawer has already been offered. */
  let offered: unknown;

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

    let focused: string | undefined;
    rendered = yield* paint(
      frames,
      tree,
      renderer,
      screen,
      yield* build(state, model, current, yield* screen.size(), focused),
    );
    focused = keyOfFocus(tree);
    // The first frame has the same obligation as every other one.
    rendered = yield* paint(
      frames,
      tree,
      renderer,
      screen,
      yield* build(state, model, current, yield* screen.size(), focused),
    );

    while (true) {
      const taken = yield* wakes.take();
      if (taken.length === 0) {
        return Ok({ location: encodeLocation(state.route), refusal: undefined });
      }

      // What stands now, to return to if what is attempted does not resolve.
      const standing = state;
      let ended = false;
      for (const wake of taken) {
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
            const dispatched = yield* tree.dispatch(aimed);
            if (dispatched.ok && dispatched.value.outcome === "action") {
              const transition = reduceRepl(
                state,
                dispatched.value.action,
                model,
                liveOf(current),
                yield* screen.size(),
              );
              state = transition.state;
              const performed = yield* perform(
                transition.intent,
                current,
                execution,
                options,
                wakes,
              );
              if (performed.submitted === true) {
                model = current.model;
                // The entry exists now, so the draft that became it is finished.
                state = admitted(state);
              }
              if (performed.answered !== undefined) {
                // The question took it, so the drawer that was asking is over.
                // The model here is the history without this answer in it yet,
                // which is what makes the record it adds recognisable.
                state = answered(state, model, performed.answered);
              }
              if (performed.settled !== undefined) {
                // The authority answered it, so the request is gone and the
                // drawer over it goes too.
                state = permissionSettled(state, performed.settled);
              }
              if (performed.messages !== undefined) {
                // Still the same question. What the schema said goes under the
                // form, and every value stays where it was typed.
                state = Object.freeze({
                  ...state,
                  form: Object.freeze({
                    ...state.form,
                    messages: Object.freeze([...performed.messages]),
                  }),
                });
              }
              if (performed.refusal !== undefined) {
                state = Object.freeze({ ...state, refusal: performed.refusal });
              }
            }
          }
        } else if (wake.event.kind === "input") {
          const delivered = wake.event.event;
          if (delivered !== undefined) {
            const dispatched = yield* tree.dispatch(delivered);
            if (dispatched.ok && dispatched.value.outcome === "action") {
              const transition = reduceRepl(
                state,
                dispatched.value.action,
                model,
                liveOf(current),
                yield* screen.size(),
              );
              state = transition.state;
              const performed = yield* perform(
                transition.intent,
                current,
                execution,
                options,
                wakes,
              );
              if (performed.submitted === true) {
                model = current.model;
                // The entry exists now, so the draft that became it is finished.
                state = admitted(state);
              }
              if (performed.answered !== undefined) {
                // The question took it, so the drawer that was asking is over.
                // The model here is the history without this answer in it yet,
                // which is what makes the record it adds recognisable.
                state = answered(state, model, performed.answered);
              }
              if (performed.settled !== undefined) {
                // The authority answered it, so the request is gone and the
                // drawer over it goes too.
                state = permissionSettled(state, performed.settled);
              }
              if (performed.messages !== undefined) {
                // Still the same question. What the schema said goes under the
                // form, and every value stays where it was typed.
                state = Object.freeze({
                  ...state,
                  form: Object.freeze({
                    ...state.form,
                    messages: Object.freeze([...performed.messages]),
                  }),
                });
              }
              if (performed.refusal !== undefined) {
                state = Object.freeze({ ...state, refusal: performed.refusal });
              }
            }
          }
        }
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

      // A question is the interaction, not a place to go looking for one: when
      // this process starts asking, its drawer is offered once. Dismissing it
      // with Escape is final for that question, because the offer is remembered
      // by the question itself rather than by a flag somebody has to clear.
      const asking = current.overlay.question;
      if (asking !== undefined && asking !== offered && state.route.at === undefined) {
        offered = asking;
        const opening = reduceRepl(
          state,
          { kind: "open-drawer", drawer: { kind: "live-elicit" } },
          model,
          liveOf(current),
        );
        state = opening.state;
      }

      // A route that names a history position needs the model projected *at* that
      // position: a prefix is a different reading of the same file rather than a
      // filter over the head. Reprojected, then verified — and a route that does
      // not resolve there leaves the standing one exactly as it was.
      let view: ReplView;
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
        view = built.value;
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
        const again = viewFor(state, model, liveOf(current), drawnAt, focused);
        view = again.ok ? again.value : refusedView(state, again.error.message, drawnAt);
      }
      rendered = yield* paint(frames, tree, renderer, screen, view);
      // Focus is the tree's answer, and the tree only answers after the commit —
      // so a frame built before it can be marking the wrong control. When it has
      // moved, draw once more with where it actually is. Otherwise the marker is
      // always one keystroke behind, and a person reaching for a control would be
      // acting on the one after it.
      let settledFocus = keyOfFocus(tree);
      // A focus claim this commit satisfied is spent here, at the commit that
      // satisfied it: what the tree answers is the only thing that says whether
      // the control a claim named actually took it.
      state = focusSettled(view, settledFocus);
      if (settledFocus !== focused) {
        focused = settledFocus;
        const redrawn = yield* build(state, model, current, yield* screen.size(), focused);
        rendered = yield* paint(frames, tree, renderer, screen, redrawn);
        settledFocus = keyOfFocus(tree);
        state = focusSettled(redrawn, settledFocus);
        focused = settledFocus;
      }
      if (ended) {
        // End of input is a lifecycle outcome: the last frame is drawn, and then
        // the command is over.
        return Ok({ location: encodeLocation(state.route), refusal: undefined });
      }
    }
  });

  return outcome;
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

/** This process's overlay, as the application reads it. */
function liveOf(session: ReplSession): ReplLive {
  return {
    output: session.overlay.output,
    question: session.overlay.question,
    expansion: session.expansion.state,
    pausable: session.controller !== undefined,
    agent: session.agent,
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
  /** Why it could not be done, for the screen to say. */
  readonly refusal?: string;
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
        return { refusal: submitted.error.message };
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
 */
function* paint(
  frames: ReplFrames,
  tree: ReplTree<ReplAction>,
  renderer: ReplRenderer,
  screen: ReplScreen,
  view: ReplView,
): Operation<ReplRendered> {
  return yield* scoped(function* (): Operation<ReplRendered> {
    const held = yield* frames.subscribe({ owner: "repl", participants: [["repl"]] });
    if (!held.ok) {
      throw held.error;
    }
    const tick = yield* held.value.next();

    // 1. The immutable view is already in hand. 2. Commit it and wait for that
    // exact handoff.
    const committed = yield* tree.apply(describeApplication(view));
    if (!committed.ok) {
      throw committed.error;
    }
    // 3. Only the mounted tree, laid out for the terminal as it is now.
    const size = yield* screen.size();
    const frame = layout(size, replSurface(tree, view));
    const drawn = yield* renderer.render(
      snapshotRender({
        frame,
        tree: tree.frame().id,
        mounted: tree.mounted(),
        deltaTime: tick.delta,
        pointer: undefined,
      }),
    );
    if (!drawn.ok) {
      throw drawn.error;
    }
    // 4. Present the copied bytes. 5. The caller retains the returned map. And
    // only then 6. acknowledge that this timestamp has been applied.
    yield* screen.present(drawn.value.output);
    held.value.acknowledge();
    return drawn.value;
  });
}
