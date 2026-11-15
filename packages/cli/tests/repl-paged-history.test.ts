import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { INLINE_SOURCE_PATH } from "@executablemd/core";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { appendFile, open, readFile, rename, truncate, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "effection";
import type { Operation } from "effection";
import { ROOT_IMPORT } from "../src/repl/entries.ts";
import { ReplHost } from "../src/repl/host.ts";
import { openRetainedStream } from "../src/repl/journal.ts";
import { entryInputBindings, entryOutput, projectRepl } from "../src/repl/model.ts";
import { prepareReplStartup } from "../src/repl/program.ts";
import { appendCheckedRecord } from "../src/repl/record-file.ts";
import { pairedReplRepository } from "../src/repl/sidekick/repository.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";

function admission(content: string): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type: "import_component", name: ROOT_IMPORT },
    result: { status: "ok", value: { kind: "repository", path: INLINE_SOURCE_PATH, content } },
  };
}

function closed(bindings?: Record<string, Json>): DurableEvent {
  return {
    type: "close",
    coroutineId: "root",
    result: {
      status: "ok",
      value: { status: "ok", output: "done", ...(bindings && { bindings }) },
    },
  };
}

function encoded(events: readonly DurableEvent[]): string {
  return events.map(serializeDurableEvent).join("");
}

