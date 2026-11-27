import process from "node:process";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { Agent, AgentProviders } from "@executablemd/agent/api";
import { API } from "@executablemd/runtime";
import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { journalBeforeEach } from "@executablemd/test-support/failure-journal";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, race, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { runXmd } from "../src/cli.ts";
import { ReplEntryHost } from "../src/repl-entry-installation.ts";
import { ReplClock } from "../src/repl/frame.ts";
import { PagedHistory } from "../src/repl/paged-history.ts";
import type { EntryRestoreProgress } from "../src/repl/paged-history.ts";
import { ReplTerminal } from "../src/repl/terminal.ts";
import { unsupportedWorkflowHost } from "../src/workflow.ts";
import { recordingTerminal, useMountedHost } from "./support/mounted-repl.ts";
import type { Terminal } from "./support/mounted-repl.ts";
import { invalidRestoreEntries, savedRestoreFixture } from "./support/restore-progress.ts";
import type { RetainedRestoreFixture } from "./support/restore-progress.ts";
import { PLACEHOLDER } from "./support/screen-journeys.ts";

const OWNER = "packages/cli/tests/repl-restore-progress.test.ts";

const WIDE = { columns: 160, rows: 36 };
const MEDIUM = { columns: 120, rows: 30 };
const NARROW = { columns: 72, rows: 20 };
const EARLIER = 2;
const PARTWAY = "Restoring rounds · 42 / 155";
const STOPPED = "Restoring rounds · 118 / 155 · stopped";
const DIAGNOSTIC = "the recorded outcome of this entry cannot be read by this version of the REPL.";

function gate() {
  const reached = withResolvers<void>();
  const released = withResolvers<void>();
  let joined = false;
  return {
    reached: reached.operation,
    release: () => released.resolve(),
    get joined() {
      return joined;
    },
    wait: () =>
      scoped(function* () {
        yield* ensure(() => {
          joined = true;
        });
        reached.resolve();
        yield* released.operation;
      }),
  };
}

type Gate = ReturnType<typeof gate>;

function* openCold(location: string, size = WIDE, holds: ReadonlyMap<number, Gate> = new Map()) {
  const recording = recordingTerminal(size);
  const { terminal } = recording;
  let checkpoints = 0;
  const calls = { provider: 0, prompt: 0, entry: 0, command: 0 };
  const stderr: { text: string; resets: number; readers: number }[] = [];
  const stdout: string[] = [];
  let status = 0;
  const exitContext = createContext<(result: { status: number }) => Operation<void>>("exit");
  yield* exitContext.set(function* (result) {
    status = result.status;
  });

  const error = console.error;
  const write = process.stdout.write;
  yield* ensure(() => {
    console.error = error;
    process.stdout.write = write;
  });
  console.error = (...parts: unknown[]) => {
    stderr.push({
      text: parts.map(String).join(" "),
      resets: terminal.resets,
      readers: terminal.readers,
    });
  };
  process.stdout.write = function (...args: unknown[]): boolean {
    const [text, callback] = args;
    if (typeof text === "string" && text.startsWith("Reopen this view with:")) {
      stdout.push(text);
      if (typeof callback === "function") {
        callback();
      }
      return true;
    }
    return Reflect.apply(write, process.stdout, args);
  };
  const task = yield* spawn(function* () {
    let failure: Error | undefined;
    yield* ensure(() => terminal.stopped(failure));
    yield* ReplClock.around({
      *wait([seconds], next) {
        if (seconds === 0) {
          const held = holds.get(++checkpoints);
          if (held !== undefined) {
            yield* held.wait();
          }
        }
        yield* next(seconds);
      },
    });
    yield* AgentProviders.around({
      *install([request], next) {
        if (request.intent === "install") {
          calls.provider += 1;
        }
        return yield* next(request);
      },
    });
    yield* Agent.around({
      *prompt([message, options], next) {
        calls.prompt += 1;
        return yield* next(message, options);
      },
    });
    yield* API.Process.around({
      *exec() {
        calls.command += 1;
        throw new Error("Cold reopen attempted to start a subprocess.");
      },
    });
    try {
      yield* runXmd(
        ["repl", location],
        function* () {},
        {
          provenance: "deno-source",
          currentVersion: "0.0.0-test",
          executablePath: "/nonexistent",
          platform: "darwin",
          architecture: "arm64",
        },
        function* () {
          throw new Error("Unexpected stdin document.");
        },
        function* () {
          throw new Error("Unexpected Plugin load.");
        },
        unsupportedWorkflowHost,
        undefined,
        {
          install: recording.install,
          *select() {
            yield* ReplEntryHost.set(function* () {
              calls.entry += 1;
              throw new Error("Cold reopen attempted to initialize an entry.");
            });
          },
        },
      );
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error(String(cause));
      throw failure;
    }
  });
  return {
    terminal,
    task,
    calls,
    stderr,
    stdout,
    status: () => status,
    checkpoints: () => checkpoints,
  };
}

