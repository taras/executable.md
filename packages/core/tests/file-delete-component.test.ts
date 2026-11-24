/**
 * Tier FD — `<File.Delete>` (spec §6.13.1).
 *
 * The component ships in core, so these drive the real definition through
 * `execute()` against the real host provider. Each test installs a directory as
 * the contextual `Env.cwd` and then works only in relative paths, which is the
 * position a document inside a `<TempDir>` is in — without needing the directory
 * to be temporary, so a fixture can lay out symlinks first.
 *
 * What this tier owns is the component's own surface: the shape that decides
 * its one form, the empty rendering and what `as` therefore captures, which
 * directory a relative path is read against, and the sentences a refusal is
 * reported in. The structural failure data behind those sentences belongs to
 * Tier HF, and what an absent or misbehaving provider does belongs to Tier FF.
 *
 * `mkdtemp`, `realpath`, `symlink` and `readdir` have no `@effectionx/fs`
 * equivalent; everything else goes through it. Removing a fixture unlinks its
 * symlinks rather than following them.
 */

import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import {
  captureTestJournal,
  journalBeforeEach,
  useJournalStream,
} from "@executablemd/test-support/failure-journal";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API, Files, filesFailure, Permissions, useHostFiles } from "@executablemd/runtime";
import type { FilePathInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { Component, content } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { hasContent } from "../src/content-context.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";
import { mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * A workspace and a directory beside it that is deliberately out of reach.
 *
 * `outside` is a sibling rather than a parent, so a link escaping the workspace
 * lands somewhere a test can then prove was never touched.
 */
interface Fixture {
  root: string;
  workspace: string;
  outside: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "fd-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    yield* ensureDir(workspace);
    yield* ensureDir(outside);
    yield* provide({ root, workspace, outside });
  });
}

/** A directory symlink, spelled the way the running platform accepts one. */
const DIRECTORY_LINK = process.platform === "win32" ? "junction" : "dir";

/**
 * Install the workspace as the contextual working directory, and the host
 * document filesystem provider beneath it.
 *
 * `API.Files` has no host default, so a suite driving `execute()` directly
 * installs the provider the way an entrypoint does.
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
  yield* useHostFiles();
}

/**
 * Run `source` as a document whose contextual working directory is the
 * workspace.
 *
 * `install` runs inside the execution scope, after the provider and before
 * `execute()`, which is what lets a test wrap `API.Env` or `API.Files` and
 * count what the component actually reached for.
 */
function run(
  fixture: Fixture,
  source: string,
  install?: () => Operation<void>,
  suppliedStream?: InMemoryStream,
): Operation<string> {
  return scoped(function* () {
    const path = join(fixture.workspace, "doc.md");
    yield* writeTextFile(path, source);
    const stream = suppliedStream ?? (yield* useJournalStream(path));
    yield* useWorkspaceCwd(fixture);
    if (install) {
      yield* install();
    }
    const output: Json = yield* collect(
      yield* execute({ path, stream, includes: [fixture.workspace] }),
    );
    return String(output);
  });
}

/** Everything in a directory except the document each test writes there. */
function* entries(directory: string): Operation<string[]> {
  return (yield* until(readdir(directory))).filter((entry) => entry !== "doc.md").sort();
}

/**
 * A printed containment error may name the path the document wrote and nothing
 * else — not the resolved workspace, and not what a link pointed at (§1.2).
 */
function expectNoAbsolutePaths(output: string, fixture: Fixture): void {
  expect(output).not.toContain(fixture.workspace);
  expect(output).not.toContain(fixture.outside);
  expect(output).not.toContain(fixture.root);
}

/**
 * `<Nested>` — a component that installs a subdirectory as the contextual
 * working directory for its content, and nothing else.
 *
 * The boundary is a fixture rather than a shipped component because no core
 * component rebinds `Env.cwd` for authored content except `<TempDir>`, whose
 * directory a test cannot lay files out in beforehand.
 */
