/**
 * The only module that touches the terminal.
 *
 * Everything it turns on, it turns back off — on an ordinary exit, on a signal,
 * and when a frame throws. The ordering is the point: each `ensure()` is
 * registered *before* the thing it undoes exists, because a run halted while it
 * is still acquiring has nothing registered to unwind, and a terminal left in
 * the alternate buffer with its cursor hidden is a shell the person has to fix
 * by hand.
 *
 * Mouse reporting is deliberately never enabled. Nothing here needs a pointer,
 * and a terminal left reporting mouse movement is the loudest way this
 * experiment could damage the thing it is borrowing.
 */

import { alternateBuffer, createInput, cursor, settings } from "@bomb.sh/tty";
import type { Input, InputEvent, ScanResult, Setting, Term } from "@bomb.sh/tty";
import { createSignal, ensure, resource, sleep, spawn, until } from "effection";
import type { Operation, Signal, Task } from "effection";

import { fixture, fixtures } from "./fixtures.ts";
import type { Fixture, FixtureName } from "./model.ts";
import { SURFACES } from "./layout.ts";
import { transcriptLines } from "./render.ts";
import type { FocusView } from "./render.ts";
import { initialView } from "./store.ts";
import { asKey, fixtureFor, hydrate, reduce, viewOf } from "./store.ts";
import { overlayOf, useReplTree } from "./tree.ts";
import { drive, enterRoute } from "./drive.ts";
import type { HarnessEvent, ReplState, View } from "./store.ts";
import { journalThrough, markerShowing } from "./journal.ts";
import { formatRoute } from "./route.ts";
import { RendererCapacityError, useComposition, useTerm } from "./capture.ts";
import type { Composition } from "./capture.ts";
import { renderInto } from "./capture.ts";
import type { Mutation } from "./mutations.ts";
import {
  motionAt,
  playbackFrom,
  segmentDurationMs,
  segmentFixture,
  segmentLabel,
} from "./playback.ts";
import type { Motion, Playback, Segment } from "./playback.ts";

/** The modes the harness changes, as one reversible pair. */
export function terminalModes(): Setting {
  return settings(alternateBuffer({ clear: true }), cursor(false));
}

/**
 * Apply the terminal modes, and restore them however this ends.
 *
 * The cleanup is registered before the first byte is written, and it only
 * reverts what it actually applied.
 */
export function useTerminalModes(
  write: (bytes: Uint8Array) => void,
  mutation?: Mutation,
): Operation<void> {
  return resource(function* (provide) {
    const modes = terminalModes();
    let applied = false;
    yield* ensure(() => {
      if (applied && mutation !== "leak-terminal-modes") {
        write(modes.revert);
      }
    });
    write(modes.apply);
    applied = true;
    yield* provide();
  });
}

export function useRawMode(mutation?: Mutation): Operation<void> {
  return resource(function* (provide) {
    let raw = false;
    yield* ensure(() => {
      if (raw && mutation !== "leak-terminal-modes") {
        Deno.stdin.setRaw(false);
      }
    });
    Deno.stdin.setRaw(true);
    raw = true;
    yield* provide();
  });
}

/**
 * One operating-system signal, for as long as the enclosing scope lives.
 *
 * The handler is a stable reference, added after its own removal is registered
 * and removed in the same scope's teardown.
 */
export function useSignalListener(signal: Deno.Signal, handler: () => void): Operation<void> {
  return resource(function* (provide) {
    let added = false;
    yield* ensure(() => {
      if (added) {
        Deno.removeSignalListener(signal, handler);
      }
    });
    Deno.addSignalListener(signal, handler);
    added = true;
    yield* provide();
  });
}

/**
 * Raw keystrokes.
 *
 * The reader is cancelled in teardown, which is what releases a read that is
 * still waiting for a key that will never come.
 */
export function useStdinReader(): Operation<ReadableStreamDefaultReader<Uint8Array>> {
  return resource(function* (provide) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    yield* ensure(function* () {
      if (reader) {
        yield* until(reader.cancel());
      }
    });
    reader = Deno.stdin.readable.getReader();
    yield* provide(reader);
  });
}

/**
 * What to assume when the terminal will not say how big it is.
 *
 * Some pseudo-terminals report `0 × 0` — macOS `script` does — and a renderer
 * handed those dimensions draws nothing at all, which looks exactly like a
 * harness that crashed. Eighty by twenty-four is the oldest safe answer to that
 * question.
 */
