/**
 * What retaining a REPL entry's file work costs, measured rather than asserted.
 *
 * Three columns, over the same authored document and the same seeded layout:
 *
 * - **ordinary** — what `xmd run` assembles for file work: the host filesystem
 *   provider and this package's component declarations, and nothing else.
 * - **entry** — the same, plus the executing entry's repository host. Every
 *   mutation inside the checkout is recorded, and the timing includes the host's
 *   assembly and its first lazy acquisitions, because a person waiting for the
 *   first write waits for those too.
 * - **continuation** — the same document again, over the journal the entry
 *   column wrote, with the root close removed. Every operation is complete, so
 *   this is the cost of answering from records rather than performing.
 *
 * The comparison is only fair if the work is identical, so each sample gets its
 * own independently seeded checkout, prepared outside every timed region, and
 * both live modes expand the same document in the same relative layout. There
 * is no terminal here and nobody waits for a question: painting a screen and
 * waiting for a person are not what this measures.
 *
 * It states no budget and no pass/fail ratio. What it produces is raw samples,
 * medians and counters for a reviewer to read.
 */

import { main, scoped, until } from "effection";
import type { Operation } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { API } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { hostFilesHandler } from "@executablemd/runtime";
import { collect } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { useCompositionComponents } from "../packages/git/src/composition/installation.ts";
import { Execution } from "@executablemd/core/api";
import { useReplRepositoryRecording } from "../packages/git/src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../packages/git/src/retained-repository/admission.ts";
import { denoRepositoryHost } from "../packages/git/src/deno/composition/host.ts";
import { commonDirectoryLock } from "../packages/git/src/deno/run-composition/placement.ts";
import {
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
} from "../packages/git/src/retained-repository/records.ts";

/** What one invocation was asked to measure. */
interface Settings {
  readonly samples: number;
  readonly operations: number;
  readonly payloadBytes: number;
  /**
   * How much unrelated content the checkout holds, per comparison.
   *
   * One whole comparison per size, so the two are read beside each other: a
   * cost that grew with content the document never named would be a cost of
   * looking at the checkout, and these columns are what would show it.
   */
  readonly unrelatedFiles: readonly number[];
}

function settings(argv: readonly string[]): Settings {
  const read = (name: string, fallback: number): number => {
    const found = argv.find((entry) => entry.startsWith(`--${name}=`));
    if (found === undefined) {
      return fallback;
    }
    const value = Number(found.slice(`--${name}=`.length));
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`--${name} takes a positive whole number, and was given ${found}`);
    }
    return value;
  };
  const operations = read("operations", 40);
  if (operations % 4 !== 0) {
    throw new Error(
      `--operations is split equally between directory ensures, reads, writes and deletions, ` +
        `so it takes a multiple of four; ${operations} is not one`,
    );
  }
  const sizes = argv.find((entry) => entry.startsWith("--unrelated-files="));
  const unrelatedFiles =
    sizes === undefined
      ? [0]
      : sizes
          .slice("--unrelated-files=".length)
          .split(",")
          .map((entry) => {
            const value = Number(entry);
            if (!Number.isSafeInteger(value) || value < 0) {
              throw new Error(`--unrelated-files takes whole counts, and was given ${entry}`);
            }
            return value;
          });
  return {
    samples: read("samples", 5),
    operations,
    payloadBytes: read("payload-bytes", 1024),
    unrelatedFiles,
  };
}

/** What the composition beneath was actually asked to do. */
interface Counters {
  reads: number;
  writes: number;
  deletes: number;
  ensures: number;
  /** Pure path admissibility checks, which touch no file. */
  checks: number;
  /** Searches of the tree, which are the only traversal a document can ask for. */
  globs: number;
  /** Every `git` this entry's session ran, which is what discovery costs. */
  commands: number;
  /** Journaled records of this feature's own types, which are its appends. */
  records: number;
  /** The UTF-8 size of the whole journal this run produced. */
  journalBytes: number;
  /** Whether the entry took the checkout's lease during this run. */
  lease: number;
}

function counters(): Counters {
  return {
    reads: 0,
    writes: 0,
    deletes: 0,
    ensures: 0,
    checks: 0,
    globs: 0,
    commands: 0,
    records: 0,
    journalBytes: 0,
    lease: 0,
  };
}

function countingFiles(counted: Counters): FilesHandler {
  const host = hostFilesHandler();
  return {
    *checkFilePath(input: FilePathInput) {
      counted.checks += 1;
      return yield* host.checkFilePath(input);
    },
    *readTextFile(input: FilePathInput) {
      counted.reads += 1;
      return yield* host.readTextFile(input);
    },
    *globFiles(input: Parameters<FilesHandler["globFiles"]>[0]) {
      counted.globs += 1;
      return yield* host.globFiles(input);
    },
    temporaryDirectory: () => host.temporaryDirectory(),
    *writeTextFile(input: FileWriteInput) {
      counted.writes += 1;
      return yield* host.writeTextFile(input);
    },
    *deleteFile(input: FilePathInput) {
      counted.deletes += 1;
      return yield* host.deleteFile(input);
    },
    *ensureDirectory(input: FilePathInput) {
      counted.ensures += 1;
      return yield* host.ensureDirectory(input);
    },
  };
}

