/**
 * What one REPL entry's local Add, Switch and Commit retain, replay and refuse
 * to guess.
 *
 * Everything here runs a document through canonical execution with the
 * production entry host installed, so what is proven is the whole path: the
 * authored component asks the composition Api, the ordinary performer runs real
 * `git` against a real checkout, and the result is recorded once. A fixture that
 * asserted on the record without the performer would prove the bookkeeping and
 * nothing about the answer.
 *
 * The contract these rows hold the host to is the REPL's execution model.
 * Replay restores recorded results; it does not restore the checkout or require
 * it to match. So the rows that matter most are the ones where the two
 * disagree: a branch, an index and a HEAD moved behind a completed commit, a
 * selected worktree deleted outright, and a commit that physically happened and
 * was never acknowledged.
 *
 * ## How "nothing was resolved" is proven
 *
 * Counting `git` is not enough: routing a live call canonicalizes its working
 * directory and chooses among this entry's registered checkouts, and neither
 * touches `git`. So the directory an entry is opened in is a symbolic link, and
 * a continuation runs with that link pointing somewhere else entirely. Live
 * routing would resolve it, find it inside none of the checkouts this entry
 * registered, and fail admission. A continuation that answers normally has
 * therefore resolved nothing and selected nothing.
 *
 * Ownership is proven the same way round. A continuation runs while this suite
 * holds the checkout's own mutation lease, which the operating system would
 * refuse a second descriptor on. One that answers has taken no lock.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { chmod, mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";
import { Git } from "@executablemd/git/api";
// From the root rather than from the source module: this result type is what the
// package publishes, and reaching it by relative path would bypass the export
// map the partition test holds every consumer to.
import type { GitSwitchResult } from "@executablemd/git";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import type { GitAuthenticationSession } from "../src/deno/composition/authentication.ts";
import { UNAUTHENTICATED } from "../src/deno/composition/authentication.ts";
import { useReplRepositoryRecording } from "../src/deno/retained-repository/provider.ts";
import { useCommonDirectoryLease } from "../src/deno/retained-repository/leases.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { parseReplGitRecord, REPL_REPOSITORY_GIT } from "../src/retained-repository/git-records.ts";
import type { ReplGitRecord } from "../src/retained-repository/git-records.ts";
import { worktreeSlot } from "../src/deno/run-composition/placement.ts";

interface Fixture {
  /** The scenario's own directory: checkouts, managed root and HOME. */
  readonly root: string;
  /** An ordinary checkout with one commit, which entries are opened in. */
  readonly checkout: string;
  /** A second ordinary checkout, so "another repository" is a real other one. */
  readonly elsewhere: string;
  /** The repository a `<Repository url=..>` row clones from. */
  readonly origin: string;
  /** Where this scenario's managed checkouts live. */
  readonly managed: string;
  /**
   * A symbolic link an entry is opened through.
   *
   * Pointed at {@link Fixture.checkout} to begin with, and re-pointed by the
   * rows that need "nothing resolved this directory" to be a positive fact.
   */
  readonly link: string;
}

/** One seeded checkout with a commit in it, plus this scenario's own root. */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-git-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const git = gitSession(denoRepositoryHost(), root);
    const made: string[] = [];
    for (const name of ["checkout", "elsewhere", "origin"]) {
      const directory = join(root, name);
      yield* until(mkdir(directory, { recursive: true }));
      yield* git.run(["init", "-b", "main", directory], root);
      yield* until(writeFile(join(directory, "seed.md"), "seed\n"));
      // Committed, because a Repository identity is pinned at the commit HEAD
      // named when the entry opened, and a Commit needs a parent to be a commit
      // of the index rather than a root commit.
      yield* git.run(["add", "seed.md"], directory);
      yield* git.run(["commit", "-m", "seed"], directory);
      made.push(directory);
    }
    const link = join(root, "entered");
    yield* until(symlink(made[0] ?? "", link));
    yield* provide({
      root,
      checkout: made[0] ?? "",
      elsewhere: made[1] ?? "",
      origin: made[2] ?? "",
      managed: join(root, "repositories"),
      link,
    });
  });
}

/** Point the link an entry is opened through at another directory. */
function* repoint(fixture: Fixture, target: string): Operation<void> {
  yield* until(unlink(fixture.link));
  yield* until(symlink(target, fixture.link));
}

/** Let every ready task run, so "reached its wait" is about turns. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/** Wait until this path is there, or say what never appeared. */
function* appears(path: string): Operation<void> {
  const deadline = Date.now() + 30_000;
  while (!(yield* exists(path))) {
    if (Date.now() > deadline) {
      throw new Error(`${path} never appeared`);
    }
    yield* sleep(25);
  }
}

/** What the host and the composition beneath the recorder were asked to do. */
interface Counters {
  /** Every `git` invocation this entry ran, as its argument list. */
  commands: string[][];
  /** How many isolation directories this entry's Git session acquired. */
  directories: number;
  /** Every identity variable this entry asked the host for. */
  identity: string[];
  /** Every authentication locator a session was opened for. */
  sessions: string[];
  writes: string[];
  reads: string[];
}

function counters(): Counters {
  return { commands: [], directories: 0, identity: [], sessions: [], writes: [], reads: [] };
}

/** The Git subcommands one entry issued, in order. */
function subcommands(counted: Counters): string[] {
  return counted.commands.map((args) => args.find((arg) => !arg.startsWith("-")) ?? "");
}

/** The host filesystem, with the document's own writes and reads counted. */
function countingFiles(counted: Counters): FilesHandler {
  const host = hostFilesHandler();
  return {
    checkFilePath: (input) => host.checkFilePath(input),
    *readTextFile(input: FilePathInput) {
      counted.reads.push(input.path);
      return yield* host.readTextFile(input);
    },
    globFiles: (input) => host.globFiles(input),
    temporaryDirectory: () => host.temporaryDirectory(),
    *writeTextFile(input: FileWriteInput) {
      counted.writes.push(input.path);
      return yield* host.writeTextFile(input);
    },
    deleteFile: (input) => host.deleteFile(input),
    ensureDirectory: (input) => host.ensureDirectory(input),
  };
}

/** What a row may do to one `git` invocation before the real one runs. */
type GitBarrier = (invocation: GitInvocation) => Operation<void>;

