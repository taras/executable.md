/**
 * Tier FL — `<File>` (spec §6.13).
 *
 * The component ships in core, so these drive the real definition through
 * `execute()`. Each test installs a directory as the contextual `Env.cwd` and
 * then works only in relative paths, which is the same position a document
 * inside a `<TempDir>` is in — without needing the directory to be temporary,
 * so a fixture can lay out symlinks and permissions first.
 *
 * `mkdtemp`, `realpath`, `symlink`, `chmod`, and `readdir` have no
 * `@effectionx/fs` equivalent; everything else goes through it. Removing a
 * fixture unlinks its symlinks rather than following them.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, resource, scoped, sleep, suspend, until } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { FileAccessError } from "../src/components/File.ts";
import { CORE_REGISTRY } from "../src/components/registry.ts";
import { Component } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { expandSegments } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import { ContentError, DocumentationError, ErrorMode } from "../src/errors.ts";
import type { ErrorSegment, FunctionComponentDefinition, Segment } from "../src/types.ts";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * A workspace and a directory beside it that is deliberately out of reach.
 *
 * `outside` is a sibling rather than a parent, so a symlink escaping the
 * workspace lands somewhere a test can then prove was never touched.
 */
interface Fixture {
  workspace: string;
  outside: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "fl-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    yield* until(mkdir(workspace));
    yield* until(mkdir(outside));

    yield* provide({ workspace, outside });
  });
}

/**
 * Install the workspace as the contextual working directory.
 *
 * The document lives in the workspace too, but nothing depends on that:
 * `<File>` resolves against `Env.cwd`, which this installs explicitly rather
 * than inheriting from the process.
 */
function* useWorkspaceCwd(fixture: Fixture): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd() {
        return fixture.workspace;
      },
    },
    { at: "min" },
  );
}

function run(fixture: Fixture, source: string): Operation<Json> {
  return runWith(fixture, source, new InMemoryStream());
}

/**
 * Run `source` as a document whose contextual working directory is the
 * workspace, against a caller-supplied journal.
 *
 * `install` runs inside the execution scope, before `execute()`, which is what
 * lets a test wrap the Fs Api to make a write fail or hang.
 */
function runWith(
  fixture: Fixture,
  source: string | undefined,
  stream: InMemoryStream,
  install?: () => Operation<void>,
): Operation<Json> {
  return scoped(function* () {
    const path = join(fixture.workspace, "doc.md");
    if (source !== undefined) {
      yield* writeTextFile(path, source);
    }
    yield* useWorkspaceCwd(fixture);
    if (install) {
      yield* install();
    }
    return yield* collect(yield* execute({ path, stream, componentDirs: [fixture.workspace] }));
  });
}

/**
 * The journal without the root's close, which is what makes the next run
 * replay what is there and then continue live rather than restoring a
 * completed execution.
 */
function* partial(stream: InMemoryStream): Operation<InMemoryStream> {
  const events = yield* stream.readAll();
  return new InMemoryStream(
    events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
}

/** What one expansion observed, and how it ended. */
interface Observation {
  /** Every ErrorSegment that passed through `Component.raise`, in order. */
  raised: ErrorSegment[];
  /** Every DocumentationError the observation chain constructed, in order. */
  failures: DocumentationError[];
  /** What the expansion produced, or nothing when it threw. */
  segments: Segment[];
  /** What the expansion threw, if anything. */
  thrown: unknown;
}

/**
 * A failing child, so the segment it reports is identifiable by reference.
 *
 * Failing rather than returning is what makes it a stand-in at all: the engine
 * reports a printed error for the failed invocation, and that segment — not text a
 * component chose to render — is the one `<File>` finds among its content and
 * the one the assertions below follow by identity.
 */
const BROKEN: FunctionComponentDefinition = {
  kind: "function",
  name: "Broken",
  props: { type: "object", properties: {}, additionalProperties: false },
  // deno-lint-ignore require-yield
  fn: printErrors(function* () {
    throw new Error("broken");
  }),
};

/** What the engine's printed error for a failed `<Broken />` reads. */
const BROKE = "Function component Broken error: broken";

/**
 * Expand `source` against the real `<File>` definition under `mode`, observing
 * every error where it is reported.
 *
 * `execute()` is the harness everywhere else here, because what the other tests
 * assert is what a document produces. This one goes a level down: how often a
 * failure is reported, and the shape of the failure that leaves the component —
 * which error object, carrying which others — are not things rendered output can
 * show.
 */
function observe(fixture: Fixture, source: string, mode: ErrorMode): Operation<Observation> {
  return scoped(function* () {
    const definition = CORE_REGISTRY.get("File")?.default?.definition;
    if (!definition) {
      throw new Error("the File component core supplies is missing");
    }
    const raised: ErrorSegment[] = [];
    const failures: DocumentationError[] = [];

    yield* useWorkspaceCwd(fixture);
    yield* Component.around({
      *raise([error], next) {
        raised.push(error);
        try {
          return yield* next(error);
        } catch (failure) {
          // The chain is where a throwing error mode constructs the
          // DocumentationError, so capturing it here is what lets the test
          // assert which of them leaves the expansion.
          if (failure instanceof DocumentationError) {
            failures.push(failure);
          }
          throw failure;
        }
      },
    });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          if (name === definition.name) {
            return definition;
          }
          if (name === "Broken") {
            return BROKEN;
          }
          throw new Error(`Component not found: ${name}`);
        },
      },
      { at: "min" },
    );
    yield* ErrorMode.set(mode);

    let segments: Segment[] = [];
    let thrown: unknown;
    try {
      segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
    } catch (error) {
      thrown = error;
    }
    return { raised, failures, segments, thrown };
  });
}

