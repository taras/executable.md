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
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { allocate, showing, showingAcross } from "./pty.ts";
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
    // so it reads the file as it is now. What is retained is each operation,
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
 * A source repository with one commit, for the managed journeys to clone.
 *
 * Seeded with a plain `git` for the same reason the checkout above is: the
 * fixture has to be the same on every runtime this suite starts on.
 */
function* seedOrigin(home: string): Operation<string> {
  const origin = join(home, "origin");
  yield* until(mkdir(origin, { recursive: true }));
  yield* git(home, ["init", "-b", "main", origin]);
  yield* writeTextFile(join(origin, "README.md"), "origin\n");
  yield* git(origin, ["add", "README.md"], home);
  yield* git(origin, ["commit", "-m", "first"], home);
  return origin;
}

/** One `git` command, in this journey's own isolated home. */
function git(cwd: string, args: readonly string[], home = cwd): Operation<void> {
  return until(
    new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          env: {
            ...process.env,
            HOME: home,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Journey",
            GIT_AUTHOR_EMAIL: "journey@example.test",
            GIT_COMMITTER_NAME: "Journey",
            GIT_COMMITTER_EMAIL: "journey@example.test",
          },
        },
        (error) => (error === null ? resolve() : reject(error)),
      );
    }),
  );
}

/**
 * The one managed checkout this journey's entry created, once it is there.
 *
 * Found rather than predicted. A slot is a digest of the whole identity under a
 * root this journey never names — the command decides where
 * `~/.xmd/repositories` is from the home it was given — so looking for the one
 * checkout beneath that layout is what asks the question the person asks:
 * where did my Repository end up.
 */
