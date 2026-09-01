/**
 * Tier WF — the document filesystem of a workflow run.
 *
 * These drive the real `<File>` and `<Glob>` definitions through `execute()`
 * against a real run database, because what is under test is where a document's
 * paths land and what survives in the journal — neither of which a stand-in for
 * DOFS or for SQLite could show.
 *
 * Two observations do most of the work. A second connection counts committed
 * journal rows, which says whether a transaction has already published rather
 * than whether a row is there now; and a host `API.Files` spy is installed
 * *outside* the workflow provider, so any call that fell through to the caller's
 * filesystem would be recorded rather than merely suspected.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  createContext,
  race,
  scoped,
  sleep,
  spawn,
  suspend,
  type Operation,
  withResolvers,
} from "effection";
import { type Api, createApi } from "@effectionx/context-api";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API, FILES_FATAL, parseFilesFatal, useHostFiles } from "@executablemd/runtime";
import type { HostFilesEvent } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "../mod.ts";
import { withWorkflowWorkspace } from "../src/deno/workspace/host.ts";
import { WORKSPACE_FILE } from "../src/deno/workspace/files.ts";
import { throwWorkspaceFilesystemFailure } from "../src/deno/workspace/errors.ts";
import type { DenoWorkspaceFilesystem } from "../src/deno/workspace/filesystem.ts";
import { join } from "node:path";
import { exists } from "@effectionx/fs";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import type { PrivateWorkspaceTransaction } from "../src/deno/workspace/private.ts";
import {
  committedEventCount,
  createRun,
  runPath,
  tamper,
  useStorageRoot,
  withStorage,
} from "./support/storage.ts";

/** What an operation threw, so a suite can assert on it rather than fail. */
function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * The infrastructure failure somewhere in this failure's causes.
 *
 * A denied operation is raised where `<TempDir>` acquired it and reaches the
 * caller wrapped in whatever the document execution reported, so the assertion
 * follows the chain the engine builds rather than the top of it.
 */
function fatalOf(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 16 && current instanceof Error; depth += 1) {
    if (parseFilesFatal(current) !== undefined) {
      return current;
    }
    current = current.cause;
  }
  return error;
}

/** The current root pointer, as a second connection sees it. */
function committedRoot(path: string): unknown {
  let found: unknown;
  tamper(path, (database) => {
    found = database.prepare("SELECT current_root_id AS root FROM workspace_state").get()?.root;
  });
  return found;
}

/** The Workspace root the newest committed journal row is associated with. */
function rootOfLastEvent(path: string): unknown {
  let found: unknown;
  tamper(path, (database) => {
    found = database
      .prepare(
        "SELECT workspace_root_id AS root FROM journal_events ORDER BY sequence DESC LIMIT 1",
      )
      .get()?.root;
  });
  return found;
}

/** Every host document-filesystem step this run performed. Must stay empty. */
interface HostSpy {
  readonly seen: HostFilesEvent[];
}

function* useHostSpy(): Operation<HostSpy> {
  const seen: HostFilesEvent[] = [];
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return "/nowhere-the-workflow-may-reach";
      },
    },
    { at: "min" },
  );
  yield* useHostFiles({ observe: (event) => seen.push(event) });
  return { seen };
}

interface Run {
  readonly output: Json;
  readonly host: HostSpy;
}

/**
 * Execute `source` as this run's root document, with the run's Workspace
 * attached and a host provider installed outside it.
 */
function runDocument(database: WorkflowRunDatabase, source: string): Operation<Run> {
  return scoped(function* () {
    const host = yield* useHostSpy();
    const output = yield* withWorkflowWorkspace(
      database,
      scoped(function* () {
        return yield* collect(
          yield* execute({ ...inlineSource(source), stream: database.journal }),
        );
      }),
    );
    return { output, host };
  });
}

/**
 * What one run said, whether it printed it or failed with it.
 *
 * A refusal the component owns is printed into the output; one the engine makes
 * before the component runs — prop validation — fails the execution instead. A
 * table covering both reads the sentence from wherever it landed.
 */
function* reportedBy(database: WorkflowRunDatabase, source: string): Operation<string> {
  try {
    return String((yield* runDocument(database, source)).output);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The same document again, replaying the journal the first execution wrote. */
function replayDocument(database: WorkflowRunDatabase, source: string): Operation<Run> {
  return runDocument(database, source);
}

function* workspaceEvents(database: WorkflowRunDatabase): Operation<DurableEvent[]> {
  const events = yield* database.journal.readAll();
  return events.filter(
    (event) => event.type === "yield" && event.description.type === WORKSPACE_FILE,
  );
}

/**
 * The file effects this run recorded, as operation and outcome.
 *
 * What a document rendered is not evidence that a file effect happened: an
 * element's own expansion is journaled too, so a provider that never recorded
 * anything can still replay the text it produced. These rows are the provider's
 * own history, which is what the durability claims are about.
 */
function* recordedFileEffects(
  database: WorkflowRunDatabase,
): Operation<Array<{ name: string; result: unknown }>> {
  const events = yield* workspaceEvents(database);
  return events.flatMap((event) =>
    event.type === "yield" ? [{ name: event.description.name, result: event.result }] : [],
  );
}

function* workspaceText(database: WorkflowRunDatabase, path: string): Operation<string> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    return yield* workspace.filesystem.readTextFile(path);
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

/**
 * A Workspace filesystem that refuses one write the way DOFS refuses one.
 *
 * The failure is raised through the adapter's own wrapping, so what reaches the
 * provider is indistinguishable from a real `EACCES`: it selects a reason and
 * carries nothing else. It exists because no ordinary DOFS condition stops a
 * write between creating its parents and writing the file — a parent chain that
 * can be created is a chain the file can then be written into — so the state a
 * savepoint is there to discard cannot otherwise be produced.
 */
function refusingWrite(
  target: string,
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *writeFile(path, content, mode) {
      if (path === target) {
        throwWorkspaceFilesystemFailure(
          Object.assign(new Error("planted"), { name: "WorkspaceFsError", code: "EACCES" }),
        );
      }
      yield* filesystem.writeFile(path, content, mode);
    },
  });
}

/**
 * A Workspace filesystem that records every removal it performs.
 *
 * Counting the low-level call is what distinguishes "replay restored the
 * outcome" from "the deletion simply happened again and found nothing" — the
 * Workspace looks the same either way.
 */
function countingRemoves(
  removed: string[],
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *remove(path, options) {
      removed.push(path);
      yield* filesystem.remove(path, options);
    },
  });
}

/** Every directory this run actually created, in order. */
function countingMkdirs(
  made: string[],
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *mkdir(path, options) {
      made.push(path);
      yield* filesystem.mkdir(path, options);
    },
  });
}

