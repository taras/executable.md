/**
 * Tier SI — `xmd run -`, the root document read from standard input (#723).
 *
 * The public rows shell out through the launcher's real stdin pipe, so what the
 * CLI observes is the pipeline a caller would build: bytes, then an actual end
 * of file. The private rows drive `runXmd` in this process, because a read that
 * fails, a read that is cancelled, and a reader that is never called are all
 * facts about a call inside the process that no subprocess can show.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import {
  createContext,
  Err,
  ensure,
  Ok,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation, Result, Task } from "effection";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { API, Service, useHostFiles } from "@executablemd/runtime";
import { runXmd } from "../src/cli.ts";
import {
  readInputStream,
  STANDARD_INPUT_FAILURE,
  STANDARD_INPUT_PATH,
} from "../src/standard-input.ts";
import type { StandardInputReader } from "../src/standard-input.ts";
import { unsupportedRepositories } from "../src/run-repositories.ts";
import { SOURCE_UPGRADE } from "./support/upgrade-assembly.ts";

function* useFixture<T>(
  files: Record<string, string>,
  body: (dir: string) => Operation<T>,
): Operation<T> {
  const dir = path.join(os.tmpdir(), `xmd-si-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, content] of Object.entries(files)) {
      yield* writeTextFile(path.join(dir, name), content);
    }
    return yield* body(dir);
  });
}

function* entries(dir: string): Operation<Set<string>> {
  return new Set(yield* until(readdir(dir)));
}

const MARKER_DOCUMENT = "# Piped\n\nSTDIN_MARKER\n";

const PROPS_DOCUMENT = [
  "---",
  "props:",
  "  name:",
  "    type: string",
  "    description: Person to greet",
  "required: [name]",
  "---",
  "",
  "Hello {props.name}",
].join("\n");

const VALUE_DOCUMENT = [
  "---",
  "returns:",
  "  ok: { type: boolean }",
  "---",
  "",
  "rendered body",
  "",
  "<Return value={{ ok: true }} />",
].join("\n");

/**
 * An effect, and then a construct the structural preflight refuses.
 *
 * The `<File>` is the negative control: reaching it at all would leave a file
 * behind. The malformed `<Return>` is a declaration violation, which core
 * reports before the body runs — so the whole input has to have been read for
 * the run to refuse it, and refusing costs the earlier effect.
 */
const PREFLIGHT_DOCUMENT = [
  "---",
  "returns:",
  "  ok: { type: boolean }",
  "---",
  "",
  '<File path="written.txt">content</File>',
  "",
  "<Return>oops</Return>",
  "",
].join("\n");

/** A document whose third line is a construct only `<If>` may select. */
const POSITIONED_DOCUMENT = "PREFIX\n\n<Else>stray</Else>\n";

/** A document that writes one file, so an execution is visible on disk. */
const EFFECTFUL_DOCUMENT = '<File path="written.txt">content</File>\n';