function* managedCheckout(home: string, kind: "repositories" | "worktrees"): Operation<string> {
  const base = join(home, ".xmd", "repositories", kind);
  const depth = kind === "repositories" ? 1 : 2;
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const found = yield* slotsBeneath(base, depth);
    if (found.length === 1 && (yield* exists(join(found[0] ?? "", "checkout")))) {
      return join(found[0] ?? "", "checkout");
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no single managed ${kind} slot appeared beneath ${base}; found ${JSON.stringify(found)}`,
      );
    }
    yield* sleep(200);
  }
}

/** Every slot directory at this depth beneath a managed layout root. */
function* slotsBeneath(base: string, depth: number): Operation<string[]> {
  if (!(yield* exists(base))) {
    return [];
  }
  let level = [base];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const directory of level) {
      for (const entry of yield* until(readdir(directory))) {
        next.push(join(directory, entry));
      }
    }
    level = next;
  }
  return level.sort();
}

/** Which managed journey this is, and what the entry it types looks like. */
export type ManagedJourney = "repository" | "worktree";

const QUESTION =
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string", enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} as="answer">Recorded value: {held}. Continue this experiment?</Elicit>';

/** The entry this managed journey types, as the specification shows it. */
function managedEntry(through: ManagedJourney, origin: string): string {
  const body = [
    '<File path="note.md">first</File>',
    '<File path="obsolete.md">remove me</File>',
    '<File.Delete path="obsolete.md" />',
    '<File path="note.md" as="held" />',
    QUESTION,
    '<File path="after.md">continued</File>',
  ];
  if (through === "repository") {
    return [
      `<Repository name="project" url=${JSON.stringify(origin)}>`,
      '<Dir path="drafts">',
      ...body,
      "</Dir>",
      "</Repository>",
    ].join("\n");
  }
  // The self-closing spelling: it binds the checkout path, and a `<Dir>`
  // sibling renders its descendants at exactly that path.
  return [
    `<Repository name="project" url=${JSON.stringify(origin)}>`,
    '<Worktree name="experiment" branch="experiment" as="worktree" />',
    "<Dir path={worktree}>",
    ...body,
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/** A new entry that selects the same placement afresh and reads live. */
function managedLiveRead(through: ManagedJourney, origin: string): string {
  if (through === "repository") {
    return [
      `<Repository name="project" url=${JSON.stringify(origin)}>`,
      '<File path="drafts/note.md" as="live" />',
      "live is {live}",
      "</Repository>",
    ].join("\n");
  }
  return [
    `<Repository name="project" url=${JSON.stringify(origin)}>`,
    '<Worktree name="experiment" branch="experiment" as="worktree" />',
    "<Dir path={worktree}>",
    '<File path="note.md" as="live" />',
    "live is {live}",
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/**
 * The whole journey again, through a managed Repository the entry selected.
 *
 * Same shape as the ambient one and for the same reasons, with the one addition
 * this delivery is about: the checkout the file work happens in is one the entry
 * *selected*, under the root the command decides from the home it was given.
 * Leaving at the question and coming back must not select it again — and the
 * completed read must still answer with what it read the first time, while the
 * file on disk says something else.
 */
export function replRepositoryJourney(repl: ReplCommand, through: ManagedJourney): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-managed-pty-");
    const origin = yield* seedOrigin(home);
    // Typed from a directory inside no checkout, so what the entry works in is
    // the placement it selected rather than an ambient repository.
    const away = join(home, "away");
    yield* until(mkdir(away, { recursive: true }));
    const outside = (args: readonly string[]): string => `cd ${shellQuote(away)} && ${repl(args)}`;

    const first = yield* allocate(outside(["repl", "--deny-all"]), home);
    yield* showing(first, "[exit]", REACH_MS);
    yield* first.type(managedEntry(through, origin));
    yield* sleep(500);
    yield* first.type("\r");

    // The checkout the selection created, found under the managed layout.
    const checkout = yield* managedCheckout(
      home,
      through === "repository" ? "repositories" : "worktrees",
    );
    const working = through === "repository" ? join(checkout, "drafts") : checkout;

    // The prefix ran, inside that checkout, and the write after the question
    // has not.
    yield* holding(join(working, "note.md"), "first");
    yield* removed(join(working, "obsolete.md"));
    expect(yield* exists(join(working, "after.md"))).toBe(false);
    yield* showing(first, "waiting for an answer", ACT_MS);

    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));

    // Changed from outside, which this execution model allows.
    yield* writeTextFile(join(working, "note.md"), "second");
    yield* writeTextFile(join(working, "obsolete.md"), "back again");

    const second = yield* allocate(outside(["repl", "--deny-all", location]), home);
    yield* showing(second, "[exit]", REACH_MS);
    yield* showing(second, "waiting for an answer", ACT_MS);

    // No completed operation ran again — the selection included. A reselected
    // placement would have reached a selector; a replayed write would have
    // overwritten the shell's edit, and a replayed read would have bound
    // "second".
    expect(yield* readTextFile(join(working, "note.md"))).toBe("second");
    expect(yield* readTextFile(join(working, "obsolete.md"))).toBe("back again");
    expect(yield* exists(join(working, "after.md"))).toBe(false);

    yield* reach(second, "[answer]");
    yield* second.type("\r");
    yield* showing(second, "Recorded value: first", ACT_MS);
    yield* showing(second, "Continue this experiment?", ACT_MS);
    yield* click(second, "( ) continue");
    yield* showing(second, "[ok] entry-1", ACT_MS);

    // The suffix write executed, for the first time, on the answer — in the
    // checkout the restored placement named.
    yield* holding(join(working, "after.md"), "continued");

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);

    // A separate new entry, selecting the same placement afresh: its selection
    // is new work, so it reuses the checkout that is there, and its read is new
    // work, so it reads what the file now holds.
    const third = yield* allocate(outside(["repl", "--deny-all", location]), home);
    yield* showing(third, "[exit]", REACH_MS);
    yield* third.type(managedLiveRead(through, origin));
    yield* sleep(500);
    yield* third.type("\r");
    yield* showing(third, "live is second", ACT_MS);

    yield* reach(third, "[exit]");
    yield* third.type("\r");
    expect(yield* ended(third)).toBe(0);
  });
}

/**
 * What a managed selection does on a runtime that assembles no native setup.
 *
 * Node and Bun start a REPL and do ordinary file and directory work; neither
 * installs a Repository provider, because the Deno adapter's module graph
 * reaches `node:sqlite` and Bun has not got one. So a `<Repository>` there says
 * no provider is installed rather than reaching a clone — and says it before
 * anything local or remote is touched.
 */
export function replUnsupportedSelection(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-managed-pty-");
    const origin = yield* seedOrigin(home);
    const away = join(home, "away");
    yield* until(mkdir(away, { recursive: true }));
    const pty = yield* allocate(`cd ${shellQuote(away)} && ${repl(["repl", "--deny-all"])}`, home);
    yield* showing(pty, "[exit]", REACH_MS);
    yield* pty.type(
      [
        `<Repository name="project" url=${JSON.stringify(origin)}>`,
        '<File path="note.md">first</File>',
        "</Repository>",
      ].join("\n"),
    );
    yield* sleep(500);
    yield* pty.type("\r");

    // The refusal is a sentence, wrapped where the Transcript's own width
    // cuts it, so it is read across those rows rather than off one of them.
    yield* showingAcross(pty, "no Repository composition provider is installed", ACT_MS);
    // Nothing was placed: no managed layout was created at all.
    expect(yield* exists(join(home, ".xmd", "repositories", "repositories"))).toBe(false);

    yield* reach(pty, "[exit]");
    yield* pty.type("\r");
    expect(yield* ended(pty)).toBe(0);
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

/**
 * A `git` on `PATH` that logs every invocation and forwards to the real one.
 *
 * The local Git journey's one new question is whether a reopened prefix runs
 * `git` at all — including the apparently observational commands, `write-tree`
 * and `git var` among them. Counting them from outside the process is the only
 * way to answer it for a *packaged* binary, which has no seam a suite can
 * substitute.
 *
 * It forwards unchanged to the real Git it resolved, so what runs is the real
 * command with the real arguments. Only the `xmd` invocation gets it on `PATH`;
 * this journey's own fixture commands keep the host's own Git, so the log holds
 * what the document did and nothing this harness did.
 */
function* gitShim(home: string): Operation<{ readonly prefix: string; readonly log: string }> {
  const real = yield* until(
    new Promise<string>((resolve, reject) => {
      execFile("sh", ["-c", "command -v git"], (error, stdout) =>
        error === null ? resolve(stdout.trim()) : reject(error),
      );
    }),
  );
  if (real === "") {
    throw new Error("this host has no git on PATH, so there is nothing to forward to");
  }
  const directory = join(home, "git-shim");
  yield* until(mkdir(directory, { recursive: true }));
  const log = join(home, "git-commands.log");
  const shim = join(directory, "git");
  yield* writeTextFile(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\nexec ${shellQuote(real)} "$@"\n`,
  );
  yield* until(chmod(shim, 0o755));
  yield* writeTextFile(log, "");
  return { prefix: `PATH=${shellQuote(directory)}:$PATH`, log };
}

