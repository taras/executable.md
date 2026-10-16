/**
 * What one REPL entry's Repository and Worktree selections retain, replay and
 * refuse to repeat.
 *
 * Everything here runs a document through canonical execution with the entry
 * host installed and a real managed root, so what is proven is the whole path:
 * the authored `<Repository>` asks the composition Api, the ordinary managed
 * selector clones or reuses a checkout, the placement is recorded, and a
 * continuation answers from that record.
 *
 * The contract these rows hold the host to is the REPL's execution model.
 * Replay restores recorded answers; it does not restore the environment or
 * require it to match. So the rows that matter most are the ones where the two
 * disagree: a managed checkout edited behind a completed selection, a selected
 * worktree deleted outright, and a placement whose result was never
 * acknowledged.
 *
 * Each scenario gets its own source repository, managed root, HOME and journal,
 * because what most of them assert is what a *second* open of one history does.
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
import type { Operation, Result } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { chmod, mkdir, mkdtemp, open, readdir, realpath, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, cwd, hostFilesHandler } from "@executablemd/runtime";
import type {
  FilePathInput,
  FilesHandler,
  FileWriteInput,
  FileWriteSuccess,
} from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import type { GitAuthenticationSession } from "../src/deno/composition/authentication.ts";
import { UNAUTHENTICATED } from "../src/deno/composition/authentication.ts";
import { useReplRepositoryRecording } from "../src/deno/retained-repository/provider.ts";
import { slotTurns } from "../src/deno/retained-repository/selections.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
} from "../src/retained-repository/placement-records.ts";
import type { ReplPlacementRecord } from "../src/retained-repository/placement-records.ts";
import { REPL_REPOSITORY_LOCAL } from "../src/retained-repository/records.ts";
import { metadataOf, repositorySlot, worktreeSlot } from "../src/deno/run-composition/checkout-layout.ts";
import { writeMetadata } from "../src/deno/run-composition/checkouts.ts";
import { METADATA_VERSION } from "../src/deno/run-composition/metadata.ts";
import type { ManagedRepositoryMetadata } from "../src/deno/run-composition/metadata.ts";

interface Fixture {
  /** The scenario's own directory: source repository, managed root and HOME. */
  readonly root: string;
  /** The repository every `<Repository url=..>` in these rows clones from. */
  readonly origin: string;
  /** Where this scenario's managed checkouts live. */
  readonly managed: string;
  /** An ordinary checkout an entry is opened in, for the ambient rows. */
  readonly ambient: string;
}

/**
 * One source repository with a commit in it, plus a managed root of this
 * scenario's own.
 *
 * The locator is an absolute path, so the transport carries no identity and no
 * credential is ever asked for — which is also what makes "no authentication
 * session was opened" say something about replay rather than about the fixture.
 */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-select-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const git = gitSession(denoRepositoryHost(), root);
    const origin = join(root, "origin");
    yield* until(mkdir(origin, { recursive: true }));
    yield* git.run(["init", "-b", "main", origin], root);
    yield* until(writeFile(join(origin, "README.md"), "origin\n"));
    yield* git.run(["add", "README.md"], origin);
    yield* git.run(["commit", "-m", "first"], origin);

    const ambient = join(root, "ambient");
    yield* until(mkdir(ambient, { recursive: true }));
    yield* git.run(["init", "-b", "main", ambient], root);
    yield* until(writeFile(join(ambient, "seed.md"), "seed\n"));
    // Committed, because a Repository identity is pinned at the commit HEAD
    // named when the entry opened: a checkout with no commit is one this
    // provider cannot say the shape of, and discovery answers with nothing.
    yield* git.run(["add", "seed.md"], ambient);
    yield* git.run(["commit", "-m", "seed"], ambient);

    const managed = join(root, "repositories");
    yield* provide({ root, origin, managed, ambient });
  });
}

/** Let every ready task run, so "reached its wait" is about turns. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/**
 * A promise a row releases by hand.
 *
 * What makes the two filesystem cuts below deterministic rather than a race: an
 * acquisition is started, the halt is delivered while it is demonstrably still
 * pending, and only then is it allowed to deliver.
 */
function gate(): { readonly released: Promise<void>; release(): void } {
  let open = (): void => {};
  const released = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { released, release: () => open() };
}

/** The sidecar the metadata cut below writes, which is ordinary record data. */
const REPOSITORY_SIDECAR: ManagedRepositoryMetadata = Object.freeze({
  kind: "repository" as const,
  version: METADATA_VERSION,
  name: "project",
  locator: "/origin",
  locatorFingerprint: "a".repeat(64),
  requestedBase: null,
  creationCommit: "b".repeat(40),
  primaryBranch: "main",
  objectFormat: "sha1" as const,
  commonDirectory: "/origin/.git",
});