describe(
  "Tier SI — standard-input root documents",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("SI1: a piped document reaches end of file and runs once", function* () {
      const { code, stdout, stderr } = yield* runCli(["run", "-", "--raw"], {
        stdin: MARKER_DOCUMENT,
      }).join();

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.split("STDIN_MARKER")).toHaveLength(2);
    });

    it("SI2: the separator form selects standard input too", function* () {
      const { code, stdout, stderr } = yield* runCli(["run", "--", "-", "--raw"], {
        stdin: MARKER_DOCUMENT,
      }).join();

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.split("STDIN_MARKER")).toHaveLength(2);
      // `-` after the separator is the document argument, never an option or a
      // path: a run that read it as either would have refused for want of a
      // root, or looked for a file of that name.
      expect(stderr).not.toContain("requires a root document");
    });

    it("SI3: the whole input is read, and preflight costs the earlier effect", function* () {
      yield* useFixture({}, function* (dir) {
        const { code, stderr } = yield* runCli(["run", "-", "--raw"], {
          cwd: dir,
          stdin: PREFLIGHT_DOCUMENT,
        }).join();

        expect(code).not.toBe(0);
        // Only the last construct in the input can produce this, so the read
        // reached end of file rather than stopping at its first chunk.
        expect(stderr).toContain('<Return /> requires a "value" prop');
        expect(stderr).toContain("<Return /> takes no children");
        // Complete structural preflight finishes before the first document
        // effect, so the `<File>` written above it never ran.
        expect(yield* exists(path.join(dir, "written.txt"))).toBe(false);
      });
    });

    it("SI4: empty input is an empty root that emits nothing and does nothing", function* () {
      yield* useFixture({}, function* (dir) {
        const before = yield* entries(dir);
        const { code, stdout, stderr } = yield* runCli(["run", "-", "--raw"], {
          cwd: dir,
          stdin: "",
        }).join();

        expect(code).toBe(0);
        expect(stdout).toBe("");
        expect(stderr).toBe("");
        expect(yield* entries(dir)).toEqual(before);
      });
    });

    it("SI5: the root reports <stdin> and retains the exact supplied source", function* () {
      const positioned = yield* runCli(["run", "-", "--raw"], {
        stdin: POSITIONED_DOCUMENT,
      }).join();
      expect(positioned.code).toBe(1);
      expect(positioned.stderr).toContain(`(${STANDARD_INPUT_PATH}:3:1)`);

      yield* useFixture({}, function* (dir) {
        const trace = path.join(dir, "trace.jsonl");
        yield* runCli(["run", "--raw", "--journal", trace, "-"], {
          cwd: dir,
          stdin: MARKER_DOCUMENT,
        }).join();

        const written = yield* readTextFile(trace);
        const root = written
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
          .find(
            (event) =>
              event.type === "yield" &&
              event.description?.type === "import_component" &&
              event.description?.name === "__root__",
          );

        // Exact equality is the claim: the existing closed repository-root
        // shape, the `<stdin>` origin, the exact bytes, and no member of its
        // own — no stdin kind and no digest.
        expect(root?.result?.value).toEqual({
          kind: "repository",
          path: STANDARD_INPUT_PATH,
          content: MARKER_DOCUMENT,
        });
      });
    });

    it("SI6: relative resolution is the invocation's, and <stdin> is no file", function* () {
      yield* useFixture({ "Greeting.md": "Hello from a component\n" }, function* (dir) {
        const before = yield* entries(dir);
        const { code, stdout } = yield* runCli(["run", "-", "--raw"], {
          cwd: dir,
          stdin: "<Greeting />\n",
        }).join();

        expect(code).toBe(0);
        expect(stdout).toContain("Hello from a component");
        // The origin is an identity, never a path: nothing named it on disk,
        // and the run left the directory exactly as it found it.
        expect(yield* exists(path.join(dir, STANDARD_INPUT_PATH))).toBe(false);
        expect(yield* entries(dir)).toEqual(before);
      });
    });

    it("SI7: the ordinary run options apply to a document read from stdin", function* () {
      const props = yield* runCli(["run", "-", "--raw", "--props-name", "Ada"], {
        stdin: PROPS_DOCUMENT,
      }).join();
      expect(props.code).toBe(0);
      expect(props.stdout).toContain("Hello Ada");

      // Written after the sentinel, so this also proves the document argument
      // no longer stops the parser: a dropped `--verbose` would echo nothing.
      const verbose = yield* runCli(["run", "-", "--raw", "--verbose"], {
        stdin: MARKER_DOCUMENT,
      }).join();
      expect(verbose.code).toBe(0);
      expect(verbose.stderr).toContain("[yield] import_component:__root__");

      const quiet = yield* runCli(["run", "--raw", "-"], { stdin: MARKER_DOCUMENT }).join();
      expect(quiet.code).toBe(0);
      expect(quiet.stderr).toBe("");
      expect(quiet.stdout).toBe(MARKER_DOCUMENT);

      yield* useFixture({}, function* (dir) {
        // A malformed duration is fixed grammar, refused before anything is
        // read — so the document that would have written a file never ran.
        const malformed = yield* runCli(["run", "--timeout", "nope", "-"], {
          cwd: dir,
          stdin: EFFECTFUL_DOCUMENT,
        }).join();
        expect(malformed.code).toBe(1);
        expect(malformed.stderr).toContain("--timeout must be a duration");
        expect(yield* exists(path.join(dir, "written.txt"))).toBe(false);

        const bounded = yield* runCli(["run", "--timeout", "5min", "--approve-reads", "-"], {
          cwd: dir,
          stdin: EFFECTFUL_DOCUMENT,
        }).join();
        expect(bounded.code).toBe(0);
        expect(yield* exists(path.join(dir, "written.txt"))).toBe(true);
      });

      const permissions = yield* runCli(["run", "--approve-all", "--deny-all", "-"], {
        stdin: MARKER_DOCUMENT,
      }).join();
      expect(permissions.code).toBe(1);
      expect(permissions.stderr).toContain("mutually exclusive");
    });

    it("SI11: a value root read from stdin reserves stdout for its result", function* () {
      const { code, stdout } = yield* runCli(["run", "-"], { stdin: VALUE_DOCUMENT }).join();
      expect(code).toBe(0);
      expect(stdout.trim()).toBe('{"ok":true}');
      expect(stdout).not.toContain("rendered body");

      const verbose = yield* runCli(["run", "-", "--verbose"], { stdin: VALUE_DOCUMENT }).join();
      expect(verbose.stdout.trim()).toBe('{"ok":true}');
      expect(verbose.stderr).toContain("rendered body");
    });

    it("SI10: only a selected stdin root reads, and reading it executes nothing", function* () {
      yield* useFixture({}, function* (dir) {
        const trace = path.join(dir, "trace.jsonl");

        const generic = yield* controlledRun(
          ["run", "--help", "--journal", trace],
          dir,
          succeeds(PROPS_DOCUMENT),
        );
        expect(generic.status).toBe(0);
        expect(generic.reader.calls).toBe(0);
        expect(generic.stdout).toContain("Usage: xmd run");
        expect(generic.stdout).not.toContain("Properties declared by");

        const selected = yield* controlledRun(
          ["run", "-", "--help", "--journal", trace],
          dir,
          succeeds(PROPS_DOCUMENT),
        );
        expect(selected.status).toBe(0);
        expect(selected.reader.calls).toBe(1);
        expect(selected.stdout).toContain(`Properties declared by ${STANDARD_INPUT_PATH}`);
        expect(selected.stdout).toContain("--props-name <string>");
        // Help is inspection: no provider was wired in, and the journal it
        // asked for was never created.
        expect(selected.serviceInstalled).toBe(false);
        expect(yield* exists(trace)).toBe(false);
      });

      // The same boundary through a real pipe, so the help path also reaches a
      // genuine end of file rather than a value a stand-in already held.
      const piped = yield* runCli(["run", "-", "--help"], { stdin: PROPS_DOCUMENT }).join();
      expect(piped.code).toBe(0);
      expect(piped.stdout).toContain(`Properties declared by ${STANDARD_INPUT_PATH}`);
    });

    it("SI8: a failed read reports the fixed sentence and reaches nothing after it", function* () {
      yield* useFixture({ "source.txt": "READ_ME\n" }, function* (dir) {
        const trace = path.join(dir, "trace.jsonl");
        // One document that reads and one that writes, so a run that got past
        // the reader leaves both kinds of trace behind.
        const document = `<File path="source.txt" />\n\n${EFFECTFUL_DOCUMENT}`;
        const args = ["run", "-", "--raw", "--no-secret-detection", "--journal", trace];

        const failed = yield* controlledRun(args, dir, fails("PRIVATE-READER-DETAIL"));

        expect(failed.status).toBe(1);
        expect(failed.reader.calls).toBe(1);
        expect(failed.stderr.trim()).toBe(STANDARD_INPUT_FAILURE);
        expect(failed.stderr).not.toContain("PRIVATE-READER-DETAIL");
        // The host's own error is the only thing the diagnostic could have
        // leaked; the announcement, the provider, the journal, the root and the
        // authored effect are the phases it must not have reached.
        expect(failed.stderr).not.toContain("secret detection is disabled");
        expect(failed.serviceInstalled).toBe(false);
        expect(failed.reads).toEqual([]);
        expect(yield* exists(trace)).toBe(false);
        expect(yield* exists(path.join(dir, "written.txt"))).toBe(false);

        // The positive control: the same argv and the same document, with a
        // reader that answers — so every assertion above is about the failure
        // rather than about a run that could never have done any of it.
        const ok = yield* controlledRun(args, dir, succeeds(document));
        expect(ok.status).toBe(undefined);
        expect(ok.stderr).toContain("secret detection is disabled");
        expect(ok.serviceInstalled).toBe(true);
        // Suffix rather than the joined path: macOS resolves the temporary
        // directory through `/private`, so the run's own read is the same file
        // under a different spelling.
        expect(ok.reads.filter((read) => read.endsWith("source.txt"))).toHaveLength(1);
        expect(yield* exists(trace)).toBe(true);
        expect(yield* exists(path.join(dir, "written.txt"))).toBe(true);
      });
    });

    it("SI9: cancelling a waiting read tears it down and reports no failure", function* () {
      yield* useFixture({}, function* (dir) {
        const trace = path.join(dir, "trace.jsonl");
        const waiting = waits();

        const run = yield* cancellableRun(
          ["run", "-", "--raw", "--journal", trace],
          dir,
          waiting.reader,
        );
        yield* waiting.started;
        yield* run.task.halt();

        // Halting waited for the reader's own teardown before it returned.
        expect(waiting.torndown).toBe(true);
        expect(run.state.status).toBe(undefined);
        expect(run.state.stderr).toBe("");
        expect(run.state.serviceInstalled).toBe(false);
        expect(yield* exists(trace)).toBe(false);
        expect(yield* exists(path.join(dir, "written.txt"))).toBe(false);
      });
    });

    it("SI1b: the read waits for end of file and joins every chunk", function* () {
      // A subprocess pipe delivers a small document in one chunk, so nothing a
      // launcher can arrange separates "read to end of file" from "read the
      // first chunk". A stream this row owns does: it holds bytes back, and
      // splits one character across a chunk boundary on the way.
      const stream = new PassThrough();
      let settled: Result<string> | undefined;
      const read = yield* spawn(function* () {
        settled = yield* readInputStream(stream);
      });
      yield* sleep(0);

      stream.write("# One\n");
      yield* sleep(0);
      expect(settled).toBe(undefined);

      stream.write(new Uint8Array([0xc3]));
      stream.write(new Uint8Array([0xa9]));
      yield* sleep(0);
      expect(settled).toBe(undefined);

      stream.end();
      yield* read;

      expect(settled).toEqual(Ok("# One\né"));
    });

    it("SI9b: the stream adapter's listeners belong to the read's own scope", function* () {
      const stream = new PassThrough();
      const read = yield* spawn(() => readInputStream(stream));
      yield* sleep(0);

      // A real stream, partly delivered: the read is waiting for an end of file
      // that never comes.
      stream.write("partial");
      for (const event of ["data", "end", "close", "error"]) {
        expect(stream.listenerCount(event)).toBe(1);
      }

      yield* read.halt();

      for (const event of ["data", "end", "close", "error"]) {
        expect(stream.listenerCount(event)).toBe(0);
      }
      expect(stream.isPaused()).toBe(true);
    });
  },
);

