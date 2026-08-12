/**
 * Tier GB — `<Glob>` (spec §6.14).
 *
 * `Glob.test.md` covers the matching contract in Markdown; these cover what a
 * document cannot construct. Each test installs a directory as the contextual
 * `Env.cwd` and then works only in relative paths — the same position a document
 * inside a `<TempDir>` is in, without needing the directory to be temporary, so
 * a fixture can lay out symlinks first and a test can point `Env.cwd` at
 * something that is not a directory at all.
 *
 * `mkdtemp`, `realpath`, and `symlink` have no `@effectionx/fs` equivalent;
 * everything else goes through it. Removing a fixture unlinks its symlinks
 * rather than following them.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, resource, scoped, sleep, suspend, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, FsApi, rm, writeTextFile } from "@effectionx/fs";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { GlobError } from "../src/components/Glob.ts";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A workspace and a directory beside it that is deliberately out of reach.
 *
 * `outside` is a sibling rather than a parent, so a symlink escaping the
 * workspace lands somewhere a test can then prove was never searched.
 */
interface Fixture {
  workspace: string;
  outside: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "gb-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    yield* until(mkdir(workspace));
    yield* until(mkdir(outside));

    yield* provide({ workspace, outside });
  });
}

/** Install `directory` as the contextual working directory. */
function* useCwd(directory: string): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd() {
        return directory;
      },
    },
    { at: "min" },
  );
}

function run(fixture: Fixture, source: string): Operation<Json> {
  return runWith(fixture, source, new InMemoryStream());
}

/**
 * What one run said: its rendered text, or the diagnostic it reported. A
 * refusal nothing recovers is the run's own outcome.
 */