function* refuse(work: () => Operation<unknown>): Operation<string | undefined> {
  try {
    yield* work();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function* useWriter(): Operation<void> {
  yield* ReplHost.around({
    *createExclusive([path]) {
      yield* until(open(path, "wx").then((file) => file.close()));
    },
    *appendRecord([path, text]) {
      yield* until(appendFile(path, text));
    },
    *appendEntryRecord([path, text, check]) {
      yield* appendCheckedRecord(path, text, check);
    },
  });
}

describe("Paged REPL history", () => {
  it("matches the whole projection at each position and finds older binding publishers", function* () {
    const path = join(yield* useTempDirectory("xmd-pages-"), "entries.jsonl");
    const records: DurableEvent[] = [
      admission("Un premier résultat — 🌱"),
      closed({ first: { data: ["α", "β"] }, second: "original" }),
      admission("Failed"),
      {
        type: "close",
        coroutineId: "root",
        result: { status: "err", error: { message: "failed" } },
      },
      admission("Older result"),
      closed(),
      admission("Updates second"),
      closed({ second: "updated" }),
      admission("Unfinished"),
    ];
    yield* until(writeFile(path, encoded(records)));
    const { history } = yield* openRetainedStream(path, true);
    if (history === undefined) {
      throw new Error("Expected paged history");
    }
    const full = projectRepl(records);
    if (!full.ok) {
      throw full.error;
    }
    expect(history.activeEvents).toEqual(records.slice(-1));
    expect(history.resumeBindings()).toEqual({ first: { data: ["α", "β"] }, second: "updated" });
    const markers = full.value.entries.flatMap((entry) =>
      entry.records.map((record) => record.marker),
    );
    for (const at of [undefined, ...markers]) {
      const oracle = projectRepl(records, at);
      if (!oracle.ok) {
        throw oracle.error;
      }
      for (const expected of oracle.value.entries) {
        const loaded = yield* history.attend(at, expected.key);
        if (!loaded.ok) {
          throw loaded.error;
        }
        const actual = loaded.value.entries[expected.order - 1];
        expect(loaded.value.checkpoints).toEqual(oracle.value.checkpoints);
        expect(loaded.value.transcript).toEqual(oracle.value.transcript);
        expect(actual?.scope).toEqual(expected.scope);
        expect(actual?.bindings).toEqual(expected.bindings);
        expect(entryInputBindings(loaded.value, actual)).toEqual(
          entryInputBindings(oracle.value, expected),
        );
        expect(entryOutput(actual)).toEqual(entryOutput(expected));
      }
    }
  });

  it("rejects later damage before opening an earlier history position", function* () {
    const root = yield* useTempDirectory("xmd-pages-");
    const path = join(root, "broken.jsonl");
    const original = encoded([
      admission("good"),
      closed(),
      admission("unreadable"),
      closed({ "invalid name": 1 }),
    ]);
    yield* until(writeFile(path, original));
    const opened = yield* prepareReplStartup(
      "xmd://repl/broken/entries/entry-1?at=close:root",
      root,
      false,
      true,
    );
    expect(!opened.ok && opened.error.message).toContain("recorded outcome");
    expect(yield* until(readFile(path, "utf8"))).toBe(original);
  });

  for (const change of ["truncate", "edit", "replace", "remove"]) {
    it(`refuses a running append after external ${change} and keeps its writer fenced`, function* () {
      yield* useWriter();
      const dir = yield* useTempDirectory("xmd-pages-");
      const path = join(dir, "entries.jsonl");
      const original = encoded([admission("first"), closed(), admission("running")]);
      yield* until(writeFile(path, original));
      const stream = yield* openRetainedStream(path, true);
      const changed = original.replace("first", "other");
      if (change === "truncate") {
        yield* until(truncate(path, 10));
      } else if (change === "edit") {
        yield* until(writeFile(path, changed));
      } else if (change === "remove") {
        yield* until(unlink(path));
      } else {
        const replacement = join(dir, "replacement");
        yield* until(writeFile(replacement, original));
        yield* until(rename(replacement, path));
      }
      const observed = change === "remove" ? undefined : yield* until(readFile(path, "utf8"));
      expect(yield* refuse(() => stream.append(closed()))).toContain("changed");
      expect(yield* until(readFile(path, "utf8").catch(() => undefined))).toBe(observed);
      yield* until(writeFile(path, original));
      expect(yield* refuse(() => stream.append(closed()))).toContain("changed");
      expect(yield* until(readFile(path, "utf8"))).toBe(original);
    });
  }

  it("detects damaged released bytes during navigation and fences future appends", function* () {
    yield* useWriter();
    const path = join(yield* useTempDirectory("xmd-pages-"), "entries.jsonl");
    const original = encoded([admission("first"), closed(), admission("running")]);
    yield* until(writeFile(path, original));
    const stream = yield* openRetainedStream(path, true);
    const changed = original.replace("first", "other");
    yield* until(writeFile(path, changed));
    const history = stream.history;
    if (history === undefined) {
      throw new Error("Expected paged history");
    }
    const loaded = yield* history.attend(undefined, "entry-1");
    expect(loaded.ok).toBe(false);
    expect(yield* refuse(() => stream.append(closed()))).toContain("changed");
    expect(yield* until(readFile(path, "utf8"))).toBe(changed);
  });

  it("keeps the validated pages and active range across the legacy-to-pair handoff", function* () {
    yield* useWriter();
    const root = yield* useTempDirectory("xmd-pages-");
    const repository = pairedReplRepository(root, true);
    const path = join(root, "legacy.jsonl");
    const original = encoded([admission("first"), closed({ data: "older" }), admission("running")]);
    yield* until(writeFile(path, original));
    const execution = yield* repository.open("legacy");
    const published = yield* repository.upgrade(execution);
    yield* execution.stream.append(closed());
    expect(yield* until(readFile(path, "utf8"))).toBe(original);
    const target = pairedLocation(root, "legacy");
    expect(yield* until(readFile(target.entries, "utf8"))).toBe(original + encoded([closed()]));
    const history = published.stream.history;
    if (history === undefined) {
      throw new Error("Expected paged history");
    }
    const loaded = yield* history.attend("close:root", "entry-1");
    if (!loaded.ok) {
      throw loaded.error;
    }
    expect(entryOutput(loaded.value.entries[0])).toEqual({
      state: "ok",
      bindings: [{ name: "data", value: "older" }],
    });
  });
});
