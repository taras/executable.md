/**
 * A long REPL history, kept once and read a record at a time (#992).
 *
 * A history that binds captured output as root values repeats that output in
 * every later root close, so its file grows far faster than what it says. Two
 * things made such a history fail to reopen or continue long before a disk
 * would mind: every reader of the retained stream was handed a deep copy of the
 * whole history, and the file was read as one string. These rows hold the two
 * replacements to what they have to preserve.
 *
 * - **Retained events.** One frozen graph per event, handed to every reader in
 *   a fresh array. Nobody can change what another reader sees, an append's
 *   operand is copied before the write suspends, and the segment view and the
 *   physical stream keep the same graph rather than one copy each.
 * - **Incremental reading.** Records are read a chunk at a time, split at the
 *   newline byte and decoded per line, so multi-byte text split across a chunk
 *   boundary reads exactly as a whole-file read did. A history past the
 *   supported length is refused by a sentence naming the limit.
 * - **Exact bytes.** The Sidekick's prefix bindings and the single-file-to-pair
 *   upgrade measure and copy the file's own bytes through the same reader.
 * - **Bounded reading of a long value.** What the screen says a binding is
 *   stays what it said, without writing out a value to show twenty columns of
 *   it.
 *
 * Files are real, in a per-row temporary directory, because what is under test
 * is how bytes on disk are read; the chunk size comes from the reader itself so
 * a boundary row keeps landing on a boundary.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { appendFile, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { INLINE_SOURCE_PATH, parseJson } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";

import { describeApplication, initialState, NO_AGENT, viewFor } from "../src/repl/application.ts";
import type { ReplLive } from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { fields, readDescription } from "../src/repl/description.ts";
import type { ReplRoute } from "../src/repl/route.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { committedContext, useMeasuringRenderer } from "./fixtures/repl/presentation.ts";
import { ReplHost } from "../src/repl/host.ts";
import {
  HISTORY_LIMIT,
  openExecutionFile,
  readRecords,
  RetainedReplStream,
} from "../src/repl/journal.ts";
import { EntrySegmentStream, ROOT_IMPORT } from "../src/repl/entries.ts";
import { projectRepl } from "../src/repl/model.ts";
import { READ_CHUNK } from "../src/repl/record-file.ts";
import {
  bindRetainedPrefix,
  ENTRIES_FILE,
  measureRetainedPrefix,
  PAIRED_DIRECTORY,
  readSidekickRecords,
  SIDEKICK_FILE,
} from "../src/repl/sidekick/history.ts";
import { pairedReplRepository } from "../src/repl/sidekick/repository.ts";

/** Characters whose UTF-8 encodings are two, three and four bytes long. */
const WIDE = ["é", "—", "😀"];

/** One record carrying `value`, as a run would write it. */
function record(name: string, value: string): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "test_effect", name },
    result: { status: "ok", value },
  };
}

