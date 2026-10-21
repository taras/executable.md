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
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { runGit } from "./support/fixture-git.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
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
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import { useReplRepositoryRecording } from "../src/repl/repositories/deno/provider.ts";
import { slotTurns } from "../src/repl/repositories/deno/selections.ts";
import { admitReplRepositoryHistory } from "../src/repl/repositories/admission.ts";
import { useCompositionComponents } from "@executablemd/git";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
} from "../src/repl/repositories/placement-records.ts";
import type { ReplPlacementRecord } from "../src/repl/repositories/placement-records.ts";
import { REPL_REPOSITORY_LOCAL } from "../src/repl/repositories/records.ts";
import { repositorySlot, worktreeSlot } from "@executablemd/git/deno";

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

function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-select-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const origin = join(root, "origin");
    yield* until(mkdir(origin, { recursive: true }));
    yield* runGit(root, ["init", "-b", "main", origin]);
    yield* until(writeFile(join(origin, "README.md"), "origin\n"));
    yield* runGit(origin, ["add", "README.md"]);
    yield* runGit(origin, ["commit", "-m", "first"]);

    const ambient = join(root, "ambient");
    yield* until(mkdir(ambient, { recursive: true }));
    yield* runGit(root, ["init", "-b", "main", ambient]);
    yield* until(writeFile(join(ambient, "seed.md"), "seed\n"));
    // Committed, because a Repository identity is pinned at the commit HEAD
    // named when the entry opened: a checkout with no commit is one this
    // provider cannot say the shape of, and discovery answers with nothing.
    yield* runGit(ambient, ["add", "seed.md"]);
    yield* runGit(ambient, ["commit", "-m", "seed"]);

    const managed = join(root, "repositories");
    yield* provide({ root, origin, managed, ambient });
  });
}

/**
 * Where a slot keeps the sidecar that describes it.
 *
 * Spelled here rather than read from the writer's own layout module: the file
 * name is released on-disk shape, and a row that asked the implementation
 * where it writes could not catch the implementation moving it.
 */
function sidecarOf(slot: string): string {
  return join(slot, "metadata.json");
}

/** What the composition and the host beneath the recorder were asked to do. */
interface Counters {
  reads: string[];
  writes: string[];
  deletes: string[];
  ensures: string[];
  /** Every repository-handle method this entry called, by name, in order. */
  methods: string[];
}

function counters(): Counters {
  return {
    reads: [],
    writes: [],
    deletes: [],
    ensures: [],
    methods: [],
  };
}