/**
 * The exit continuation `exit()` reaches for. `main()` installs one under this
 * name; a suite that drives `runXmd` directly installs its own so a command's
 * status is a value rather than a process exit.
 */
const ExitContext = createContext<(result: { status: number }) => Operation<void>>("exit");

interface ControlledReader {
  read: StandardInputReader;
  /** How many times the run asked the host for standard input. */
  calls: number;
}

function succeeds(source: string): ControlledReader {
  const reader: ControlledReader = {
    calls: 0,
    // deno-lint-ignore require-yield
    *read(): Operation<Result<string>> {
      reader.calls += 1;
      return Ok(source);
    },
  };
  return reader;
}

function fails(detail: string): ControlledReader {
  const reader: ControlledReader = {
    calls: 0,
    // deno-lint-ignore require-yield
    *read(): Operation<Result<string>> {
      reader.calls += 1;
      return Err(new Error(detail));
    },
  };
  return reader;
}

/** A reader that arrives, says so, and then waits for bytes that never come. */
function waits(): {
  reader: ControlledReader;
  started: Operation<void>;
  readonly torndown: boolean;
} {
  const arrived = withResolvers<void>();
  const state = { torndown: false };
  const reader: ControlledReader = {
    calls: 0,
    *read(): Operation<Result<string>> {
      reader.calls += 1;
      yield* ensure(() => {
        state.torndown = true;
      });
      arrived.resolve();
      yield* suspend();
      throw new Error("the waiting reader resumed");
    },
  };
  return {
    reader,
    started: arrived.operation,
    get torndown() {
      return state.torndown;
    },
  };
}

