/**
 * Tier R1 — the paired history, and the one moment its writer moves (#883, J8).
 *
 * An execution that has a Sidekick owns two files rather than one:
 * `v1/<execution>/entries.jsonl` holds exactly the serialized DurableEvents it
 * always held, and `sidekick.jsonl` beside it holds the conversation. Every row
 * here is about the seam between them — what makes a pair a pair, what a
 * half-written one does, and what happens to an entry that was mid-append when
 * its execution was upgraded.
 *
 * The filesystem is real, in a per-run temporary directory, because everything
 * in this tier is about bytes on disk: which file a record reached, whether an
 * original survived, whether a digest still matches. An in-memory host would
 * be asserting the test's own bookkeeping. What *is* injected is the host's two
 * operations — exclusive create and append — so a case can hold a real append
 * open while the handoff waits for it, which is the only way to observe the
 * ordering the contract is made of.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensure, race, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { ReplHost } from "../src/repl/host.ts";
import { readRecords } from "../src/repl/journal.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  parseSidekickRecord,
  readSidekickRecords,
  SIDEKICK_FILE,
  serializeSidekickRecord,
} from "../src/repl/sidekick/history.ts";
import type { SidekickRecord } from "../src/repl/sidekick/history.ts";
import { pairedReplRepository } from "../src/repl/sidekick/repository.ts";
import { SidekickWriter } from "../src/repl/sidekick/history.ts";

/**
 * One repository root per case, removed when that case's scope ends.
 *
 * Per case rather than per file, so a row that leaves a half-written pair
 * behind cannot be what the next row is reading.
 */
let root = "";

function* useRoot(): Operation<void> {
  root = yield* until(mkdtemp(join(tmpdir(), "xmd-sidekick-storage-")));
  const created = root;
  yield* ensure(() => until(rm(created, { recursive: true, force: true })));
}

/** A gate a case installs to hold one real append open. */
interface Gate {
  /** Called for every append; a returned operation holds that append. */
  hold?: (path: string, record: string) => Operation<void> | undefined;
  /** Every path an append actually reached, in order. */
  readonly reached: string[];
}

/**
 * The host's two operations, over the real filesystem.
 *
 * This is the half a runtime entrypoint owns. The gate sits *inside*
 * `appendRecord`, before the write, so a held append is genuinely in flight:
 * the writer's own count is raised and the handoff's wait has something to wait
 * for. A gate that held the caller instead would prove nothing about ordering.
 */
function useGatedHost(name: string, gate: Gate): Operation<void> {
  return ReplHost.around(
    {
      // deno-lint-ignore require-yield
      *identify(): Operation<string> {
        return name;
      },
      *createExclusive([path]: [string]): Operation<void> {
        const handle = yield* until(open(path, "wx"));
        yield* until(handle.close());
      },
      *appendRecord([path, record]: [string, string]): Operation<void> {
        const holding = gate.hold?.(path, record);
        if (holding !== undefined) {
          yield* holding;
        }
        yield* until(appendFile(path, record));
        gate.reached.push(path);
      },
    },
    { at: "min" },
  );
}

function fresh(): Gate {
  return { reached: [] };
}

/** One ordinary entry record, as a run would write one. */
function event(coroutineId: string): DurableEvent {
  return {
    type: "yield",
    coroutineId,
    description: { type: "test_effect", name: coroutineId, input: null },
    result: { status: "ok", value: coroutineId },
  } as unknown as DurableEvent;
}

/**
 * The same record with its members written in another order.
 *
 * A valid event, through the repository's own serializer, whose encoding is not
 * the one `parseDurableEvent` rebuilds — which is what makes "copy the bytes"
 * different from "copy the events". A fixture that happened to use the parser's
 * ordering would pass either way, which is exactly how the first version of
 * this tier passed while re-encoding the prefix.
 */
function reordered(value: string): DurableEvent {
  return {
    result: { status: "ok", value },
    coroutineId: "root",
    description: { name: value, type: "test_effect" },
    type: "yield",
  } as unknown as DurableEvent;
}

/** Write an older single-file history holding these events. */
function* legacyFile(execution: string, events: readonly DurableEvent[]): Operation<string> {
  const path = join(root, `${execution}.jsonl`);
  yield* until(mkdir(root, { recursive: true }));
  yield* until(writeFile(path, events.map((held) => serializeDurableEvent(held)).join("")));
  return path;
}