/**
 * The production host, counted, and interruptible at a named subcommand.
 *
 * Every leaf is wrapped rather than replaced: what these rows need to know is
 * whether a performer ran at all, and the only honest way to answer is to let
 * the real `switch`, the real `add` and the real `commit-tree` happen and
 * watch. A barrier runs *before* the real invocation is delegated to, so a row
 * that halts there halts with the native work still to come — and one that
 * delegates first halts with a real child in flight.
 */
function countingHost(
  counted: Counters,
  barrier?: GitBarrier,
  intercept?: (invocation: GitInvocation) => Partial<GitInvocation> | undefined,
): RepositoryHost {
  const host = denoRepositoryHost();
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      counted.commands.push([...invocation.args]);
      if (barrier !== undefined) {
        yield* barrier(invocation);
      }
      return yield* host.git({ ...invocation, ...(intercept?.(invocation) ?? {}) });
    },
    *useDirectory(): Operation<string> {
      counted.directories += 1;
      return yield* host.useDirectory();
    },
    *useAuthentication(locator: string): Operation<GitAuthenticationSession> {
      counted.sessions.push(locator);
      return host.useAuthentication === undefined
        ? UNAUTHENTICATED
        : yield* host.useAuthentication(locator);
    },
  };
}

/**
 * The identity reader these rows substitute.
 *
 * Counted, so "a completed Commit reads no identity" and "a live one reads it
 * once" are both positive facts, and answerable with nothing so the
 * missing-identity refusal is reachable without touching anybody's real Git
 * configuration.
 */
function identityReader(
  counted: Counters,
  known: Record<string, string> | undefined,
): (variable: string) => Operation<string | undefined> {
  // deno-lint-ignore require-yield
  return function* (variable: string): Operation<string | undefined> {
    counted.identity.push(variable);
    return known?.[variable];
  };
}

/** The author and committer this suite's host states by default. */
const STATED_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_IDENT: "Entry Author <author@example.test> 1700000000 +0000",
  GIT_COMMITTER_IDENT: "Entry Committer <committer@example.test> 1700000000 +0000",
};

/** What a watched `git` child reported about its own lifetime. */
interface WatchedChildren {
  /** Resolves once a watched child has been spawned. */
  readonly spawned: Operation<void>;
  /** Handed to the host, which forwards it to the one place a child exists. */
  readonly observe: NonNullable<GitInvocation["observe"]>;
  observed(): number;
  /** Whether every observed child has closed both of its pipes. */
  closed(): boolean;
  /** Whether any observed process is still running. */
  alive(): boolean;
}

/**
 * Watch the real children a row's chosen invocation spawns.
 *
 * The production host forwards this to `runProcess`, which calls it with the
 * child as it is spawned — the only point at which a row can see the process a
 * command really started. A wrapper around the host sees the call and its answer
 * and never the child between them, so observing residue afterwards cannot tell
 * an interrupted command from one that never began.
 */