/** Everything reachable from `error` by `cause`, nearest first. */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (
    current instanceof Error &&
    current.cause !== undefined &&
    !chain.includes(current.cause)
  ) {
    current = current.cause;
    chain.push(current);
  }
  return chain;
}

function text(output: Json): string {
  return String(output);
}

function read(fixture: Fixture, relative: string): Operation<string> {
  return readTextFile(join(fixture.workspace, relative));
}

/** Everything in the workspace except the document each test writes there. */
function* entries(directory: string): Operation<string[]> {
  return (yield* until(readdir(directory))).filter((entry) => entry !== "doc.md").sort();
}

/** The temporaries a write left behind, named only by their suffix. */
function* temporaries(fixture: Fixture): Operation<string[]> {
  return (yield* entries(fixture.workspace)).filter((entry) => entry.endsWith(".tmp"));
}

/**
 * A containment printed error may name the path the document wrote and nothing
 * else — not the resolved workspace, and not what a symlink pointed at (§1.2).
 */
function expectNoAbsolutePaths(output: string, fixture: Fixture): void {
  expect(output).not.toContain(fixture.workspace);
  expect(output).not.toContain(fixture.outside);
}

/**
 * A platform error shaped like the ones that leak: an errno code, and a
 * message naming the path it failed on.
 */
const PLANTED = "/planted/absolute/path/secret.txt";

