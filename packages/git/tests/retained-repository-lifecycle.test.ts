/**
 * Who holds a checkout while an entry works in it, and when they let go.
 *
 * Two entries moving files in one repository is what the exclusion exists to
 * prevent, and one mechanism answers it: the kernel lock on a sidecar beside
 * the repository. `flock` and `LockFileEx` both exclude *independently opened*
 * handles, including two opened by one process, so the native descriptor is the
 * whole live resource and there is no table of holders to keep.
 *
 * The rows that matter most are the entry-level ones. A refused acquisition has
 * to leave the history it found exactly as it was: records already written stay
 * written, the mutation that was about to happen gets no result of any kind,
 * nothing after it runs, and a later attempt works once the holder has gone. A
 * lease that leaked past its entry, or one that answered from a table instead of
 * the kernel, would pass a helper test and fail that rule.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  type Operation,
  type Result,
  ensure,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { collect, Elicitation } from "@executablemd/core";
import { Execution } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { useAdvisoryLock } from "@executablemd/workflow/deno";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import { useReplRepositoryRecording } from "../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import {
  CommonDirectoryLeaseError,
  useCommonDirectoryLease,
} from "../src/deno/retained-repository/leases.ts";
import { commonDirectoryLock } from "../src/deno/run-composition/placement.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { REPL_REPOSITORY_LOCAL } from "../src/retained-repository/records.ts";

/** Let every ready task run, so "reached its wait" is about turns. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly elsewhere: string;
}

/** Two seeded checkouts, so "another directory" is a real other repository. */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-lease-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const git = gitSession(denoRepositoryHost(), root);
    const made: string[] = [];
    for (const name of ["checkout", "elsewhere"]) {
      const directory = join(root, name);
      yield* until(mkdir(directory, { recursive: true }));
      yield* git.run(["init", "-b", "main", directory], root);
      yield* writeTextFile(join(directory, "seed.md"), "seed\n");
      made.push(directory);
    }
    yield* provide({ root, checkout: made[0] ?? "", elsewhere: made[1] ?? "" });
  });
}

/** The canonical common Git directory of this checkout. */
function common(checkout: string): Operation<string> {
  return until(realpath(join(checkout, ".git")));
}

/** What holding this directory answered: nothing, or the refusal it raised. */
function* held(directory: string): Operation<Error | undefined> {
  try {
    yield* useCommonDirectoryLease(directory);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

interface Counters {
  reads: string[];
  writes: string[];
  deletes: string[];
}

function counters(): Counters {
  return { reads: [], writes: [], deletes: [] };
}

function countingFiles(counted: Counters): FilesHandler {
  const host = hostFilesHandler();
  return {
    checkFilePath: (input) => host.checkFilePath(input),
    *readTextFile(input: FilePathInput) {
      counted.reads.push(input.path);
      return yield* host.readTextFile(input);
    },
    globFiles: (input) => host.globFiles(input),
    temporaryDirectory: () => host.temporaryDirectory(),
    *writeTextFile(input: FileWriteInput) {
      counted.writes.push(input.path);
      return yield* host.writeTextFile(input);
    },
    *deleteFile(input: FilePathInput) {
      counted.deletes.push(input.path);
      return yield* host.deleteFile(input);
    },
    ensureDirectory: (input) => host.ensureDirectory(input),
  };
}

interface Run {
  readonly refusal: string | undefined;
  readonly events: readonly DurableEvent[];
  /** What the document rendered, for a row whose subject is a read's value. */
  readonly output: string;
}

/**
 * One entry, run to completion in this checkout.
 *
 * The entry host is the production one, so a second concurrent entry is refused
 * by whatever actually refuses it rather than by anything this suite installs.
 */
function entry(
  checkout: string,
  source: string,
  stream: InMemoryStream,
  counted: Counters,
  /**
   * Work to do while this entry is standing at a question it never answers.
   *
   * Where a row holding the checkout open has to wait, and it has to wait while
   * the *document* is live: the lease belongs to the scope core initialization
   * established it in, and an entry whose document has finished has already
   * released it. A source ending in `<Elicit>` is how a held entry is held in
   * production too — somebody left it at a question — so this is that, with the
   * answer never arriving.
   */
  holding?: () => Operation<void>,
): Operation<Run> {
  return scoped(function* (): Operation<Run> {
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
    yield* Execution.around({
      *init(_args, next): Operation<void> {
        yield* useReplRepositoryRecording();
        yield* next();
      },
    });
    if (holding !== undefined) {
      // The question this entry's source ends at. Whoever asked gets no answer:
      // the callback runs instead, and the entry stays where it is — holding
      // the lease its initialization took — until that callback returns.
      yield* Elicitation.around({
        *elicit(): Operation<unknown> {
          yield* holding();
          return yield* suspend();
        },
      });
    }
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream }, [
            { admissions: [(retained) => admitReplRepositoryHistory(retained)] },
          ]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { refusal, events: yield* stream.readAll(), output };
  });
}

function localRecords(events: readonly DurableEvent[]): number {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_LOCAL,
  ).length;
}