/** Every `git` the shim has seen since it was last forgotten. */
function* logged(log: string): Operation<string[]> {
  const held = (yield* exists(log)) ? yield* readTextFile(log) : "";
  return held.split("\n").filter((line) => line !== "");
}

/**
 * The author and committer this journey's entry commits under.
 *
 * `<Git.Commit>` borrows the *invoking person's* identity, read with `git var`
 * from the environment the command was started in — and this journey starts it
 * in an isolated `HOME` of its own. So that home gets a configuration, exactly
 * as a person's would have one, and the commit is then held to it below.
 *
 * Without it the identity is whatever the host happens to auto-detect from its
 * operating-system user, which a continuous-integration runner commonly cannot
 * do at all: `git var` fails, `<Git.Commit>` reports its ordinary
 * missing-identity refusal, and the row would be failing for a reason that is
 * about the runner rather than about this feature.
 */
const JOURNEY_IDENTITY = { name: "Journey Author", email: "journey-author@example.test" };

/** Give this journey's isolated home a Git identity to commit under. */
function* seedIdentity(home: string): Operation<void> {
  yield* writeTextFile(
    join(home, ".gitconfig"),
    `[user]\n\tname = ${JOURNEY_IDENTITY.name}\n\temail = ${JOURNEY_IDENTITY.email}\n`,
  );
}