/** What one observed `git` child reported about its own lifetime. */
interface WatchedChildren {
  /** Resolves once a watched child has been spawned. */
  readonly spawned: Operation<void>;
  /** Handed to the host, which forwards it to the one place a child exists. */
  readonly observe: NonNullable<GitInvocation["observe"]>;
  /** How many watched children were spawned. */
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
 * child as it is spawned — the only point at which a row can see the process
 * this command really started. A wrapper around the host sees the call and its
 * answer and never the child between them, which is why observing residue
 * afterwards cannot tell an interrupted clone from one that never began.
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

/**
 * Make a `file://` clone of this fixture's origin wait inside its transfer.
 *
 * `uploadpack.packObjectsHook` is honored from the configuration of the
 * repository being read, which is this fixture's own, so the clone's child is a
 * real `git clone` with a real descendant doing real work when the halt
 * arrives. Without it a local clone of one commit finishes in milliseconds and
 * nothing is ever interrupted.
 */
function* blockPackObjects(fixture: Fixture): Operation<string> {
  const script = join(fixture.root, "pack-objects-hook");
  const marker = join(fixture.root, "pack-objects-ran");
  yield* waitingScript(script, marker);
  const git = gitSession(denoRepositoryHost(), fixture.root);
  yield* git.run(["config", "uploadpack.packObjectsHook", script], fixture.origin);
  return marker;
}

/**
 * A hooks directory whose one hook waits, for the commands that run hooks.
 *
 * `worktree add` runs `post-checkout` after it has made the checkout, so the
 * marker also says the partial state this row is about is already on disk.
 */
function* blockingHooks(fixture: Fixture, hook: string): Operation<string> {
  const hooks = join(fixture.root, "hooks");
  yield* until(mkdir(hooks, { recursive: true }));
  const marker = join(fixture.root, `${hook}-ran`);
  yield* waitingScript(join(hooks, hook), marker);
  return marker;
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

/** What the composition and the host beneath the recorder were asked to do. */
interface Counters {
  reads: string[];
  writes: string[];
  deletes: string[];
  ensures: string[];
  /** Every `git` invocation this entry ran, as its argument list. */
  commands: string[][];
  /** Every locator an authentication session was opened for. */
  sessions: string[];
  /** How many isolation directories this entry's Git session acquired. */
  directories: number;
}

function counters(): Counters {
  return {
    reads: [],
    writes: [],
    deletes: [],
    ensures: [],
    commands: [],
    sessions: [],
    directories: 0,
  };
}

/** The Git subcommands one entry issued, in order. */
function subcommands(counted: Counters): string[] {
  return counted.commands.map((args) => args.find((arg) => !arg.startsWith("-")) ?? "");
}

/**
 * The host filesystem, with the four document operations counted.
 *
 * Installed at `min`, the implementation slot, so the recorder's own middleware
 * composes above it exactly as it does in production.
 */
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
    *deleteFile(input: FilePathInput) {
      counted.deletes.push(input.path);
      return yield* host.deleteFile(input);
    },
    *ensureDirectory(input: FilePathInput) {
      counted.ensures.push(input.path);
      return yield* host.ensureDirectory(input);
    },
  };
}

/** What a row may do to one `git` invocation before the real one runs. */
type GitBarrier = (invocation: GitInvocation) => Operation<void>;

/**
 * The production host, counted, and interruptible at a named subcommand.
 *
 * Every leaf is wrapped rather than replaced: what these rows need to know is
 * whether a selector ran at all, and the only honest way to answer is to let
 * the real clone, the real `worktree add` and the real session happen and
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
 * The host, with the authentication a clone opens reporting its own release.
 *
 * Substituted at the one seam the production host already offers, so what this
 * observes is the *lifetime* of a selector-owned resource rather than anything
 * about a credential transport.
 */
function tracedAuthentication(host: RepositoryHost, trace: string[] | undefined): RepositoryHost {
  if (trace === undefined) {
    return host;
  }
  return {
    ...host,
    useAuthentication(): Operation<GitAuthenticationSession> {
      return resource(function* (provide) {
        yield* ensure(function* () {
          trace.push("auth-cleanup-start");
          yield* sleep(20);
          trace.push("auth-cleanup-end");
        });
        yield* provide(UNAUTHENTICATED);
      });
    },
  };
}

interface Run {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  /** What ended the entry, when something did. */
  readonly refusal: string | undefined;
}

interface RunOptions {
  /** The directory the entry is opened in. Defaults to the fixture root. */
  readonly cwd?: string;
  /** What this row installs between the host and the recording. */
  readonly between?: () => Operation<void>;
  /** A barrier inside one `git` invocation. */
  readonly barrier?: GitBarrier;
  /**
   * What this row changes about one invocation before the real host runs it.
   *
   * Where a row reaches the child a command spawns, and where it adds the `-c`
   * settings that make one wait. Returning nothing leaves the invocation
   * exactly as the provider built it.
   */
  readonly intercept?: (invocation: GitInvocation) => Partial<GitInvocation> | undefined;
  /** Whether this entry installs a managed root at all. */
  readonly root?: string | undefined;
  /**
   * Where this row records the selector's own cleanup and the work around it.
   *
   * Present only for the ownership row: the authentication a clone opens is
   * substituted for one that says when it is released, and the first document
   * write says when the body began.
   */
  readonly trace?: string[];
}

