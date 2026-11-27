import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { journalBeforeEach } from "@executablemd/test-support/failure-journal";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { useReplPage } from "../../../packages/cli/tests/support/repl-page.ts";
import type { ReplPage, ScreenReading } from "../../../packages/cli/tests/support/repl-page.ts";
import { generateTypingHistory } from "../../../packages/cli/tests/support/typing-history.ts";
import { mountedAnswers } from "../lib/driver-mounted.ts";
import type { Command } from "../lib/protocol.ts";

const OWNER = "examples/repl-bench/tests/driver-mounted.test.ts";

const READING = { row: 10, column: 60 };

/** The payload line at the top of the entry reading, the leftmost pane that shows one. */
function readingTop(reading: ScreenReading): number {
  for (const row of reading.rows) {
    const match = /TAIL-[A-Z]+-(\d{3})/.exec(row);
    if (match !== null) {
      return Number(match[1]);
    }
  }
  throw new Error(`no payload line in the reading: ${JSON.stringify(reading.rows)}`);
}

interface Burst {
  readonly chunks: number;
  readonly writes: number;
  readonly moved: number;
}

function* burst(
  page: ReplPage,
  answer: (command: Command) => Operation<unknown>,
  delta: number,
): Operation<Burst> {
  const before = page.screen();
  const fed = page.repl.terminal.fed;
  yield* answer({ action: "scroll", delta, at: READING });
  yield* answer({ action: "pause", ticks: 1, tick: 16 });
  const after = page.screen();
  return {
    chunks: page.repl.terminal.fed - fed,
    writes: after.index - before.index,
    moved: readingTop(after) - readingTop(before),
  };
}

describe("mounted driver", () => {
  beforeEach(journalBeforeEach(OWNER));

  // A terminal delivers the notches of one burst together. Fed one notch at a
  // time, an idle REPL draws the first notch alone and the rest as a second
  // frame, and the pause after the burst returns on the first of them.
  it("feeds a wheel burst as one input chunk and draws it as one frame", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* generateTypingHistory(page, 2, 32, true);
    const answer = mountedAnswers(page);
    yield* burst(page, answer, 1);

    expect(yield* burst(page, answer, 3)).toEqual({ chunks: 1, writes: 1, moved: 9 });
    expect(yield* burst(page, answer, -3)).toEqual({ chunks: 1, writes: 1, moved: -9 });
  });
});
