/**
 * Tier FG — foreground execution, capture, and retention (spec §3.6, #441).
 *
 * These run real children, because what is under test is what a command's
 * output does on its way to a reader. Nothing waits on a duration: a command
 * that must still be running holds itself open until the case releases it, so
 * "the first chunk arrived before the child exited" is a fact rather than a
 * race.
 *
 * "Exactly" always means exactly what reached the per-exec boundary. Middleware
 * enclosing an execution is trusted preprocessing and may transform, redact,
 * redirect or consume a channel first; what a run captures, journals and
 * reports is what that leaves. What a child wrote to its pipe is not observed
 * by anything here, and no case claims it: where a case installs no enclosing
 * handler, what the boundary receives is what the command emitted, and that is
 * all such a case asserts.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
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
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { useStubFs } from "@executablemd/runtime/test";
import { FOREGROUND, route } from "../src/foreground.ts";
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

  it("FG4: a run that keeps a record keeps exactly what the boundary received", function* () {
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
  it("FG9: the per-exec wrapper is already active while the child is being acquired", function* () {
    const encoder = new TextEncoder();
    const source = ["```bash exec", "echo after-acquisition", "```", ""].join("\n");

    const run = yield* watching(function* (seen) {
      // The seam: an emission that reaches the chain while the process is
      // still being acquired. A wrapper installed after `Process.exec` returns
      // would miss exactly these, and only sometimes.
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
   * A channel is the operation this boundary receives bytes on. Nothing below
   * it hands one channel's bytes to the other channel's operation, so a
   * downstream policy may show them wherever it likes without the record having
   * to reconstruct an origin it never lost. What an enclosing handler did
   * before the boundary is a different question, and FG26 asks it.
   */
  it("FG13: each channel is forwarded and recorded on the channel it was received on", function* () {
    const encoder = new TextEncoder();
    let kept: ForegroundOutput | undefined;

    const seen = yield* watching(function* (seen) {
      yield* scoped(function* () {
        const finished = yield* route(FOREGROUND, true);
        yield* Stdio.operations.stdout(encoder.encode("from-stdout\n"));
        yield* Stdio.operations.stderr(encoder.encode("from-stderr\n"));
        kept = finished();
      });
      return seen;
    });

    // Displayed on its own channel; which stream that is belongs to the host.
    expect(seen.stdout).toBe("from-stdout\n");
    expect(seen.stderr).toBe("from-stderr\n");
    // And recorded on the operation each was received on.
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
   * The two channels are forwarded by concurrent tasks, so what a route knows
   * about one emission can never be a fact it holds for the run. Here a
   * downstream handler holds a stdout chunk while a genuine stderr chunk
   * arrives behind it: any classification shared between the channels would
   * describe the held chunk while recording the other, silently, and only
   * under load.
   */
  it("FG18: a held-up chunk cannot take the other channel's bytes with it", function* () {
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
            *stdout([bytes], next) {
              if (decoder.decode(bytes, { stream: false }).includes("out")) {
                holding = true;
                yield* release.operation;
              }
              return yield* next(bytes);
            },
          },
          { at: "min" },
        );

        const finished = yield* route(FOREGROUND, true);

        const held = yield* spawn(() => Stdio.operations.stdout(encoder.encode("out")));
        // The stdout chunk is inside the blocked handler before stderr is written.
        yield* when(function* () {
          return holding;
        });
        yield* Stdio.operations.stderr(encoder.encode("err"));
        release.resolve();
        yield* held;

        kept = finished();
      });
      return seen;
    });

    // Each reached the reader once, on its own channel.
    expect(seen.stdout).toBe("out");
    expect(seen.stderr).toBe("err");
    // And the record names the channel each was received on.
    expect(kept?.retainedStdout).toBe("out");
    expect(kept?.retainedStderr).toBe("err");
  });

  /**
   * `Stdio` middleware is documented as free to capture, transform, or redirect
   * what it forwards, and an enclosing handler doing so is the host exercising
   * authority over its own child processes. What it forwards is what the run
   * has: the boundary keeps the transformed text, not the bytes behind it.
   */
  it("FG19: transformed bytes an enclosing middleware forwards are what is retained", function* () {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let transformed = 0;
    let kept: ForegroundOutput | undefined;

    const seen = yield* watching(function* (seen) {
      yield* scoped(function* () {
        // Upstream of the boundary, so this is what the run ever sees.
        yield* Stdio.around({
          *stdout([bytes], next) {
            transformed += 1;
            const text = decoder.decode(bytes, { stream: false }).toUpperCase();
            return yield* next(encoder.encode(text));
          },
        });

        const finished = yield* route(FOREGROUND, true);
        yield* Stdio.operations.stdout(encoder.encode("out"));
        yield* Stdio.operations.stderr(encoder.encode("err"));
        kept = finished();
      });
      return seen;
    });

    // The transforming middleware really did run.
    expect(transformed).toBe(1);
    // What it forwarded is what was displayed and what was kept.
    expect(seen.stdout).toBe("OUT");
    expect(seen.stderr).toBe("err");
    expect(kept?.retainedStdout).toBe("OUT");
    expect(kept?.retainedStderr).toBe("err");
  });

  /**
   * Where authority sits, in both directions, in one case.
   *
   * A handler enclosing an execution is trusted preprocessing: what it forwards
   * is what the run has. A handler below the boundary is this document's
   * display policy — `silent`, a capture region, a value root's stream choice
   * are all of this kind — and it decides what a reader sees and nothing else.
   * Reversing either half is the defect this holds shut.
   */
  it("FG23: what is retained is set upstream of the boundary and is untouchable below it", function* () {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let above = 0;
    let below = 0;

    const upstream = yield* scoped(function* () {
      // Above: rewrites stdout, and the run keeps the rewrite.
      yield* Stdio.around({
        *stdout([bytes], next) {
          above += 1;
          void decoder.decode(bytes, { stream: false });
          return yield* next(encoder.encode("rewritten"));
        },
      });
      const finished = yield* route(FOREGROUND, true);
      yield* Stdio.operations.stdout(encoder.encode("original"));
      yield* Stdio.operations.stderr(encoder.encode("err"));
      return finished();
    });

    const downstream = yield* scoped(function* () {
      const finished = yield* route(FOREGROUND, true);
      // Below: consumes stdout entirely and rewrites stderr. Nothing reaches a
      // reader, and the record is exactly what the boundary received.
      yield* Stdio.around(
        {
          *stdout() {
            below += 1;
          },
          *stderr([bytes], next) {
            below += 1;
            void bytes;
            return yield* next(encoder.encode("swapped"));
          },
        },
        { at: "min" },
      );
      yield* Stdio.operations.stdout(encoder.encode("original"));
      yield* Stdio.operations.stderr(encoder.encode("err"));
      return finished();
    });

    // Both handlers really ran.
    expect(above).toBe(1);
    expect(below).toBe(2);
    // The one above decided the record.
    expect(upstream.retainedStdout).toBe("rewritten");
    expect(upstream.retainedStderr).toBe("err");
    // The one below decided nothing about it.
    expect(downstream.retainedStdout).toBe("original");
    expect(downstream.retainedStderr).toBe("err");
  });

  /**
   * A host that redacts a command's output upstream has decided what the run
   * knows. The safe text is what is displayed, bound, journaled and replayed;
   * the original is nowhere, including in the record a resume reads back.
   */
  it("FG24: a redaction upstream of the boundary is what is captured, journaled and replayed", function* () {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const source = [
      '<Capture as="taken">',
      "```bash exec",
      "echo account-1234-5678",
      "```",
      "</Capture>",
      "",
      "[{taken}]",
      "",
    ].join("\n");

    function* redacting(): Operation<void> {
      yield* Stdio.around({
        *stdout([bytes], next) {
          const text = decoder.decode(bytes, { stream: false });
          return yield* next(encoder.encode(text.replace(/account-[\d-]+/g, "account-REDACTED")));
        },
      });
    }

    let starts = 0;
    const first = new InMemoryStream();
    const live = yield* watching(function* (seen) {
      const run = yield* scoped(function* () {
        yield* redacting();
        yield* API.Process.around({
          *exec([options], next) {
            starts += 1;
            return yield* next(options);
          },
        });
        return yield* runDocument(source, { retainProcessOutput: true, stream: first });
      });
      return { output: run.output, seen };
    });

    expect(starts).toBe(1);
    // Bound and displayed as the redaction, which is what the boundary
    // received — never as what the command emitted behind it.
    expect(live.output).toContain("account-REDACTED");
    expect(live.output).not.toContain("1234-5678");
    expect(live.seen.stdout).not.toContain("1234-5678");
    // And journaled the same way.
    const kept = execOutcome(first);
    expect(kept?.stdout).toBe("account-REDACTED\n");
    // The document names the command, so the record holds that; what it must
    // not hold is what the command printed.
    expect(JSON.stringify(kept)).not.toContain("1234-5678");

    // A resumed run reads the record rather than the child.
    const events = first.snapshot();
    expect(events.at(-1)?.type).toBe("close");
    const partial = new InMemoryStream(events.slice(0, -1));
    const resumed = yield* scoped(function* () {
      yield* API.Process.around({
        *exec([options], next) {
          starts += 1;
          return yield* next(options);
        },
      });
      return yield* runDocument(source, { retainProcessOutput: true, stream: partial });
    });

    expect(starts).toBe(1);
    expect(resumed.output).toContain("account-REDACTED");
    expect(resumed.output).not.toContain("1234-5678");
  });

  /**
   * Consumption is the strongest form of the same authority: an enclosing
   * handler that forwards nothing has decided the run saw nothing. The exit
   * status does not travel through the stdio chain and is unaffected, and the
   * channel the handler left alone arrives as the command emitted it.
   */
  it("FG25: stdout consumed upstream of the boundary is displayed and retained nowhere", function* () {
    const source = ["```bash exec", "echo swallowed; echo kept >&2", "```", ""].join("\n");

    let consumed = 0;
    const run = yield* watching(function* (seen) {
      const result = yield* scoped(function* () {
        yield* Stdio.around({
          *stdout() {
            consumed += 1;
          },
        });
        return yield* runDocument(source, { retainProcessOutput: true });
      });
      return { seen, stream: result.stream };
    });
    const kept = execOutcome(run.stream);

    expect(consumed).toBeGreaterThan(0);
    // Nothing displayed, nothing retained, and no trace in the record.
    expect(run.seen.stdout).toBe("");
    expect(kept?.stdout).toBe("");
    expect(JSON.stringify(kept)).not.toContain("swallowed");
    // The status never passes through the chain, and the untouched channel
    // reaches the boundary as the command emitted it.
    expect(kept?.exitCode).toBe(0);
    expect(kept?.stderr).toBe("kept\n");
  });

  /**
   * An enclosing handler that forwards stdout on stderr has reclassified it,
   * and the record says stderr — that is what "the channel it was received on"
   * means. Only the totals are asserted: two channels forwarded concurrently
   * arrive in whatever order they arrive.
   */
  it("FG26: an upstream redirect reclassifies the channel the run records", function* () {
    const encoder = new TextEncoder();
    let redirects = 0;
    let kept: ForegroundOutput | undefined;

    const seen = yield* watching(function* (seen) {
      yield* scoped(function* () {
        yield* Stdio.around({
          *stdout([bytes]) {
            redirects += 1;
            return yield* Stdio.operations.stderr(bytes);
          },
        });

        const finished = yield* route(FOREGROUND, true);
        yield* Stdio.operations.stdout(encoder.encode("out"));
        yield* Stdio.operations.stderr(encoder.encode("err"));
        kept = finished();
      });
      return seen;
    });

    expect(redirects).toBe(1);
    // Nothing arrived on stdout, so nothing is recorded there.
    expect(kept?.retainedStdout).toBe("");
    expect(seen.stdout).toBe("");
    // Both texts arrived on stderr, and both are recorded there.
    expect(kept?.retainedStderr).toContain("out");
    expect(kept?.retainedStderr).toContain("err");
    expect(kept?.retainedStderr?.length).toBe("outerr".length);
    expect(seen.stderr).toContain("out");
    expect(seen.stderr).toContain("err");
  });
});