/** One entry, over one journal, with a real managed root. */
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
    const working = options.cwd ?? fixture.root;
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
    const trace = options.trace;
    if (trace !== undefined) {
      yield* API.Files.around({
        *writeTextFile([input], next): Operation<Result<FileWriteSuccess>> {
          trace.push("body-file-write");
          return yield* next(input);
        },
      });
    }
    yield* useCompositionComponents();
    if (options.between !== undefined) {
      yield* options.between();
    }
    const managed = "root" in options ? options.root : fixture.managed;
    // Registered the way the REPL host registers it: core initialization is
    // what establishes the recording and the selectors, inside the scope the
    // invocation owns.
    yield* Execution.around({
      *init(_args, next): Operation<void> {
        yield* useReplRepositoryRecording({
          host: tracedAuthentication(
            countingHost(counted, options.barrier, options.intercept),
            trace,
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
 *
 * So the entry is spawned, its question is reached and never answered, the
 * journal is read exactly as the interruption left it, and only then is the
 * entry halted.
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

/** The names, in order, this journal recorded placements under. */
function placementNames(events: readonly DurableEvent[]): readonly string[] {
  return events
    .filter(
      (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_PLACEMENT,
    )
    .map((event) => (event.type === "yield" ? event.description.name : ""));
}

/** What each placement record says about the selection it describes. */
function placements(events: readonly DurableEvent[]): ReplPlacementRecord[] {
  return recordsOf(events, REPL_REPOSITORY_PLACEMENT).map((payload) => {
    const parsed = parseReplPlacementRecord(payload);
    if (parsed === undefined) {
      throw new Error("a recorded placement is not readable");
    }
    return parsed;
  });
}

/** The checkout a successful placement record names. */
function checkoutOf(record: ReplPlacementRecord | undefined): string | undefined {
  return record?.outcome.ok === true ? record.outcome.value.checkoutRoot : undefined;
}

/** The question an entry is left at, never answered. */
const QUESTION = '<Elicit schema={{ type: "object" }} as="answer">Continue?</Elicit>';

/**
 * An elicitation that answers at once.
 *
 * The question is in the document because what these rows are about is leaving
 * an entry at one and coming back: the prefix a continuation reopens is the
 * journal with its close removed, which is the same history a person leaves
 * behind when they answer nothing and the entry is reopened later.
 */
function answered(count: { asked: number } = { asked: 0 }): Operation<void> {
  return Elicitation.around({
    // deno-lint-ignore require-yield
    *elicit(): Operation<unknown> {
      count.asked += 1;
      return {};
    },
  });
}

describe("one entry's managed Repository and Worktree selections", () => {
  it("E2: replays acknowledged placements and results with no selector work", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    // One document, run twice. The first run is left at the question, so the
    // suffix after it has never run; the second answers and reaches it. A
    // continuation is the same document — a different one is a divergence, not
    // a resumption.
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
      '<Worktree name="experiment" branch="experiment" as="worktree" />',
      "<Dir path={worktree}>",
      '<File path="note.md">first</File>',
      '<File path="note.md" as="held" />',
      "Recorded value: {held}",
      QUESTION,
      "</Dir>",
      '<File path="suffix.md">new suffix</File>',
      "</Repository>",
    ].join("\n");
    const prefix = yield* left(fixture, source, live);

    // Two placements and the file work inside them: one ensure, one write, one
    // read. The ensure is the managed worktree root itself, reached through the
    // path the self-closing `<Worktree>` bound.
    const recorded = placements(prefix);
    expect(recorded.map((record) => record.kind)).toEqual(["repository", "worktree"]);
    const worktree = checkoutOf(recorded[1]);
    expect(worktree).toBe(
      `${worktreeSlot(fixture.managed, yield* commonOf(fixture, "project"), "experiment")}/checkout`,
    );
    expect(live.ensures.length).toBe(1);
    expect(live.writes).toEqual(["note.md"]);
    expect(live.reads).toEqual(["note.md"]);
    expect(subcommands(live)).toContain("clone");
    expect(subcommands(live)).toContain("worktree");
    expect(yield* readTextFile(join(worktree ?? "", "note.md"))).toBe("first");

    // The environment and the record now disagree, which the REPL's execution
    // model allows. The managed checkout's bytes change, and the selected
    // worktree is removed outright — the state a selector would refuse.
    yield* writeTextFile(join(worktree ?? "", "note.md"), "changed by somebody else");
    yield* rm(worktree ?? "", { recursive: true, force: true });

    const replayed = counters();
    const repository = checkoutOf(recorded[0]) ?? "";
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: answered,
    });

    expect(again.refusal).toBe(undefined);
    // Not one selector call, clone, `worktree add`, metadata read, credential
    // or isolation directory: the Git session is acquired lazily, and nothing
    // on this path needed it.
    expect(replayed.commands).toEqual([]);
    expect(replayed.sessions).toEqual([]);
    expect(replayed.directories).toBe(0);
    // No replayed file work either: the ensure, the first write and the read
    // all answered from their records, and only the new suffix ran.
    expect(replayed.ensures).toEqual([]);
    expect(replayed.reads).toEqual([]);
    expect(replayed.writes).toEqual(["suffix.md"]);
    // The binding a continuation offers is the text the read answered with the
    // first time, from a checkout that no longer exists.
    expect(again.output).toContain("Recorded value: first");
    // Nothing was recreated or repaired to produce it, and the new suffix
    // reached the restored Repository placement's own checkout.
    expect(yield* exists(worktree ?? "")).toBe(false);
    expect(yield* readTextFile(join(repository, "suffix.md"))).toBe("new suffix");
  });

  it("E2: retains an absolute captured-path Dir, and replays it over a removed checkout", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    // The supported spelling this row is about: a self-closing Repository binds
    // its checkout path, and a `<Dir>` renders at exactly that absolute path.
    // The entry is opened outside any checkout, so nothing ambient can answer
    // for it — the placement is the only route there is.
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="project" />`,
      "<Dir path={project}>",
      QUESTION,
      "</Dir>",
    ].join("\n");

    const prefix = yield* left(fixture, source, live);
    const checkout = checkoutOf(placements(prefix)[0]) ?? "";
    expect(checkout).not.toBe("");

    // The ensure happened, at the checkout root itself, and it was retained:
    // an absolute path routed through the working directory would have landed
    // inside no placement and been recorded by nothing.
    expect(live.ensures).toEqual([checkout]);
    expect(recordsOf(prefix, REPL_REPOSITORY_LOCAL).length).toBe(1);

    // The checkout is gone, and the continuation answers the ensure from its
    // record rather than making the directory again.
    yield* rm(checkout, { recursive: true, force: true });

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: answered,
    });

    expect(again.refusal).toBe(undefined);
    expect(replayed.ensures).toEqual([]);
    expect(replayed.commands).toEqual([]);
    expect(replayed.directories).toBe(0);
    // And nothing recreated it. A replayed ensure that reached the filesystem
    // would have put the checkout root back.
    expect(yield* exists(checkout)).toBe(false);
  });

  it("E2: reports an ordinary live failure for a new read of a missing file", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    // The paired form, so the read after the question is relative to the
    // checkout this selection names without anything creating a directory.
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
      QUESTION,
      "<PrintErrors>",
      '<File path="absent.md" as="text" />',
      "</PrintErrors>",
      "</Repository>",
    ].join("\n");

    const prefix = yield* left(fixture, source, live);
    const checkout = checkoutOf(placements(prefix)[0]);
    expect(checkout).not.toBe(undefined);

    // The checkout is gone, and the continuation asks for a file in it.
    yield* rm(checkout ?? "", { recursive: true, force: true });

    const replayed = counters();
    const count = { asked: 0 };
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: () => answered(count),
    });

    // The question replayed from the journal like everything before it, so
    // nothing asked it again.
    expect(count.asked).toBe(1);
    // The read failed where the file is not, in the ordinary vocabulary, and
    // nothing cloned the checkout back into existence to answer it.
    expect(again.output).toContain('cannot read "absent.md": no such file');
    expect(subcommands(replayed)).not.toContain("clone");
    expect(yield* exists(checkout ?? "")).toBe(false);
  });

  it("E2: replays an ordinary selector refusal without native work", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const stream = new InMemoryStream();
    const source = [
      "<PrintErrors>",
      `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="project" />`,
      "</PrintErrors>",
      QUESTION,
    ].join("\n");

    // A slot carrying a sidecar this version cannot read, which is the
    // ordinary `incompatible-reuse` refusal and changes nothing on disk.
    const slot = repositorySlot(fixture.managed, fixture.origin, "project");
    yield* until(mkdir(slot, { recursive: true }));
    yield* writeTextFile(metadataOf(slot), "{}\n");

    const prefix = yield* left(fixture, source, live);
    expect(subcommands(live)).not.toContain("clone");

    // Recorded as the refusal it was, and replayed as the same one without the
    // selector being asked again.
    const recorded = placements(prefix);
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.outcome.ok).toBe(false);

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: answered,
    });
    const repeated = again.refusal === undefined ? again.output : again.refusal;
    expect(repeated).toContain("cannot read");
    expect(replayed.commands).toEqual([]);
    expect(replayed.directories).toBe(0);
  });

  it("E3: restores the enclosing Repository and its directory after nesting", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      `<Repository name="outer" url=${JSON.stringify(fixture.origin)}>`,
      '<Worktree name="inner-tree" branch="inner-tree">',
      '<File path="in-worktree.md">worktree</File>',
      "</Worktree>",
      `<Repository name="nested" url=${JSON.stringify(fixture.origin)}>`,
      '<File path="in-nested.md">nested</File>',
      "</Repository>",
      '<File path="back-in-outer.md">outer</File>',
      "</Repository>",
    ].join("\n");

    const ran = yield* run(fixture, source, new InMemoryStream(), live);
    expect(ran.refusal).toBe(undefined);

    const recorded = placements(ran.events);
    expect(recorded.map((record) => record.kind)).toEqual(["repository", "worktree", "repository"]);
    const outer = checkoutOf(recorded[0]) ?? "";
    const tree = checkoutOf(recorded[1]) ?? "";
    const nested = checkoutOf(recorded[2]) ?? "";
    expect(outer === nested).toBe(false);

    // Each write landed in the checkout its own lexical scope named, and the
    // write after the nested Repository landed back in the outer one.
    expect(yield* readTextFile(join(tree, "in-worktree.md"))).toBe("worktree");
    expect(yield* readTextFile(join(nested, "in-nested.md"))).toBe("nested");
    expect(yield* readTextFile(join(outer, "back-in-outer.md"))).toBe("outer");
    // All three writes were recorded, because all three were inside a managed
    // placement this entry registered.
    expect(recordsOf(ran.events, REPL_REPOSITORY_LOCAL).length).toBe(3);
  });

  it("E3: consumes its own record for each of two equal requests", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="first" />`,
      `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="second" />`,
      "{first} and {second}",
      QUESTION,
    ].join("\n");

    const prefix = yield* left(fixture, source, live);

    // Two records, under one name, at two ordered positions: one clone, and
    // the second selection reused the slot this entry already held.
    const names = placementNames(prefix);
    expect(names.length).toBe(2);
    expect(names[0]).toBe(names[1]);
    expect(subcommands(live).filter((name) => name === "clone").length).toBe(1);

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: answered,
    });
    expect(again.refusal).toBe(undefined);
    expect(replayed.commands).toEqual([]);
    expect(again.output).toContain("and");
  });

  it("E3: keeps two concurrent equal selections to one creation and two records", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const selection = `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="selected" />`;
    const source = [
      "<All>",
      `<Spawn>${selection}{selected}</Spawn>`,
      `<Spawn>${selection}{selected}</Spawn>`,
      "</All>",
    ].join("\n");

    const ran = yield* run(fixture, source, new InMemoryStream(), live);
    expect(ran.refusal).toBe(undefined);

    // Neither record was suppressed, and neither branch raced the other into
    // the directory: one clone for the two of them.
    expect(placementNames(ran.events).length).toBe(2);
    expect(subcommands(live).filter((name) => name === "clone").length).toBe(1);
    const recorded = placements(ran.events);
    expect(checkoutOf(recorded[0])).toBe(checkoutOf(recorded[1]));
  });

  it("E3: keeps a cancelled slot waiter from releasing the active holder", function* () {
    const serialize = slotTurns();
    const active = withResolvers<void>();
    const release = withResolvers<void>();
    let third = false;

    yield* scoped(function* (): Operation<void> {
      // A holding the turn, B waiting on A, C waiting behind B.
      yield* spawn(() =>
        serialize("one-slot", function* (): Operation<void> {
          active.resolve();
          yield* release.operation;
        }),
      );
      yield* active.operation;
      const waiting = yield* spawn(() =>
        serialize("one-slot", function* (): Operation<void> {
          yield* suspend();
        }),
      );
      yield* sleep(0);
      yield* spawn(() =>
        serialize("one-slot", function* (): Operation<void> {
          third = true;
          yield* suspend();
        }),
      );
      yield* sleep(0);

      // B leaves. It was never granted the turn, so it releases nothing and
      // the exclusion stays with A — a waiter that signalled its own
      // completion here would let C run a selector beside A's.
      yield* waiting.halt();
      yield* sleep(0);
      expect(third).toBe(false);

      // A ends, and C is the one that inherits the turn.
      release.resolve();
      yield* sleep(0);
      expect(third).toBe(true);
    });
  });

  it("E5: finishes the selector's own cleanup before the placement is recorded", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const trace: string[] = [];
    const events: DurableEvent[] = [];
    // The journal, with the placement append marked where it happens.
    const stream: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [...events];
      },
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === REPL_REPOSITORY_PLACEMENT) {
          trace.push("placement-append");
        }
        events.push(event);
        yield* sleep(0);
      },
    };

    const ran = yield* run(
      fixture,
      [
        `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
        '<File path="body.md">body</File>',
        "</Repository>",
      ].join("\n"),
      stream,
      live,
      { trace },
    );

    expect(ran.refusal).toBe(undefined);
    // The clone's authentication is the selector's own, not the entry's. Its
    // cleanup is joined before the answer becomes a record, so no placement and
    // no body work precede it.
    expect(trace).toEqual([
      "auth-cleanup-start",
      "auth-cleanup-end",
      "placement-append",
      "body-file-write",
    ]);
  });

  it("E3: resumes two spawned branches in their own placements, in reverse order", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    // Two branches, two different managed repositories, two questions. Each
    // branch records its own placement and its own file work at its own
    // position in its own coroutine.
    const branch = (name: string) =>
      [
        `<Spawn><Repository name=${JSON.stringify(name)} url=${JSON.stringify(fixture.origin)}>`,
        `<File path="${name}.md">${name}</File>`,
        `<Elicit schema={{ type: "object" }} as="answer">Question for ${name}</Elicit>`,
        `<File path="${name}-suffix.md">suffix</File>`,
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

    // Two placements, on two different coroutines, and neither branch's record
    // is in the other's.
    const selections = prefix.filter(
      (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_PLACEMENT,
    );
    expect(selections.length).toBe(2);
    expect(
      new Set(selections.map((event) => (event.type === "yield" ? event.coroutineId : ""))).size,
    ).toBe(2);
    expect([...live.writes].sort()).toEqual(["alpha.md", "beta.md"]);

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
    // Each branch's suffix ran once, in its own placement, and neither
    // replayed write happened again.
    expect([...replayed.writes].sort()).toEqual(["alpha-suffix.md", "beta-suffix.md"]);
    const recorded = placements(prefix);
    const alpha = recorded.find(
      (record) => record.request.kind === "repository" && record.request.name === "alpha",
    );
    const beta = recorded.find(
      (record) => record.request.kind === "repository" && record.request.name === "beta",
    );
    expect(checkoutOf(alpha) === checkoutOf(beta)).toBe(false);
    expect(yield* readTextFile(join(checkoutOf(alpha) ?? "", "alpha-suffix.md"))).toBe("suffix");
    expect(yield* readTextFile(join(checkoutOf(beta) ?? "", "beta-suffix.md"))).toBe("suffix");
  });

  it("E3: selects a root Worktree of the repository the entry was opened in", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      '<Worktree name="root-tree" branch="root-tree" as="tree" />',
      "<Dir path={tree}>",
      '<File path="from-root.md">root</File>',
      "</Dir>",
      QUESTION,
    ].join("\n");

    const prefix = yield* left(fixture, source, live, { cwd: fixture.ambient });

    // The ambient owner is recorded as its own selection, so a continuation
    // learns which repository the root Worktree belonged to without asking Git.
    const recorded = placements(prefix);
    expect(recorded.map((record) => record.kind)).toEqual(["ambient-owner", "worktree"]);
    const tree = checkoutOf(recorded[1]) ?? "";
    expect(yield* readTextFile(join(tree, "from-root.md"))).toBe("root");

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      cwd: fixture.ambient,
      between: answered,
    });
    expect(again.refusal).toBe(undefined);
    expect(replayed.commands).toEqual([]);
    expect(replayed.ensures).toEqual([]);
    expect(replayed.writes).toEqual([]);
  });

  it("E3: refuses a root Worktree outside a checkout with the actionable sentence", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const outside = join(fixture.root, "outside");
    yield* until(mkdir(outside, { recursive: true }));

    const ran = yield* run(
      fixture,
      '<Worktree name="nowhere" branch="nowhere" as="tree" />',
      new InMemoryStream(),
      live,
      { cwd: outside },
    );

    const stated = ran.refusal === undefined ? ran.output : ran.refusal;
    expect(stated).toContain("needs a repository");
    // Nothing was written down for a selection that found nothing.
    expect(placements(ran.events)).toEqual([]);
  });

  it("E6: leaves no placement when the acknowledgement is cancelled", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const events: DurableEvent[] = [];
    const reached = withResolvers<void>();
    const held = withResolvers<void>();
    const source =
      `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="project" />` +
      '\n<File path="sentinel.md">sentinel</File>';

    // A barrier between the native clone and its acknowledgement: the checkout
    // exists, and the append has not happened.
    const barrier: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [...events];
      },
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === REPL_REPOSITORY_PLACEMENT) {
          reached.resolve();
          yield* held.operation;
        }
        events.push(event);
      },
    };

    yield* scoped(function* () {
      const task = yield* spawn(() => run(fixture, source, barrier, counted));
      yield* reached.operation;
      yield* task.halt();
    });

    // The clone happened, and nothing says it did — so no body ran past it.
    expect(subcommands(counted)).toContain("clone");
    expect(recordsOf(events, REPL_REPOSITORY_PLACEMENT)).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);

    // A continuation therefore takes the live path, where the ordinary reuse
    // policy decides what the slot now holds.
    const again = counters();
    const continued = yield* run(fixture, source, new InMemoryStream([...events]), again);
    expect(continued.refusal).toBe(undefined);
    expect(placements(continued.events).length).toBe(1);
  });

  it("E6: bypasses the selector for a placement acknowledged before cancellation", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
      QUESTION,
      '<File path="suffix.md">new suffix</File>',
      "</Repository>",
    ].join("\n");

    const prefix = yield* left(fixture, source, live);
    expect(placements(prefix).length).toBe(1);
    const checkout = checkoutOf(placements(prefix)[0]) ?? "";

    // The suffix the interrupted run never reached: genuinely new work, inside
    // a placement that was restored rather than selected again.
    const replayed = counters();
    const count = { asked: 0 };
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: () => answered(count),
    });
    expect(again.refusal).toBe(undefined);
    // The question replayed, the selector was never asked, and the new write
    // reached the restored placement's own checkout.
    expect(count.asked).toBe(1);
    expect(replayed.commands).toEqual([]);
    expect(replayed.writes).toEqual(["suffix.md"]);
    expect(yield* readTextFile(join(checkout, "suffix.md"))).toBe("new suffix");
  });

  it("E6: keeps a rejected placement append fatal, with nothing after it", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const events: DurableEvent[] = [];
    const rejecting: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [...events];
      },
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === REPL_REPOSITORY_PLACEMENT) {
          throw new Error("the journal refused this event");
        }
        events.push(event);
      },
    };

    const ran = yield* run(
      fixture,
      [
        "<PrintErrors>",
        `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="project" />`,
        "</PrintErrors>",
        '<File path="sentinel.md">sentinel</File>',
      ].join("\n"),
      rejecting,
      counted,
    );

    // The first persistence failure is preserved, no placement was published,
    // and the sentinel after it never ran — printing region or not.
    const stated = ran.refusal === undefined ? ran.output : ran.refusal;
    expect(stated).toContain("persist");
    expect(stated).not.toContain("sentinel");
    expect(recordsOf(events, REPL_REPOSITORY_PLACEMENT)).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);
  });

  it("E5: joins an actually running clone child and its blocked descendant", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // A clone that is genuinely running when the halt arrives. The transport
    // command is a script that reports it was reached and then waits, so the
    // child is a real `git clone` holding a real descendant open — not a
    // command that had yet to be delegated to.
    //
    // Git creates the destination only once the connection has succeeded, so
    // this cut leaves no bytes behind. What it discriminates is the teardown:
    // whether the process this entry started, and the process that one
    // started, are joined before the owner finishes. The worktree cut below is
    // the one that interrupts a command *after* it has written something, and
    // proves the ordinary handling of what it left.
    const reached = join(fixture.root, "transport-ran");
    const transport = join(fixture.root, "transport");
    yield* waitingScript(transport, reached);
    const locator = "ssh://example.invalid/repo.git";
    const source = [
      `<Repository name="project" url=${JSON.stringify(locator)} as="project" />`,
      '<File path="sentinel.md">sentinel</File>',
    ].join("\n");

    const watched = watchChildren();
    const journal = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(() =>
        run(fixture, source, journal, counted, {
          intercept: (invocation) =>
            invocation.args.includes("clone")
              ? {
                  observe: watched.observe,
                  args: ["-c", `core.sshCommand=${transport}`, ...invocation.args],
                }
              : undefined,
        }),
      );
      yield* watched.spawned;
      // Not merely spawned: inside its own transport, with a descendant of its
      // own waiting. Halting before the delegation would interrupt a command
      // that had done nothing, which is the hole this row closes.
      yield* appears(reached);
      // The guard against a vacuous row: a clone that had already ended would
      // make everything below true without anything being interrupted.
      expect(watched.closed()).toBe(false);
      // Teardown kills the process group and waits for `close`, so this does
      // not return until the child and its descendant are gone.
      yield* task.halt();
    });

    expect(watched.observed()).toBe(1);
    expect(watched.closed()).toBe(true);
    expect(watched.alive()).toBe(false);

    // No placement was published, and no body ran after it.
    expect(placements(yield* journal.readAll())).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);
    // The isolation directory the session took is gone with the entry.
    expect(counted.directories).toBe(1);

    // And nothing was published for a creation that never reached a checkout.
    const slot = repositorySlot(fixture.managed, locator, "project");
    expect(yield* exists(metadataOf(slot))).toBe(false);
    expect(yield* temporarySiblings(slot)).toEqual([]);
  });

  it("E5: joins an actually running worktree-add child and adopts what it left", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // `worktree add` runs the `post-checkout` hook in the checkout it just
    // made, so a hook that waits holds the real child open after it has done
    // its work — which is the partial state the next attempt has to account
    // for.
    const checkedOut = yield* blockingHooks(fixture, "post-checkout");
    const hooks = join(fixture.root, "hooks");
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
      '<Worktree name="experiment" branch="experiment" as="worktree" />',
      '<File path="sentinel.md">sentinel</File>',
      "</Repository>",
    ].join("\n");

    const watched = watchChildren();
    const journal = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(() =>
        run(fixture, source, journal, counted, {
          intercept: (invocation) =>
            invocation.args.includes("worktree")
              ? {
                  observe: watched.observe,
                  args: ["-c", `core.hooksPath=${hooks}`, ...invocation.args],
                }
              : undefined,
        }),
      );
      yield* watched.spawned;
      // The hook runs after the checkout, so this says the worktree is on disk
      // and the command is still the live owner of it.
      yield* appears(checkedOut);
      expect(watched.closed()).toBe(false);
      yield* task.halt();
    });

    expect(watched.observed()).toBe(1);
    expect(watched.closed()).toBe(true);
    expect(watched.alive()).toBe(false);
    expect(placements(yield* journal.readAll()).map((record) => record.kind)).toEqual([
      "repository",
    ]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);

    // The worktree slot holds a checkout nothing describes yet.
    const owner = yield* commonOf(fixture, "project");
    const slot = worktreeSlot(fixture.managed, owner, "experiment");
    expect(yield* exists(join(slot, "checkout"))).toBe(true);
    expect(yield* exists(metadataOf(slot))).toBe(false);

    // The next attempt proves it under the ordinary stricter proof and adopts
    // it, which is what keeps the bytes somebody's work rather than something
    // to recreate.
    const again = counters();
    const continued = yield* run(fixture, source, new InMemoryStream(), again);
    expect(continued.refusal).toBe(undefined);
    expect(yield* readTextFile(metadataOf(slot))).toContain('"kind": "worktree"');
  });

  it("E5: waits for a pending metadata open and closes what it delivers", function* () {
    const fixture = yield* useFixture();
    const slot = join(fixture.root, "metadata-slot");
    yield* until(mkdir(slot, { recursive: true }));

    const asked = withResolvers<string>();
    const held = gate();
    let closed = false;
    let opened = false;
    // The open is started and then held, so the halt below lands in exactly the
    // window this ownership discipline exists for: after the acquisition began
    // and before its descriptor arrived.
    const openExclusive = (path: string): Promise<FileHandle> => {
      asked.resolve(path);
      return held.released
        .then(() => open(path, "wx"))
        .then((handle) => {
          opened = true;
          const close = handle.close.bind(handle);
          return Object.assign(handle, {
            close: (): Promise<void> => {
              closed = true;
              return close();
            },
          });
        });
    };

    let returned = false;
    yield* scoped(function* (): Operation<void> {
      const writing = yield* spawn(() => writeMetadata(slot, REPOSITORY_SIDECAR, openExclusive));
      const temporary = yield* asked.operation;
      const halting = yield* spawn(function* (): Operation<void> {
        yield* writing.halt();
        returned = true;
      });
      yield* settled();
      // Teardown is waiting for the acquisition it armed its release before.
      expect(returned).toBe(false);
      expect(opened).toBe(false);

      held.release();
      yield* halting;
      expect(temporary.startsWith(`${metadataOf(slot)}.`)).toBe(true);
    });

    // It waited for delivery, and closed what was delivered.
    expect(returned).toBe(true);
    expect(opened).toBe(true);
    expect(closed).toBe(true);
    // And published nothing: a sidecar is renamed into place only by a write
    // that finished.
    expect(yield* exists(metadataOf(slot))).toBe(false);
  });

  it("E5: waits for a pending isolation directory and removes what it delivers", function* () {
    const made: string[] = [];
    const asked = withResolvers<void>();
    const held = gate();
    const create = (prefix: string): Promise<string> => {
      asked.resolve();
      return held.released
        .then(() => mkdtemp(prefix))
        .then((directory) => {
          made.push(directory);
          return directory;
        });
    };
    const host = denoRepositoryHost({ directories: { create } });

    let returned = false;
    yield* scoped(function* (): Operation<void> {
      const taking = yield* spawn(function* (): Operation<void> {
        yield* host.useDirectory();
        yield* suspend();
      });
      yield* asked.operation;
      const halting = yield* spawn(function* (): Operation<void> {
        yield* taking.halt();
        returned = true;
      });
      yield* settled();
      // The creation is still pending, and teardown has not finished over it.
      expect(returned).toBe(false);
      expect(made).toEqual([]);

      held.release();
      yield* halting;
    });

    expect(returned).toBe(true);
    // It waited for the directory to arrive, and removed it.
    expect(made.length).toBe(1);
    expect(yield* exists(made[0] ?? "")).toBe(false);
  });
});

/** The canonical common Git directory of one managed repository of this fixture. */
function* commonOf(fixture: Fixture, name: string): Operation<string> {
  const slot = repositorySlot(fixture.managed, fixture.origin, name);
  return yield* until(realpath(join(slot, "checkout", ".git")));
}

/** Every orphan metadata sibling this slot holds. */
function* temporarySiblings(slot: string): Operation<string[]> {
  if (!(yield* exists(slot))) {
    return [];
  }
  const entries = yield* until(readdir(slot));
  return entries.filter((entry) => entry.startsWith("metadata.json.")).sort();
}

/** The isolation directories this host's sessions have left in the temporary root. */
function* isolationDirectories(): Operation<string[]> {
  const entries = yield* until(readdir(tmpdir()));
  return entries.filter((entry) => entry.startsWith("xmd-workflow-git-")).sort();
}