function* bounded<T>(terminal: Terminal, condition: string, action: Operation<T>): Operation<T> {
  return yield* race([
    action,
    (function* () {
      yield* sleep(8_000);
      throw new Error(
        `Timed out waiting for ${condition} after ${terminal.drawn} completed writes\n` +
          (terminal.screen?.rows().join("\n") ?? ""),
      );
    })(),
  ]);
}

function shown(terminal: Terminal, text: string, after = -1): Operation<string[]> {
  return bounded(
    terminal,
    text,
    (function* () {
      while (true) {
        const count = terminal.drawn;
        const lines = terminal.screen?.rows() ?? [];
        if (count > after && lines.some((line) => line.includes(text))) {
          return lines;
        }
        if (terminal.ending !== undefined) {
          throw new Error(`The command ended before showing ${text}\n${lines.join("\n")}`);
        }
        yield* terminal.after(count);
      }
    })(),
  );
}

function bar(lines: readonly string[], restored: number, total: number): void {
  const cells = lines.map((line) => line.trim()).find((line) => /^[━─]+$/u.test(line)) ?? "";
  expect(cells.length).toBeGreaterThan(1);
  expect(cells).toMatch(/^[━]*[─]*$/u);
  expect(cells.replaceAll("─", "").length).toBe(Math.round((restored / total) * cells.length));
}

function* unchanged(fixture: RetainedRestoreFixture, entries = fixture.entries): Operation<void> {
  expect(yield* readTextFile(fixture.files.entries)).toBe(entries);
  expect(yield* readTextFile(fixture.files.sidekick)).toBe(fixture.sidekick);
}

function settled(
  command: Awaited<ReturnType<typeof openCold> extends Operation<infer T> ? T : never>,
): void {
  expect(command.calls).toEqual({ provider: 0, prompt: 0, entry: 0, command: 0 });
  expect(command.terminal.raw).toEqual([true, false]);
  expect(command.terminal.resets).toBe(1);
  expect(command.terminal.readers).toBe(0);
  expect(command.terminal.listeners).toBe(0);
}

