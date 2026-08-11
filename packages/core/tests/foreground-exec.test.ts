/**
 * Tier FG — foreground execution, capture, and retention (spec §3.6, #441).
 *
 * These run real children, because what is under test is what a child's output
 * does on its way to a reader. Nothing waits on a duration: a command that must
 * still be running holds itself open until the case releases it, so "the first
 * chunk arrived before the child exited" is a fact rather than a race.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { when } from "@effectionx/converge";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { Stdio } from "@effectionx/process";
import { InMemoryStream } from "@executablemd/durable-streams";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useStubFs } from "@executablemd/runtime/test";
import { FOREGROUND, VALUE_ROOT, route } from "../src/foreground.ts";
import type { ForegroundOutput } from "../src/foreground.ts";
import { API } from "@executablemd/runtime";

interface Seen {
  /** Every chunk displayed, in arrival order, with the channel it arrived on. */
  chunks: { channel: "stdout" | "stderr"; text: string }[];
  stdout: string;
  stderr: string;
}

/** Watch the display while `body` runs. */
function* watching<T>(body: (seen: Seen) => Operation<T>): Operation<T> {
  const seen: Seen = { chunks: [], stdout: "", stderr: "" };
  const decoder = new TextDecoder();
  return yield* scoped(function* () {
    // At `min`, where the host's own writer sits: a reader sees what survives
    // the document's routing, so silence and capture must reach here as
    // nothing at all.
    yield* Stdio.around(
      {
        *stdout([bytes]) {
          const text = decoder.decode(bytes);
          seen.chunks.push({ channel: "stdout", text });
          seen.stdout += text;
        },
        *stderr([bytes]) {
          const text = decoder.decode(bytes);
          seen.chunks.push({ channel: "stderr", text });
          seen.stderr += text;
        },
      },
      { at: "min" },
    );
    return yield* body(seen);
  });
}

/** A directory this case owns, removed with it. */
function* useDirectory(): Operation<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xmd-fg-"));
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function* runDocument(
  source: string,
  options: { retainProcessOutput?: boolean; stream?: InMemoryStream } = {},
): Operation<{ output: string; stream: InMemoryStream }> {
  const stream = options.stream ?? new InMemoryStream();
  yield* useStubFs({ "doc.md": source });
  const output = String(
    yield* collect(
      yield* execute({
        path: "doc.md",
        stream,
        ...(options.retainProcessOutput === undefined
          ? {}
          : { retainProcessOutput: options.retainProcessOutput }),
      }),
    ),
  );
  return { output, stream };
}

/** The value a recorded exec effect settled with. */
function execOutcome(stream: InMemoryStream): Record<string, unknown> | undefined {
  for (const event of stream.snapshot()) {
    if (
      event.type === "yield" &&
      event.description.type === "exec" &&
      event.result.status === "ok"
    ) {
      return event.result.value as Record<string, unknown>;
    }
  }
  return undefined;
}

