/**
 * What one REPL entry's local file work retains, replays and refuses to guess.
 *
 * Everything here runs a document through canonical execution with the entry
 * host installed, so what is proven is the whole path: the authored component
 * calls the document filesystem, the composition beneath answers, and the
 * result is recorded once. A fixture that asserted on the record without the
 * composition would prove the bookkeeping and nothing about the answer.
 *
 * The contract these rows hold the host to is the REPL's execution model.
 * Replay restores recorded results; it does not restore the environment or
 * require it to match. So the rows that matter most are the ones where the two
 * disagree: a file changed behind a completed write, a checkout that is no
 * longer there, and a write whose result was never acknowledged.
 *
 * Each scenario gets its own checkout, HOME and journal, because what most of
 * them assert is what a *second* open of one history does.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  Err,
  Ok,
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
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runGit } from "./support/fixture-git.ts";
import { join } from "node:path";
import {
  API,
  cwd,
  FILES_ERROR,
  fileWriteSuccess,
  filesFailure,
  hostFilesHandler,
} from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation } from "@executablemd/core";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import { useReplRepositoryRecording } from "../src/repl/repositories/deno/provider.ts";
import { admitReplRepositoryHistory } from "../src/repl/repositories/admission.ts";
import { useCompositionComponents } from "@executablemd/git";
import {
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
  parseReplLocalRecord,
} from "../src/repl/repositories/records.ts";
import type { ReplLocalValue } from "../src/repl/repositories/records.ts";

interface Fixture {
  readonly root: string;
  readonly checkout: string;
}

/** One seeded checkout, with its own HOME, outside every other scenario's. */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-local-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    yield* runGit(root, ["init", "-b", "main", checkout]);
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    yield* provide({ root, checkout });
  });
}

/** What the composition beneath the recorder was actually asked to do. */
interface Counters {
  reads: string[];
  writes: string[];
  deletes: string[];
  ensures: string[];
  /** Every `git` subcommand this entry's session ran. */
  /** Each directory a live operation discovered a checkout from. */
  discoveries: string[];
  /** Every working directory the recorder resolved through the filesystem. */
  resolved: number;
}

function counters(): Counters {
  return { reads: [], writes: [], deletes: [], ensures: [], discoveries: [], resolved: 0 };
}

/**
 * The host filesystem, with the three mutations counted.
 *
 * Installed at `min`, the implementation slot, so the recorder's own middleware
 * and anything a scenario puts between them compose above it exactly as they do
 * in production.
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

/** A repository host that counts the `git` this entry ran. */
/**
 * The platform's own repository work, with the one call these rows count.
 *
 * `ambientCheckout` is what a live file operation asks before it knows whether
 * it is standing in a checkout, so counting it is the measurement these rows
 * want: a completed operation asks nothing. Every other method delegates
 * untouched, and no session, attachment or credential crosses this wrapper —
 * what it wraps is the twelve credential-free methods and nothing else.
 */
