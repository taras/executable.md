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
import { createSignal, ensure, resource, spawn, until } from "effection";
import type { Operation } from "effection";

import { fixture, fixtures } from "./fixtures.ts";
import { FIXTURE_NAMES } from "./model.ts";
import type { Fixture, FixtureName } from "./model.ts";
import { layoutFor, SURFACES } from "./layout.ts";
import { renderScreen } from "./render.ts";
import { transcriptLines } from "./render.ts";
import { initialView, moveSurface, returnToHead, scrollBy, scrubBy, toggleDrawer } from "./view.ts";
import type { View } from "./view.ts";
import { useTerm } from "./capture.ts";
import type { Mutation } from "./mutations.ts";

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

function draw(
  term: Term,
  state: HarnessState,
  write: (bytes: Uint8Array) => void,
  mutation?: Mutation,
): void {
  const layout = layoutFor({
    cols: state.cols,
    rows: state.rows,
    drawer: state.fixture.drawer !== undefined && state.view.drawerOpen,
    surface: state.view.surface,
    mutation,
  });
  const result = term.render(
    renderScreen({ fixture: state.fixture, view: state.view, layout, mutation }),
  );
  write(Uint8Array.from(result.output));
}

export interface InteractiveOptions {
  readonly fixture: FixtureName;
  readonly mutation?: Mutation;
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

  draw(term, state, write, options.mutation);

  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      return;
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
    draw(term, state, write, options.mutation);
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
