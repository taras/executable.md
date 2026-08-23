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

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API, Files, filesFailure, useHostFiles } from "@executablemd/runtime";
import type { FilePathInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { Component, content } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { hasContent } from "../src/content-context.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";
import { mkdtemp, readdir, realpath, symlink } from "node:fs/promises";
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
function run(fixture: Fixture, source: string, install?: () => Operation<void>): Operation<string> {
  return scoped(function* () {
    const path = join(fixture.workspace, "doc.md");
    yield* writeTextFile(path, source);
    yield* useWorkspaceCwd(fixture);
    if (install) {
      yield* install();
    }
    const output: Json = yield* collect(
      yield* execute({ path, stream: new InMemoryStream(), componentDirs: [fixture.workspace] }),
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

describe("Tier FD — File.Delete", () => {
  // FD1: the ordinary case, and the whole of what a success looks like from the
  // document: the file is gone, and nothing is rendered or bound in its place.
  it("FD1: removes one regular file, rendering nothing and binding the empty string", function* () {
    const fixture = yield* useFixture();
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

    const output = yield* run(
      fixture,
      ['<File.Delete path="absent.md" />', "", '<File.Delete path="absent.md" />', "", "done"].join(
        "\n",
      ),
    );

    expect(output).toContain("done");
    expect(output).not.toContain("cannot delete");
    expect(output).not.toContain("no such file");
    expect(yield* entries(fixture.workspace)).toEqual([]);
  });

  // FD3: the shape of the invocation decides its one form, and paired-*empty*
  // is the case that says so — there is no rendered content to blame, so a
  // component that branched on rendered length would accept it.
  it("FD3: paired content is refused before Env.cwd or the provider is reached", function* () {
    const fixture = yield* useFixture();
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

    const output = yield* run(fixture, '<File.Delete path="kept.md"></File.Delete>', watch);

    expect(output).toContain("<File.Delete> is self-closing");
    expect(reached).toEqual([]);
    expect(yield* readTextFile(join(fixture.workspace, "kept.md"))).toBe("kept");

    // The same watchers, on the form that is accepted. Without this the empty
    // list above would also be what a spy that never fired reports.
    yield* run(fixture, '<File.Delete path="kept.md" />', watch);
    expect(reached).toEqual(["cwd", "deleteFile"]);
    expect(yield* exists(join(fixture.workspace, "kept.md"))).toBe(false);
  });

  // FD4: a relative path means what the contextual directory says it means, and
  // the sibling after a nested region means what the *restored* one says. One
  // document proves both: the inner file goes, the outer file of the same name
  // stays, and the element after the region reaches the outer directory.
  it("FD4: Env.cwd selects the target, and lexical restoration is whole", function* () {
    const fixture = yield* useFixture();
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

    // Fatal rather than printed, because the wrapper's own function is not the
    // one core declared a printing boundary on — which is beside the point
    // here. What matters is where it stopped.
    expect(failure).toContain("without the invocation the engine issued");
    expect(reached).toEqual([]);
    expect(yield* readTextFile(join(fixture.workspace, "kept.md"))).toBe("kept");
  });

  // FD5: every refusal the component has its own sentence for, and the one rule
  // they share — a printed error names the path the document wrote and nothing
  // the filesystem knows. The provider is the real host one, so what is under
  // test is the whole path from an authored string to a printed sentence.
  it("FD5: each refusal names the authored path and no absolute one", function* () {
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
    yield* run(fixture, '<File.Delete path="ordinary.txt" />', function* () {
      yield* API.Fs.around({
        *remove([path, options], next) {
          removed.push(path);
          return yield* next(path, options);
        },
      });
    });
    expect(removed).toEqual([join(fixture.workspace, "ordinary.txt")]);
  });

  // FD6: an ordinary structural refusal from a provider is this component's own
  // printed error rather than a failure of the run, and the sibling after it
  // still runs. The document reads a sentence from the fixed vocabulary and
  // nothing the provider chose.
  it("FD6: a structural provider refusal is printed, and changes nothing", function* () {
    const fixture = yield* useFixture();
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
    );

    expect(output).toContain('cannot delete "kept.md": permission denied.');
    expect(output).toContain("after");
    expect(yield* readTextFile(join(fixture.workspace, "kept.md"))).toBe("kept");
  });
});