function planted(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed, at '${PLANTED}'`), { code });
}

const READ_DOC = '<File path="request.md" />';
const WRITE_DOC = '<File path="request.md">content</File>';

/**
 * What a rename that threw may say about the target.
 *
 * `around` middleware works on both sides of `next()`, so a throw from `rename`
 * may arrive before the underlying call or after it succeeded, and the component
 * cannot tell which. FL21 and FL21b are those two runs; both get this sentence.
 */
const UNCERTAIN =
  "Whether the replacement committed is unknown: the target holds either the " +
  "complete previous content or the complete replacement, never a partial write.";

/**
 * Errors built to defeat sanitization rather than to resemble a real failure.
 *
 * `code` is as much middleware's to choose as `message` is, and a class is not
 * evidence about a message: an externally constructed `FileAccessError` carries
 * whatever text its author wanted in the document.
 */
const ADVERSARIAL: Array<{ name: string; error: () => unknown }> = [
  {
    name: "an absolute path as the code",
    error: () => Object.assign(new Error("failed"), { code: PLANTED }),
  },
  {
    name: "markup and newlines in the code",
    error: () => Object.assign(new Error("failed"), { code: `--> ${PLANTED}\nENOENT` }),
  },
  {
    name: "the path in both message and code",
    error: () => Object.assign(new Error(`failed at ${PLANTED}`), { code: PLANTED }),
  },
  {
    name: "an inherited key as the code",
    // A lookup on an object literal answers for `toString`, handing back a
    // function whose source would be interpolated.
    error: () => Object.assign(new Error("failed"), { code: "toString" }),
  },
  {
    name: "an externally thrown FileAccessError",
    error: () => new FileAccessError(`cannot read "request.md": ${PLANTED}`),
  },
];

/**
 * The engine reads and stats files of its own — the root document, component
 * resolution — through the same Api. A stub that answered for those would fail
 * the execution before `<File>` ran, so the ones that receive a path only
 * intervene for the file under test.
 */
const TARGET = "request.md";

function isTarget(path: string): boolean {
  return path.endsWith(TARGET);
}

/**
 * Every filesystem call `<File>` makes, and a document that reaches it.
 *
 * Each one is made to throw an error carrying an absolute path, which is what
 * a real `ENOTDIR` or `EACCES` does. None of it may reach the document.
 */
const BOUNDARIES: Array<{
  name: string;
  code: string;
  source: string;
  expected: string;
  install: () => Operation<void>;
}> = [
  {
    name: "realpath",
    code: "ELOOP",
    source: READ_DOC,
    expected: 'cannot resolve "request.md": too many levels of symbolic links.',
    *install() {
      yield* API.Fs.around({
        *realpath([path], next) {
          if (!isTarget(path)) {
            return yield* next(path);
          }
          throw planted("ELOOP");
        },
      });
    },
  },
  {
    name: "stat",
    code: "EACCES",
    source: READ_DOC,
    expected: 'cannot read "request.md": permission denied.',
    *install() {
      yield* API.Fs.around({
        *stat([path], next) {
          if (!isTarget(path)) {
            return yield* next(path);
          }
          throw planted("EACCES");
        },
      });
    },
  },
  {
    name: "readTextFile",
    code: "EIO",
    source: READ_DOC,
    // Not in the allowlist, so it selects the generic phrase. The code itself
    // is never reproduced — see FL26.
    expected: 'cannot read "request.md": the filesystem operation failed.',
    *install() {
      yield* API.Fs.around({
        *readTextFile([path], next) {
          if (!isTarget(path)) {
            return yield* next(path);
          }
          throw planted("EIO");
        },
      });
    },
  },
  {
    name: "ensureDir",
    code: "EROFS",
    source: WRITE_DOC,
    expected: 'cannot write "request.md": the filesystem is read-only.',
    *install() {
      yield* API.Fs.around({
        *ensureDir() {
          throw planted("EROFS");
        },
      });
    },
  },
  {
    name: "writeTextFile",
    code: "EDQUOT",
    source: WRITE_DOC,
    expected: 'cannot write "request.md": the disk quota is exhausted.',
    *install() {
      yield* API.Fs.around({
        *writeTextFile() {
          throw planted("EDQUOT");
        },
      });
    },
  },
  {
    name: "rename",
    code: "EXDEV",
    source: WRITE_DOC,
    expected: 'cannot write "request.md": the destination is on a different filesystem.',
    *install() {
      yield* API.Fs.around({
        *rename() {
          throw planted("EXDEV");
        },
      });
    },
  },
];

describe("Tier FL — File", () => {
  beforeAll(() => useTempFileCompiler());

  // FL1: the ordinary round trip, in relative paths against the contextual
  // directory — the position every other test starts from.
  it("FL1: a relative write is readable at the same relative path", function* () {
    const fixture = yield* useFixture();

    const output = yield* run(
      fixture,
      ['<File path="request.md">Request content</File>', '<File path="request.md" />'].join("\n"),
    );

    expect(yield* read(fixture, "request.md")).toBe("Request content");
    expect(text(output)).toContain("Request content");
  });

  // FL2: the write form is not an expression. It contributes no output and no
  // path, so a document cannot accidentally leak where it wrote.
  it("FL2: the write form renders nothing", function* () {
    const fixture = yield* useFixture();

    const output = yield* run(fixture, '<File path="request.md">Request content</File>');

    expect(text(output).trim()).toBe("");
    expect(yield* read(fixture, "request.md")).toBe("Request content");
  });

  // FL3: a path names where the file goes, not a directory that must exist.
  it("FL3: a write creates the parent directories its path names", function* () {
    const fixture = yield* useFixture();

    yield* run(fixture, '<File path="fixtures/nested/request.md">nested</File>');

    expect(yield* read(fixture, "fixtures/nested/request.md")).toBe("nested");
  });

  // FL4: replacement, and the idempotence that follows from it — writing the
  // same content again leaves the same file rather than appending.
  it("FL4: a second write replaces the content", function* () {
    const fixture = yield* useFixture();

    yield* run(
      fixture,
      [
        '<File path="notes.md">first</File>',
        '<File path="notes.md">second</File>',
        '<File path="notes.md">second</File>',
      ].join("\n"),
    );

    expect(yield* read(fixture, "notes.md")).toBe("second");
  });

  // FL5: a missing file is a document printed error, not a crash — the sibling
  // after it still runs.
  it("FL5: reading a missing path fails as a printed error", function* () {
    const fixture = yield* useFixture();

    const output = text(yield* run(fixture, ['<File path="absent.md" />', "", "after"].join("\n")));

    expect(output).toContain('cannot read "absent.md": no such file.');
    expect(output).toContain("after");
  });

  // FL6: a directory is not text, and saying so is better than whatever
  // reading one produces on a given platform.
  it("FL6: reading a directory fails naming what it is", function* () {
    const fixture = yield* useFixture();

    const output = text(
      yield* run(
        fixture,
        ['<File path="dir/inner.md">inner</File>', '<File path="dir" />'].join("\n"),
      ),
    );

    expect(output).toContain('cannot read "dir": it is a directory, not a text file.');
  });

  // FL7: an absolute path is refused before anything is read, so the failure
  // says nothing about whether the target exists.
  it("FL7: an absolute path is rejected", function* () {
    const fixture = yield* useFixture();
    const secret = join(fixture.outside, "secret.txt");
    yield* writeTextFile(secret, "SECRET");

    const output = text(yield* run(fixture, `<File path="${secret}" />`));

    expect(output).toContain("an absolute path is not accepted");
    expect(output).not.toContain("SECRET");
    // The rejected path is absolute, so echoing it back would leak it just as
    // surely as resolving it would (§1.2).
    expectNoAbsolutePaths(output, fixture);
    expect(output).not.toContain(secret);
  });

  // FL8: the lexical escape, and the content it aimed at never appears.
  it("FL8: a path escaping through .. is rejected", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");

    const output = text(yield* run(fixture, '<File path="../outside/secret.txt" />'));

    expect(output).toContain("resolves outside the working directory");
    expect(output).not.toContain("SECRET");
    expectNoAbsolutePaths(output, fixture);
  });

  // FL9: a symlink that stays inside is ordinary. The write follows it to the
  // file it names rather than replacing the link, which is what makes reading
  // back through either name agree.
  it("FL9: an internal symlink is followed for both reads and writes", function* () {
    const fixture = yield* useFixture();
    yield* until(mkdir(join(fixture.workspace, "real")));
    yield* writeTextFile(join(fixture.workspace, "real/target.txt"), "original");
    yield* until(
      symlink(join(fixture.workspace, "real/target.txt"), join(fixture.workspace, "link.txt")),
    );

    const output = text(
      yield* run(
        fixture,
        ['<File path="link.txt" />', '<File path="link.txt">replaced</File>'].join("\n"),
      ),
    );

    expect(output).toContain("original");
    expect(yield* read(fixture, "real/target.txt")).toBe("replaced");
    expect((yield* until(lstat(join(fixture.workspace, "link.txt")))).isSymbolicLink()).toBe(true);
  });

  // FL10: a symlink whose target is outside is where a lexical check alone
  // would let a read through.
  it("FL10: a file symlink pointing outside is rejected", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");
    yield* until(
      symlink(join(fixture.outside, "secret.txt"), join(fixture.workspace, "escape.txt")),
    );

    const output = text(yield* run(fixture, '<File path="escape.txt" />'));

    expect(output).toContain("leads through a symlink outside the working directory");
    expect(output).not.toContain("SECRET");
    // Naming where the link pointed would report the escape by performing it.
    expectNoAbsolutePaths(output, fixture);
  });

  // FL11: the same, one level up — the file does not exist yet, so only
  // resolving the existing ancestor catches it, and the write must not land
  // outside.
  it("FL11: a parent-directory symlink pointing outside is rejected", function* () {
    const fixture = yield* useFixture();
    yield* until(symlink(fixture.outside, join(fixture.workspace, "escape"), "dir"));

    const output = text(yield* run(fixture, '<File path="escape/planted.txt">planted</File>'));

    expect(output).toContain("leads through a symlink outside the working directory");
    expect(yield* exists(join(fixture.outside, "planted.txt"))).toBe(false);
    expectNoAbsolutePaths(output, fixture);
  });

  // FL12: a failing block is an ordinary printed error, which for a component
  // that renders its content would simply appear in place. `<File>` renders
  // nothing, so the printed error would have been written into the file instead.
  // The invocation fails rather than writing, and carries the reason out.
  it("FL12: a failing child leaves an existing file untouched", function* () {
    const fixture = yield* useFixture();

    const output = text(
      yield* run(
        fixture,
        [
          '<File path="notes.md">first</File>',
          '<File path="notes.md">',
          "```sh exec",
          "echo nope >&2; exit 4",
          "```",
          "</File>",
        ].join("\n"),
      ),
    );

    expect(output).toContain('did not write "notes.md": its content failed to expand.');
    // The block's own failure travels with it — nothing else would report it.
    expect(output).toContain("Command failed (exit 4)");
    expect(yield* read(fixture, "notes.md")).toBe("first");
  });

  // FL12b: the same translation under fail-fast, where a failure is an object
  // rather than a rendered line. What ends the execution is `<File>`'s own
  // failure — the write is what the document asked for — and the content failure
  // it was translated from stays reachable beneath it, segments and all, so
  // nothing is lost by reporting the component's account instead of the child's.
  it("FL12b: the reported failure is File's own, with the content failure beneath it", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    const observed = yield* observe(fixture, '<File path="notes.md"><Broken /></File>', "throw");

    expect(yield* read(fixture, "notes.md")).toBe("first");

    // Two errors exist, each reported once: the child's, and the one `<File>`
    // chose in its place.
    expect(observed.raised).toHaveLength(2);
    expect(observed.raised[0].message).toBe(BROKE);
    expect(observed.failures).toHaveLength(2);
    expect(observed.failures[0].segment).toBe(observed.raised[0]);
    expect(observed.failures[1].segment).toBe(observed.raised[1]);

    const thrown = observed.thrown;
    expect(thrown).toBeInstanceOf(DocumentationError);
    if (!(thrown instanceof DocumentationError)) {
      throw new Error("expected a DocumentationError to leave the expansion");
    }
    expect(thrown).toBe(observed.failures[1]);
    // Not the child's decision resurrected: a different object, carrying the
    // printed error about the write that did not happen.
    expect(thrown).not.toBe(observed.failures[0]);
    expect(thrown.message).toContain('did not write "notes.md": its content failed to expand.');
    expect(thrown.message).toContain(BROKE);

    const chain = causes(thrown);
    const recovered = chain.find((link) => link instanceof ContentError);
    expect(recovered).toBeInstanceOf(ContentError);
    if (!(recovered instanceof ContentError)) {
      throw new Error("expected a ContentError in the reported failure's cause chain");
    }
    // The same segment objects the document reported, not copies.
    expect(recovered.errors).toHaveLength(1);
    expect(recovered.errors[0]).toBe(observed.raised[0]);
    // And the child's own failure, by identity.
    expect(chain.includes(observed.failures[0])).toBe(true);
  });

  // FL12c: the printing half of the same translation. The component reports
  // the same printed error once, and it is the whole invocation's result — the
  // child's segment is accounted for inside it rather than appended beside it.
  it("FL12c: a printed translation reports File's printed error once", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    const observed = yield* observe(fixture, '<File path="notes.md"><Broken /></File>', "print");

    expect(yield* read(fixture, "notes.md")).toBe("first");
    expect(observed.thrown).toBeUndefined();
    expect(observed.failures).toEqual([]);
    expect(observed.raised).toHaveLength(2);
    expect(observed.segments).toEqual([observed.raised[1]]);
    expect(observed.raised[1].message).toContain(
      'did not write "notes.md": its content failed to expand.',
    );
  });

  // FL13: the write itself failing is the other half. The replacement is a
  // rename over a temporary, so a directory that refuses new files stops it
  // before the previous content is disturbed.
  it("FL13: a failed replacement leaves the previous content in place", function* () {
    // Root ignores directory permissions, so there would be no failure to
    // observe and the assertion below would measure nothing.
    if (process.getuid?.() === 0) {
      return;
    }

    const fixture = yield* useFixture();
    const locked = join(fixture.workspace, "locked");
    yield* until(mkdir(locked));
    yield* writeTextFile(join(locked, "notes.md"), "first");
    yield* until(chmod(locked, 0o555));
    yield* ensure(() => until(chmod(locked, 0o755)));

    const output = text(yield* run(fixture, '<File path="locked/notes.md">second</File>'));

    expect(output).toContain("Function component File error:");
    expect(yield* read(fixture, "locked/notes.md")).toBe("first");
  });

  // FL14: the temporary the replacement goes through is an implementation
  // detail, and it must not become a document's problem.
  it("FL14: a successful write leaves no temporary file behind", function* () {
    const fixture = yield* useFixture();

    yield* run(fixture, '<File path="notes.md">content</File>');

    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // FL15: a journal with the root's close is a finished execution. Replaying
  // it restores that result without expanding anything, so `<File>` does not
  // run at all — proven by removing the file it read and getting the same
  // output anyway. This says nothing about the component; it is the root
  // contract, and it is what FL15b and FL15c have to be distinguished from.
  it("FL15: a completed-root replay restores the result without running File", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "request.md"), "Request content");

    const stream = new InMemoryStream();
    const source = '<File path="request.md" as="request" />\n\nread: {request}';

    const live = yield* runWith(fixture, source, stream);
    const appended = stream.appendCount;

    // Nothing on disk for a re-read to find.
    yield* rm(join(fixture.workspace, "request.md"));

    const replay = yield* runWith(fixture, undefined, stream);

    expect(text(live)).toContain("read: Request content");
    expect(replay).toEqual(live);
    expect(stream.appendCount).toBe(appended);
  });

  // FL15b: a partial journal replays what it holds and continues live, so
  // expansion reaches `<File>`. It performs no durable effect, so there is
  // nothing recorded to restore and the read happens again — against whatever
  // the file says now, which is how the repetition is observable.
  it("FL15b: a partial replay re-reads the file", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "request.md"), "first content");

    const stream = new InMemoryStream();
    const source = '<File path="request.md" as="request" />\n\nread: {request}';

    const live = yield* runWith(fixture, source, stream);
    expect(text(live)).toContain("read: first content");

    yield* writeTextFile(join(fixture.workspace, "request.md"), "second content");

    const replay = yield* runWith(fixture, undefined, yield* partial(stream));

    // The read really ran again: a restored result would still say "first".
    expect(text(replay)).toContain("read: second content");
  });

  // FL15c: the same for the write form. The file is removed between runs, so
  // finding it again can only mean the write repeated.
  it("FL15c: a partial replay re-writes the file", function* () {
    const fixture = yield* useFixture();

    const stream = new InMemoryStream();
    yield* runWith(fixture, '<File path="notes.md">content</File>', stream);
    expect(yield* read(fixture, "notes.md")).toBe("content");

    yield* rm(join(fixture.workspace, "notes.md"));

    yield* runWith(fixture, undefined, yield* partial(stream));

    expect(yield* exists(join(fixture.workspace, "notes.md"))).toBe(true);
    expect(yield* read(fixture, "notes.md")).toBe("content");
  });

  // FL16: props are validated like any component's — no name-specific check.
  it("FL16: a missing path and an undeclared prop are both rejected", function* () {
    const fixture = yield* useFixture();

    const missing = text(yield* run(fixture, "<File />"));
    expect(missing).toContain("path");

    const extra = text(yield* run(fixture, '<File path="a.md" encoding="utf16" />'));
    expect(extra).toContain("additional properties");
  });

  // FL17: only a complete `..` segment leaves the directory. A prefix test
  // would refuse an ordinary file whose name happens to start with two dots.
  it("FL17: a name beginning with dots is an ordinary file", function* () {
    const fixture = yield* useFixture();

    const output = text(
      yield* run(
        fixture,
        [
          '<File path="..notes.md">dotted</File>',
          '<File path="..config/settings.json">nested</File>',
          '<File path="..notes.md" />',
        ].join("\n"),
      ),
    );

    expect(output).toContain("dotted");
    expect(yield* read(fixture, "..notes.md")).toBe("dotted");
    expect(yield* read(fixture, "..config/settings.json")).toBe("nested");
  });

  // FL18: the destination is resolved after the children finish, because they
  // can change what the path means. Here the block swaps a real directory for
  // a symlink out of the workspace — resolving before expansion would have
  // validated the directory and then written through the link.
  it("FL18: a child replacing the parent with an escaping symlink is caught", function* () {
    const fixture = yield* useFixture();
    yield* until(mkdir(join(fixture.workspace, "out")));

    const output = text(
      yield* run(
        fixture,
        [
          '<File path="out/planted.txt">',
          "```sh exec",
          `rmdir out && ln -s ${fixture.outside} out`,
          "```",
          "</File>",
        ].join("\n"),
      ),
    );

    expect(output).toContain("leads through a symlink outside the working directory");
    expect(yield* exists(join(fixture.outside, "planted.txt"))).toBe(false);
    expect(yield* entries(fixture.outside)).toEqual([]);
    expectNoAbsolutePaths(output, fixture);
  });

  // FL18b: the lexical half of validation runs before the children, so an
  // absolute path costs nothing. The block would leave a file behind if it
  // ran, and the printed error would name the rejected path if the failure came
  // from the content stage instead.
  it("FL18b: a content-form absolute path is rejected before the children run", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.outside, "planted.txt");

    const output = text(
      yield* run(
        fixture,
        [`<File path="${target}">`, "```sh exec", "touch ran.txt; exit 7", "```", "</File>"].join(
          "\n",
        ),
      ),
    );

    expect(output).toContain("an absolute path is not accepted");
    // The block never ran: no marker, and none of its failure in the output.
    expect(yield* exists(join(fixture.workspace, "ran.txt"))).toBe(false);
    expect(output).not.toContain("exit 7");
    expect(output).not.toContain("its content failed to expand");
    expect(yield* exists(target)).toBe(false);
    expectNoAbsolutePaths(output, fixture);
    expect(output).not.toContain(target);
  });

  // FL18c: the same for a lexical escape. Together with FL18 these fix the
  // order: `..` and absolute are decided before expansion, and only the
  // symlink check waits for it.
  it("FL18c: a content-form lexical escape is rejected before the children run", function* () {
    const fixture = yield* useFixture();

    const output = text(
      yield* run(
        fixture,
        [
          '<File path="../outside/planted.txt">',
          "```sh exec",
          "touch ran.txt; exit 7",
          "```",
          "</File>",
        ].join("\n"),
      ),
    );

    expect(output).toContain("resolves outside the working directory");
    expect(yield* exists(join(fixture.workspace, "ran.txt"))).toBe(false);
    expect(output).not.toContain("exit 7");
    expect(output).not.toContain("its content failed to expand");
    expect(yield* entries(fixture.outside)).toEqual([]);
    expectNoAbsolutePaths(output, fixture);
  });

  // FL19: the temporary's removal is registered before it is written, so a
  // failure in the write itself — the likeliest place for one — is covered.
  it("FL19: a failure during the temporary write leaves nothing behind", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    const output = text(
      yield* runWith(
        fixture,
        '<File path="notes.md">second</File>',
        new InMemoryStream(),
        function* () {
          yield* API.Fs.around({
            // The temporary is created and then the write fails, which is the
            // case a cleanup registered afterwards would miss entirely.
            *writeTextFile([path, content], next) {
              yield* next(path, content);
              throw planted("ENOSPC");
            },
          });
        },
      ),
    );

    expect(output).toContain('cannot write "notes.md": no space left on the device.');
    // Preparation is the one step whose outcome is a conclusion: the commit was
    // never reached, so the previous file certainly stands.
    expect(output).toContain("The previous file is unchanged.");
    expect(output).not.toContain(PLANTED);
    expect(yield* read(fixture, "notes.md")).toBe("first");
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // FL20: the same window, closed by cancellation rather than failure — and
  // pre-commit, which is the half the contract still promises. The write
  // suspends after creating the temporary and the run is halted there.
  it("FL20: cancellation before the commit leaves the previous content", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    yield* race([
      runWith(fixture, '<File path="notes.md">second</File>', new InMemoryStream(), function* () {
        yield* API.Fs.around({
          *writeTextFile([path, content], next) {
            yield* next(path, content);
            yield* suspend();
          },
        });
      }),
      sleep(500),
    ]);

    expect(yield* read(fixture, "notes.md")).toBe("first");
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // FL21: the commit throwing before it reached the filesystem. The old file
  // stands, but the printed error cannot say so — a handler may equally throw
  // *after* committing (FL21b), and from inside the component the two are the
  // same event. So the wording is conservative for both.
  it("FL21: a rename that throws before next leaves the previous content", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    const output = text(
      yield* runWith(
        fixture,
        '<File path="notes.md">second</File>',
        new InMemoryStream(),
        function* () {
          yield* API.Fs.around({
            *rename() {
              throw planted("EXDEV");
            },
          });
        },
      ),
    );

    expect(output).toContain(
      'cannot write "notes.md": the destination is on a different filesystem.',
    );
    expect(output).toContain(UNCERTAIN);
    // Not claimed, because it is not knowable — but true here.
    expect(yield* read(fixture, "notes.md")).toBe("first");
    expect(output).not.toContain(PLANTED);
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // FL21b: the same throw, on the far side of `next()`. `around` middleware may
  // do work either side of it, so this is the error twin of FL22 — and it is
  // why FL21's wording cannot claim the previous file survived. Here it did
  // not: the replacement is committed and the printed error is still correct.
  it("FL21b: a rename that throws after next leaves the replacement committed", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    const output = text(
      yield* runWith(
        fixture,
        '<File path="notes.md">second</File>',
        new InMemoryStream(),
        function* () {
          yield* API.Fs.around({
            *rename([from, to], next) {
              yield* next(from, to);
              throw planted("EXDEV");
            },
          });
        },
      ),
    );

    expect(output).toContain(
      'cannot write "notes.md": the destination is on a different filesystem.',
    );
    // The identical sentence to FL21, and it has to be: "the previous file is
    // unchanged" would be a false statement about this run.
    expect(output).toContain(UNCERTAIN);
    expect(output).not.toContain("The previous file is unchanged.");
    // The commit did happen.
    expect(yield* read(fixture, "notes.md")).toBe("second");
    expect(output).not.toContain(PLANTED);
    // Cleanup succeeded either way: the rename consumed the temporary.
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // FL22: the commit is a commit, not a transaction. `rename` is one
  // filesystem call that cannot be interrupted once it starts, so a
  // cancellation arriving after it completes finds the replacement already
  // done — and does not undo it. What the contract promises is that no write
  // is ever half visible, not that a finished one can be taken back.
  it("FL22: cancellation after the commit does not roll it back", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    yield* race([
      runWith(fixture, '<File path="notes.md">second</File>', new InMemoryStream(), function* () {
        yield* API.Fs.around({
          *rename([from, to], next) {
            yield* next(from, to);
            yield* suspend();
          },
        });
      }),
      sleep(500),
    ]);

    expect(yield* read(fixture, "notes.md")).toBe("second");
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // FL23: a platform error names the path it failed on, which for a write can
  // be a temporary the document never wrote. Every call is wrapped, so what
  // reaches the document is the errno code's meaning and nothing else.
  for (const boundary of BOUNDARIES) {
    it(`FL23 (${boundary.name}): a ${boundary.code} failure reaches the document with no path`, function* () {
      const fixture = yield* useFixture();
      yield* writeTextFile(join(fixture.workspace, "request.md"), "existing");

      const output = text(
        yield* runWith(fixture, boundary.source, new InMemoryStream(), boundary.install),
      );

      expect(output).toContain(boundary.expected);
      expect(output).not.toContain(PLANTED);
      expect(output).not.toContain("operation failed, at");
      expectNoAbsolutePaths(output, fixture);
    });
  }

  // FL23b: a temporary that could not be removed is a fact about the
  // document's directory, so it is reported — but named by the document's own
  // path, because the temporary is generated and the document never chose it.
  it("FL23b: a failure removing the temporary is reported without naming it", function* () {
    const fixture = yield* useFixture();

    const output = text(
      yield* runWith(
        fixture,
        '<File path="request.md">content</File>',
        new InMemoryStream(),
        function* () {
          yield* API.Fs.around({
            *remove() {
              throw planted("EPERM");
            },
          });
        },
      ),
    );

    expect(output).toContain('cannot clean up "request.md": permission denied.');
    // The commit succeeded, and saying so is the difference between this and a
    // write that failed.
    // The rename returned, so the commit is a conclusion — and the leftover
    // sentence composes with it rather than replacing it.
    expect(output).toContain("The file was written.");
    expect(output).toContain("A temporary file beside it may remain.");
    expect(output).not.toContain(PLANTED);
    expectNoAbsolutePaths(output, fixture);
    expect(yield* read(fixture, "request.md")).toBe("content");
    // Nothing was actually left behind: the commit consumed the temporary, so
    // the removal that failed had nothing to remove. The report says "may
    // remain" because the component cannot tell the two cases apart — a
    // removal that failed is exactly the evidence it would need.
    expect(yield* entries(fixture.workspace)).toEqual(["request.md"]);
  });

  // FL23c: both halves fail. Neither may hide the other: the write's failure
  // says what is known about the target, and the cleanup's says something was
  // left behind — a reader needs both to know what the directory now holds.
  it("FL23c: a failed commit and a failed cleanup are reported together", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "notes.md"), "first");

    const output = text(
      yield* runWith(
        fixture,
        '<File path="notes.md">second</File>',
        new InMemoryStream(),
        function* () {
          yield* API.Fs.around({
            *rename() {
              throw planted("EXDEV");
            },
            *remove() {
              throw planted("EPERM");
            },
          });
        },
      ),
    );

    expect(output).toContain(
      'cannot write "notes.md": the destination is on a different filesystem.',
    );
    expect(output).toContain('cannot clean up "notes.md": permission denied.');
    // The target's outcome, then the leftover — orthogonal, and both present.
    expect(output).toContain(UNCERTAIN);
    expect(output).toContain("A temporary file beside it may remain.");
    expect(output).not.toContain(PLANTED);
    expectNoAbsolutePaths(output, fixture);

    // The old file did survive this run's failed commit...
    expect(yield* read(fixture, "notes.md")).toBe("first");
    // ...and the temporary remains, which is what the printed error warned about.
    expect(yield* temporaries(fixture)).toHaveLength(1);
  });

  // FL26: `code` is middleware's to choose, so it selects a phrase and never
  // builds one. Every shape below would put its content in the document if the
  // code were interpolated, or if an error's class were taken as evidence that
  // its message is safe.
  for (const shape of ADVERSARIAL) {
    it(`FL26 (${shape.name}): nothing planted reaches the document`, function* () {
      const fixture = yield* useFixture();
      yield* writeTextFile(join(fixture.workspace, TARGET), "existing");

      const output = text(
        yield* runWith(fixture, READ_DOC, new InMemoryStream(), function* () {
          yield* API.Fs.around({
            *readTextFile([path], next) {
              if (!isTarget(path)) {
                return yield* next(path);
              }
              throw shape.error();
            },
          });
        }),
      );

      expect(output).toContain('cannot read "request.md": the filesystem operation failed.');
      expect(output).not.toContain(PLANTED);
      expect(output).not.toContain("secret");
      // One printed error, on one line: a newline or a comment terminator in the
      // planted text would otherwise split or escape it.
      expect(output.split("ERROR:")).toHaveLength(2);
      expect(output.trim().split("\n")).toHaveLength(1);
    });
  }

  // FL24: the reported reproduction. A regular file standing where a directory
  // is expected produces ENOTDIR from `stat`, whose message carries the
  // canonical absolute path.
  it("FL24: a regular file as a path component fails without naming the path", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "parent"), "not a directory");

    const reading = text(yield* run(fixture, '<File path="parent/child.txt" />'));
    expect(reading).toContain(
      'cannot read "parent/child.txt": a component of the path is not a directory.',
    );
    expectNoAbsolutePaths(reading, fixture);

    const writing = text(yield* run(fixture, '<File path="parent/child.txt">content</File>'));
    expect(writing).toContain(
      'cannot write "parent/child.txt": a component of the path is not a directory.',
    );
    expectNoAbsolutePaths(writing, fixture);
    // The write never happened: `parent` is still the file it was.
    expect(yield* read(fixture, "parent")).toBe("not a directory");
  });

  // FL25: the working directory is inside itself. `.` is not an escape — it is
  // a directory, which is a question about the target rather than containment,
  // and the printed error should say so.
  it("FL25: the working directory itself is contained, and reported as a directory", function* () {
    const fixture = yield* useFixture();

    const reading = text(yield* run(fixture, '<File path="." />'));
    expect(reading).toContain('cannot read ".": it is a directory, not a text file.');
    expect(reading).not.toContain("outside the working directory");

    const writing = text(yield* run(fixture, '<File path=".">content</File>'));
    expect(writing).toContain('cannot write ".": it is a directory, not a text file.');
    expect(writing).not.toContain("outside the working directory");

    // A path that normalizes to the directory reads the same way.
    const normalized = text(yield* run(fixture, '<File path="sub/.." />'));
    expect(normalized).toContain("it is a directory, not a text file.");
    expect(normalized).not.toContain("outside the working directory");
  });
});
