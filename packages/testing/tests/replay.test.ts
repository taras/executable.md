import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { TestFailureError } from "../src/test-api.ts";
import { failureOf, runDoc } from "./helpers.ts";
import type { DocRun, RunDocOptions } from "./helpers.ts";
import type { Operation } from "effection";

interface LiveAndReplay {
  live: DocRun;
  replay: DocRun;
  replayStream: InMemoryStream;
}

/**
 * Run a document live on a fresh journal, then run it again on a copy of
 * the completed journal — a confirmed full replay.
 */
function* liveThenReplay(
  files: Record<string, string>,
  options: RunDocOptions = {},
): Operation<LiveAndReplay> {
  const liveStream = new InMemoryStream();
  const live = yield* runDoc(files, { ...options, stream: liveStream });
  const events = yield* liveStream.readAll();
  const replayStream = new InMemoryStream(events);
  const replay = yield* runDoc(files, { ...options, stream: replayStream });
  return { live, replay, replayStream };
}

describe("testing replay", () => {
  it("a passing useTesting run preserves its outcome and results on full replay", function* () {
    const { live, replay, replayStream } = yield* liveThenReplay(
      { "README.md": '<Test name="one"><Assert expr={true} /></Test>\n' },
      { testing: true },
    );
    expect(live.completion.ok).toBe(true);
    expect(replay.completion.ok).toBe(true);
    expect(replay.results).toEqual(live.results);
    expect(replay.results.map((r) => [r.name, r.status])).toEqual([["one", "pass"]]);
    // Full replay appends nothing to the journal.
    expect(replayStream.appendCount).toBe(0);
  });

  it("a failing useTesting run stays failed on full replay, with results available", function* () {
    const { live, replay } = yield* liveThenReplay(
      { "README.md": '<Test name="bad"><Assert expr={false} /></Test>\n' },
      { testing: true },
    );
    expect(failureOf(live)).toBeInstanceOf(TestFailureError);
    expect(failureOf(replay)).toBeInstanceOf(TestFailureError);
    expect(replay.results).toEqual(live.results);
    expect(replay.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["bad", "fail", "assertion"],
    ]);
  });

  it("a zero-test useTesting run stays failed on full replay", function* () {
    const { live, replay } = yield* liveThenReplay(
      { "README.md": "just text\n" },
      { testing: true },
    );
    expect(failureOf(live)?.message).toContain("no tests were discovered");
    expect(failureOf(replay)?.message).toContain("no tests were discovered");
    expect(replay.results).toEqual([]);
  });

  it("explicit <Testing> boundaries preserve pass, fail, and empty outcomes on replay", function* () {
    const passing = yield* liveThenReplay({
      "README.md": "<Testing><Test><Assert expr={true} /></Test></Testing>\n",
    });
    expect(passing.live.completion.ok).toBe(true);
    expect(passing.replay.completion.ok).toBe(true);
    expect(passing.replay.boundaries).toEqual([{ tests: 1, failed: 0 }]);

    const failing = yield* liveThenReplay({
      "README.md": "<Testing><Test><Assert expr={false} /></Test></Testing>\n",
    });
    expect(failureOf(failing.live)).toBeInstanceOf(TestFailureError);
    expect(failureOf(failing.replay)).toBeInstanceOf(TestFailureError);
    expect(failing.replay.boundaries).toEqual([{ tests: 1, failed: 1 }]);

    const empty = yield* liveThenReplay({
      "README.md": "<Testing>no tests</Testing>\n",
    });
    expect(failureOf(empty.live)).toBeInstanceOf(TestFailureError);
    expect(failureOf(empty.replay)).toBeInstanceOf(TestFailureError);
    expect(empty.replay.boundaries).toEqual([{ tests: 0, failed: 0 }]);
  });

  it("partial replay records each result exactly once, in discovery order", function* () {
    const files = {
      "README.md": [
        '<Test name="first"><Assert expr={true} /></Test>',
        '<Test name="second"><Assert expr={true} /></Test>',
        "",
      ].join("\n"),
    };
    const liveStream = new InMemoryStream();
    const live = yield* runDoc(files, { testing: true, stream: liveStream });
    expect(live.completion.ok).toBe(true);

    // Drop the root Close: the journal is now a partial trace, so the
    // document re-expands with completed durable records replaying in place.
    const events = yield* liveStream.readAll();
    const partial = events.filter((event: DurableEvent) => event.type !== "close");
    const resumed = yield* runDoc(files, {
      testing: true,
      stream: new InMemoryStream(partial),
    });
    expect(resumed.completion.ok).toBe(true);
    expect(resumed.results.map((r) => [r.name, r.status])).toEqual([
      ["first", "pass"],
      ["second", "pass"],
    ]);
  });

  it("full replay leaves output unchanged and reruns no document effects", function* () {
    const execCalls: string[] = [];
    yield* API.Process.around({
      // deno-lint-ignore require-yield
      *exec([options], _next) {
        execCalls.push(options.command.join(" "));
        return { exitCode: 0, stdout: "ran\n", stderr: "" };
      },
    });
    const files = {
      "README.md": [
        "<Testing><Test>",
        "```bash exec",
        "echo hi",
        "```",
        "<Assert expr={true} />",
        "</Test></Testing>",
        "",
      ].join("\n"),
    };
    const { live, replay, replayStream } = yield* liveThenReplay(files);
    expect(live.completion.ok).toBe(true);
    expect(replay.completion.ok).toBe(true);
    expect(execCalls).toHaveLength(1);
    expect(replay.output).toBe(live.output);
    expect(replayStream.appendCount).toBe(0);
  });
});
