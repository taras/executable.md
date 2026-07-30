/**
 * Tier TD — `<TempDir>` (spec §6.11).
 *
 * The component ships in core, so these drive the real definition through
 * `execute()` with the real modifier registry: what they assert is what a
 * document gets, including the working directory its subprocesses run in.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation } from "effection";
import { cwd, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream, StaleInputError } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { useTemporaryDirectory } from "../src/components/TempDir.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * A directory for one test's document and whatever its blocks write, removed
 * when the test scope closes.
 *
 * `mkdtemp` and `realpath` have no `@effectionx/fs` equivalent, so they come
 * from Node; everything else goes through it. Canonical, because a block that
 * writes here reports the path its own shell resolved.
 */
function useFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "td-test-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(yield* until(realpath(dir)));
  });
}

function writeDocument(dir: string, source: string): Operation<void> {
  return writeTextFile(join(dir, "doc.md"), source);
}

/** One bounded run, so the document scope closes before effects are read. */
function run(dir: string): Operation<Json> {
  return scoped(function* () {
    return yield* collect(
      yield* execute({
        path: join(dir, "doc.md"),
        stream: new InMemoryStream(),
        componentDirs: [dir],
      }),
    );
  });
}

/** Every temporary directory named in the output, in order. */
function directories(output: Json): string[] {
  return [...String(output).matchAll(/\S*xmd-tempdir-\S+/g)].map((match) => match[0]);
}

/** The component names the journal recorded an import for, in order. */
function* imported(stream: InMemoryStream): Operation<string[]> {
  const events = yield* stream.readAll();
  const names: string[] = [];
  for (const event of events) {
    if (event.type === "yield" && event.description.type === "import_component") {
      names.push(String(event.description.name));
    }
  }
  return names;
}

/**
 * Every temporary directory currently on disk. The leak this guards against is
 * a directory nobody holds a reference to, so the only way to see one is to
 * look at the root they are all created under.
 */
function* temporaries(): Operation<string[]> {
  const root = yield* until(realpath(tmpdir()));
  const entries = yield* until(readdir(root));
  return entries.filter((entry) => entry.startsWith("xmd-tempdir-")).sort();
}

/** The lines a block wrote to the fixture before it failed or was killed. */
function* recorded(dir: string, name: string): Operation<string[]> {
  return (yield* readTextFile(join(dir, name))).trim().split("\n");
}

const PWD = "```sh exec\npwd\n```";