function useNested(directory: string): Operation<void> {
  return registerComponents([
    {
      name: "Nested",
      origin: "tier-fd",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* API.Env.around(
          {
            // deno-lint-ignore require-yield
            *cwd() {
              return directory;
            },
          },
          { at: "min" },
        );
        return yield* content();
      },
    },
  ]);
}

/**
 * A contextual `hasContent` handler outside every component invocation, plus a
 * component that reports what it answers.
 *
 * The script is consumed one entry per call and the last entry repeats, so
 * `[true, false]` is the exact toggle that defeats a caller which checks and
 * then invokes. `<Says />` is what makes the handler *demonstrably* live and
 * demonstrably lying: without it, a passing test would only mean nobody asked.
 */
function* useLyingContent(script: readonly boolean[], answered: boolean[]): Operation<void> {
  let call = 0;
  yield* registerComponents([
    {
      name: "Says",
      origin: "tier-fd",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<string> {
        return String(yield* hasContent());
      },
    },
  ]);
  yield* Component.around({
    // deno-lint-ignore require-yield
    *hasContent(_args, _next) {
      const answer = script[Math.min(call, script.length - 1)] ?? false;
      call += 1;
      answered.push(answer);
      return answer;
    },
  });
}

const OWNER = "packages/core/tests/file-delete-component.test.ts";

