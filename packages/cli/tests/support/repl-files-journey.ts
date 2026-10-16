/**
 * The one real-terminal journey this feature's public behavior rests on.
 *
 * Shared by two rows that differ in exactly one thing: which `xmd` runs. The
 * Deno source row proves the entry host this repository builds; the compiled row
 * proves the binary carries it. Writing the journey twice would let the two
 * drift, and a compiled row asserting something slightly weaker than the source
 * row is how a packaging defect survives.
 *
 * It is the specification's own example, typed as a person types it: a `<Dir>`
 * holding a write, a write and a delete, a read that binds what the write
 * produced, a question that shows that binding, and a write after the question.
 * Leave at the question, change the files from a shell, come back to the printed
 * location, and what the entry already did must not happen again — including the
 * read, whose binding the question still shows while the disk says something
 * else. A *new* entry then reads the same path and sees what is there now, which
 * is what says this is retention rather than a cache.
 */

import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { type Operation, scoped, sleep, until } from "effection";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { allocate, showing } from "./pty.ts";
import type { Pty } from "./pty.ts";

/**
 * How long reaching the screen may take, and how long one interaction may take.
 *
 * Reaching the screen compiles or loads an entrypoint, which is slow and
 * uninteresting. Everything after that is the subject.
 */
const REACH_MS = 180_000;
const ACT_MS = 30_000;

/** How this row's `xmd` is invoked, as one shell command. */
export type ReplCommand = (args: readonly string[]) => string;

/** The entry this journey types, exactly as the specification shows it. */
const ENTRY = [
  '<Dir path="drafts">',
  '<File path="note.md">first</File>',
  '<File path="obsolete.md">remove me</File>',
  '<File.Delete path="obsolete.md" />',
  "</Dir>",
  '<File path="drafts/note.md" as="held" />',
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string", enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} as="answer">Recorded value: {held}. Continue this experiment?</Elicit>',
  '<File path="after.md">continued</File>',
].join("\n");

/** A second entry, which reads the same path live rather than from a record. */
const LIVE_READ = ['<File path="drafts/note.md" as="live" />', "live is {live}"].join("\n");

/**
 * One seeded checkout, inside the isolated home this row already owns.
 *
 * Seeded with a plain `git` rather than through this repository's own Deno
 * adapter, so the fixture is the same on all three runtimes — the adapter is the
 * subject of the Deno branch below, not of the setup both branches share.
 */
function* seedCheckout(home: string): Operation<string> {
  const checkout = join(home, "checkout");
  yield* until(mkdir(checkout, { recursive: true }));
  yield* until(
    new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        ["init", "-b", "main", checkout],
        { env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" } },
        (error) => (error === null ? resolve() : reject(error)),
      );
    }),
  );
  yield* writeTextFile(join(checkout, "seed.md"), "seed\n");
  return checkout;
}

/** Walk the focus ring until this control is the marked one. */
function* reach(pty: Pty, label: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (!(yield* pty.shows()).some((line) => line.includes(`> ${label}`))) {
    if (Date.now() > deadline) {
      throw new Error(
        `focus never reached ${label} under ${cliRuntime()}. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* pty.type("\t");
    yield* sleep(250);
  }
}

/**
 * Activate the control holding this text with a pointer.
 *
 * The screen asks for SGR mouse reporting, so a press and a release at the
 * cell the text starts in is what a person's click is. It is needed because the
 * focus ring inside the question drawer does not stop on an enum's offered
 * values: they are drawn and pointable, and a pointer is how a keyboard-only
 * harness reaches one.
 */
function* click(pty: Pty, text: string): Operation<void> {
  const screen = yield* pty.shows();
  const row = screen.findIndex((line) => line.includes(text));
  if (row < 0) {
    throw new Error(
      `nothing on this screen holds ${JSON.stringify(text)} to click. screen=` +
        JSON.stringify(screen.map((one) => one.trimEnd())),
    );
  }
  const column = (screen[row] ?? "").indexOf(text) + 1;
  yield* pty.type(`\u001b[<0;${column};${row + 1}M`);
  yield* pty.type(`\u001b[<0;${column};${row + 1}m`);
  yield* sleep(300);
}

/** Wait until this file holds this exact text. */
function* holding(path: string, content: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    if ((yield* exists(path)) && (yield* readTextFile(path)) === content) {
      return;
    }
    if (Date.now() > deadline) {
      const found = (yield* exists(path)) ? yield* readTextFile(path) : "<absent>";
      throw new Error(
        `${path} never held ${JSON.stringify(content)}; it holds ${JSON.stringify(found)}`,
      );
    }
    yield* sleep(200);
  }
}

/**
 * Wait until this path is absent.
 *
 * The delete inside the `<Dir>` happens after the write this row waited for, so
 * asking once would be asking inside the window where the file still exists:
 * which of two authored operations the entry has reached is not something this
 * journey controls. A deadline is what makes the behavior "it was removed" rather
 * than "it was removed before this line ran".
 */
function* removed(path: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    if (!(yield* exists(path))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${path} was never removed`);
    }
    yield* sleep(200);
  }
}

/** Wait for the command to end, and answer with its status. */
function* ended(pty: Pty): Operation<number> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const status = yield* pty.status();
    if (status !== undefined) {
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the command never finished under ${cliRuntime()}. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* sleep(150);
  }
}

/** The one location this command printed for a caller to come back with. */
function printedLocation(screen: string): string {
  const found = screen.match(/xmd repl '(xmd:\/\/repl\/[^']+)'/);
  if (found === null || found[1] === undefined) {
    throw new Error(
      `this command printed no reopenable location. screen=${JSON.stringify(screen)}`,
    );
  }
  return found[1];
}