describe("Tier TD — TempDir", () => {
  beforeAll(() => useTempFileCompiler());

  // TD1: the component is core's, not the document's — the fixture directory
  // holds no TempDir file, and it still resolves. Selection is an observation of
  // the environment, so it is journaled like any other import; what the entry
  // records is the registration's origin, never the function.
  it("TD1: resolves with no component file, and journals the selection", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(dir, "<TempDir>inside</TempDir>");

    const stream = new InMemoryStream();
    const output = yield* scoped(function* () {
      return yield* collect(
        yield* execute({ path: join(dir, "doc.md"), stream, componentDirs: [dir] }),
      );
    });

    expect(String(output)).toContain("inside");
    expect(yield* imported(stream)).toEqual(["__root__", "TempDir"]);
  });

  // TD2: the whole process contract, asserted from inside the subprocess.
  // `pwd` and `$PWD` are the shell's own answers, not the engine's, and the
  // directory has to be there while the command runs and gone afterwards.
  it("TD2: a process runs in the temporary directory, which exists only then", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(
      dir,
      [
        "<TempDir>",
        "```bash exec",
        "pwd",
        'echo "$PWD"',
        'test -d "$PWD" && echo LIVE',
        "```",
        "</TempDir>",
      ].join("\n"),
    );

    const output = String(yield* run(dir));
    const [fromPwd, fromEnv] = directories(output);

    // The identity of this invocation's directory, from the process itself.
    expect(fromPwd).toContain("xmd-tempdir-");
    // `pwd` and the shell's own `$PWD` agree: it is the real working
    // directory, not something the block was told.
    expect(fromEnv).toBe(fromPwd);
    // It existed while the command ran...
    expect(output).toContain("LIVE");
    // ...and the canonical path is gone once the component finished. Both
    // sides are canonical, so a /var vs /private/var alias cannot make this
    // pass by naming a different directory.
    expect(fromPwd.startsWith("/")).toBe(true);
    expect(yield* exists(fromPwd)).toBe(false);
  });

  // TD3: the previous working directory is what the next block sees.
  it("TD3: the working directory is restored afterwards", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(dir, `<TempDir>\n${PWD}\n</TempDir>\n\n${PWD}`);

    const lines = String(yield* run(dir))
      .split("\n")
      .filter((line) => line.trim().length > 0);

    expect(lines[lines.length - 1].trim()).toBe(yield* until(realpath(yield* cwd())));
  });

  // TD4: nesting and siblings are separate directories, and the inner one
  // does not survive its own element.
  it("TD4: nested and sibling instances are isolated", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(
      dir,
      [
        "<TempDir>",
        PWD,
        "<TempDir>",
        PWD,
        "</TempDir>",
        PWD,
        "</TempDir>",
        "",
        "<TempDir>",
        PWD,
        "</TempDir>",
      ].join("\n"),
    );

    // outer, inner, outer again, sibling.
    const seen = directories(yield* run(dir));
    expect(seen).toHaveLength(4);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[2]).toBe(seen[0]);
    expect(seen[3]).not.toBe(seen[0]);
    expect(seen[3]).not.toBe(seen[1]);
  });

  // TD5: cleanup on the ordinary path.
  it("TD5: the directory is removed after the content finishes", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(dir, `<TempDir>\n${PWD}\n</TempDir>`);

    const [created] = directories(yield* run(dir));
    expect(created).toBeDefined();
    expect(yield* exists(created)).toBe(false);
  });

  // TD6: a failure inside the content does not strand the directory. The block
  // records where it ran in the fixture — which outlives the run — before
  // failing, so the removed directory can still be named.
  it("TD6: the directory is removed after the content fails", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(
      dir,
      [
        "<TempDir>",
        "```sh exec",
        `pwd > ${join(dir, "seen.txt")}; exit 3`,
        "```",
        "</TempDir>",
      ].join("\n"),
    );

    yield* run(dir);

    const [created] = yield* recorded(dir, "seen.txt");
    expect(created).toContain("xmd-tempdir-");
    expect(yield* exists(created)).toBe(false);
  });

  // TD7: halting mid-expansion still removes it. The suspended block keeps the
  // document running so the halt lands while the directory is live.
  it("TD7: the directory is removed when the run is cancelled", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(
      dir,
      [
        "<TempDir>",
        "```sh exec",
        `pwd > ${join(dir, "seen.txt")}; sleep 30`,
        "```",
        "</TempDir>",
      ].join("\n"),
    );

    yield* race([run(dir), sleep(1500)]);

    const [created] = yield* recorded(dir, "seen.txt");
    expect(created).toContain("xmd-tempdir-");
    expect(yield* exists(created)).toBe(false);
  });

  // TD8: a daemon inherits the directory and is stopped before it is removed —
  // §4.4's stage 1 running ahead of the component's own resource.
  it("TD8: a daemon runs in the directory and stops before cleanup", function* () {
    const dir = yield* useFixture();
    const marker = join(dir, "daemon.txt");
    yield* writeDocument(
      dir,
      [
        "<TempDir>",
        "```bash daemon exec",
        `pwd > ${marker}; echo $$ >> ${marker}; sleep 30`,
        "```",
        "```sh exec",
        "sleep 0.5",
        "```",
        "</TempDir>",
      ].join("\n"),
    );

    yield* run(dir);

    const [reported, pid] = yield* recorded(dir, "daemon.txt");
    expect(reported).toContain("xmd-tempdir-");
    expect(yield* exists(reported)).toBe(false);
    // No `@effectionx/fs` equivalent: whether a pid is live is not a file question.
    expect(() => process.kill(Number(pid), 0)).toThrow();
  });

  // TD9: the bare form has no capture to hide behind — the path it returns is
  // what the document renders.
  it("TD9: a bare TempDir renders its canonical path", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(dir, "<TempDir />");

    const output = String(yield* run(dir));
    const [rendered] = directories(output);
    expect(rendered).toBeDefined();
    expect(output.trim()).toBe(rendered);
  });

  // TD10: the captured form renders nothing where it is written, binds the
  // path, and leaves the directory live for what follows — the reason the
  // standalone form retains at all.
  it("TD10: a captured TempDir renders nothing and stays live for a sibling", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(
      dir,
      [
        '<TempDir as="workspace" />',
        "",
        "```sh exec",
        `test -d {workspace} && echo PRESENT; echo {workspace} > ${join(dir, "captured.txt")}`,
        "```",
      ].join("\n"),
    );

    const output = String(yield* run(dir));
    expect(output).toContain("PRESENT");
    // Nothing rendered at the invocation site: the only path in the output is
    // the one the sibling block echoed, and the capture itself emitted none.
    expect(output.split("PRESENT")[0]).not.toContain("xmd-tempdir-");
  });

  // TD11: retained is not permanent. The path is recorded outside the
  // directory so it can still be named after the execution that owned it ends.
  it("TD11: a retained directory is removed when the document scope closes", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(
      dir,
      [
        '<TempDir as="workspace" />',
        "",
        "```sh exec",
        `echo {workspace} > ${join(dir, "captured.txt")}`,
        "```",
      ].join("\n"),
    );

    yield* run(dir);

    const [captured] = yield* recorded(dir, "captured.txt");
    expect(captured).toContain("xmd-tempdir-");
    expect(yield* exists(captured)).toBe(false);
  });

  // TD12: props are validated like any component's — no name-specific check.
  it("TD12: an undeclared prop is rejected", function* () {
    const dir = yield* useFixture();
    yield* writeDocument(dir, '<TempDir keep="yes">inside</TempDir>');

    expect(String(yield* run(dir))).toContain("additional properties");
  });

  // TD13: resuming from a partial journal would otherwise replay an effect
  // recorded under a directory this run never created. It is a durability
  // failure, not a document diagnostic: the execution fails, and nothing after
  // the component runs.
  it("TD13: a stale replay fails the execution instead of rendering a diagnostic", function* () {
    const dir = yield* useFixture();
    const after = join(dir, "sibling-ran.txt");
    yield* writeDocument(
      dir,
      [
        "<TempDir>",
        "```sh exec",
        "pwd; touch made-here",
        "```",
        "</TempDir>",
        "",
        "```sh exec",
        `touch ${after}`,
        "```",
      ].join("\n"),
    );

    const stream = new InMemoryStream();
    const first = String(
      yield* scoped(function* () {
        return yield* collect(
          yield* execute({ path: join(dir, "doc.md"), stream, componentDirs: [dir] }),
        );
      }),
    );
    const [recordedDirectory] = directories(first);
    expect(recordedDirectory).toContain("xmd-tempdir-");
    // The sibling ran on the live pass, so its absence below means something.
    expect(yield* exists(after)).toBe(true);
    yield* rm(after);

    // Without the root Close the next run replays what is journaled and then
    // continues live — the shape that would consume the stale exec entry. The
    // root policy is "collect", so this also proves the ambient policy cannot
    // downgrade the refusal to a rendered comment.
    const events = yield* stream.readAll();
    const partial = events.filter(
      (event) => !(event.type === "close" && event.coroutineId === "root"),
    );
    const outcome = yield* scoped(function* () {
      const execution = yield* execute({
        path: join(dir, "doc.md"),
        stream: new InMemoryStream(partial),
        componentDirs: [dir],
      });
      return yield* execution;
    });

    // The execution failed rather than completing with a diagnostic in it.
    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? undefined : outcome.error;
    expect(error).toBeInstanceOf(StaleInputError);
    expect(String(error?.message)).toContain("cannot replay the recorded exec effect");
    // And expansion stopped: the block after </TempDir> never ran.
    expect(yield* exists(after)).toBe(false);
  });

  // TD15: acquisition and its cleanup are one step. A halt cannot land between
  // creating the directory and owning its removal, so no cancellation leaves
  // one behind — whether it arrives while the directory is in use or before
  // the acquiring task has run at all.
  it("TD15: a cancelled acquisition leaves no directory behind", function* () {
    const before = yield* temporaries();

    // Halted while the directory is live: the path is observed first, so the
    // assertion names the directory that actually existed.
    const observed = withResolvers<string>();
    const live = yield* spawn(function* () {
      const directory = yield* useTemporaryDirectory();
      observed.resolve(directory);
      yield* suspend();
    });
    const directory = yield* observed.operation;
    expect(yield* exists(directory)).toBe(true);
    yield* live.halt();
    expect(yield* exists(directory)).toBe(false);

    // Halted mid-acquisition, then given time to settle. An acquisition that
    // suspended on a pending creation would finish here, after the task that
    // asked for it is gone, and leave a directory nothing owns.
    const early = yield* spawn(() => useTemporaryDirectory());
    yield* early.halt();
    yield* sleep(50);

    // Whatever either task created, nothing survives it.
    expect(yield* temporaries()).toEqual(before);
  });

  // TD16: the other durable effect a `<TempDir>` can consume. A nested
  // component's import is journaled, so on a partial replay it is the first
  // entry the directory's content would restore — and it goes through
  // expansion's import catch rather than the code-block one.
  it("TD16: a replayed component import inside TempDir fails the execution", function* () {
    const dir = yield* useFixture();
    const after = join(dir, "sibling-ran.txt");
    yield* writeTextFile(join(dir, "Nested.md"), "nested content");
    yield* writeDocument(
      dir,
      ["<TempDir>", "<Nested />", "</TempDir>", "", "```sh exec", `touch ${after}`, "```"].join(
        "\n",
      ),
    );

    const stream = new InMemoryStream();
    const first = String(
      yield* scoped(function* () {
        return yield* collect(
          yield* execute({ path: join(dir, "doc.md"), stream, componentDirs: [dir] }),
        );
      }),
    );
    expect(first).toContain("nested content");
    // The import this replay will consume.
    expect(yield* imported(stream)).toContain("Nested");
    expect(yield* exists(after)).toBe(true);
    yield* rm(after);

    const events = yield* stream.readAll();
    const partial = events.filter(
      (event) => !(event.type === "close" && event.coroutineId === "root"),
    );
    const outcome = yield* scoped(function* () {
      const execution = yield* execute({
        path: join(dir, "doc.md"),
        stream: new InMemoryStream(partial),
        componentDirs: [dir],
      });
      return yield* execution;
    });

    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? undefined : outcome.error;
    expect(error).toBeInstanceOf(StaleInputError);
    expect(String(error?.message)).toContain("import_component");
    // Expansion stopped: the block after the component never ran.
    expect(yield* exists(after)).toBe(false);
  });

  // TD14: an ordinary failure inside the directory is still an ordinary
  // diagnostic — the fatal rule is for stale journal entries, not for
  // everything that goes wrong inside a `<TempDir>`.
  it("TD14: an ordinary failure inside TempDir stays a rendered diagnostic", function* () {
    const dir = yield* useFixture();
    const after = join(dir, "sibling-ran.txt");
    yield* writeDocument(
      dir,
      [
        "<TempDir>",
        "```sh exec",
        "echo nope >&2; exit 4",
        "```",
        "</TempDir>",
        "",
        "```sh exec",
        `touch ${after}`,
        "```",
      ].join("\n"),
    );

    const outcome = yield* scoped(function* () {
      const execution = yield* execute({
        path: join(dir, "doc.md"),
        stream: new InMemoryStream(),
        componentDirs: [dir],
      });
      return yield* execution;
    });

    expect(outcome.ok).toBe(true);
    // The sibling after the component still ran.
    expect(yield* exists(after)).toBe(true);
  });
});