describe("Tier FD — File.Delete", () => {
  beforeEach(journalBeforeEach(OWNER));
  // FD1: the ordinary case, and the whole of what a success looks like from the
  // document: the file is gone, and nothing is rendered or bound in its place.
  it("FD1: removes one regular file, rendering nothing and binding the empty string", function* () {
    const fixture = yield* useFixture();
    const stream = yield* useJournalStream(join(fixture.workspace, "doc.md"));
    yield* writeTextFile(join(fixture.workspace, "obsolete.md"), "stale");
    yield* writeTextFile(join(fixture.workspace, "kept.md"), "kept");

    const output = yield* run(
      fixture,
      [
        '<File.Delete path="obsolete.md" />',
        "",
        '<File.Delete path="kept.md" as="gone" />',
        "",
        "[{gone}]",
      ].join("\n"),
      undefined,
      stream,
    );

    // `as` captures the empty string the component returns, exactly as it does
    // for any component that returns text — nothing is invented for it to hold.
    expect(output).toContain("[]");
    expect(output).not.toContain("obsolete.md");
    expect(yield* entries(fixture.workspace)).toEqual([]);
  });

  // FD2: absence is the answer the document asked for, not a condition. Two
  // deletions of the same path both succeed, so a document may remove a file it
  // is not sure it created.
  it("FD2: deleting a path that names nothing succeeds, twice", function* () {
    const fixture = yield* useFixture();
    const stream = yield* useJournalStream(join(fixture.workspace, "doc.md"));
    const output = yield* run(
      fixture,
      ['<File.Delete path="absent.md" />', "", '<File.Delete path="absent.md" />', "", "done"].join(
        "\n",
      ),
      undefined,
      stream,
    );

    expect(output).toContain("done");
    expect(output).not.toContain("cannot delete");
    expect(output).not.toContain("no such file");
    expect(yield* entries(fixture.workspace)).toEqual([]);
  });

  // FD3: the shape of the invocation decides its one form, and paired-*empty*
  // is the case that says so — there is no rendered content to blame, so a
  // component that branched on rendered length would accept it.
  const pairedDelete = "FD3: paired content is refused before Env.cwd or the provider is reached";
  it(pairedDelete, function* () {
    const fixture = yield* useFixture();
    const stream = yield* useJournalStream(join(fixture.workspace, "doc.md"));
    yield* writeTextFile(join(fixture.workspace, "kept.md"), "kept");
    const reached: string[] = [];

    function* watch(): Operation<void> {
      yield* API.Env.around({
        *cwd(_args, next) {
          reached.push("cwd");
          return yield* next();
        },
      });
      yield* Files.around({
        *deleteFile([input], next) {
          reached.push("deleteFile");
          return yield* next(input);
        },
      });
    }

    const output = yield* run(fixture, '<File.Delete path="kept.md"></File.Delete>', watch, stream);

    expect(output).toContain("<File.Delete> is self-closing");
    expect(reached).toEqual([]);
    expect(yield* readTextFile(join(fixture.workspace, "kept.md"))).toBe("kept");

    // The same watchers, on the form that is accepted. Without this the empty
    // list above would also be what a spy that never fired reports.
    yield* captureTestJournal(
      { owner: OWNER, name: pairedDelete },
      join(fixture.workspace, "doc.md"),
      function* (secondStream) {
        yield* run(fixture, '<File.Delete path="kept.md" />', watch, secondStream);
        expect(reached).toEqual(["cwd", "deleteFile"]);
        expect(yield* exists(join(fixture.workspace, "kept.md"))).toBe(false);
      },
    );
  });

  // FD4: a relative path means what the contextual directory says it means, and
  // the sibling after a nested region means what the *restored* one says. One
  // document proves both: the inner file goes, the outer file of the same name
  // stays, and the element after the region reaches the outer directory.
  it("FD4: Env.cwd selects the target, and lexical restoration is whole", function* () {
    const fixture = yield* useFixture();
    const stream = yield* useJournalStream(join(fixture.workspace, "doc.md"));
    const nested = join(fixture.workspace, "nested");
    yield* ensureDir(nested);
    yield* writeTextFile(join(nested, "target.md"), "inner");
    yield* writeTextFile(join(fixture.workspace, "target.md"), "outer");
    yield* writeTextFile(join(fixture.workspace, "keep.md"), "sibling");

    yield* run(
      fixture,
      [
        "<Nested>",
        '<File.Delete path="target.md" />',
        "</Nested>",
        "",
        '<File.Delete path="keep.md" />',
      ].join("\n"),
      () => useNested(nested),
      stream,
    );

    expect(yield* exists(join(nested, "target.md"))).toBe(false);
    // The outer file of the same name is untouched, which is what says the
    // inner directory selected the target rather than the outer one.
    expect(yield* readTextFile(join(fixture.workspace, "target.md"))).toBe("outer");
    // And the element after the region resolved against the outer directory.
    expect(yield* exists(join(fixture.workspace, "keep.md"))).toBe(false);
  });

  // FD3b: the form is read from the invocation the engine issued, so a
  // contextual handler answering "self-closing" for a paired element cannot
  // turn a document that wrote children into one that deleted the path beside
  // them. Both paired spellings are covered, because paired-*empty* is the one
  // with no rendered content to blame.
  //
  // Every case proves both halves. `<Says />` renders whatever the chain
  // reports, so the handler is live and lying; the files and the provider calls
  // show `<File.Delete>` did the authored thing anyway. The self-closing
  // control in the same document shows the handler does not block a genuine
  // deletion either.
  const DENYING: Array<[string, readonly boolean[]]> = [
    ["a handler that always denies content", [false]],
    ["a handler that answers true then false", [true, false]],
  ];

  for (const [what, script] of DENYING) {
    it(`FD3b: a paired File.Delete removes nothing under ${what}`, function* () {
      const fixture = yield* useFixture();
      const stream = yield* useJournalStream(join(fixture.workspace, "doc.md"));
      yield* writeTextFile(join(fixture.workspace, "kept.md"), "kept");
      yield* writeTextFile(join(fixture.workspace, "kept-empty.md"), "also kept");
      yield* writeTextFile(join(fixture.workspace, "gone.md"), "removed");
      const reached: string[] = [];
      const answered: boolean[] = [];

      const output = yield* run(
        fixture,
        [
          "<Says />",
          "",
          '<File.Delete path="kept.md">paired</File.Delete>',
          "",
          '<File.Delete path="kept-empty.md"></File.Delete>',
          "",
          '<File.Delete path="gone.md" />',
          "",
          "<Says />",
        ].join("\n"),
        function* () {
          yield* useLyingContent(script, answered);
          yield* API.Env.around({
            *cwd(_args, next) {
              reached.push("cwd");
              return yield* next();
            },
          });
          yield* Files.around({
            *deleteFile([input], next) {
              reached.push(`delete:${input.path}`);
              return yield* next(input);
            },
          });
        },
        stream,
      );

      // The handler is live, and the lie is visible on a component that does
      // read the chain.
      expect(answered.length).toBeGreaterThanOrEqual(2);
      expect(output).toContain("false");

      // Both paired spellings refused, and both targets are byte-for-byte what
      // they were.
      expect(output).toContain("<File.Delete> is self-closing");
      expect(yield* readTextFile(join(fixture.workspace, "kept.md"))).toBe("kept");
      expect(yield* readTextFile(join(fixture.workspace, "kept-empty.md"))).toBe("also kept");

      // Neither of them reached the working directory or the provider: the only
      // calls belong to the genuinely self-closing control, which still deleted.
      expect(reached).toEqual(["cwd", "delete:gone.md"]);
      expect(yield* exists(join(fixture.workspace, "gone.md"))).toBe(false);
    });
  }

  // FD3c: there is no fallback to guess with. A call arriving without a genuine
  // invocation is not one the engine made, and guessing "self-closing" there
  // would be guessing *delete* — so it refuses before `cwd()` and therefore
  // before any provider.
  it("FD3c: a look-alike invocation removes nothing and reaches no provider", function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.workspace, "kept.md"), "kept");
    const reached: string[] = [];

    // Not an absence — a forgery. The whole public shape is here: a method of
    // the right name, taking nothing, returning a boolean. Every check written
    // against the shape passes, which is why the component authenticates the
    // object instead. `false` is the dangerous answer for a paired element, and
    // it is the one this reports.
    const mismatched: ComponentInvocation = {
      hasContent() {
        return false;
      },
    };

    let failure: string | undefined;
    try {
      yield* run(fixture, '<File.Delete path="kept.md" />', function* () {
        yield* API.Env.around({
          *cwd(_args, next) {
            reached.push("cwd");
            return yield* next();
          },
        });
        yield* Files.around({
          *deleteFile([input], next) {
            reached.push(`delete:${input.path}`);
            return yield* next(input);
          },
        });
        yield* Component.around({
          *importComponent([name, position], next) {
            const definition = yield* next(name, position);
            if (name !== "File.Delete" || definition.kind !== "function") {
              return definition;
            }
            const original = definition.fn;
            if (typeof original !== "function") {
              return definition;
            }
            return {
              ...definition,
              *fn(props: Record<string, Json>) {
                return yield* original(props, mismatched);
              },
            };
          },
        });
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    // It stops one layer earlier than it used to. The wrapper returns a
    // definition canonical execution did not issue, and this is a name
    // canonical core owns, so verification refuses the answer before anything
    // is invoked with the forged invocation at all. The dispatcher's own
    // refusal is still there underneath — `fixed-filesystem-components.test.ts`
    // reaches it directly, without an import to intercept.
    expect(failure).toContain("canonical execution did not produce");
    expect(reached).toEqual([]);
    expect(yield* readTextFile(join(fixture.workspace, "kept.md"))).toBe("kept");
  });

  // FD5: every refusal the component has its own sentence for, and the one rule
  // they share — a printed error names the path the document wrote and nothing
  // the filesystem knows. The provider is the real host one, so what is under
  // test is the whole path from an authored string to a printed sentence.
  const pathRefusals = "FD5: each refusal names the authored path and no absolute one";
  it(pathRefusals, function* () {
    const fixture = yield* useFixture();
    yield* writeTextFile(join(fixture.outside, "secret.txt"), "SECRET");
    yield* ensureDir(join(fixture.workspace, "held"));
    yield* writeTextFile(join(fixture.workspace, "held", "inner.txt"), "kept");
    yield* until(symlink(fixture.outside, join(fixture.workspace, "escape"), DIRECTORY_LINK));

    const cases: Array<{ path: string; says: string }> = [
      { path: join(fixture.outside, "secret.txt"), says: "an absolute path is not accepted" },
      { path: "../outside/secret.txt", says: "resolves outside the working directory" },
      { path: "escape/secret.txt", says: "leads through a symlink outside the working directory" },
      { path: "held", says: 'cannot delete "held": it is a directory, not a file.' },
    ];

    for (const refused of cases) {
      const removed: string[] = [];
      const output = yield* run(fixture, `<File.Delete path="${refused.path}" />`, function* () {
        yield* API.Fs.around({
          *remove([path, options], next) {
            removed.push(path);
            return yield* next(path, options);
          },
        });
      });

      expect(output).toContain(refused.says);
      expectNoAbsolutePaths(output, fixture);
      // Nothing was attempted: each of these is decided before the removal.
      expect(removed).toEqual([]);
    }

    // And none of them touched what they named.
    expect(yield* readTextFile(join(fixture.outside, "secret.txt"))).toBe("SECRET");
    expect(yield* readTextFile(join(fixture.workspace, "held", "inner.txt"))).toBe("kept");

    // The same spy on a deletion that is admitted, so the empty lists above are
    // a removal that did not happen rather than a spy that never fired.
    const removed: string[] = [];
    yield* writeTextFile(join(fixture.workspace, "ordinary.txt"), "gone soon");
    yield* captureTestJournal(
      { owner: OWNER, name: pathRefusals },
      join(fixture.workspace, "doc.md"),
      function* (stream) {
        yield* run(
          fixture,
          '<File.Delete path="ordinary.txt" />',
          function* () {
            yield* API.Fs.around({
              *remove([path, options], next) {
                removed.push(path);
                return yield* next(path, options);
              },
            });
          },
          stream,
        );
        expect(removed).toEqual([join(fixture.workspace, "ordinary.txt")]);
      },
    );
  });

  // FD6: an ordinary structural refusal from a provider is this component's own
  // printed error rather than a failure of the run, and the sibling after it
  // still runs. The document reads a sentence from the fixed vocabulary and
  // nothing the provider chose.
  it("FD6: a structural provider refusal is printed, and changes nothing", function* () {
    const fixture = yield* useFixture();
    const stream = yield* useJournalStream(join(fixture.workspace, "doc.md"));
    yield* writeTextFile(join(fixture.workspace, "kept.md"), "kept");

    const output = yield* run(
      fixture,
      ['<File.Delete path="kept.md" />', "", "after"].join("\n"),
      function* () {
        yield* Files.around({
          // deno-lint-ignore require-yield
          *deleteFile(_args: [FilePathInput]): Operation<Result<void>> {
            return Err(
              filesFailure({ operation: "delete", phase: "access", reason: "permission-denied" }),
            );
          },
        });
      },
      stream,
    );

    expect(output).toContain('cannot delete "kept.md": permission denied.');
    expect(output).toContain("after");
    expect(yield* readTextFile(join(fixture.workspace, "kept.md"))).toBe("kept");
  });
});

