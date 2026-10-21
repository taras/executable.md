/**
 * What retaining a REPL entry's file work costs, measured rather than asserted.
 *
 * Three columns, over the same authored document and the same seeded layout:
 *
 * - **ordinary** — what `xmd run` initializes: the host filesystem provider,
 *   this package's component declarations and the ordinary repository
 *   composition an ordinary run establishes through `Execution.init`.
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
 *
 * ## What the counters are, and what they are not
 *
 * The document filesystem calls, the `git` invocations and the lock descriptors
 * are observed at the boundaries this harness owns: middleware on `API.Files`,
 * a counting repository host, and a wrapper around the one native function the
 * advisory lock opens its descriptor with. Those are actual calls, not
 * inferences — in particular the lease column counts descriptors this run
 * opened on a sidecar, with the sidecar left exactly where it is, because a
 * sidecar is persistent and its presence says nothing about who took it.
 *
 * `globs` counts the contextual `globFiles` calls a document made. It is *not*
 * comprehensive traversal instrumentation: this harness does not observe
 * `node:fs` directly, so it cannot say that nothing walked the tree by another
 * route. Two columns with similar elapsed times are likewise not proof that
 * neither traversed anything. What the content-size pair does say is that these
 * observed counts and these times did not change when the checkout grew.
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
import { ensure, resource } from "effection";
import { fileURLToPath } from "node:url";
import { useCompositionComponents } from "../packages/git/src/composition/installation.ts";
import { useRunComposition } from "../packages/git/src/deno/run-composition/provider.ts";
import type { HelperAssembly } from "../packages/git/src/deno/composition/credential-helper.ts";
import { Execution } from "@executablemd/core/api";
import { useReplRepositoryRecording } from "../packages/cli/src/repl/repositories/deno/provider.ts";
import { admitReplRepositoryHistory } from "../packages/cli/src/repl/repositories/admission.ts";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import {
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
} from "../packages/cli/src/repl/repositories/records.ts";

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
  /** Lock descriptors this run opened on a common-directory sidecar. */
  lease: number;
  /** Every durable event this run appended, engine events included. */
  appends: number;
  /** Of those, the ones that are this feature's own local results. */
  localAppends: number;
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
    appends: 0,
    localAppends: 0,
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

/**
 * The platform's own repository work, with the one call this benchmark counts.
 *
 * `ambientCheckout` is what a live file operation asks before it knows whether
 * it is inside a checkout, and counting it is the measurement: a replayed
 * operation asks nothing. Every other method delegates untouched, and no
 * session, attachment or credential crosses this wrapper.
 */