export const ASSUMED_SIZE = { cols: 80, rows: 24 } as const;

export function measureTerminal(): { cols: number; rows: number } {
  try {
    const size = Deno.consoleSize();
    if (size.columns > 0 && size.rows > 0) {
      return { cols: size.columns, rows: size.rows };
    }
  } catch {
    // No terminal is attached to this process; the assumed size is the answer.
  }
  return { cols: ASSUMED_SIZE.cols, rows: ASSUMED_SIZE.rows };
}

export type { HarnessEvent };

export interface HarnessState {
  readonly view: View;
  readonly fixture: Fixture;
  readonly cols: number;
  readonly rows: number;
  readonly quit: boolean;
}

/**
 * One chunk of raw keystrokes, decoded completely.
 *
 * A lone `ESC` is ambiguous until the terminal has had its say, so the decoder
 * buffers it and asks to be re-scanned with an empty buffer after its own
 * latency. A harness that reads `scanned.events` and drops `scanned.pending`
 * swallows every Escape the user presses — the key is documented, the reducer
 * handles it, and pressing it does nothing. Honouring `pending` here is what
 * makes Escape arrive at all.
 *
 * The flush is bounded: the decoder reports `pending` again when re-scanned
 * before its latency has elapsed, and a loop that trusted it without a ceiling
 * would spin on a terminal whose clock disagreed.
 */
const FLUSH_ATTEMPTS = 4;

export function* scanKeys(
  input: Input,
  chunk: Uint8Array | undefined,
  deliver: (event: InputEvent) => void,
  mutation?: Mutation,
): Operation<void> {
  const dispatch = (scanned: ScanResult): ScanResult["pending"] => {
    for (const event of scanned.events) {
      deliver(event);
    }
    return scanned.pending;
  };
  let pending = dispatch(input.scan(chunk));
  for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt += 1) {
    if (pending === undefined || mutation === "swallow-pending-escape") {
      return;
    }
    yield* sleep(pending.delay);
    pending = dispatch(input.scan());
  }
}

/** One frame drawn, and whether the renderer is still moving. */
interface Painted {
  readonly animating: boolean;
  readonly bytes: number;
}

function draw(
  term: Term,
  state: HarnessState,
  composition: Composition,
  write: (bytes: Uint8Array) => void,
  mutation?: Mutation,
  motion?: Motion,
  deltaMs = 0,
  focus?: FocusView,
): Painted {
  // One render path for the harness and for the captures, so what a person sees
  // in a terminal and what a golden records cannot drift apart.
  const frame = renderInto(term, {
    fixture: state.fixture,
    view: state.view,
    composition,
    size: { cols: state.cols, rows: state.rows },
    mutation,
    motion,
    focus,
    // The harness counts in milliseconds and the renderer in seconds. The
    // conversion happens here, once, at the only place the two meet.
    deltaSeconds: deltaMs / 1000,
  });
  write(frame.ansi);
  return { animating: frame.animating, bytes: frame.ansi.length };
}

/** A frame every sixteen milliseconds, which is the rate the study was made at. */
export const FRAME_MS = 16;

/** The same frame, in the seconds the renderer measures transitions in. */
export const FRAME_SECONDS = FRAME_MS / 1000;

/**
 * One wake-up, armed by the frame loop after each frame it draws.
 *
 * It is a child of the terminal session, so a cancelled session takes it with
 * it and no timer is left drawing into a terminal that has been restored. It is
 * armed one frame at a time rather than looping on its own, because only the
 * loop knows how long the next wait should be — sixteen milliseconds while a
 * transition runs, and the remainder of a hold while a moment is being read.
 * A timer that decided that for itself would be deciding it from state the loop
 * had not finished updating.
 */
function* ticker(events: Signal<HarnessEvent, never>, delayMs: number): Operation<void> {
  yield* sleep(delayMs);
  events.send({ kind: "tick", advanceMs: delayMs });
}