function watchChildren(): WatchedChildren {
  const pids: number[] = [];
  let count = 0;
  let closes = 0;
  const first = withResolvers<void>();
  return {
    spawned: first.operation,
    observe(child): void {
      count += 1;
      if (child.pid !== undefined) {
        pids.push(child.pid);
      }
      child.on("close", () => {
        closes += 1;
      });
      first.resolve();
    },
    observed: () => count,
    closed: () => count > 0 && closes === count,
    alive: () =>
      pids.some((pid) => {
        try {
          // Signal 0 asks the operating system whether the process is there.
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
  };
}

/**
 * A script that reports it ran and then waits.
 *
 * What makes a child cut deterministic: the marker says the command really
 * reached this point, and the wait keeps it there until the halt arrives. The
 * process group teardown is what ends it.
 */
function* waitingScript(path: string, marker: string): Operation<void> {
  yield* writeTextFile(path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nsleep 120\n`);
  yield* until(chmod(path, 0o755));
}

interface Run {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  /** What ended the entry, when something did. */
  readonly refusal: string | undefined;
}

interface RunOptions {
  /** The directory the entry is opened in. Defaults to the fixture's link. */
  readonly cwd?: string;
  /** What this row installs between the host and the recording. */
  readonly between?: () => Operation<void>;
  /** A barrier inside one `git` invocation. */
  readonly barrier?: GitBarrier;
  /** What this row changes about one invocation before the real host runs it. */
  readonly intercept?: (invocation: GitInvocation) => Partial<GitInvocation> | undefined;
  /** Whether this entry installs a managed root at all. */
  readonly root?: string | undefined;
  /** What this host says about who a commit is by. Absent states the usual pair. */
  readonly identity?: Record<string, string> | undefined;
}

/** One entry, over one journal, in one checkout. */
function run(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  counted: Counters,
  options: RunOptions = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const working = options.cwd ?? fixture.link;
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return working;
        },
      },
      { at: "min" },
    );
    const files = countingFiles(counted);
    yield* API.Files.around(
      {
        checkFilePath: ([input]) => files.checkFilePath(input),
        readTextFile: ([input]) => files.readTextFile(input),
        globFiles: ([input]) => files.globFiles(input),
        temporaryDirectory: () => files.temporaryDirectory(),
        writeTextFile: ([input]) => files.writeTextFile(input),
        deleteFile: ([input]) => files.deleteFile(input),
        ensureDirectory: ([input]) => files.ensureDirectory(input),
      },
      { at: "min" },
    );
    yield* useCompositionComponents();
    if (options.between !== undefined) {
      yield* options.between();
    }
    const managed = "root" in options ? options.root : fixture.managed;
    // Registered the way the REPL host registers it: core initialization is
    // what establishes the recording and the handlers, inside the scope the
    // invocation owns.
    yield* Execution.around({
      *init(_args, next): Operation<void> {
        yield* useReplRepositoryRecording({
          host: countingHost(counted, options.barrier, options.intercept),
          identity: identityReader(
            counted,
            "identity" in options ? options.identity : STATED_IDENTITY,
          ),
          ...(managed === undefined ? {} : { root: managed }),
        });
        yield* next();
      },
    });
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream, includes: [fixture.root] }, [
            // What the Git Plugin contributes for `repl`, attached directly:
            // this suite assembles no command Plugins.
            { admissions: [(retained) => admitReplRepositoryHistory(retained)] },
          ]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, events: yield* stream.readAll(), refusal };
  });
}

/**
 * The prefix an entry left behind when it was left at a question.
 *
 * A *real* unfinished history, not a complete one with its closes removed: a
 * journal whose run finished replays every position it holds and runs no
 * component, so a continuation with a new suffix would never reach the suffix.
 * What these rows are about is the other case — somebody answered nothing, the
 * entry is still standing there, and the work after the question has never run.
 */
function left(
  fixture: Fixture,
  source: string,
  counted: Counters,
  options: RunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* spawn(() =>
      run(fixture, source, stream, counted, {
        ...options,
        *between(): Operation<void> {
          if (options.between !== undefined) {
            yield* options.between();
          }
          yield* Elicitation.around({
            *elicit(): Operation<unknown> {
              reached.resolve();
              // Nobody answers, so this is where the entry is when it is left.
              return yield* suspend();
            },
          });
        },
      }),
    );
    yield* race([
      reached.operation,
      (function* (): Operation<never> {
        yield* sleep(30_000);
        throw new Error("the entry never reached its question");
      })(),
    ]);
    const prefix = [...(yield* stream.readAll())];
    yield* task.halt();
    return prefix;
  });
}

/** An elicitation that answers at once, for a continuation past a question. */
function answered(count: { asked: number } = { asked: 0 }): Operation<void> {
  return Elicitation.around({
    // deno-lint-ignore require-yield
    *elicit(): Operation<unknown> {
      count.asked += 1;
      return {};
    },
  });
}

/** Every payload of one record type, in journal order. */
function recordsOf(events: readonly DurableEvent[], type: string): readonly Json[] {
  const held: Json[] = [];
  for (const event of events) {
    if (event.type === "yield" && event.description.type === type && event.result.status === "ok") {
      held.push(event.result.value ?? null);
    }
  }
  return held;
}

/** What each local Git record says about the operation it describes. */
function gitRecords(events: readonly DurableEvent[]): ReplGitRecord[] {
  return recordsOf(events, REPL_REPOSITORY_GIT).map((payload) => {
    const parsed = parseReplGitRecord(payload);
    if (parsed === undefined) {
      throw new Error("a recorded local Git operation is not readable");
    }
    return parsed;
  });
}

/** The names, in order, this journal recorded local Git operations under. */
function gitNames(events: readonly DurableEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_GIT)
    .map((event) => (event.type === "yield" ? event.description.name : ""));
}

/** The object id a recorded commit names, for the rows about a saved binding. */
function committed(record: ReplGitRecord | undefined): string | undefined {
  if (record?.outcome.ok !== true) {
    return undefined;
  }
  const value = record.outcome.value;
  return "commit" in value ? value.commit : undefined;
}

/** The branch a recorded switch ended on. */
function switched(record: ReplGitRecord | undefined): string | undefined {
  if (record?.outcome.ok !== true) {
    return undefined;
  }
  const value = record.outcome.value;
  return "resolvedBranch" in value ? value.resolvedBranch : undefined;
}

/** What one checkout holds right now, read with a session of this suite's own. */
function* observed(
  fixture: Fixture,
  checkout: string,
): Operation<{ branch: string; head: string; staged: string }> {
  const git = gitSession(denoRepositoryHost(), fixture.root);
  const branch = yield* git.run(["rev-parse", "--abbrev-ref", "HEAD"], checkout);
  const head = yield* git.run(["rev-parse", "HEAD"], checkout);
  const staged = yield* git.run(["write-tree"], checkout);
  return {
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    staged: staged.stdout.trim(),
  };
}

/** Run one fixture command with a session of this suite's own, not the entry's. */
function* fixtureGit(fixture: Fixture, args: string[], cwd: string): Operation<string> {
  const outcome = yield* gitSession(denoRepositoryHost(), fixture.root).run(args, cwd);
  return outcome.stdout.trim();
}

/** The canonical common Git directory the repository owning this checkout has. */
function commonOf(fixture: Fixture, checkout: string): Operation<string> {
  return fixtureGit(fixture, ["rev-parse", "--path-format=absolute", "--git-common-dir"], checkout);
}

/** What admitting this history answered: nothing, or the refusal it raised. */
function* admitted(events: readonly DurableEvent[]): Operation<string | undefined> {
  try {
    yield* admitReplRepositoryHistory(events);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The question an entry is left at, never answered. */
const QUESTION = '<Elicit schema={{ type: "object" }} as="answer">Continue?</Elicit>';

describe("one entry's local Add, Switch and Commit", () => {
  it("E2: replays acknowledged Switch, Add and Commit with no Git work", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      '<Git.Switch branch="experiment" />',
      '<File path="note.md">first</File>',
      '<Git.Commit message="Record experiment" as="commit">',
      '  <Git.Add paths="note.md" />',
      "</Git.Commit>",
      "Recorded commit: {commit}",
      QUESTION,
      '<File path="after.md">continued</File>',
    ].join("\n");

    const prefix = yield* left(fixture, source, live);

    // Three recorded Git operations, in the order the document wrote them, with
    // the staging child before the Commit that encloses it.
    const recorded = gitRecords(prefix);
    expect(recorded.map((record) => record.operation)).toEqual(["switch", "add", "commit"]);
    expect(switched(recorded[0])).toBe("experiment");
    const commit = committed(recorded[2]);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    // The commit really happened in the checkout, and it is what the document
    // bound.
    expect((yield* observed(fixture, fixture.checkout)).head).toBe(commit);
    expect(live.identity).toEqual(["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]);
    expect(subcommands(live)).toContain("switch");
    expect(subcommands(live)).toContain("add");
    expect(subcommands(live)).toContain("commit");

    // The checkout and the record now disagree, which the REPL's execution
    // model allows: branch, index and HEAD all move behind the completed work.
    yield* fixtureGit(fixture, ["switch", "-c", "elsewhere"], fixture.checkout);
    yield* writeTextFile(join(fixture.checkout, "note.md"), "changed by somebody else");
    yield* fixtureGit(fixture, ["add", "note.md"], fixture.checkout);
    yield* fixtureGit(fixture, ["commit", "-m", "theirs"], fixture.checkout);
    const theirs = yield* observed(fixture, fixture.checkout);
    expect(theirs.head).not.toBe(commit);

    // And the directory the entry was opened through now points at another
    // repository entirely, so live routing would fail admission rather than
    // answer. A continuation that answers has resolved nothing.
    yield* repoint(fixture, fixture.elsewhere);

    const replayed = counters();
    const asked = { asked: 0 };
    const again = yield* scoped(function* () {
      // Held by this suite for the whole continuation. A continuation taking
      // the mutation lease would open a second descriptor on the same sidecar
      // and be refused by the operating system.
      yield* useCommonDirectoryLease(yield* until(realpath(join(fixture.checkout, ".git"))));
      return yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
        between: () => answered(asked),
      });
    });

    expect(again.refusal).toBe(undefined);
    // The saved commit, not today's HEAD.
    expect(again.output).toContain(`Recorded commit: ${commit}`);
    expect(again.output).not.toContain(theirs.head);
    // Zero Git, zero isolation directories, zero identity reads, and no new
    // local-Git record for the prefix.
    expect(replayed.commands).toEqual([]);
    expect(replayed.directories).toBe(0);
    expect(replayed.identity).toEqual([]);
    expect(gitRecords(again.events).length).toBe(recorded.length);
    // The suffix after the answered question ran exactly once, and the external
    // work survived.
    expect(asked.asked).toBe(1);
    expect(replayed.writes).toEqual(["after.md"]);
    const after = yield* observed(fixture, fixture.checkout);
    expect(after.branch).toBe("elsewhere");
    expect(after.head).toBe(theirs.head);
    expect(yield* readTextFile(join(fixture.checkout, "note.md"))).toBe("changed by somebody else");
  });

  it("E2: answers a saved managed prefix with the selected worktree removed", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
      '<Worktree name="experiment" branch="experiment" as="worktree" />',
      "<Dir path={worktree}>",
      '<File path="note.md">first</File>',
      '<Git.Commit message="Record it" as="commit">',
      '  <Git.Add paths="note.md" />',
      "</Git.Commit>",
      "Recorded commit: {commit}",
      QUESTION,
      "</Dir>",
      "</Repository>",
    ].join("\n");

    const prefix = yield* left(fixture, source, live);
    const recorded = gitRecords(prefix);
    expect(recorded.map((record) => record.operation)).toEqual(["add", "commit"]);
    const commit = committed(recorded[1]);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    // The commit ran in the selected worktree rather than in the Repository's
    // own checkout, which is what the `<Dir>` around it selected.
    const where = recorded[1]?.outcome.ok === true ? recorded[1].outcome.value.checkout : undefined;
    expect(where?.worktreeName).toBe("experiment");
    expect(where?.checkoutPath).toBe(
      `${worktreeSlot(fixture.managed, yield* commonOf(fixture, where?.checkoutPath ?? ""), "experiment")}/checkout`,
    );

    // The selected worktree is removed outright — the state a selector would
    // refuse and a repair would recreate.
    yield* rm(where?.checkoutPath ?? "", { recursive: true, force: true });

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: () => answered(),
    });

    expect(again.refusal).toBe(undefined);
    expect(again.output).toContain(`Recorded commit: ${commit}`);
    // Nothing was run, cloned, added, recreated or repaired.
    expect(replayed.commands).toEqual([]);
    expect(replayed.sessions).toEqual([]);
    expect(replayed.identity).toEqual([]);
    expect(yield* exists(where?.checkoutPath ?? "")).toBe(false);
  });

  it("E3: ignores an unusable creation base for a branch that exists", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* fixtureGit(fixture, ["branch", "ready"], fixture.checkout);
    const before = yield* observed(fixture, fixture.checkout);

    const performed = yield* run(
      fixture,
      '<Git.Switch branch="ready" base="nothing-resolves-this" />',
      new InMemoryStream(),
      counted,
    );

    expect(performed.refusal).toBe(undefined);
    const record = gitRecords(performed.events)[0];
    expect(switched(record)).toBe("ready");
    // A base is consulted only when a branch has to be created, so the
    // unusable one is irrelevant rather than a refusal — and nothing moved.
    expect(
      record?.outcome.ok === true && "resolvedBase" in record.outcome.value
        ? record.outcome.value.resolvedBase
        : "unset",
    ).toBe(null);
    const after = yield* observed(fixture, fixture.checkout);
    expect(after.branch).toBe("ready");
    expect(after.head).toBe(before.head);
  });

  it("E3: starts a missing branch at live HEAD when no base is supplied", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const before = yield* observed(fixture, fixture.checkout);

    const performed = yield* run(
      fixture,
      '<Git.Switch branch="fresh" />',
      new InMemoryStream(),
      counted,
    );

    expect(performed.refusal).toBe(undefined);
    const record = gitRecords(performed.events)[0];
    expect(switched(record)).toBe("fresh");
    expect(
      record?.outcome.ok === true && "resolvedBase" in record.outcome.value
        ? record.outcome.value.resolvedBase
        : undefined,
    ).toBe(before.head);
    expect((yield* observed(fixture, fixture.checkout)).head).toBe(before.head);
  });

  it("E3: retains a conflicting Switch as a refusal and replays it after repair", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    // A branch that holds different content for a file the working tree has
    // changed, so switching to it would overwrite work.
    yield* fixtureGit(fixture, ["switch", "-c", "other"], fixture.checkout);
    yield* writeTextFile(join(fixture.checkout, "seed.md"), "other\n");
    yield* fixtureGit(fixture, ["commit", "-am", "other"], fixture.checkout);
    yield* fixtureGit(fixture, ["switch", "main"], fixture.checkout);
    yield* writeTextFile(join(fixture.checkout, "seed.md"), "mine, uncommitted\n");

    const source = [
      "<PrintErrors>",
      '<Git.Switch branch="other" />',
      "</PrintErrors>",
      QUESTION,
    ].join("\n");
    const prefix = yield* left(fixture, source, live);

    const recorded = gitRecords(prefix);
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.outcome.ok).toBe(false);
    // The native refusal keeps its own words. The Workflow formatter's sentence
    // for an overwrite claims nothing was discarded to make room, and the
    // native one says what `git` reported.
    expect(prefix.length > 0).toBe(true);
    expect((yield* observed(fixture, fixture.checkout)).branch).toBe("main");

    // The checkout is repaired: the local change is gone, so a new attempt
    // would succeed.
    yield* fixtureGit(fixture, ["checkout", "--", "seed.md"], fixture.checkout);

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: () => answered(),
    });

    // Fixing the checkout after the refusal was acknowledged does not turn the
    // historical answer into success, and nothing was run to find out.
    expect(again.refusal).toBe(undefined);
    expect(replayed.commands).toEqual([]);
    expect((yield* observed(fixture, fixture.checkout)).branch).toBe("main");

    // A new invocation, in a new entry, does succeed.
    const fresh = counters();
    const later = yield* run(fixture, '<Git.Switch branch="other" />', new InMemoryStream(), fresh);
    expect(later.refusal).toBe(undefined);
    expect((yield* observed(fixture, fixture.checkout)).branch).toBe("other");
  });

  it("E3: commits the current index under the host identity and binds its id", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // Staged by hand, outside the document, and one unstaged file beside it.
    yield* writeTextFile(join(fixture.checkout, "staged.md"), "staged\n");
    yield* writeTextFile(join(fixture.checkout, "unstaged.md"), "unstaged\n");
    yield* fixtureGit(fixture, ["add", "staged.md"], fixture.checkout);

    const performed = yield* run(
      fixture,
      ['<Git.Commit message="Record the index" as="commit" />', "Commit: {commit}"].join("\n"),
      new InMemoryStream(),
      counted,
    );

    expect(performed.refusal).toBe(undefined);
    const record = gitRecords(performed.events)[0];
    const commit = committed(record);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(performed.output).toContain(`Commit: ${commit}`);
    // Exactly the index: nothing was staged for it, so the unstaged file is
    // still unstaged and is not in the commit.
    expect(yield* fixtureGit(fixture, ["rev-parse", "HEAD"], fixture.checkout)).toBe(commit);
    const listed = yield* fixtureGit(
      fixture,
      ["show", "--name-only", "--format=", "HEAD"],
      fixture.checkout,
    );
    expect(listed.split("\n").filter((line) => line !== "")).toEqual(["staged.md"]);
    // The invoking person's own author and committer, read once.
    expect(counted.identity).toEqual(["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]);
    expect(
      yield* fixtureGit(fixture, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], fixture.checkout),
    ).toBe("Entry Author <author@example.test>|Entry Committer <committer@example.test>");
    // And the clock is the operation's own rather than anything the identity
    // reported: `git var` named 1700000000, which this commit is not stamped at.
    const when = Number(
      yield* fixtureGit(fixture, ["log", "-1", "--format=%at"], fixture.checkout),
    );
    expect(when > 1700000000).toBe(true);
    expect(
      record?.outcome.ok === true && "committedAt" in record.outcome.value
        ? record.outcome.value.committedAt
        : undefined,
    ).toBe(when);
  });

  it("E3: refuses Commit alone when the host states no identity, reading once", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* writeTextFile(join(fixture.checkout, "staged.md"), "staged\n");
    yield* fixtureGit(fixture, ["add", "staged.md"], fixture.checkout);
    const before = yield* observed(fixture, fixture.checkout);

    const performed = yield* run(
      fixture,
      [
        '<Git.Switch branch="ready" />',
        "<PrintErrors>",
        '<Git.Commit message="Record it" as="commit" />',
        "</PrintErrors>",
        '<Git.Add paths="staged.md" />',
        '<File path="after.md">after</File>',
      ].join("\n"),
      new InMemoryStream(),
      counted,
      { identity: undefined },
    );

    // Printed and carried on past: Switch before it and Add after it both ran,
    // and the file beside them was written.
    expect(performed.refusal).toBe(undefined);
    expect(performed.output).toContain("cannot record who this commit is by");
    const records = gitRecords(performed.events);
    expect(records.map((record) => record.operation)).toEqual(["switch", "commit", "add"]);
    expect(records[1]?.outcome.ok).toBe(false);
    expect(records[0]?.outcome.ok).toBe(true);
    expect(records[2]?.outcome.ok).toBe(true);
    // Nothing was committed, and the read happened once for the one operation
    // that needed it.
    expect((yield* observed(fixture, fixture.checkout)).head).toBe(before.head);
    expect(counted.identity).toEqual(["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]);

    // And the refusal replays as the same refusal, with no identity read at all.
    const replayed = counters();
    const again = yield* run(
      fixture,
      [
        '<Git.Switch branch="ready" />',
        "<PrintErrors>",
        '<Git.Commit message="Record it" as="commit" />',
        "</PrintErrors>",
        '<Git.Add paths="staged.md" />',
        '<File path="after.md">after</File>',
      ].join("\n"),
      new InMemoryStream(performed.events.filter((event) => event.type !== "close")),
      replayed,
      { identity: undefined },
    );
    expect(again.output).toContain("cannot record who this commit is by");
    expect(replayed.identity).toEqual([]);
    expect(replayed.commands).toEqual([]);
  });

  it("E3: switches to the branch it recorded when the caller's value changes", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // Two real branches, so whichever one is reached is a branch that exists
    // and the difference is about which was asked for rather than about a
    // refusal.
    yield* fixtureGit(fixture, ["branch", "ready"], fixture.checkout);
    yield* fixtureGit(fixture, ["branch", "changed"], fixture.checkout);

    // Ordinary middleware that transforms and delegates, which is the supported
    // route. What it delegates is a request whose branch answers differently
    // the second time it is read — a caller-owned value this operation suspends
    // several times across.
    let reads = 0;
    const changing = function* (): Operation<void> {
      yield* Git.around({
        *switch([invocation], next): Operation<GitSwitchResult> {
          return yield* next({
            ...invocation,
            get branch(): string {
              reads += 1;
              return reads === 1 ? "ready" : "changed";
            },
          });
        },
      });
    };

    const source = ['<Git.Switch branch="ready" />', QUESTION].join("\n");
    const prefix = yield* left(fixture, source, counted, { between: changing });

    // Read once, so the record and the checkout cannot disagree.
    expect(reads).toBe(1);
    const record = gitRecords(prefix)[0];
    expect(record?.request.operation === "switch" ? record.request.branch : undefined).toBe(
      "ready",
    );
    expect(switched(record)).toBe("ready");
    expect((yield* observed(fixture, fixture.checkout)).branch).toBe("ready");

    // And the acknowledged result is one this host can read, so the entry
    // continues from it with no native work.
    const replayed = counters();
    let later = 0;
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      *between(): Operation<void> {
        yield* Git.around({
          *switch([invocation], next): Operation<GitSwitchResult> {
            later += 1;
            return yield* next(invocation);
          },
        });
        yield* answered();
      },
    });
    expect(again.refusal).toBe(undefined);
    expect(replayed.commands).toEqual([]);
    // The middleware above is still reached and still delegates; what it
    // delegates into is the saved result rather than a native switch.
    expect(later).toBe(1);
  });

  it("E3: retains an empty supplied base exactly, and reads it back", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* fixtureGit(fixture, ["branch", "ready"], fixture.checkout);
    const before = yield* observed(fixture, fixture.checkout);

    // `<Git.Switch base="">` is the absence of a base to the component, so this
    // arrives through the public Api — where the ordinary performer ignores it
    // for a branch that exists, exactly as it ignores any base there.
    const supplied = function* (): Operation<void> {
      yield* Git.around({
        *switch([invocation], next): Operation<GitSwitchResult> {
          return yield* next({ ...invocation, base: "" });
        },
      });
    };

    const source = ['<Git.Switch branch="ready" />', QUESTION].join("\n");
    const prefix = yield* left(fixture, source, counted, { between: supplied });

    // The ordinary success, retained with the bytes it was given rather than
    // with an absence invented for it.
    const record = gitRecords(prefix)[0];
    expect(record?.outcome.ok).toBe(true);
    expect(record?.request.operation === "switch" ? record.request.base : undefined).toBe("");
    expect(
      record?.outcome.ok === true && "requestedBase" in record.outcome.value
        ? record.outcome.value.requestedBase
        : undefined,
    ).toBe("");
    expect(switched(record)).toBe("ready");
    expect((yield* observed(fixture, fixture.checkout)).head).toBe(before.head);
    // Readable, and admissible as this entry's own history.
    expect(yield* admitted(prefix)).toBe(undefined);

    // So a real unfinished prefix continues from it, with no native work.
    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      *between(): Operation<void> {
        yield* supplied();
        yield* answered();
      },
    });
    expect(again.refusal).toBe(undefined);
    expect(replayed.commands).toEqual([]);
  });

  it("E3: keeps a native ignored-path Add refusal native, with no rollback claim", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* writeTextFile(join(fixture.checkout, ".gitignore"), "ignored.md\n");
    yield* writeTextFile(join(fixture.checkout, "ignored.md"), "ignored\n");
    yield* writeTextFile(join(fixture.checkout, "ordinary.md"), "ordinary\n");

    const performed = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<Git.Add paths={["ordinary.md", "ignored.md"]} />',
        "</PrintErrors>",
        '<File path="after.md">after</File>',
      ].join("\n"),
      new InMemoryStream(),
      counted,
    );

    expect(performed.refusal).toBe(undefined);
    // `git` itself refused, in its own fixed words. The Workflow sentence for
    // this condition claims the staging was discarded with the rest of the
    // attempt, and nothing here discards anything.
    expect(performed.output).toContain("git refused: ignored-pathspec");
    expect(performed.output).not.toContain("was discarded with the rest of the attempt");
    const record = gitRecords(performed.events)[0];
    expect(record?.outcome.ok).toBe(false);
    // Native Add is not all-or-none: the ordinary path it matched before it
    // refused is staged, and the refusal rolls nothing back.
    const staged = yield* fixtureGit(
      fixture,
      ["diff", "--cached", "--name-only"],
      fixture.checkout,
    );
    expect(staged.split("\n").filter((line) => line !== "")).toEqual(["ordinary.md"]);

    // The refusal replays as the same one, with the ignored path still ignored
    // and nothing run to find out.
    const replayed = counters();
    const again = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<Git.Add paths={["ordinary.md", "ignored.md"]} />',
        "</PrintErrors>",
        '<File path="after.md">after</File>',
      ].join("\n"),
      new InMemoryStream(performed.events.filter((event) => event.type !== "close")),
      replayed,
    );
    expect(again.output).toContain("git refused: ignored-pathspec");
    expect(replayed.commands).toEqual([]);
  });

  it("E4: records two equal Adds at two positions and consumes two results", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    yield* writeTextFile(join(fixture.checkout, "note.md"), "first\n");
    const source = ['<Git.Add paths="note.md" />', '<Git.Add paths="note.md" />', QUESTION].join(
      "\n",
    );

    const prefix = yield* left(fixture, source, live);
    const recorded = gitRecords(prefix);
    expect(recorded.map((record) => record.operation)).toEqual(["add", "add"]);
    // One name at two ordered positions. Two equal requests are two records,
    // and nothing deduplicates them.
    const names = gitNames(prefix);
    expect(names.length).toBe(2);
    expect(names[0]).toBe(names[1]);
    expect(subcommands(live).filter((word) => word === "add").length).toBe(2);

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: () => answered(),
    });
    expect(again.refusal).toBe(undefined);
    expect(replayed.commands).toEqual([]);
    expect(gitRecords(again.events).length).toBe(2);
  });

  it("E4: serializes two same-repository callers through one acquisition", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* writeTextFile(join(fixture.checkout, "one.md"), "one\n");
    yield* writeTextFile(join(fixture.checkout, "two.md"), "two\n");

    // Both branches reach their Add; the turn is what keeps the two native
    // commands from overlapping.
    let inside = 0;
    let overlapped = 0;
    const barrier: GitBarrier = function* (invocation): Operation<void> {
      if (!invocation.args.includes("add")) {
        return;
      }
      inside += 1;
      overlapped = Math.max(overlapped, inside);
      yield* settled();
      inside -= 1;
    };

    const performed = yield* run(
      fixture,
      [
        "<All>",
        "<Spawn>",
        '<Git.Add paths="one.md" />',
        "</Spawn>",
        "<Spawn>",
        '<Git.Add paths="two.md" />',
        "</Spawn>",
        "</All>",
      ].join("\n"),
      new InMemoryStream(),
      counted,
      { barrier },
    );

    expect(performed.refusal).toBe(undefined);
    // Two distinct results, and never two native commands at once.
    const records = gitRecords(performed.events);
    expect(records.length).toBe(2);
    expect(gitNames(performed.events)[0]).not.toBe(gitNames(performed.events)[1]);
    expect(overlapped).toBe(1);
    // One isolation directory for the entry, taken once however many operations
    // asked for it.
    expect(counted.directories).toBe(1);
    const staged = yield* fixtureGit(
      fixture,
      ["diff", "--cached", "--name-only"],
      fixture.checkout,
    );
    expect(
      staged
        .split("\n")
        .filter((line) => line !== "")
        .sort(),
    ).toEqual(["one.md", "two.md"]);
  });

  it("E4: keeps a nested Add before the Commit that encloses it", function* () {
    const fixture = yield* useFixture();
    const counted = counters();

    const performed = yield* run(
      fixture,
      [
        '<File path="note.md">first</File>',
        '<Git.Commit message="Record experiment" as="commit">',
        '  <Git.Add paths="note.md" />',
        "</Git.Commit>",
      ].join("\n"),
      new InMemoryStream(),
      counted,
    );

    expect(performed.refusal).toBe(undefined);
    const records = gitRecords(performed.events);
    // The staging child finished before the Commit started, and each is its own
    // journal operation: the Commit's envelope does not enclose its children.
    expect(records.map((record) => record.operation)).toEqual(["add", "commit"]);
    const staged = records[0];
    const commit = records[1];
    const index =
      staged?.outcome.ok === true && "paths" in staged.outcome.value
        ? staged.outcome.value.after.indexTree
        : undefined;
    // The commit wrote exactly the tree the child had just staged.
    expect(
      commit?.outcome.ok === true && "tree" in commit.outcome.value
        ? commit.outcome.value.tree
        : undefined,
    ).toBe(index);
  });

  it("E4: resumes two spawned branches' Git in reverse order, sharing nothing", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    // Two branches, two different managed repositories, two questions. Each
    // branch stages at its own position in its own coroutine.
    const branch = (name: string) =>
      [
        `<Spawn><Repository name=${JSON.stringify(name)} url=${JSON.stringify(fixture.origin)}>`,
        `<File path="${name}.md">${name}</File>`,
        `<Git.Add paths="${name}.md" />`,
        `<Elicit schema={{ type: "object" }} as="answer">Question for ${name}</Elicit>`,
        `<Git.Add paths="${name}.md" />`,
        "</Repository></Spawn>",
      ].join("\n");
    const source = ["<All>", branch("alpha"), branch("beta"), "</All>"].join("\n");

    const prefix = yield* scoped(function* () {
      const stream = new InMemoryStream();
      const waiting = withResolvers<void>();
      let asked = 0;
      const task = yield* spawn(() =>
        run(fixture, source, stream, live, {
          *between(): Operation<void> {
            yield* Elicitation.around({
              *elicit(): Operation<unknown> {
                asked += 1;
                if (asked === 2) {
                  waiting.resolve();
                }
                return yield* suspend();
              },
            });
          },
        }),
      );
      yield* race([
        waiting.operation,
        (function* (): Operation<never> {
          yield* sleep(30_000);
          throw new Error("both branches never reached their questions");
        })(),
      ]);
      const held = [...(yield* stream.readAll())];
      yield* task.halt();
      return held;
    });

    // Two staged operations, on two different coroutines, and neither branch's
    // record is in the other's.
    const staged = prefix.filter(
      (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_GIT,
    );
    expect(staged.length).toBe(2);
    expect(
      new Set(staged.map((event) => (event.type === "yield" ? event.coroutineId : ""))).size,
    ).toBe(2);

    // Continued with the answers arriving in the other order: `alpha` reached
    // its question first and is answered last here.
    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      *between(): Operation<void> {
        yield* Elicitation.around({
          *elicit([request]: [ElicitationRequest]): Operation<unknown> {
            yield* sleep(request.message.includes("alpha") ? 30 : 0);
            return {};
          },
        });
      },
    });

    expect(again.refusal).toBe(undefined);
    // Each branch replayed its own saved staging and performed its own suffix
    // once: four records in all, and no cursor or result shared between them.
    expect(gitRecords(again.events).length).toBe(4);
    expect(subcommands(replayed).filter((word) => word === "add").length).toBe(2);
  });

  it("E4: keeps equal sources in two journals independent", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.checkout, "note.md"), "note\n");
    const source = '<Git.Add paths="note.md" />';

    const first = counters();
    const one = yield* run(fixture, source, new InMemoryStream(), first);
    const second = counters();
    const two = yield* run(fixture, source, new InMemoryStream(), second);

    expect(one.refusal).toBe(undefined);
    expect(two.refusal).toBe(undefined);
    // The same source twice is the same name, and that is allowed: each entry
    // executes against its own segment, so a name another entry wrote is never
    // inside the range this one replays. Both performed.
    expect(gitNames(one.events)).toEqual(gitNames(two.events));
    expect(subcommands(first)).toContain("add");
    expect(subcommands(second)).toContain("add");
  });

  it("E6: leaves no completion when a finished Commit's append is cancelled", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const events: DurableEvent[] = [];
    const reached = withResolvers<void>();
    const held = withResolvers<void>();
    yield* writeTextFile(join(fixture.checkout, "staged.md"), "staged\n");
    yield* fixtureGit(fixture, ["add", "staged.md"], fixture.checkout);

    // A barrier between the native work and its acknowledgement: the commit has
    // happened, and the append has not.
    const barrier: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [...events];
      },
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === REPL_REPOSITORY_GIT) {
          reached.resolve();
          yield* held.operation;
        }
        events.push(event);
      },
    };

    // One document, run twice, so the continuation is a resumption rather than
    // a divergence. The printing region is where the second run's ordinary
    // refusal is shown.
    const source = [
      "<PrintErrors>",
      '<Git.Commit message="Record it" as="commit" />',
      "Commit: {commit}",
      "</PrintErrors>",
      '<File path="sentinel.md">sentinel</File>',
    ].join("\n");

    yield* scoped(function* () {
      const task = yield* spawn(() => run(fixture, source, barrier, counted));
      yield* reached.operation;
      yield* task.halt();
    });

    // The commit object exists in the checkout, and nothing says it does.
    const after = yield* observed(fixture, fixture.checkout);
    expect(subcommands(counted)).toContain("commit");
    expect(recordsOf(events, REPL_REPOSITORY_GIT)).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "sentinel.md"))).toBe(false);

    // So a continuation takes the live path — and gets today's answer, which is
    // the ordinary empty-index refusal, because the earlier attempt already
    // consumed the index. Nothing adopts or predicts the commit that was made.
    const again = counters();
    const continued = yield* run(fixture, source, new InMemoryStream([...events]), again);
    expect(continued.refusal).toBe(undefined);
    expect(continued.output).toContain("nothing is staged in the checkout it ran in");
    // Neither adopted nor predicted: the id of the commit that was really made
    // appears nowhere, and no success binding was offered for it.
    expect(continued.output).not.toContain(after.head);
    const records = gitRecords(continued.events);
    expect(records.length).toBe(1);
    expect(records[0]?.outcome.ok).toBe(false);
    expect(yield* readTextFile(join(fixture.checkout, "sentinel.md"))).toBe("sentinel");
  });

  it("E6: replays an acknowledged Commit that was then cancelled", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    yield* writeTextFile(join(fixture.checkout, "staged.md"), "staged\n");
    yield* fixtureGit(fixture, ["add", "staged.md"], fixture.checkout);
    const source = [
      '<Git.Commit message="Record it" as="commit" />',
      "Commit: {commit}",
      QUESTION,
    ].join("\n");

    const prefix = yield* left(fixture, source, live);
    const commit = committed(gitRecords(prefix)[0]);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: () => answered(),
    });
    expect(again.output).toContain(`Commit: ${commit}`);
    expect(replayed.commands).toEqual([]);
    expect(replayed.identity).toEqual([]);
  });

  it("E6: keeps a failed result append fatal, with no binding and nothing after", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const events: DurableEvent[] = [];
    yield* writeTextFile(join(fixture.checkout, "staged.md"), "staged\n");
    yield* fixtureGit(fixture, ["add", "staged.md"], fixture.checkout);

    const rejecting: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [...events];
      },
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === REPL_REPOSITORY_GIT) {
          throw new Error("the journal refused this event");
        }
        events.push(event);
      },
    };

    const performed = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<Git.Commit message="Record it" as="commit" />',
        "Commit: {commit}",
        "</PrintErrors>",
        '<File path="sentinel.md">sentinel</File>',
      ].join("\n"),
      rejecting,
      counted,
    );

    // The commit happened; the durability failure is fatal; no success binding
    // was offered; and nothing after it ran, printing region or not.
    expect(subcommands(counted)).toContain("commit");
    const reported = performed.refusal ?? performed.output;
    expect(reported).not.toContain("sentinel");
    expect(recordsOf(events, REPL_REPOSITORY_GIT)).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "sentinel.md"))).toBe(false);
  });

  it("E6: joins an interrupted Add child's close before the entry settles", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* writeTextFile(join(fixture.checkout, "note.md"), "note\n");
    const watched = watchChildren();
    const marker = join(fixture.root, "add-ran");
    const script = join(fixture.root, "waiting-hook");
    yield* waitingScript(script, marker);

    // `git add` runs no hook, so the child that waits is made to wait by a
    // `core.fsmonitor` program: it is consulted before the index is written,
    // and it holds the pipes the parent inherited.
    const intercept = (invocation: GitInvocation): Partial<GitInvocation> | undefined =>
      invocation.args.includes("add")
        ? {
            args: ["-c", `core.fsmonitor=${script}`, ...invocation.args],
            observe: watched.observe,
          }
        : undefined;

    yield* scoped(function* () {
      const task = yield* spawn(() =>
        run(fixture, '<Git.Add paths="note.md" />', new InMemoryStream(), counted, { intercept }),
      );
      // The marker says the descendant really ran and is holding the pipes.
      yield* appears(marker);
      yield* watched.spawned;
      yield* task.halt();
    });

    // The child this entry started closed before the entry settled, and no
    // outcome was invented for the work it never finished.
    expect(watched.observed() > 0).toBe(true);
    expect(watched.closed()).toBe(true);
    expect(watched.alive()).toBe(false);
  });

  it("E6: keeps an unclassified performer failure fatal and unrecorded", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* writeTextFile(join(fixture.checkout, "note.md"), "note\n");

    // A `git add` that fails in a way this provider has no word for. The
    // condition is infrastructure, so it publishes no completion and a printing
    // region cannot carry on past it.
    const intercept = (invocation: GitInvocation): Partial<GitInvocation> | undefined =>
      invocation.args.includes("add")
        ? { args: ["add", "--this-option-does-not-exist", "--", "note.md"] }
        : undefined;

    const performed = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<Git.Add paths="note.md" />',
        "</PrintErrors>",
        '<File path="sentinel.md">sentinel</File>',
      ].join("\n"),
      new InMemoryStream(),
      counted,
      { intercept },
    );

    expect(recordsOf(performed.events, REPL_REPOSITORY_GIT)).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "sentinel.md"))).toBe(false);
    const reported = performed.refusal ?? performed.output;
    expect(reported).not.toContain("sentinel");
  });

  it("refuses a Git element in an entry that configures no managed root", function* () {
    const fixture = yield* useFixture();
    const counted = counters();

    const performed = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<Git.Add paths="seed.md" />',
        "</PrintErrors>",
        '<File path="after.md">after</File>',
      ].join("\n"),
      new InMemoryStream(),
      counted,
      { root: undefined },
    );

    // An entry with no managed root installs no selector and no Git handler, so
    // the element reaches its own unchanged missing-provider refusal — before
    // any Git operation exists, and with nothing written down for it. The file
    // beside it is ordinary work and runs.
    expect(performed.refusal).toBe(undefined);
    expect(performed.output).toContain("an element written outside a <Repository>");
    expect(subcommands(counted)).not.toContain("add");
    expect(recordsOf(performed.events, REPL_REPOSITORY_GIT)).toEqual([]);
    expect(counted.writes).toEqual(["after.md"]);
  });
});
