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
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import { collect } from "@executablemd/core";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { useRetainedRepositoryEntry } from "../src/deno/retained-repository/provider.ts";
import {
  RETAINED_REPOSITORY_COMPLETION,
  RETAINED_REPOSITORY_INTENT,
  parseRetainedRepositoryCompletion,
  parseRetainedRepositoryIntent,
} from "../src/retained-repository/records.ts";

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
    const output = yield* collect(
      yield* executeInstalled({ path, stream, includes: [fixture.root] }, [entry.installation]),
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
    expect(intent?.preState.worktree.some((entry) => entry.path === "notes.md")).toBe(false);
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
    expect(add?.preState.index.some((entry) => entry.path === "notes.md")).toBe(false);
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
    expect(commit?.preState.head.kind === "symbolic" && commit.preState.head.oid).not.toBe(
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
    expect(moved?.preState.head.kind === "symbolic" && moved.preState.head.ref).toBe(
      "refs/heads/main",
    );
    expect(moved?.postState.head.kind === "symbolic" && moved.postState.head.ref).toBe(
      "refs/heads/topic",
    );
    // The content the other branch carries was predicted, not guessed.
    expect(moved?.preState.worktree.some((entry) => entry.path === "topic.md")).toBe(false);
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

  it("R3: a repository selection is the baseline its lane is held to following", function* () {
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
    // The selection comes first in its own lane, and the write inside it follows.
    expect(intents.map((record) => record?.operation)).toEqual(["repository", "file-write"]);
    const selection = intents[0];
    const write = intents[1];
    expect(selection?.lane.position).toBe(0);
    expect(write?.lane.position).toBe(1);
    expect(selection?.lane.common).toBe(write?.lane.common);
    // A selection changes nothing, so its two frozen ends are one state.
    expect(selection?.preState.worktree.some((entry) => entry.path === "remote.md")).toBe(true);
    expect(selection?.postState.worktree.some((entry) => entry.path === "inside.md")).toBe(false);
    // And the file really is in the clone.
    expect(write?.postState.worktree.some((entry) => entry.path === "inside.md")).toBe(true);
  });

  it("R3: a worktree is retained against the repository it belongs to", function* () {
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
    const write = intents[2];
    // A linked worktree is its own checkout, sharing the repository's
    // administration.
    expect(worktree?.preState.administration.role).toBe("linked");
    expect(worktree?.preState.administration.common).toBe(
      intents[0]?.preState.administration.common,
    );
    // The file was written in the worktree, not in the repository.
    expect(write?.preState.checkout).toBe(worktree?.preState.checkout);
    expect(write?.preState.checkout).not.toBe(intents[0]?.preState.checkout);
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