/** One line of what the frame loop did, for evidence that cannot watch a screen. */
export interface TraceEntry {
  readonly frame: number;
  readonly elapsedMs: number;
  /** What the renderer was advanced by, in its own unit: seconds. */
  readonly deltaSeconds: number;
  readonly animating: boolean;
  readonly motionDone: boolean | null;
  readonly bytes: number;
  /** `hold:nested`, `play:nested→generated`, or `settled` once it is over. */
  readonly segment: string;
  /** The moment this frame is showing, which is always one of the fixtures. */
  readonly fixture: FixtureName;
}

/**
 * The state a run opens at.
 *
 * `--route` says it outright. A fixture name says it indirectly: the journal
 * knows which marker reconstructs that moment, and a moment with a suspension
 * waiting opens the drawer that is waiting, because that is what an execution
 * suspending does.
 */
export function openingState(options: {
  readonly fixture: FixtureName;
  readonly route?: string;
  readonly head?: string;
  readonly focusMap?: boolean;
}): ReplState {
  const head = options.head ?? markerShowing(options.fixture);
  const journal = journalThrough(head);
  if (options.route !== undefined) {
    const opened = hydrate(options.route, journal);
    return { ...opened, overlay: options.focusMap === true };
  }
  const start = {
    execution: "e1",
    surface: "transcript" as const,
    scopes: [],
    drawers: [],
    inspect: false,
    draft: "",
  };
  const opened = hydrate(formatRoute(start), journal);
  const waiting = opened.moment.suspension;
  const routed =
    waiting === undefined
      ? opened
      : hydrate(formatRoute({ ...start, drawers: [waiting] }), journal);
  return { ...routed, overlay: options.focusMap === true };
}

export interface InteractiveOptions {
  readonly fixture: FixtureName;
  readonly mutation?: Mutation;
  /** Open at this URL instead of at a fixture's own moment. */
  readonly route?: string;
  /** How far the execution has recorded, which a URL never carries. */
  readonly head?: string;
  /** The node to put focus on, for a run that opens at a named study frame. */
  readonly focus?: string;
  /** Start with the numbered focus map drawn. */
  readonly focusMap?: boolean;
  /** Start this playback immediately, rather than waiting for `p`. */
  readonly play?: Playback;
  /** Play the whole approved story, holds and all, with no keystrokes. */
  readonly journey?: readonly Segment[];
  /** Leave after this many frames, so a run can end without a keystroke. */
  readonly maxFrames?: number;
  /** Raise SIGINT at this harness once this many frames have been drawn. */
  readonly interruptAfterFrames?: number;
  readonly trace?: TraceEntry[];
}

/**
 * The harness, in a real terminal.
 *
 * A resize is read from the operating system rather than from the input stream:
 * `Input.scan()` decodes keys and mouse reports, and a terminal's size change is
 * neither.
 */
