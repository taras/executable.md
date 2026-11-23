import { createScope, ensure, Err, Ok, race, sleep, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { useReplPage } from "../../../packages/cli/tests/support/repl-page.ts";
import type {
  PageKey,
  ReplPage,
  ScreenReading,
  ScreenScope,
} from "../../../packages/cli/tests/support/repl-page.ts";
import {
  COMPOSER_VALUE,
  intoComposer,
} from "../../../packages/cli/tests/support/screen-journeys.ts";
import {
  generateTypingDraft,
  generateTypingHistory,
} from "../../../packages/cli/tests/support/typing-history.ts";
import type { Command, Region, Size } from "./protocol.ts";

export interface MountedOptions extends Size {
  readonly draft?: { readonly lines: number };
  readonly history?: { readonly rounds: number; readonly linesPerRound: number };
}

const KEYS = new Map<string, PageKey>([
  ["Enter", "Enter"],
  ["Escape", "Escape"],
  ["Tab", "Tab"],
  ["BTab", "Backtab"],
  ["Backtab", "Backtab"],
  ["Backspace", "Backspace"],
  ["Up", "ArrowUp"],
  ["Down", "ArrowDown"],
  ["Left", "ArrowLeft"],
  ["Right", "ArrowRight"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
]);

function unanswered(what: string): Error {
  return new Error(`The mounted driver does not answer ${what}.`);
}

function scopeOf(region: Region | undefined): ScreenScope | undefined {
  if (region === undefined) {
    return undefined;
  }
  if (region === "sidekick-composer") {
    return COMPOSER_VALUE;
  }
  throw unanswered(`the ${region} region`);
}

function* wait(page: ReplPage, command: Extract<Command, { action: "wait" }>): Operation<unknown> {
  if (command.at !== undefined || command.row !== undefined || command.bold !== undefined) {
    throw unanswered("a wait by cell, row or weight");
  }
  const scope = scopeOf(command.region);
  const holds = (reading: ScreenReading): boolean => {
    const found = reading.found(command.text, scope);
    if (command.count !== undefined) {
      return found === command.count;
    }
    return command.present === false ? found === 0 : found > 0;
  };
  const reading = yield* page.until(`"${command.text}" on the mounted screen`, holds);
  if (command.unique !== true) {
    return null;
  }
  if (reading.found(command.text, scope) !== 1) {
    throw new Error(`Expected one match for "${command.text}" on the mounted screen.`);
  }
  const cell = reading.locate(command.text, scope);
  return { row: cell.row, column: cell.column };
}

/** The reading a key or wheel burst was sent after, until a pause waits for its frame. */
interface PendingInput {
  from: number | undefined;
}

/** How long a pause waits for the frame of the preceding input, in milliseconds. */
const INPUT_FRAME_MS = 2000;

function* answer(page: ReplPage, command: Command, pendingInput: PendingInput): Operation<unknown> {
  switch (command.action) {
    case "ready":
      return null;
    case "focus":
      yield* intoComposer(page);
      return null;
    case "type":
      yield* page.type(command.text);
      return null;
    case "key": {
      const key = KEYS.get(command.key);
      if (key === undefined) {
        throw unanswered(`the ${command.key} key`);
      }
      pendingInput.from ??= page.screen().index;
      yield* page.key(key);
      return null;
    }
    case "resize":
      yield* page.resize({ columns: command.columns, rows: command.rows });
      return null;
    case "scroll": {
      if (command.region !== undefined) {
        throw unanswered(`the ${command.region} region`);
      }
      if (command.at === undefined) {
        throw unanswered("a scroll without a cell");
      }
      if (command.delta === 0) {
        return null;
      }
      pendingInput.from ??= page.screen().index;
      for (let notch = 0; notch < Math.abs(command.delta); notch += 1) {
        yield* page.wheel(command.delta < 0 ? "up" : "down", command.at);
      }
      return null;
    }
    case "pause": {
      const from = pendingInput.from;
      pendingInput.from = undefined;
      if (from !== undefined) {
        // Input clamped against a boundary can paint nothing, so the wait
        // for its frame is bounded rather than required.
        yield* race([
          page.until("the frame of a key or wheel burst", (one) => one.index > from),
          sleep(INPUT_FRAME_MS),
        ]);
      }
      yield* sleep(command.ticks * command.tick);
      return null;
    }
    case "wait":
      return yield* wait(page, command);
    default:
      throw unanswered(`the ${command.action} action`);
  }
}

// The page is mounted in a root scope, which inherits nothing. An entry the
// mounted REPL runs therefore never passes through the testing session of the
// document that mounted it, and that session admits one execution.
export function* connectMounted(
  options: MountedOptions,
): Operation<(command: Command) => Operation<unknown>> {
  const [scope, destroy] = createScope();
  yield* ensure(() => destroy());
  const ready = withResolvers<ReplPage>();
  scope.run(function* () {
    try {
      const page = yield* useReplPage({ size: { columns: options.columns, rows: options.rows } });
      if (options.history !== undefined) {
        const { rounds, linesPerRound } = options.history;
        yield* generateTypingHistory(page, rounds, linesPerRound, true);
      }
      if (options.draft !== undefined) {
        yield* generateTypingDraft(page, options.draft.lines);
      }
      ready.resolve(page);
      yield* suspend();
    } catch (error) {
      ready.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const page = yield* ready.operation;
  const pendingInput: PendingInput = { from: undefined };
  // A command that fails is handed back as a result. Thrown inside the scope it
  // would fail the scope too, and one refused step would end the mounted REPL.
  return function* (command) {
    const result: Result<unknown> = yield* scope.run(function* () {
      try {
        return Ok(yield* answer(page, command, pendingInput));
      } catch (error) {
        return Err(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  };
}