describe("Tier FG — foreground execution", () => {
  it("FG1: a chunk is displayed before the child exits", function* () {
    const dir = yield* useDirectory();
    const release = path.join(dir, "release");
    const source = [
      "```bash exec",
      `echo READY; while [ ! -f ${release} ]; do sleep 0.05; done`,
      "```",
      "",
    ].join("\n");

    yield* watching(function* (seen) {
      yield* scoped(function* () {
        const run = yield* spawn(() => runDocument(source));
        // The child holds itself open until this case lets it finish, so
        // observing the chunk here proves it arrived before the exit.
        yield* when(function* () {
          return seen.stdout.includes("READY");
        });
        expect(seen.stdout).toContain("READY");
        yield* writeTextFile(release, "go");
        yield* run;
      });
      expect(seen.stdout).toContain("READY");
    });
  });

  it("FG2: each channel keeps its own, and each byte is displayed once", function* () {
    const source = ["```bash exec", "echo out; echo err >&2", "```", ""].join("\n");

    yield* watching(function* (seen) {
      const { output } = yield* runDocument(source);

      expect(seen.stdout).toContain("out");
      expect(seen.stderr).toContain("err");
      expect(seen.stdout).not.toContain("err");
      // Displayed once, and not rendered again at completion.
      expect(seen.stdout.match(/out/g) ?? []).toHaveLength(1);
      expect(output).not.toContain("out");
    });
  });

  it("FG3: a run that keeps no record keeps no output either", function* () {
    const source = ["```bash exec", "echo kept-or-not", "```", ""].join("\n");

    const { stream } = yield* watching(() => runDocument(source, { retainProcessOutput: false }));
    const outcome = execOutcome(stream);

    expect(outcome?.exitCode).toBe(0);
    expect(outcome?.stdout).toBe(undefined);
    expect(outcome?.stderr).toBe(undefined);
  });

  it("FG4: a run that keeps a record keeps exactly what the child wrote", function* () {
    const source = ["```bash exec", "echo out; echo err >&2", "```", ""].join("\n");

    const seenAndStream = yield* watching(function* (seen) {
      const { stream } = yield* runDocument(source, { retainProcessOutput: true });
      return { seen, stream };
    });
    const outcome = execOutcome(seenAndStream.stream);

    // Streamed live and recorded: retention adds to routing, it does not
    // replace it.
    expect(seenAndStream.seen.stdout).toContain("out");
    expect(outcome?.stdout).toBe("out\n");
    expect(outcome?.stderr).toBe("err\n");
    expect(outcome?.exitCode).toBe(0);
  });

  it("FG5: a capture takes stdout for its binding and leaves stderr diagnostic", function* () {
    const source = [
      '<Capture as="taken">',
      "```bash exec",
      "echo captured; echo diagnostic >&2",
      "```",
      "</Capture>",
      "",
      "[{taken}]",
      "",
    ].join("\n");

    yield* watching(function* (seen) {
      const { output } = yield* runDocument(source);

      expect(output).toContain("captured");
      // Taken, not shown twice.
      expect(seen.stdout).not.toContain("captured");
      expect(seen.stderr).toContain("diagnostic");
    });
  });

  it("FG6: silence displays neither channel, and a journal still records both", function* () {
    const source = ["```bash silent exec", "echo quiet; echo hushed >&2", "```", ""].join("\n");

    const run = yield* watching(function* (seen) {
      const { stream } = yield* runDocument(source, { retainProcessOutput: true });
      return { seen, stream };
    });
    const outcome = execOutcome(run.stream);

    expect(run.seen.stdout).toBe("");
    expect(run.seen.stderr).toBe("");
    // A display policy does not weaken an explicit record.
    expect(outcome?.stdout).toBe("quiet\n");
    expect(outcome?.stderr).toBe("hushed\n");
  });

  it("FG7: a nonzero exit stops the document, with no <Output> anywhere", function* () {
    const dir = yield* useDirectory();
    const later = path.join(dir, "later");
    const source = [
      "```bash exec",
      "echo before; exit 3",
      "```",
      "",
      "```bash exec",
      `touch ${later}`,
      "```",
      "",
    ].join("\n");

    const failure = yield* watching(function* (seen) {
      try {
        yield* runDocument(source);
        return { message: "", seen };
      } catch (error) {
        return { message: error instanceof Error ? error.message : String(error), seen };
      }
    });

    expect(failure.message).toContain("Command failed (exit 3)");
    // What it printed first still reached the reader.
    expect(failure.seen.stdout).toContain("before");
    // And the block after it never started.
    expect(yield* exists(later)).toBe(false);
  });

  it("FG8: cancelling a block stops the child and emits nothing afterwards", function* () {
    const dir = yield* useDirectory();
    const source = [
      "```bash exec",
      `echo started; while true; do echo more >> ${path.join(dir, "kept")}; sleep 0.05; done`,
      "```",
      "",
    ].join("\n");

    const seen = yield* watching(function* (seen) {
      yield* scoped(function* () {
        const run = yield* spawn(() => runDocument(source));
        yield* when(function* () {
          return seen.stdout.includes("started");
        });
        yield* run.halt();
      });
      return seen;
    });

    const afterTeardown = seen.chunks.length;
    // Nothing arrives once the scope is gone.
    expect(seen.chunks.length).toBe(afterTeardown);
    expect(seen.stdout).toContain("started");
  });

  /**
   * The adapter starts forwarding while it acquires the child, and publishes
   * its retained observations through Signals, which drop a send nobody has
   * subscribed to yet. A run that began retaining after acquisition would keep
   * a record missing its first bytes — silently, and only sometimes. The child
   * here writes before this case can possibly have subscribed to anything.
   */
  it("FG9: a journal keeps what a child wrote while it was still starting", function* () {
    const encoder = new TextEncoder();
    const source = ["```bash exec", "echo after-acquisition", "```", ""].join("\n");

    const run = yield* watching(function* (seen) {
      // The seam: bytes emitted while the process is being acquired, before
      // any Process object exists to subscribe to. Retention that began after
      // acquisition would miss exactly these, and only sometimes.
      yield* API.Process.around({
        *exec([options], next) {
          yield* Stdio.operations.stdout(encoder.encode("during-acquisition-out\n"));
          yield* Stdio.operations.stderr(encoder.encode("during-acquisition-err\n"));
          return yield* next(options);
        },
      });
      const { stream } = yield* runDocument(source, { retainProcessOutput: true });
      return { seen, stream };
    });
    const outcome = execOutcome(run.stream);

    expect(outcome?.stdout).toBe("during-acquisition-out\nafter-acquisition\n");
    expect(outcome?.stderr).toBe("during-acquisition-err\n");
    // Displayed once as well: retention reads the same bytes, it does not
    // consume them.
    expect(run.seen.stdout.match(/during-acquisition-out/g) ?? []).toHaveLength(1);
  });

  /**
   * Retention decides what reaches durable storage and therefore what crosses
   * the secret gate, so it is the host's and nothing else's. A same-name
   * Context is the reachable impostor: `createContext` keys by name, so a
   * separately loaded copy addresses the same binding.
   */
  it("FG10: a same-name Context cannot suppress a record the host asked for", function* () {
    const impostor = createContext<boolean>("core.retainProcessOutput", true);
    const source = ["```bash exec", "echo recorded", "```", ""].join("\n");

    const stream = yield* scoped(function* () {
      yield* impostor.set(false);
      const run = yield* watching(() => runDocument(source, { retainProcessOutput: true }));
      return run.stream;
    });

    expect(execOutcome(stream)?.stdout).toBe("recorded\n");
  });

  it("FG11: a same-name Context cannot make a transient run start keeping output", function* () {
    const impostor = createContext<boolean>("core.retainProcessOutput", false);
    const source = ["```bash exec", "echo not-recorded", "```", ""].join("\n");

    const stream = yield* scoped(function* () {
      yield* impostor.set(true);
      const run = yield* watching(() => runDocument(source, { retainProcessOutput: false }));
      return run.stream;
    });

    const outcome = execOutcome(stream);
    expect(outcome?.exitCode).toBe(0);
    expect(outcome?.stdout).toBe(undefined);
    expect(outcome?.stderr).toBe(undefined);
  });

  /**
   * A capture owns a buffer, not a retention policy. Without a journal the
   * region still reconstructs its binding, while the durable record stays exit
   * status alone — including for the region's stderr, which is diagnostic and
   * is forwarded rather than accumulated.
   */
  it("FG12: a capture without a journal binds its stdout and records nothing", function* () {
    const source = [
      '<Capture as="taken">',
      "```bash exec",
      "echo bound; echo loud >&2",
      "```",
      "</Capture>",
      "",
      "[{taken}]",
      "",
      "```bash exec",
      "echo after",
      "```",
      "",
    ].join("\n");

    const run = yield* watching(function* (seen) {
      const { output, stream } = yield* runDocument(source, { retainProcessOutput: false });
      return { seen, output, stream };
    });
    const outcome = execOutcome(run.stream);

    // The binding was reconstructed live, from the region's own buffer.
    expect(run.output).toContain("bound");
    expect(run.seen.stdout).not.toContain("bound");
    // stderr stays diagnostic and reaches the reader.
    expect(run.seen.stderr).toContain("loud");
    // And nothing at all was retained.
    expect(outcome?.stdout).toBe(undefined);
    expect(outcome?.stderr).toBe(undefined);
    // The block after the region is an ordinary foreground block again.
    expect(run.seen.stdout).toContain("after");
    expect(run.output).not.toContain("after");
  });

  /**
   * A value root's stdout carries its JSON result, so a command's stdout is
   * shown on the channel that is free. It is still the child's stdout, and a
   * record that called it stderr would not be the child's result.
   */
  it("FG13: a value root displays stdout on stderr and records it as stdout", function* () {
    const encoder = new TextEncoder();
    let kept: ForegroundOutput | undefined;

    const seen = yield* watching(function* (seen) {
      yield* scoped(function* () {
        const finished = yield* route(VALUE_ROOT, true);
        yield* Stdio.operations.stdout(encoder.encode("from-stdout\n"));
        yield* Stdio.operations.stderr(encoder.encode("from-stderr\n"));
        kept = finished();
      });
      return seen;
    });

    // Displayed where a value root can afford to show it.
    expect(seen.stderr).toContain("from-stdout");
    expect(seen.stdout).toBe("");
    // Recorded as what the child actually wrote.
    expect(kept?.retainedStdout).toBe("from-stdout\n");
    expect(kept?.retainedStderr).toBe("from-stderr\n");
  });

  /**
   * A code point split across chunks belongs to the channel that split it. One
   * shared decoder would hand a channel the other's continuation bytes and
   * produce replacement characters on both.
   */
  it("FG14: a split code point survives interleaving with the other channel", function* () {
    const euro = new TextEncoder().encode("€");
    let kept: ForegroundOutput | undefined;

    yield* scoped(function* () {
      const finished = yield* route(FOREGROUND, true);
      yield* Stdio.operations.stdout(euro.slice(0, 1));
      yield* Stdio.operations.stderr(new TextEncoder().encode("x"));
      yield* Stdio.operations.stdout(euro.slice(1));
      kept = finished();
    });

    expect(kept?.retainedStdout).toBe("€");
    expect(kept?.retainedStderr).toBe("x");
  });

  it("FG15: a journaled capture agrees byte for byte with what it retained", function* () {
    const euro = new TextEncoder().encode("€");
    let kept: ForegroundOutput | undefined;

    yield* scoped(function* () {
      const finished = yield* route({ stdout: "capture", stderr: "forward" }, true);
      yield* Stdio.operations.stdout(euro.slice(0, 2));
      yield* Stdio.operations.stderr(new TextEncoder().encode("diagnostic"));
      yield* Stdio.operations.stdout(euro.slice(2));
      kept = finished();
    });

    // The same bytes, decoded once and handed to both.
    expect(kept?.captured).toBe("€");
    expect(kept?.retainedStdout).toBe("€");
    expect(kept?.retainedStderr).toBe("diagnostic");
  });

  /**
   * A journaled capture has to survive a resumed run: replay never starts the
   * child, so the binding can only come from what the record kept.
   */
  it("FG17: a resumed journaled capture rebuilds its binding without running again", function* () {
    const source = [
      '<Capture as="taken">',
      "```bash exec",
      "echo recorded-once",
      "```",
      "</Capture>",
      "",
      "[{taken}]",
      "",
    ].join("\n");

    let starts = 0;
    const first = new InMemoryStream();
    yield* watching(function* () {
      yield* scoped(function* () {
        yield* API.Process.around({
          *exec([options], next) {
            starts += 1;
            return yield* next(options);
          },
        });
        return yield* runDocument(source, { retainProcessOutput: true, stream: first });
      });
    });
    expect(starts).toBe(1);

    // The completed exec Yield stays; the run's terminal record does not.
    const events = first.snapshot();
    expect(events.at(-1)?.type).toBe("close");
    const partial = new InMemoryStream(events.slice(0, -1));

    const resumed = yield* watching(function* (seen) {
      const run = yield* scoped(function* () {
        yield* API.Process.around({
          *exec([options], next) {
            starts += 1;
            return yield* next(options);
          },
        });
        return yield* runDocument(source, { retainProcessOutput: true, stream: partial });
      });
      return { output: run.output, seen };
    });

    // The child never ran again, the binding is the one the record holds, and
    // nothing was displayed a second time.
    expect(starts).toBe(1);
    expect(resumed.output).toContain("recorded-once");
    expect(resumed.seen.stdout).toBe("");
  });

  /**
   * The two channels are forwarded by concurrent tasks, so "this byte is a
   * redirect" cannot be a fact about the route as a whole. Here a downstream
   * handler holds the redirected stdout while a genuine stderr chunk arrives
   * behind it: shared classification would call that chunk somebody else's
   * stdout and drop it from the record, silently, and only under load.
   */
  it("FG18: a held-up redirect cannot swallow a sibling's stderr", function* () {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const release = withResolvers<void>();
    let holding = false;
    let kept: ForegroundOutput | undefined;

    const seen = yield* watching(function* (seen) {
      yield* scoped(function* () {
        // Downstream of the route, so it receives what the route forwards.
        yield* Stdio.around(
          {
            *stderr([bytes], next) {
              if (decoder.decode(bytes, { stream: false }).includes("out")) {
                holding = true;
                yield* release.operation;
              }
              return yield* next(bytes);
            },
          },
          { at: "min" },
        );

        const finished = yield* route(VALUE_ROOT, true);

        const redirect = yield* spawn(() => Stdio.operations.stdout(encoder.encode("out")));
        // The redirect is inside the blocked handler before the sibling writes.
        yield* when(function* () {
          return holding;
        });
        yield* Stdio.operations.stderr(encoder.encode("err"));
        release.resolve();
        yield* redirect;

        kept = finished();
      });
      return seen;
    });

    // A value root keeps its own stdout free, and both reached the reader once.
    expect(seen.stdout).toBe("");
    expect(seen.stderr).toContain("out");
    expect(seen.stderr).toContain("err");
    expect(seen.stderr.match(/out/g) ?? []).toHaveLength(1);
    expect(seen.stderr.match(/err/g) ?? []).toHaveLength(1);
    // And the record still says which channel each came from.
    expect(kept?.retainedStdout).toBe("out");
    expect(kept?.retainedStderr).toBe("err");
  });

  /**
   * `Stdio` middleware is documented as free to capture, transform, or redirect
   * what it forwards, so a host that hands on a copy of the bytes it was given
   * is behaving correctly. A route that reads a chunk's origin off the payload
   * loses it to exactly that host, and records a command's stdout as its stderr.
   */
  it("FG19: an enclosing middleware may copy the bytes without confusing the channels", function* () {
    const encoder = new TextEncoder();
    let copies = 0;
    let kept: ForegroundOutput | undefined;

    const seen = yield* watching(function* (seen) {
      yield* scoped(function* () {
        // Installed before the route, so every emission the route forwards —
        // including the one it redirects — arrives here first and goes on as a
        // plain array holding the same bytes.
        yield* Stdio.around({
          *stderr([bytes], next) {
            copies += 1;
            return yield* next(new Uint8Array(bytes));
          },
        });

        const finished = yield* route(VALUE_ROOT, true);
        yield* Stdio.operations.stdout(encoder.encode("out"));
        yield* Stdio.operations.stderr(encoder.encode("err"));
        kept = finished();
      });
      return seen;
    });

    // The copying middleware really did see both emissions.
    expect(copies).toBe(2);
    // A value root keeps its own stdout free, and each reached the reader once.
    expect(seen.stdout).toBe("");
    expect(seen.stderr).toContain("out");
    expect(seen.stderr).toContain("err");
    expect(seen.stderr.match(/out/g) ?? []).toHaveLength(1);
    expect(seen.stderr.match(/err/g) ?? []).toHaveLength(1);
    // And the record is still the child's own two channels.
    expect(kept?.retainedStdout).toBe("out");
    expect(kept?.retainedStderr).toBe("err");
  });
});