export function* runInteractive(options: InteractiveOptions): Operation<void> {
  const write = (bytes: Uint8Array) => {
    // Every byte this harness sends the terminal goes through one synchronous
    // write, because the last of them is sent from teardown: an asynchronous
    // write there can be cut short by the very shutdown that scheduled it, and
    // a terminal left in the alternate buffer with a hidden cursor is a shell
    // the person has to repair by hand.
    // oxlint-disable-next-line local/no-sync-filesystem
    Deno.stdout.writeSync(bytes);
  };
  const size = measureTerminal();
  // One owner for where the person is. The journey below is a projector rather
  // than a place: while it runs it supplies the moment on screen, and the store
  // is what every keystroke acts on.
  let repl = openingState(options);
  let state: HarnessState = {
    view: viewOf(repl),
    fixture: fixtureFor(repl),
    cols: size.cols,
    rows: size.rows,
    quit: false,
  };

  // The tree is acquired before the terminal is touched, so its teardown runs
  // after the terminal has been given back rather than into a restored one.
  const tree = yield* useReplTree(repl);
  // Entering the region the route names comes first, because the footer is an
  // explicit region: its controls exist only once focus is inside it. Without
  // this the interactive harness opened at a frame's *location* but not its
  // focus, so `--frame 12` drew none of the transport controls it is about.
  yield* enterRoute(tree, repl, options.focus);

  let term = yield* useTerm({ cols: state.cols, rows: state.rows });
  const input: Input = yield* until(createInput({}));

  yield* useTerminalModes(write, options.mutation);
  yield* useRawMode(options.mutation);

  const events = createSignal<HarnessEvent, never>();
  const subscription = yield* events;

  yield* useSignalListener("SIGWINCH", () => events.send({ kind: "resize", ...measureTerminal() }));
  yield* useSignalListener("SIGINT", () => events.send({ kind: "quit" }));
  yield* useSignalListener("SIGTERM", () => events.send({ kind: "quit" }));

  const reader = yield* useStdinReader();
  yield* spawn(function* () {
    while (true) {
      const chunk = yield* until(reader.read());
      if (chunk.done) {
        events.send({ kind: "quit" });
        return;
      }
      // The flush runs inside the reader task, so a cancelled session takes it
      // along and nothing re-scans into a terminal that has been restored.
      yield* scanKeys(
        input,
        chunk.value,
        (event) => events.send({ kind: "key", event }),
        options.mutation,
      );
    }
  });

  // Everything about where the demonstration has got to lives here, in this
  // invocation, and is gone when it returns. No fixture knows about it, nothing
  // durable records it, and reconstruction lands on a fixture rather than on a
  // moment between two of them.
  const journey = options.journey;
  let segmentIndex = 0;
  let playback = options.play;
  let elapsed = 0;
  let frames = 0;
  let clock: Task<void> | undefined;
  let interrupted = false;
  let settled = false;
  let held: string | undefined;
  let lastPainted = false;
  const compositions = new Map<string, Composition>();

  const currentSegment = (): Segment | undefined =>
    journey === undefined ? undefined : journey[segmentIndex];

  const show = (name: FixtureName) => {
    const target = fixture(name);
    state = { ...state, fixture: target, view: initialView(target) };
  };

  /** Where the store says we are, once the projector is not overriding it. */
  const follow = () => {
    state = { ...state, fixture: fixtureFor(repl), view: viewOf(repl), quit: repl.quit };
  };

  if (journey !== undefined) {
    const first = journey[0];
    show(segmentFixture(first));
    if (first.kind === "play") {
      playback = first.playback;
    }
  } else if (playback !== undefined) {
    show(playback.to);
  }

  /**
   * How long the clock should wait before the next frame.
   *
   * A transition wants one every sixteen milliseconds. A held moment wants
   * exactly one, when the hold is over.
   */
  const nextDelayMs = (): number => {
    const segment = currentSegment();
    if (segment?.kind === "hold") {
      return Math.max(1, segment.durationMs - elapsed);
    }
    return FRAME_MS;
  };

  /**
   * Move the journey on by the time that just passed.
   *
   * A wake-up can cross a segment boundary — the end of a hold is exactly such
   * a wake-up — so this consumes segments until the elapsed time fits inside
   * the current one, and reports when the story has run out.
   */
  const advance = (byMs: number): "running" | "finished" => {
    if (journey === undefined) {
      elapsed += byMs;
      return "running";
    }
    elapsed += byMs;
    while (segmentIndex < journey.length) {
      const segment = journey[segmentIndex];
      const duration = segmentDurationMs(segment);
      if (elapsed < duration) {
        break;
      }
      elapsed -= duration;
      segmentIndex += 1;
      const entered = journey[segmentIndex];
      if (entered === undefined) {
        // The last hold ended. What is on screen is the settled entry, and it
        // stays there until the person leaves.
        show(segmentFixture(segment));
        playback = undefined;
        return "finished";
      }
      show(segmentFixture(entered));
      playback = entered.kind === "play" ? entered.playback : undefined;
    }
    return "running";
  };

  /**
   * Draw one frame, then decide whether anything is still moving.
   *
   * The clock is started only when the renderer says it is animating or the
   * application's own transition has not finished, and halted as soon as both
   * have settled — so an idle REPL schedules nothing at all.
   */
  const paint = function* (deltaMs: number, finished = false): Operation<void> {
    const segment = currentSegment();
    const motion = playback === undefined ? undefined : motionAt(playback, elapsed);
    const label =
      finished || segment === undefined
        ? journey === undefined
          ? "focused"
          : "settled"
        : segmentLabel(segment);

    // A held moment is one picture. Drawing it again on the way past would cost
    // a render and change nothing, so the hold is drawn once and then waited
    // out.
    const repeated = journey !== undefined && segment?.kind === "hold" && held === label;
    if (!repeated) {
      const measured = { cols: state.cols, rows: state.rows };
      const focus: FocusView = {
        here: tree.focused().name,
        map: overlayOf(tree),
        overlay: repl.overlay,
      };
      // The moment on screen has its own mounted composition, kept for as long
      // as that moment is shown.
      let composition = compositions.get(state.fixture.name);
      if (composition === undefined) {
        composition = yield* useComposition(state.fixture, state.view);
        compositions.set(state.fixture.name, composition);
      }
      let painted: Painted;
      try {
        painted = draw(term, state, composition, write, options.mutation, motion, deltaMs, focus);
      } catch (error) {
        if (!(error instanceof RendererCapacityError)) {
          throw error;
        }
        // The renderer ran out of room to measure text, which a long run in a
        // wide terminal will do. A new one starts that cache again and repaints
        // the whole screen, so the person watching sees nothing but a frame.
        term = yield* useTerm(measured);
        painted = draw(term, state, composition, write, options.mutation, motion, 0, focus);
      }
      frames += 1;
      options.trace?.push({
        frame: frames,
        elapsedMs: elapsed,
        deltaSeconds: deltaMs / 1000,
        animating: painted.animating,
        motionDone: motion === undefined ? null : motion.done,
        bytes: painted.bytes,
        segment: label,
        fixture: state.fixture.name,
      });
      lastPainted = painted.animating;
    }
    held = segment?.kind === "hold" ? label : undefined;

    const journeyRunning = journey !== undefined && !finished;
    const moving = lastPainted || (motion !== undefined && !motion.done) || journeyRunning;
    const active = options.mutation === "never-tick" ? false : moving;
    if (clock !== undefined) {
      const running = clock;
      clock = undefined;
      yield* running.halt();
    }
    if (active) {
      const delay = Math.max(1, Math.round(nextDelayMs()));
      clock = yield* spawn(() => ticker(events, delay));
    }
    if (journey === undefined && motion !== undefined && motion.done && !lastPainted) {
      // The transition has arrived. What remains is the fixture itself, which
      // is what a journal or a URL would restore.
      playback = undefined;
      settled = true;
    }
    if (finished) {
      settled = true;
    }
    if (options.maxFrames !== undefined && !active) {
      // A run with a frame budget has nobody at the keyboard, so when nothing
      // is moving there is nothing left for it to do. A harness that scheduled
      // no frame at all ends here too, after exactly one.
      settled = true;
    }
  };

  yield* paint(0);

  while (true) {
    // `--frames` is a ceiling for a run nobody is watching: it leaves when the
    // playback has settled, or when that many frames have been drawn, whichever
    // comes first. Without it the harness waits for a keystroke, as it should.
    if (options.maxFrames !== undefined && (settled || frames >= options.maxFrames)) {
      return;
    }
    if (
      options.interruptAfterFrames !== undefined &&
      frames >= options.interruptAfterFrames &&
      !interrupted
    ) {
      interrupted = true;
      Deno.kill(Deno.pid, "SIGINT");
    }

    const next = yield* subscription.next();
    if (next.done) {
      return;
    }

    if (next.value.kind === "tick") {
      // The one-shot has fired and finished; the frame it produces arms the next.
      clock = undefined;
      const advanced = advance(next.value.advanceMs);
      yield* paint(next.value.advanceMs, advanced === "finished");
      continue;
    }

    // A keystroke or a resize is not time passing, so the renderer is told no
    // time has passed: a transition in flight keeps its own pace instead of
    // jumping forward because somebody typed.
    const pressed = next.value.kind === "key" ? asKey(next.value.event) : undefined;
    if (pressed !== undefined && pressed.type === "keydown") {
      const code = pressed.code;
      if (code === "p") {
        const starting = playbackFrom(state.fixture.name);
        if (starting !== undefined) {
          playback = starting;
          elapsed = 0;
          const target = fixture(starting.to);
          state = { ...state, fixture: target, view: initialView(target) };
          yield* paint(0);
          continue;
        }
      }
    }

    const before = { cols: state.cols, rows: state.rows };
    // Ignoring a resize means ignoring it completely — the renderer keeps the
    // dimensions it had, and goes on addressing cells the terminal no longer
    // has.
    if (next.value.kind === "resize") {
      if (options.mutation !== "skip-resize-update") {
        const measured = { cols: next.value.cols, rows: next.value.rows };
        state = { ...state, cols: measured.cols, rows: measured.rows };
        const resized = yield* drive(tree, repl, next.value, {
          size: measured,
          mutation: options.mutation,
          scrollLimit: 0,
        });
        repl = resized.state;
        if (journey === undefined && playback === undefined) {
          follow();
        }
      }
    } else {
      const lines = state.fixture.entry
        ? transcriptLines(state.fixture.entry, Math.max(1, state.cols - 2)).length
        : 0;
      const driven = yield* drive(tree, repl, next.value, {
        size: { cols: state.cols, rows: state.rows },
        mutation: options.mutation,
        scrollLimit: Math.max(0, lines - Math.max(1, state.rows - 8)),
      });
      repl = driven.state;
      if (journey === undefined && playback === undefined) {
        follow();
      } else {
        state = { ...state, quit: repl.quit };
      }
    }
    if (state.quit) {
      return;
    }
    if (state.cols !== before.cols || state.rows !== before.rows) {
      term.update({ width: state.cols, height: state.rows });
    }
    yield* paint(0);
  }
}