/** The handle methods one entry called, in order. */
function methodsCalled(counted: Counters): string[] {
  return [...counted.methods];
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

/** What a row may do to one handle method before the real one runs. */
type MethodBarrier = (method: string) => Operation<void>;

/**
 * The production handle, counted, and interruptible at a named method.
 *
 * Every method is wrapped rather than replaced: what these rows need to know is
 * whether a selector ran at all, and the only honest way to answer is to let
 * the real clone and the real `worktree add` happen and watch. A barrier runs
 * *before* the real method is delegated to, so a row that halts there halts
 * with the selection still to come.
 *
 * A `trace`, where a row supplies one, records the selector's own teardown.
 * `ensure` inside a selector method registers on the scope that *called* it,
 * which is the selection's own — so the cleanup it adds is joined exactly where
 * a selector-owned resource's would be, and the order a journal then sees is
 * the order this suite asserts.
 */
function countingOperations(
  counted: Counters,
  barrier?: MethodBarrier,
  trace?: string[],
): () => Operation<DenoRepositoryOperations> {
  return function* (): Operation<DenoRepositoryOperations> {
    const operations = yield* useDenoRepositoryOperations();
    function* note(method: string): Operation<void> {
      counted.methods.push(method);
      if (barrier !== undefined) {
        yield* barrier(method);
      }
    }
    function* traced(): Operation<void> {
      if (trace === undefined) {
        return;
      }
      yield* ensure(function* () {
        trace.push("selector-cleanup-start");
        yield* sleep(20);
        trace.push("selector-cleanup-end");
      });
    }
    const wrapped: DenoRepositoryOperations = {
      ...operations,
      *selectRepository(slot, request) {
        yield* note("selectRepository");
        yield* traced();
        return yield* operations.selectRepository(slot, request);
      },
      *selectWorktree(slot, creation) {
        yield* note("selectWorktree");
        yield* traced();
        return yield* operations.selectWorktree(slot, creation);
      },
      *ambientCheckout(from) {
        yield* note("ambientCheckout");
        return yield* operations.ambientCheckout(from);
      },
      *ambientRepository(from) {
        yield* note("ambientRepository");
        return yield* operations.ambientRepository(from);
      },
    };
    return wrapped;
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
  /** A barrier inside one handle method. */
  readonly barrier?: MethodBarrier;
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
          operations: countingOperations(counted, options.barrier, trace),
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
    expect(methodsCalled(live)).toContain("selectRepository");
    expect(methodsCalled(live)).toContain("selectWorktree");
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
    // Not one operation asked of the handle, so no clone, no `worktree add`,
    // no metadata read, no credential and no isolation directory either: the
    // handle acquires lazily, and nothing on this path entered it.
    expect(methodsCalled(replayed)).toEqual([]);
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
    expect(methodsCalled(replayed)).toEqual([]);
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
    expect(methodsCalled(replayed)).not.toContain("selectRepository");
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
    yield* writeTextFile(sidecarOf(slot), "{}\n");

    const prefix = yield* left(fixture, source, live);
    // Asked once and refused: the selector is entered, decides from the
    // sidecar it cannot read, and changes nothing. The unreadable sidecar is
    // still the one this row wrote, so nothing was recreated over it.
    expect(methodsCalled(live)).toEqual(["selectRepository"]);
    expect(yield* readTextFile(sidecarOf(slot))).toBe("{}\n");

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
    expect(methodsCalled(replayed)).toEqual([]);
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

    // Two records, under one name, at two ordered positions. Each request asks
    // the selector for itself — so both are entered — and both answer from the
    // one slot this entry holds. That the two asks become one clone rather than
    // two is single-flight inside the selector, proved in
    // `packages/git/tests/run-composition-lazy.test.ts`.
    const names = placementNames(prefix);
    expect(names.length).toBe(2);
    expect(names[0]).toBe(names[1]);
    expect(methodsCalled(live)).toEqual(["selectRepository", "selectRepository"]);

    const replayed = counters();
    const again = yield* run(fixture, source, new InMemoryStream([...prefix]), replayed, {
      between: answered,
    });
    expect(again.refusal).toBe(undefined);
    expect(methodsCalled(replayed)).toEqual([]);
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
    // the directory: both branches asked, and both were answered with the same
    // checkout. That the two concurrent asks become one creation rather than
    // two is single-flight inside the selector, proved in
    // `packages/git/tests/run-composition-lazy.test.ts`.
    expect(placementNames(ran.events).length).toBe(2);
    expect(methodsCalled(live)).toEqual(["selectRepository", "selectRepository"]);
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
    // The selector's own teardown is joined before its answer becomes a
    // record, so no placement and no body work precede it. That the resource
    // being released is a credential, and that it is released in the clone's
    // own scope, is proved in `packages/git/tests/ambient-authentication.test.ts`.
    expect(trace).toEqual([
      "selector-cleanup-start",
      "selector-cleanup-end",
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
    expect(methodsCalled(replayed)).toEqual([]);
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
    expect(methodsCalled(counted)).toContain("selectRepository");
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
    expect(methodsCalled(replayed)).toEqual([]);
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

  it("E5: publishes no placement for a selection it was interrupted inside", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const entered = withResolvers<void>();
    // Held at the method the selection is performed by, so the halt lands with
    // the selection started and nothing decided about it. What the native clone
    // and its own descendant do between the call and its answer is proved where
    // the invocation is, in `packages/git/tests/repository-replay.test.ts`.
    const barrier: MethodBarrier = function* (method): Operation<void> {
      if (method !== "selectRepository") {
        return;
      }
      entered.resolve();
      yield* suspend();
    };
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)} as="project" />`,
      '<File path="sentinel.md">sentinel</File>',
    ].join("\n");

    const journal = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(() => run(fixture, source, journal, counted, { barrier }));
      yield* entered.operation;
      yield* task.halt();
    });

    // The selection was entered, nothing was published for it, and the body
    // after it never ran.
    expect(methodsCalled(counted)).toContain("selectRepository");
    expect(placements(yield* journal.readAll())).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);
  });

  it("E5: keeps the repository placement and publishes no worktree when cut inside one", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const entered = withResolvers<void>();
    const barrier: MethodBarrier = function* (method): Operation<void> {
      if (method !== "selectWorktree") {
        return;
      }
      entered.resolve();
      yield* suspend();
    };
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
      '<Worktree name="experiment" branch="experiment" as="worktree" />',
      '<File path="sentinel.md">sentinel</File>',
      "</Repository>",
    ].join("\n");

    const journal = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(() => run(fixture, source, journal, counted, { barrier }));
      yield* entered.operation;
      yield* task.halt();
    });

    // The enclosing repository is a record because its own selection finished;
    // the worktree is not, and nothing after it ran. That the interrupted
    // `worktree add` joins its own hook, leaves a checkout no metadata
    // describes, and is adopted rather than recreated next time is proved in
    // `packages/git/tests/repository-replay.test.ts`.
    expect(methodsCalled(counted)).toContain("selectWorktree");
    expect(placements(yield* journal.readAll()).map((record) => record.kind)).toEqual([
      "repository",
    ]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);
  });
});

/** The canonical common Git directory of one managed repository of this fixture. */
function* commonOf(fixture: Fixture, name: string): Operation<string> {
  const slot = repositorySlot(fixture.managed, fixture.origin, name);
  return yield* until(realpath(join(slot, "checkout", ".git")));
}