function patchDocument(path: string, diff: string): string {
  return [
    "<File.Patch path=" + JSON.stringify(path) + ">",
    ...diff.split("\n").map((line) => "  " + line),
    "</File.Patch>",
  ].join("\n");
}

function printPatchRefusal(patch: string): string {
  return ["<PrintErrors>", ...patch.split("\n").map((line) => "  " + line), "</PrintErrors>"].join(
    "\n",
  );
}

const SMALL_PATCH = [
  "```diff",
  "--- a/target.txt",
  "+++ b/target.txt",
  "@@ -2 +2 @@",
  "-old",
  "+new",
  "```",
].join("\n");

describe("File.Patch", () => {
  beforeEach(journalBeforeEach("core:file-patch"));

  it("edits one hunk and preserves the surrounding bytes", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.workspace, "target.txt");
    const suffix = "unchanged café\r\n".repeat(200) + "last";
    const context = "\uFEFFfirst\n    indented  \r\n\r\n";
    yield* writeTextFile(target, context + "old\r\n" + suffix);
    const diff = SMALL_PATCH.replace("@@ -2 +2 @@", "@@ -2,3 +2,3 @@\n     indented  \n ");
    const output = yield* run(fixture, patchDocument("target.txt", diff));
    expect(output.trim()).toBe("");
    expect(new Uint8Array(yield* until(readFile(target)))).toEqual(
      new TextEncoder().encode(context + "new\r\n" + suffix),
    );
  });

  it("applies formatted top-level and nested patches from CRLF source", function* () {
    const fixture = yield* useFixture();
    const top = join(fixture.workspace, "notes.md");
    const reports = join(fixture.workspace, "reports");
    const nested = join(reports, "notes.md");
    yield* ensureDir(reports);
    yield* writeTextFile(top, "Draft\n");
    const context = "    indented  \n\r\n";
    yield* writeTextFile(nested, context + "Draft\r\nlast");
    const source = [
      '<File.Patch path="notes.md">',
      "  ```diff",
      "  --- a/notes.md",
      "  +++ b/notes.md",
      "  @@ -1 +1 @@",
      "  -Draft",
      "  +Ready",
      "  ```",
      "</File.Patch>",
      '<Dir path="reports">',
      '  <File.Patch path="notes.md">',
      "    ```diff",
      "    @@ -1,3 +1,3 @@",
      "         indented  ",
      "     ",
      "    -Draft",
      "    +Ready",
      "    ```",
      "  </File.Patch>",
      "</Dir>",
      "",
    ].join("\r\n");
    expect(yield* run(fixture, source)).toBe("");
    const encoder = new TextEncoder();
    expect(new Uint8Array(yield* until(readFile(top)))).toEqual(encoder.encode("Ready\n"));
    expect(new Uint8Array(yield* until(readFile(nested)))).toEqual(
      encoder.encode(context + "Ready\r\nlast"),
    );
  });

  it("reports the malformed nested fence position in CRLF source before file effects", function* () {
    const fixture = yield* useFixture();
    const reports = join(fixture.workspace, "reports");
    const target = join(reports, "notes.md");
    yield* ensureDir(reports);
    yield* writeTextFile(target, "Draft\n");
    const source = [
      "Préface 😀",
      '<Dir path="reports">',
      '  <File.Patch path="notes.md">',
      "    ```diff",
      "    @@ -1 +1 @@",
      "    -Draft",
      "    +Ready",
      "  ```",
      "  </File.Patch>",
      "</Dir>",
    ].join("\r\n");
    let diagnostic = "";
    try {
      yield* run(fixture, source, function* () {
        yield* API.Files.around({
          *checkFilePath() {
            throw new Error("document reached the file provider");
          },
          *ensureDirectory() {
            throw new Error("document reached the file provider");
          },
          *readTextFile() {
            throw new Error("document reached the file provider");
          },
        });
      });
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).toContain("at 8:3. Indent the closing diff fence with exactly 4 spaces.");
    expect(new Uint8Array(yield* until(readFile(target)))).toEqual(
      new TextEncoder().encode("Draft\n"),
    );
  });

  it("diagnoses omitted fence prefixes at the marker before accessing the target", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.workspace, "target.txt");
    const before = new TextEncoder().encode("first\n    indented\n\nold\n");
    yield* until(writeFile(target, before));
    const flat =
      '<File.Patch path="target.txt">\n' +
      ["```diff", "@@ -2,3 +2,3 @@", "     indented", " ", "-old", "+new", "```"].join("\n") +
      "\n</File.Patch>";
    const missingClosePrefix = patchDocument("target.txt", SMALL_PATCH).replace(
      "\n  ```\n",
      "\n```\n",
    );
    for (const [source, location, marker] of [
      [flat, "2:1", "opening"],
      [missingClosePrefix, "8:1", "closing"],
    ]) {
      let diagnostic = "";
      try {
        yield* run(fixture, source, function* () {
          yield* API.Files.around({
            *readTextFile() {
              throw new Error("patch reached the file provider");
            },
          });
        });
      } catch (error) {
        diagnostic = String(error);
      }
      expect(diagnostic).toContain(
        `at ${location}. Indent the ${marker} diff fence with exactly 2 spaces.`,
      );
      expect(new Uint8Array(yield* until(readFile(target)))).toEqual(before);
    }
  });

  it("stops later effects on refusal unless PrintErrors encloses the patch", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.workspace, "target.txt");
    const later = join(fixture.workspace, "later.txt");
    const before = new TextEncoder().encode("first\nchanged\r\nlast");
    yield* until(writeFile(target, before));
    const patch = patchDocument("target.txt", SMALL_PATCH);
    const following = '\n<File path="later.txt">continued</File>';
    let refusal = "";
    try {
      yield* run(fixture, patch + following);
    } catch (error) {
      refusal = String(error);
    }
    expect(refusal).toContain("the diff no longer matches");
    expect(yield* exists(later)).toBe(false);
    expect(new Uint8Array(yield* until(readFile(target)))).toEqual(before);

    const output = yield* run(fixture, printPatchRefusal(patch + following));
    expect(output).toContain("the diff no longer matches");
    expect(yield* readTextFile(later)).toBe("continued");
    expect(new Uint8Array(yield* until(readFile(target)))).toEqual(before);
  });

  it("refuses the entire edit for stale, malformed or wrong-target diffs", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.workspace, "target.txt");
    const other = join(fixture.workspace, "other.txt");
    const before = new TextEncoder().encode("first\nold\r\nlast");
    yield* until(writeFile(target, before));
    yield* until(writeFile(other, before));
    const stale = SMALL_PATCH.replace("\n```", "\n@@ -3 +3 @@\n-missing\n+fresh\n```");
    for (const [diff, message] of [
      [stale, "the diff no longer matches"],
      [SMALL_PATCH.replace("-2 +2", "-2,2 +2"), "exact, single-file unified diff"],
      [SMALL_PATCH.replaceAll("target.txt", "other.txt"), "exact, single-file unified diff"],
    ]) {
      expect(yield* run(fixture, printPatchRefusal(patchDocument("target.txt", diff)))).toContain(
        message,
      );
      expect(new Uint8Array(yield* until(readFile(target)))).toEqual(before);
      expect(new Uint8Array(yield* until(readFile(other)))).toEqual(before);
    }
  });

  it("establishes the complete indented patch boundary before any wrapper or sibling runs", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.workspace, "target.txt");
    const other = join(fixture.workspace, "other.txt");
    const probe = "<Probe />";
    const encoder = new TextEncoder();
    const before = encoder.encode(
      "```\r\n</File.Patch>\r\n" + probe + "  \r\n    indented  \r\n\r\nold\r\nlast",
    );
    const unrelated = encoder.encode("unchanged\r\n");
    yield* until(writeFile(target, before));
    yield* until(writeFile(other, unrelated));
    const events: string[] = [];
    const install = () =>
      registerComponents([
        {
          name: "Wrap",
          origin: "patch-boundary",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            events.push("wrapper");
            return yield* content();
          },
        },
        {
          name: "Probe",
          origin: "patch-boundary",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            events.push("row");
            yield* writeTextFile(other, "probe executed");
            return "probe executed";
          },
        },
      ]);
    const wrap = (rows: string[]) =>
      [
        "before patch",
        "<Wrap>",
        '  <File.Patch path="target.txt">',
        ...rows,
        "  wrapper content",
        "</Wrap>",
        "after patch",
      ].join("\n");

    for (const rows of [
      [
        "    ```diff",
        "    @@ -1,3 +1,3 @@",
        "     ```",
        "     </File.Patch>",
        "    +" + probe,
        "  </File.Patch>",
      ],
      ["    ```diff", "    +" + probe, "  </File.Patch>"],
      ["    ```diff", "    +" + probe],
      ["    ```diff", "    @@ -2 +2 @@", "    -old", "    +new", "    ```", "  " + probe],
      ["    > ```diff", "    > +" + probe, "  </File.Patch>", "  +" + probe],
      ["    ```diff", "    ```", "    ```diff", "    ```", "  </File.Patch>"],
      ["    " + probe, "  </File.Patch>"],
    ]) {
      let message = "";
      try {
        yield* run(fixture, wrap(rows), install);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("File.Patch requires exactly one passive fenced unified diff");
      expect(events).toEqual([]);
      expect(new Uint8Array(yield* until(readFile(target)))).toEqual(before);
      expect(new Uint8Array(yield* until(readFile(other)))).toEqual(unrelated);
    }

    const valid = yield* run(
      fixture,
      wrap([
        "    ````diff",
        "    @@ -1,6 +1,6 @@",
        "     ```",
        "     </File.Patch>",
        "     " + probe + "  ",
        "         indented  ",
        "     ",
        "    -old",
        "    +new",
        "    ````",
        "  </File.Patch>",
      ]),
      install,
    );
    expect(events).toEqual(["wrapper"]);
    expect(valid.trim()).toBe("before patch\nwrapper content\nafter patch");
    expect(new Uint8Array(yield* until(readFile(target)))).toEqual(
      encoder.encode(
        "```\r\n</File.Patch>\r\n" + probe + "  \r\n    indented  \r\n\r\nnew\r\nlast",
      ),
    );
    expect(new Uint8Array(yield* until(readFile(other)))).toEqual(unrelated);
  });

  it("refuses lossy UTF-8 replacement and honors an explicit final-newline marker", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.workspace, "target.txt");
    const invalid = new Uint8Array([0xff, ...new TextEncoder().encode("\nold\n")]);
    yield* until(writeFile(target, invalid));
    expect(
      yield* run(fixture, printPatchRefusal(patchDocument("target.txt", SMALL_PATCH))),
    ).toContain("existing bytes no longer match");
    expect(new Uint8Array(yield* until(readFile(target)))).toEqual(invalid);

    yield* writeTextFile(target, "first\r\nold");
    const marker = "\n\\ No newline at end of file";
    const patch = SMALL_PATCH.replace("-old\n+new", "-old" + marker + "\n+new" + marker);
    expect((yield* run(fixture, patchDocument("target.txt", patch))).trim()).toBe("");
    expect(yield* readTextFile(target)).toBe("first\r\nnew");
  });

  it("honors File containment and write permission", function* () {
    const fixture = yield* useFixture();
    const target = join(fixture.workspace, "target.txt");
    const other = join(fixture.outside, "other.txt");
    const before = "first\nold\nlast";
    yield* writeTextFile(target, before);
    yield* writeTextFile(other, before);
    const outside = "../outside/other.txt";
    const outsidePatch = SMALL_PATCH.replaceAll("target.txt", outside);
    expect(yield* run(fixture, printPatchRefusal(patchDocument(outside, outsidePatch)))).toContain(
      "outside",
    );
    expect(
      yield* run(
        fixture,
        printPatchRefusal(patchDocument("target.txt", SMALL_PATCH)),
        function* () {
          yield* Permissions.around({
            files: ([operation], next) => (operation === "write" ? false : next(operation)),
          });
        },
      ),
    ).toContain("permission denied");
    expect(yield* readTextFile(target)).toBe(before);
    expect(yield* readTextFile(other)).toBe(before);
  });

  it("describes its paired form through Syntax", function* () {
    const fixture = yield* useFixture();
    const output = yield* run(fixture, '<Syntax names={["File.Patch"]} />');
    expect(output).toContain('<File.Patch path="notes.md">');
    expect(output).toContain("Exactly one passive fenced unified diff");
    expect(output).toContain("Apply a unified diff to a file.");
    expect(output).toContain("A refusal throws by default.");
  });
});
