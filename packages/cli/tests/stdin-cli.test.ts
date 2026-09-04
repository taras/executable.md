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
import { runCli, runShell } from "@executablemd/test-support/launch";
import { when } from "@effectionx/converge";
import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
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
import process from "node:process";
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

/**
 * Two roots on disk and one on standard input, each of which leaves a file
 * behind when it runs, so "nothing executed" is observable rather than assumed.
 */
const CONFLICT_FIXTURE = {
  "ordinary.md": '<File path="ordinary-ran.txt">x</File>\n\nORDINARY_MARKER\n',
  "-": [
    "# Dash",
    "",
    '<File path="dash-ran.txt">x</File>',
    "",
    "DASH_MARKER",
    "",
    "## Section",
    "",
    "SECTION_MARKER",
    "",
  ].join("\n"),
};

/** What the shared launcher attaches to a child it owns, and to its pipes. */
function attached(child: ChildProcess): number[] {
  return [
    child.listenerCount("error"),
    child.listenerCount("close"),
    child.stdout?.listenerCount("data") ?? 0,
    child.stderr?.listenerCount("data") ?? 0,
    child.stdin?.listenerCount("error") ?? 0,
  ];
}

const STDIN_EFFECT = '<File path="stdin-ran.txt">x</File>\n\nSTDIN_MARKER\n';

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

    /**
     * Which of two roots the parser happened to take depends on where the
     * caller wrote them; a run naming two does not. Every pair is written both
     * ways round, and each half is a document that would leave a file behind if
     * anything ran it.
     */
    it("SI13: two roots refuse in either order, before anything is read", function* () {
      const pairs: string[][] = [
        ["run", "ordinary.md", "-"],
        ["run", "-", "ordinary.md"],
        ["run", "ordinary.md", "--", "-"],
        ["run", "--", "-", "ordinary.md"],
        ["run", "ordinary.md", "-#Section"],
        ["run", "-#Section", "ordinary.md"],
      ];

      for (const argv of pairs) {
        yield* useFixture(CONFLICT_FIXTURE, function* (dir) {
          const { code, stdout, stderr } = yield* runCli([...argv, "--raw"], {
            cwd: dir,
            stdin: STDIN_EFFECT,
          }).join();

          expect(code).toBe(1);
          expect(stderr).toContain("both supply a root document");
          // No candidate executed: neither marker was rendered, and neither
          // document's `<File>` reached the directory.
          expect(stdout).not.toContain("ORDINARY_MARKER");
          expect(stdout).not.toContain("DASH_MARKER");
          expect(stdout).not.toContain("STDIN_MARKER");
          expect(yield* exists(path.join(dir, "ordinary-ran.txt"))).toBe(false);
          expect(yield* exists(path.join(dir, "dash-ran.txt"))).toBe(false);
          expect(yield* exists(path.join(dir, "stdin-ran.txt"))).toBe(false);
        });
      }
    });

    it("SI14: one root written twice refuses, and neither copy runs", function* () {
      for (const argv of [
        ["run", "-", "-"],
        ["run", "-#Section", "-#Section"],
      ]) {
        yield* useFixture(CONFLICT_FIXTURE, function* (dir) {
          const { code, stdout, stderr } = yield* runCli([...argv, "--raw"], {
            cwd: dir,
            stdin: STDIN_EFFECT,
          }).join();

          expect(code).toBe(1);
          expect(stderr).toContain("supplies the root document more than once");
          expect(stdout).not.toContain("DASH_MARKER");
          expect(stdout).not.toContain("STDIN_MARKER");
          expect(yield* exists(path.join(dir, "dash-ran.txt"))).toBe(false);
          expect(yield* exists(path.join(dir, "stdin-ran.txt"))).toBe(false);
        });
      }
    });

    /**
     * A `-` is only a document argument where the grammar has nowhere else to
     * put it. These four spellings each keep their own meaning, and the run
     * they name is still the one root a run takes.
     */
    it("SI15: an option's value, another command's argument and a typo are not roots", function* () {
      yield* useFixture(CONFLICT_FIXTURE, function* (dir) {
        const trace = path.join(dir, "trace.jsonl");
        // `--journal -` names a file called `-` to write, so the run has the
        // one root it was given and the conflict never arises.
        const journal = yield* runCli(["run", "--journal", trace, "ordinary.md", "--raw"], {
          cwd: dir,
          stdin: STDIN_EFFECT,
        }).join();
        expect(journal.code).toBe(0);
        expect(journal.stdout).toContain("ORDINARY_MARKER");
        expect(journal.stdout).not.toContain("STDIN_MARKER");

        const evaluated = yield* runCli(["run", "--eval", "-"], {
          cwd: dir,
          stdin: STDIN_EFFECT,
        }).join();
        expect(evaluated.code).toBe(1);
        expect(evaluated.stderr).toContain("does not read from stdin");
        expect(evaluated.stderr).not.toContain("both supply a root document");

        const other = yield* runCli(["test", "-"], { cwd: dir, stdin: STDIN_EFFECT }).join();
        expect(`${other.stdout}${other.stderr}`).not.toContain("both supply a root document");
        expect(other.stdout).not.toContain("STDIN_MARKER");

        // An option nothing defines is still an option: the run refuses for
        // want of a root rather than looking for a file named after the flag.
        const typo = yield* runCli(["run", "--raww", "ordinary.md"], {
          cwd: dir,
          stdin: STDIN_EFFECT,
        }).join();
        expect(typo.code).toBe(1);
        expect(typo.stderr).toContain("requires a root document");

        expect(yield* exists(path.join(dir, "stdin-ran.txt"))).toBe(false);
      });
    });

    it("SI12: cancelling a stdin run returns only once its child is gone", function* () {
      yield* useFixture({}, function* (dir) {
        const idsPath = path.join(dir, "ids.txt");
        // A command that ignores SIGTERM and holds the run open behind it.
        // Measured: a group SIGTERM leaves this CLI unclosed indefinitely, so
        // teardown can only return by escalating and then waiting for the
        // child's own close boundary. `$$` is the command's shell and `$PPID`
        // is the CLI the launcher owns.
        const document = [
          "```bash exec",
          `trap "" TERM; echo "$$ $PPID" > ${idsPath}; sleep 20`,
          "```",
          "",
        ].join("\n");

        // The child this launcher owns, what its streams carried before the
        // launcher attached anything, and what the run has captured from it.
        let child: ChildProcess | undefined;
        let before: number[] = [];
        let captured: () => { stdout: string; stderr: string } = () => ({
          stdout: "",
          stderr: "",
        });

        const run = yield* spawn(function* () {
          yield* runCli(["run", "-", "--raw"], {
            cwd: dir,
            stdin: document,
            timeout: 60_000,
            observeChild: (started, reader) => {
              child = started;
              before = attached(started);
              captured = reader;
            },
          }).join();
        });

        // `escaped` is not `owned`. `@effectionx/process` detaches an exec child
        // into a process group of its own, so the command belongs to the
        // running CLI, to be reaped while it unwinds — and a command written to
        // survive that unwinding survives it. The launcher owns the CLI's group
        // and nothing else; this row owns the escapee, and ends it on the way
        // out however the assertions below turn out.
        const [escaped, owned] = yield* waitForIds(idsPath);
        yield* ensure(() => endEscapedGroup(escaped));

        // Synchronized on the command having run, so every handler is attached
        // and the child is still alive when the run is cancelled underneath it.
        if (!child) {
          throw new Error("the launcher never owned a child");
        }
        const live = attached(child);
        const seen = captured();

        // At least what this owner attached, not exactly it: a runtime may hold
        // handlers of its own on a child and its pipes, so the release below is
        // measured against what was live rather than against the baseline.
        live.forEach((count, index) => {
          expect(count).toBeGreaterThanOrEqual(before[index] + 1);
        });

        const at = Date.now();
        yield* run.halt();
        const elapsed = Date.now() - at;

        // Cancelled while all five were live, and back to what the runtime had
        // before the launcher attached anything. Read before the events are
        // replayed, because a handler removed by its own event would leave the
        // same counts behind as one the launcher released.
        const released = live.map((count) => count - 1);

        expect(attached(child)).toEqual(released);

        child.stdout?.emit("data", Buffer.from("after the run was cancelled"));
        child.stderr?.emit("data", Buffer.from("after the run was cancelled"));
        child.emit("close", 0, null);

        // And nothing is still accumulating: the capture the run abandoned did
        // not grow.
        expect(captured()).toEqual(seen);
        expect(attached(child)).toEqual(released);

        // A signal that has been sent is not a process that is gone: teardown
        // returning as soon as it signalled would come back at once. Nor may it
        // wait forever on a child that is never going to answer SIGTERM — the
        // command sleeps for twenty seconds, and escalation is what ends this
        // inside the grace period instead.
        expect(elapsed).toBeGreaterThanOrEqual(1_500);
        expect(elapsed).toBeLessThan(10_000);
        // And the group the launcher owns is gone by the time it returns.
        expect(yield* waitForGroupExit(owned)).toBe(true);
      });
    });

    /**
     * Teardown's boundary is the child's `close`, not the signal it was sent
     * and not an exit status the handle has recorded. This child traps the
     * interrupt, writes on its way out, and only then leaves — so the marker
     * can only be here if the capture was still attached while it stopped and
     * the cancellation waited for the pipes to end.
     */
    it("SI12b: what a cancelled child writes while it stops is still captured", function* () {
      let child: ChildProcess | undefined;
      let before: number[] = [];
      let captured: () => { stdout: string; stderr: string } = () => ({
        stdout: "",
        stderr: "",
      });

      const run = yield* spawn(function* () {
        // A large trailing write, so what is asserted below is the whole of it
        // rather than the first line to arrive.
        yield* runShell("trap 'yes LATE | head -20000; exit 0' TERM; echo READY; sleep 20", {
          stdin: "",
          timeout: 60_000,
          observeChild: (started, reader) => {
            child = started;
            before = attached(started);
            captured = reader;
          },
        }).join();
      });

      // Synchronized on the child running, so the halt lands on a live process
      // with every handler attached.
      yield* when(function* () {
        expect(captured().stdout).toContain("READY");
      });

      if (!child) {
        throw new Error("the launcher never owned a child");
      }
      const live = attached(child);

      yield* run.halt();

      live.forEach((count, index) => {
        expect(count).toBeGreaterThanOrEqual(before[index] + 1);
      });
      // All of it, written after the signal and before `close`: the capture was
      // still attached while the child stopped, and teardown did not return
      // until the pipes had ended.
      expect(captured().stdout.split("LATE").length - 1).toBe(20_000);
      // And released only once that had happened.
      expect(attached(child)).toEqual(live.map((count) => count - 1));
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

/** The command's own pid and the CLI's, once the run has reached the command. */
function* waitForIds(idsPath: string): Operation<[number, number]> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ids = yield* readIds(idsPath);
    if (ids !== undefined) {
      return ids;
    }
    yield* sleep(50);
  }
  throw new Error(`the run never reached its command: ${idsPath} names no pids`);
}