function countingOperations(counted: Counters): () => Operation<DenoRepositoryOperations> {
  return function* (): Operation<DenoRepositoryOperations> {
    const operations = yield* useDenoRepositoryOperations();
    return {
      ...operations,
      *ambientCheckout(from: string) {
        counted.commands += 1;
        return yield* operations.ambientCheckout(from);
      },
    };
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

/** One checkout and managed root, seeded identically for every sample and mode. */
function* seed(
  chosen: Settings,
  unrelated: number,
): Operation<{ readonly checkout: string; readonly managed: string }> {
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
  // Where an ordinary run would keep a managed repository, inside this
  // invocation's own fixture: nothing here selects one, and a root under the
  // real home would be shared state this measurement has no business touching.
  const managed = join(root, "repositories");
  return { checkout, managed };
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

/**
 * Every lock descriptor this run opens, counted at the native function.
 *
 * `useAdvisoryLock` opens its descriptor with `Deno.openSync` and takes the
 * lock on it, so wrapping that one function counts actual acquisitions. The
 * sidecar is left where it is: it is persistent by design, and whether the file
 * exists says nothing about whether this run took it.
 *
 * A resource, and the original is restored by cleanup registered before the
 * substitution, so a cancelled sample cannot leave the runtime wrapped.
 */
function useObservedLocks(counted: Counters): Operation<{ stop: () => void }> {
  return resource<{ stop: () => void }>(function* (provide) {
    const runtime: unknown = Reflect.get(globalThis, "Deno");
    const original: unknown = Reflect.get(Object(runtime), "openSync");
    if (typeof original !== "function") {
      throw new Error("this host opens no files, so there is no descriptor to observe");
    }
    let watching = true;
    yield* ensure(() => {
      Reflect.set(Object(runtime), "openSync", original);
    });
    Reflect.set(Object(runtime), "openSync", (...args: unknown[]) => {
      const [path] = args;
      if (watching && typeof path === "string" && path.endsWith(".lock")) {
        counted.lease += 1;
      }
      return Reflect.apply(original as (...rest: unknown[]) => unknown, runtime, args);
    });
    yield* provide({
      stop: () => {
        watching = false;
      },
    });
  });
}

/**
 * The helper configuration an ordinary run is initialized with.
 *
 * The same shape the Deno entrypoint states. Nothing here reads a credential:
 * what it describes is how a launcher would start this runtime, and no launcher
 * is written unless an operation needs one.
 */
const HELPER: HelperAssembly = {
  runtime: "source",
  platform: process.platform === "win32" ? "windows" : "unix",
  execPath: process.execPath,
  modulePath: fileURLToPath(
    new URL("../packages/cli/src/credential-helper-entry.ts", import.meta.url),
  ),
  launcherEnvironment: {},
};

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
  managed: string,
  source: string,
  retained: readonly DurableEvent[] = [],
): Operation<Measured> {
  return scoped(function* (): Operation<Measured> {
    const counted = counters();
    // Every lock descriptor this run opens, observed at the one native function
    // `useAdvisoryLock` reaches for. The sidecar itself is left alone.
    const descriptors = yield* useObservedLocks(counted);
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

    // Timed from here, so the entry setup and its first lazy acquisitions are
    // inside the measurement rather than beside it.
    const started = performance.now();
    if (mode === "ordinary") {
      // What an ordinary run establishes, through the same seam and inside the
      // same timed region: the comparison is between two initialized
      // executions, and a baseline that initialized nothing would be charging
      // the entry column for work the ordinary one also does.
      yield* Execution.around({
        *init(_args, next): Operation<void> {
          yield* useRunComposition({
            root: managed,
            cwd: checkout,
            helper: HELPER,
          });
          yield* next();
        },
      });
      yield* collect(yield* executeInstalled({ path, stream }, []));
    } else {
      // Registered the way the REPL host registers it: core initialization is
      // what establishes the recording, which is why the registration is inside
      // the timed region along with the first lazy acquisitions it leads to.
      yield* Execution.around({
        *init(_args, next): Operation<void> {
          yield* useReplRepositoryRecording({ operations: countingOperations(counted) });
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

    const events = yield* stream.readAll();
    counted.appends = events.length - retained.length;
    counted.localAppends = events
      .slice(retained.length)
      .filter(
        (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_LOCAL,
      ).length;
    descriptors.stop();
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
    `${"".padEnd(13)} git ${counted.commands}  lock descriptors ${counted.lease}  ` +
      `appends ${counted.appends} (local results ${counted.localAppends})  ` +
      `retained records ${counted.records}  journal ${counted.journalBytes} bytes`,
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
      const { checkout, managed } = yield* seed(chosen, unrelated);
      yield* measure(mode, checkout, managed, source);
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
        const { checkout, managed } = yield* seed(chosen, unrelated);
        const measured = yield* measure(mode, checkout, managed, source);
        (mode === "ordinary" ? ordinary : entry).push(measured);
        if (mode === "entry") {
          // The continuation runs against the journal that entry just wrote, in
          // the checkout it wrote it in. The sidecar stays exactly where the
          // live run left it: whether this run takes a lease is observed at the
          // descriptor, so there is nothing to clear to make an acquisition
          // visible.
          continuation.push(
            yield* measure("continuation", checkout, managed, source, unfinished(measured.events)),
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
    "A continuation performs no observed document read, write, delete or ensure, runs no `git`, " +
      "opens no lock descriptor and appends no local result; the appends it does make are the " +
      "engine's own closing events, which is why that column is counted apart from local " +
      "results. The `checks` it does make are pure lexical path checks, which touch no file. " +
      "This states no budget and no ratio, and the `globs` column is contextual calls rather " +
      "than comprehensive traversal instrumentation: it is raw evidence for a reviewer.",
  );
});