function countingHost(counted: Counters) {
  const host = denoRepositoryHost();
  return {
    git(invocation: Parameters<typeof host.git>[0]) {
      counted.commands += 1;
      return host.git(invocation);
    },
    useDirectory: () => host.useDirectory(),
  };
}

/**
 * The document both live modes expand.
 *
 * One `<Dir>` per quarter of the operations, each holding one read of a file the
 * fixture preseeded, one exact-size write and one deletion, so the four kinds
 * happen in one order and one relative layout whichever mode is running. The
 * read comes before the deletion because it reads the file the deletion
 * removes: a read of an absent file is a refusal, and a refusal is a different
 * measurement.
 */
function document(chosen: Settings): string {
  const each = chosen.operations / 4;
  const payload = "x".repeat(chosen.payloadBytes);
  const lines: string[] = [];
  for (let index = 0; index < each; index += 1) {
    lines.push(`<Dir path="part-${index}">`);
    lines.push(`<File path="preseeded.md" as="held_${index}" />`);
    lines.push(`<File path="written.md">${payload}</File>`);
    lines.push(`<File.Delete path="preseeded.md" />`);
    lines.push("</Dir>");
  }
  return lines.join("\n");
}

/** One checkout, seeded identically for every sample and every mode. */
function* seed(chosen: Settings, unrelated: number): Operation<string> {
  const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "xmd-bench-")))));
  const checkout = join(root, "checkout");
  yield* until(mkdir(checkout, { recursive: true }));
  yield* run("git", ["init", "-b", "main", checkout], root);
  const each = chosen.operations / 4;
  for (let index = 0; index < each; index += 1) {
    const part = join(checkout, `part-${index}`);
    yield* until(mkdir(part, { recursive: true }));
    yield* writeTextFile(join(part, "preseeded.md"), "preseeded\n");
  }
  // Content the document never names, in a subtree it never enters. What it is
  // here to show is whether a cost grows with the size of the checkout.
  if (unrelated > 0) {
    const elsewhere = join(checkout, "unrelated");
    yield* until(mkdir(elsewhere, { recursive: true }));
    const payload = "u".repeat(chosen.payloadBytes);
    for (let index = 0; index < unrelated; index += 1) {
      yield* writeTextFile(join(elsewhere, `file-${index}.md`), payload);
    }
  }
  return checkout;
}

function run(command: string, args: readonly string[], cwd: string): Operation<void> {
  return until(
    new Promise<void>((resolve, reject) => {
      execFile(command, [...args], { cwd }, (error) =>
        error === null ? resolve() : reject(error),
      );
    }),
  );
}

/** One measured run: how long it took, and what it really did. */
interface Measured {
  readonly ms: number;
  readonly counted: Counters;
  readonly events: readonly DurableEvent[];
}

/** Expand the document once, in the mode named, and measure it. */
function measure(
  mode: "ordinary" | "entry" | "continuation",
  checkout: string,
  source: string,
  retained: readonly DurableEvent[] = [],
): Operation<Measured> {
  return scoped(function* (): Operation<Measured> {
    const counted = counters();
    const stream = new InMemoryStream([...retained]);
    const path = join(checkout, "entry.md");
    yield* writeTextFile(path, source);
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return checkout;
        },
      },
      { at: "min" },
    );
    const files = countingFiles(counted);
    yield* API.Files.around(
      {
        checkFilePath: ([input]) => files.checkFilePath(input),
        readTextFile: ([input]) => files.readTextFile(input),
        globFiles: ([input]) => files.globFiles(input),
        temporaryDirectory: () => files.temporaryDirectory(),
        writeTextFile: ([input]) => files.writeTextFile(input),
        deleteFile: ([input]) => files.deleteFile(input),
        ensureDirectory: ([input]) => files.ensureDirectory(input),
      },
      { at: "min" },
    );
    yield* useCompositionComponents();

    const lock = commonDirectoryLock(yield* until(realpath(join(checkout, ".git"))));
    const before = yield* exists(lock);

    // Timed from here, so the entry setup and its first lazy acquisitions are
    // inside the measurement rather than beside it.
    const started = performance.now();
    if (mode === "ordinary") {
      yield* collect(yield* executeInstalled({ path, stream }, []));
    } else {
      // Registered the way the REPL host registers it: core initialization is
      // what establishes the recording, which is why the registration is inside
      // the timed region along with the first lazy acquisitions it leads to.
      yield* Execution.around({
        *init(_args, next): Operation<void> {
          yield* useReplRepositoryRecording({ host: countingHost(counted) });
          yield* next();
        },
      });
      yield* collect(
        yield* executeInstalled({ path, stream }, [
          { admissions: [(retained) => admitReplRepositoryHistory(retained)] },
        ]),
      );
    }
    const ms = performance.now() - started;

    if (!before && (yield* exists(lock))) {
      counted.lease = 1;
    }
    const events = yield* stream.readAll();
    counted.journalBytes = new TextEncoder().encode(JSON.stringify(events)).length;
    counted.records = events.filter(
      (event) =>
        event.type === "yield" &&
        (event.description.type === REPL_REPOSITORY_LOCAL ||
          event.description.type === REPL_REPOSITORY_SELECTION),
    ).length;
    return { ms, counted, events };
  });
}