/**
 * A Workspace filesystem that stops one removal after it has happened.
 *
 * The suspension sits between the mutation and the transaction's commit, which
 * is the one window where a Workspace holds a change nothing has published yet.
 */
function suspendingRemove(
  target: string,
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *remove(path, options) {
      yield* filesystem.remove(path, options);
      if (path === target) {
        yield* suspend();
      }
    },
  });
}

/**
 * A creation that makes a parent and then refuses.
 *
 * The refusal a document can be told about arrives *after* part of the path
 * exists, which is the only shape that exercises the savepoint: a target that
 * refuses before anything is created rolls nothing back, and a test built on
 * one would assert an empty Workspace that was never written to.
 */
function partialThenRefuse(
  target: string,
  parent: string,
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *mkdir(path, options) {
      if (path !== target) {
        yield* filesystem.mkdir(path, options);
        return;
      }
      yield* filesystem.mkdir(parent, { recursive: true });
      // Planted the way the Workspace filesystem reports one, so it is a
      // journalable condition rather than an infrastructure failure: an
      // unrecognized platform error is deliberately fatal here, which is
      // exactly what an unadorned `Error` would have produced.
      throwWorkspaceFilesystemFailure(
        Object.assign(new Error("planted"), { name: "WorkspaceFsError", code: "ENOTDIR" }),
      );
    },
  });
}

function suspendingWrite(
  target: string,
  reached: { resolve(): void },
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *writeFile(path, content, mode) {
      yield* filesystem.writeFile(path, content, mode);
      if (path === target) {
        reached.resolve();
        yield* suspend();
      }
    },
  });
}

/**
 * A Workspace filesystem that stops one creation after it has happened.
 *
 * The suspension sits between the mutation and the transaction's commit, which
 * is the one window where a Workspace holds a change nothing has published yet.
 */
function suspendingMkdir(
  target: string,
  reached: { resolve(): void },
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *mkdir(path, options) {
      yield* filesystem.mkdir(path, options);
      if (path === target) {
        // Signalled after the mutation and before the commit, so a halt that
        // waits for this lands in that window rather than wherever a deadline
        // happened to fall.
        reached.resolve();
        yield* suspend();
      }
    },
  });
}

/**
 * A Workspace filesystem whose removal succeeds and then fails the run.
 *
 * Not a documented condition, so it is never journaled: what it produces is an
 * infrastructure failure after the mutation and before publication, which is
 * the case the outer transaction's rollback exists for.
 */
function faultAfterRemove(
  target: string,
): (filesystem: DenoWorkspaceFilesystem) => DenoWorkspaceFilesystem {
  return (filesystem) => ({
    ...filesystem,
    *remove(path, options) {
      yield* filesystem.remove(path, options);
      if (path === target) {
        throw new Error("planted failure after the removal");
      }
    },
  });
}

/**
 * Every name a Workspace filesystem decorator has answered to, rebuilt here.
 *
 * A contextual Api composes by stable name across loaded copies, so an
 * independently constructed descriptor of the same name *is* the second copy.
 * Each handler records that it was consulted and then delegates, so a seam that
 * still existed would show up as a name in `reached` rather than as a broken
 * run.
 */
const SEAM_NAMES: readonly string[] = [
  "executablemd.workflow.deno.workspace.private.filesystem",
  "executablemd.workflow.deno.workspace.private",
  "executablemd.workflow.deno.workspace.effect.mutation",
];

interface SeamShape {
  interpose(value: unknown): Operation<unknown>;
}

function* useImpostorSeams(reached: string[]): Operation<void> {
  for (const name of SEAM_NAMES) {
    const impostor: Api<SeamShape> = createApi<SeamShape>(name, {
      // deno-lint-ignore require-yield
      *interpose(value: unknown): Operation<unknown> {
        return value;
      },
    });
    yield* impostor.around({
      *interpose([value], next) {
        reached.push(name);
        return yield* next(value);
      },
    });
    yield* createContext<unknown>(name, undefined).set({ seized: true });
  }
}

/** `<Tamper />` — the same impostors, installed from inside the document. */
function useTamper(reached: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Tamper",
      origin: "tier-wf",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* useImpostorSeams(reached);
        return "";
      },
    },
  ]);
}

/** Whether one journal row is the recorded `operation` on `target`. */
function namesEffect(record: unknown, operation: string, target: string): boolean {
  if (typeof record !== "string") {
    return false;
  }
  const parsed: unknown = JSON.parse(record);
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const description = Reflect.get(parsed, "description");
  const name =
    typeof description === "object" && description !== null
      ? Reflect.get(description, "name")
      : undefined;
  return (
    Reflect.get(parsed, "type") === "yield" &&
    typeof name === "string" &&
    name.startsWith(`${operation}:`) &&
    name.endsWith(`:${target}`)
  );
}

/**
 * How many committed journal rows record `operation` on `target`.
 *
 * Counted through a second connection, so what it reports is what a
 * transaction published rather than what this handle is holding — the same
 * observation `committedEventCount` makes, narrowed to one effect.
 */
function committedEffects(path: string, operation: string, target: string): number {
  let found = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT record FROM journal_events").all()) {
      if (namesEffect(row["record"], operation, target)) {
        found += 1;
      }
    }
  });
  return found;
}

/**
 * Replace what one recorded file effect settled to.
 *
 * Written through SQL rather than through the provider, because the point of
 * these cases is a journal holding something the provider would never write.
 */
function plantOutcome(path: string, operation: string, target: string, value: Json): void {
  tamper(path, (database) => {
    let planted = 0;
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      if (!namesEffect(row["record"], operation, target)) {
        continue;
      }
      const record = JSON.parse(String(row["record"]));
      record.result = { status: "ok", value };
      database
        .prepare("UPDATE journal_events SET record = ? WHERE sequence = ?")
        .run(`${JSON.stringify(record)}\n`, row["sequence"]);
      planted += 1;
    }
    if (planted !== 1) {
      throw new Error(`the journal records ${planted} ${operation} effects on ${target}`);
    }
  });
}

/**
 * Take away the root's Close.
 *
 * A completed journal answers with its recorded root result without replaying
 * anything, so a record planted in one of its effects is never read. Removing
 * the Close is what makes the effects replay.
 */
function dropRootClose(path: string): void {
  tamper(path, (database) => {
    let dropped = 0;
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      if (
        Reflect.get(parsed, "type") !== "close" ||
        Reflect.get(parsed, "coroutineId") !== "root"
      ) {
        continue;
      }
      database.prepare("DELETE FROM journal_events WHERE sequence = ?").run(row["sequence"]);
      dropped += 1;
    }
    if (dropped !== 1) {
      throw new Error(`the journal records ${dropped} root closes`);
    }
  });
}

