/**
 * R3–R6 — one entry's local repository work, against real Git and real files.
 *
 * Everything here runs a document through canonical execution with the entry
 * host installed, so what is proven is the whole path: core delivers the
 * occurrence, the ordinary provider performs the work, and its result is
 * recorded once. A fixture that asserted on the protocol without the filesystem
 * would prove the bookkeeping and nothing about the checkout.
 *
 * The contract these rows hold the host to is the REPL's execution model.
 * Replay restores recorded results; it does not restore the environment or
 * require it to match. So the rows that matter most here are the ones where the
 * two disagree: a file changed behind a completed write, a checkout that is no
 * longer there, a write whose result was never acknowledged.
 *
 * Each scenario gets its own repository, HOME and journal. Nothing is shared,
 * because the thing most of these assert is what a *second* open of one history
 * does, and a shared checkout would make the second open depend on the first
 * test's leftovers.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import {
  ensureDir,
  exists,
  readTextFile,
  readdir as readDirectory,
  rm,
  writeTextFile,
} from "@effectionx/fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API,
  fileWriteFailure,
  filesFailure,
  hostFilesHandler,
  useHostFiles,
} from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import { collect } from "@executablemd/core";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { countingHost } from "./support/composition.ts";
import type { CompositionCounters } from "./support/composition.ts";
import { fileDeleteEntry, fileWriteEntry } from "@executablemd/core/host";
import { useRetainedRepositoryEntry } from "../src/deno/retained-repository/provider.ts";
import { useRunComposition } from "../src/deno/run-composition/provider.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import {
  REPL_REPOSITORY_RESULT,
  parseReplRepositoryResult,
} from "../src/retained-repository/records.ts";
import { METADATA, repositorySlot } from "../src/deno/run-composition/placement.ts";
import { admitRetainedRepositoryHistory } from "../src/retained-repository/admission.ts";

interface Fixture {
  readonly root: string;
  readonly checkout: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "retained-local-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    yield* ensureDir(join(root, "plain"));
    yield* ensureDir(join(root, "managed"));
    const git = gitSession(denoRepositoryHost(), root);
    yield* git.run(["init", "-b", "main", checkout], root);
    yield* git.run(["config", "user.name", "Retained"], checkout);
    yield* git.run(["config", "user.email", "retained@example.com"], checkout);
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    yield* git.run(["add", "seed.md"], checkout);
    yield* git.run(["commit", "-m", "seed"], checkout);
    yield* provide({ root, checkout });
  });
}

/** A Files provider that counts the mutations it is actually asked to make. */
interface Counted {
  readonly handler: FilesHandler;
  readonly writes: string[];
  readonly deletes: string[];
}

function counted(): Counted {
  const host = hostFilesHandler();
  const writes: string[] = [];
  const deletes: string[] = [];
  return {
    writes,
    deletes,
    handler: {
      checkFilePath: (input) => host.checkFilePath(input),
      readTextFile: (input) => host.readTextFile(input),
      globFiles: (input) => host.globFiles(input),
      ensureDirectory: (input) => host.ensureDirectory(input),
      temporaryDirectory: () => host.temporaryDirectory(),
      *writeTextFile(input) {
        writes.push(input.path);
        return yield* host.writeTextFile(input);
      },
      *deleteFile(input) {
        deletes.push(input.path);
        return yield* host.deleteFile(input);
      },
    },
  };
}

/**
 * The public Files layer a retained entry installs.
 *
 * It answers everything that is not a mutation and delegates the two that are,
 * which is what lets a canonical authored mutation reach its own
 * invocation-owned default. A layer that answered a write here would be the
 * direct-call case, and the mutation would fail closed rather than going
 * unrecorded.
 */
function* useEntryFiles(fixture: Fixture, leaf: FilesHandler): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd() {
        return fixture.checkout;
      },
    },
    { at: "min" },
  );
  yield* API.Files.around({
    checkFilePath: ([input]) => leaf.checkFilePath(input),
    readTextFile: ([input]) => leaf.readTextFile(input),
    globFiles: ([input]) => leaf.globFiles(input),
    temporaryDirectory: () => leaf.temporaryDirectory(),
    *ensureDirectory([input], next) {
      return yield* next(input);
    },
    *writeTextFile([input], next) {
      return yield* next(input);
    },
    *deleteFile([input], next) {
      return yield* next(input);
    },
  });
}

