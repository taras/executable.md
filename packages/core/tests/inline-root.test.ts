/**
 * Tier IR — root documents supplied as text (issue #76).
 *
 * Inline Markdown runs through the same pipeline a file does. What these
 * measure is that the pipeline is genuinely the same one: the identity travels
 * with the text, the text is captured where the journal can restore it, and
 * nothing about a supplied root changes where relative paths point or puts a
 * file on disk.
 *
 * The filesystem is the instrument throughout. A run that must not touch it is
 * given a provider that throws on every operation, so absence of I/O is
 * asserted rather than assumed — the existing B2 replay leaves its stub
 * installed and therefore cannot tell a journal restore from a second read.
 *
 * What replay cannot be asked: a replayed run is restored from the journal
 * rather than re-executed, so no assertion here distinguishes where inside the
 * root import the read is placed. IR4 pins the property that does the work —
 * the identity and the text are recorded — and IR6 marks the boundary.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { inspectDocument } from "../src/inspect.ts";
import { INLINE_SOURCE_PATH, inlineSource } from "../src/root-source.ts";
import type { InlineRootDocument, RootDocumentSource } from "../src/root-source.ts";
import { asText } from "./helpers.ts";

/**
 * A terminal filesystem that answers nothing. Installed where a run must reach
 * the filesystem zero times, so any contact names the path it wanted.
 */
function* useNoFs(): Operation<void> {
  yield* API.Fs.around({
    *readTextFile([path], _next): Operation<string> {
      throw new Error(`filesystem read: ${path}`);
    },
    *stat([path], _next) {
      throw new Error(`filesystem stat: ${path}`);
    },
    *glob(_args, _next) {
      throw new Error("filesystem glob");
    },
    *writeTextFile([path], _next) {
      throw new Error(`filesystem write: ${path}`);
    },
    *ensureDir([path], _next) {
      throw new Error(`filesystem ensureDir: ${path}`);
    },
    *rename([from], _next) {
      throw new Error(`filesystem rename: ${from}`);
    },
    *remove([path], _next) {
      throw new Error(`filesystem remove: ${path}`);
    },
    *realpath([path], _next) {
      throw new Error(`filesystem realpath: ${path}`);
    },
  });
}

/** Every path a run asked the filesystem about, in order. */
interface FsTrace {
  reads: string[];
  stats: string[];
  writes: string[];
}

/**
 * Record what a run asks of the filesystem and refuse every write.
 *
 * Installed *over* whatever answers reads, so it observes traffic instead of
 * terminating it — a guard wrapped around `useStubFs`, which never calls
 * `next`, would never fire.
 */
function* useFsWriteGuard(trace: FsTrace): Operation<void> {
  yield* API.Fs.around({
    *readTextFile([path], next): Operation<string> {
      trace.reads.push(path);
      return yield* next(path);
    },
    *stat([path], next) {
      trace.stats.push(path);
      return yield* next(path);
    },
    *writeTextFile([path], _next) {
      trace.writes.push(path);
      throw new Error(`the run wrote a file: ${path}`);
    },
    *ensureDir([path], _next) {
      trace.writes.push(path);
      throw new Error(`the run created a directory: ${path}`);
    },
    *rename([from, to], _next) {
      trace.writes.push(`${from} -> ${to}`);
      throw new Error(`the run renamed a file: ${from}`);
    },
  });
}