interface ControlledRun {
  status: number | undefined;
  stdout: string;
  stderr: string;
  /** Whether the host's provider installer ran. */
  serviceInstalled: boolean;
  /** Every path the run read for itself. */
  reads: string[];
}

/**
 * Everything one in-process `runXmd` invocation is observed through.
 *
 * The state object is handed over before the run finishes, because the
 * cancellation row halts the task and then reads what it did.
 */
function* observedRun(
  args: string[],
  cwd: string,
  reader: ControlledReader,
  state: ControlledRun,
): Operation<void> {
  const logged = console.log;
  const written = console.error;
  yield* ensure(() => {
    console.log = logged;
    console.error = written;
  });
  console.log = (...parts: unknown[]) => {
    state.stdout += `${parts.map((part) => String(part)).join(" ")}\n`;
  };
  console.error = (...parts: unknown[]) => {
    state.stderr += `${parts.map((part) => String(part)).join(" ")}\n`;
  };

  yield* ExitContext.set(function* (result) {
    state.status = result.status;
  });

  yield* API.Fs.around({
    *readTextFile([target], next) {
      state.reads.push(target);
      return yield* next(target);
    },
  });

  yield* API.Env.around({
    *cwd() {
      return cwd;
    },
  });
  yield* useHostFiles();

  yield* runXmd(
    args,
    function* () {
      state.serviceInstalled = true;
      yield* Service.around({
        *start() {
          throw new Error("the run started a service");
        },
      });
    },
    SOURCE_UPGRADE,
    unsupportedRepositories,
    reader.read,
  );
}

function empty(): ControlledRun {
  return { status: undefined, stdout: "", stderr: "", serviceInstalled: false, reads: [] };
}

/** Drive one complete `runXmd` invocation and report what it did. */
function* controlledRun(
  args: string[],
  cwd: string,
  reader: ControlledReader,
): Operation<ControlledRun & { reader: ControlledReader }> {
  const state = empty();
  yield* scoped(() => observedRun(args, cwd, reader, state));
  return { ...state, reader };
}

/** Start one `runXmd` invocation and hand back the task that is running it. */
function* cancellableRun(
  args: string[],
  cwd: string,
  reader: ControlledReader,
): Operation<{ task: Task<void>; state: ControlledRun }> {
  const state = empty();
  const task = yield* spawn(() => scoped(() => observedRun(args, cwd, reader, state)));
  return { task, state };
}
