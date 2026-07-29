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

/**
 * A containment diagnostic may name the path the document wrote and nothing
 * else — not the resolved workspace, and not what a symlink pointed at (§1.2).
 */
function expectNoAbsolutePaths(output: string, fixture: Fixture): void {
  expect(output).not.toContain(fixture.workspace);
  expect(output).not.toContain(fixture.outside);
}

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

  // FL5: a missing file is a document diagnostic, not a crash — the sibling
  // after it still runs.
  it("FL5: reading a missing path fails as a diagnostic", function* () {
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

  // FL12: a failing block is an ordinary diagnostic, which for a component
  // that renders its content would simply appear in place. `<File>` renders
  // nothing, so the diagnostic would have been written into the file instead.
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
              throw new Error("disk full");
            },
          });
        },
      ),
    );

    expect(output).toContain("disk full");
    expect(yield* read(fixture, "notes.md")).toBe("first");
    expect(yield* entries(fixture.workspace)).toEqual(["notes.md"]);
  });

  // FL20: the same window, closed by cancellation rather than failure. The
  // write suspends after creating the temporary and the run is halted there.
  it("FL20: cancellation during the temporary write leaves nothing behind", function* () {
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
});
