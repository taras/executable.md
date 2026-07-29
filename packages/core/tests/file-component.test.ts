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
import { ensure, resource, scoped, until } from "effection";
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
 * Run `source` as a document whose contextual working directory is the
 * workspace.
 *
 * The document itself lives in the workspace too, but nothing depends on that:
 * `<File>` resolves against `Env.cwd`, which this installs explicitly rather
 * than inheriting from the process.
 */
function run(fixture: Fixture, source: string): Operation<Json> {
  return scoped(function* () {
    const path = join(fixture.workspace, "doc.md");
    yield* writeTextFile(path, source);
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return fixture.workspace;
        },
      },
      { at: "min" },
    );
    return yield* collect(
      yield* execute({ path, stream: new InMemoryStream(), componentDirs: [fixture.workspace] }),
    );
  });
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

    expect(output).toContain("cannot use the absolute path");
    expect(output).not.toContain("SECRET");
  });

  // FL8: the lexical escape, and the content it aimed at never appears.
  it("FL8: a path escaping through .. is rejected", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");

    const output = text(yield* run(fixture, '<File path="../outside/secret.txt" />'));

    expect(output).toContain("resolves outside the working directory");
    expect(output).not.toContain("SECRET");
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

    expect(output).toContain("leads through a symlink to");
    expect(output).not.toContain("SECRET");
  });

  // FL11: the same, one level up — the file does not exist yet, so only
  // resolving the existing ancestor catches it, and the write must not land
  // outside.
  it("FL11: a parent-directory symlink pointing outside is rejected", function* () {
    const fixture = yield* useFixture();
    yield* until(symlink(fixture.outside, join(fixture.workspace, "escape"), "dir"));

    const output = text(yield* run(fixture, '<File path="escape/planted.txt">planted</File>'));

    expect(output).toContain("leads through a symlink to");
    expect(yield* exists(join(fixture.outside, "planted.txt"))).toBe(false);
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

  // FL15: `<File>` performs no durable effect of its own, so a replay
  // re-reads and appends nothing — the same contract `<Parse>` has.
  it("FL15: a replay reproduces the read and journals nothing new", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "request.md"), "Request content");

    const stream = new InMemoryStream();
    const source = '<File path="request.md" as="request" />\n\nread: {request}';
    const path = join(fixture.workspace, "doc.md");

    const live = yield* scoped(function* () {
      yield* writeTextFile(path, source);
      yield* API.Env.around(
        {
          // deno-lint-ignore require-yield
          *cwd() {
            return fixture.workspace;
          },
        },
        { at: "min" },
      );
      return yield* collect(yield* execute({ path, stream }));
    });
    const appended = stream.appendCount;

    const replay = yield* scoped(function* () {
      yield* API.Env.around(
        {
          // deno-lint-ignore require-yield
          *cwd() {
            return fixture.workspace;
          },
        },
        { at: "min" },
      );
      return yield* collect(yield* execute({ path, stream }));
    });

    expect(text(live)).toContain("read: Request content");
    expect(replay).toEqual(live);
    expect(stream.appendCount).toBe(appended);
  });

  // FL16: props are validated like any component's — no name-specific check.
  it("FL16: a missing path and an undeclared prop are both rejected", function* () {
    const fixture = yield* useFixture();

    const missing = text(yield* run(fixture, "<File />"));
    expect(missing).toContain("path");

    const extra = text(yield* run(fixture, '<File path="a.md" encoding="utf16" />'));
    expect(extra).toContain("additional properties");
  });
});