/** One seeded checkout with a commit in it, so a Commit has a parent. */
function* seedCommitted(home: string): Operation<string> {
  const checkout = join(home, "checkout");
  yield* until(mkdir(checkout, { recursive: true }));
  yield* git(home, ["init", "-b", "main", checkout]);
  yield* writeTextFile(join(checkout, "seed.md"), "seed\n");
  yield* git(checkout, ["add", "seed.md"], home);
  yield* git(checkout, ["commit", "-m", "seed"], home);
  return checkout;
}

/** What one `git` command printed, for a fixture that reads the checkout. */
function gitSaid(cwd: string, args: readonly string[], home: string): Operation<string> {
  return until(
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          env: {
            ...process.env,
            HOME: home,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Journey",
            GIT_AUTHOR_EMAIL: "journey@example.test",
            GIT_COMMITTER_NAME: "Journey",
            GIT_COMMITTER_EMAIL: "journey@example.test",
          },
        },
        (error, stdout) => (error === null ? resolve(stdout.trim()) : reject(error)),
      );
    }),
  );
}

/** Wait until the checkout's HEAD names something other than this commit. */
function* moved(checkout: string, home: string, from: string): Operation<string> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const head = yield* gitSaid(checkout, ["rev-parse", "HEAD"], home);
    if (head !== from) {
      return head;
    }
    if (Date.now() > deadline) {
      throw new Error(`${checkout} never moved off ${from}`);
    }
    yield* sleep(200);
  }
}

/** Where the local Git journey's entry works: the ambient checkout, or a worktree. */
export type GitJourney = "ambient" | "worktree";

const GIT_QUESTION =
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string", enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} as="answer">Recorded commit: {commit}. Continue this experiment?</Elicit>';