/**
 * Tier FG — a command whose failure is an answer (spec §3.6, #447).
 *
 * `exec as="name"` binds what the process settled to, so these cases ask the
 * three questions that separates a binding from every other use of the same
 * bytes: what the document reads, what a reader is shown, and what the run
 * keeps. A binding is none of the other two — it never displays a channel and
 * never adds one to a record the host did not ask for.
 */
describe("Tier FG — bound command results", () => {
  beforeAll(() => useTempFileCompiler());

  /** How many children a run started, whatever else the case installs. */
  function* counting(starts: { count: number }): Operation<void> {
    yield* API.Process.around({
      *exec([options], next) {
        starts.count += 1;
        return yield* next(options);
      },
    });
  }

  it("FG27: a nonzero command binds its outcome, shows nothing, and the run goes on", function* () {
    const source = [
      '```bash exec as="probe"',
      "printf out; printf err >&2; exit 7",
      "```",
      "",
      "```js eval",
      "output(`code=${probe.exitCode} out=${probe.stdout} err=${probe.stderr}`);",
      "```",
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

    // The document decided what the nonzero status meant, and kept going.
    expect(run.output).toContain("code=7 out=out err=err");
    // Neither channel was displayed, and the block rendered nothing itself.
    expect(run.seen.stdout).not.toContain("out");
    expect(run.seen.stderr).not.toContain("err");
    expect(run.output).not.toContain("Command failed");
    // The block after it is an ordinary foreground block again.
    expect(run.seen.stdout).toContain("after");
    // And a binding is not a retention decision: this run keeps the status
    // alone, exactly as it would have without one.
    const outcome = execOutcome(run.stream);
    expect(outcome?.exitCode).toBe(7);
    expect(outcome?.stdout).toBe(undefined);
    expect(outcome?.stderr).toBe(undefined);
  });

  it("FG28: a resumed retained run rebuilds the same binding without running again", function* () {
    const source = [
      '```bash exec as="probe"',
      "printf recorded-out; printf recorded-err >&2; exit 3",
      "```",
      "",
      "[{probe.exitCode}|{probe.stdout}|{probe.stderr}]",
      "",
    ].join("\n");

    const starts = { count: 0 };
    const first = new InMemoryStream();
    const live = yield* watching(function* () {
      return yield* scoped(function* () {
        yield* counting(starts);
        return yield* runDocument(source, { retainProcessOutput: true, stream: first });
      });
    });

    expect(starts.count).toBe(1);
    expect(live.output).toContain("[3|recorded-out|recorded-err]");
    // The record holds both channels, because this host asked for a record.
    const kept = execOutcome(first);
    expect(kept?.stdout).toBe("recorded-out");
    expect(kept?.stderr).toBe("recorded-err");

    const events = first.snapshot();
    expect(events.at(-1)?.type).toBe("close");
    const partial = new InMemoryStream(events.slice(0, -1));

    const resumed = yield* watching(function* (seen) {
      const run = yield* scoped(function* () {
        yield* counting(starts);
        return yield* runDocument(source, { retainProcessOutput: true, stream: partial });
      });
      return { output: run.output, seen };
    });

    // Same fields, from the record; no second child, and nothing displayed.
    expect(starts.count).toBe(1);
    expect(resumed.output).toContain("[3|recorded-out|recorded-err]");
    expect(resumed.seen.stdout).toBe("");
    expect(resumed.seen.stderr).toBe("");
  });

  it("FG29: a command that cannot start fails and binds nothing", function* () {
    const source = ['```bash exec as="probe"', "true", "```", "", "[{probe.exitCode}]", ""].join(
      "\n",
    );

    const run = yield* watching(function* () {
      return yield* scoped(function* () {
        yield* API.Process.around({
          // deno-lint-ignore require-yield
          *exec() {
            throw new Error("no such executable");
          },
        });
        return yield* runDocument(source, { retainProcessOutput: false });
      });
    });

    // The failure is the block's, decided by the region's error mode as any
    // other is — and the reference below it never resolved, because nothing
    // was bound.
    expect(run.output).toContain("no such executable");
    expect(run.output).toContain("{probe.exitCode}");
  });

  it("FG30: a timeout stays a failure and binds nothing", function* () {
    const dir = yield* useDirectory();
    const source = [
      '```bash timeout=25ms exec as="probe"',
      `sleep 5; touch ${path.join(dir, "finished")}`,
      "```",
      "",
      "[{probe.exitCode}]",
      "",
    ].join("\n");

    const run = yield* watching(() => runDocument(source, { retainProcessOutput: false }));

    // A timeout wins as a failure, so the command has no settled status to
    // bind: the reference below it stands unresolved.
    expect(run.output).toContain("timed out after 25ms");
    expect(run.output).toContain("{probe.exitCode}");
    expect(yield* exists(path.join(dir, "finished"))).toBe(false);
  });

  it("FG31: a refused annotation or modifier starts no process", function* () {
    const refused = [
      ['```bash silent exec as="probe"', "only the built-in `timeout` modifier"],
      ['```js eval as="probe"', "supported only with the `exec` terminal"],
      ["```bash exec as=probe", "double quotes"],
      ['```bash exec as="probe" as="other"', "not several"],
      ['```bash exec as="probe" silent', "must be the last word"],
      ['```bash exec as="1nope"', "valid JavaScript identifier"],
    ];

    for (const [fence, expected] of refused) {
      const starts = { count: 0 };
      const source = [fence!, "echo ran", "```", ""].join("\n");
      const run = yield* watching(function* () {
        return yield* scoped(function* () {
          yield* counting(starts);
          return yield* runDocument(source, { retainProcessOutput: false });
        });
      });

      expect(run.output).toContain(expected!);
      expect(starts.count).toBe(0);
    }
  });
});
