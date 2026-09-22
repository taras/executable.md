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
import type { Input, InputEvent, Setting, Term } from "@bomb.sh/tty";
import { createSignal, ensure, resource, sleep, spawn, until } from "effection";
import type { Operation, Signal, Task } from "effection";

import { fixture, fixtures } from "./fixtures.ts";
import { FIXTURE_NAMES } from "./model.ts";
import type { Fixture, FixtureName } from "./model.ts";
import { layoutFor, SURFACES } from "./layout.ts";
import { renderScreen } from "./render.ts";
import { transcriptLines } from "./render.ts";
import { initialView, moveSurface, returnToHead, scrollBy, scrubBy, toggleDrawer } from "./view.ts";
import type { View } from "./view.ts";
import { renderInto, useTerm } from "./capture.ts";
import type { Mutation } from "./mutations.ts";
import { motionAt, playbackFrom } from "./playback.ts";
import type { Motion, Playback } from "./playback.ts";

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

export type HarnessEvent =
  | { readonly kind: "key"; readonly event: InputEvent }
  | { readonly kind: "resize" }
  | { readonly kind: "tick" }
  | { readonly kind: "quit" };

export interface HarnessState {
  readonly view: View;
  readonly fixture: Fixture;
  readonly cols: number;
  readonly rows: number;
  readonly quit: boolean;
}

function fixtureAt(index: number): FixtureName {
  return FIXTURE_NAMES[Math.max(0, Math.min(FIXTURE_NAMES.length - 1, index))];
}

/**
 * How one event changes what is shown.
 *
 * Pure, so the same transitions the interactive harness performs can be
 * replayed without a terminal.
 */
export function reduce(state: HarnessState, event: HarnessEvent): HarnessState {
  if (event.kind === "quit") {
    return { ...state, quit: true };
  }
  if (event.kind === "resize") {
    const size = measureTerminal();
    return { ...state, cols: size.cols, rows: size.rows };
  }
  if (event.kind === "tick") {
    // A frame passing changes what is drawn, never what is shown: the motion is
    // a function of elapsed time, which the frame loop owns.
    return state;
  }
  const key = event.event;
  if (key.type !== "keydown") {
    return state;
  }
  if (key.code === "q" || (key.ctrl === true && key.code === "c")) {
    return { ...state, quit: true };
  }
  const digit = Number(key.code);
  if (!Number.isNaN(digit) && digit >= 1 && digit <= FIXTURE_NAMES.length) {
    const next = fixture(fixtureAt(digit - 1));
    return { ...state, fixture: next, view: initialView(next) };
  }
  const layout = layoutFor({
    cols: state.cols,
    rows: state.rows,
    drawer: state.fixture.drawer !== undefined && state.view.drawerOpen,
    surface: state.view.surface,
  });
  const width = Math.max(1, (layout.transcript?.width ?? state.cols) - 2);
  const height = layout.transcript?.height ?? state.rows;
  const total = state.fixture.entry ? transcriptLines(state.fixture.entry, width).length : 0;
  const limit = Math.max(0, total - Math.max(1, height - 3));
  const checkpoints = state.fixture.history.checkpoints.length;

  if (key.code === "ArrowUp") {
    return { ...state, view: scrollBy(state.view, -1, limit) };
  }
  if (key.code === "ArrowDown") {
    return { ...state, view: scrollBy(state.view, 1, limit) };
  }
  if (key.code === "PageUp") {
    return { ...state, view: scrollBy(state.view, -Math.max(1, height - 4), limit) };
  }
  if (key.code === "PageDown") {
    return { ...state, view: scrollBy(state.view, Math.max(1, height - 4), limit) };
  }
  if (key.code === "ArrowLeft") {
    return { ...state, view: scrubBy(state.view, -1, checkpoints) };
  }
  if (key.code === "ArrowRight") {
    return { ...state, view: scrubBy(state.view, 1, checkpoints) };
  }
  if (key.code === "Escape") {
    return { ...state, view: returnToHead(state.view) };
  }
  if (key.code === "Tab") {
    return { ...state, view: moveSurface(state.view, key.shift === true ? -1 : 1) };
  }
  if (key.code === "d") {
    return { ...state, view: toggleDrawer(state.view) };
  }
  return state;
}

