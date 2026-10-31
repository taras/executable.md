import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { readFile, writeFile } from "node:fs/promises";
import { API, useHostFiles } from "@executablemd/runtime";
import { Permissions } from "@executablemd/runtime/api";
import { installTodoSource } from "../src/node-todo-source.ts";
import { captureTodoSource } from "../src/repl/todo/source.ts";
import { useTodo } from "../src/repl/todo/service.ts";
import { applyTodoDiff, editTodo, parseTodo, todoDiff } from "../src/repl/todo/document.ts";
import type { ControlJournal } from "../src/repl/sidekick/controls.ts";
import { todoDeclaration } from "../src/repl/todo/component.ts";
import { Component, retainedSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { forEach } from "@effectionx/stream-helpers";

function entry(source: string, history = new InMemoryStream(), journal?: ControlJournal) {
  return scoped(function* () {
    const execution = yield* executeInstalled(
      { ...retainedSource("todo-entry.md", source), stream: history },
      [{ components: [todoDeclaration(journal)] }],
    );
    yield* forEach(function* (_chunk: string) {}, execution.output);
    return yield* execution;
  });
}

function* fixture(): Operation<string> {
  yield* useHostFiles();
  yield* installTodoSource();
  const root = yield* API.Files.operations.temporaryDirectory();
  if (!root.ok) {
    throw root.error;
  }
  return root.value;
}

function* failure(work: () => Operation<unknown>): Operation<Error> {
  try {
    yield* work();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected refusal");
}

describe("TODO strict source and serialized edits", () => {
  it("reads absence without creation and retains inline source through a real replacement", function* () {
    const root = yield* fixture();
    const todo = yield* useTodo(root);
    expect((yield* todo.read()).items).toEqual([]);
    expect(yield* exists(`${root}/todo.md`)).toBe(false);
    const source =
      "\n- [ ] **first** `code` [link](https://example.com)  \r\n\r\n- [X] duplicate\r\n- [ ] duplicate";
    const items = yield* todo.save("", source);
    expect(yield* readTextFile(`${root}/todo.md`)).toBe(source);
    expect(items).toEqual(parseTodo(source).items);
    expect(todo.pending).toHaveLength(1);
    expect(todo.pending[0].origin).toBe("human");
    const next = source.replace("[X] duplicate", "[ ] duplicate");
    const result = yield* todo.apply(todoDiff(source, next));
    expect(result).toEqual(parseTodo(next).items);
    expect(yield* readTextFile(`${root}/todo.md`)).toBe(next);
    expect(todo.pending.map((change) => change.origin)).toEqual(["human", "sidekick"]);
  });

  it("refuses FF and FE source before read/edit without normalizing either fixture", function* () {
    const root = yield* fixture();
    const encoder = new TextEncoder();
    for (const byte of [0xff, 0xfe]) {
      const bytes = new Uint8Array([
        ...encoder.encode("- [ ] before "),
        byte,
        ...encoder.encode("\n- [ ] keep\n"),
      ]);
      yield* until(writeFile(`${root}/todo.md`, bytes));
      yield* scoped(function* () {
        const todo = yield* useTodo(root);
        expect(todo.current.ok).toBe(false);
        expect((yield* failure(() => todo.read())).message).toContain("Repair its UTF-8");
        expect(
          (yield* failure(() => todo.apply("@@ -2 +2 @@\n-- [ ] keep\n+- [x] keep\n"))).message,
        ).toContain("UTF-8");
        expect(todo.pending).toEqual([]);
        expect([...(yield* until(readFile(`${root}/todo.md`)))]).toEqual([...bytes]);
      });
    }
  });

  it("accepts literal U+FFFD and preserves it when the second task changes", function* () {
    const root = yield* fixture();
    const source = "- [ ] before \ufffd\n- [ ] keep\n";
    yield* writeTextFile(`${root}/todo.md`, source);
    const todo = yield* useTodo(root);
    expect((yield* todo.read()).items[0].text).toBe("before \ufffd");
    yield* todo.apply("@@ -2 +2 @@\n-- [ ] keep\n+- [x] keep\n");
    expect([...(yield* until(readFile(`${root}/todo.md`)))]).toEqual([
      ...new TextEncoder().encode(source.replace("[ ] keep", "[x] keep")),
    ]);
  });

  it("refreshes outside writes without pending changes and clears stale valid items on malformed source", function* () {
    const root = yield* fixture();
    yield* writeTextFile(`${root}/todo.md`, "- [ ] initial\n");
    const todo = yield* useTodo(root);
    yield* writeTextFile(`${root}/todo.md`, "- [ ] outside\n");
    yield* todo.refresh();
    expect((yield* todo.read()).items[0].text).toBe("outside");
    yield* until(writeFile(`${root}/todo.md`, new Uint8Array([0xff])));
    yield* todo.refresh();
    expect(todo.current.ok).toBe(false);
    expect(todo.pending).toEqual([]);
    yield* writeTextFile(`${root}/todo.md`, "- [ ] repaired");
    expect((yield* todo.read()).items[0].text).toBe("repaired");
  });

  it("keeps ordinary decoding outside the scope and checks permissions before native access", function* () {
    const root = yield* fixture();
    yield* until(writeFile(`${root}/todo.md`, new Uint8Array([0xff])));
    const source = yield* captureTodoSource();
    expect((yield* source.read(root)).ok).toBe(false);
    const ordinary = yield* API.Files.operations.readTextFile({ cwd: root, path: "todo.md" });
    expect(ordinary).toEqual({ ok: true, value: "\ufffd" });
    const denied = yield* scoped(function* () {
      yield* Permissions.around({ files: () => false });
      return yield* source.read(root);
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.message).not.toContain("UTF-8");
    }
  });

  it("refuses a stale two-hunk edit and a stale duplicate-label editor atomically", function* () {
    const root = yield* fixture();
    const source = "- [ ] same\n- [ ] same\n- [ ] third\n";
    yield* writeTextFile(`${root}/todo.md`, source);
    const todo = yield* useTodo(root);
    yield* todo.save(source, source.replace("third", "changed"));
    const committed = yield* readTextFile(`${root}/todo.md`);
    const before = todo.pending.length;
    yield* failure(() =>
      todo.apply(
        "@@ -1 +1 @@\n-- [ ] same\n+- [x] same\n@@ -3 +3 @@\n-- [ ] third\n+- [x] third\n",
      ),
    );
    yield* failure(() => todo.save(source, source.replace("same", "renamed")));
    expect(yield* readTextFile(`${root}/todo.md`)).toBe(committed);
    expect(todo.pending).toHaveLength(before);
    yield* todo.save(committed, committed);
    expect(todo.pending).toHaveLength(before);
  });

  it("holds a competing mutation behind the owned replacement before checking its opening source", function* () {
    const root = yield* fixture();
    const source = "- [ ] same\n- [ ] same\n";
    yield* writeTextFile(`${root}/todo.md`, source);
    const todo = yield* useTodo(root);
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const first = yield* spawn(function* () {
      yield* API.Fs.around(
        {
          *rename([from, to], next) {
            entered.resolve();
            yield* release.operation;
            return yield* next(from, to);
          },
        },
        { at: "min" },
      );
      return yield* todo.save(source, source.replace("same", "first"));
    });
    yield* entered.operation;
    let finished = false;
    const competing = yield* spawn(function* () {
      const result = yield* failure(() => todo.save(source, source.replace("same", "second")));
      finished = true;
      return result;
    });
    expect(finished).toBe(false);
    expect(yield* readTextFile(`${root}/todo.md`)).toBe(source);
    release.resolve();
    yield* first;
    expect((yield* competing).message).toContain("changed while this editor was open");
    expect(todo.pending).toHaveLength(1);
    const fresh = yield* todo.read();
    yield* todo.apply(todoDiff(fresh.source, fresh.source.replace("first", "corrected")));
    expect((yield* todo.read()).items[0].text).toBe("corrected");
    expect(todo.pending).toHaveLength(2);
  });

  it("joins an issued replacement before releasing a cancelled mutation", function* () {
    const root = yield* fixture();
    yield* writeTextFile(`${root}/todo.md`, "- [ ] original\n");
    const todo = yield* useTodo(root);
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    let joined = false;
    const writer = yield* spawn(function* () {
      yield* API.Fs.around(
        {
          *rename([from, to], next) {
            entered.resolve();
            yield* release.operation;
            return yield* next(from, to);
          },
        },
        { at: "min" },
      );
      yield* todo.save("- [ ] original\n", "- [ ] committed\n");
    });
    yield* entered.operation;
    const halt = yield* spawn(function* () {
      yield* writer.halt();
      joined = true;
    });
    expect(joined).toBe(false);
    release.resolve();
    yield* halt;
    expect(joined).toBe(true);
    expect(yield* readTextFile(`${root}/todo.md`)).toBe("- [ ] committed\n");
    expect(todo.pending).toEqual([]);
  });
  it("cancels before replacement without changing the file and retains unknown acknowledgement honestly", function* () {
    const root = yield* fixture();
    const source = "- [ ] original\n";
    yield* writeTextFile(`${root}/todo.md`, source);
    const todo = yield* useTodo(root);
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const writer = yield* spawn(function* () {
      yield* API.Fs.around(
        {
          *writeTextFile([path, text], next) {
            entered.resolve();
            yield* release.operation;
            return yield* next(path, text);
          },
        },
        { at: "min" },
      );
      yield* todo.save(source, "- [x] original\n");
    });
    yield* entered.operation;
    const stoppingStarted = withResolvers<void>();
    const stopping = yield* spawn(function* () {
      stoppingStarted.resolve();
      yield* writer.halt();
    });
    yield* stoppingStarted.operation;
    release.resolve();
    yield* stopping;
    expect(yield* readTextFile(`${root}/todo.md`)).toBe(source);
    expect(todo.pending).toEqual([]);
    const uncertain = yield* scoped(function* () {
      yield* API.Fs.around(
        {
          *rename([from, to], next) {
            yield* next(from, to);
            throw new Error("acknowledgement lost");
          },
        },
        { at: "min" },
      );
      return yield* failure(() => todo.save(source, "- [x] original\n"));
    });
    expect(uncertain.message).toContain("unknown");
    expect(yield* readTextFile(`${root}/todo.md`)).toBe("- [x] original\n");
    expect(todo.pending).toEqual([]);
    expect((yield* todo.read()).items).toEqual([{ text: "original", completed: true }]);
    expect(todo.pending).toEqual([]);
  });
});

describe("TODO exact source grammar and patches", () => {
  it("preserves CRLF, blanks, trailing spaces, headers and final-newline markers", function* () {
    const source = "\r\n- [X] first  \r\n\r\n- [ ] last";
    const patch = "--- a/todo.md\n+++ b/todo.md\n@@ -2 +2 @@\n-- [X] first  \n+- [ ] first  \n";
    expect(applyTodoDiff(parseTodo(source), patch).source).toBe(source.replace("[X]", "[ ]"));
    const next = source + " changed";
    expect(applyTodoDiff(parseTodo(source), todoDiff(source, next)).source).toBe(next);
  });

  it("moves exact mixed-ending lines and keeps the final newline disposition", function* () {
    const source = "- [X] first  \r\n\n- [ ] second\n- [ ] last";
    expect(editTodo(source, 1, "up")).toBe("- [ ] second\n\n- [X] first  \r\n- [ ] last");
    expect(editTodo(source, 2, "up")).toBe("- [X] first  \r\n\n- [ ] last\n- [ ] second");
    expect(editTodo(source, 0, "toggle")).toBe(source.replace("[X]", "[ ]"));
    expect(editTodo(source, 1, "toggle")).toBe(source.replace("[ ] second", "[x] second"));
  });

  it("refuses unsupported source and malformed or multi-file patches", function* () {
    for (const source of [
      "\ufeff- [ ] task\n",
      "  - [ ] nested\n",
      "# heading\n",
      "- [ ] ![image](a.png)\n",
    ]) {
      expect(() => parseTodo(source)).toThrow("todo.md:1");
    }
    for (const patch of [
      "diff --git a/todo.md b/other.md\n",
      "@@ -1,2 +1 @@\n-- [ ] old\n+- [ ] new\n",
      "--- a/other.md\n+++ b/other.md\n@@ -1 +1 @@\n-- [ ] old\n+- [ ] new\n",
    ]) {
      expect(() => applyTodoDiff(parseTodo("- [ ] old\n"), patch)).toThrow();
    }
  });
});

describe("TODO typed component and historical result", () => {
  it("requires as before effects, shares entry state, and replays an edit without repeating it", function* () {
    const root = yield* fixture();
    const todo = yield* useTodo(root);
    const missing = yield* entry("<Sidekick.Todo />");
    expect(missing.ok).toBe(false);
    expect(yield* exists(`${root}/todo.md`)).toBe(false);
    const history = new InMemoryStream();
    const source =
      '<Sidekick.Todo as="items">\n```diff\n@@ -0,0 +1 @@\n+- [ ] shared\n```\n</Sidekick.Todo>\n<Json value={items} />';
    const first = yield* entry(source, history);
    if (!first.ok) {
      throw first.error;
    }
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value).toContain('"text": "shared"');
    }
    expect((yield* todo.read()).items).toEqual([{ text: "shared", completed: false }]);
    const readHistory = new InMemoryStream();
    const other = yield* entry('<Sidekick.Todo as="items" />\n<Json value={items} />', readHistory);
    expect(other).toEqual(first);
    yield* writeTextFile(`${root}/todo.md`, "- [x] external\n");
    const before = todo.pending.length;
    expect(yield* entry(source, history)).toEqual(first);
    expect(
      yield* entry('<Sidekick.Todo as="items" />\n<Json value={items} />', readHistory),
    ).toEqual(other);
    expect(yield* readTextFile(`${root}/todo.md`)).toBe("- [x] external\n");
    expect(todo.pending).toHaveLength(before);
  });

  it("returns its own committed items while result delivery is held across a newer mutation", function* () {
    const root = yield* fixture();
    const todo = yield* useTodo(root);
    const delivering = withResolvers<void>();
    const release = withResolvers<void>();
    const journal: ControlJournal = {
      *began() {
        return 0;
      },
      *settled(_order, result) {
        if (result.ok) {
          delivering.resolve();
          yield* release.operation;
        }
      },
    };
    const running = yield* spawn(() =>
      entry(
        '<Sidekick.Todo as="items">\n```diff\n@@ -0,0 +1 @@\n+- [ ] earlier\n```\n</Sidekick.Todo>\n<Json value={items} />',
        new InMemoryStream(),
        journal,
      ),
    );
    yield* delivering.operation;
    yield* todo.save("- [ ] earlier\n", "- [x] newer\n");
    release.resolve();
    const result = yield* running;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('"text": "earlier"');
      expect(result.value).not.toContain("newer");
    }
    expect((yield* todo.read()).items[0].text).toBe("newer");
  });

  it("admits both forms from one captured definition and refuses writes under read-only admission", function* () {
    const root = yield* fixture();
    const todo = yield* useTodo(root);
    const ready = withResolvers<void>();
    const execution = yield* executeInstalled(
      {
        ...retainedSource("todo-host.md", "<TodoHost />"),
        stream: new InMemoryStream(),
      },
      [
        {
          components: [
            todoDeclaration(),
            {
              name: "TodoHost",
              origin: "test://todo-host",
              props: { type: "object", properties: {}, additionalProperties: false },
              factory: () =>
                function* () {
                  ready.resolve();
                  yield* suspend();
                  return "";
                },
            },
          ],
          *install() {
            yield* Component.around({
              generated: () => ({ "Sidekick.Todo": ["self-closing", "paired"] }),
            });
          },
        },
      ],
    );
    yield* ready.operation;
    const write =
      '<Sidekick.Todo as="items">\n```diff\n@@ -0,0 +1 @@\n+- [ ] generated\n```\n</Sidekick.Todo>';
    const refused = yield* execution.evaluateGeneratedXmdRoot({
      id: "refused",
      source: write,
      allow: ["read"],
    });
    expect(refused.ok).toBe(false);
    expect(todo.pending).toEqual([]);
    const written = yield* execution.evaluateGeneratedXmdRoot({
      id: "write",
      source: write,
      allow: ["read", "write"],
    });
    if (!written.ok) {
      throw written.error;
    }
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(written.value.output).toBe("");
    }
    const read = yield* execution.evaluateGeneratedXmdRoot({
      id: "read",
      source: '<Sidekick.Todo as="items" />\n<Json value={items} />',
      allow: ["read"],
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.output).toContain('"text": "generated"');
    }
  });
});
