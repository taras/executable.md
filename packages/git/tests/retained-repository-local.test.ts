/**
 * R3–R6 — one entry's retained repository work, against real Git and real files.
 *
 * Everything here runs a document through canonical execution with the entry
 * host installed, so what is proven is the whole path: core delivers the
 * occurrence, the host retains an intent, native work happens, and the
 * completion is written only once the result and the resulting state have both
 * been checked. A fixture that asserted on the protocol without the filesystem
 * would prove the bookkeeping and nothing about the checkout.
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
import { API, fileWriteFailure, filesFailure, hostFilesHandler } from "@executablemd/runtime";
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
import {
  RETAINED_REPOSITORY_COMPLETION,
  RETAINED_REPOSITORY_INTENT,
  parseRetainedCreationPreparation,
  parseRetainedRepositoryCompletion,
  parseRetainedRepositoryIntent,
  retainedFrontierJson,
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
}

/** One entry, over one journal, in one checkout. */
function run(
  fixture: Fixture,
  source: string,
  stream: InMemoryStream,
  leaf: FilesHandler,
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
    const output = yield* collect(
      yield* executeInstalled({ path, stream, includes: [fixture.root] }, [installation]),
    );
    return { output: String(output), events: yield* stream.readAll() };
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

/** A journal with its last completion removed: one interrupted mutation. */
function interrupted(events: readonly DurableEvent[]): InMemoryStream {
  const last = events.findLastIndex(
    (event) => event.type === "yield" && event.description.type === RETAINED_REPOSITORY_COMPLETION,
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
      return { output: "", events: yield* stream.readAll() };
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
      return { output: "", events: yield* stream.readAll() };
    }
  });
}