/**
 * Drop the journal from the recorded effect on `target` onward.
 *
 * What is left replays up to that point and runs live after it, which is how a
 * test observes what a document does *after* a replayed effect rather than only
 * what that effect answers.
 */
function truncateFromEffect(path: string, operation: string, target: string): void {
  tamper(path, (database) => {
    const rows = database.prepare("SELECT sequence, record FROM journal_events").all();
    const found = rows.find((row) => namesEffect(row["record"], operation, target));
    if (found === undefined) {
      throw new Error(`the journal records no ${operation} of ${target}`);
    }
    database.prepare("DELETE FROM journal_events WHERE sequence >= ?").run(found["sequence"]);
  });
}

function* mutateWorkspace(
  database: WorkflowRunDatabase,
  body: (workspace: PrivateWorkspaceTransaction) => Operation<void>,
): Operation<void> {
  const changed = yield* transactWorkspaceRoots(database, function* (workspace) {
    yield* body(workspace);
    const root = yield* workspace.capture();
    yield* workspace.publish(root.rootId);
  });
  if (!changed.ok) {
    throw changed.error;
  }
}

describe("WF workflow document filesystem", () => {
  it("writes a file into the run's own Workspace and records one effect", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = yield* runDocument(
        database,
        ["# Release", "", '<File path="notes/release.md">Prepared</File>', ""].join("\n"),
      );

      expect(run.host.seen).toEqual([]);
      expect(yield* workspaceText(database, "/notes/release.md")).toEqual("Prepared");

      const events = yield* workspaceEvents(database);
      expect(events).toHaveLength(1);
      expect(events[0]?.type === "yield" && events[0].description.name).toContain("write:");
    });
  });

  it("reads a file back through the same logical Workspace", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = yield* runDocument(
        database,
        [
          '<File path="config.json">{"channel":"stable"}</File>',
          "",
          '<File path="config.json" as="config" />',
          "",
          "Read: {config}",
        ].join("\n"),
      );

      expect(run.host.seen).toEqual([]);
      expect(String(run.output)).toContain('Read: {"channel":"stable"}');
    });
  });

  it("restores a read's recorded content when the frontier no longer holds it", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const source = [
        '<File path="seed.txt">first</File>',
        "",
        '<File path="seed.txt" as="seen" />',
        "",
        "Seen: {seen}",
      ].join("\n");
      const first = yield* runDocument(database, source);
      expect(String(first.output)).toContain("Seen: first");

      // The provider recorded the read itself, not merely the element that
      // asked for it: a read that answered from the frontier would leave one
      // effect here instead of two.
      const recorded = yield* recordedFileEffects(database);
      expect(recorded.map((effect) => effect.name.split(":")[0])).toEqual(["write", "read"]);
      expect(recorded[1]?.result).toEqual({
        status: "ok",
        value: { kind: "content", content: "first" },
      });

      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/seed.txt", "replaced");
      });
      expect(yield* workspaceText(database, "/seed.txt")).toEqual("replaced");

      const replayed = yield* replayDocument(database, source);
      expect(String(replayed.output)).toContain("Seen: first");
      expect(replayed.host.seen).toEqual([]);
      expect(yield* recordedFileEffects(database)).toEqual(recorded);
    });
  });

  // WF6: the three refusals a document can act on, each decided before any
  // effect exists. Nothing is recorded and nothing outside the run is asked,
  // which is what "lexical" means here.
  it("refuses an empty, absolute or escaping path without an effect or a host call", function* () {
    const cases: Array<{ path: string; says: string }> = [
      { path: "", says: "path is empty" },
      { path: "/etc/passwd", says: "an absolute path is not accepted" },
      { path: "../escape.txt", says: "resolves outside the working directory" },
    ];

    for (const refused of cases) {
      const root = yield* useStorageRoot();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);
        const before = committedRoot(path);
        const run = yield* runDocument(database, `<File path="${refused.path}">no</File>`);

        expect(String(run.output)).toContain(refused.says);
        expect(run.host.seen).toEqual([]);
        expect(yield* workspaceEvents(database)).toEqual([]);
        expect(committedRoot(path)).toEqual(before);
      });
    }
  });

  // WF11: the search's document-facing shape, on the same contract the host
  // provider answers on (HF3). A link is not a file, so it is neither a result
  // nor a way into the tree it names.
  it("searches regular files only, reporting no symbolic link and following none", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.mkdir("/docs", { recursive: true });
        yield* workspace.filesystem.writeFile("/docs/a.md", "a");
        yield* workspace.filesystem.mkdir("/hidden", { recursive: true });
        yield* workspace.filesystem.writeFile("/hidden/b.md", "b");
        yield* workspace.filesystem.symlink("/docs/a.md", "/link.md");
        // Named so that walking *through* it would produce a second, matching
        // path for a file the walk already reaches by its own name.
        yield* workspace.filesystem.symlink("/hidden", "/mirror.md");
      });

      const run = yield* runDocument(
        database,
        ['<Glob include={["**/*.md"]} as="found" />', "", "Found: {found}"].join("\n"),
      );

      expect(run.host.seen).toEqual([]);
      const recorded = yield* recordedFileEffects(database);
      expect(recorded[0]?.result).toEqual({
        status: "ok",
        value: { kind: "paths", paths: ["docs/a.md", "hidden/b.md"] },
      });
      // The file link is not a result, and the directory link is neither a
      // result nor a second route to `b.md`.
      expect(String(run.output)).not.toContain("link.md");
      expect(String(run.output)).not.toContain("mirror.md");
    });
  });

  it("reports a missing file as missing rather than reaching the host for it", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = yield* runDocument(database, '<File path="absent.txt" as="gone" />');

      expect(String(run.output)).toContain("absent.txt");
      expect(run.host.seen).toEqual([]);
      const events = yield* workspaceEvents(database);
      expect(events).toHaveLength(1);
    });
  });

  it("searches the logical Workspace with <Glob>", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = yield* runDocument(
        database,
        [
          '<File path="docs/a.md">a</File>',
          '<File path="docs/b.md">b</File>',
          '<File path="docs/skip.txt">c</File>',
          "",
          '<Glob include={["docs/*.md"]} as="found" />',
          "",
          "Found: {found}",
        ].join("\n"),
      );

      expect(run.host.seen).toEqual([]);
      expect(String(run.output)).toContain("docs/a.md");
      expect(String(run.output)).toContain("docs/b.md");
      expect(String(run.output)).not.toContain("skip.txt");
    });
  });

  it("commits the bytes, the current root and the filtered result together", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const path = runPath(root, database.record.runId);
      yield* runDocument(database, '<File path="atomic.txt">committed</File>');

      // Counted through a second connection, so what it reports is what the
      // transaction published rather than what this handle is holding.
      expect(committedEventCount(path)).toBeGreaterThan(0);
      expect(committedRoot(path)).toEqual(rootOfLastEvent(path));
      expect(yield* workspaceText(database, "/atomic.txt")).toEqual("committed");

      const events = yield* workspaceEvents(database);
      const written = events[0];
      expect(written?.type === "yield" && written.result).toEqual({
        status: "ok",
        value: { kind: "written" },
      });
    });
  });

  it("replays a create/delete/create history without consulting the current file", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const source = [
        '<File path="x.txt">one</File>',
        "",
        '<File path="x.txt" as="seen" />',
        "",
        "Seen: {seen}",
      ].join("\n");

      const first = yield* runDocument(database, source);
      expect(String(first.output)).toContain("Seen: one");

      // The history the replay has to survive, built through the seam a
      // provider owns rather than through a public delete component: the file
      // the document created is removed, and then a different file is created
      // at the same path.
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.remove("/x.txt");
      });
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/x.txt", "three");
      });

      const before = yield* database.journal.readAll();
      const recorded = yield* recordedFileEffects(database);
      expect(recorded).toEqual([
        { name: recorded[0]?.name ?? "", result: { status: "ok", value: { kind: "written" } } },
        {
          name: recorded[1]?.name ?? "",
          result: { status: "ok", value: { kind: "content", content: "one" } },
        },
      ]);
      const frontier = yield* workspaceText(database, "/x.txt");
      expect(frontier).toEqual("three");

      const replayed = yield* replayDocument(database, source);

      expect(String(replayed.output)).toContain("Seen: one");
      expect(replayed.host.seen).toEqual([]);
      // The write did not run again, so the frontier is still what the private
      // history left there rather than the document's own content.
      expect(yield* workspaceText(database, "/x.txt")).toEqual(frontier);
      expect((yield* database.journal.readAll()).length).toEqual(before.length);
      expect(yield* recordedFileEffects(database)).toEqual(recorded);
    });
  });

  it("refuses to publish a workflow file effect into a stream that is not the run's", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const before = yield* database.journal.readAll();

      const failure = yield* raised(
        scoped(function* () {
          yield* useHostSpy();
          return yield* withWorkflowWorkspace(
            database,
            scoped(function* () {
              return yield* collect(
                yield* execute({
                  ...inlineSource('<File path="smuggled.txt">no</File>'),
                  stream: new InMemoryStream(),
                }),
              );
            }),
          );
        }),
      );

      expect(failure).toBeInstanceOf(Error);
      expect((yield* database.journal.readAll()).length).toEqual(before.length);
      const present = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* workspace.filesystem.readTextFile("/smuggled.txt");
      });
      expect(present.ok).toEqual(false);
    });
  });

  it("publishes a refusal as rolled back, leaving the Workspace as it was", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const path = runPath(root, database.record.runId);
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/blocked", "a file, not a directory");
      });
      const before = committedRoot(path);

      const run = yield* runDocument(database, '<File path="blocked/deep/x.txt">no</File>');

      expect(run.host.seen).toEqual([]);
      const recorded = yield* recordedFileEffects(database);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.result).toEqual({
        status: "ok",
        value: { kind: "refused", phase: "transaction", reason: "not-directory" },
      });
      // Nothing the attempt created survives, so the root the effect published
      // is the one it started from.
      expect(committedRoot(path)).toEqual(before);

      const created = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* workspace.filesystem.stat("/blocked/deep");
      });
      expect(created.ok).toEqual(false);
    });
  });

  // WF12: the savepoint around parent creation and the write together. The
  // write fails after two directories exist, so what the assertion below sees
  // is the rollback rather than an attempt that never started.
  it("discards the parent directories a refused write already created", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.writeFile("/kept.txt", "kept");
        });

        const run = yield* runDocument(
          database,
          ['<File path="made/deep/x.txt">no</File>', "", '<File path="after.txt">yes</File>'].join(
            "\n",
          ),
        );

        expect(run.host.seen).toEqual([]);
        const recorded = yield* recordedFileEffects(database);
        expect(recorded[0]?.result).toEqual({
          status: "ok",
          value: { kind: "refused", phase: "transaction", reason: "permission-denied" },
        });

        // Both directories the attempt created are gone.
        for (const created of ["/made", "/made/deep"]) {
          const stat = yield* transactWorkspaceRoots(database, function* (workspace) {
            return yield* workspace.filesystem.stat(created);
          });
          expect(stat.ok).toEqual(false);
        }
        // What the Workspace already held is what it still holds.
        expect(yield* workspaceText(database, "/kept.txt")).toEqual("kept");
        // The savepoint took back the mutation rather than the transaction, so
        // the next effect still commits.
        expect(recorded[1]?.result).toEqual({ status: "ok", value: { kind: "written" } });
        expect(yield* workspaceText(database, "/after.txt")).toEqual("yes");
      },
      { decorateFilesystem: refusingWrite("/made/deep/x.txt") },
    );
  });

  // WF14: the transaction filesystem is the provider's, decided where the
  // provider was installed. The adversary here sits in the strongest position
  // any composed code can occupy — a scope that encloses the whole document and
  // was installed *after* the provider — and rebuilds, by name, every seam a
  // filesystem decorator has answered to. A stable name is composition; this is
  // what it means for authority not to travel through one.
  it("keeps composed middleware away from the transaction filesystem", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const reached: string[] = [];

      const run = yield* scoped(function* () {
        yield* useImpostorSeams(reached);
        yield* useTamper(reached);
        return yield* runDocument(
          database,
          ["<Tamper />", "", '<File path="guarded.txt">written</File>'].join("\n"),
        );
      });

      expect(run.host.seen).toEqual([]);
      // The write went to the run's own Workspace, untouched.
      expect(yield* workspaceText(database, "/guarded.txt")).toEqual("written");
      const recorded = yield* recordedFileEffects(database);
      expect(recorded.at(-1)?.result).toEqual({ status: "ok", value: { kind: "written" } });
      // Neither position reached the filesystem: not the enclosing scope, and
      // not the component that installed the same names from inside the
      // document.
      expect(reached).toEqual([]);
    });
  });

  // WF13: durable history is parsed, not believed. A record carrying more than
  // its variant carries, or a word the vocabulary does not hold, describes no
  // outcome — and nothing it happens to hold is repeated back.
  it("refuses a recorded outcome carrying extra or contradictory members", function* () {
    const source = [
      '<File path="seed.txt">first</File>',
      "",
      '<File path="seed.txt" as="seen" />',
      "",
      '<Glob include={["*.txt"]} as="found" />',
      "",
      "Seen: {seen}",
    ].join("\n");

    const cases: Array<{ operation: string; target: string; value: Json }> = [
      // content, carrying a refusal's members as well as its own
      {
        operation: "read",
        target: "/seed.txt",
        value: { kind: "content", content: "first", reason: "missing" },
      },
      // written, which carries nothing but its kind
      { operation: "write", target: "/seed.txt", value: { kind: "written", content: "first" } },
      // paths, carrying content
      {
        operation: "glob",
        target: "/",
        value: { kind: "paths", paths: ["seed.txt"], content: "x" },
      },
      // refused, missing the reason it is refused for
      { operation: "read", target: "/seed.txt", value: { kind: "refused", phase: "target" } },
      // refused, in a vocabulary this provider does not speak
      {
        operation: "read",
        target: "/seed.txt",
        value: { kind: "refused", phase: "target", reason: "unspeakable" },
      },
      // refused, with planted text riding along beside the vocabulary
      {
        operation: "read",
        target: "/seed.txt",
        value: { kind: "refused", phase: "target", reason: "missing", detail: "PLANTED-SECRET" },
      },
      // Every member, holding the wrong kind of value.
      { operation: "read", target: "/seed.txt", value: { kind: "content", content: 7 } },
      { operation: "glob", target: "/", value: { kind: "paths", paths: "seed.txt" } },
      { operation: "glob", target: "/", value: { kind: "paths", paths: ["seed.txt", 7] } },
      {
        operation: "read",
        target: "/seed.txt",
        value: { kind: "refused", phase: 7, reason: "missing" },
      },
      {
        operation: "read",
        target: "/seed.txt",
        value: { kind: "refused", phase: "target", reason: 7 },
      },
      // A word from the other operation's vocabulary is not this one's.
      {
        operation: "read",
        target: "/seed.txt",
        value: { kind: "refused", phase: "commit", reason: "missing" },
      },
    ];

    for (const planted of cases) {
      const root = yield* useStorageRoot();
      yield* withStorage(root, function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);
        yield* runDocument(database, source);

        dropRootClose(path);
        plantOutcome(path, planted.operation, planted.target, planted.value);
        const before = (yield* workspaceEvents(database)).length;

        const failure = yield* raised(replayDocument(database, source));

        expect(failure).toBeInstanceOf(Error);
        // Exactly the fixed provider invariant — not merely "something failed".
        const fatal = fatalOf(failure);
        expect(parseFilesFatal(fatal)).toEqual({
          type: FILES_FATAL,
          kind: "invariant",
          category: "protocol",
        });
        // Cause-free: nothing the journal held is carried along underneath it.
        expect(fatal instanceof Error ? fatal.cause : "not an error").toBeUndefined();
        expect(String(failure)).not.toContain("PLANTED-SECRET");
        // The failed run performed no file effect of its own — the history it
        // could not read is the whole of what it has.
        expect((yield* workspaceEvents(database)).length).toEqual(before);
      });
    }
  });

  it("performs no later file effect once the history it replays is malformed", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const path = runPath(root, database.record.runId);
      const source = [
        '<File path="first.txt">one</File>',
        "",
        '<File path="second.txt">two</File>',
      ].join("\n");
      yield* runDocument(database, source);

      // The journal now replays the first write and runs everything from the
      // second one live, and the first write's record describes no outcome.
      truncateFromEffect(path, "write", "/second.txt");
      plantOutcome(path, "write", "/first.txt", { kind: "written", content: "one" });
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.remove("/second.txt");
      });
      const before = (yield* workspaceEvents(database)).length;

      const failure = yield* raised(replayDocument(database, source));

      expect(parseFilesFatal(fatalOf(failure))).toEqual({
        type: FILES_FATAL,
        kind: "invariant",
        category: "protocol",
      });
      expect((yield* workspaceEvents(database)).length).toEqual(before);
      const second = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* workspace.filesystem.stat("/second.txt");
      });
      expect(second.ok).toEqual(false);
    });
  });

  it("refuses to replace a directory before it changes anything", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.mkdir("/held", { recursive: true });
        yield* workspace.filesystem.writeFile("/held/inner.txt", "kept");
      });

      const run = yield* runDocument(database, '<File path="held">replacement</File>');

      expect(run.host.seen).toEqual([]);
      const recorded = yield* recordedFileEffects(database);
      expect(recorded[0]?.result).toEqual({
        status: "ok",
        value: { kind: "refused", phase: "target", reason: "directory" },
      });
      expect(yield* workspaceText(database, "/held/inner.txt")).toEqual("kept");
    });
  });

  it("denies a temporary directory instead of handing out a host one", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        runDocument(
          database,
          ["<TempDir>", '<File path="inside.txt">x</File>', "</TempDir>"].join("\n"),
        ),
      );

      expect(failure).toBeInstanceOf(Error);
      expect(parseFilesFatal(fatalOf(failure))).toEqual({
        type: FILES_FATAL,
        kind: "operation-denied",
        operation: "temporary-directory",
      });
    });
  });

  it("keeps an unrelated in-memory journal out of the run's storage", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const before = (yield* database.journal.readAll()).length;
      yield* scoped(function* () {
        yield* useHostSpy();
        yield* collect(
          yield* execute({ ...inlineSource("# plain"), stream: new InMemoryStream() }),
        );
      });
      expect((yield* database.journal.readAll()).length).toEqual(before);
    });
  });

  // WF15: the delete half of WF1 and WF9 together. One authored element is one
  // effect, and the removal, the resulting root and the filtered result are one
  // commit — which a second connection is what proves.
  it("deletes a file and publishes the removal, root and result together", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const path = runPath(root, database.record.runId);
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/notes.md", "stale");
        yield* workspace.filesystem.writeFile("/kept.md", "kept");
      });

      const run = yield* runDocument(database, '<File.Delete path="notes.md" />');

      expect(run.host.seen).toEqual([]);
      const recorded = yield* recordedFileEffects(database);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.name.split(":")[0]).toEqual("delete");
      expect(recorded[0]?.result).toEqual({ status: "ok", value: { kind: "deleted" } });

      const gone = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* workspace.filesystem.stat("/notes.md");
      });
      expect(gone.ok).toEqual(false);
      expect(yield* workspaceText(database, "/kept.md")).toEqual("kept");
      expect(committedRoot(path)).toEqual(rootOfLastEvent(path));
      expect(committedEffects(path, "delete", "/notes.md")).toEqual(1);
    });
  });

  // WF16: absence is the answer, not a condition. Both deletions publish the
  // same successful outcome, and neither moves the run's root — a Workspace
  // that did not change captures the root it already had.
  it("records a deletion of a path that names nothing as the same success", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const path = runPath(root, database.record.runId);
      const before = committedRoot(path);

      const run = yield* runDocument(
        database,
        ['<File.Delete path="absent.md" />', "", '<File.Delete path="absent.md" />'].join("\n"),
      );

      expect(run.host.seen).toEqual([]);
      const recorded = yield* recordedFileEffects(database);
      expect(recorded.map((effect) => effect.result)).toEqual([
        { status: "ok", value: { kind: "deleted" } },
        { status: "ok", value: { kind: "deleted" } },
      ]);
      expect(committedRoot(path)).toEqual(before);
    });
  });

  // WF17: a link is the entry the document named. Removing it leaves what it
  // pointed at, whether that is a file or a whole directory — the same claim
  // HF19 makes about the host, on a filesystem with no host in it.
  it("removes a logical symbolic link as the link, leaving what it names", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.writeFile("/real.txt", "kept");
        yield* workspace.filesystem.mkdir("/tree", { recursive: true });
        yield* workspace.filesystem.writeFile("/tree/inner.txt", "also kept");
        yield* workspace.filesystem.symlink("/real.txt", "/link.txt");
        yield* workspace.filesystem.symlink("/tree", "/mirror");
      });

      const run = yield* runDocument(
        database,
        ['<File.Delete path="link.txt" />', "", '<File.Delete path="mirror" />'].join("\n"),
      );

      expect(run.host.seen).toEqual([]);
      expect((yield* recordedFileEffects(database)).map((effect) => effect.result)).toEqual([
        { status: "ok", value: { kind: "deleted" } },
        { status: "ok", value: { kind: "deleted" } },
      ]);
      expect(yield* workspaceText(database, "/real.txt")).toEqual("kept");
      expect(yield* workspaceText(database, "/tree/inner.txt")).toEqual("also kept");
    });
  });

  // WF18: the case that says the classification is the provider's rather than
  // the filesystem's. The pinned DOFS `rm` removes an empty directory even when
  // `recursive` is false, so a provider that delegated the decision would
  // silently mean something different here than `<File.Delete>` means on a host.
  it("refuses every directory, including the empty one DOFS would remove", function* () {
    const root = yield* useStorageRoot();
    const removed: string[] = [];
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.mkdir("/empty", { recursive: true });
          yield* workspace.filesystem.mkdir("/full", { recursive: true });
          yield* workspace.filesystem.writeFile("/full/inner.txt", "kept");
        });
        const before = committedRoot(path);

        const run = yield* runDocument(
          database,
          ['<File.Delete path="empty" />', "", '<File.Delete path="full" />'].join("\n"),
        );

        expect(run.host.seen).toEqual([]);
        expect((yield* recordedFileEffects(database)).map((effect) => effect.result)).toEqual([
          { status: "ok", value: { kind: "refused", phase: "target", reason: "directory" } },
          { status: "ok", value: { kind: "refused", phase: "target", reason: "directory" } },
        ]);
        expect(String(run.output)).toContain('cannot delete "empty": it is a directory');

        const empty = yield* transactWorkspaceRoots(database, function* (workspace) {
          return yield* workspace.filesystem.stat("/empty");
        });
        expect(empty.ok).toEqual(true);
        expect(yield* workspaceText(database, "/full/inner.txt")).toEqual("kept");
        // A refusal publishes the failed effect against the root it started
        // from: nothing was removed, so the Workspace the effect captured is
        // the one it found.
        expect(removed).toEqual([]);
        expect(committedRoot(path)).toEqual(before);
      },
      { decorateFilesystem: countingRemoves(removed) },
    );
  });

  // WF19: the delete half of WF6, and the one row where the two providers
  // legitimately differ.
  //
  // An empty path never reaches the component: the schema declares a non-empty
  // string, so prop validation refuses it and the document execution fails
  // rather than printing. An absolute path and a `..` escape are decided from
  // the path alone, so there is no effect to record.
  //
  // A parent link whose target leaves the Workspace root is the logical
  // analogue of the host's escaping parent symlink, and it is not a lexical
  // question here: the path is admissible, and what refuses it is DOFS
  // declining to resolve a link target outside the root. So that one *does*
  // publish an effect — a refusal, at resolution, against the unchanged root.
  //
  // None of the four removes anything, which the counter is what proves.
  it("refuses an empty, absolute, escaping or unresolvable delete path", function* () {
    const cases: Array<{ path: string; says: string; effects: number; link?: boolean }> = [
      { path: "", says: "must NOT have fewer than 1 characters", effects: 0 },
      { path: "/etc/passwd", says: "an absolute path is not accepted", effects: 0 },
      { path: "../escape.txt", says: "resolves outside the working directory", effects: 0 },
      {
        path: "escape/secret.txt",
        says: 'cannot resolve "escape/secret.txt": the filesystem operation failed.',
        effects: 1,
        link: true,
      },
    ];

    for (const refused of cases) {
      const root = yield* useStorageRoot();
      const removed: string[] = [];
      yield* withStorage(
        root,
        function* () {
          const database = yield* createRun();
          const path = runPath(root, database.record.runId);
          if (refused.link === true) {
            yield* mutateWorkspace(database, function* (workspace) {
              yield* workspace.filesystem.symlink("../outside", "/escape");
            });
          }
          const before = committedRoot(path);

          expect(yield* reportedBy(database, `<File.Delete path="${refused.path}" />`)).toContain(
            refused.says,
          );

          expect((yield* workspaceEvents(database)).length).toEqual(refused.effects);
          expect(removed).toEqual([]);
          expect(committedRoot(path)).toEqual(before);

          if (refused.link === true) {
            const link = yield* transactWorkspaceRoots(database, function* (workspace) {
              return yield* workspace.filesystem.lstat("/escape");
            });
            expect(link.ok && link.value.kind).toEqual("symlink");
            expect((yield* recordedFileEffects(database))[0]?.result).toEqual({
              status: "ok",
              value: { kind: "refused", phase: "resolution", reason: "operation-failed" },
            });
          }
        },
        { decorateFilesystem: countingRemoves(removed) },
      );
    }
  });

  // WF20: a failure after the removal and before publication. Nothing is
  // journaled for it — it is not a documented condition — so the outer
  // transaction rolls back and the run's file, root and history are the ones it
  // started with.
  it("rolls the removal back when publication fails after it", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.writeFile("/x.txt", "here");
        });
        const before = committedRoot(path);

        const failure = yield* raised(runDocument(database, '<File.Delete path="x.txt" />'));

        expect(failure).toBeInstanceOf(Error);
        expect(yield* workspaceText(database, "/x.txt")).toEqual("here");
        expect(committedRoot(path)).toEqual(before);
        // Nothing about the deletion was published, as a second connection sees
        // it: the effect row and the root move in the same transaction, and
        // this one rolled back.
        expect(committedEffects(path, "delete", "/x.txt")).toEqual(0);
        expect(yield* workspaceEvents(database)).toEqual([]);
      },
      { decorateFilesystem: faultAfterRemove("/x.txt") },
    );
  });

  // WF21: a completed replay restores the outcome rather than performing it
  // again. The target is privately recreated first, so a second removal would
  // be visible as the file disappearing — and the removal counter says which of
  // the two happened rather than leaving it to be inferred.
  it("does not remove again when a completed replay restores its outcome", function* () {
    const root = yield* useStorageRoot();
    const removed: string[] = [];
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const source = '<File.Delete path="x.txt" />';
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.writeFile("/x.txt", "first");
        });

        yield* runDocument(database, source);
        expect(removed).toEqual(["/x.txt"]);
        const recorded = yield* recordedFileEffects(database);
        const before = yield* database.journal.readAll();

        // Recreated through the private seam, without touching the retained
        // delete record.
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.writeFile("/x.txt", "recreated");
        });

        const replayed = yield* replayDocument(database, source);

        expect(replayed.host.seen).toEqual([]);
        expect(removed).toEqual(["/x.txt"]);
        expect(yield* workspaceText(database, "/x.txt")).toEqual("recreated");
        expect((yield* database.journal.readAll()).length).toEqual(before.length);
        expect(yield* recordedFileEffects(database)).toEqual(recorded);
      },
      { decorateFilesystem: countingRemoves(removed) },
    );
  });

  // WF22: cancellation between the removal and the commit. Nothing is
  // published, so the run's frontier is still the one it had — and the
  // continuation, which has no record of a deletion, performs it once.
  it("publishes no outcome for a cancelled delete, and the continuation performs it once", function* () {
    const root = yield* useStorageRoot();
    const source = '<File.Delete path="x.txt" />';
    let path = "";
    let before: unknown;

    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        path = runPath(root, database.record.runId);
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.writeFile("/x.txt", "here");
        });
        before = committedRoot(path);

        yield* race([raised(runDocument(database, source)), sleep(500)]);

        // The mutation the halt interrupted was never published: the file, the
        // root and the file-effect history are all the ones it started with.
        expect(yield* workspaceText(database, "/x.txt")).toEqual("here");
        expect(committedRoot(path)).toEqual(before);
        expect(committedEffects(path, "delete", "/x.txt")).toEqual(0);
        expect(yield* workspaceEvents(database)).toEqual([]);
      },
      { decorateFilesystem: suspendingRemove("/x.txt") },
    );

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const run = yield* runDocument(database, source);

      expect(run.host.seen).toEqual([]);
      const recorded = yield* recordedFileEffects(database);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.result).toEqual({ status: "ok", value: { kind: "deleted" } });
      const gone = yield* transactWorkspaceRoots(database, function* (workspace) {
        return yield* workspace.filesystem.stat("/x.txt");
      });
      expect(gone.ok).toEqual(false);
      expect(committedRoot(path)).not.toEqual(before);
      // Performed once, by the continuation, and recorded once.
      expect(committedEffects(path, "delete", "/x.txt")).toEqual(1);
    });
  });
});