/** The question a held entry stands at, never answered. */
const QUESTION = '<Elicit schema={{ type: "object" }} as="answer">Holding</Elicit>';

describe("an entry's hold on the checkout it is working in", () => {
  it("E8: refuses a second live entry, preserving what the first recorded", function* () {
    const fixture = yield* useFixture();
    const holding = counters();
    const blocked = counters();
    const stream = new InMemoryStream();
    const first = new InMemoryStream();

    yield* scoped(function* (): Operation<void> {
      // One entry holding the checkout, kept open by a write it has already
      // performed and a suspension after it.
      const acquired = withResolvers<void>();
      const release = withResolvers<void>();
      yield* spawn(function* (): Operation<void> {
        yield* entry(
          fixture.checkout,
          ['<File path="held.md">held</File>', QUESTION].join("\n"),
          first,
          holding,
          function* (): Operation<void> {
            acquired.resolve();
            yield* release.operation;
          },
        );
      });
      yield* acquired.operation;
      expect(holding.writes).toEqual(["held.md"]);
      const recorded = localRecords(yield* first.readAll());
      expect(recorded).toBe(1);

      // A second live entry of the same process, in the same checkout. It is
      // refused by the operating system: the first entry's descriptor is a
      // different handle on the same file.
      const second = yield* entry(
        fixture.checkout,
        ['<File path="blocked.md">blocked</File>', '<File path="sentinel.md">sentinel</File>'].join(
          "\n",
        ),
        stream,
        blocked,
      );

      // Refused before anything was read or changed, so: no mutation, no
      // sentinel after it, and no result of any kind written down for the
      // operation that was about to happen.
      expect(second.refusal).toContain("Another XMD entry or process holds this checkout");
      expect(blocked.writes).toEqual([]);
      expect(yield* exists(join(fixture.checkout, "blocked.md"))).toBe(false);
      expect(yield* exists(join(fixture.checkout, "sentinel.md"))).toBe(false);
      expect(localRecords(second.events)).toBe(0);

      // And the records the first entry wrote are untouched.
      expect(localRecords(yield* first.readAll())).toBe(recorded);
      expect(yield* readTextFile(join(fixture.checkout, "held.md"))).toBe("held");

      release.resolve();
    });

    // The holder is gone, so a later attempt works against the environment then
    // available.
    const later = counters();
    const after = yield* entry(
      fixture.checkout,
      '<File path="later.md">later</File>',
      new InMemoryStream(),
      later,
    );
    expect(after.refusal).toBe(undefined);
    expect(later.writes).toEqual(["later.md"]);
  });

  it("E8: lets an entry in another repository through", function* () {
    const fixture = yield* useFixture();
    const holding = counters();
    const other = counters();

    yield* scoped(function* (): Operation<void> {
      const acquired = withResolvers<void>();
      const release = withResolvers<void>();
      yield* spawn(function* (): Operation<void> {
        yield* entry(
          fixture.checkout,
          ['<File path="held.md">held</File>', QUESTION].join("\n"),
          new InMemoryStream(),
          holding,
          function* (): Operation<void> {
            acquired.resolve();
            yield* release.operation;
          },
        );
      });
      yield* acquired.operation;

      // A different common directory is a different question.
      const elsewhere = yield* entry(
        fixture.elsewhere,
        '<File path="free.md">free</File>',
        new InMemoryStream(),
        other,
      );
      expect(elsewhere.refusal).toBe(undefined);
      expect(other.writes).toEqual(["free.md"]);
      release.resolve();
    });
  });

  it("E8: reads the held checkout, and takes no lease to do it", function* () {
    const fixture = yield* useFixture();
    const holding = counters();
    const reading = counters();

    yield* scoped(function* (): Operation<void> {
      const acquired = withResolvers<void>();
      const release = withResolvers<void>();
      yield* spawn(function* (): Operation<void> {
        yield* entry(
          fixture.checkout,
          ['<File path="held.md">held</File>', QUESTION].join("\n"),
          new InMemoryStream(),
          holding,
          function* (): Operation<void> {
            acquired.resolve();
            yield* release.operation;
          },
        );
      });
      yield* acquired.operation;

      // Watched from here, after the holder has its descriptor: what this row
      // is about is whether the reader opens one of its own.
      const observed = yield* useObservedDescriptors();
      const stream = new InMemoryStream();
      const read = yield* entry(
        fixture.checkout,
        '<File path="held.md" as="seen" />\n{seen}',
        stream,
        reading,
      );

      // The read happened, against a checkout somebody else is holding for
      // mutation. A lease taken here would have refused it.
      expect(read.refusal).toBe(undefined);
      expect(reading.reads).toEqual(["held.md"]);
      expect(String(read.output)).toContain("held");
      // And it is retained, so a continuation answers it without looking.
      expect(localRecords(read.events)).toBe(1);
      // No descriptor at all: the lease is about one entry at a time changing a
      // repository, and this one only looked.
      expect(observed.events()).toEqual([]);

      release.resolve();
    });

    // The holder is gone. A mutation now takes the lease it always did, which
    // is the positive control for the observation above.
    const after = counters();
    const observed = yield* useObservedDescriptors();
    const wrote = yield* entry(
      fixture.checkout,
      '<File path="later.md">later</File>',
      new InMemoryStream(),
      after,
    );
    expect(wrote.refusal).toBe(undefined);
    expect(observed.events().includes("lock")).toBe(true);
  });

  it("E8: takes one handle for an entry's many mutations", function* () {
    const fixture = yield* useFixture();
    const counted = counters();

    // Four mutations in one entry. Each asks for the lease; the entry's lazy
    // single-flight acquisition is what makes that one native handle rather
    // than four — a second independent handle would refuse itself.
    const performed = yield* entry(
      fixture.checkout,
      [
        '<Dir path="many">',
        '<File path="one.md">one</File>',
        '<File path="two.md">two</File>',
        '<File.Delete path="one.md" />',
        "</Dir>",
      ].join("\n"),
      new InMemoryStream(),
      counted,
    );

    expect(performed.refusal).toBe(undefined);
    expect(counted.writes).toEqual(["one.md", "two.md"]);
    expect(counted.deletes).toEqual(["one.md"]);
    expect(localRecords(performed.events)).toBe(4);
  });

  it("E8: releases the checkout when the entry is torn down, and not before", function* () {
    const fixture = yield* useFixture();
    const directory = yield* common(fixture.checkout);
    const acquired = withResolvers<void>();
    const release = withResolvers<void>();

    yield* scoped(function* (): Operation<void> {
      const holder = yield* spawn(function* (): Operation<void> {
        yield* useCommonDirectoryLease(directory);
        acquired.resolve();
        yield* release.operation;
      });
      // Asked for after the holder has it, not beside it: a probe racing the
      // acquisition would be testing which of the two went first.
      yield* acquired.operation;
      expect(yield* scoped(() => held(directory))).not.toBe(undefined);
      release.resolve();
      // Joined, not merely signalled: what proves the lease is gone is the
      // holder's own teardown having run.
      yield* holder;
    });

    expect(yield* scoped(() => held(directory))).toBe(undefined);
  });

  it("E8: refuses a second independently opened handle in this process", function* () {
    const fixture = yield* useFixture();
    const directory = yield* common(fixture.checkout);

    yield* scoped(function* (): Operation<void> {
      const acquired = withResolvers<void>();
      yield* spawn(function* (): Operation<void> {
        yield* useCommonDirectoryLease(directory);
        acquired.resolve();
        yield* suspend();
      });
      yield* acquired.operation;
      // The kernel, not a table: this is a second `open` of the same path in one
      // process, which `flock` and `LockFileEx` both refuse.
      const refused = yield* scoped(() => held(directory));
      expect(refused instanceof CommonDirectoryLeaseError).toBe(true);
    });
  });

  it("E8: refuses while another process holds the sidecar, and not after", function* () {
    const fixture = yield* useFixture();
    const directory = yield* common(fixture.checkout);
    const lock = commonDirectoryLock(directory);
    const child = yield* holdingChild(lock);

    expect(yield* child.locked()).toBe("locked");
    expect(yield* scoped(() => held(directory))).not.toBe(undefined);

    // The child lets go, and the kernel is what says so: this waits for the
    // process to be gone rather than for the close to be accepted.
    yield* child.finish();

    expect(yield* scoped(() => held(directory))).toBe(undefined);
    // Nothing unlinked the sidecar: unlinking a locked path lets the next
    // caller lock a different file at the same name.
    expect(yield* exists(lock)).toBe(true);
  });

  it("E8: joins the child it owns when finishing is cancelled", function* () {
    const fixture = yield* useFixture();
    const lock = commonDirectoryLock(yield* common(fixture.elsewhere));
    let probe: HoldingChild | undefined;

    yield* scoped(function* (): Operation<void> {
      // A child that holds the sidecar and does not exit when its standard
      // input closes, so `finish()` gets past the close and suspends on the
      // status wait — which is where a cancellation lands.
      const child = yield* holdingChild(lock, { ignoreStdin: true });
      probe = child;
      expect(yield* child.locked()).toBe("locked");
      yield* spawn(() => child.finish());
      // Let the finishing task reach its wait before this scope unwinds.
      yield* settled();
    });

    // The owner's teardown has returned. A fixture that switched its cleanup
    // off on the way *into* those waits would have left a live process here,
    // and a live process still holds the sidecar — so the lock being free is
    // the independent evidence that the child was killed and joined.
    expect(probe?.alive()).toBe(false);
    yield* scoped(function* (): Operation<void> {
      expect(yield* useAdvisoryLock(lock)).not.toBe(undefined);
    });
  });

  it("E8: releases the advisory lock when its holder is cancelled", function* () {
    const fixture = yield* useFixture();
    const lock = commonDirectoryLock(yield* common(fixture.elsewhere));
    const acquired = withResolvers<void>();

    yield* scoped(function* (): Operation<void> {
      const task = yield* spawn(function* (): Operation<void> {
        const file = yield* useAdvisoryLock(lock);
        // Acquired before the halt, so this cancels a holder rather than a
        // caller that had not reached the descriptor yet.
        expect(file).not.toBe(undefined);
        acquired.resolve();
        yield* suspend();
      });
      yield* acquired.operation;
      yield* task.halt();
    });

    // Available immediately afterwards, in this same process, where a
    // still-open descriptor would still hold it.
    yield* scoped(function* (): Operation<void> {
      expect(yield* useAdvisoryLock(lock)).not.toBe(undefined);
    });
  });

  it("E8: opens, locks, releases and closes each descriptor exactly once", function* () {
    const fixture = yield* useFixture();
    const lock = commonDirectoryLock(yield* common(fixture.checkout));

    yield* scoped(function* (): Operation<void> {
      const observed = yield* useObservedDescriptors();

      // A held descriptor: nothing is released while the scope that took it is
      // still running, and leaving it unlocks and closes once each.
      yield* scoped(function* (): Operation<void> {
        expect(yield* useAdvisoryLock(lock)).not.toBe(undefined);
        expect(observed.events()).toEqual(["open", "lock"]);
      });
      expect(observed.events()).toEqual(["open", "lock", "unlock", "close"]);

      // A refused descriptor, against a real holder.
      const acquired = withResolvers<void>();
      yield* spawn(function* (): Operation<void> {
        expect(yield* useAdvisoryLock(lock)).not.toBe(undefined);
        acquired.resolve();
        yield* suspend();
      });
      yield* acquired.operation;
      observed.forget();

      yield* scoped(function* (): Operation<void> {
        expect(yield* useAdvisoryLock(lock)).toBe(undefined);
        // Closed already, inside the scope that asked: a descriptor holding
        // nothing has nothing to release, and keeping it open until teardown
        // would cost a refusal a handle it never acquired. Observing the close
        // is the point — a refused descriptor left open holds no lock, so
        // reacquiring later cannot reveal it.
        expect(observed.events()).toEqual(["open", "refused", "close"]);
      });
      // And not closed again on the way out. A second close throws, so the
      // list staying put is what says cleanup handled the partial acquisition.
      expect(observed.events()).toEqual(["open", "refused", "close"]);

      // A lock attempt that throws: the descriptor is closed once, and never
      // unlocked — it was never held.
      observed.forget();
      observed.failLock();
      yield* scoped(function* (): Operation<void> {
        let raised: Error | undefined;
        try {
          yield* useAdvisoryLock(lock);
        } catch (error) {
          raised = error instanceof Error ? error : new Error(String(error));
        }
        expect(raised?.message).toBe("this host refused to lock");
        // One close and no unlock: the descriptor was never held, so there was
        // nothing to release. Which of the two paths closed it — the catch, or
        // the cleanup unwinding as the error propagates out of the resource —
        // is deliberately not claimed here, because the two are simultaneous
        // from outside. What is claimed is that exactly one of them did it.
        expect(observed.events()).toEqual(["open", "lock-threw", "close"]);
      });
      // And not closed a second time on the way out.
      expect(observed.events()).toEqual(["open", "lock-threw", "close"]);
    });
  });
});