function pairPath(execution: string, file: string): string {
  return join(root, PAIRED_DIRECTORY, execution, file);
}

/** Write a Sidekick file holding exactly these lines, for the reader table. */
function* sidekickFile(execution: string, lines: readonly string[]): Operation<string> {
  const directory = join(root, PAIRED_DIRECTORY, execution);
  yield* until(mkdir(directory, { recursive: true }));
  yield* until(writeFile(join(directory, ENTRIES_FILE), ""));
  const path = join(directory, SIDEKICK_FILE);
  yield* until(writeFile(path, lines.join("")));
  return path;
}

function line(record: SidekickRecord): string {
  return serializeSidekickRecord(record);
}

/** The same line with its terminator removed, for an unfinished final write. */
function unterminated(record: SidekickRecord): string {
  return serializeSidekickRecord(record).slice(0, -1);
}

function* text(path: string): Operation<string> {
  return yield* until(readFile(path, "utf8"));
}

function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** What one opening refused with, or nothing when it did not refuse. */
function* refusal(work: () => Operation<unknown>): Operation<string | undefined> {
  try {
    yield* work();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Tier R1 — a published pair, and the writer handoff that creates one", () => {
  it("R1a: a new execution is published as a pair, and reopening recognizes it", function* () {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("new-one", gate);
    const repository = pairedReplRepository(root);

    const created = yield* repository.create();
    expect(created.id).toBe("new-one");
    expect(created.chat.form).toBe("paired");

    // Both records, in order, before anything else: the owner names the
    // format and the execution, and `ready` is what says the pair may be used.
    const records = yield* readSidekickRecords(pairPath("new-one", SIDEKICK_FILE));
    expect(records.map((record) => record.kind)).toEqual(["owner", "ready"]);
    expect(records[0]).toMatchObject({ version: 1, execution: "new-one" });
    // Nothing to be the origin of: this history was never anything else.
    expect(records[0]).not.toHaveProperty("origin");

    // An entry record written now reaches the pair's entry file and no other.
    yield* created.stream.append(event("one"));
    expect(gate.reached.at(-1)).toBe(pairPath("new-one", ENTRIES_FILE));

    const reopened = yield* repository.open("new-one");
    expect(reopened.chat.form).toBe("paired");
    expect((yield* reopened.stream.readAll()).length).toBe(1);
  });

  it("975: publication establishes components and cold reads never repair it", function* () {
    yield* useRoot();
    yield* useGatedHost("workspace", fresh());
    const repository = pairedReplRepository(root);
    const created = yield* repository.create();
    const components = pairPath(created.id, "components");
    expect((yield* until(stat(components))).isDirectory()).toBe(true);
    yield* until(writeFile(join(components, "Greeting.md"), "Hello"));
    yield* repository.open(created.id);
    expect(yield* until(readFile(join(components, "Greeting.md"), "utf8"))).toBe("Hello");
    yield* until(rm(components, { recursive: true }));
    const before = yield* until(readFile(pairPath(created.id, SIDEKICK_FILE), "utf8"));
    yield* repository.open(created.id);
    expect(yield* until(readFile(pairPath(created.id, SIDEKICK_FILE), "utf8"))).toBe(before);
    let absent = false;
    try {
      yield* until(stat(components));
    } catch {
      absent = true;
    }
    expect(absent).toBe(true);
  });

  it("975: an initial components non-directory refuses without replacing it", function* () {
    yield* useRoot();
    yield* useGatedHost("blocked-components", fresh());
    const target = pairPath("blocked-components", "components");
    yield* until(mkdir(join(root, PAIRED_DIRECTORY, "blocked-components"), { recursive: true }));
    yield* until(writeFile(target, "preserved"));
    let refused = false;
    try {
      yield* pairedReplRepository(root).create();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(yield* until(readFile(target, "utf8"))).toBe("preserved");
  });

  it("R1b: cold-opening an older single file converts nothing and writes nothing", function* () {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("legacy-cold", gate);
    const path = yield* legacyFile("legacy-cold", [event("one"), event("two")]);
    const before = yield* text(path);

    const opened = yield* pairedReplRepository(root).open("legacy-cold");

    expect(opened.chat.form).toBe("legacy");
    expect((yield* opened.stream.readAll()).length).toBe(2);
    // The whole claim: no append, no pair, and the file exactly as it was.
    expect(gate.reached).toEqual([]);
    expect(yield* text(path)).toBe(before);
    expect(
      yield* refusal(() => readSidekickRecords(pairPath("legacy-cold", SIDEKICK_FILE))),
    ).toContain("missing from its pair");
  });

  it("R1c: the upgrade copies exact bytes, and waits for an append already in flight", function* () {
    yield* useRoot();
    const gate = fresh();
    const released = withResolvers<void>();
    const started = withResolvers<void>();
    yield* useGatedHost("legacy-hot", gate);
    const path = yield* legacyFile("legacy-hot", [event("one")]);
    const repository = pairedReplRepository(root);
    const opened = yield* repository.open("legacy-hot");

    // One real append, held open inside the host. Only the entry file is
    // gated: the pair's own writes must not be blocked by it.
    gate.hold = (target) => {
      if (target !== path) {
        return undefined;
      }
      gate.hold = undefined;
      return (function* (): Operation<void> {
        started.resolve();
        yield* released.operation;
      })();
    };
    const appending = yield* spawn(() => opened.stream.append(event("two")));
    yield* started.operation;

    const upgrading = yield* spawn(() => repository.upgrade(opened));
    // The handoff cannot have copied anything yet: the record it would have
    // to include has not reached the file.
    expect(gate.reached).toEqual([]);

    released.resolve();
    yield* appending;
    const upgraded = yield* upgrading;

    expect(upgraded.chat.form).toBe("paired");
    // The copied prefix is exactly the older file's bytes, and the owner
    // record names that file by size and digest.
    const original = yield* text(path);
    expect(yield* text(pairPath("legacy-hot", ENTRIES_FILE))).toBe(original);
    const records = yield* readSidekickRecords(pairPath("legacy-hot", SIDEKICK_FILE));
    expect(records.map((record) => record.kind)).toEqual(["owner", "ready"]);
    expect(records[0]).toMatchObject({
      origin: {
        bytes: new TextEncoder().encode(original).length,
        sha256: digest(original),
        records: 2,
      },
    });
    // The held record is in the copied prefix, which is what waiting bought.
    expect((yield* readRecords(pairPath("legacy-hot", ENTRIES_FILE))).length).toBe(2);
    // And the original is retained, not deleted.
    expect(yield* text(path)).toBe(original);
  });

  it("R1d: after the handoff the same writer appends only to the new file", function* () {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("legacy-after", gate);
    const path = yield* legacyFile("legacy-after", [event("one")]);
    const repository = pairedReplRepository(root);
    const opened = yield* repository.open("legacy-after");
    // The object an already-running entry would be holding.
    const held = opened.stream;

    yield* repository.upgrade(opened);
    gate.reached.length = 0;
    yield* held.append(event("after"));

    expect(gate.reached).toEqual([pairPath("legacy-after", ENTRIES_FILE)]);
    expect(yield* text(path)).not.toContain("after");
    expect(yield* text(pairPath("legacy-after", ENTRIES_FILE))).toContain("after");
  });

  /**
   * One legacy execution with a record genuinely in flight, and an upgrade
   * inside the hold that record keeps it waiting in.
   *
   * `cancel` is the whole difference between the two rows below: a handoff
   * halted while it is acquiring the hold, and one that fails on its own in the
   * ordinary way. Both must leave the writer usable, and the only way to tell a
   * release that covers acquisition from one that does not is to interrupt it
   * there — which needs a signal saying the hold has been taken and is waiting,
   * not a sleep hoping it has.
   */
  function* cancelledHandoff(name: string, cancel: boolean): Operation<string> {
    yield* useRoot();
    const gate = fresh();
    const released = withResolvers<void>();
    const started = withResolvers<void>();
    // Released at the end whatever happened, so a row that fails mid-hold does
    // not leave the suite waiting on its own latch.
    yield* ensure(() => released.resolve());
    yield* useGatedHost(name, gate);
    const path = yield* legacyFile(name, [event("one")]);
    const repository = pairedReplRepository(root);
    const opened = yield* repository.open(name);

    // One real append, held open inside the host, so the writer's own count is
    // raised and the hold below has something to wait for.
    gate.hold = (target) => {
      if (target !== path) {
        return undefined;
      }
      gate.hold = undefined;
      return (function* (): Operation<void> {
        started.resolve();
        yield* released.operation;
      })();
    };
    const appending = yield* spawn(() => opened.stream.append(event("two")));
    yield* started.operation;

    // When the handoff has taken the hold and is waiting inside it. Observed
    // through the writer's own public wait, which `hold()` calls immediately
    // after marking itself held — the method still does what it did, and this
    // only says when it was entered.
    const entered = withResolvers<void>();
    const waiting = opened.stream.settled.bind(opened.stream);
    opened.stream.settled = function* (): Operation<void> {
      entered.resolve();
      yield* waiting();
    };

    const upgrading = yield* spawn(function* (): Operation<void> {
      try {
        yield* repository.upgrade(opened);
      } catch (error) {
        // The missing directory is the ordinary-failure arm's own refusal, and
        // it has to reach the same release the cancelled arm does.
        if (!cancel) {
          return;
        }
        throw error;
      }
    });
    yield* entered.operation;

    if (cancel) {
      yield* upgrading.halt();
    }
    released.resolve();
    yield* appending;
    if (!cancel) {
      yield* upgrading;
    }

    // The record a still-running entry writes next. Whether it lands at all is
    // the question: a hold nothing released would make this wait forever.
    const answer = yield* race([
      (function* (): Operation<string> {
        yield* opened.stream.append(event("three"));
        return "appended";
      })(),
      // A deadline that bounds the failure. It establishes no readiness: the
      // append either goes through or this row is about a writer nobody can
      // use again.
      (function* (): Operation<string> {
        yield* sleep(2000);
        return "held forever";
      })(),
    ]);
    return answer;
  }

  it("R1u: a handoff cancelled while it acquires the hold leaves the writer usable", function* () {
    // Halted inside `hold()`, before the publication begins. The release has to
    // be established before the hold is taken, because this is the one window
    // in which the writer is already held and nothing has been entered that
    // could unwind.
    expect(yield* cancelledHandoff("legacy-cancelled", true)).toBe("appended");
  });

  it("R1u: control — a handoff that fails on its own releases the same writer", function* () {
    // The same hold, the same record in flight, and an ordinary refusal instead
    // of a cancellation: the arm that was already covered, kept beside the one
    // that was not so a regression names which of the two it broke.
    expect(yield* cancelledHandoff("legacy-refused", false)).toBe("appended");
  });

  it("R1e: an upgrade interrupted before ready leaves the original and refuses the pair", function* () {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("legacy-torn", gate);
    const path = yield* legacyFile("legacy-torn", [event("one")]);
    const before = yield* text(path);
    const repository = pairedReplRepository(root);
    const opened = yield* repository.open("legacy-torn");

    // Fail the `ready` write, which is the last of the four. Everything
    // before it has happened, so this is the exact interruption the contract
    // names rather than a missing directory.
    gate.hold = (_target, record) => {
      if (!record.includes('"kind":"ready"')) {
        return undefined;
      }
      return (function* (): Operation<void> {
        throw new Error("the host lost power");
      })();
    };
    expect(yield* refusal(() => repository.upgrade(opened))).toContain("lost power");

    // The original survives untouched, and the half-written pair refuses
    // rather than presenting itself as a history to continue.
    expect(yield* text(path)).toBe(before);
    expect(yield* refusal(() => repository.open("legacy-torn"))).toContain(
      "never acknowledged as ready",
    );
  });
});

describe("Tier R1 — what a reader refuses, and never repairs", () => {
  const PREFIX: SidekickRecord[] = [
    { kind: "owner", version: 1, execution: "reader" },
    { kind: "ready" },
  ];

  it("R1f: an unknown format version refuses", function* () {
    yield* useRoot();
    yield* useGatedHost("reader-version", fresh());
    yield* sidekickFile("reader-version", [
      line({ kind: "owner", version: 2, execution: "reader-version" }),
      line({ kind: "ready" }),
    ]);

    expect(yield* refusal(() => pairedReplRepository(root).open("reader-version"))).toContain(
      "version 2",
    );
  });

  it("R1g: a chat history whose final record was never finished refuses", function* () {
    yield* useRoot();
    yield* useGatedHost("reader-partial", fresh());
    // No terminating newline: the last write did not finish.
    yield* sidekickFile("reader-partial", [
      line({ ...PREFIX[0]!, execution: "reader-partial" } as SidekickRecord),
      unterminated({ kind: "ready" }),
    ]);

    expect(yield* refusal(() => pairedReplRepository(root).open("reader-partial"))).toContain(
      "never finished writing",
    );
  });

  it("R1h: a record this version cannot read refuses, and quotes none of it", function* () {
    yield* useRoot();
    yield* useGatedHost("reader-unknown", fresh());
    yield* sidekickFile("reader-unknown", [
      line({ ...PREFIX[0]!, execution: "reader-unknown" } as SidekickRecord),
      line({ kind: "ready" }),
      '{"kind":"something-else","secret":"do not echo me"}\n',
    ]);

    const message = yield* refusal(() => pairedReplRepository(root).open("reader-unknown"));
    expect(message).toContain("cannot read (record 3)");
    expect(message).not.toContain("do not echo me");
  });

  it("R1i: a chat history that belongs to another execution refuses", function* () {
    yield* useRoot();
    yield* useGatedHost("reader-foreign", fresh());
    yield* sidekickFile("reader-foreign", [
      line({ kind: "owner", version: 1, execution: "somebody-else" }),
      line({ kind: "ready" }),
    ]);

    expect(yield* refusal(() => pairedReplRepository(root).open("reader-foreign"))).toContain(
      "belongs to another execution",
    );
  });

  it("R1j: a required file that is missing or is not a regular file refuses", function* () {
    yield* useRoot();
    yield* useGatedHost("reader-missing", fresh());
    const directory = join(root, PAIRED_DIRECTORY, "reader-missing");
    yield* until(mkdir(directory, { recursive: true }));
    yield* until(
      writeFile(
        join(directory, SIDEKICK_FILE),
        [
          line({ kind: "owner", version: 1, execution: "reader-missing" }),
          line({ kind: "ready" }),
        ].join(""),
      ),
    );
    // The entry history is absent, so this pair is not one.
    expect(yield* refusal(() => pairedReplRepository(root).open("reader-missing"))).toContain(
      "entry history is missing",
    );

    // And a directory where the chat history belongs is not a chat history.
    yield* until(mkdir(join(root, PAIRED_DIRECTORY, "reader-kind"), { recursive: true }));
    yield* until(writeFile(join(root, PAIRED_DIRECTORY, "reader-kind", ENTRIES_FILE), ""));
    yield* until(
      mkdir(join(root, PAIRED_DIRECTORY, "reader-kind", SIDEKICK_FILE), { recursive: true }),
    );
    expect(yield* refusal(() => pairedReplRepository(root).open("reader-kind"))).toContain(
      "not a file",
    );
  });

  it("R1k: an older history that has changed since publication is a conflict", function* () {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("origin-changed", gate);
    const path = yield* legacyFile("origin-changed", [event("one")]);
    const repository = pairedReplRepository(root);
    yield* repository.upgrade(yield* repository.open("origin-changed"));

    // Reopening while the origin still matches is ordinary.
    expect((yield* repository.open("origin-changed")).chat.form).toBe("paired");

    // Something other than this feature wrote to the retained origin. Which
    // of the two is current cannot be established, so neither is chosen.
    yield* until(appendFile(path, serializeDurableEvent(event("elsewhere"))));
    expect(yield* refusal(() => repository.open("origin-changed"))).toContain("has changed since");

    // A removed origin is not a conflict: the pair is the history, and this
    // feature never deleted the file it grew out of.
    yield* until(rm(path));
    expect((yield* repository.open("origin-changed")).chat.form).toBe("paired");
  });

  it("R1l: publishing over an existing pair refuses rather than making a second one", function* () {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("twice", gate);
    const repository = pairedReplRepository(root);
    const created = yield* repository.create();

    expect(yield* refusal(() => repository.upgrade(created))).toContain("nothing to upgrade");
    expect(yield* refusal(() => repository.create())).toContain("already has a paired history");
  });
});

describe("Tier R1 — a pair is the prefix it published, and the origin it named", () => {
  it("R1n: the copied prefix is the origin's exact bytes, whatever order they were written in", function* () {
    yield* useRoot();
    yield* useGatedHost("bytes", fresh());
    const original = serializeDurableEvent(reordered("original"));
    yield* until(mkdir(root, { recursive: true }));
    yield* until(writeFile(join(root, "bytes.jsonl"), original));
    const repository = pairedReplRepository(root);

    yield* repository.upgrade(yield* repository.open("bytes"));

    // Byte-for-byte, not record-for-record. The owner's digest describes these
    // bytes, so a copy that re-encoded them would leave the pair claiming a
    // prefix it does not hold.
    expect(yield* text(pairPath("bytes", ENTRIES_FILE))).toBe(original);
  });

  it("R1o: a changed copied prefix refuses even while the origin still matches", function* () {
    yield* useRoot();
    yield* useGatedHost("prefix", fresh());
    yield* legacyFile("prefix", [event("one")]);
    const repository = pairedReplRepository(root);
    yield* repository.upgrade(yield* repository.open("prefix"));

    // The older file is untouched and still matches its digest. Only the copy
    // changed — which the origin's digest alone cannot see, because it is a
    // digest of the *origin*.
    yield* until(
      writeFile(pairPath("prefix", ENTRIES_FILE), serializeDurableEvent(event("replacement"))),
    );

    expect(yield* refusal(() => repository.open("prefix"))).toContain(
      "no longer begins with the records it was published with",
    );
  });

  it("R1p: later entry records after the copied prefix are ordinary", function* () {
    yield* useRoot();
    yield* useGatedHost("later", fresh());
    yield* legacyFile("later", [event("one")]);
    const repository = pairedReplRepository(root);
    const upgraded = yield* repository.upgrade(yield* repository.open("later"));

    yield* upgraded.stream.append(event("after"));

    // The prefix is a prefix, not the whole file: carrying on is the point of
    // having copied it.
    expect((yield* repository.open("later")).chat.form).toBe("paired");
  });

  it("R1q: an older history beside a pair that declares none is a conflict", function* () {
    yield* useRoot();
    yield* useGatedHost("undeclared", fresh());
    const repository = pairedReplRepository(root);
    yield* repository.create();

    // This pair grew out of nothing, so a single file beside it is not its
    // past. It is a second history for one execution, and nothing here can say
    // which of the two is current.
    yield* until(
      writeFile(join(root, "undeclared.jsonl"), serializeDurableEvent(event("elsewhere"))),
    );

    expect(yield* refusal(() => repository.open("undeclared"))).toContain(
      "was not published from one",
    );
  });

  it("R1r: a second owner anywhere in the file is conflicting ownership", function* () {
    yield* useRoot();
    yield* useGatedHost("twice-owned", fresh());
    const repository = pairedReplRepository(root);
    yield* repository.create();

    yield* until(
      appendFile(
        pairPath("twice-owned", SIDEKICK_FILE),
        line({ kind: "owner", version: 1, execution: "somebody-else" }),
      ),
    );

    expect(yield* refusal(() => repository.open("twice-owned"))).toContain(
      "claims its ownership twice",
    );
  });
});

describe("Tier R1 — a record is constructed from checked members, never asserted", () => {
  /**
   * The parser's own rows, because a cast is invisible from the outside.
   *
   * A record asserted into shape hands a typed value to code that then trusts
   * it, so the failure surfaces far from the file that caused it. These check
   * the boundary instead.
   */
  const MALFORMED: Array<[string, Record<string, unknown>]> = [
    [
      "a serialized error that is not one",
      {
        kind: "response",
        conversation: "c",
        turn: 0,
        response: "r",
        outcome: { status: "err", error: null },
        hasOutput: true,
        output: "",
      },
    ],
    [
      "a serialized error with no message",
      {
        kind: "response",
        conversation: "c",
        turn: 0,
        response: "r",
        outcome: { status: "err", error: { name: "Error" } },
        hasOutput: true,
        output: "",
      },
    ],
    [
      "a version table that does not map strings to strings",
      {
        kind: "reference",
        conversation: "c",
        turn: 0,
        bootstrap: "",
        index: "",
        surface: "",
        versions: { guides: 3 },
      },
    ],
    [
      "an optional member of the wrong type",
      {
        kind: "conversation",
        conversation: "c",
        agent: "a",
        phase: "activated",
        previous: 7,
      },
    ],
    [
      "a control missing its declared arguments",
      {
        kind: "control",
        conversation: "c",
        response: "r",
        order: 0,
        component: "REPL.Bindings",
      },
    ],
    [
      "an outcome carrying members that belong to the intent",
      {
        kind: "control-outcome",
        conversation: "c",
        response: "r",
        order: 0,
        component: "REPL.Bindings",
        outcome: { status: "ok" },
      },
    ],
    [
      "an undeclared member",
      {
        kind: "ready",
        extra: "from another version",
      },
    ],
    [
      "a canonical event that is not one",
      {
        kind: "event",
        conversation: "c",
        sequence: 0,
        event: '{"not":"an event"}\n',
      },
    ],
    [
      // A Submit that binds a slot and not the history it counted it in. The
      // ordinal cannot stand in for the binding — reading one as though it
      // could is what let a changed earlier history satisfy a reservation — so
      // a record without it is not a record this grammar has.
      "a Submit intent with no retained prefix",
      {
        kind: "control",
        conversation: "c",
        response: "r",
        order: 0,
        component: "REPL.Submit",
        arguments: {},
        submit: { ordinal: 1, entry: "entry-2", source: "Hello", revision: 0 },
      },
    ],
    [
      "a Submit intent whose retained prefix is missing its digest",
      {
        kind: "control",
        conversation: "c",
        response: "r",
        order: 0,
        component: "REPL.Submit",
        arguments: {},
        submit: {
          ordinal: 1,
          entry: "entry-2",
          source: "Hello",
          revision: 0,
          retained: { records: 11, bytes: 2048 },
        },
      },
    ],
  ];

  for (const [what, held] of MALFORMED) {
    it(`R1s: ${what} is not a record`, function* () {
      expect(parseSidekickRecord(JSON.stringify(held))).toBe(undefined);
    });
  }

  for (const workspace of [false, null, "true", 1, {}]) {
    it(`975: a present invalid workspace marker ${JSON.stringify(workspace)} refuses`, function* () {
      expect(
        parseSidekickRecord(
          JSON.stringify({
            kind: "control",
            conversation: "c",
            response: "r",
            order: 0,
            component: "REPL.Submit",
            arguments: {},
            submit: {
              ordinal: 0,
              entry: "entry-1",
              source: "Hello",
              revision: 0,
              retained: { records: 0, bytes: 0, sha256: "f".repeat(64) },
              workspace,
            },
          }),
        ),
      ).toBe(undefined);
    });
  }

  it("R1t: a well-formed record round-trips through the parser", function* () {
    const intent: SidekickRecord = {
      kind: "control",
      conversation: "c",
      response: "r",
      order: 2,
      component: "REPL.Submit",
      arguments: { entry: null },
      submit: {
        ordinal: 3,
        entry: "entry-4",
        source: "Hello",
        revision: 9,
        retained: { records: 11, bytes: 2048, sha256: "f".repeat(64) },
      },
    };
    const answered: SidekickRecord = {
      kind: "control-outcome",
      conversation: "c",
      response: "r",
      order: 2,
      outcome: { status: "err", error: { message: "refused", name: "ReplError" } },
    };

    const marked: SidekickRecord = { ...intent, submit: { ...intent.submit!, workspace: true } };
    for (const held of [intent, answered, marked]) {
      expect(parseSidekickRecord(serializeSidekickRecord(held).slice(0, -1))).toEqual(held);
    }
  });
});

describe("Tier R1 — the identifier is checked before it becomes a path", () => {
  it("R1m: an identifier that is not the one the REPL minted never joins a path", function* () {
    yield* useRoot();
    yield* useGatedHost("opaque", fresh());
    const repository = pairedReplRepository(root);

    for (const named of ["../escape", "a/b", "", "."]) {
      expect(yield* refusal(() => repository.open(named))).toContain("opaque identifier");
    }
  });
});

/**
 * Tier R1 — one writer, one order, through the host boundary (#883, CFG8).
 *
 * The chat file has several writers now: a person's message, a reply's feedback
 * and controls, the wrapped canonical events of a turn, and a preference
 * somebody saves while all of that is running. They share one `SidekickWriter`,
 * and its acknowledged records are what the next turn's settings are read from
 * — so memory and disk disagreeing is a turn sent under settings nobody asked
 * for, rather than a cosmetic inconsistency.
 *
 * The gate holds a real append inside the host, which is what makes the
 * predecessor genuinely active: a writer that had merely gone quiet would make
 * every ordering look correct.
 */
describe("Tier R1 — the Sidekick writer's one order, and leaving its queue", () => {
  function preference(model: string): SidekickRecord {
    return { kind: "preferences", conversation: "conversation-one", model, effort: null };
  }

  /**
   * Three appends with the first one held, and the middle one optionally gone.
   *
   * `cancelMiddle` is the whole distinction. Taking a waiter out of the line
   * must take out its own place and nothing else: the caller holding the writer
   * goes on holding it, and the caller behind the cancelled one still waits for
   * *that* caller rather than being let past it.
   */
  function* appending(cancelMiddle: boolean): Operation<{
    readonly duringFirst: boolean;
    readonly reached: readonly string[];
    readonly acknowledged: readonly string[];
    readonly written: readonly string[];
  }> {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("writer-order", gate);
    const path = join(root, "writer-order.jsonl");

    const held = withResolvers<void>();
    const reached: string[] = [];
    const arrived = { first: withResolvers<void>() };
    let holding = true;
    let duringFirst = false;
    let thirdReached = false;
    // Released at the end whatever happened, so a failing arm leaves no latch.
    yield* ensure(() => held.resolve());
    gate.hold = (_target, record) => {
      if (record.includes('"model":"first"')) {
        return (function* (): Operation<void> {
          reached.push("first");
          arrived.first.resolve();
          yield* held.operation;
        })();
      }
      if (record.includes('"model":"middle"')) {
        reached.push("middle");
        return undefined;
      }
      reached.push("third");
      duringFirst = holding;
      thirdReached = true;
      return undefined;
    };

    const writer = new SidekickWriter(path);
    const first = yield* spawn(() => writer.append(preference("first")));
    yield* arrived.first.operation;

    // Queued behind it, in the order they arrive.
    const started = withResolvers<void>();
    const middle = yield* spawn(function* (): Operation<void> {
      started.resolve();
      yield* writer.append(preference("middle"));
    });
    yield* started.operation;
    const third = yield* spawn(() => writer.append(preference("third")));
    if (cancelMiddle) {
      yield* middle.halt();
    }

    // A deadline, and only that: it bounds how long this waits for a host entry
    // that must not happen, and establishes no readiness of its own.
    for (let waited = 0; waited < 20 && !thirdReached; waited += 1) {
      yield* sleep(5);
    }
    holding = false;
    held.resolve();
    yield* first;
    if (!cancelMiddle) {
      yield* middle;
    }
    yield* third;

    const acknowledged: string[] = [];
    for (const record of yield* writer.readAll()) {
      if (record.kind === "preferences" && record.model !== null) {
        acknowledged.push(record.model);
      }
    }
    // And what the file itself holds, in its own order: the acknowledged
    // records are a claim about this file, so the file is what checks them.
    const written: string[] = [];
    for (const line of (yield* text(path)).split("\n").filter((one) => one.length > 0)) {
      const parsed = parseSidekickRecord(line);
      if (parsed?.kind === "preferences" && parsed.model !== null) {
        written.push(parsed.model);
      }
    }
    return { duringFirst, reached, acknowledged, written };
  }

  it("R1v: a cancelled waiter appends nothing and lets nobody past the writer", function* () {
    const observed = yield* appending(true);

    // The middle caller left the queue and took only its own place: nothing
    // entered the host while the first append was still inside it.
    expect(observed.duringFirst).toBe(false);
    expect(observed.reached).toEqual(["first", "third"]);
    // And it wrote nothing — a caller cancelled while waiting has appended
    // nothing to append.
    expect(observed.acknowledged).toEqual(["first", "third"]);
    expect(observed.written).toEqual(["first", "third"]);
  });

  it("R1v: with nobody cancelled, every append still follows the one before", function* () {
    const observed = yield* appending(false);

    expect(observed.duringFirst).toBe(false);
    expect(observed.reached).toEqual(["first", "middle", "third"]);
    expect(observed.acknowledged).toEqual(["first", "middle", "third"]);
    // Memory and disk in the same order, which is the whole point of having one
    // writer: the preference a turn takes is the last one *acknowledged*.
    expect(observed.written).toEqual(["first", "middle", "third"]);
  });

  it("R1v: control — appends nobody contends for are in order either way", function* () {
    yield* useRoot();
    const gate = fresh();
    yield* useGatedHost("writer-uncontended", gate);
    const path = join(root, "writer-uncontended.jsonl");
    const writer = new SidekickWriter(path);

    // One at a time, each awaited before the next is asked for. There is no
    // contention to order, so this is what ordinary successful writing looks
    // like — and it says so whether or not anything is serializing them. It is
    // the control the arms above are measured against: a regression there has
    // to be about contention rather than about writing at all.
    yield* writer.append(preference("one"));
    yield* writer.append(preference("two"));

    const acknowledged = (yield* writer.readAll()).flatMap((record) =>
      record.kind === "preferences" && record.model !== null ? [record.model] : [],
    );
    expect(acknowledged).toEqual(["one", "two"]);
    const written: string[] = [];
    for (const line of (yield* text(path)).split("\n").filter((one) => one.length > 0)) {
      const parsed = parseSidekickRecord(line);
      if (parsed?.kind === "preferences" && parsed.model !== null) {
        written.push(parsed.model);
      }
    }
    expect(written).toEqual(["one", "two"]);
  });
});