function line(event: DurableEvent): string {
  return serializeDurableEvent(event);
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A record whose `wide` character starts exactly `offset` bytes into the file,
 * given the bytes already before it.
 */
function placed(before: number, offset: number, wide: string): string {
  const head = line(record("placed", "")).indexOf('"value":"') + '"value":"'.length;
  const padding = offset - before - head;
  return line(record("placed", `${"a".repeat(padding)}${wide}tail`));
}

/** How a whole-file reader parsed the same text, for comparison. */
function wholeFile(text: string): DurableEvent[] {
  if (text.length === 0) {
    return [];
  }
  return text
    .slice(0, -1)
    .split("\n")
    .map((each) => {
      const parsed = parseDurableEvent(each);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    });
}

function* refusal(work: () => Operation<unknown>): Operation<string | undefined> {
  try {
    yield* work();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The host's two file operations, over the real filesystem, with one append held on request. */
function useHost(name: string, hold?: () => Operation<void> | undefined): Operation<void> {
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
      *appendRecord([path, text]: [string, string]): Operation<void> {
        const holding = hold?.();
        if (holding !== undefined) {
          yield* holding;
        }
        yield* until(appendFile(path, text));
      },
    },
    { at: "min" },
  );
}

/** Whether every container in this graph is frozen. */
function frozenThroughout(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(frozenThroughout);
}

describe("#992 — retained events are kept once and shared", () => {
  it("H1: every read shares one frozen graph, in an array of its own", function* () {
    const directory = yield* useTempDirectory("xmd-retained-");
    yield* useHost("h1");
    const stream = new RetainedReplStream(join(directory, "h1.jsonl"), [record("one", "1")]);
    yield* stream.append(record("two", "2"));

    const first = yield* stream.readAll();
    const second = yield* stream.readAll();
    expect(first).not.toBe(second);
    expect(first[0]).toBe(second[0]);
    expect(first[1]).toBe(second[1]);
    expect(first.every(frozenThroughout)).toBe(true);

    // Editing a returned array edits that array, and nothing the stream holds.
    first.pop();
    first.push(record("forged", "x"));
    expect(
      (yield* stream.readAll()).map((event) => event.type === "yield" && event.description.name),
    ).toEqual(["one", "two"]);
  });

  it("H1: an append copies its operand before suspending, and leaves the operand the caller's", function* () {
    const directory = yield* useTempDirectory("xmd-retained-");
    const entered = withResolvers<void>();
    const released = withResolvers<void>();
    let holding = true;
    yield* useHost("h1b", () => {
      if (!holding) {
        return undefined;
      }
      holding = false;
      return (function* (): Operation<void> {
        entered.resolve();
        yield* released.operation;
      })();
    });
    const path = join(directory, "h1b.jsonl");
    const stream = new RetainedReplStream(path);
    const announced: DurableEvent[] = [];
    stream.onAppend = (event) => {
      announced.push(event);
    };

    const operand: {
      type: "yield";
      coroutineId: string;
      description: { type: string; name: string; items: string[] };
      result: { status: "ok"; value: { nested: { word: string } } };
    } = {
      type: "yield",
      coroutineId: "root",
      description: { type: "test_effect", name: "mutable", items: ["kept"] },
      result: { status: "ok", value: { nested: { word: "kept" } } },
    };
    const appending = yield* spawn(() => stream.append(operand));
    yield* entered.operation;

    // The write is suspended: an edit now must reach neither the file's record
    // nor the retained event.
    operand.description.items.push("added later");
    operand.result.value.nested.word = "changed";
    expect(Object.isFrozen(operand)).toBe(false);
    expect(Object.isFrozen(operand.result.value.nested)).toBe(false);
    released.resolve();
    yield* appending;

    const [retained] = yield* stream.readAll();
    expect(retained).not.toBe(operand);
    expect(retained).toEqual({
      type: "yield",
      coroutineId: "root",
      description: { type: "test_effect", name: "mutable", items: ["kept"] },
      result: { status: "ok", value: { nested: { word: "kept" } } },
    });
    expect(wholeFile(yield* until(readFile(path, "utf8")))).toEqual([retained]);
    // The observer is told the event that was retained, not a further copy.
    expect(announced).toHaveLength(1);
    expect(announced[0]).toBe(retained);
  });

  it("H1: a segment and its physical stream keep one graph, and earlier events are untouched", function* () {
    const directory = yield* useTempDirectory("xmd-retained-");
    yield* useHost("h1c");
    const physical = new RetainedReplStream(join(directory, "h1c.jsonl"), [record("one", "1")]);
    const before = yield* physical.readAll();
    const segment = new EntrySegmentStream(physical);

    yield* segment.append(record("two", "2"));

    const seen = yield* segment.readAll();
    const held = yield* physical.readAll();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(held[1]);
    // What was retained before the append is still the very same object.
    expect(held[0]).toBe(before[0]);
  });

  it("H1: a frozen accessor operand is retained as the reading that was written", function* () {
    const directory = yield* useTempDirectory("xmd-retained-");
    yield* useHost("h1f");
    const path = join(directory, "h1f.jsonl");
    const physical = new RetainedReplStream(path);
    const observed: DurableEvent[] = [];
    physical.onAppend = (event) => {
      observed.push(event);
    };
    const segment = new EntrySegmentStream(physical);

    // The caller's own state, read through getters, inside frozen containers.
    // Frozen says nothing about what a getter will answer next, so a retained
    // event that kept these objects would be a live reading of this state
    // rather than a record of what was written.
    const caller = { answer: "acknowledged", held: ["kept"] };
    const value: { readonly nested: { readonly answer: string } } = Object.freeze({
      nested: Object.freeze({
        get answer(): string {
          return caller.answer;
        },
      }),
    });
    yield* segment.append({
      type: "yield",
      coroutineId: "root",
      description: Object.freeze({
        type: "test_effect",
        name: "accessor",
        get held(): string[] {
          return caller.held;
        },
      }),
      result: { status: "ok", value },
    });
    const written = yield* until(readFile(path, "utf8"));

    caller.answer = "changed after acknowledgement";
    caller.held.push("added later");

    // Every reader, every time, still describes the record the file holds.
    for (const read of [
      yield* physical.readAll(),
      yield* segment.readAll(),
      yield* physical.readAll(),
      yield* segment.readAll(),
      observed,
    ]) {
      expect(read).toHaveLength(1);
      expect(read.map(serializeDurableEvent).join("")).toBe(written);
    }
    // And they are still one shared graph rather than a copy each.
    expect((yield* physical.readAll())[0]).toBe((yield* segment.readAll())[0]);
    // The caller's own objects are untouched and still answer for the caller.
    expect(value.nested.answer).toBe("changed after acknowledgement");
    expect(caller.held).toEqual(["kept", "added later"]);
  });

  it("H1: sealing keeps member order, absent and undefined members, and an own __proto__", function* () {
    const directory = yield* useTempDirectory("xmd-retained-");
    yield* useHost("h1d");
    const parsed = parseDurableEvent(
      '{"type":"yield","coroutineId":"root","description":{"type":"test_effect","name":"p",' +
        '"zeta":1,"__proto__":{"own":true},"alpha":[{"__proto__":2}]},' +
        '"result":{"status":"ok"}}',
    );
    if (!parsed.ok) {
      throw parsed.error;
    }
    const undefinedValue: DurableEvent = {
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value: undefined },
    };
    const stream = new RetainedReplStream(join(directory, "h1d.jsonl"));
    yield* stream.append(parsed.value);
    yield* stream.append(undefinedValue);

    const [first, second] = yield* stream.readAll();
    if (first?.type !== "yield" || second === undefined) {
      throw new Error("expected the two appended events");
    }
    expect(Object.keys(first.description)).toEqual(["type", "name", "zeta", "__proto__", "alpha"]);
    expect(Object.hasOwn(first.description, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(first.description)).toBe(Object.prototype);
    const alpha = first.description["alpha"];
    const member = Array.isArray(alpha) ? alpha[0] : undefined;
    expect(
      typeof member === "object" && member !== null && Object.hasOwn(member, "__proto__"),
    ).toBe(true);
    expect("value" in first.result).toBe(false);
    expect(Object.keys(second.result)).toEqual(["status", "value"]);
  });
});

describe("#992 — a history is read a record at a time", () => {
  it("H2: text split across a chunk boundary reads exactly as a whole-file read does", function* () {
    const directory = yield* useTempDirectory("xmd-chunks-");
    const opening = line(record("first", "start"));
    for (const wide of WIDE) {
      const width = bytesOf(wide);
      // Every position at which the character can straddle the boundary, and
      // the two positions either side of it.
      for (let into = -1; into <= width; into++) {
        const path = join(directory, `split-${width}-${into + 1}.jsonl`);
        const text =
          opening +
          placed(bytesOf(opening), READ_CHUNK - into, wide) +
          line(record("escaped", 'a "quoted"\nline\twith — escapes')) +
          line(record("last", "😀 end"));
        yield* until(writeFile(path, text));
        expect(yield* readRecords(path)).toEqual(wholeFile(text));
      }
    }
  });

  it("H2: a newline on either side of a chunk boundary ends its record there", function* () {
    const directory = yield* useTempDirectory("xmd-chunks-");
    const opening = line(record("first", "start"));
    for (const end of [READ_CHUNK - 1, READ_CHUNK, READ_CHUNK + 1]) {
      const path = join(directory, `newline-${end}.jsonl`);
      // A record whose terminating newline is byte `end - 1`.
      const empty = line(record("fill", "")).length;
      const fill = line(record("fill", "b".repeat(end - bytesOf(opening) - empty)));
      const text = opening + fill + line(record("after", "next"));
      expect(bytesOf(opening + fill)).toBe(end);
      yield* until(writeFile(path, text));
      expect(yield* readRecords(path)).toEqual(wholeFile(text));
    }
  });

  it("H2: empty, unfinished, malformed and non-file histories refuse as before", function* () {
    const directory = yield* useTempDirectory("xmd-chunks-");
    const empty = join(directory, "empty.jsonl");
    yield* until(writeFile(empty, ""));
    expect(yield* readRecords(empty)).toEqual([]);

    const unfinished = join(directory, "unfinished.jsonl");
    yield* until(
      writeFile(unfinished, line(record("one", "1")) + line(record("two", "—")).slice(0, -1)),
    );
    expect(yield* refusal(() => readRecords(unfinished))).toBe(
      "this execution's history ends in a record that was never finished writing.",
    );

    const malformed = join(directory, "malformed.jsonl");
    yield* until(writeFile(malformed, line(record("one", "1")) + '{"secret":"do not repeat"}\n'));
    const refused = yield* refusal(() => readRecords(malformed));
    expect(refused).toBe(
      "this execution's history holds a record this version cannot read (record 2).",
    );
    expect(refused).not.toContain("do not repeat");

    yield* until(mkdir(join(directory, "kf39sla2.jsonl")));
    expect(yield* refusal(() => openExecutionFile(directory, "kf39sla2"))).toBe(
      "this execution's history is not a file.",
    );
  });

  it("H3: the limit is in UTF-16 code units with newlines, and refusing it names it", function* () {
    const directory = yield* useTempDirectory("xmd-limit-");
    const path = join(directory, "limit.jsonl");
    // Three-byte characters, so a byte count and a code-unit count disagree and
    // a limit that confused them would refuse a file that fits.
    const text = line(record("one", "—".repeat(400))) + line(record("two", "x".repeat(300)));
    yield* until(writeFile(path, text));
    expect(bytesOf(text)).toBeGreaterThan(text.length);

    expect(yield* readRecords(path, text.length)).toEqual(wholeFile(text));
    const refused = yield* refusal(() => readRecords(path, text.length - 1));
    expect(refused).toBe(
      `this execution's history exceeds the supported limit of ` +
        `${(text.length - 1).toLocaleString("en-US")} UTF-16 code units. Start a new execution ` +
        "with `xmd repl` for further work; this history was left unchanged.",
    );
    // Refusing leaves the history exactly as it was.
    expect(yield* until(readFile(path, "utf8"))).toBe(text);
    expect(HISTORY_LIMIT).toBe(0x1fffffe8);
  });
});

/** A history several chunks long, with wide text across every boundary it crosses. */
function longHistory(): string {
  let text = "";
  let index = 0;
  while (bytesOf(text) < READ_CHUNK * 3) {
    const wide = WIDE[index % WIDE.length] ?? "—";
    text += line(record(`r${index}`, `${wide}${"z".repeat(300_000 + index)}${wide}`));
    index += 1;
  }
  return text;
}

function linesOf(text: string): string[] {
  return text
    .slice(0, -1)
    .split("\n")
    .map((each) => `${each}\n`);
}

describe("#992 — Sidekick prefixes and the upgrade use the file's own bytes", () => {
  it("H4: a bound and a measured prefix are the digest of exactly those bytes", function* () {
    const directory = yield* useTempDirectory("xmd-prefix-");
    const path = join(directory, ENTRIES_FILE);
    const text = longHistory();
    yield* until(writeFile(path, text));
    const lines = linesOf(text);

    const bound = yield* bindRetainedPrefix(path);
    expect(bound).toEqual({ records: lines.length, bytes: bytesOf(text), sha256: sha256(text) });

    const claimed = 3;
    const prefix = lines.slice(0, claimed).join("");
    expect(yield* measureRetainedPrefix(path, claimed)).toEqual({
      records: lines.length,
      measured: { bytes: bytesOf(prefix), sha256: sha256(prefix) },
    });
    expect(yield* measureRetainedPrefix(path, lines.length + 1)).toEqual({
      records: lines.length,
      measured: undefined,
    });

    // The same number of records with one byte changed inside the prefix is a
    // different prefix, not the same one.
    const changed = text.replace('"r1"', '"q1"');
    expect(bytesOf(changed)).toBe(bytesOf(text));
    yield* until(writeFile(path, changed));
    const remeasured = yield* measureRetainedPrefix(path, claimed);
    expect(remeasured.records).toBe(lines.length);
    expect(remeasured.measured?.bytes).toBe(bytesOf(prefix));
    expect(remeasured.measured?.sha256).not.toBe(sha256(prefix));

    yield* until(appendFile(path, '{"type":"yield"'));
    expect(yield* refusal(() => bindRetainedPrefix(path))).toBe(
      "this execution's history ends in a record that was never finished writing.",
    );
  });

  it("H4: an upgrade copies a multi-chunk history byte for byte and reopens it", function* () {
    const root = yield* useTempDirectory("xmd-upgrade-");
    yield* useHost("long-legacy");
    // Members in another order than the parser rebuilds, so a copy that
    // re-encoded records would not be byte-identical.
    const reordered =
      '{"result":{"status":"ok","value":"— reordered"},"coroutineId":"root",' +
      '"description":{"name":"reordered","type":"test_effect"},"type":"yield"}\n';
    const text = longHistory() + reordered;
    const legacy = join(root, "long-legacy.jsonl");
    yield* until(writeFile(legacy, text));
    const repository = pairedReplRepository(root);

    const opened = yield* repository.open("long-legacy");
    const retained = yield* opened.stream.readAll();
    const upgraded = yield* repository.upgrade(opened);
    expect(upgraded.chat.form).toBe("paired");

    const pair = join(root, PAIRED_DIRECTORY, "long-legacy");
    const copied = yield* until(readFile(join(pair, ENTRIES_FILE)));
    expect(sha256(copied)).toBe(sha256(text));
    expect(copied.length).toBe(bytesOf(text));
    const records = yield* readSidekickRecords(join(pair, SIDEKICK_FILE));
    expect(records[0]).toMatchObject({
      origin: { bytes: bytesOf(text), sha256: sha256(text), records: linesOf(text).length },
    });
    // The pair's stream answers with the events this process already held.
    const after = yield* upgraded.stream.readAll();
    expect(after).toHaveLength(retained.length);
    expect(after.every((event, index) => event === retained[index])).toBe(true);

    const reopened = yield* pairedReplRepository(root).open("long-legacy");
    expect(yield* reopened.stream.readAll()).toEqual(retained);
    // The original is retained, untouched.
    expect(yield* until(readFile(legacy, "utf8"))).toBe(text);
  });
});

describe("#992 — every saved history reads as it did", () => {
  it("H5: each entry history under fixtures/repl reads and projects as a whole-file read does", function* () {
    const fixtures = fileURLToPath(new URL("./fixtures/repl/", import.meta.url));
    const names = (yield* until(readdir(fixtures, { recursive: true })))
      .filter((name) => name.endsWith(".jsonl") && basename(name) !== SIDEKICK_FILE)
      .toSorted();
    // The inventory this row was written against; a new saved history joins it
    // rather than going unread.
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const path = join(fixtures, name);
      const text = yield* until(readFile(path, "utf8"));
      const expected = wholeFile(text);
      const events = yield* readRecords(path);
      expect(events).toEqual(expected);
      const now = projectRepl(events);
      const before = projectRepl(expected);
      // The same outcome, including a fixture that is kept because it refuses.
      expect(now.ok).toBe(before.ok);
      if (now.ok && before.ok) {
        expect(now.value).toEqual(before.value);
      } else if (!now.ok && !before.ok) {
        expect(now.error.message).toBe(before.error.message);
      }
    }
  });
});