function said(fixture: Fixture, source: string): Operation<string> {
  return (function* () {
    try {
      return String(yield* run(fixture, source));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
}

/**
 * Run `source` as a document whose contextual working directory is the
 * workspace, against a caller-supplied journal.
 *
 * `install` runs inside the execution scope, before `execute()`, which is what
 * lets a test wrap the Fs Api to make traversal fail or hang, or point `Env.cwd`
 * somewhere unusable.
 */
function runWith(
  fixture: Fixture,
  source: string | undefined,
  stream: InMemoryStream,
  install?: () => Operation<void>,
): Operation<Json> {
  return scoped(function* () {
    // The document lives beside the workspace, not inside it, so it is never
    // itself a match — a `**/*` in a test means only what the test laid out.
    const path = join(fixture.workspace, "..", "doc.md");
    if (source !== undefined) {
      yield* writeTextFile(path, source);
    }
    yield* useCwd(fixture.workspace);
    // `API.Files` has no host default, so a suite driving `execute()` directly
    // installs the provider the way an entrypoint does.
    yield* useHostFiles();
    if (install) {
      yield* install();
    }
    return yield* collect(yield* execute({ path, stream, componentDirs: [fixture.workspace] }));
  });
}

/**
 * The journal without the root's close, which is what makes the next run replay
 * what is there and then continue live rather than restoring a completed
 * execution.
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

/**
 * A printed error may name the patterns the document wrote and nothing else — not
 * the resolved workspace, and not what a symlink pointed at (§1.2).
 */
function expectNoAbsolutePaths(output: string, fixture: Fixture): void {
  expect(output).not.toContain(fixture.workspace);
  expect(output).not.toContain(fixture.outside);
}

/**
 * A platform error shaped like the ones that leak: an errno code, and a message
 * naming the path it failed on.
 */
const PLANTED = "/planted/absolute/path/secret.txt";

function planted(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed, at '${PLANTED}'`), { code });
}

/** Search the whole tree and render what came back. */
const FIND_ALL = '<Glob include={["**/*"]} as="found" />\n\nfound: {found}';

/**
 * `FIND_ALL`'s rendered listing for an expected result.
 *
 * A binding interpolated into text is rendered with `String()`, which joins an
 * array on a bare comma. Building the expectation the same way keeps the tests
 * about the paths and their order rather than about that spelling.
 */
function found(...paths: string[]): string {
  return `found: ${paths.join(",")}`;
}

/** Lay out `paths` as files under the workspace, each holding its own name. */
function* plant(fixture: Fixture, paths: string[]): Operation<void> {
  for (const path of paths) {
    const target = join(fixture.workspace, path);
    yield* ensureDir(join(target, ".."));
    yield* writeTextFile(target, path);
  }
}

/**
 * Errors built to defeat sanitization rather than to resemble a real failure.
 *
 * `code` is as much middleware's to choose as `message` is, and a class is not
 * evidence about a message: an externally constructed `GlobError` carries
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
    name: "an inherited key as the code",
    // A lookup on an object literal answers for `toString`, handing back a
    // function whose source would be interpolated.
    error: () => Object.assign(new Error("failed"), { code: "toString" }),
  },
  {
    name: "an externally thrown GlobError",
    error: () => new GlobError(`cannot search the working directory: ${PLANTED}`),
  },
];

describe("Tier GB — Glob component", () => {
  // GB1: props are validated like any component's — no name-specific check.
  it("GB1: include is required and undeclared props are rejected", function* () {
    const fixture = yield* useFixture();

    const missing = yield* said(fixture, '<Glob as="found" />');
    expect(missing).toContain("must have required property 'include'");

    const extra = yield* said(fixture, '<Glob include={["*.md"]} hidden={true} as="found" />');
    expect(extra).toContain("additional properties");
  });

  // GB2: an empty include list is not "match nothing" — it is a pattern list
  // that forgot to say anything, and the schema is where that is caught.
  it("GB2: an empty include list is rejected", function* () {
    const fixture = yield* useFixture();

    const output = yield* said(fixture, '<Glob include={[]} as="found" />');

    expect(output).toContain('"/include" must NOT have fewer than 1 items');
  });

  // GB3: the props schema types both lists, so a bare string and a list of
  // non-strings are refused before the component runs.
  it("GB3: include and exclude must be lists of strings", function* () {
    const fixture = yield* useFixture();

    const bare = yield* said(fixture, '<Glob include={"*.md"} as="found" />');
    expect(bare).toContain('"/include" must be array');

    const numbers = yield* said(fixture, '<Glob include={[1, 2]} as="found" />');
    expect(numbers).toContain('"/include/0" must be string');

    const badExclude = yield* said(fixture, '<Glob include={["*.md"]} exclude={"x"} as="found" />');
    expect(badExclude).toContain('"/exclude" must be array');
  });

  // GB4: declaring `returns` is what requires `as` (§6.10). Nothing in the
  // component enforces it, which is the point — it is the value-component
  // contract, not a rule of its own.
  it("GB4: invoking without as fails", function* () {
    const fixture = yield* useFixture();

    const output = yield* said(fixture, '<Glob include={["*.md"]} />');

    expect(output).toContain("must be invoked with `as`");
  });

  // GB5: `exclude` is optional, and omitting it excludes nothing.
  it("GB5: exclude defaults to empty", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md", "nested/b.md"]);

    const output = text(yield* run(fixture, FIND_ALL));

    expect(output).toContain(found("a.md", "nested/b.md"));
  });

  // GB6: patterns match paths relative to `Env.cwd`, so an absolute pattern
  // cannot match anything a search produces. Returning `[]` would make a typo
  // indistinguishable from an empty directory, so it fails instead — and the
  // printed error quotes the document's own text, which is the one absolute path
  // §1.2 does not have to withhold, because the document wrote it.
  it("GB6: an absolute pattern fails", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md"]);

    const include = text(yield* run(fixture, '<Glob include={["/etc/**"]} as="found" />'));
    expect(include).toContain("include");
    expect(include).toContain("is absolute");
    expect(include).toContain("/etc/**");

    const exclude = text(
      yield* run(fixture, '<Glob include={["*.md"]} exclude={["/etc/**"]} as="found" />'),
    );
    expect(exclude).toContain("exclude");
    expect(exclude).toContain("is absolute");
  });

  // GB7: the same for a pattern that starts by leaving. Only a whole leading
  // `..` segment does: `..notes.md` is an ordinary name, and a `..` further
  // along is a path a search never produces, so it matches nothing for the
  // ordinary reason.
  it("GB7: a pattern that reaches outside fails, but a dotted name does not", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["..notes.md"]);

    const escaping = text(yield* run(fixture, '<Glob include={["../*.md"]} as="found" />'));
    expect(escaping).toContain("reaches outside the working directory");

    const bare = text(yield* run(fixture, '<Glob include={[".."]} as="found" />'));
    expect(bare).toContain("reaches outside the working directory");

    const dotted = text(
      yield* run(fixture, '<Glob include={["..notes.md"]} as="found" />\n\nfound: {found}'),
    );
    expect(dotted).toContain(found("..notes.md"));

    // A `..` further along needs no refusal: traversal never produces a path
    // containing one, so it matches nothing for the ordinary reason. This is
    // the claim that makes refusing only a leading segment sufficient.
    const deep = text(
      yield* run(
        fixture,
        '<Glob include={["docs/../../../etc/passwd"]} as="found" />\n\nfound: [{found}]',
      ),
    );
    expect(deep).toContain("found: []");
  });

  // GB8: an empty pattern matches nothing by construction, so it is the same
  // authoring mistake as an absolute one.
  it("GB8: an empty pattern fails", function* () {
    const fixture = yield* useFixture();

    const output = text(yield* run(fixture, '<Glob include={["*.md", ""]} as="found" />'));

    expect(output).toContain("empty pattern");
  });

  // GB9: a pattern the dialect cannot compile — an unterminated character class
  // — arrives as a `SyntaxError` about a translated regular expression the
  // author never wrote. Which pattern it was is not recoverable from the error,
  // so the candidates are listed rather than one being named.
  it("GB9: a pattern that cannot be compiled fails naming the candidates", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md"]);

    const include = text(yield* run(fixture, '<Glob include={["*.md", "[bad"]} as="found" />'));
    expect(include).toContain("cannot be used");
    expect(include).toContain('"[bad"');
    expect(include).not.toContain("Unterminated");

    const exclude = text(
      yield* run(fixture, '<Glob include={["*.md"]} exclude={["[bad"]} as="found" />'),
    );
    expect(exclude).toContain("cannot be used");
    expect(exclude).toContain('"[bad"');
  });

  // GB10: a working directory that is not there, and one that is a file. Both
  // are about the document's environment rather than about one entry inside a
  // directory that was fine, and both withhold the path (§1.2).
  it("GB10: a missing working directory fails", function* () {
    const fixture = yield* useFixture();
    const gone = join(fixture.workspace, "gone");

    const output = text(
      yield* runWith(fixture, FIND_ALL, new InMemoryStream(), function* () {
        yield* useCwd(gone);
      }),
    );

    expect(output).toContain("the working directory does not exist");
    expectNoAbsolutePaths(output, fixture);
    expect(output).not.toContain(gone);
  });

  it("GB11: a working directory that is a file fails", function* () {
    const fixture = yield* useFixture();
    const file = join(fixture.workspace, "a.md");
    yield* writeTextFile(file, "a");

    const output = text(
      yield* runWith(fixture, FIND_ALL, new InMemoryStream(), function* () {
        yield* useCwd(file);
      }),
    );

    expect(output).toContain("the working directory is not a directory");
    expectNoAbsolutePaths(output, fixture);
  });

  // GB12: a directory read that fails part-way through traversal. The error
  // names the directory it failed on, which is an absolute path under the
  // workspace that the document never wrote — so the sentence reports the
  // reason and no path at all.
  it("GB12: a traversal failure is reported without a path", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md"]);

    const output = text(
      yield* runWith(fixture, FIND_ALL, new InMemoryStream(), function* () {
        yield* API.Fs.around({
          // deno-lint-ignore require-yield
          *glob() {
            throw planted("EACCES");
          },
        });
      }),
    );

    expect(output).toContain("cannot search the working directory: permission denied.");
    expect(output).not.toContain(PLANTED);
    expect(output).not.toContain("EACCES");
  });

  // GB12b: `stat` is the other Api call the component makes, and it leaks the
  // same way if forwarded.
  it("GB12b: a failing stat of the working directory is reported without a path", function* () {
    const fixture = yield* useFixture();

    const output = text(
      yield* runWith(fixture, FIND_ALL, new InMemoryStream(), function* () {
        yield* API.Fs.around({
          *stat([path], next) {
            if (path === fixture.workspace) {
              throw planted("ELOOP");
            }
            return yield* next(path);
          },
        });
      }),
    );

    expect(output).toContain("too many levels of symbolic links");
    expect(output).not.toContain(PLANTED);
  });

  // GB13: an unrecognized errno selects the generic phrase rather than being
  // forwarded, because the code is chosen by whatever implements the Fs Api.
  it("GB13: an unrecognized code selects the generic phrase", function* () {
    const fixture = yield* useFixture();

    const output = text(
      yield* runWith(fixture, FIND_ALL, new InMemoryStream(), function* () {
        yield* API.Fs.around({
          // deno-lint-ignore require-yield
          *glob() {
            throw planted("ENOTAREALCODE");
          },
        });
      }),
    );

    expect(output).toContain("the filesystem operation failed");
    expect(output).not.toContain("ENOTAREALCODE");
    expect(output).not.toContain(PLANTED);
  });

  // GB14: the adversarial half. Neither the code nor the class is evidence
  // about a message, so nothing from a caught error reaches the document.
  for (const { name, error } of ADVERSARIAL) {
    it(`GB14: ${name} does not reach the document`, function* () {
      const fixture = yield* useFixture();

      const output = text(
        yield* runWith(fixture, FIND_ALL, new InMemoryStream(), function* () {
          yield* API.Fs.around({
            // deno-lint-ignore require-yield
            *glob() {
              throw error();
            },
          });
        }),
      );

      expect(output).toContain("cannot search the working directory:");
      expect(output).not.toContain(PLANTED);
    });
  }

  // GB15: a symlink to a directory is not descended into, so nothing under its
  // destination is a result. This is what keeps traversal inside `Env.cwd`
  // without a containment check per entry, and what makes a cycle impossible.
  it("GB15: a directory symlink is not traversed", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md"]);
    yield* writeTextFile(join(fixture.outside, "secret.md"), "secret");
    yield* until(symlink(fixture.outside, join(fixture.workspace, "escape")));

    const output = text(yield* run(fixture, FIND_ALL));

    expect(output).toContain(found("a.md"));
    expect(output).not.toContain("secret.md");
    expect(output).not.toContain("escape/");
  });

  // GB15b: a link back into the workspace is refused on the same terms. The
  // rule is about symlinks, not about where they point, so `<Glob>` never has
  // to judge a destination.
  it("GB15b: a directory symlink inside the workspace is not traversed either", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["real/a.md"]);
    yield* until(symlink(join(fixture.workspace, "real"), join(fixture.workspace, "alias")));

    const output = text(yield* run(fixture, FIND_ALL));

    expect(output).toContain(found("real/a.md"));
    expect(output).not.toContain("alias/");
  });

  // GB15c: the cycle that rule prevents. A link to its own parent would be an
  // unbounded walk if it were followed; the search finishes.
  it("GB15c: a symlink cycle does not hang the search", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md"]);
    yield* until(symlink(fixture.workspace, join(fixture.workspace, "loop")));

    const output = text(
      yield* race([run(fixture, FIND_ALL), timeout("GB15c: the search did not finish")]),
    );

    expect(output).toContain(found("a.md"));
  });

  // GB16: a symlink is a link rather than a file, so it is not a result even
  // when its destination is an ordinary file inside the workspace.
  it("GB16: a symlink to a file is not a result", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md"]);
    yield* until(symlink(join(fixture.workspace, "a.md"), join(fixture.workspace, "link.md")));

    const output = text(yield* run(fixture, FIND_ALL));

    expect(output).toContain(found("a.md"));
    expect(output).not.toContain("link.md");
  });

  // GB16b: and one pointing out of the workspace is excluded for that same
  // reason, so the file it names is never even opened.
  it("GB16b: a symlink pointing outside the workspace is not a result", function* () {
    const fixture = yield* useFixture();
    const secret = join(fixture.outside, "secret.md");
    yield* writeTextFile(secret, "secret");
    yield* until(symlink(secret, join(fixture.workspace, "escape.md")));

    const output = text(yield* run(fixture, FIND_ALL));

    expect(output).toContain("found: ");
    expect(output).not.toContain("escape.md");
    expectNoAbsolutePaths(output, fixture);
  });

  // GB17: traversal is a sequence of directory reads, so every one of them is a
  // cancellation point. Suspending the second read halts the walk part-way: the
  // third directory is never read, and the run produces nothing at all — no
  // partial listing reaches the document.
  it("GB17: cancellation during traversal stops the search", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md", "one/b.md", "two/c.md"]);

    const read: string[] = [];
    const output = yield* race([
      runWith(fixture, FIND_ALL, new InMemoryStream(), function* () {
        yield* FsApi.around({
          *readdirDirents([path], next) {
            // The engine reads directories of its own; only the walk under the
            // workspace is being counted and interrupted.
            if (String(path).startsWith(fixture.workspace)) {
              read.push(String(path));
              if (read.length === 2) {
                yield* suspend();
              }
            }
            return yield* next(path);
          },
        });
      }),
      sleep(250),
    ]);

    expect(read).toHaveLength(2);
    expect(output).toBeUndefined();
  });

  // GB18: a journal with the root's close is a finished execution. Replaying it
  // restores that result without expanding anything, so `<Glob>` does not run
  // at all — proven by removing the files it found and getting the same output
  // anyway. This says nothing about the component; it is the root contract, and
  // it is what GB18b has to be distinguished from.
  it("GB18: a completed-root replay restores the result without searching", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md", "nested/b.md"]);

    const stream = new InMemoryStream();
    const live = yield* runWith(fixture, FIND_ALL, stream);
    const appended = stream.appendCount;

    // Nothing on disk for a second search to find.
    yield* rm(join(fixture.workspace, "a.md"));
    yield* rm(join(fixture.workspace, "nested"), { recursive: true });

    const replay = yield* runWith(fixture, undefined, stream);

    expect(text(live)).toContain(found("a.md", "nested/b.md"));
    expect(replay).toEqual(live);
    expect(stream.appendCount).toBe(appended);
  });

  // GB18b: a partial journal replays what it holds and continues live, so
  // expansion reaches `<Glob>`. It records no durable effect, so there is
  // nothing to restore and the search happens again — against whatever is on
  // disk now, which is how the repetition is observable.
  it("GB18b: a partial replay searches again", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["a.md"]);

    const stream = new InMemoryStream();
    const live = yield* runWith(fixture, FIND_ALL, stream);
    expect(text(live)).toContain(found("a.md"));

    yield* plant(fixture, ["b.md"]);

    const replay = yield* runWith(fixture, undefined, yield* partial(stream));

    // The search really ran again: a restored result would still say only a.md.
    expect(text(replay)).toContain(found("a.md", "b.md"));
  });

  // GB19: the same tree searched twice gives the same array in the same order.
  // Sorting is what makes that true — the order entries come back in belongs to
  // the filesystem, and a document that branches on a listing must not.
  it("GB19: repeated searches return the same order", function* () {
    const fixture = yield* useFixture();
    yield* plant(fixture, ["zebra.md", "one/middle.md", "Beta.md", "alpha.md"]);

    const first = text(yield* run(fixture, FIND_ALL));
    const second = text(yield* run(fixture, FIND_ALL));

    expect(first).toContain(found("Beta.md", "alpha.md", "one/middle.md", "zebra.md"));
    expect(second).toBe(first);
  });
});

/** Fail rather than hang, so a runaway traversal is a test failure. */
function* timeout(message: string): Operation<never> {
  yield* sleep(5000);
  throw new Error(message);
}