/** Everything before the root close, which is what a continuation reopens. */
function unfinished(events: readonly DurableEvent[]): readonly DurableEvent[] {
  return events.filter((event) => event.type !== "close");
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function report(name: string, samples: readonly Measured[]): void {
  const times = samples.map((sample) => sample.ms);
  const counted = samples[0]?.counted ?? counters();
  console.log(
    `${name.padEnd(13)} median ${median(times).toFixed(1).padStart(8)}ms  ` +
      `range ${Math.min(...times).toFixed(1)}–${Math.max(...times).toFixed(1)}ms`,
  );
  console.log(`${"".padEnd(13)} raw ${times.map((value) => value.toFixed(1)).join(", ")}`);
  console.log(
    `${"".padEnd(13)} reads ${counted.reads}  writes ${counted.writes}  ` +
      `deletes ${counted.deletes}  ensures ${counted.ensures}  checks ${counted.checks}  ` +
      `globs ${counted.globs}`,
  );
  console.log(
    `${"".padEnd(13)} git ${counted.commands}  lease ${counted.lease}  ` +
      `records ${counted.records}  journal ${counted.journalBytes} bytes`,
  );
}

await main(function* (argv): Operation<void> {
  const chosen = settings(argv);
  const source = document(chosen);

  console.log("# A REPL entry's file work, measured");
  console.log("");
  console.log(`samples ${chosen.samples}`);
  const each = chosen.operations / 4;
  console.log(
    `operations ${chosen.operations} per sample ` +
      `(${each} directory ensures, ${each} reads of preseeded files, ${each} writes of exactly ` +
      `${chosen.payloadBytes} bytes, ${each} deletions of those preseeded files)`,
  );
  console.log(`unrelated checkout content ${chosen.unrelatedFiles.join(", ")} files`);
  console.log(`deno ${Deno.version.deno}  v8 ${Deno.version.v8}`);
  console.log(`host ${process.platform} ${process.arch}`);

  for (const unrelated of chosen.unrelatedFiles) {
    console.log("");
    console.log(
      `## ${unrelated} unrelated ${chosen.payloadBytes}-byte files under an untouched subtree`,
    );
    console.log("");

    // One unreported warmup per live mode, so neither column is charged for the
    // module graph the other one already paid for.
    for (const mode of ["ordinary", "entry"] as const) {
      const checkout = yield* seed(chosen, unrelated);
      yield* measure(mode, checkout, source);
      yield* rm(join(checkout, ".."), { recursive: true, force: true });
    }

    const ordinary: Measured[] = [];
    const entry: Measured[] = [];
    const continuation: Measured[] = [];

    for (let sample = 0; sample < chosen.samples; sample += 1) {
      // Alternated, so a drift in the machine across the run does not land on
      // one column.
      const order =
        sample % 2 === 0 ? (["ordinary", "entry"] as const) : (["entry", "ordinary"] as const);
      for (const mode of order) {
        const checkout = yield* seed(chosen, unrelated);
        const measured = yield* measure(mode, checkout, source);
        (mode === "ordinary" ? ordinary : entry).push(measured);
        if (mode === "entry") {
          // The continuation runs against the journal that entry just wrote, in
          // the checkout it wrote it in, with the lease sidecar removed so a
          // second acquisition would be visible. Nothing holds it: the live run
          // has ended.
          const lock = commonDirectoryLock(yield* until(realpath(join(checkout, ".git"))));
          yield* rm(lock, { force: true });
          continuation.push(
            yield* measure("continuation", checkout, source, unfinished(measured.events)),
          );
        }
        yield* rm(join(checkout, ".."), { recursive: true, force: true });
      }
    }

    report("ordinary", ordinary);
    console.log("");
    report("entry", entry);
    console.log("");
    report("continuation", continuation);
  }
  console.log("");
  console.log(
    "A continuation performs no read, no mutation, no traversal, runs no `git` and takes no " +
      "lease, which is what the zeroes above say. This states no budget and no ratio: it is raw " +
      "evidence for a reviewer.",
  );
});