/** The entry this journey types, as the specification shows it. */
function gitEntry(through: GitJourney, origin: string): string {
  const body = [
    '<File path="note.md">first</File>',
    '<Git.Commit message="Record experiment" as="commit">',
    '<Git.Add paths="note.md" />',
    "</Git.Commit>",
    GIT_QUESTION,
    '<File path="after.md">continued</File>',
  ];
  if (through === "ambient") {
    return body.join("\n");
  }
  // The self-closing spelling binds the checkout path, and a `<Dir>` sibling
  // renders its descendants at exactly that path — while the enclosing
  // `<Repository>` stays the owner every Git element below belongs to.
  return [
    `<Repository name="project" url=${JSON.stringify(origin)}>`,
    '<Worktree name="experiment" branch="experiment" as="worktree" />',
    "<Dir path={worktree}>",
    ...body,
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/** A new entry that stages and commits whatever the checkout holds now. */
function gitLiveCommit(through: GitJourney, origin: string): string {
  const body = [
    '<Git.Add paths="note.md" />',
    '<Git.Commit message="Record again" as="again" />',
    "again is {again}",
  ];
  if (through === "ambient") {
    return body.join("\n");
  }
  return [
    `<Repository name="project" url=${JSON.stringify(origin)}>`,
    '<Worktree name="experiment" branch="experiment" as="worktree" />',
    "<Dir path={worktree}>",
    ...body,
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/**
 * The whole journey again, through the three local Git operations.
 *
 * The one addition this delivery is about: the entry stages and commits, and
 * the object id it bound is what the question still shows after the checkout
 * has moved on. A reopened prefix runs no `git` at all, which the shim on
 * `PATH` is what proves — and a *new* entry commits today's staged work, which
 * is what says this is retention rather than a cache.
 */
export function replGitJourney(repl: ReplCommand, through: GitJourney): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-git-pty-");
    const shim = yield* gitShim(home);
    yield* seedIdentity(home);
    const ambient = yield* seedCommitted(home);
    const origin = through === "ambient" ? "" : yield* seedOrigin(home);
    // The ambient journey is typed from inside the checkout; the managed one
    // from a directory inside no checkout, so what it works in is the placement
    // it selected.
    const away = join(home, "away");
    yield* until(mkdir(away, { recursive: true }));
    const from = through === "ambient" ? ambient : away;
    const open = (args: readonly string[]): string =>
      `cd ${shellQuote(from)} && ${shim.prefix} ${repl(args)}`;

    const first = yield* allocate(open(["repl", "--deny-all"]), home);
    yield* showing(first, "[exit]", REACH_MS);
    yield* first.type(gitEntry(through, origin));
    yield* sleep(500);
    yield* first.type("\r");

    const working = through === "ambient" ? ambient : yield* managedCheckout(home, "worktrees");

    // The prefix ran: the file is there, the commit was made, and the write
    // after the question is not.
    yield* holding(join(working, "note.md"), "first");
    yield* showing(first, "waiting for an answer", ACT_MS);
    expect(yield* exists(join(working, "after.md"))).toBe(false);
    const recorded = yield* gitSaid(working, ["rev-parse", "HEAD"], home);
    expect(recorded).toMatch(/^[0-9a-f]{40}$/);
    // The commit holds exactly what the staging child staged, and records the
    // identity this home configured — the invoking person's own, read by the
    // host rather than substituted.
    expect(yield* gitSaid(working, ["show", "HEAD:note.md"], home)).toBe("first");
    expect(yield* gitSaid(working, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], home)).toBe(
      `${JOURNEY_IDENTITY.name} <${JOURNEY_IDENTITY.email}>|` +
        `${JOURNEY_IDENTITY.name} <${JOURNEY_IDENTITY.email}>`,
    );
    // And the document's own Git really ran, which is what makes the empty log
    // below say something.
    expect((yield* logged(shim.log)).length > 0).toBe(true);

    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));

    // Changed from outside: the file, the index and HEAD all move on, which is
    // exactly what this execution model allows.
    yield* writeTextFile(join(working, "note.md"), "second");
    yield* gitSaid(working, ["add", "note.md"], home);
    yield* writeTextFile(join(working, "staged.md"), "staged\n");
    yield* gitSaid(working, ["add", "staged.md"], home);
    yield* gitSaid(working, ["commit", "-m", "theirs"], home);
    const theirs = yield* gitSaid(working, ["rev-parse", "HEAD"], home);
    expect(theirs).not.toBe(recorded);
    // And something is left staged and uncommitted, so "the index did not
    // move" below is a fact about work a replayed Commit would have consumed.
    yield* writeTextFile(join(working, "today.md"), "today");
    yield* gitSaid(working, ["add", "today.md"], home);
    const theirIndex = yield* gitSaid(working, ["write-tree"], home);
    expect(theirIndex).not.toBe(yield* gitSaid(working, ["rev-parse", "HEAD^{tree}"], home));

    // Forgotten here, so what the log holds afterwards is what *reopening* ran.
    yield* writeTextFile(shim.log, "");

    const second = yield* allocate(open(["repl", "--deny-all", location]), home);
    yield* showing(second, "[exit]", REACH_MS);
    yield* showing(second, "waiting for an answer", ACT_MS);

    // No completed operation ran again, and no `git` ran at all — not a
    // `write-tree`, not a `git var`, not a `rev-parse`.
    expect(yield* logged(shim.log)).toEqual([]);
    expect(yield* readTextFile(join(working, "note.md"))).toBe("second");
    expect(yield* gitSaid(working, ["rev-parse", "HEAD"], home)).toBe(theirs);
    expect(yield* gitSaid(working, ["write-tree"], home)).toBe(theirIndex);
    expect(yield* exists(join(working, "after.md"))).toBe(false);

    yield* reach(second, "[answer]");
    yield* second.type("\r");
    // The saved object id, which describes the earlier commit rather than
    // today's HEAD.
    yield* showing(second, `Recorded commit: ${recorded}`, ACT_MS);
    yield* click(second, "( ) continue");
    yield* showing(second, "[ok] entry-1", ACT_MS);

    // The suffix write executed, for the first time, on the answer.
    yield* holding(join(working, "after.md"), "continued");

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);

    // A separate new entry: its Add and its Commit are new work, so they stage
    // and commit what the checkout holds now.
    const third = yield* allocate(open(["repl", "--deny-all", location]), home);
    yield* showing(third, "[exit]", REACH_MS);
    yield* third.type(gitLiveCommit(through, origin));
    yield* sleep(500);
    yield* third.type("\r");
    const today = yield* moved(working, home, theirs);
    // The object id is read across the wrap the Transcript's own width puts in
    // it: forty characters of it, whole, rather than whichever row it starts on.
    yield* showingAcross(third, `again is ${today}`, ACT_MS);
    // Today's staged work, not the commit the earlier entry retained.
    expect(today).not.toBe(recorded);
    expect(yield* gitSaid(working, ["show", "HEAD:today.md"], home)).toBe("today");
    expect(yield* gitSaid(working, ["show", "HEAD:note.md"], home)).toBe("second");

    yield* reach(third, "[exit]");
    yield* third.type("\r");
    expect(yield* ended(third)).toBe(0);
  });
}