function* readIds(idsPath: string): Operation<[number, number] | undefined> {
  let written: string;
  try {
    written = yield* readTextFile(idsPath);
  } catch {
    return undefined;
  }
  const [command, cli] = written
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  return Number.isInteger(command) && Number.isInteger(cli) ? [command, cli] : undefined;
}

/**
 * Whether that whole process group is gone.
 *
 * Bounded rather than instantaneous: the group dies together, so the kernel may
 * still be reaping a member as the launcher's own child closes.
 */
function* waitForGroupExit(leader: number): Operation<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isReachable(-leader)) {
      return true;
    }
    yield* sleep(50);
  }
  return false;
}

/** Signal 0 delivers nothing: it asks the kernel whether the target is there. */
function isReachable(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End the process group this row deliberately let escape, and wait for it.
 *
 * Registered with `ensure`, so it runs whether the assertions passed, failed or
 * were cancelled. A signal that was sent is not a process that stopped, so this
 * waits for the group to become unreachable and fails the row when it cannot
 * establish that — a suite that left something running would otherwise say so
 * nowhere.
 */
function* endEscapedGroup(leader: number): Operation<void> {
  if (!isReachable(-leader)) {
    return;
  }
  killGroup(leader);
  if (!(yield* waitForGroupExit(leader))) {
    throw new Error(`the escaped process group ${leader} did not stop after SIGKILL`);
  }
}

/** Send the signal. Establishing that it worked is `endEscapedGroup`'s job. */
function killGroup(leader: number): void {
  try {
    process.kill(-leader, "SIGKILL");
  } catch {
    // Already gone.
  }
}