function countingOperations(counted: Counters): () => Operation<DenoRepositoryOperations> {
  return function* (): Operation<DenoRepositoryOperations> {
    const operations = yield* useDenoRepositoryOperations();
    return {
      ...operations,
      *ambientCheckout(from: string) {
        counted.discoveries.push(from);
        return yield* operations.ambientCheckout(from);
      },
    };
  };
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
  stream: DurableStream,
  counted: Counters,
  options: {
    readonly cwd?: string;
    readonly between?: () => Operation<void>;
  } = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const working = options.cwd ?? fixture.checkout;
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
    // `<Dir>` is this package's own vocabulary, and an entry that writes one
    // has to be able to resolve the name.
    yield* useCompositionComponents();
    if (options.between !== undefined) {
      yield* options.between();
    }
    // Registered the way the REPL host registers it: core initialization is
    // what establishes the recording, inside the scope the invocation owns.
    yield* Execution.around({
      *init(_args, next): Operation<void> {
        yield* useReplRepositoryRecording({ operations: countingOperations(counted) });
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

/** The names, in order, this journal recorded local operations under. */
function recordNames(events: readonly DurableEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_LOCAL)
    .map((event) => (event.type === "yield" ? event.description.name : ""));
}

/**
 * A journal with its last recorded result removed.
 *
 * What an interruption leaves: work that happened and whose outcome was never
 * acknowledged. There is nothing to replay for it, so a continuation takes the
 * ordinary live path and may do it again.
 */
function interrupted(events: readonly DurableEvent[]): InMemoryStream {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event !== undefined &&
      event.type === "yield" &&
      event.description.type === REPL_REPOSITORY_LOCAL
    ) {
      return new InMemoryStream(events.slice(0, index));
    }
  }
  throw new Error("the interruption fixture has no recorded result to remove");
}

/** Everything before the root Close, which is what a continuation reopens. */
function unfinished(events: readonly DurableEvent[]): InMemoryStream {
  return new InMemoryStream(events.filter((event) => event.type !== "close"));
}

/**
 * Data as it arrives from outside the type system.
 *
 * A provider is a contextual handler: at run time it can return whatever it
 * likes, and the contract these rows exercise is precisely the one the types
 * cannot enforce. Round-tripping through JSON is how a malformed value is built
 * here without asserting a type it does not have — the same device
 * `packages/core/tests/files-fatal.test.ts` uses for the outer validator.
 */
function fromOutside<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The publication a recorded write's success names.
 *
 * A record carries a write receipt, a read's text or nothing at all, so the
 * payload is narrowed here rather than at each assertion: a row about a write
 * that found a string would be reading a record of something else.
 */
function written(outcome: Result<ReplLocalValue> | undefined): string | undefined {
  if (outcome === undefined || !outcome.ok) {
    return undefined;
  }
  const value = outcome.value;
  return value === undefined || typeof value === "string" ? undefined : value.publication;
}

/** What one record says about the operation it describes. */
function localRecords(events: readonly DurableEvent[]) {
  return recordsOf(events, REPL_REPOSITORY_LOCAL).map((payload) => {
    const parsed = parseReplLocalRecord(payload);
    if (parsed === undefined) {
      throw new Error("a recorded local operation is not readable");
    }
    return parsed;
  });
}

describe("one entry's local file work", () => {
  it("records an authored write, a delete and a Dir ensure once", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();

    const first = yield* run(
      fixture,
      [
        "# entry",
        "",
        '<Dir path="drafts">',
        '<File path="note.md">first</File>',
        '<File path="obsolete.md">remove me</File>',
        '<File.Delete path="obsolete.md" />',
        "</Dir>",
      ].join("\n"),
      stream,
      counted,
    );

    expect(first.refusal).toBe(undefined);
    expect(yield* readTextFile(join(fixture.checkout, "drafts", "note.md"))).toBe("first");
    expect(yield* exists(join(fixture.checkout, "drafts", "obsolete.md"))).toBe(false);
    // The ensure comes before the children, and the children are this Dir's.
    expect(counted.ensures).toEqual(["drafts"]);
    expect(counted.writes).toEqual(["note.md", "obsolete.md"]);
    expect(counted.deletes).toEqual(["obsolete.md"]);
    // One record per operation, and one routing record for the entry.
    expect(recordsOf(first.events, REPL_REPOSITORY_LOCAL).length).toBe(4);
    expect(recordsOf(first.events, REPL_REPOSITORY_SELECTION).length).toBe(1);

    // And a continuation performs none of the four again, Dir ensure included.
    const replayed = counters();
    const again = yield* run(
      fixture,
      [
        "# entry",
        "",
        '<Dir path="drafts">',
        '<File path="note.md">first</File>',
        '<File path="obsolete.md">remove me</File>',
        '<File.Delete path="obsolete.md" />',
        "</Dir>",
      ].join("\n"),
      unfinished(first.events),
      replayed,
    );
    expect(again.refusal).toBe(undefined);
    expect(replayed.ensures).toEqual([]);
    expect(replayed.writes).toEqual([]);
    expect(replayed.deletes).toEqual([]);
    expect(replayed.discoveries).toEqual([]);
  });

  it("answers a completed operation from its record, against a changed file", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const stream = new InMemoryStream();
    const source = '<File path="note.md">first</File>';

    const first = yield* run(fixture, source, stream, live);
    expect(first.refusal).toBe(undefined);
    expect(live.writes).toEqual(["note.md"]);

    // The environment and the record now disagree, which the REPL's execution
    // model allows: the person reading the screen is what resolves it.
    yield* writeTextFile(join(fixture.checkout, "note.md"), "changed by somebody else");

    const replayed = counters();
    const again = yield* run(fixture, source, unfinished(first.events), replayed);

    expect(again.refusal).toBe(undefined);
    // Nothing was performed and nothing was resolved: no write, and no `git`.
    expect(replayed.writes).toEqual([]);
    expect(replayed.discoveries).toEqual([]);
    // And the file the person changed is still theirs.
    expect(yield* readTextFile(join(fixture.checkout, "note.md"))).toBe("changed by somebody else");
  });

  it("performs an unacknowledged operation again", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const stream = new InMemoryStream();
    const source = ['<File path="kept.md">kept</File>', '<File path="lost.md">lost</File>'].join(
      "\n",
    );

    const first = yield* run(fixture, source, stream, live);
    expect(live.writes).toEqual(["kept.md", "lost.md"]);

    const again = counters();
    const continued = yield* run(fixture, source, interrupted(first.events), again);

    expect(continued.refusal).toBe(undefined);
    // The acknowledged one replayed; the one whose result never landed ran.
    expect(again.writes).toEqual(["lost.md"]);
  });

  it("leaves work outside every checkout ordinary, unrecorded and repeatable", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    const source = '<File path="beside.md">beside</File>';

    // Started where there is no checkout at all, which is the reachable
    // outside case: an authored path may not escape the directory the run is
    // working in, so a `../` target is refused lexically long before routing.
    const performed = yield* run(fixture, source, stream, counted, { cwd: fixture.root });

    expect(performed.refusal).toBe(undefined);
    expect(yield* readTextFile(join(fixture.root, "beside.md"))).toBe("beside");
    expect(counted.writes).toEqual(["beside.md"]);
    // The entry looked once, remembered that there is none, and recorded no
    // operation — a record would claim a checkout this write is not in.
    expect(recordsOf(performed.events, REPL_REPOSITORY_LOCAL)).toEqual([]);
    expect(recordsOf(performed.events, REPL_REPOSITORY_SELECTION).length).toBe(1);

    // And because nothing was recorded, a continuation performs it again.
    const again = counters();
    const continued = yield* run(fixture, source, unfinished(performed.events), again, {
      cwd: fixture.root,
    });
    expect(continued.refusal).toBe(undefined);
    expect(again.writes).toEqual(["beside.md"]);
  });

  it("recognizes a checkout reached through a symlinked working directory", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    // A link to the checkout, which is how a host's temporary root is commonly
    // reached — `/var` for `/private/var` on macOS. A checkout discovered by
    // its real path does not appear to contain a file addressed through the
    // link unless the working directory is resolved first.
    const linked = join(fixture.root, "through-a-link");
    yield* until(symlink(fixture.checkout, linked));

    const performed = yield* run(fixture, '<File path="linked.md">first</File>', stream, counted, {
      cwd: linked,
    });

    expect(performed.refusal).toBe(undefined);
    expect(yield* readTextFile(join(fixture.checkout, "linked.md"))).toBe("first");
    // Routed as inside the checkout, which is what the record says.
    expect(recordsOf(performed.events, REPL_REPOSITORY_LOCAL).length).toBe(1);
  });

  it("replays two equal writes in the order they were answered", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    const source = ['<File path="twice.md">same</File>', '<File path="twice.md">same</File>'].join(
      "\n",
    );

    const first = yield* run(fixture, source, stream, counted);
    expect(counted.writes).toEqual(["twice.md", "twice.md"]);

    // One name at two ordered positions, which is valid: a reader that
    // deduplicated by name would refuse a document that is allowed.
    const names = recordNames(first.events);
    expect(names.length).toBe(2);
    expect(names[0]).toBe(names[1]);

    const replayed = counters();
    const again = yield* run(fixture, source, unfinished(first.events), replayed);
    expect(again.refusal).toBe(undefined);
    expect(replayed.writes).toEqual([]);
  });

  it("offers nested work before the mutation that encloses it", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    const source = '<File path="outer.md"><File path="inner.md">inner</File></File>';

    const first = yield* run(fixture, source, stream, counted);
    expect(first.refusal).toBe(undefined);
    // A write's content expands before the write, so the nested one happened
    // first — and the journal holds them in that order.
    expect(counted.writes).toEqual(["inner.md", "outer.md"]);
    const records = localRecords(first.events);
    expect(records.map((record) => record.request.path)).toEqual(["inner.md", "outer.md"]);

    const replayed = counters();
    const again = yield* run(fixture, source, unfinished(first.events), replayed);
    expect(again.refusal).toBe(undefined);
    expect(replayed.writes).toEqual([]);
  });

  it("keeps two concurrent branches' equal requests on their own coroutines", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    // Two `<Spawn>` children of one `<All>` are concurrent durable coroutines of
    // the one that reached the `<All>`, each with its own journal position. They
    // write the same path with the same content, so the two records carry one
    // name — and what tells them apart is which coroutine they belong to rather
    // than anything this feature adds.
    const source = [
      "<All>",
      '<Spawn><File path="same.md">same</File></Spawn>',
      '<Spawn><File path="same.md">same</File></Spawn>',
      "</All>",
    ].join("\n");

    const first = yield* run(fixture, source, stream, counted);
    expect(first.refusal).toBe(undefined);
    expect(yield* readTextFile(join(fixture.checkout, "same.md"))).toBe("same");

    // Two writes, one name, two coroutines: the name is what the request asks
    // and the coroutine is where it was asked.
    const writes = first.events.filter(
      (event) =>
        event.type === "yield" &&
        event.description.type === REPL_REPOSITORY_LOCAL &&
        event.description.name.includes("file-write"),
    );
    expect(writes.length).toBe(2);
    const named = new Set(
      writes.map((event) => (event.type === "yield" ? event.description.name : "")),
    );
    expect(named.size).toBe(1);
    const coroutines = new Set(
      writes.map((event) => (event.type === "yield" ? event.coroutineId : "")),
    );
    expect(coroutines.size).toBe(2);
    expect(counted.writes).toEqual(["same.md", "same.md"]);

    // Repeated once: every operation replays on its own coroutine, and no
    // native work happens again.
    const replayed = counters();
    const again = yield* run(fixture, source, unfinished(first.events), replayed);
    expect(again.refusal).toBe(undefined);
    expect(replayed.writes).toEqual([]);
    expect(replayed.ensures).toEqual([]);
    expect(replayed.discoveries).toEqual([]);
  });

  it("continues a prefix each concurrent branch saved its own routing in", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    const question = '<Elicit schema={{ type: "object" }} as="answer">Continue?</Elicit>';
    // Both branches mutate, so both save where they are working — each at its
    // own position in its own coroutine. One of them reads a file first, so the
    // two do not reach their first write in lockstep. Then both stop at a
    // question, which is what leaves a prefix with no close in it.
    const source = [
      "<All>",
      `<Spawn><File path="a.md">A</File>${question}</Spawn>`,
      `<Spawn><File path="seed.md" /><File path="b.md">B</File>${question}</Spawn>`,
      "</All>",
      '<File path="sentinel.md">new suffix</File>',
    ].join("\n");

    const waiting = withResolvers<void>();
    let asked = 0;
    const live = yield* spawn(() =>
      run(fixture, source, stream, counted, {
        *between(): Operation<void> {
          yield* Elicitation.around({
            *elicit(): Operation<unknown> {
              asked += 1;
              if (asked === 2) {
                waiting.resolve();
              }
              // Nobody answers, so this is where the entry is when it is left.
              return yield* suspend();
            },
          });
        },
      }),
    );

    yield* race([
      waiting.operation,
      (function* (): Operation<never> {
        yield* sleep(10_000);
        throw new Error("both branches never reached their questions");
      })(),
    ]);

    // The prefix exactly as the interrupted run left it: nothing removed and
    // nothing reordered.
    const prefix = [...(yield* stream.readAll())];
    yield* live.halt();

    expect(prefix.some((event) => event.type === "close")).toBe(false);
    // Both branches wrote, and nothing else did. Sorted, because which of two
    // concurrent branches reaches its write first is the scheduler's business
    // and asserting one order here would make this row fail for a reason it is
    // not about. Copied before sorting: `toSorted` is ES2023 and the Node
    // typecheck's lib is ES2022.
    expect([...counted.writes].sort()).toEqual(["a.md", "b.md"]);
    // The condition that makes this row discriminating: two saved routings, on
    // two different coroutines. A host that remembered routing per *entry*
    // would skip one of them and the continuation below would be refused.
    const selections = prefix.filter(
      (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_SELECTION,
    );
    expect(selections.length).toBe(2);
    expect(
      new Set(selections.map((event) => (event.type === "yield" ? event.coroutineId : ""))).size,
    ).toBe(2);

    // Continued unchanged, with answers available this time.
    const replayed = counters();
    let answered = 0;
    const again = yield* run(fixture, source, new InMemoryStream(prefix), replayed, {
      *between(): Operation<void> {
        yield* Elicitation.around({
          // deno-lint-ignore require-yield
          *elicit(): Operation<unknown> {
            answered += 1;
            return {};
          },
        });
      },
    });

    expect(again.refusal).toBe(undefined);
    // Both completed writes came from history, both questions were answerable,
    // and the work after them ran once.
    expect(replayed.writes).toEqual(["sentinel.md"]);
    expect(answered).toBe(2);
    expect(yield* readTextFile(join(fixture.checkout, "sentinel.md"))).toBe("new suffix");
    // Discovery stays shared. The suffix is new work in a coroutine that saved
    // no routing, so it does look — once, for the whole continuation, rather
    // than once per coroutine that asks.
    expect(replayed.discoveries).toHaveLength(1);
  });

  it("records what the composition answered, without performing it itself", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    let answered = 0;
    const source = '<File path="staged.md">staged</File>';

    // A provider that answers the write itself, exactly as a transactional one
    // does. Installed beneath the recorder and above the host, so what the
    // recorder keeps is the answer the whole composition gave.
    const answering = function* (): Operation<void> {
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *writeTextFile(): Operation<Result<ReturnType<typeof fileWriteSuccess>>> {
            answered += 1;
            return Ok(fileWriteSuccess("transaction-staged"));
          },
        },
        { at: "min" },
      );
    };

    const first = yield* run(fixture, source, stream, counted, { between: answering });
    expect(first.refusal).toBe(undefined);
    expect(answered).toBe(1);
    // Nothing reached the host, and the publication the answer named is kept.
    expect(counted.writes).toEqual([]);
    const records = localRecords(first.events);
    expect(records.length).toBe(1);
    expect(records[0]?.outcome.ok).toBe(true);
    expect(written(records[0]?.outcome)).toBe("transaction-staged");

    answered = 0;
    const replayed = counters();
    const again = yield* run(fixture, source, unfinished(first.events), replayed, {
      between: answering,
    });
    expect(again.refusal).toBe(undefined);
    // The same semantics, and the answering provider was never asked.
    expect(answered).toBe(0);
    expect(replayed.writes).toEqual([]);
  });

  it("keeps the received request as the identity when a provider transforms it", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    let delegated = 0;
    const source = '<File path="note.md">first</File>';

    const transforming = function* (): Operation<void> {
      yield* API.Files.around(
        {
          *writeTextFile([input], next) {
            delegated += 1;
            return yield* next({ ...input, path: "elsewhere.md", content: "TRANSFORMED" });
          },
        },
        { at: "min" },
      );
    };

    const first = yield* run(fixture, source, stream, counted, { between: transforming });
    expect(first.refusal).toBe(undefined);
    // Delegated once, and the host performed the provider's version of it.
    expect(delegated).toBe(1);
    expect(counted.writes).toEqual(["elsewhere.md"]);
    expect(yield* readTextFile(join(fixture.checkout, "elsewhere.md"))).toBe("TRANSFORMED");
    // The record names what the document asked for. A downstream path is
    // provider behavior, not a second authored identity.
    const records = localRecords(first.events);
    expect(records[0]?.request).toEqual({
      cwd: fixture.checkout,
      path: "note.md",
      content: "first",
    });

    delegated = 0;
    const replayed = counters();
    yield* run(fixture, source, unfinished(first.events), replayed, { between: transforming });
    expect(delegated).toBe(0);
    expect(replayed.writes).toEqual([]);
  });

  it("replays an ordinary refusal as the refusal it was", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    let refused = 0;
    const source = '<File.Delete path="seed.md" />';

    const refusing = function* (): Operation<void> {
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *deleteFile(): Operation<Result<void>> {
            refused += 1;
            return Err(
              filesFailure({ operation: "delete", phase: "access", reason: "permission-denied" }),
            );
          },
        },
        { at: "min" },
      );
    };

    const first = yield* run(fixture, source, stream, counted, { between: refusing });
    expect(refused).toBe(1);
    // Refused without delegating, and the file is still there.
    expect(counted.deletes).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "seed.md"))).toBe(true);
    // A refusal the document can read, and it is in the document's output.
    expect(first.output).toContain("seed.md");
    const records = localRecords(first.events);
    expect(records[0]?.outcome.ok).toBe(false);

    refused = 0;
    const replayed = counters();
    const again = yield* run(fixture, source, unfinished(first.events), replayed, {
      between: refusing,
    });
    expect(again.output).toContain("seed.md");
    expect(refused).toBe(0);
    expect(replayed.deletes).toEqual([]);
  });

  it("answers completed results with the checkout gone", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    const source = [
      '<Dir path="drafts">',
      '<File path="note.md">first</File>',
      '<File path="note.md" as="held" />',
      '<File.Delete path="note.md" />',
      "</Dir>",
      "{held}",
    ].join("\n");

    const first = yield* run(fixture, source, stream, counted);
    expect(first.refusal).toBe(undefined);
    // One ensure, one write, one read and one delete.
    expect(localRecords(first.events).length).toBe(4);
    expect(first.output).toContain("first");

    // The checkout the records were made in is no longer there. A completed
    // operation is still answered, because answering it reads nothing.
    yield* rm(fixture.checkout, { recursive: true, force: true });

    const replayed = counters();
    const again = yield* run(fixture, source, unfinished(first.events), replayed);
    expect(again.refusal).toBe(undefined);
    expect(replayed.reads).toEqual([]);
    expect(replayed.writes).toEqual([]);
    expect(replayed.deletes).toEqual([]);
    expect(replayed.ensures).toEqual([]);
    // No discovery, and no canonicalization of a directory that is gone.
    expect(replayed.discoveries).toEqual([]);
    // And the binding a continuation offers is the text the read answered with
    // the first time, from a file that no longer exists.
    expect(again.output).toContain("first");
  });
  it("leaves no completed result when the acknowledgement is cancelled", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const events: DurableEvent[] = [];
    const reached = withResolvers<void>();
    const held = withResolvers<void>();
    const source = '<File path="note.md">first</File>';

    // A barrier between the native work and its acknowledgement: the write has
    // happened, and the append has not.
    const barrier: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [...events];
      },
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === REPL_REPOSITORY_LOCAL) {
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

    // The work happened, and nothing says it did.
    expect(counted.writes).toEqual(["note.md"]);
    expect(recordsOf(events, REPL_REPOSITORY_LOCAL)).toEqual([]);
    expect(yield* readTextFile(join(fixture.checkout, "note.md"))).toBe("first");

    // So a continuation takes the live path and may do it again, which is the
    // window this feature trades for not snapshotting anybody's working tree.
    const again = counters();
    const continued = yield* run(fixture, source, new InMemoryStream([...events]), again);
    expect(continued.refusal).toBe(undefined);
    expect(again.writes).toEqual(["note.md"]);
  });

  it("keeps a failed acknowledgement fatal, and runs nothing after it", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const events: DurableEvent[] = [];
    const rejecting: DurableStream = {
      *readAll(): Operation<DurableEvent[]> {
        return [...events];
      },
      *append(event: DurableEvent): Operation<void> {
        if (event.type === "yield" && event.description.type === REPL_REPOSITORY_LOCAL) {
          throw new Error("the journal refused this event");
        }
        events.push(event);
      },
    };

    const run1 = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<File path="note.md">first</File>',
        "</PrintErrors>",
        '<File path="sentinel.md">sentinel</File>',
      ].join("\n"),
      rejecting,
      counted,
    );

    // The write happened; the durability failure is fatal; and the sentinel
    // after it never ran, printing region or not.
    expect(counted.writes).toEqual(["note.md"]);
    expect(run1.refusal === undefined ? run1.output : run1.refusal).not.toContain("sentinel");
    expect(recordsOf(events, REPL_REPOSITORY_LOCAL)).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "sentinel.md"))).toBe(false);
  });

  it("keeps a malformed provider answer fatal, with no completion and no sentinel", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();

    const malformed = function* (): Operation<void> {
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *writeTextFile(): Operation<Result<never>> {
            // A refusal in no vocabulary this boundary can read. A provider
            // that cannot describe what it did may not have done it, so this
            // is a broken contract rather than an outcome to write down.
            return Err(new Error("something went wrong"));
          },
        },
        { at: "min" },
      );
    };

    const performed = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<File path="note.md">first</File>',
        "</PrintErrors>",
        '<File path="sentinel.md">sentinel</File>',
      ].join("\n"),
      stream,
      counted,
      { between: malformed },
    );

    // No ordinary completion was written for it, and nothing ran after it.
    expect(recordsOf(performed.events, REPL_REPOSITORY_LOCAL)).toEqual([]);
    expect(counted.writes).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "sentinel.md"))).toBe(false);
  });

  it("keeps a malformed unit success fatal, with no completion and no sentinel", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();

    const malformed = function* (): Operation<void> {
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *deleteFile(): Operation<Result<void>> {
            // A delete answers with nothing at all. A payload here describes an
            // outcome this operation does not have, so the provider has broken
            // its contract and may not have removed anything.
            return fromOutside<Result<void>>({ ok: true, value: "unexpected" });
          },
        },
        { at: "min" },
      );
    };

    const performed = yield* run(
      fixture,
      [
        "<PrintErrors>",
        '<File.Delete path="seed.md" />',
        "</PrintErrors>",
        '<File path="sentinel.md">sentinel</File>',
      ].join("\n"),
      stream,
      counted,
      { between: malformed },
    );

    // Nothing was written down for it, and nothing ran after it.
    expect(recordsOf(performed.events, REPL_REPOSITORY_LOCAL)).toEqual([]);
    expect(counted.deletes).toEqual([]);
    expect(yield* exists(join(fixture.checkout, "sentinel.md"))).toBe(false);
  });

  it("records a refusal it does not recognize as the ordinary generic one", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    const source = [
      "<PrintErrors>",
      '<File.Delete path="seed.md" />',
      "</PrintErrors>",
      '<File path="after.md">after</File>',
    ].join("\n");

    const unknown = function* (): Operation<void> {
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *deleteFile(): Operation<Result<void>> {
            // Readable data in this operation's own shape, naming a phase this
            // version does not know. The provider *did* describe a failure,
            // just not a recognized one, so the document carries on past the
            // generic sentence — and nothing it planted travels with it.
            return Err(
              Object.assign(new Error("delete failed at /planted/absolute/path"), {
                data: { type: FILES_ERROR, operation: "delete", phase: "nowhere" },
              }),
            );
          },
        },
        { at: "min" },
      );
    };

    const performed = yield* run(fixture, source, stream, counted, { between: unknown });

    // An ordinary printed refusal, in the vocabulary's own words, and the work
    // after it ran.
    expect(performed.refusal).toBe(undefined);
    expect(performed.output).toContain("the filesystem operation failed");
    expect(performed.output).not.toContain("/planted/absolute/path");
    expect(yield* readTextFile(join(fixture.checkout, "after.md"))).toBe("after");

    // Recorded as the refusal it was normalized to, and replayed as that same
    // refusal without the provider being asked again.
    const records = localRecords(performed.events);
    expect(records.length).toBe(2);
    expect(records[0]?.outcome.ok).toBe(false);

    const replayed = counters();
    let asked = 0;
    const again = yield* run(fixture, source, unfinished(performed.events), replayed, {
      *between(): Operation<void> {
        yield* API.Files.around(
          {
            // deno-lint-ignore require-yield
            *deleteFile(): Operation<Result<void>> {
              asked += 1;
              return Err(
                Object.assign(new Error("delete failed"), {
                  data: { type: FILES_ERROR, operation: "delete", phase: "nowhere" },
                }),
              );
            },
          },
          { at: "min" },
        );
      },
    });
    expect(again.refusal).toBe(undefined);
    expect(again.output).toContain("the filesystem operation failed");
    expect(asked).toBe(0);
    expect(replayed.deletes).toEqual([]);
  });
});