/**
 * What the three local Git operations do on a runtime with no native setup.
 *
 * Node and Bun start a REPL and do ordinary file and directory work; neither
 * installs a Git provider, because the Deno adapter's module graph reaches
 * `node:sqlite` and Bun has not got one. So `<Git.Add>`, `<Git.Switch>` and
 * `<Git.Commit>` there say no provider is installed rather than reaching a
 * native operation — and say it before anything is staged, switched or
 * committed.
 */
export function replUnsupportedGit(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-git-pty-");
    const shim = yield* gitShim(home);
    const checkout = yield* seedCommitted(home);
    const head = yield* gitSaid(checkout, ["rev-parse", "HEAD"], home);
    const index = yield* gitSaid(checkout, ["write-tree"], home);
    yield* writeTextFile(shim.log, "");

    const pty = yield* allocate(
      `cd ${shellQuote(checkout)} && ${shim.prefix} ${repl(["repl", "--deny-all"])}`,
      home,
    );
    yield* showing(pty, "[exit]", REACH_MS);
    // All three in one printing region, because an absent provider is an
    // ordinary refusal a region recovers: each of them reports, and the
    // ordinary file work after them still runs.
    yield* pty.type(
      [
        "<PrintErrors>",
        '<Git.Add paths="seed.md" />',
        '<Git.Switch branch="experiment" />',
        '<Git.Commit message="Record it" as="commit" />',
        "</PrintErrors>",
        '<File path="after.md">continued</File>',
      ].join("\n"),
    );
    yield* sleep(500);
    yield* pty.type("\r");

    // Refused before a repository is in scope, which is before Git exists in
    // the story at all. Either way nothing native was reached.
    yield* showingAcross(pty, "composition provider is installed", ACT_MS);
    yield* holding(join(checkout, "after.md"), "continued");
    expect(yield* logged(shim.log)).toEqual([]);
    expect(yield* gitSaid(checkout, ["rev-parse", "HEAD"], home)).toBe(head);
    expect(yield* gitSaid(checkout, ["write-tree"], home)).toBe(index);
    expect(yield* exists(join(home, ".xmd", "repositories"))).toBe(false);

    yield* reach(pty, "[exit]");
    yield* pty.type("\r");
    expect(yield* ended(pty)).toBe(0);
  });
}
