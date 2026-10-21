/**
 * One REPL entry, over one journal, reading a real repository.
 *
 * The same assembly the REPL host installs: core initialization establishes the
 * entry's recording inside the scope the invocation owns, the Git Plugin's own
 * trusted admission is attached, and the components are the shipped ones. What
 * a suite substitutes is only what it has to observe — the repository handle,
 * so the operations an entry performs can be counted, barriered and held, and
 * the filesystem, so the document's own writes can be.
 *
 * The handle is the published twelve-method one, which carries no session, no
 * attachment and no credential. A row that needs to watch an actual `git`
 * child instead belongs to the composition suite that owns the native layer.
 */

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
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation } from "@executablemd/core";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import type { GitObservationRequest } from "@executablemd/git/api";
import { useCompositionComponents } from "@executablemd/git";
import { useReplRepositoryRecording } from "../../src/repl/repositories/deno/provider.ts";
import { admitReplRepositoryHistory } from "../../src/repl/repositories/admission.ts";
import type { ObservationFixture } from "../../../git/tests/support/observations.ts";

/** What the repository handle beneath one entry was asked to do. */
export interface EntryCounters {
  /** Every handle method this entry called, by name, in order. */
  methods: string[];
  /** What each observation asked for, in order. */
  reads: GitObservationRequest[];
}

export function entryCounters(): EntryCounters {
  return { methods: [], reads: [] };
}

/** The handle methods one entry called, in order. */
export function methodsCalled(counted: EntryCounters): string[] {
  return [...counted.methods];
}

/** What one entry's observations asked for, by kind, in order. */
export function readKinds(counted: EntryCounters): string[] {
  return counted.reads.map((request) => request.kind);
}

/** What a row may do to one handle method before the real one runs. */
export type MethodBarrier = (method: string) => Operation<void>;

/**
 * The production handle, counted, and interruptible at a named method.
 *
 * Every method is wrapped rather than replaced: what a row needs to know is
 * whether a read ran at all, and the only honest way to answer is to let the
 * real observation happen and watch. A barrier runs *before* the real method is
 * delegated to, so a row that halts there halts with the native work still to
 * come — and one that delegates first halts with the work in flight.
 */
export function countingEntryOperations(
  counted: EntryCounters,
  barrier?: MethodBarrier,
): () => Operation<DenoRepositoryOperations> {
  return function* (): Operation<DenoRepositoryOperations> {
    const operations = yield* useDenoRepositoryOperations();
    function* note(method: string): Operation<void> {
      counted.methods.push(method);
      if (barrier !== undefined) {
        yield* barrier(method);
      }
    }
    const wrapped: DenoRepositoryOperations = {
      *ambientCheckout(from) {
        yield* note("ambientCheckout");
        return yield* operations.ambientCheckout(from);
      },
      *ambientRepository(from) {
        yield* note("ambientRepository");
        return yield* operations.ambientRepository(from);
      },
      *selectRepository(slot, request) {
        yield* note("selectRepository");
        return yield* operations.selectRepository(slot, request);
      },
      *selectWorktree(slot, creation) {
        yield* note("selectWorktree");
        return yield* operations.selectWorktree(slot, creation);
      },
      *switch(checkout, workingDirectory, branch, base) {
        yield* note("switch");
        return yield* operations.switch(checkout, workingDirectory, branch, base);
      },
      *add(checkout, workingDirectory, paths) {
        yield* note("add");
        return yield* operations.add(checkout, workingDirectory, paths);
      },
      *commit(checkout, workingDirectory, message, messageSource, identity) {
        yield* note("commit");
        return yield* operations.commit(
          checkout,
          workingDirectory,
          message,
          messageSource,
          identity,
        );
      },
      *currentBranch(directory) {
        yield* note("currentBranch");
        return yield* operations.currentBranch(directory);
      },
      *resolveCommit(directory, revision) {
        yield* note("resolveCommit");
        return yield* operations.resolveCommit(directory, revision);
      },
      *commitPresent(directory, commit) {
        yield* note("commitPresent");
        return yield* operations.commitPresent(directory, commit);
      },
      *observe(element, request, place) {
        counted.reads.push(request);
        yield* note("observe");
        return yield* operations.observe(element, request, place);
      },
      *pushProvider(commonDirectory, origin, inputs) {
        yield* note("pushProvider");
        return yield* operations.pushProvider(commonDirectory, origin, inputs);
      },
    };
    return wrapped;
  };
}

