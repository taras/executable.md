import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { useReplPage } from "../../../packages/cli/tests/support/repl-page.ts";
import type { ReplPage } from "../../../packages/cli/tests/support/repl-page.ts";
import {
  composerHolds,
  intoComposer,
} from "../../../packages/cli/tests/support/screen-journeys.ts";
import { generateTypingHistory } from "../../../packages/cli/tests/support/typing-history.ts";
import { EDITS, VIEWPORT, WARMUP, WORKLOADS } from "../lib/typing-latency-report.ts";
import type { TypingSample } from "../lib/typing-latency-report.ts";

const MARKER = "XMD:";
const CHARACTERS = "abcdefghijklmnopqrstuvwxyz".repeat(2).slice(0, EDITS);
const revision = Deno.env.get("XMD_TYPING_BENCH_REVISION");

function* sampleTyping(page: ReplPage): Operation<TypingSample[]> {
  const { terminal } = page.repl;
  const screen = terminal.screen;
  if (screen === undefined) {
    throw new Error("The mounted terminal has no emulator.");
  }
  yield* intoComposer(page);
  yield* page.type(MARKER);
  yield* page.until("the typing marker in Message", (reading) => composerHolds(reading, MARKER));

  const feed = screen.feed;
  const completed = new Map<number, number>();
  screen.feed = (bytes) => {
    feed.call(screen, bytes);
    // The terminal increments its completed-write index after the emulator accepts the bytes.
    completed.set(terminal.drawn + 1, performance.now());
  };
  try {
    let value = MARKER;
    const samples: TypingSample[] = [];
    for (const [index, character] of [...CHARACTERS].entries()) {
      const before = page.screen();
      const drawn = terminal.drawn;
      completed.clear();
      value += character;
      expect(composerHolds(before, value)).toBe(false);
      const startedAt = performance.now();
      yield* page.type(character);
      const changed = yield* page.until(
        `edit ${index + 1} in Message`,
        (reading) => reading.index > before.index && composerHolds(reading, value),
      );
      const writes = changed.index - before.index;
      const completedAt = completed.get(drawn + writes);
      if (completedAt === undefined || completedAt <= startedAt) {
        throw new Error(`No completed emulator write for edit ${index + 1}.`);
      }
      samples.push({ edit: index + 1, milliseconds: completedAt - startedAt, writes });
    }
    return samples;
  } finally {
    screen.feed = feed;
  }
}

if (revision !== undefined) {
  describe("mounted REPL typing latency", () => {
    for (const workload of WORKLOADS) {
      it(workload.name, function* () {
        const page = yield* useReplPage({ size: VIEWPORT });
        yield* generateTypingHistory(page, workload.rounds, workload.linesPerRound, true);
        const prompts = page.repl.fake.prompts.length;
        const providers = page.repl.fake.created.length;
        const samples = yield* sampleTyping(page);
        expect(samples).toHaveLength(EDITS);
        expect(page.repl.fake.prompts.length).toBe(prompts);
        expect(page.repl.fake.created.length).toBe(providers);
        console.log(
          "XMD_TYPING_SAMPLE " +
            JSON.stringify({
              revision,
              runtime: Deno.version,
              host: { os: Deno.build.os, arch: Deno.build.arch },
              viewport: VIEWPORT,
              workload,
              warmup: WARMUP,
              samples,
            }),
        );
      });
    }
  });
}