describe("#1037 cold restore progress", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("draws projected rounds, resizes, then waits for Sidekick before opening the original view", function* () {
    const held = yield* savedRestoreFixture(yield* useMountedHost(), 155);
    const rounds = gate();
    const sidekick = gate();
    const command = yield* openCold(
      `xmd://repl/${held.id}/entries/entry-155?view=sidekick`,
      WIDE,
      new Map([
        [43, rounds],
        [157, sidekick],
      ]),
    );
    const { terminal } = command;
    yield* bounded(command.terminal, "round 42 gate", rounds.reached);
    const reading = yield* shown(terminal, PARTWAY);
    const progress = reading.join("\n");
    expect(progress).toContain(`resuming ${held.id}`);
    expect(progress).toContain(`xmd repl 'xmd://repl/${held.id}/entries/entry-155?view=sidekick'`);
    expect(progress).toMatch(/elapsed \d+\.\ds/u);
    expect(progress).toMatch(/✓  Resolve the location +\d+\.\ds/u);
    expect(progress).toMatch(/✓  Open the session store +\d+\.\ds/u);
    expect(progress).toMatch(/—  Restore rounds +\d+\.\ds/u);
    expect(progress).toMatch(/·  Restore the Sidekick conversation/u);
    bar(reading, 42, 155);
    const before = terminal.drawn;
    terminal.resized(MEDIUM);
    bar(yield* shown(terminal, PARTWAY, before), 42, 155);
    terminal.resized(WIDE);
    rounds.release();
    yield* bounded(terminal, "Sidekick projection gate", sidekick.reached);
    const pending = yield* shown(terminal, "Restoring Sidekick history · count not known yet");
    expect(pending.join("\n")).toContain("Restored rounds · 155 / 155");
    expect(pending.join("\n")).toContain("Saved messages are being read before the REPL can open.");
    expect(pending.join("\n")).toMatch(/—  Restore the Sidekick conversation +\d+\.\ds/u);
    expect(pending.join("\n")).not.toContain(PLACEHOLDER);
    bar(pending, 155, 155);
    sidekick.release();

    yield* shown(terminal, "Entry 155");
    yield* shown(terminal, "Saved round 155 witness.");
    yield* shown(terminal, "Saved Sidekick reply witness.");
    yield* shown(terminal, "Restored 155 rounds in ");
    terminal.feed("\x074");
    yield* shown(terminal, "> + New Round");
    terminal.feed("\r");
    yield* shown(terminal, "> Round 156");
    terminal.feed("reopened-draft");
    const live = yield* shown(terminal, "reopened-draft");
    const draft = live.map((row) => row.slice(36, 90));
    const heading = draft.findIndex((row) => row.includes("· draft"));
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(draft.slice(heading + 1).some((row) => row.includes("reopened-draft"))).toBe(true);
    expect(live.some((row) => row.slice(90).includes("reopened-draft"))).toBe(false);
    expect(live.join("\n")).not.toContain("Restored 155 rounds in ");
    terminal.end();
    yield* bounded(command.terminal, "command teardown", command.task);
    settled(command);
    expect(command.status()).toBe(0);
    yield* unchanged(held);
  });

  it("stops at the exact partial count and shows the same diagnostic before and after quitting", function* () {
    const held = yield* savedRestoreFixture(yield* useMountedHost(), 155);
    const invalid = invalidRestoreEntries(held);
    expect(invalid).not.toBe(held.entries);
    yield* writeTextFile(held.files.entries, invalid);
    const command = yield* openCold(`xmd://repl/${held.id}/entries/entry-${EARLIER}`, NARROW);
    const { terminal } = command;
    const partial = yield* shown(terminal, STOPPED);
    bar(partial, 118, 155);
    const failure = partial.join("\n");
    expect(failure).toContain("Round 119 of 155 could not be restored");
    expect(failure).not.toContain("Open read-only");
    expect(failure).not.toContain("[exit]");
    for (const action of ["Retry", "Show error details", "Quit"]) {
      expect(failure).toContain(`[${action}]`);
    }
    const click = (label: string) => {
      const rows = terminal.screen?.rows() ?? [];
      const index = rows.findIndex((row) => row.includes(label));
      expect(index).toBeGreaterThan(-1);
      const column = rows[index].indexOf(label) + 1;
      const row = index + 1;
      terminal.feed(`\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`);
    };
    click("[Show error details]");
    const details = yield* shown(terminal, "Restore error details");
    expect(details.join("").replace(/\s+/gu, " ")).toContain(DIAGNOSTIC);
    terminal.feed("\x1b");
    bar(yield* shown(terminal, STOPPED), 118, 155);
    click("[Quit]");
    yield* bounded(command.terminal, "command teardown", command.task);
    settled(command);
    expect(command.status()).toBe(1);
    expect(command.stderr).toEqual([{ text: `xmd repl: ${DIAGNOSTIC}`, resets: 1, readers: 0 }]);
    expect(command.stdout).toEqual([]);
    yield* unchanged(held, invalid);
  });

  it("joins the refused attempt before Retry projects the same requested location", function* () {
    const held = yield* savedRestoreFixture(yield* useMountedHost(), 155);
    yield* writeTextFile(held.files.entries, invalidRestoreEntries(held));
    const fresh = gate();
    const command = yield* openCold(
      `xmd://repl/${held.id}/entries/entry-${EARLIER}`,
      NARROW,
      new Map([[120, fresh]]),
    );
    const { terminal } = command;
    yield* shown(terminal, STOPPED);
    expect(command.checkpoints()).toBe(119);
    yield* writeTextFile(held.files.entries, held.entries);
    terminal.feed("\r");
    yield* bounded(terminal, "fresh attempt gate", fresh.reached);
    const reset = yield* shown(terminal, "Restoring rounds · 0 / 155");
    expect(reset.join("\n")).not.toContain("stopped");
    bar(reset, 0, 155);
    fresh.release();
    yield* shown(terminal, "Saved round 2 witness.");
    terminal.end();
    yield* bounded(command.terminal, "command teardown", command.task);
    settled(command);
    expect(command.checkpoints()).toBe(276);
    expect(command.status()).toBe(0);
    expect(command.stdout[0]).toContain("/entries/entry-2");
    yield* unchanged(held);
  });

  it("counts only projected ranges when a broken final record leaves the total unknown", function* () {
    const held = yield* savedRestoreFixture(yield* useMountedHost(), 2);
    const broken = held.entries + "{";
    yield* writeTextFile(held.files.entries, broken);
    const command = yield* openCold(`xmd://repl/${held.id}/entries`, NARROW);
    const { terminal } = command;
    const partial = yield* shown(terminal, "Restoring rounds · 2 / unknown · stopped");
    expect(partial.some((row) => /^[━─]+$/u.test(row.trim()))).toBe(false);
    expect(partial.join("\n")).not.toContain("[exit]");
    const diagnostic = partial
      .filter((row) => row.startsWith("│"))
      .map((row) => row.slice(1, row.lastIndexOf("│")).trim())
      .join(" ");
    expect(diagnostic).toContain("a record that was never finished writing");
    terminal.feed("\x1b");
    yield* bounded(command.terminal, "command teardown", command.task);
    settled(command);
    expect(command.status()).toBe(1);
    expect(command.stdout).toEqual([]);
    yield* unchanged(held, broken);
  });

  it("discards a counted total when an identical replacement changes journal identity", function* () {
    const held = yield* savedRestoreFixture(yield* useMountedHost(), 2);
    const replacement = held.files.entries + ".replacement";
    const observations: EntryRestoreProgress[] = [];
    let failure: unknown;
    try {
      yield* PagedHistory.open(held.files.entries, function* (progress) {
        observations.push(progress);
        if (progress.stage === "rounds" && progress.total === 2) {
          yield* writeTextFile(replacement, held.entries);
          yield* API.Fs.operations.rename(replacement, held.files.entries);
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("journal changed");
    expect(observations).toEqual([
      { stage: "counting" },
      { stage: "rounds", restored: 0, total: 2 },
      { stage: "rounds", restored: 0, total: undefined },
    ]);
    yield* unchanged(held);
  });

  for (const count of [0, 1]) {
    it(`opens a retained ${count}-round journal without a display hold`, function* () {
      const held = yield* savedRestoreFixture(yield* useMountedHost(), count);
      const location = `xmd://repl/${held.id}/entries${count === 0 ? "" : "/entry-1"}`;
      const command = yield* openCold(location, NARROW);
      yield* shown(command.terminal, count === 0 ? "HEAD · EMPTY" : "Saved round 1 witness.");
      command.terminal.end();
      yield* bounded(command.terminal, "command teardown", command.task);
      settled(command);
      expect(command.status()).toBe(0);
      yield* unchanged(held);
    });
  }

  for (const [label, name] of [
    [
      "Opening REPL",
      "joins terminal takeover when Control-C arrives during the final progress write",
    ],
    ["Entry 1", "joins the blocked first live write when Control-C arrives"],
  ]) {
    it(name, function* () {
      const held = yield* savedRestoreFixture(yield* useMountedHost(), 1);
      const heldWrite = gate();
      const decoder = new TextDecoder();
      yield* ReplTerminal.around(
        {
          *write([bytes], next) {
            if (decoder.decode(bytes).includes(label)) {
              yield* heldWrite.wait();
            }
            yield* next(bytes);
          },
        },
        { at: "max" },
      );
      const command = yield* openCold(`xmd://repl/${held.id}/entries/entry-1`);
      const { terminal } = command;
      yield* bounded(terminal, `the held "${label}" write`, heldWrite.reached);
      const drawn = terminal.drawn;
      terminal.feed("\u0003");
      yield* bounded(terminal, "Control-C to settle while the write is held", command.task);

      expect(heldWrite.joined).toBe(true);
      heldWrite.release();
      expect(terminal.drawn).toBe(drawn);
      settled(command);
      expect(terminal.fed).toBe(1);
      expect(terminal.presented.some((bytes) => decoder.decode(bytes).includes("Entry 1"))).toBe(
        false,
      );
      expect(command.status()).toBe(1);
      expect(command.stdout).toEqual([]);
      expect(command.stderr).toEqual([
        { text: "xmd repl: Session restoration was interrupted.", resets: 1, readers: 0 },
      ]);
      yield* unchanged(held);
    });
  }

  it("joins a held reader and terminal before leaving during projection", function* () {
    const held = yield* savedRestoreFixture(yield* useMountedHost(), 155);
    const rounds = gate();
    const command = yield* openCold(
      `xmd://repl/${held.id}/entries/entry-155`,
      WIDE,
      new Map([[43, rounds]]),
    );
    yield* bounded(command.terminal, "round 42 gate", rounds.reached);
    yield* shown(command.terminal, PARTWAY);
    command.terminal.feed("\u0003");
    yield* bounded(command.terminal, "command teardown", command.task);
    expect(rounds.joined).toBe(true);
    settled(command);
    const completed = command.terminal.drawn;
    rounds.release();
    expect(command.terminal.drawn).toBe(completed);
    expect(command.status()).toBe(1);
    expect(command.stdout).toEqual([]);
    yield* unchanged(held);
  });
});