describe("#992 — a long value is summarized without being written out", () => {
  const EXECUTION = "summary";
  const SCREEN: ReplTerminalSize = { columns: 160, rows: 36 };
  const NOTHING_LIVE: ReplLive = Object.freeze({
    output: "",
    question: undefined,
    expansion: "playing",
    pausable: false,
    running: false,
    agent: NO_AGENT,
    lifecycle: NO_LIFECYCLE,
  });

  /** One settled entry that published `held`, as a run records one. */
  function publishing(value: Json): DurableEvent[] {
    const content = "```js eval\nconst held = 1;\n```\n";
    return [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "import_component", name: ROOT_IMPORT },
        result: {
          status: "ok",
          value: { kind: "repository", path: INLINE_SOURCE_PATH, content },
        },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: {
          type: "eval",
          name: "eval:eval:root:0",
          language: "js",
          "executablemd.source-position": {
            path: INLINE_SOURCE_PATH,
            offset: 0,
            line: 1,
            column: 1,
          },
        },
        result: { status: "ok", value: { value: { held: value } } },
      },
      {
        type: "close",
        coroutineId: "root",
        result: {
          status: "ok",
          value: { status: "ok", output: "", value: "", bindings: { held: value } },
        },
      },
    ];
  }

  /** What the binding rows of this reading say, as a reader reads them. */
  function* bindingRows(value: Json, engine: ReplRenderer): Operation<string[]> {
    const projected = projectRepl(publishing(value));
    if (!projected.ok) {
      throw projected.error;
    }
    const opening = initialState(EXECUTION);
    // The bindings pane explicitly: the right-hand column defaults to the
    // Sidekick, so this asks for the pane the way a person does.
    const route: ReplRoute = { ...opening.route, scopes: ["entry-1"], right: "bindings" };
    const view = viewFor(
      Object.freeze({ ...opening, route }),
      projected.value,
      NOTHING_LIVE,
      SCREEN,
    );
    if (!view.ok) {
      throw view.error;
    }
    const context = yield* committedContext(engine, view.value);
    const rows: string[] = [];
    for (const description of describeApplication(view.value, context)) {
      const read = readDescription(description);
      const label = fields(read.input)?.["label"];
      if (read.key.startsWith("binding:") && typeof label === "string") {
        rows.push(label.trim());
      }
    }
    return rows;
  }

  /**
   * The summary writing the whole value out produced.
   *
   * Twenty columns, with the twentieth given to an ellipsis where there was
   * more — stated here as the contract rather than read from the screen's own
   * constant, so a changed constant fails this row instead of agreeing with it.
   */
  function whole(value: Json): string {
    const written = JSON.stringify(value) ?? "null";
    return written.length <= 20 ? written : `${written.slice(0, 19)}\u2026`;
  }

  it("H6: a value too long to show reads exactly as writing it out whole did", function* () {
    const engine = yield* useMeasuringRenderer(SCREEN);
    const values: Json[] = [
      // Long enough that a summary is a cut, in the shapes a cut could move:
      // plain text, text whose every character escapes into two, quotes at the
      // front, characters outside the basic plane, and long text nested in a
      // container and in a list.
      "a".repeat(5000),
      "\n".repeat(5000),
      `${'"'.repeat(10)}${"b".repeat(5000)}`,
      "\u{1f600}".repeat(3000),
      `\u2014${"c".repeat(5000)}`,
      { log: "d".repeat(5000) },
      ["e".repeat(5000)],
      { first: "f".repeat(5000), second: "g".repeat(5000) },
      // And the lengths either side of the twenty columns a summary keeps, so
      // the row that is shown whole is shown whole.
      "h".repeat(17),
      "i".repeat(18),
      "j".repeat(19),
      "alpha",
      42,
      null,
      true,
      { a: 1 },
      [],
      // An own `__proto__` member, which a history can hold because
      // `JSON.parse` makes one an own property and Core's parser keeps it.
      // Shortening a value by assigning its members would reach the inherited
      // setter instead, and this row would read as `{}`.
      parseJson(JSON.parse('{"__proto__":{"x":1}}')),
    ];
    for (const value of values) {
      expect(yield* bindingRows(value, engine)).toEqual([`held = ${whole(value)}`]);
    }
  });
});