interface Run {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  /** What ended the entry, when something did. */
  readonly refusal: string | undefined;
}

/** One entry, over one journal, in one checkout. */
function run(
  fixture: Fixture,
  source: string,
  stream: InMemoryStream,
  leaf: FilesHandler = hostFilesHandler(),
  entryKey = "0001",
  evaluating = false,
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    yield* useEntryFiles(fixture, leaf);
    const entry = yield* useRetainedRepositoryEntry({
      executionId: "execution-1",
      entryKey,
      source: "entry.md",
      cwd: fixture.checkout,
      managedRoot: join(fixture.root, "managed"),
      host: denoRepositoryHost(),
      files: leaf,
    });
    // The one captured file access this entry's fragments run on, bound from
    // the same provider that answers its authored work.
    const installation = evaluating
      ? {
          ...entry.installation,
          evaluation: {
            read: [],
            write: [fileWriteEntry(), fileDeleteEntry()],
            files: entry.files,
          },
        }
      : entry.installation;
    // What ended the entry, when something did: a fatal history or durability
    // failure leaves the execution rather than appearing in the document, and
    // a row about replay has to be able to say which happened.
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream, includes: [fixture.root] }, [installation]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, events: yield* stream.readAll(), refusal };
  });
}

function recordsOf(events: readonly DurableEvent[], type: string): readonly Json[] {
  const held: Json[] = [];
  for (const event of events) {
    if (event.type === "yield" && event.description.type === type && event.result.status === "ok") {
      held.push(event.result.value ?? null);
    }
  }
  return held;
}

/**
 * A journal with its last recorded result removed.
 *
 * What an interruption leaves: native work that happened and whose outcome was
 * never acknowledged. There is nothing to replay for it, so a continuation
 * takes the ordinary live path.
 */
function interrupted(events: readonly DurableEvent[]): InMemoryStream {
  const last = events.findLastIndex(
    (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_RESULT,
  );
  return new InMemoryStream([...events.slice(0, last)]);
}

/** The paths this checkout's index holds right now. */
function* readIndexPaths(fixture: Fixture): Operation<readonly string[]> {
  const git = gitSession(denoRepositoryHost(), fixture.root);
  const listed = yield* git.read(["ls-files", "--stage"], fixture.checkout);
  return (listed ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(line.indexOf("\t") + 1));
}

/** Run an entry that is expected to refuse, and answer with its journal. */
function refused(fixture: Fixture, source: string): Operation<Run> {
  const stream = new InMemoryStream();
  return scoped(function* () {
    try {
      return yield* run(fixture, source, stream, counted().handler);
    } catch {
      return { output: "", events: yield* stream.readAll(), refusal: undefined };
    }
  });
}

/** The managed repository checkout this entry created, if it created one. */
function* checkoutPaths(fixture: Fixture): Operation<readonly string[]> {
  const managed = join(fixture.root, "managed", "repositories");
  if (!(yield* exists(managed))) {
    return [];
  }
  const slots = yield* readDirectory(managed);
  const found: string[] = [];
  for (const slot of slots) {
    const checkout = join(managed, slot, "checkout");
    if (yield* exists(checkout)) {
      found.push(checkout);
    }
  }
  return found;
}

/** One entry, with every native Git command it ran counted. */
function runCounting(
  fixture: Fixture,
  source: string,
  stream: InMemoryStream,
): Operation<{
  readonly counters: CompositionCounters;
  readonly events: readonly DurableEvent[];
  /** What ended the entry, when something did. */
  readonly refusal: string | undefined;
}> {
  const counting = countingHost();
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const leaf = counted();
    yield* useEntryFiles(fixture, leaf.handler);
    const entry = yield* useRetainedRepositoryEntry({
      executionId: "execution-1",
      entryKey: "0001",
      source: "entry.md",
      cwd: fixture.checkout,
      managedRoot: join(fixture.root, "managed"),
      host: counting.host,
      files: leaf.handler,
    });
    let refusal: string | undefined;
    try {
      yield* collect(
        yield* executeInstalled({ path, stream, includes: [fixture.root] }, [entry.installation]),
      );
    } catch (error) {
      // Reported rather than swallowed: which commands ran says nothing on its
      // own, because an entry that refused before it started ran none of them.
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { counters: counting.counters, events: yield* stream.readAll(), refusal };
  });
}