/**
 * Run the whole journey, and answer with nothing.
 *
 * Takes the command rather than building one, so the only difference between
 * the two rows that call this is which `xmd` they name.
 */
export function replFilesJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-files-pty-");
    const checkout = yield* seedCheckout(home);
    const inside = (args: readonly string[]): string =>
      `cd ${shellQuote(checkout)} && ${repl(args)}`;

    const first = yield* allocate(inside(["repl", "--deny-all"]), home);
    yield* showing(first, "[exit]", REACH_MS);

    // Typed as a person types it: one paste carrying newlines, then Enter.
    yield* first.type(ENTRY);
    yield* sleep(500);
    yield* first.type("\r");

    // The prefix ran. Everything the entry authored before the question is on
    // disk, and the write after the question is not.
    yield* holding(join(checkout, "drafts", "note.md"), "first");
    yield* removed(join(checkout, "drafts", "obsolete.md"));
    // And the write after the question has not happened: by now the prefix is
    // through its last authored operation, so this one is absent because the
    // entry is waiting rather than because it has not got there yet.
    expect(yield* exists(join(checkout, "after.md"))).toBe(false);

    // The question is waiting, and the footer says so on one row. The read
    // before it settled, which the transcript marks; what it *bound* is read in
    // the drawer after the reopen below, because the prompt is rendered where it
    // is answered rather than on the surface behind it.
    yield* showing(first, "waiting for an answer", ACT_MS);

    // Left through [exit], with the question still open.
    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));

    // Changed from outside, which is exactly what this execution model allows:
    // a completed result and the environment may disagree.
    yield* writeTextFile(join(checkout, "drafts", "note.md"), "second");
    yield* writeTextFile(join(checkout, "drafts", "obsolete.md"), "back again");

    // Reopened at the live head, in the same data root.
    const second = yield* allocate(inside(["repl", "--deny-all", location]), home);
    yield* showing(second, "[exit]", REACH_MS);
    // The question is offered again, which is what says the unfinished entry
    // started once rather than being replayed into a settled state.
    yield* showing(second, "waiting for an answer", ACT_MS);

    // And no completed operation ran again: a replayed write would have
    // overwritten the shell's edit, a replayed delete would have removed the
    // file the shell put back, and a replayed read would have bound "second".
    expect(yield* readTextFile(join(checkout, "drafts", "note.md"))).toBe("second");
    expect(yield* readTextFile(join(checkout, "drafts", "obsolete.md"))).toBe("back again");
    expect(yield* exists(join(checkout, "after.md"))).toBe(false);

    // Answered through the real drawer. Activating the one value the schema
    // offers is the answer: a keystroke in this drawer reaches the field a
    // *pointer* last selected rather than the line holding focus, so an enum is
    // what a pointer alone can settle. Reported as a non-blocking observation;
    // it is not this feature's behavior.
    yield* reach(second, "[answer]");
    yield* second.type("\r");
    // The prompt the drawer renders carries the binding the completed read
    // produced — `first`, from a record — while the file on disk says `second`.
    // A replayed read would have bound the new text, and this is where that
    // would show.
    yield* showing(second, "Recorded value: first", ACT_MS);
    yield* showing(second, "Continue this experiment?", ACT_MS);
    yield* click(second, "( ) continue");
    yield* showing(second, "[ok] entry-1", ACT_MS);

    // The suffix write executed, for the first time, on the answer.
    yield* holding(join(checkout, "after.md"), "continued");

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);

    // A separate new entry, opened at the same location: its read is new work,
    // so it reads the file as it is now. What is saved is each operation,
    // not a value the session remembers for the path.
    //
    // A third session rather than another entry typed into the second one: a
    // draft is where keystrokes land when a session opens, and after answering
    // a question they reach the transcript instead. That is the pre-existing
    // focus defect the enum above is clicked for, and typing through it is not
    // what this journey is about.
    const third = yield* allocate(inside(["repl", "--deny-all", location]), home);
    yield* showing(third, "[exit]", REACH_MS);
    yield* third.type(LIVE_READ);
    yield* sleep(500);
    yield* third.type("\r");
    yield* showing(third, "live is second", ACT_MS);

    yield* reach(third, "[exit]");
    yield* third.type("\r");
    expect(yield* ended(third)).toBe(0);
  });
}

/**
 * The prefix alone, for a runtime that assembles no entry host.
 *
 * Node and Bun start a REPL and perform ordinary file and directory work; what
 * they do not have is anything that retains it. So their behavior is that the
 * document ran and the command left cleanly, and the journey above is not
 * theirs.
 */
export function replOrdinaryFileWork(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-files-pty-");
    const checkout = yield* seedCheckout(home);
    const pty = yield* allocate(
      `cd ${shellQuote(checkout)} && ${repl(["repl", "--deny-all"])}`,
      home,
    );
    yield* showing(pty, "[exit]", REACH_MS);
    yield* pty.type(ENTRY);
    yield* sleep(500);
    yield* pty.type("\r");

    yield* holding(join(checkout, "drafts", "note.md"), "first");
    yield* removed(join(checkout, "drafts", "obsolete.md"));
    // And the write after the question has not happened: by now the prefix is
    // through its last authored operation, so this one is absent because the
    // entry is waiting rather than because it has not got there yet.
    expect(yield* exists(join(checkout, "after.md"))).toBe(false);

    yield* reach(pty, "[exit]");
    yield* pty.type("\r");
    expect(yield* ended(pty)).toBe(0);
  });
}
