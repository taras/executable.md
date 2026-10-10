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
    ensureDirectory: ([input]) => leaf.ensureDirectory(input),
    temporaryDirectory: () => leaf.temporaryDirectory(),
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
