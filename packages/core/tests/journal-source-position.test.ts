/**
 * Tier JSP — where an authored durable operation says it was written.
 *
 * A journal entry's identity is its `type` and `name`. A position is neither,
 * so it travels beside them under one stable namespaced field and takes no part
 * in matching — which is the whole reason it can be added to an existing
 * description at all. These tests hold both halves: the position is retained for
 * the operations an author wrote, and replay still matches the entries it
 * matched before.
 *
 * The document is a real file, because a position without a path is a position
 * in nothing: what makes `release.md:5:1` useful is that it names the file the
 * reader has open.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  collect,
  execute,
  inlineSource,
  registerComponents,
  SOURCE_POSITION_FIELD,
} from "../mod.ts";

const LINES = [
  "# Release",
  "",
  "<Mark />",
  "",
  "```bash exec",
  "echo hi",
  "```",
  "",
  "```js eval",
  "export const answer = 41 + 1;",
  "```",
  "",
];

const DOCUMENT = LINES.join("\n");

/** The 1-based line a written token sits on, read from the document itself. */
function lineOf(token: string): number {
  return LINES.findIndex((line) => line.startsWith(token)) + 1;
}

function useDocument(): Operation<string> {
  return resource<string>(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "xmd-jsp-")));
    yield* ensure(function* () {
      yield* rm(dir, { recursive: true, force: true });
    });
    const path = join(dir, "release.md");
    yield* writeTextFile(path, DOCUMENT);
    yield* provide(path);
  });
}

/** `<Mark />` — one authored element whose import is journaled. */
function useMark(): Operation<void> {
  return registerComponents([
    {
      name: "Mark",
      origin: "tier-jsp",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn() {
        return "";
      },
    },
  ]);
}

/** The position one operation retained, or `undefined` when it retained none. */
function sourceOf(events: DurableEvent[], type: string, name?: string): unknown {
  const found = events.find(
    (event) =>
      event.type === "yield" &&
      event.description.type === type &&
      (name === undefined || event.description.name === name),
  );
  if (found === undefined || found.type !== "yield") {
    throw new Error(`no ${type} event was journaled`);
  }
  return found.description[SOURCE_POSITION_FIELD];
}

describe("Tier JSP — authored source in the journal", () => {
  it("JSP1: component imports, commands and eval blocks retain where they were written", function* () {
    const path = yield* useDocument();
    const stream = new InMemoryStream();
    yield* useMark();
    yield* collect(yield* execute({ path, stream }));

    const events = yield* stream.readAll();

    expect(sourceOf(events, "import_component", "Mark")).toEqual({
      path,
      offset: DOCUMENT.indexOf("<Mark />"),
      line: lineOf("<Mark />"),
      column: 1,
    });
    expect(sourceOf(events, "exec")).toEqual({
      path,
      offset: DOCUMENT.indexOf("```bash exec"),
      line: lineOf("```bash exec"),
      column: 1,
    });
    expect(sourceOf(events, "eval")).toEqual({
      path,
      offset: DOCUMENT.indexOf("```js eval"),
      line: lineOf("```js eval"),
      column: 1,
    });
  });

  it("JSP2: the root import and the root Close carry no authored source", function* () {
    const path = yield* useDocument();
    const stream = new InMemoryStream();
    yield* useMark();
    yield* collect(yield* execute({ path, stream }));

    const events = yield* stream.readAll();

    // The root is the run's own entry rather than an element somebody wrote.
    expect(sourceOf(events, "import_component", "__root__")).toBeUndefined();

    const close = events.find((event) => event.type === "close" && event.coroutineId === "root");
    expect(close).toBeDefined();
    expect(close && "description" in close).toBe(false);
  });

  it("JSP3: an inline document's position names the inline document", function* () {
    const stream = new InMemoryStream();
    yield* useMark();
    const root = inlineSource("<Mark />\n");
    yield* collect(yield* execute({ ...root, stream }));

    // An inline root has an identity of its own rather than a file path, and
    // the position carries that identity unchanged rather than inventing one.
    const source = sourceOf(yield* stream.readAll(), "import_component", "Mark");
    expect(source).toEqual({ path: root.path, offset: 0, line: 1, column: 1 });
  });

  it("JSP4: a position is not identity, so a recorded run replays", function* () {
    const path = yield* useDocument();
    const stream = new InMemoryStream();
    yield* useMark();
    const first = yield* collect(yield* execute({ path, stream }));
    const recorded = (yield* stream.readAll()).length;

    // The same journal, replayed: every entry matches by type and name, and a
    // full replay adds nothing to what was already retained.
    const replayed = yield* collect(yield* execute({ path, stream }));

    expect(replayed).toEqual(first);
    expect((yield* stream.readAll()).length).toBe(recorded);
  });
});