export interface EntryRun {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  /** What ended the entry, when something did. */
  readonly refusal: string | undefined;
}

export interface EntryRunOptions {
  /** The directory the entry is opened in. Defaults to the fixture's link. */
  readonly cwd?: string;
  /** What this row installs between the host and the recording. */
  readonly between?: () => Operation<void>;
  /** A barrier inside one handle method. */
  readonly barrier?: MethodBarrier;
  /** Whether this entry installs a managed root at all. */
  readonly root?: string | undefined;
  /** The handle this entry runs through, when a row supplies its own. */
  readonly operations?: () => Operation<DenoRepositoryOperations>;
}

/** Where one scenario's entries are opened, and what they can reach. */
export interface EntryPlace {
  /** The scenario's own directory, which is also the include root. */
  readonly root: string;
  /** Where this scenario's managed checkouts live. */
  readonly managed: string;
  /**
   * A symbolic link an entry is opened through.
   *
   * Pointed at the fixture's checkout to begin with, and re-pointed by a row
   * that needs "nothing resolved this directory" to be a positive fact.
   */
  readonly link: string;
}

export function useEntryPlace(fixture: ObservationFixture): Operation<EntryPlace> {
  return resource<EntryPlace>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-observe-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const link = join(root, "entered");
    yield* until(symlink(fixture.root, link));
    yield* provide({ root, managed: join(root, "repositories"), link });
  });
}

/** Point the link an entry is opened through at another directory. */
export function* repoint(place: EntryPlace, target: string): Operation<void> {
  yield* until(unlink(place.link));
  yield* until(symlink(target, place.link));
}

/** One entry, over one journal, in one checkout. */
export function runEntry(
  place: EntryPlace,
  source: string,
  stream: DurableStream,
  counted: EntryCounters,
  options: EntryRunOptions = {},
): Operation<EntryRun> {
  return scoped(function* () {
    const path = join(place.root, "entry.md");
    yield* writeTextFile(path, source);
    const working = options.cwd ?? place.link;
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return working;
        },
      },
      { at: "min" },
    );
    // What a runtime entrypoint installs beside the provider: `API.Files` has
    // no host default, and a document that writes `<File>` must reach the
    // caller's own filesystem exactly as the REPL leaves it.
    yield* useHostFiles();
    yield* useCompositionComponents();
    if (options.between !== undefined) {
      yield* options.between();
    }
    const managed = "root" in options ? options.root : place.managed;
    // Registered the way the REPL host registers it: core initialization is
    // what establishes the recording and the handlers, inside the scope the
    // invocation owns.
    yield* Execution.around({
      *init(_args, next): Operation<void> {
        yield* useReplRepositoryRecording({
          operations: options.operations ?? countingEntryOperations(counted, options.barrier),
          ...(managed === undefined ? {} : { root: managed }),
        });
        yield* next();
      },
    });
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream, includes: [place.root] }, [
            // What the Git Plugin contributes for `repl`, attached directly:
            // this suite assembles no command Plugins.
            { admissions: [(retained) => admitReplRepositoryHistory(retained)] },
          ]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, events: yield* stream.readAll(), refusal };
  });
}

/**
 * The prefix an entry left behind when it was left at a question.
 *
 * A *real* unfinished history, not a complete one with its closes removed: a
 * journal whose run finished replays every position it holds and runs no
 * component, so a continuation with a new suffix would never reach the suffix.
 * What a row needs is the other case — somebody answered nothing, the entry is
 * still standing there, and the work after the question has never run.
 */
export function leftEntry(
  place: EntryPlace,
  source: string,
  counted: EntryCounters,
  options: EntryRunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* spawn(() =>
      runEntry(place, source, stream, counted, {
        ...options,
        *between(): Operation<void> {
          if (options.between !== undefined) {
            yield* options.between();
          }
          yield* Elicitation.around({
            *elicit(): Operation<unknown> {
              reached.resolve();
              // Nobody answers, so this is where the entry is when it is left.
              return yield* suspend();
            },
          });
        },
      }),
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