describe("retained repository: one entry's local work", () => {
  it("R3: a write inside the ambient checkout retains an intent and a completion", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
      leaf.handler,
    );

    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("the note\n");
    expect(leaf.writes).toEqual(["notes.md"]);

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    const completions = recordsOf(events, RETAINED_REPOSITORY_COMPLETION).map((record) =>
      parseRetainedRepositoryCompletion(record),
    );
    // Selecting the checkout is itself retained, and it is the baseline the
    // write is held to following.
    expect(intents.map((record) => record?.operation)).toEqual(["ambient", "file-write"]);
    expect(intents.map((record) => record?.lane.position)).toEqual([0, 1]);
    expect(completions.length).toBe(2);

    const intent = intents[1];
    const completion = completions[1];
    expect(intent?.operation).toBe("file-write");
    expect(intent?.owner).toBe('repl:v1:["execution-1","0001"]');
    // The state it started from had no such file, and the one it predicted does.
    expect(intent?.preState?.worktree.some((entry) => entry.path === "notes.md")).toBe(false);
    expect(intent?.postState.worktree.some((entry) => entry.path === "notes.md")).toBe(true);
    expect(completion?.intent.length).toBeGreaterThan(0);
    // What it left is what it predicted.
    expect(completion?.frontier.worktree.some((entry) => entry.path === "notes.md")).toBe(true);
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

  it("R4: an interrupted write performs from the state it saved", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
      first.handler,
    );
    // Put the checkout back where the intent says it started.
    yield* rm(join(fixture.checkout, "notes.md"));

    const resumed = counted();
    yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      interrupted(events),
      resumed.handler,
    );

    expect(resumed.writes).toEqual(["notes.md"]);
    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("the note\n");
  });

  it("R4: an interrupted write adopts the state it predicted", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
      first.handler,
    );
    // The file is already there: the interrupted write reached its far end.
    const adopted = counted();
    yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      interrupted(events),
      adopted.handler,
    );

    expect(adopted.writes).toEqual([]);
    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("the note\n");
  });

  it("R4: an interrupted write refuses a state it neither saved nor predicted", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n',
      new InMemoryStream(),
      first.handler,
    );
    // Somebody else has been in this checkout.
    yield* writeTextFile(join(fixture.checkout, "notes.md"), "somebody else\n");

    const drifted = counted();
    let refusal: string | undefined;
    try {
      yield* run(
        fixture,
        '<File path="notes.md">the note\n</File>\n',
        interrupted(events),
        drifted.handler,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    expect(refusal).toBeDefined();
    expect(drifted.writes).toEqual([]);
    // Nothing was repaired to make the replay succeed.
    expect(yield* readTextFile(join(fixture.checkout, "notes.md"))).toBe("somebody else\n");
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

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
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
    // The directory is in the state the ensure predicted, and the file is not.
    expect(ensure?.postState.worktree.some((entry) => entry.path === "notes")).toBe(true);
    expect(ensure?.postState.worktree.some((entry) => entry.path === "notes/inside.md")).toBe(
      false,
    );
    expect(write?.postState.worktree.some((entry) => entry.path === "notes/inside.md")).toBe(true);
  });

  it("R3: staging predicts the index it will leave and is checked against it", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const { events } = yield* run(
      fixture,
      '<File path="notes.md">the note\n</File>\n\n<Git.Add paths="notes.md" />\n',
      new InMemoryStream(),
      leaf.handler,
    );

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    expect(intents.map((record) => record?.operation)).toEqual(["ambient", "file-write", "add"]);
    const add = intents[2];
    // The file was not in the index before and is in the one it predicted.
    expect(add?.preState?.index.some((entry) => entry.path === "notes.md")).toBe(false);
    expect(add?.postState.index.some((entry) => entry.path === "notes.md")).toBe(true);

    // And that is the index Git actually produced.
    const staged = yield* readIndexPaths(fixture);
    expect(staged).toContain("notes.md");
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

  it("R3: a commit's object id is predicted before it is written", function* () {
    const fixture = yield* useFixture();
    const source =
      '<File path="notes.md">the note\n</File>\n\n' +
      '<Git.Add paths="notes.md" />\n\n<Git.Commit message="record the note" as="commit" />\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    expect(intents.map((record) => record?.operation)).toEqual([
      "ambient",
      "file-write",
      "add",
      "commit",
    ]);
    const commit = intents[3];
    const predicted =
      commit?.postState.head.kind === "symbolic" ? commit.postState.head.oid : undefined;
    expect(predicted).toBeDefined();

    // The commit Git actually wrote is the one the intent predicted.
    const git = gitSession(denoRepositoryHost(), fixture.root);
    expect(yield* git.read(["rev-parse", "HEAD"], fixture.checkout)).toBe(predicted);
    // And the parent it predicted is the commit the checkout was on.
    expect(commit?.preState?.head.kind === "symbolic" && commit.preState.head.oid).not.toBe(
      predicted,
    );
  });

  it("R4: an interrupted commit adopts the commit it predicted", function* () {
    const fixture = yield* useFixture();
    const source =
      '<File path="notes.md">the note\n</File>\n\n' +
      '<Git.Add paths="notes.md" />\n\n<Git.Commit message="record the note" as="commit" />\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const git = gitSession(denoRepositoryHost(), fixture.root);
    const head = yield* git.read(["rev-parse", "HEAD"], fixture.checkout);

    // The commit happened; its completion did not. A resume adopts it rather
    // than committing a second time.
    const resumed = yield* run(fixture, source, interrupted(events), counted().handler);
    expect(recordsOf(resumed.events, RETAINED_REPOSITORY_COMPLETION).length).toBeGreaterThan(0);
    expect(yield* git.read(["rev-parse", "HEAD"], fixture.checkout)).toBe(head);
    // One commit, not two.
    expect(yield* git.read(["rev-list", "--count", "HEAD"], fixture.checkout)).toBe("2");
  });

  it("R3: a switch predicts the branch and the content it will leave", function* () {
    const fixture = yield* useFixture();
    const git = gitSession(denoRepositoryHost(), fixture.root);
    // A second branch whose content differs, so the switch has something to do.
    yield* git.run(["switch", "--create", "topic"], fixture.checkout);
    yield* writeTextFile(join(fixture.checkout, "topic.md"), "topic\n");
    yield* git.run(["add", "topic.md"], fixture.checkout);
    yield* git.run(["commit", "-m", "topic"], fixture.checkout);
    yield* git.run(["switch", "main"], fixture.checkout);

    const { events } = yield* run(
      fixture,
      '<Git.Switch branch="topic" />\n',
      new InMemoryStream(),
      counted().handler,
    );

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    expect(intents.map((record) => record?.operation)).toEqual(["ambient", "switch"]);
    const moved = intents[1];
    expect(moved?.preState?.head.kind === "symbolic" && moved.preState.head.ref).toBe(
      "refs/heads/main",
    );
    expect(moved?.postState.head.kind === "symbolic" && moved.postState.head.ref).toBe(
      "refs/heads/topic",
    );
    // The content the other branch carries was predicted, not guessed.
    expect(moved?.preState?.worktree.some((entry) => entry.path === "topic.md")).toBe(false);
    expect(moved?.postState.worktree.some((entry) => entry.path === "topic.md")).toBe(true);

    // And that is where the checkout actually is.
    expect(yield* git.read(["symbolic-ref", "HEAD"], fixture.checkout)).toBe("refs/heads/topic");
    expect(yield* exists(join(fixture.checkout, "topic.md"))).toBe(true);
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
    // Nothing was retained for an operation that never started.
    expect(
      recordsOf(events, RETAINED_REPOSITORY_INTENT)
        .map((record) => parseRetainedRepositoryIntent(record)?.operation)
        .filter((operation) => operation === "switch"),
    ).toEqual([]);
  });

  it("R3: a repository creation records an absent destination before it clones", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const { events } = yield* run(
      fixture,
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
        '<File path="inside.md">inside\n</File>\n</Repository>\n',
      new InMemoryStream(),
      counted().handler,
    );

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    expect(intents.map((record) => record?.operation)).toEqual(["repository", "file-write"]);
    const creation = intents[0];
    // There was nothing there, and that is what the record says — not an empty
    // Git snapshot standing in for absence.
    expect(creation?.preState).toBe(null);
    // What makes it recoverable is everything else it froze.
    const prepared = creation?.prepared;
    expect(typeof prepared === "object" && prepared !== null && !Array.isArray(prepared)).toBe(
      true,
    );
    const creationData = prepared as {
      slot: string;
      metadata: Record<string, unknown>;
      owner: null;
    };
    expect(typeof creationData.slot).toBe("string");
    expect(creationData.owner).toBe(null);
    expect(creationData.metadata.kind).toBe("repository");
    expect(creationData.metadata.locator).toBe(remote.locator);
    expect(typeof creationData.metadata.creationCommit).toBe("string");
    // And the state it will be in when it is done, which the clone produced.
    expect(creation?.postState.worktree.some((entry) => entry.path === "remote.md")).toBe(true);
    expect(creation?.postState.administration.role).toBe("primary");
    // The write inside it follows in the same lane.
    expect(intents[1]?.lane.common).toBe(creation?.lane.common);
    expect(intents.map((record) => record?.lane.position)).toEqual([0, 1]);
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
      if (event.type === "yield" && event.description.type === RETAINED_REPOSITORY_INTENT) {
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

    // The barrier was reached once, and the entry ended there.
    expect(reached).toBe(1);
    expect(attempted.refusal).toBeDefined();
    expect(recordsOf(attempted.events, RETAINED_REPOSITORY_INTENT)).toEqual([]);
    // Nothing was created where it was asked for: no checkout, no metadata,
    // and no clone into the placement. Preparing one clones into a scratch
    // directory, which is why the destination is what is counted.
    expect(yield* exists(join(slot, "checkout"))).toBe(false);
    expect(yield* exists(join(slot, METADATA))).toBe(false);
    expect(targetCommands(attempted.counters, "clone", join(slot, "checkout"))).toEqual([]);
  });

  it("R4: an interrupted creation is adopted without cloning again", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      "nothing\n</Repository>\n";
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const intent = parseRetainedRepositoryIntent(recordsOf(events, RETAINED_REPOSITORY_INTENT)[0]);
    const completed = parseRetainedRepositoryCompletion(
      recordsOf(events, RETAINED_REPOSITORY_COMPLETION)[0],
    );
    expect(intent).toBeDefined();
    expect(completed).toBeDefined();
    const [created] = yield* checkoutPaths(fixture);
    expect(created).toBe(intent!.postState.checkout);

    // Nothing is changed first. Adoption is what this proves, and a checkout
    // with something extra in it is not the state the intent predicted — so a
    // resume that refused drift would pass an assertion about clones it never
    // reached.
    const resumed = yield* runCounting(fixture, source, interrupted(events));
    expect(resumed.refusal).toBeUndefined();
    // No clone ran at all: the destination was already what the intent
    // predicted, so there was nothing to prepare and nothing to perform.
    expect(resumed.counters.commands.filter((args) => args[0] === "clone")).toEqual([]);
    const adopted = parseRetainedRepositoryCompletion(
      recordsOf(resumed.events, RETAINED_REPOSITORY_COMPLETION)[0],
    );
    expect(adopted?.result).toEqual(completed!.result);
    expect(adopted === undefined ? undefined : retainedFrontierJson(adopted.frontier)).toEqual(
      retainedFrontierJson(intent!.postState),
    );
  });

  it("R4: a resumed creation uses its saved commit after the base moves", function* () {
    const fixture = yield* useFixture();
    // One remote, with somewhere for it to move to. The locator the document
    // wrote never changes — what changes is what it answers, which is the case
    // a pinned commit exists for.
    const remote = yield* useBareRemote({
      commits: [
        { message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] },
        {
          message: "moved on",
          branch: "next",
          entries: [{ path: "later.md", content: "later\n" }],
        },
      ],
    });
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      "nothing\n</Repository>\n";
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const intent = parseRetainedRepositoryIntent(recordsOf(events, RETAINED_REPOSITORY_INTENT)[0]);
    expect(intent).toBeDefined();
    const prepared = parseRetainedCreationPreparation(intent!.prepared, intent!.operation);
    expect(prepared).toBeDefined();
    const pinned = prepared!.metadata.creationCommit;
    const moved = remote.heads.get("next");
    expect(moved).toBeDefined();
    expect(moved).not.toBe(pinned);

    // The destination is removed so the resume has the absent state its intent
    // saved, and the branch the authored request names is moved on so a live
    // resolution would answer with a different commit.
    yield* rm(prepared!.slot, { recursive: true, force: true });
    const git = gitSession(denoRepositoryHost(), fixture.root);
    expect((yield* git.run(["update-ref", "refs/heads/main", moved!], remote.locator)).code).toBe(
      0,
    );

    const resumed = yield* runCounting(fixture, source, interrupted(events));
    expect(resumed.refusal).toBeUndefined();
    // The checkout exists, and it is at the commit the intent pinned rather
    // than at what the locator now answers.
    expect(yield* git.read(["rev-parse", "HEAD"], intent!.postState.checkout)).toBe(pinned);
    const completed = parseRetainedRepositoryCompletion(
      recordsOf(resumed.events, RETAINED_REPOSITORY_COMPLETION)[0],
    );
    expect(completed?.frontier.head.oid).toBe(pinned);
    // Exactly the state the intent predicted, remote-tracking refs included: a
    // creation establishes the refs it froze rather than keeping whatever the
    // remote advertised by the time the clone ran.
    expect(completed === undefined ? undefined : retainedFrontierJson(completed.frontier)).toEqual(
      retainedFrontierJson(intent!.postState),
    );
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
    expect(recordsOf(attempted.events, RETAINED_REPOSITORY_INTENT)).toEqual([]);
  });

  it("R3: a worktree creation freezes its owner's two states as well", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const { events } = yield* run(
      fixture,
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
        '<Worktree name="review" branch="topic">\n' +
        '<File path="in-worktree.md">worktree\n</File>\n' +
        "</Worktree>\n</Repository>\n",
      new InMemoryStream(),
      counted().handler,
    );

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    expect(intents.map((record) => record?.operation)).toEqual([
      "repository",
      "worktree",
      "file-write",
    ]);
    const worktree = intents[1];
    expect(worktree?.preState).toBe(null);
    // A linked worktree is its own checkout sharing the repository's
    // administration, and the record says so before it exists.
    expect(worktree?.postState.administration.role).toBe("linked");
    expect(worktree?.postState.administration.common).toBe(
      intents[0]?.postState.administration.common,
    );
    // Adding it advances refs the owner shares, so the owner's own two states
    // are frozen beside it.
    const prepared = parseRetainedCreationPreparation(
      worktree?.prepared ?? null,
      worktree?.operation ?? "worktree",
    );
    expect(prepared?.owner).not.toBe(null);
    expect(prepared?.owner?.postState.refs.some((ref) => ref.name === "refs/heads/topic")).toBe(
      true,
    );
    expect(prepared?.owner?.preState.refs.some((ref) => ref.name === "refs/heads/topic")).toBe(
      false,
    );
    // The file was written in the worktree, not in the repository.
    expect(intents[2]?.preState?.checkout).toBe(worktree?.postState.checkout);
  });

  it("R3/R4: a drifted owner refuses a pending worktree creation before it is added", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      '<Worktree name="review" branch="topic">\nnothing\n</Worktree>\n</Repository>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    const worktree = intents[1];
    expect(worktree?.operation).toBe("worktree");
    const prepared = parseRetainedCreationPreparation(
      worktree?.prepared ?? null,
      worktree?.operation ?? "worktree",
    );
    expect(prepared?.owner).not.toBe(null);

    // The destination goes away, so the resume finds the absence its intent
    // saved — and the owner is moved on, so the other half of the pair is no
    // longer the state the creation started from. One match is not the pair.
    const owner = intents[0]?.postState.checkout ?? "";
    const git = gitSession(denoRepositoryHost(), fixture.root);
    expect(
      (yield* git.run(["worktree", "remove", "--force", worktree!.postState.checkout], owner)).code,
    ).toBe(0);
    expect((yield* git.run(["branch", "-D", "topic"], owner)).code).toBe(0);
    yield* rm(prepared!.slot, { recursive: true, force: true });
    yield* writeTextFile(join(owner, "drift.md"), "the owner moved on\n");

    const resumed = yield* runCounting(fixture, source, interrupted(events));
    expect(resumed.refusal).toBeDefined();
    // Nothing was added: no worktree at the destination, and the owner still
    // has no branch for it.
    expect(yield* exists(worktree!.postState.checkout)).toBe(false);
    expect(yield* git.read(["rev-parse", "--verify", "refs/heads/topic"], owner)).toBe(undefined);
    expect(targetCommands(resumed.counters, "worktree", worktree!.postState.checkout)).toEqual([]);
  });

  it("R3: a new mutation refuses a checkout its own history cannot account for", function* () {
    const fixture = yield* useFixture();
    const source =
      '<File path="first.md">first\n</File>\n\n<File path="second.md">second\n</File>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    // Keep everything up to the second write's own intent: its predecessor is
    // complete, and the tail mutation has not been attempted.
    const intents = events.filter(
      (event) => event.type === "yield" && event.description.type === RETAINED_REPOSITORY_INTENT,
    );
    const tail = events.indexOf(intents[intents.length - 1]!);
    expect(tail).toBeGreaterThan(0);
    yield* rm(join(fixture.checkout, "second.md"), { force: true });

    // Something this history never recorded. The completed prefix still
    // replays, but the state the new mutation would start from is not one the
    // history accounts for, so it is not a state to freeze and build on.
    yield* writeTextFile(join(fixture.checkout, "outside.md"), "nobody recorded this\n");

    const leaf = counted();
    let refusal: string | undefined;
    try {
      yield* run(fixture, source, new InMemoryStream([...events.slice(0, tail)]), leaf.handler);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBeDefined();
    expect(leaf.writes).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "second.md"))).toBe(false);
  });

  it("R5: a refusal that changed nothing is printed, and the entry goes on", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const refusing: FilesHandler = {
      ...leaf.handler,
      *writeTextFile(input) {
        if (input.path === "refused.md") {
          // A refusal in the closed write vocabulary, at a phase whose target
          // is `unchanged`. Its own words say the file was not replaced, and
          // the checkout bears that out — which is what makes it printable.
          return Err(fileWriteFailure({ phase: "target", reason: "read-only" }));
        }
        return yield* leaf.handler.writeTextFile(input);
      },
    };
    const { output } = yield* run(
      fixture,
      '<PrintErrors>\n<File path="refused.md">no\n</File>\n</PrintErrors>\n\n' +
        '<File path="after.md">after\n</File>\n',
      new InMemoryStream(),
      refusing,
    );
    expect(output).toContain("read-only");
    expect(yield* exists(join(fixture.checkout, "refused.md"))).toBe(false);
    // The entry carried on, because nothing it recorded disagrees with the
    // disk.
    expect(yield* readTextFile(join(fixture.checkout, "after.md"))).toBe("after\n");
  });

  it("R5: PrintErrors cannot print away a failure that left the checkout changed", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const halfway: FilesHandler = {
      ...leaf.handler,
      *writeTextFile(input) {
        if (input.path === "halfway.md") {
          // The bytes land and the write reports a failure whose own target is
          // `commit-unknown`: the outcome the journal holds no longer
          // describes the checkout, and nothing here can say which way it
          // went.
          yield* leaf.handler.writeTextFile(input);
          return Err(fileWriteFailure({ phase: "commit", reason: "no-space" }));
        }
        return yield* leaf.handler.writeTextFile(input);
      },
    };
    let refusal: string | undefined;
    try {
      yield* run(
        fixture,
        '<PrintErrors>\n<File path="halfway.md">half\n</File>\n</PrintErrors>\n\n' +
          '<File path="after.md">after\n</File>\n',
        new InMemoryStream(),
        halfway,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBeDefined();
    // `<PrintErrors>` encloses the failing write, and the entry still ends
    // there: the later file is never written.
    expect(yield* exists(join(fixture.checkout, "after.md"))).toBe(false);
  });

  it("R4/R5: a commit writes no object into the checkout before its intent stands", function* () {
    const fixture = yield* useFixture();
    const stream = new InMemoryStream();
    let reached = 0;
    // The commit's own intent, and nothing else this entry writes: the file
    // write and the staging before it are acknowledged normally, so what the
    // assertions below are about is the barrier this one operation reached.
    stream.onAppend = (event) => {
      if (event.type !== "yield" || event.description.type !== RETAINED_REPOSITORY_INTENT) {
        return;
      }
      if (event.result.status !== "ok") {
        return;
      }
      if (parseRetainedRepositoryIntent(event.result.value ?? null)?.operation !== "commit") {
        return;
      }
      reached += 1;
      throw new Error("the journal refused this entry's commit intent");
    };
    const git = gitSession(denoRepositoryHost(), fixture.root);
    const before = yield* git.read(["rev-parse", "HEAD"], fixture.checkout);

    const attempted = yield* runCounting(
      fixture,
      '<File path="staged.md">staged\n</File>\n\n<Git.Add paths="staged.md" />\n\n' +
        '<Git.Commit message="predicted" as="commit" />\n',
      stream,
    );

    expect(reached).toBe(1);
    expect(attempted.refusal).toBeDefined();
    // The commit was predicted in a copy of the administration, so the
    // checkout's own HEAD never moved and no commit of its own was written.
    expect(yield* git.read(["rev-parse", "HEAD"], fixture.checkout)).toBe(before);
  });

  it("R3: a completed entry authenticates its checkout before answering again", function* () {
    const fixture = yield* useFixture();
    const source = '<File path="one.md">one\n</File>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);

    // Every mutation this entry made is resolved, so there is nothing to
    // perform and nothing to prepare — only results to answer with. What has
    // changed is the file it wrote, which nothing in this history accounts
    // for, and answering anyway would be answering about a checkout that is
    // not the one these records describe.
    const complete = events.findLastIndex(
      (event) =>
        event.type === "yield" && event.description.type === RETAINED_REPOSITORY_COMPLETION,
    );
    expect(complete).toBeGreaterThan(0);
    yield* writeTextFile(join(fixture.checkout, "one.md"), "somebody else\n");

    const leaf = counted();
    let refusal: string | undefined;
    try {
      yield* run(
        fixture,
        source,
        new InMemoryStream([...events.slice(0, complete + 1)]),
        leaf.handler,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBeDefined();
    expect(leaf.writes).toEqual([]);
    // Left exactly as it was found: refusing is what preserves it.
    expect(yield* readTextFile(join(fixture.checkout, "one.md"))).toBe("somebody else\n");
  });

  it("R4: each new mutation builds on what the last one was acknowledged to leave", function* () {
    const fixture = yield* useFixture();
    const source =
      '<File path="first.md">first\n</File>\n\n<File path="second.md">second\n</File>\n\n' +
      '<File path="third.md">third\n</File>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const intents = events.filter(
      (event) => event.type === "yield" && event.description.type === RETAINED_REPOSITORY_INTENT,
    );
    // Everything up to the second write's own intent: one completed mutation,
    // and two still to make.
    const tail = events.indexOf(intents[intents.length - 2]!);
    expect(tail).toBeGreaterThan(0);
    yield* rm(join(fixture.checkout, "second.md"), { force: true });
    yield* rm(join(fixture.checkout, "third.md"), { force: true });

    const leaf = counted();
    const resumed = yield* run(
      fixture,
      source,
      new InMemoryStream([...events.slice(0, tail)]),
      leaf.handler,
    );
    // Both performed. The second mutation starts from the state the history
    // established, and the third from the state the second one was
    // acknowledged to have left — not from the snapshot the entry opened with.
    expect(leaf.writes).toEqual(["second.md", "third.md"]);
    expect(yield* readTextFile(join(fixture.checkout, "third.md"))).toBe("third\n");
    const owner = parseRetainedRepositoryIntent(
      recordsOf(resumed.events, RETAINED_REPOSITORY_INTENT)[0],
    )?.owner;
    expect(owner).toBeDefined();
    const admitted = yield* admitRetainedRepositoryHistory(resumed.events, owner!);
    expect(admitted.ok ? "ok" : admitted.error.message).toBe("ok");
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
    const owner = parseRetainedRepositoryIntent(
      recordsOf(first.events, RETAINED_REPOSITORY_INTENT)[0],
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

  it("R5: a changed-state directory failure cannot be printed away", function* () {
    const fixture = yield* useFixture();
    const leaf = counted();
    const halfway: FilesHandler = {
      ...leaf.handler,
      *ensureDirectory(input) {
        const made = yield* leaf.handler.ensureDirectory(input);
        if (!made.ok) {
          return made;
        }
        // The directory is there and the ensure reports failure anyway.
        return Err(
          filesFailure({
            operation: "ensure-directory",
            phase: "access",
            reason: "permission-denied",
          }),
        );
      },
    };
    let refusal: string | undefined;
    try {
      yield* run(
        fixture,
        '<PrintErrors>\n<Dir path="nested">nothing\n</Dir>\n</PrintErrors>\n\n' +
          '<File path="after.md">after\n</File>\n',
        new InMemoryStream(),
        halfway,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    // `<Dir>` reports what a document could not use, and a durability failure
    // is not that: it keeps its own class, so the later file is never written.
    expect(yield* exists(join(fixture.checkout, "nested"))).toBe(true);
    expect(leaf.writes).toEqual([]);
    // The failure the entry ends on is the one the coordinator raised, not a
    // sentence about a directory a document could not use. An adapter that
    // described it that way would be describing a durability failure as
    // something to print and carry on past.
    expect(refusal).toContain("dir-ensure");
    expect(refusal).not.toContain("could not be used");
  });

  it("R3: a commit in a linked worktree is predicted from that worktree's index", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const prefix =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      '<Worktree name="review" branch="topic">\n';
    const setup = yield* run(
      fixture,
      `${prefix}nothing\n</Worktree>\n</Repository>\n`,
      new InMemoryStream(),
      counted().handler,
    );
    const creation = recordsOf(setup.events, RETAINED_REPOSITORY_INTENT)
      .map((record) => parseRetainedRepositoryIntent(record))
      .find((record) => record?.operation === "worktree");
    expect(creation).toBeDefined();
    const target = creation!.postState.checkout;
    const owner = recordsOf(setup.events, RETAINED_REPOSITORY_INTENT)
      .map((record) => parseRetainedRepositoryIntent(record))
      .find((record) => record?.operation === "repository")!.postState.checkout;
    const git = gitSession(denoRepositoryHost(), fixture.root);
    yield* git.run(["config", "user.name", "Retained"], target);
    yield* git.run(["config", "user.email", "retained@example.com"], target);
    const before = yield* git.read(["rev-parse", "HEAD"], owner);

    const { events } = yield* run(
      fixture,
      `${prefix}<File path="new.md">new\n</File>\n<Git.Add paths="new.md" />\n` +
        '<Git.Commit message="linked work" as="commit" />\n</Worktree>\n</Repository>\n',
      new InMemoryStream(),
      counted().handler,
      "0002",
    );

    // The commit exists in the worktree, holds the file staged there, and the
    // primary checkout — whose own index was clean — has not moved. A
    // prediction pointed at the shared administration would have computed the
    // primary's tree and found nothing to commit.
    const commits = recordsOf(events, RETAINED_REPOSITORY_INTENT)
      .map((record) => parseRetainedRepositoryIntent(record))
      .filter((record) => record?.operation === "commit");
    expect(commits.length).toBe(1);
    expect(yield* git.read(["show", "HEAD:new.md"], target)).toBe("new");
    expect(yield* git.read(["log", "-1", "--format=%s"], target)).toBe("linked work");
    expect(yield* git.read(["rev-parse", "HEAD"], owner)).toBe(before);
    // The commit that was written is the commit the intent predicted.
    expect(yield* git.read(["rev-parse", "HEAD"], target)).toBe(commits[0]!.postState.head.oid);
  });

  it("R3: a managed checkout is authenticated before its results are replayed", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      '<File path="one.md">one\n</File>\n</Repository>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const created = recordsOf(events, RETAINED_REPOSITORY_INTENT)
      .map((record) => parseRetainedRepositoryIntent(record))
      .find((record) => record?.operation === "repository");
    expect(created).toBeDefined();
    const complete = events.findLastIndex(
      (event) =>
        event.type === "yield" && event.description.type === RETAINED_REPOSITORY_COMPLETION,
    );
    expect(complete).toBeGreaterThan(0);

    // The managed checkout this entry created, changed by something else. Its
    // own records are complete and would replay without reading a byte — and
    // a selection replaying its acknowledgement is not a reason to believe the
    // checkout is still what the history describes.
    yield* writeTextFile(join(created!.postState.checkout, "one.md"), "external drift\n");

    const leaf = counted();
    let refusal: string | undefined;
    try {
      yield* run(
        fixture,
        source,
        new InMemoryStream([...events.slice(0, complete + 1)]),
        leaf.handler,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBeDefined();
    expect(leaf.writes).toEqual([]);
    // And what was there is still there: refusing is what preserves it.
    expect(yield* readTextFile(join(created!.postState.checkout, "one.md"))).toBe(
      "external drift\n",
    );
  });

  it("R3: a managed checkout is authenticated when it is selected, not when it is used", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    // Nothing in this document writes inside the managed checkout: it selects
    // the repository and then works in the checkout the entry started in. So
    // the only thing that ever looks at the managed checkout is its own
    // selection, which is where this entry has to look.
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      "nothing\n</Repository>\n\n" +
      '<File path="outside.md">outside\n</File>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const created = recordsOf(events, RETAINED_REPOSITORY_INTENT)
      .map((record) => parseRetainedRepositoryIntent(record))
      .find((record) => record?.operation === "repository");
    expect(created).toBeDefined();
    // The checkout this entry started in is left exactly as its own history
    // describes it, so the only thing out of place is in the managed one.
    expect(yield* readTextFile(join(fixture.checkout, "outside.md"))).toBe("outside\n");

    // The cloned file in the managed checkout, changed by something else.
    yield* writeTextFile(join(created!.postState.checkout, "remote.md"), "somebody else\n");

    const complete = events.findLastIndex(
      (event) =>
        event.type === "yield" && event.description.type === RETAINED_REPOSITORY_COMPLETION,
    );
    const leaf = counted();
    let refusal: string | undefined;
    try {
      yield* run(
        fixture,
        source,
        new InMemoryStream([...events.slice(0, complete + 1)]),
        leaf.handler,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBeDefined();
    // And the work that came after the selection never ran: the write replays
    // from its records, and a replay writes nothing.
    expect(leaf.writes).toEqual([]);
  });

  it("R4: a replayed selection's own snapshot is not what the next write is held to", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    // The commit inside the worktree moves a branch the repository checkout
    // shares, so the state the repository's own selection recorded is already
    // out of date by the time the last write happens. That selection is
    // replayed on a resume, and what it recorded is a state this checkout was
    // in once — not the state the next write starts from.
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      '<Worktree name="review" branch="topic">\n<File path="in-worktree.md">work\n</File>\n' +
      '<Git.Add paths="in-worktree.md" />\n' +
      '<Git.Commit message="worktree work" as="commit" />\n</Worktree>\n\n' +
      '<File path="later.md">later\n</File>\n</Repository>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const records = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
    );
    const repository = records.find((record) => record?.operation === "repository");
    expect(repository).toBeDefined();
    expect(records.some((record) => record?.operation === "commit")).toBe(true);
    const intents = events.filter(
      (event) => event.type === "yield" && event.description.type === RETAINED_REPOSITORY_INTENT,
    );
    const tail = events.indexOf(intents[intents.length - 1]!);
    expect(tail).toBeGreaterThan(0);
    yield* rm(join(repository!.postState.checkout, "later.md"), { force: true });

    const leaf = counted();
    const resumed = yield* run(
      fixture,
      source,
      new InMemoryStream([...events.slice(0, tail)]),
      leaf.handler,
    );
    expect(leaf.writes).toEqual(["later.md"]);
    expect(yield* readTextFile(join(repository!.postState.checkout, "later.md"))).toBe("later\n");
    const admitted = yield* admitRetainedRepositoryHistory(resumed.events, repository!.owner);
    expect(admitted.ok ? "ok" : admitted.error.message).toBe("ok");
  });

  it("R3: a managed checkout this entry established cannot have gone", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      "nothing\n</Repository>\n\n" +
      '<File path="outside.md">outside\n</File>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const created = recordsOf(events, RETAINED_REPOSITORY_INTENT)
      .map((record) => parseRetainedRepositoryIntent(record))
      .find((record) => record?.operation === "repository");
    expect(created).toBeDefined();
    const prepared = parseRetainedCreationPreparation(created!.prepared, created!.operation);
    expect(prepared).toBeDefined();

    // The creation completed, so this history established that checkout — and
    // then it is removed. Absence is the state a creation starts from, not a
    // state one that finished may be found in, and nothing here clones it
    // again or decides the destination is eligible because it is missing.
    const complete = events.findLastIndex(
      (event) =>
        event.type === "yield" && event.description.type === RETAINED_REPOSITORY_COMPLETION,
    );
    expect(complete).toBeGreaterThan(0);
    yield* rm(prepared!.slot, { recursive: true, force: true });

    const leaf = counted();
    let refusal: string | undefined;
    try {
      yield* run(
        fixture,
        source,
        new InMemoryStream([...events.slice(0, complete + 1)]),
        leaf.handler,
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBeDefined();
    // Nothing later ran, and nothing put the destination back.
    expect(leaf.writes).toEqual([]);
    expect(yield* exists(prepared!.slot)).toBe(false);
  });

  it("R4: an undisturbed managed checkout replays its results and goes on", function* () {
    const fixture = yield* useFixture();
    const remote = yield* useBareRemote({
      commits: [{ message: "remote seed", entries: [{ path: "remote.md", content: "remote\n" }] }],
    });
    const source =
      `<Repository name="project" url=${JSON.stringify(remote.locator)}>\n` +
      '<File path="one.md">one\n</File>\n\n<File path="two.md">two\n</File>\n</Repository>\n';
    const { events } = yield* run(fixture, source, new InMemoryStream(), counted().handler);
    const created = recordsOf(events, RETAINED_REPOSITORY_INTENT)
      .map((record) => parseRetainedRepositoryIntent(record))
      .find((record) => record?.operation === "repository");
    expect(created).toBeDefined();
    const intents = events.filter(
      (event) => event.type === "yield" && event.description.type === RETAINED_REPOSITORY_INTENT,
    );
    // Up to the last write's own intent: the creation and the first write are
    // resolved, and the second write is still to make.
    const tail = events.indexOf(intents[intents.length - 1]!);
    expect(tail).toBeGreaterThan(0);
    yield* rm(join(created!.postState.checkout, "two.md"), { force: true });

    // Authentication is a check, not an obstacle: a checkout nobody has
    // touched is in a state this history accounts for, so the completed
    // selection and write replay and the remaining write is performed.
    const leaf = counted();
    const resumed = yield* run(
      fixture,
      source,
      new InMemoryStream([...events.slice(0, tail)]),
      leaf.handler,
    );
    expect(leaf.writes).toEqual(["two.md"]);
    expect(yield* readTextFile(join(created!.postState.checkout, "two.md"))).toBe("two\n");
    const admitted = yield* admitRetainedRepositoryHistory(resumed.events, created!.owner);
    expect(admitted.ok ? "ok" : admitted.error.message).toBe("ok");
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

    const intents = recordsOf(events, RETAINED_REPOSITORY_INTENT).map((record) =>
      parseRetainedRepositoryIntent(record),
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
    // It followed the authored write in the same lane rather than racing it.
    expect(intents.map((record) => record?.lane.position)).toEqual([0, 1, 2]);
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
    expect(recordsOf(events, RETAINED_REPOSITORY_INTENT)).toEqual([]);
  });
});