export interface ReplayOptions {
  readonly mutation?: Mutation;
  /** Raise SIGINT at the harness itself once this many frames have been drawn. */
  readonly interruptAfter?: number;
  /** Throw from the frame loop, to prove restoration survives a failure. */
  readonly failAfter?: number;
}

/**
 * The same lifecycle, with no terminal attached.
 *
 * A capture cannot show that the modes were restored, because restoration is a
 * sequence of bytes rather than a picture. This writes those bytes to an
 * ordinary pipe so the evidence can read them, and drives the same setup,
 * frames, resize and teardown path the interactive harness uses.
 */
export function* runReplay(options: ReplayOptions): Operation<void> {
  const chunks: Uint8Array[] = [];
  const write = (bytes: Uint8Array) => {
    chunks.push(bytes);
    // The same rule as the interactive host: the restoring bytes are written
    // from teardown, where an asynchronous write is not guaranteed to finish.
    // oxlint-disable-next-line local/no-sync-filesystem
    Deno.stdout.writeSync(bytes);
  };

  let state: HarnessState = {
    view: initialView(fixture("nested")),
    fixture: fixture("nested"),
    cols: 200,
    rows: 50,
    quit: false,
  };
  const term = yield* useTerm({ cols: state.cols, rows: state.rows });

  yield* useTerminalModes(write, options.mutation);

  const events = createSignal<HarnessEvent, never>();
  const subscription = yield* events;
  yield* useSignalListener("SIGINT", () => events.send({ kind: "quit" }));

  const script: readonly {
    readonly cols: number;
    readonly rows: number;
    readonly fixture: FixtureName;
  }[] = [
    { cols: 200, rows: 50, fixture: "nested" },
    { cols: 140, rows: 38, fixture: "drawer" },
    { cols: 90, rows: 28, fixture: "paused" },
    { cols: 64, rows: 18, fixture: "paused" },
    { cols: 200, rows: 50, fixture: "settled" },
  ];

  let drawn = 0;
  for (const step of script) {
    const next = fixture(step.fixture);
    state = { ...state, fixture: next, view: initialView(next), cols: step.cols, rows: step.rows };
    if (options.mutation !== "skip-resize-update") {
      term.update({ width: state.cols, height: state.rows });
    }
    const composition = yield* useComposition(state.fixture, state.view);
    draw(term, state, composition, write, options.mutation);
    drawn += 1;
    if (options.failAfter !== undefined && drawn >= options.failAfter) {
      throw new Error("the harness failed while drawing a frame");
    }
    if (options.interruptAfter !== undefined && drawn >= options.interruptAfter) {
      // The signal is delivered by the operating system to the listener
      // installed above; waiting for it here is what proves the listener, and
      // the restoration behind it, are reached by a real interruption.
      Deno.kill(Deno.pid, "SIGINT");
      const interrupted = yield* subscription.next();
      if (!interrupted.done && interrupted.value.kind === "quit") {
        return;
      }
      return;
    }
  }
  yield* chunksDrawn(chunks);
}

/** Frames written, kept so a caller can assert on them without a terminal. */
function* chunksDrawn(chunks: readonly Uint8Array[]): Operation<void> {
  if (chunks.length === 0) {
    throw new Error("the replay drew no frames");
  }
}

export function fixtureNames(): readonly FixtureName[] {
  return fixtures().map((one) => one.name);
}

export { SURFACES };