/** What this host was asked to do with each lock descriptor, in order. */
interface ObservedDescriptors {
  events(): readonly string[];
  /** Start a fresh list, so one row is not read against another's calls. */
  forget(): void;
  /** Make the next lock attempt throw, which is a partial acquisition. */
  failLock(): void;
}

/**
 * Watch the native boundary the advisory helper reaches through.
 *
 * `advisory-lock.ts` reads its runtime off the global and depends on three
 * methods of what `openSync` hands back, so wrapping that one function is
 * enough to see every open, lock attempt, unlock and close without the
 * production module gaining a seam of its own. The real descriptor still does
 * the work; this only records what was asked of it.
 *
 * The restore is registered before the substitution, so a cancelled or failed
 * row puts the host's own function back.
 */
function useObservedDescriptors(): Operation<ObservedDescriptors> {
  return resource<ObservedDescriptors>(function* (provide) {
    const runtime: unknown = Reflect.get(globalThis, "Deno");
    const original: unknown = Reflect.get(Object(runtime), "openSync");
    if (typeof original !== "function") {
      throw new Error("this host opens no files, so there is no descriptor to observe");
    }
    let events: string[] = [];
    let throwing = false;

    yield* ensure(() => {
      Reflect.set(Object(runtime), "openSync", original);
    });

    Reflect.set(Object(runtime), "openSync", (path: string, options: unknown) => {
      const file = Reflect.apply(original, runtime, [path, options]);
      events.push("open");
      return {
        tryLockSync(exclusive: boolean): boolean {
          if (throwing) {
            events.push("lock-threw");
            throw new Error("this host refused to lock");
          }
          const locked = Reflect.apply(Reflect.get(Object(file), "tryLockSync"), file, [exclusive]);
          events.push(locked === true ? "lock" : "refused");
          return locked === true;
        },
        unlockSync(): void {
          events.push("unlock");
          Reflect.apply(Reflect.get(Object(file), "unlockSync"), file, []);
        },
        close(): void {
          events.push("close");
          Reflect.apply(Reflect.get(Object(file), "close"), file, []);
        },
      };
    });

    yield* provide({
      events: () => [...events],
      forget(): void {
        events = [];
      },
      failLock(): void {
        throwing = true;
      },
    });
  });
}