function* useStubExec(): Operation<void> {
  yield* API.Process.around({
    *exec(_args, _next) {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

/** A directory the contextual cwd points at, removed when the test ends. */
function* useWorkspace(files: Record<string, string>): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-inline-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    yield* writeTextFile(join(root, name), content);
  }
  yield* API.Env.around(
    {
      *cwd() {
        return root;
      },
    },
    { at: "min" },
  );
  yield* useHostFiles();
  return root;
}

function importEvents(stream: InMemoryStream) {
  return stream
    .snapshot()
    .flatMap((event) =>
      event.type === "yield" && event.description.type === "import_component" ? [event] : [],
    );
}

describe("Tier IR — inline root documents", () => {
  it("IR1: inspection reports the <eval> identity and reads nothing", function* () {
    yield* useNoFs();

    const info = yield* inspectDocument(
      inlineSource(["---", "props:", "  name:", "    type: string", "---", "", "# Hi"].join("\n")),
    );

    expect(info.path).toBe("<eval>");
    expect(info.props).toMatchObject({ properties: { name: { type: "string" } } });
    expect(info.returnMode).toBe("text");
  });

  it("IR2: inspection reports a declared value root", function* () {
    yield* useNoFs();

    const info = yield* inspectDocument(
      inlineSource(["---", "returns:", "  type: object", "---", "", "body"].join("\n")),
    );

    expect(info.returnMode).toBe("value");
    expect(info.returns).toMatchObject({ type: "object" });
  });

  /**
   * The identity contract, asserted where it lives. TypeScript is structural,
   * so `inlineSource()` is a convenience rather than an enforcement: a caller
   * may hand-write `{ path: INLINE_SOURCE_PATH, source }`. What the type does
   * enforce is that supplied text cannot arrive without an identity, or under
   * a different one — widening `InlineRootDocument["path"]` to `string`, or
   * defaulting a missing identity at a shared read site, flips one of these
   * literals and fails the typecheck.
   */
  it("IR3: supplied text cannot travel without its identity", function* () {
    type Accepts<T> = T extends RootDocumentSource ? true : false;

    const rejectsBareSource: Accepts<{ source: string }> = false;
    const rejectsForeignIdentity: Accepts<{ path: "scratch.md"; source: string }> = false;
    const acceptsInline: Accepts<InlineRootDocument> = true;
    const acceptsPath: Accepts<{ path: string }> = true;

    expect([rejectsBareSource, rejectsForeignIdentity, acceptsInline, acceptsPath]).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(inlineSource("body")).toEqual({ path: INLINE_SOURCE_PATH, source: "body" });
  });

  it("IR4: the journal holds the supplied identity and text", function* () {
    yield* useNoFs();
    const stream = new InMemoryStream();

    yield* collect(yield* execute({ ...inlineSource("# Hello\n"), stream }));

    const imports = importEvents(stream);
    expect(imports.length).toBe(1);
    expect(imports[0]).toMatchObject({
      description: { name: "__root__" },
      result: { status: "ok", value: { path: "<eval>", content: "# Hello\n" } },
    });
  });

  it("IR5: an inline root replays from the journal", function* () {
    yield* useNoFs();
    const stream = new InMemoryStream();
    const root = inlineSource("# Hello\n");

    const golden = asText(yield* collect(yield* execute({ ...root, stream })));
    const replayed = asText(yield* collect(yield* execute({ ...root, stream })));

    expect(replayed).toBe(golden);
    expect(importEvents(stream).length).toBe(1);
  });

  /**
   * The file-backed half, and the boundary of what replay can be asked to show.
   *
   * A replayed run restores the document from its journal instead of
   * re-executing, so nothing downstream of `durableRun` runs again — not the
   * import, not the body. That makes a round trip a measurement of the journal's
   * completeness, and *not* a measurement of where inside the import the read
   * sits: hoisting the read above `createDurableOperation` leaves every replay
   * assertion green, because the replay never reaches either position. What
   * IR4 pins is the property that matters — the content is in the journal.
   *
   * This root fails after its import is recorded, so the case covers a journal
   * that ends in a failure as well as one that ends in a value: the recorded
   * outcome is reproduced with the filesystem throwing on every call. B2 in
   * `execute.test.ts` leaves its stub installed and so cannot say that much.
   */
  it("IR6: a failed run replays its outcome with no filesystem at all", function* () {
    const stream = new InMemoryStream();
    const source = ["---", "returns:", "  ok: { type: boolean }", "---", "", "no return"].join(
      "\n",
    );

    const golden = yield* scoped(function* () {
      yield* useStubFs({ "doc.md": source });
      yield* useStubExec();
      return yield* yield* execute({ path: "doc.md", stream });
    });
    expect(golden.ok).toBe(false);
    expect(importEvents(stream).length).toBe(1);

    yield* useNoFs();
    const replayed = yield* yield* execute({ path: "doc.md", stream });

    expect(replayed.ok).toBe(false);
    const message = replayed.ok ? "" : replayed.error.message;
    expect(message).toContain("no direct top-level <Return>");
    expect(message).not.toContain("filesystem read");
  });

  it("IR7: source positions report <eval> past the frontmatter", function* () {
    yield* useNoFs();
    const stream = new InMemoryStream();

    const output = asText(
      yield* collect(
        yield* execute({
          ...inlineSource(["---", "title: demo", "---", "", "<Else>orphan</Else>"].join("\n")),
          stream,
        }),
      ),
    );

    expect(output).toContain("(<eval>:5:1)");
  });

  it("IR8: an inline value root returns its declared value", function* () {
    yield* useNoFs();
    const stream = new InMemoryStream();

    const value = yield* collect(
      yield* execute({
        ...inlineSource(
          [
            "---",
            "returns:",
            "  ok: { type: boolean }",
            "---",
            "",
            "<Return value={{ ok: true }} />",
          ].join("\n"),
        ),
        stream,
      }),
    );

    expect(value).toEqual({ ok: true });
  });

  it("IR9: repository components resolve from the search path, not the root", function* () {
    const trace: FsTrace = { reads: [], stats: [], writes: [] };
    // The guard first: `useStubFs` is terminal, so a guard installed after it
    // would sit below and never see a call.
    yield* useFsWriteGuard(trace);
    yield* useStubFs({ "components/Greeting.md": "Hello from a component\n" });
    const stream = new InMemoryStream();

    const output = asText(
      yield* collect(yield* execute({ ...inlineSource("<Greeting />\n"), stream })),
    );

    expect(output).toContain("Hello from a component");
    // Every candidate is relative and none is derived from the root's identity.
    expect(trace.stats.some((path) => path.includes("<eval>"))).toBe(false);
    expect(trace.stats.every((path) => !path.startsWith("/"))).toBe(true);
    expect(trace.reads).toEqual(["components/Greeting.md"]);
  });

  it("IR10: a relative path resolves against the contextual cwd", function* () {
    yield* useWorkspace({ "notes.md": "notes from the working directory\n" });
    const stream = new InMemoryStream();

    const output = asText(
      yield* collect(yield* execute({ ...inlineSource('<File path="notes.md" />\n'), stream })),
    );

    expect(output).toContain("notes from the working directory");
  });

  it("IR11: props are validated and defaulted for a supplied root", function* () {
    yield* useNoFs();
    const source = [
      "---",
      "props:",
      "  name:",
      "    type: string",
      "  loud:",
      "    type: boolean",
      "    default: false",
      "required: [name]",
      "---",
      "",
      "{props.name} {props.loud}",
    ].join("\n");

    const stream = new InMemoryStream();
    const output = asText(
      yield* collect(yield* execute({ ...inlineSource(source), props: { name: "Ada" }, stream })),
    );
    expect(output).toContain("Ada false");

    const missing = new InMemoryStream();
    const result = yield* execute({ ...inlineSource(source), stream: missing });
    const completion = yield* result;
    expect(completion.ok).toBe(false);
  });

  it("IR12: running a supplied root writes nothing", function* () {
    const trace: FsTrace = { reads: [], stats: [], writes: [] };
    // The guard first: `useStubFs` is terminal, so a guard installed after it
    // would sit below and never see a call.
    yield* useFsWriteGuard(trace);
    yield* useStubFs({ "components/Greeting.md": "Hello from a component\n" });
    const stream = new InMemoryStream();

    yield* collect(yield* execute({ ...inlineSource("<Greeting />\n"), stream }));

    expect(trace.writes).toEqual([]);
    // The guard is live rather than inert: it saw the component read below it.
    expect(trace.reads).toContain("components/Greeting.md");
  });
});