/** One frame drawn, and whether the renderer is still moving. */
interface Painted {
  readonly animating: boolean;
  readonly bytes: number;
}

function draw(
  term: Term,
  state: HarnessState,
  write: (bytes: Uint8Array) => void,
  mutation?: Mutation,
  motion?: Motion,
  deltaMs = 0,
): Painted {
  // One render path for the harness and for the captures, so what a person sees
  // in a terminal and what a golden records cannot drift apart.
  const frame = renderInto(term, {
    fixture: state.fixture,
    view: state.view,
    size: { cols: state.cols, rows: state.rows },
    mutation,
    motion,
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
 * The clock that keeps an animation moving when nothing else is happening.
 *
 * It is spawned as a child of the terminal session and halted the moment
 * nothing is moving, so an idle REPL costs nothing and a cancelled session
 * cannot leave a timer drawing into a terminal that has already been restored.
 */
function* ticker(events: Signal<HarnessEvent, never>): Operation<void> {
  while (true) {
    yield* sleep(FRAME_MS);
    events.send({ kind: "tick" });
  }
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
}

export interface InteractiveOptions {
  readonly fixture: FixtureName;
  readonly mutation?: Mutation;
  /** Start this playback immediately, rather than waiting for `p`. */
  readonly play?: Playback;
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
  let state: HarnessState = {
    view: initialView(fixture(options.fixture)),
    fixture: fixture(options.fixture),
    cols: size.cols,
    rows: size.rows,
    quit: false,
  };

  const term = yield* useTerm({ cols: state.cols, rows: state.rows });
  const input: Input = yield* until(createInput({}));

  yield* useTerminalModes(write, options.mutation);
  yield* useRawMode(options.mutation);

  const events = createSignal<HarnessEvent, never>();
  const subscription = yield* events;

  yield* useSignalListener("SIGWINCH", () => events.send({ kind: "resize" }));
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
      const scanned = input.scan(chunk.value);
      for (const event of scanned.events) {
        events.send({ kind: "key", event });
      }
    }
  });

  let playback = options.play;
  let elapsed = 0;
  let frames = 0;
  let clock: Task<void> | undefined;
  let interrupted = false;
  let settled = false;

  if (playback !== undefined) {
    const target = fixture(playback.to);
    state = { ...state, fixture: target, view: initialView(target) };
  }

  /**
   * Draw one frame, then decide whether anything is still moving.
   *
   * The clock is started only when the renderer says it is animating or the
   * application's own transition has not finished, and halted as soon as both
   * have settled — so an idle REPL schedules nothing at all.
   */
  const paint = function* (deltaMs: number): Operation<void> {
    const motion = playback === undefined ? undefined : motionAt(playback, elapsed);
    const painted = draw(term, state, write, options.mutation, motion, deltaMs);
    frames += 1;
    options.trace?.push({
      frame: frames,
      elapsedMs: elapsed,
      deltaSeconds: deltaMs / 1000,
      animating: painted.animating,
      motionDone: motion === undefined ? null : motion.done,
      bytes: painted.bytes,
    });

    const moving = painted.animating || (motion !== undefined && !motion.done);
    const active = options.mutation === "never-tick" ? false : moving;
    if (active && clock === undefined) {
      clock = yield* spawn(() => ticker(events));
    }
    if (!active && clock !== undefined) {
      const running = clock;
      clock = undefined;
      yield* running.halt();
    }
    if (motion !== undefined && motion.done && !painted.animating) {
      // The transition has arrived. What remains is the fixture itself, which
      // is what a journal or a URL would restore.
      playback = undefined;
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
      elapsed += FRAME_MS;
      yield* paint(FRAME_MS);
      continue;
    }

    // A keystroke or a resize is not time passing, so the renderer is told no
    // time has passed: a transition in flight keeps its own pace instead of
    // jumping forward because somebody typed.
    const pressed = next.value.kind === "key" ? next.value.event : undefined;
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
    state =
      next.value.kind === "resize" && options.mutation === "skip-resize-update"
        ? state
        : reduce(state, next.value);
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
    draw(term, state, write, options.mutation);
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