/** What a logical path is, as a second connection sees it. */
function* workspaceStat(
  database: WorkflowRunDatabase,
  path: string,
): Operation<string | undefined> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    try {
      return (yield* workspace.filesystem.stat(path)).kind;
    } catch {
      return undefined;
    }
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

describe("Tier WF — the run's own directories", () => {
  // ORC6h (cancellation): the two halves the replay case does not reach.
  //
  // Cancelled before the commit, nothing is published — the directory the
  // Workspace briefly held is not visible to a second connection, no effect is
  // recorded and the root has not moved. Cancelled after it, in the content
  // that runs inside the region, the committed directory stays: the ensure is
  // its own transaction and the content's fate is not its business.
  it("ORC6h: cancellation before the commit publishes nothing", function* () {
    const root = yield* useStorageRoot();
    const reached = withResolvers<void>();
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);
        const before = committedRoot(path);

        // Halted on the signal rather than on a deadline: a race that fired
        // before `mkdir` ran would find the same empty Workspace and pass
        // without ever reaching the window under test.
        const running = yield* spawn(() =>
          raised(runDocument(database, '<Dir path="never">\n\nINSIDE\n\n</Dir>\n')),
        );
        yield* reached.operation;
        yield* running.halt();

        expect(yield* workspaceStat(database, "/never")).toBe(undefined);
        expect(committedRoot(path)).toEqual(before);
        expect(committedEffects(path, "ensure-directory", "/never")).toEqual(0);
        expect(yield* workspaceEvents(database)).toEqual([]);
      },
      { decorateFilesystem: suspendingMkdir("/never", reached) },
    );
  });

  it("ORC6h: cancelling later content leaves the committed directory", function* () {
    const root = yield* useStorageRoot();
    const reached = withResolvers<void>();
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);

        // The halt lands inside the region, after the ensure committed: the
        // write that suspends is the content running in the new directory, and
        // the signal is what puts the halt there rather than a deadline.
        const running = yield* spawn(() =>
          raised(
            runDocument(
              database,
              '<Dir path="committed">\n\n<File path="inside.md">x</File>\n\n</Dir>\n',
            ),
          ),
        );
        yield* reached.operation;
        yield* running.halt();

        // The directory and its effect survived the cancellation of the
        // content that was running inside it — the ensure is its own
        // transaction and the content's fate is not its business.
        expect(yield* workspaceStat(database, "/committed")).toBe("directory");
        expect(committedEffects(path, "ensure-directory", "/committed")).toEqual(1);
        // And the interrupted write published nothing.
        expect(committedEffects(path, "write", "/committed/inside.md")).toEqual(0);
      },
      { decorateFilesystem: suspendingWrite("/committed/inside.md", reached) },
    );
  });

  // WF23: the mutation, its outcome and the resulting root are one commit, and
  // the content runs after it. Ordering is read off the retained effects, in
  // the order they committed — the nested `<File>` landing proves nothing on
  // its own, because a write creates its own parents recursively and would land
  // either way.
  it("WF23: recursive creation, its effect and the resulting root commit before content", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const path = runPath(root, database.record.runId);
      const before = committedRoot(path);

      const run = yield* runDocument(
        database,
        '<Dir path="one/two">\n\n<File path="inside.md">landed</File>\n\n</Dir>\n',
      );

      expect(yield* workspaceStat(database, "/one")).toBe("directory");
      expect(yield* workspaceStat(database, "/one/two")).toBe("directory");
      expect(yield* workspaceText(database, "/one/two/inside.md")).toBe("landed");
      // One ensure effect, and it committed *before* the write.
      //
      // The nested `<File>` existing proves nothing on its own: a write creates
      // its own parents recursively, so it would land whether or not `<Dir>`
      // had committed first. What settles the ordering is the retained order of
      // the effects themselves.
      const effects = yield* recordedFileEffects(database);
      const ensures = effects.filter((effect) => effect.name.startsWith("ensure-directory:"));
      expect(ensures).toHaveLength(1);
      const order = effects.map((effect) => effect.name.split(":")[0]);
      const ensured = order.indexOf("ensure-directory");
      const wrote = order.indexOf("write");
      expect(ensured).toBeGreaterThanOrEqual(0);
      expect(wrote).toBeGreaterThan(ensured);
      // The root moved, and the host filesystem was never reached for any of it.
      expect(committedRoot(path)).not.toEqual(before);
      expect(rootOfLastEvent(path)).toEqual(committedRoot(path));
      expect(run.host.seen).toEqual([]);
    });
  });

  // WF24: a refusal rolls its savepoint back. The target sits below a file, so
  // the parent could only be created by an attempt that then had to be undone —
  // which is what makes "no partial parent" a real assertion rather than a
  // restatement of "nothing happened".
  it("WF24: a refusal after a partial creation rolls the savepoint back", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.writeFile("/kept.txt", "kept");
        });
        const before = committedRoot(path);

        const run = yield* runDocument(
          database,
          [
            "<PrintErrors>",
            '<Dir path="deep/nested">',
            "",
            "INSIDE",
            "",
            "</Dir>",
            "</PrintErrors>",
            "",
            '<File path="after.txt">yes</File>',
          ].join("\n"),
        );

        expect(run.output).toContain("not a directory");
        expect(run.output).not.toContain("INSIDE");
        expect(run.host.seen).toEqual([]);

        const recorded = yield* recordedFileEffects(database);
        expect(recorded[0]?.result).toEqual({
          status: "ok",
          value: { kind: "refused", phase: "access", reason: "not-directory" },
        });

        // `/deep` was really created inside the savepoint and is gone again.
        expect(yield* workspaceStat(database, "/deep")).toBe(undefined);
        expect(yield* workspaceStat(database, "/deep/nested")).toBe(undefined);
        // What the Workspace already held is what it still holds.
        expect(yield* workspaceText(database, "/kept.txt")).toEqual("kept");
        // And this is what says it was the savepoint rather than the whole
        // transaction: the next effect still commits. A rollback that took the
        // transaction with it would lose this write too, and the refusal alone
        // cannot tell the two apart.
        expect(recorded[1]?.result).toEqual({ status: "ok", value: { kind: "written" } });
        expect(yield* workspaceText(database, "/after.txt")).toEqual("yes");
        expect(committedRoot(path)).not.toEqual(before);
        // Sanitized: no host path, no platform code.
        expect(run.output).not.toContain(root);
        expect(run.output).not.toMatch(/ENOTDIR|ENOENT|errno/i);
      },
      { decorateFilesystem: partialThenRefuse("/deep/nested", "/deep") },
    );
  });

  // WF25: an existing populated directory is adopted, its contents survive, and
  // the effect still commits so replay has something to restore. Also the
  // absolute case: a logical path is used as written, is not rebased under the
  // contextual directory, and never names anything on the host.
  it("WF25: an existing directory is adopted, and an absolute path is logical", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const path = runPath(root, database.record.runId);
      yield* mutateWorkspace(database, function* (workspace) {
        yield* workspace.filesystem.mkdir("/kept", { recursive: true });
        yield* workspace.filesystem.writeFile("/kept/inside.txt", "the bytes that were here");
      });

      const run = yield* runDocument(
        database,
        '<Dir path="kept">\n\nA\n\n</Dir>\n\n<Dir path="/nested/deep">\n\n<File path="b.md">B</File>\n\n</Dir>\n',
      );

      // Adopted, not replaced.
      expect(yield* workspaceText(database, "/kept/inside.txt")).toBe("the bytes that were here");
      // The absolute path named exactly that logical path. Not rebased under the
      // contextual directory — `/kept/nested` would be the rebased spelling and
      // it does not exist.
      expect(yield* workspaceStat(database, "/nested/deep")).toBe("directory");
      expect(yield* workspaceStat(database, "/kept/nested")).toBe(undefined);
      expect(yield* workspaceText(database, "/nested/deep/b.md")).toBe("B");
      // And it named nothing on the host: neither the logical path taken as a
      // host path, nor one beneath the run's own storage.
      expect(yield* exists("/nested/deep")).toBe(false);
      expect(yield* exists(join(root, "nested", "deep"))).toBe(false);
      expect(run.host.seen).toEqual([]);
      // Both ensures committed, and the last event's root is the run's own.
      const ensures = (yield* recordedFileEffects(database)).filter((effect) =>
        effect.name.startsWith("ensure-directory:"),
      );
      expect(ensures).toHaveLength(2);
      expect(rootOfLastEvent(path)).toEqual(committedRoot(path));
    });
  });

  // WF26: replay restores rather than repeats. The directory is privately
  // removed between the two runs, so a second ensure would be visible as it
  // coming back — and the counter says which of the two happened rather than
  // leaving it to be inferred.
  it("WF26: a completed replay restores the outcome without creating again", function* () {
    const root = yield* useStorageRoot();
    const made: string[] = [];
    yield* withStorage(
      root,
      function* () {
        const database = yield* createRun();
        const path = runPath(root, database.record.runId);
        const source = '<Dir path="once">\n\nINSIDE\n\n</Dir>\n';

        const first = yield* runDocument(database, source);
        expect(first.output).toContain("INSIDE");
        expect(made).toEqual(["/once"]);
        const after = committedRoot(path);

        // Removed behind the run's back, so a second creation would show.
        yield* mutateWorkspace(database, function* (workspace) {
          yield* workspace.filesystem.remove("/once", { recursive: true });
        });

        const replayed = yield* replayDocument(database, source);
        expect(replayed.output).toContain("INSIDE");
        // No second ensure: the counter is unchanged.
        expect(made).toEqual(["/once"]);
        // And the retained root is what a replay restores, not a new one.
        expect(rootOfLastEvent(path)).toEqual(after);
      },
      { decorateFilesystem: countingMkdirs(made) },
    );
  });
});