/** A child process holding one sidecar, owned by the scope that started it. */
interface HoldingChild {
  /** What the child said once it had the lock. */
  locked(): Operation<string>;
  /** Let it go, and wait for the process to be gone. */
  finish(): Operation<void>;
  /** Whether this fixture still owns a process it has not joined. */
  alive(): boolean;
}

/**
 * Start a process that locks this path and waits.
 *
 * The reaping cleanup is registered *before* the child exists, which is rule
 * 16's ownership order: a scope halted between the spawn and the registration
 * would otherwise leave a process nothing owns. It waits for the child's own
 * status rather than for the signal to be accepted, because a kill that was
 * sent is not a process that has gone.
 */
function holdingChild(
  lock: string,
  options: { readonly ignoreStdin?: boolean } = {},
): Operation<HoldingChild> {
  return resource<HoldingChild>(function* (provide) {
    let child: Deno.ChildProcess | undefined;
    /**
     * Set once the child's own status has resolved, and never before.
     *
     * `finish()` suspends twice — closing stdin, then waiting for the status —
     * and a cancellation landing on either of those is exactly when this
     * cleanup is needed. Declaring completion on the way *into* those waits
     * would switch the cleanup off while the process was still running, which
     * is registering cleanup before the spawn and then disowning the result.
     */
    let gone = false;
    yield* ensure(function* (): Operation<void> {
      if (child === undefined || gone) {
        return;
      }
      try {
        child.kill();
      } catch {
        // Already gone, which is the ordinary case once stdin closed.
      }
      yield* until(child.status);
      gone = true;
    });

    child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        [
          "const path = Deno.args[0];",
          "await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });",
          "const file = Deno.openSync(path, { read: true, write: true, create: true });",
          "if (!file.tryLockSync(true)) { console.log('refused'); Deno.exit(1); }",
          "console.log('locked');",
          options.ignoreStdin === true
            ? // Holds on past its standard input closing, so a `finish()` that
              // has already closed stdin suspends on the status wait rather than
              // completing. That is the cancellation boundary this fixture's own
              // ownership has to survive.
              //
              // A pending timer rather than a bare never-resolving promise: with
              // nothing on the event loop Deno reports an unresolvable top-level
              // await and *exits*, which would release the lock on its own and
              // make this fixture prove nothing.
              "await new Promise((resolve) => setTimeout(resolve, 600000));"
            : "await new Response(Deno.stdin.readable).text();",
        ].join("\n"),
        lock,
      ],
      stdin: "piped",
      stdout: "piped",
      // Piped so a killed child's own complaint stays out of the report.
      stderr: "piped",
    }).spawn();
    const started = child;

    const reader = started.stdout.getReader();
    yield* provide({
      *locked(): Operation<string> {
        const first = yield* until(reader.read());
        return new TextDecoder().decode(first.value).trim();
      },
      *finish(): Operation<void> {
        reader.releaseLock();
        yield* until(started.stdin.close());
        yield* until(started.status);
        // Only now: the process has reported its own termination, so there is
        // nothing left for the cleanup above to own.
        gone = true;
      },
      alive(): boolean {
        return !gone;
      },
    });
  });
}