/**
 * The clones this entry ran into the placement it was asked for.
 *
 * Separate from every clone, because preparing a creation clones too — into a
 * scratch directory that goes away with the operation. What this counts is work
 * left where the document will see it.
 */
function targetCommands(
  counters: CompositionCounters,
  command: string,
  destination: string,
): readonly string[][] {
  return counters.commands.filter(
    (args) =>
      args[0] === command &&
      args.some((arg) => arg === destination || arg.startsWith(`${destination}/`)),
  );
}

/** Run an entry that may refuse, and answer with its journal either way. */
function refusedOrRan(fixture: Fixture, source: string, stream: InMemoryStream): Operation<Run> {
  return scoped(function* () {
    try {
      return yield* run(fixture, source, stream, counted().handler);
    } catch {
      return { output: "", events: yield* stream.readAll(), refusal: undefined };
    }
  });
}

/**
 * The same document through the ordinary run provider.
 *
 * What an `xmd run` would do with this batch: the same native work, with no
 * record of any of it. Answers with a refusal when one happened, so a
 * comparison cannot quietly be a comparison with a run that failed.
 */
function runOrdinary(fixture: Fixture, source: string): Operation<string | undefined> {
  return scoped(function* () {
    const path = join(fixture.root, "ordinary.md");
    yield* writeTextFile(path, source);
    // The ordinary host's own Files provider, which is what an `xmd run`
    // installs: the mutations go straight to it, recorded by nobody.
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return fixture.checkout;
        },
      },
      { at: "min" },
    );
    yield* useHostFiles();
    yield* useCompositionComponents();
    yield* useRunComposition({
      root: join(fixture.root, "ordinary-managed"),
      cwd: fixture.checkout,
      host: denoRepositoryHost(),
    });
    try {
      yield* collect(
        yield* executeInstalled(
          {
            path,
            stream: new InMemoryStream(),
            includes: [fixture.root],
          },
          [],
        ),
      );
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

describe("retained repository: one entry's local work", () => {
  it("R3: a write records what it did, and nothing about the checkout around it", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    // A file this entry never touches, beside the one it writes. Nothing about
    // it may appear in anything this entry records.
    yield* writeTextFile(join(fixture.checkout, "unrelated.md"), "not this entry's business\n");
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
      leaf.handler,
    );

    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("the note\n");
    expect(leaf.writes).toEqual(["notes.md"]);

    const results = recordsOf(events, REPL_REPOSITORY_RESULT).map((record) =>
      parseReplRepositoryResult(record),
    );
    // One record per operation, and selecting the checkout is one of them: it
    // is what says this entry works here.
    expect(results.map((record) => record?.operation)).toEqual(["ambient", "file-write"]);
    const write = results[1];
    expect(write?.owner).toBe('repl:v1:["execution-1","0001"]');
    // What it asked for, and what doing it produced. No state, no inventory,
    // and no byte of any other file.
    expect(write?.request).toEqual({
      cwd: fixture.checkout,
      path: "notes.md",
      content: "the note\n",
    });
    expect(write?.result).toEqual({ type: "file-write", publication: "host-committed" });
    expect(JSON.stringify(events)).not.toContain("not this entry's business");
  });

  it("R3: a completed write replays while the file holds something else", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const source = '<File path="notes.md">A</File>\n\nread: {props.unused}\n';
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">A</File>\n',
      new InMemoryStream(),
      first.handler,
    );
    expect(first.writes).toEqual(["notes.md"]);
    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("A");

    // Somebody changes the file. This is the ordinary situation the REPL is
    // built for: the recorded result says `A` was written, and the file says
    // `B`, and both are true.
    yield* writeTextFile(join(fixture.checkout, "notes.md"), "B");

    const again = counted();
    const replayed = yield* run(
      fixture,
      '<File path="notes.md">A</File>\n',
      new InMemoryStream([...events]),
      again.handler,
    );

    // Replayed: no write, no refusal, and the file still holds what the person
    // put there. Nothing was restored and nothing was compared.
    expect(replayed.refusal).toBeUndefined();
    expect(again.writes).toEqual([]);
    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("B");
    expect(source.length).toBeGreaterThan(0);
  });

  it("R3: a completed result replays when its checkout is no longer there", function* () {
    const fixture = yield* useFixture();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
    );

    // The checkout is gone: not moved, not changed — removed. Replay neither
    // puts it back nor looks at it.
    yield* rm(join(fixture.checkout, "notes.md"), { force: true });
    yield* rm(join(fixture.checkout, ".git"), { recursive: true, force: true });

    const again = counted();
    const replayed = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream([...events]),
      again.handler,
    );
    expect(replayed.refusal).toBeUndefined();
    expect(again.writes).toEqual([]);
    expect(yield* exists(join(fixture.checkout, ".git"))).toBe(false);
  });

  it("R4: an unacknowledged write is attempted again on the ordinary live path", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
      first.handler,
    );
    expect(first.writes).toEqual(["notes.md"]);

    // The journal with that write's result taken off the end: native work that
    // happened and was never acknowledged. There is no completion to replay, so
    // the ordinary live path runs it — which may write again. That is normal
    // durable-stream behaviour, and it is the window this host trades for not
    // snapshotting anybody's checkout.
    yield* rm(join(fixture.checkout, "notes.md"));
    const resumed = counted();
    const continued = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      interrupted(events),
      resumed.handler,
    );

    expect(continued.refusal).toBeUndefined();
    expect(resumed.writes).toEqual(["notes.md"]);
    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("the note\n");
  });

  it("R4: a new commit takes the index and the identity it finds", function* () {
    const fixture = yield* useFixture();
    const source = [
      '<File path="one.md">one</File>',
      '<Git.Add paths="one.md" />',
      '<Git.Commit message="One" as="commit" />',
      "",
      "committed {commit.commit}",
    ].join("\n");
    const { events, output } = yield* run(fixture, source, new InMemoryStream());
    expect(output).toContain("committed ");

    const results = recordsOf(events, REPL_REPOSITORY_RESULT).map((record) =>
      parseReplRepositoryResult(record),
    );
    const commit = results.find((record) => record?.operation === "commit");
    // The ordinary live result: what the commit actually produced, read back
    // from Git rather than predicted before it.
    const held = commit?.result;
    const reported =
      held !== null && typeof held === "object" && !Array.isArray(held)
        ? String(Reflect.get(held, "commit") ?? "")
        : "";
    const git = gitSession(denoRepositoryHost(), fixture.checkout);
    expect(reported).toBe(yield* git.read(["rev-parse", "HEAD"], fixture.checkout));
    // And the request is the authored message, which is all it ever asked for.
    expect(commit?.request).toEqual({ cwd: fixture.checkout, message: "One\n" });
  });

  it("R4: a completed write replays with no native mutation at all", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
      first.handler,
    );

    const again = counted();
    const replayed = new InMemoryStream([...events]);
    yield* run(fixture, '<File path="notes.md">the note\n</File>\n', replayed, again.handler);

    expect(again.writes).toEqual([]);
    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("the note\n");
  });

  it("R4: a completed stage replays without running git add again", function* () {
    const fixture = yield* useFixture();
    const source = '<File path="notes.md">the note\n</File>\n\n<Git.Add paths="notes.md" />\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);

    const again = counted();
    yield* run(fixture, source, new InMemoryStream([...events]), again.handler);
    expect(again.writes).toEqual([]);
    expect(yield* readIndexPaths(fixture)).toContain("notes.md");
  });

  it("R6: an authored directory is retained, and the file inside it is its own work", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const { events } = yield* run(
      fixture,
      '<Dir path="notes">\n<File path="inside.md">nested\n</File>\n</Dir>\n',
      new InMemoryStream(),
      leaf.handler,
    );

    expect(yield* readTextFile(join(fixture.checkout, "notes", "inside.md"))).toBe("nested\n");

    const intents = recordsOf(events, REPL_REPOSITORY_RESULT).map((record) =>
      parseReplRepositoryResult(record),
    );
    // The selection, the directory, then the file: three operations, and the
    // file's is its own rather than the directory's.
    expect(intents.map((record) => record?.operation)).toEqual([
      "ambient",
      "dir-ensure",
      "file-write",
    ]);
    const ensure = intents[1];
    const write = intents[2];
    expect(ensure?.site.occurrence).not.toBe(write?.site.occurrence);
    // Each one records what it was asked for and what it produced, and the
    // file's record is about the file: the directory's holds no inventory of
    // what ended up inside it.
    expect(ensure?.request).toEqual({ cwd: fixture.checkout, path: "notes" });
    expect(ensure?.result).toEqual({ type: "dir-ensure" });
    expect(write?.request).toEqual({
      cwd: join(fixture.checkout, "notes"),
      path: "inside.md",
      content: "nested\n",
    });
  });

  it("R5: a switch that would overwrite local changes refuses before touching it", function* () {
    const fixture = yield* useFixture();
    const git = gitSession(denoRepositoryHost(), fixture.root);
    yield* git.run(["switch", "--create", "topic"], fixture.checkout);
    yield* writeTextFile(join(fixture.checkout, "seed.md"), "topic version\n");
    yield* git.run(["add", "seed.md"], fixture.checkout);
    yield* git.run(["commit", "-m", "topic"], fixture.checkout);
    yield* git.run(["switch", "main"], fixture.checkout);
    // A local change to the same file the other branch moved.
    yield* writeTextFile(join(fixture.checkout, "seed.md"), "mine\n");

    const { events } = yield* refused(fixture, '<Git.Switch branch="topic" />\n');

    // The refusal happened before the checkout moved, and nothing was forced.
    expect(yield* git.read(["symbolic-ref", "HEAD"], fixture.checkout)).toBe("refs/heads/main");
    expect(yield* readTextFile(join(fixture.checkout, "seed.md"))).toBe("mine\n");
    // Nothing was recorded as a result for an operation that refused: the
    // refusal is the ordinary one this provider has always reported, journaled
    // as the effect failure it is rather than as an outcome this host stands
    // behind.
    expect(
      recordsOf(events, REPL_REPOSITORY_RESULT)
        .map((record) => parseReplRepositoryResult(record)?.operation)
        .filter((operation) => operation === "switch"),
    ).toEqual([]);
  });

  it("R4: a partly created destination is preserved and refused", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    // The slot this document's own request derives, holding a checkout
    // directory with no metadata beside it: exactly what an interrupted clone
    // leaves, because metadata is written last. An unrelated directory
    // somewhere under the root would prove nothing — the entry would never
    // look at it.
    const slot = repositorySlot(join(fixture.root, "managed"), remote.locator, "project");
    yield* ensureDir(join(slot, "checkout"));
    yield* writeTextFile(join(slot, "checkout", "half.md"), "half\n");

    const attempted = yield* runCounting(
      fixture,
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
        "nothing\n</Repository>\n",
      new InMemoryStream(),
    );

    // Refused, and the half-made directory is exactly as it was: no clone into
    // it, no metadata written beside it, no record of work on it.
    expect(attempted.refusal).toBeDefined();
    expect(yield* readTextFile(join(slot, "checkout", "half.md"))).toBe("half\n");
    expect(yield* exists(join(slot, METADATA))).toBe(false);
    expect(targetCommands(attempted.counters, "clone", join(slot, "checkout"))).toEqual([]);
    expect(recordsOf(attempted.events, REPL_REPOSITORY_RESULT)).toEqual([]);
  });

  it("R5: a refused acknowledgement creates nothing at all", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    // This feature's own intent is what the journal refuses, and nothing else
    // — a stream that refused every append could fail on the root or an
    // import before the creation ever reached its barrier, and the assertions
    // below would hold without the fence being tested at all.
    const stream = new InMemoryStream();
    let reached = 0;
    stream.onAppend = (event) => {
      if (event.type === "yield" && event.description.type === REPL_REPOSITORY_RESULT) {
        reached += 1;
        throw new Error("the journal refused this entry's creation intent");
      }
    };

    const slot = repositorySlot(join(fixture.root, "managed"), remote.locator, "project");
    const attempted = yield* runCounting(
      fixture,
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
        "nothing\n</Repository>\n",
      stream,
    );

    // The barrier was reached once, and the entry ended there: a durability
    // failure is fatal, and no later work in the document ran.
    expect(reached).toBe(1);
    expect(attempted.refusal).toBeDefined();
    // Nothing was written down, because the append is what failed.
    expect(recordsOf(attempted.events, REPL_REPOSITORY_RESULT)).toEqual([]);
    // And what the native work left is left: the clone it had already made is
    // still there, unrolled back and unclaimed. This host promises that later
    // work stops, not that the filesystem is put back — and the person is told
    // rather than shown a checkout nothing accounts for.
    expect(yield* exists(join(slot, "checkout"))).toBe(true);
    expect(targetCommands(attempted.counters, "clone", join(slot, "checkout"))).toHaveLength(1);
  });

  it("R5: a printable refusal is written down, and replays as a refusal", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const refusing: FilesHandler = {
      ...leaf.handler,
      *writeTextFile(input) {
        if (input.path === "refused.md") {
          return Err(fileWriteFailure({ phase: "target", reason: "read-only" }));
        }
        return yield* leaf.handler.writeTextFile(input);
      },
    };
    const source =
      '<PrintErrors>\n<File path="refused.md">no\n</File>\n</PrintErrors>\n\n' +
      '<File path="after.md">after\n</File>\n';
    const first = yield* run(fixture, source, new InMemoryStream(), refusing);
    expect(first.output).toContain("read-only");
    expect(yield* readTextFile(join(fixture.checkout, "after.md"))).toBe("after\n");

    // The refusal is settled, not left hanging: the write that follows it
    // advances the same shared directory, and a history with an unresolved
    // mutation behind it could not be reopened.
    const owner = parseReplRepositoryResult(
      recordsOf(first.events, REPL_REPOSITORY_RESULT)[0],
    )?.owner;
    expect(owner).toBeDefined();
    const admitted = yield* admitRetainedRepositoryHistory(first.events, owner!);
    expect(admitted.ok ? "ok" : admitted.error.message).toBe("ok");

    // And replaying it answers the same way, without asking the provider for
    // anything: a refusal reported as a success would be a write the document
    // was told happened.
    const again = counted();
    const replayed = yield* run(fixture, source, new InMemoryStream([...first.events]), {
      ...again.handler,
      // deno-lint-ignore require-yield
      *writeTextFile(input) {
        throw new Error(`nothing should be written on a replay, and ${input.path} was`);
      },
    });
    expect(replayed.output).toContain("read-only");
    expect(again.writes).toEqual([]);
  });

  it("R6: a generated write inside the checkout is retained on captured terms", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const fragment = '<File path="generated.md">generated\n</File>\n';
    const { events } = yield* run(
      fixture,
      '<File path="authored.md">authored\n</File>\n\n' +
        `<Evaluate text={${JSON.stringify(fragment)}} allow={["write"]} />\n`,
      new InMemoryStream(),
      leaf.handler,
      "0001",
      true,
    );

    expect(yield* readTextFile(join(fixture.checkout, "generated.md"))).toBe("generated\n");

    const intents = recordsOf(events, REPL_REPOSITORY_RESULT).map((record) =>
      parseReplRepositoryResult(record),
    );
    expect(intents.map((record) => record?.operation)).toEqual([
      "ambient",
      "file-write",
      "file-write",
    ]);
    const authored = intents[1];
    const generated = intents[2];
    // One name, two occurrences: the fragment's write is its own effect.
    expect(generated?.site.occurrence).not.toBe(authored?.site.occurrence);
    expect(generated?.request).toEqual({
      cwd: fixture.checkout,
      path: "generated.md",
      content: "generated\n",
    });
    // It followed the authored write in the journal's own order, which is the
    // only order there is: nothing numbers these records.
    expect(intents.map((record) => record?.operation)).toEqual([
      "ambient",
      "file-write",
      "file-write",
    ]);
  });

  it("R6: a completed generated write replays with no native mutation", function* () {
    const fixture = yield* useFixture();
    const fragment = '<File path="generated.md">generated\n</File>\n';
    const source = `<Evaluate text={${JSON.stringify(fragment)}} allow={["write"]} />\n`;
    const { events } = yield* run(
      fixture,
      source,
      new InMemoryStream(),
      counted().handler,
      "0001",
      true,
    );

    const again = counted();
    yield* run(fixture, source, new InMemoryStream([...events]), again.handler, "0001", true);
    expect(again.writes).toEqual([]);
    expect(yield* readTextFile(join(fixture.checkout, "generated.md"))).toBe("generated\n");
  });

  it("R12: a fixed batch costs its own requests and nothing of the checkout", function* () {
    const fixture = yield* useFixture();
    // A directory this entry never touches, holding content nothing it records
    // may mention. The point of the batch is what *is* in the journal: a
    // recovery protocol would have put all of this in it.
    yield* ensureDir(join(fixture.checkout, "ignored"));
    for (let at = 0; at < 20; at += 1) {
      yield* writeTextFile(
        join(fixture.checkout, "ignored", `noise-${at}.md`),
        `unrelated content number ${at}, which belongs to nobody's history\n`,
      );
    }

    // The fixed batch: five authored writes in two directories, then one
    // staging of all of it. Small, and the same both ways.
    const batch = [
      '<Dir path="notes">',
      '<File path="one.md">one</File>',
      '<File path="two.md">two</File>',
      "</Dir>",
      '<Dir path="more">',
      '<File path="three.md">three</File>',
      '<File path="four.md">four</File>',
      "</Dir>",
      '<File path="five.md">five</File>',
      '<Git.Add paths="." />',
      "",
    ].join("\n");

    const started = Date.now();
    const entry = yield* runCounting(fixture, batch, new InMemoryStream());
    const elapsed = Date.now() - started;
    expect(entry.refusal).toBeUndefined();

    // Every byte this entry wrote down, and what it is about.
    const journal = entry.events.map((event) => JSON.stringify(event)).join("\n");
    const results = recordsOf(entry.events, REPL_REPOSITORY_RESULT).map((record) =>
      parseReplRepositoryResult(record),
    );
    // One record per operation: the ambient selection, two directories, five
    // writes and the stage. Nothing else was recorded.
    expect(results.map((record) => record?.operation)).toEqual([
      "ambient",
      "dir-ensure",
      "file-write",
      "file-write",
      "dir-ensure",
      "file-write",
      "file-write",
      "file-write",
      "add",
    ]);
    // And nothing in any of them is about a file this entry did not write.
    expect(journal).not.toContain("unrelated content number");
    expect(journal).not.toContain("noise-");

    // No recovery work at all: nothing cloned or copied for a prediction, and
    // no scan of the checkout per mutation. The Git this batch runs is the
    // ambient discovery and the stage it was asked for.
    expect(entry.counters.commands.filter((command) => command[0] === "clone")).toEqual([]);
    const scans = entry.counters.commands.filter((command) =>
      ["ls-files", "status", "hash-object", "diff"].includes(String(command[0])),
    );
    expect(scans.length).toBeLessThanOrEqual(2);

    // The same batch through the ordinary provider, for the comparison this
    // row reports rather than asserts. No budget is invented here: the numbers
    // are evidence, and what gates the revision is the structure above.
    const ordinary = yield* useFixture();
    yield* ensureDir(join(ordinary.checkout, "ignored"));
    const ordinaryStarted = Date.now();
    const plain = yield* runOrdinary(ordinary, batch);
    const ordinaryElapsed = Date.now() - ordinaryStarted;
    expect(plain).toBeUndefined();

    console.log(
      JSON.stringify({
        batch: { directories: 2, writes: 5, stages: 1, unrelatedFiles: 20 },
        repl: { milliseconds: elapsed, journalBytes: journal.length, records: results.length },
        ordinary: { milliseconds: ordinaryElapsed },
      }),
    );
  });

  it("R6: a write where there is no repository is ordinary and retains nothing", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    // The entry starts outside any checkout. Nothing selects one, so the write
    // is the ordinary filesystem behavior it would have had without this host.
    const { events } = yield* run(
      { root: fixture.root, checkout: join(fixture.root, "plain") },
      '<File path="outside.md">outside\n</File>\n',
      new InMemoryStream(),
      leaf.handler,
    );

    expect(yield* exists(join(fixture.root, "plain", "outside.md"))).toBe(true);
    expect(leaf.writes).toEqual(["outside.md"]);
    // No record of the write, and no selection either: an entry standing
    // outside every checkout selects nothing, so there is nothing for a record
    // to be about.
    expect(
      recordsOf(events, REPL_REPOSITORY_RESULT).map(
        (record) => parseReplRepositoryResult(record)?.operation,
      ),
    ).toEqual([]);
  });
});
