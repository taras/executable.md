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
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdir, mkdtemp, realpath, symlink, unlink } from "node:fs/promises";
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
import { commonDirectoryLock, repositorySlot } from "../src/deno/run-composition/placement.ts";
import { useLeases } from "../src/deno/run-composition/leases.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { REPL_REPOSITORY_LOCAL } from "../src/retained-repository/records.ts";
import { REPL_REPOSITORY_PLACEMENT } from "../src/retained-repository/placement-records.ts";

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
   *
   * A callback that answers returns the answer; one that returns nothing leaves
   * the entry where it is, which is what every row holding a checkout open
   * needs and what a continuation past the question does not.
   */
  holding?: () => Operation<unknown>,
  /**
   * Where this entry's managed checkouts live.
   *
   * Absent for every row about the checkout the entry was opened in: a recorder
   * with no managed root installs no selector at all, which is the assembly
   * those rows are already about.
   */
  root?: string,
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
        yield* useReplRepositoryRecording(root === undefined ? {} : { root });
        yield* next();
      },
    });
    if (holding !== undefined) {
      // The question this entry's source ends at. Whoever asked gets no answer:
      // the callback runs instead, and the entry stays where it is — holding
      // the lease its initialization took — until that callback returns.
      yield* Elicitation.around({
        *elicit(): Operation<unknown> {
          const answer = yield* holding();
          if (answer === undefined) {
            return yield* suspend();
          }
          return answer;
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

function placementRecords(events: readonly DurableEvent[]): number {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_PLACEMENT,
  ).length;
}

function localRecords(events: readonly DurableEvent[]): number {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_LOCAL,
  ).length;
}

/** The question a held entry stands at, never answered. */
const QUESTION = '<Elicit schema={{ type: "object" }} as="answer">Holding</Elicit>';

/** A question that is answered at once, for a continuation past one. */
function answeringOnce(): () => Operation<unknown> {
  // deno-lint-ignore require-yield
  return function* (): Operation<unknown> {
    return {};
  };
}

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

  it("E4: refuses another entry the managed slot one is holding, until teardown", function* () {
    const fixture = yield* useFixture();
    const managed = join(fixture.root, "repositories");
    const origin = yield* useOrigin(fixture.root, "origin");
    const source = [
      `<Repository name="project" url=${JSON.stringify(origin)} as="project" />`,
      QUESTION,
    ].join("\n");

    yield* scoped(function* (): Operation<void> {
      const holding = counters();
      const acquired = withResolvers<void>();
      const release = withResolvers<void>();
      yield* spawn(function* (): Operation<void> {
        yield* entry(
          fixture.checkout,
          source,
          new InMemoryStream(),
          holding,
          function* (): Operation<void> {
            acquired.resolve();
            yield* release.operation;
          },
          managed,
        );
      });
      yield* acquired.operation;

      // A second live entry of the same process, asking for the same managed
      // Repository. It is refused by the operating system: the first entry's
      // descriptor is a different handle on the same sidecar.
      const blocked = counters();
      const second = yield* entry(
        fixture.checkout,
        source,
        new InMemoryStream(),
        blocked,
        answeringOnce(),
        managed,
      );
      expect(second.refusal).toContain("another process is working in the managed checkout");
      // Refused before the selector: nothing was written down for a selection
      // that never reached one.
      expect(placementRecords(second.events)).toBe(0);

      release.resolve();
    });

    // The holder is gone, so the same selection now reuses the checkout it
    // left behind.
    const after = counters();
    const later = yield* entry(
      fixture.checkout,
      source,
      new InMemoryStream(),
      after,
      answeringOnce(),
      managed,
    );
    expect(later.refusal).toBe(undefined);
  });

  it("E4: lets a restored placement read under a held mutation lease, and not write", function* () {
    const fixture = yield* useFixture();
    const managed = join(fixture.root, "repositories");
    const origin = yield* useOrigin(fixture.root, "shared");
    const commonLock = commonDirectoryLock(yield* until(realpath(join(origin, ".git"))));

    // Two linked placements of one repository, selected from the repository the
    // entry was opened in. `reader` and `writer` are two histories over the
    // same second worktree: each was left at a question, with its own suffix
    // still to run.
    const reading = counters();
    const readerSource = [
      '<Worktree name="observed" branch="observed">',
      '<File path="probe.md">probe</File>',
      QUESTION,
      '<File path="probe.md" as="seen" />',
      "{seen}",
      "</Worktree>",
    ].join("\n");
    const readerPrefix = yield* leftEntry(origin, readerSource, reading, managed);

    const writing = counters();
    const writerSource = [
      '<Worktree name="observed" branch="observed">',
      QUESTION,
      '<File path="later.md">later</File>',
      "</Worktree>",
    ].join("\n");
    const writerPrefix = yield* leftEntry(origin, writerSource, writing, managed);

    yield* scoped(function* (): Operation<void> {
      // One entry holding a *different* linked placement of the same
      // repository, and with it the shared Git directory's mutation lease its
      // own worktree selector took.
      const holding = counters();
      const acquired = withResolvers<void>();
      const release = withResolvers<void>();
      yield* spawn(function* (): Operation<void> {
        yield* entry(
          origin,
          ['<Worktree name="held" branch="held">', QUESTION, "</Worktree>"].join("\n"),
          new InMemoryStream(),
          holding,
          function* (): Operation<void> {
            acquired.resolve();
            yield* release.operation;
          },
          managed,
        );
      });
      yield* acquired.operation;

      // Watched from here, after the holder has its descriptors: what these two
      // continuations do is the subject.
      const observed = yield* useObservedDescriptors();

      const readAgain = counters();
      const read = yield* entry(
        origin,
        readerSource,
        new InMemoryStream([...readerPrefix]),
        readAgain,
        answeringOnce(),
        managed,
      );
      // The read happened, in a placement restored from its record, while
      // somebody else holds the repository for mutation.
      expect(read.refusal).toBe(undefined);
      expect(readAgain.reads).toEqual(["probe.md"]);
      expect(String(read.output)).toContain("probe");
      // It took the placement's own slot back and never opened the shared Git
      // directory's lock: being retained and being exclusive are different
      // questions, and so are the two holds.
      expect(observed.opened().filter((path) => path === commonLock)).toEqual([]);
      expect(observed.events().includes("lock")).toBe(true);

      observed.forget();
      const writeAgain = counters();
      const refused = yield* entry(
        origin,
        writerSource,
        new InMemoryStream([...writerPrefix]),
        writeAgain,
        answeringOnce(),
        managed,
      );
      // The mutation refused before it happened, and before any result was
      // written down for it.
      expect(refused.refusal).toContain("Another XMD entry or process holds this checkout");
      expect(writeAgain.writes).toEqual([]);
      expect(yield* exists(join(fixture.root, "later.md"))).toBe(false);
      expect(observed.opened().includes(commonLock)).toBe(true);

      release.resolve();
    });

    // The holder is gone, so the same mutation now takes the lease it always
    // did — the positive control for the refusal above.
    const after = counters();
    const wrote = yield* entry(
      origin,
      writerSource,
      new InMemoryStream([...writerPrefix]),
      after,
      answeringOnce(),
      managed,
    );
    expect(wrote.refusal).toBe(undefined);
    expect(after.writes).toEqual(["later.md"]);
  });

  it("E4: reacquires a restored placement's slot under the root it recorded", function* () {
    const fixture = yield* useFixture();
    const origin = yield* useOrigin(fixture.root, "recorded-origin");
    // Two real managed roots and one configured spelling that resolves to one
    // of them. The configured string never changes; only what it resolves to
    // does, which is what makes this about the root a placement *recorded*
    // rather than about a caller passing a different option.
    const managedA = join(fixture.root, "managed-a");
    const managedB = join(fixture.root, "managed-b");
    const configured = join(fixture.root, "managed-link");
    yield* until(mkdir(managedA, { recursive: true }));
    yield* until(mkdir(managedB, { recursive: true }));
    yield* until(symlink(managedA, configured, "dir"));

    const source = [
      `<Repository name="project" url=${JSON.stringify(origin)}>`,
      QUESTION,
      '<File path="after.md">after</File>',
      "</Repository>",
    ].join("\n");

    const live = counters();
    const prefix = yield* leftEntry(fixture.checkout, source, live, configured);
    expect(placementRecords(prefix)).toBe(1);

    yield* scoped(function* (): Operation<void> {
      // An ordinary owner of that placement, holding its slot under the root
      // the placement was selected under.
      const slot = repositorySlot(managedA, origin, "project");
      const held = yield* useLeases(managedA);
      yield* held.hold("repository", slot, 'repository "project"');

      // The positive control: a second independent acquisition of the same
      // slot, under the same root, is refused. Without it, a continuation that
      // "succeeded" would prove nothing about which sidecar was opened.
      let control: string | undefined;
      try {
        yield* scoped(function* (): Operation<void> {
          const competing = yield* useLeases(managedA);
          yield* competing.hold("repository", slot, 'repository "project"');
        });
      } catch (error) {
        control = error instanceof Error ? error.message : String(error);
      }
      expect(control).toContain("another process is working in the managed checkout");

      // The configured spelling now resolves somewhere else. The placement
      // still names the root it recorded, so the continuation's new write has
      // to meet the holder above — a lock taken under today's root would open a
      // sidecar nobody holds and let the write through.
      yield* until(unlink(configured));
      yield* until(symlink(managedB, configured, "dir"));

      const after = counters();
      const continued = yield* entry(
        fixture.checkout,
        source,
        new InMemoryStream([...prefix]),
        after,
        answeringOnce(),
        configured,
      );
      expect(continued.refusal).toContain("another process is working in the managed checkout");
      expect(after.writes).toEqual([]);
    });

    // The holder is gone, so the same continuation now performs its write in
    // the checkout the placement recorded.
    const released = counters();
    const later = yield* entry(
      fixture.checkout,
      source,
      new InMemoryStream([...prefix]),
      released,
      answeringOnce(),
      configured,
    );
    expect(later.refusal).toBe(undefined);
    expect(released.writes).toEqual(["after.md"]);
    // And it landed in the checkout the placement recorded, under root A,
    // while the configured spelling still resolves to B.
    expect(
      yield* readTextFile(
        join(repositorySlot(managedA, origin, "project"), "checkout", "after.md"),
      ),
    ).toBe("after");
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

/**
 * A source repository with a commit in it, for the rows that select one.
 *
 * Made inside the row rather than in the shared fixture, so the rows about the
 * ambient checkout keep the exact repository they have always had.
 */
function* useOrigin(root: string, name: string): Operation<string> {
  const origin = join(root, name);
  yield* until(mkdir(origin, { recursive: true }));
  const git = gitSession(denoRepositoryHost(), root);
  yield* git.run(["init", "-b", "main", origin], root);
  yield* writeTextFile(join(origin, "README.md"), "origin\n");
  yield* git.run(["add", "README.md"], origin);
  yield* git.run(["commit", "-m", "first"], origin);
  return origin;
}

/**
 * The prefix an entry left behind when it was left at a question.
 *
 * A real unfinished history: the entry is spawned, its question is reached and
 * never answered, the journal is read as the interruption left it, and only
 * then is the entry halted. The continuation that follows runs the same
 * document and reaches the work after the question.
 */
function leftEntry(
  checkout: string,
  source: string,
  counted: Counters,
  root: string,
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* spawn(() =>
      entry(
        checkout,
        source,
        stream,
        counted,
        function* (): Operation<void> {
          reached.resolve();
          yield* suspend();
        },
        root,
      ),
    );
    yield* race([
      reached.operation,
      (function* (): Operation<never> {
        yield* sleep(30_000);
        throw new Error("the entry never reached its question");
      })(),
    ]);
    const prefix = [...(yield* stream.readAll())];
    yield* task.halt();
    return prefix;
  });
}

/** What this host was asked to do with each lock descriptor, in order. */
interface ObservedDescriptors {
  events(): readonly string[];
  /**
   * Every path a descriptor was opened for, in order.
   *
   * What distinguishes the two holds: a managed slot's lock and a shared Git
   * directory's lock are different sidecars, and a row about one of them has to
   * be able to say the other was never opened.
   */
  opened(): readonly string[];
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
    let paths: string[] = [];
    let throwing = false;

    yield* ensure(() => {
      Reflect.set(Object(runtime), "openSync", original);
    });

    Reflect.set(Object(runtime), "openSync", (path: string, options: unknown) => {
      const file = Reflect.apply(original, runtime, [path, options]);
      events.push("open");
      paths.push(path);
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
      opened: () => [...paths],
      forget(): void {
        events = [];
        paths = [];
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
