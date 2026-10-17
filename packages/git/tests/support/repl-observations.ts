/**
 * One REPL entry, over one journal, reading a real repository.
 *
 * The same assembly the REPL host installs: core initialization establishes the
 * entry's recording inside the scope the invocation owns, the Git Plugin's own
 * trusted admission is attached, and the components are the shipped ones. What
 * a suite substitutes is only what it has to observe — the Git host, so native
 * commands can be counted, barriered and watched, and the filesystem, so the
 * document's own writes can be.
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
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation } from "@executablemd/core";
import { denoRepositoryHost } from "../../src/deno/composition/host.ts";
import type {
  GitBytes,
  GitInvocation,
  GitOutcome,
  RepositoryHost,
} from "../../src/deno/composition/host.ts";
import { UNAUTHENTICATED } from "../../src/deno/composition/authentication.ts";
import type { GitAuthenticationSession } from "../../src/deno/composition/authentication.ts";
import { useReplRepositoryRecording } from "../../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../../src/retained-repository/admission.ts";
import { useCompositionComponents } from "../../src/composition/installation.ts";
import type { ObservationFixture } from "./observations.ts";

/** What the host beneath one entry was asked to do. */
export interface EntryCounters {
  /** Every `git` invocation this entry ran, as its argument list. */
  commands: string[][];
  /** How many scratch directories this entry's reads acquired. */
  directories: number;
  /** Every scratch directory, by path, so its removal is observable. */
  scratch: string[];
  /** Every authentication locator a session was opened for. */
  sessions: string[];
}

export function entryCounters(): EntryCounters {
  return { commands: [], directories: 0, scratch: [], sessions: [] };
}

/** The Git subcommands one entry issued, in order. */
export function entrySubcommands(counted: EntryCounters): string[] {
  return counted.commands.map((args) => args.find((arg) => !arg.startsWith("-")) ?? "");
}

/** What a row may do to one `git` invocation before the real one runs. */
export type GitBarrier = (invocation: GitInvocation) => Operation<void>;

/**
 * The production host, counted, and interruptible at a named subcommand.
 *
 * Every leaf is wrapped rather than replaced: what a row needs to know is
 * whether a read ran at all, and the only honest way to answer is to let the
 * real `ls-files`, the real `diff` and the real `cat-file` happen and watch. A
 * barrier runs *before* the real invocation is delegated to, so a row that
 * halts there halts with the native work still to come — and one that delegates
 * first halts with a real child in flight.
 */
export function countingEntryHost(
  counted: EntryCounters,
  barrier?: GitBarrier,
  intercept?: (invocation: GitInvocation) => Partial<GitInvocation> | undefined,
): RepositoryHost {
  const host = denoRepositoryHost();
  const watched = (invocation: GitInvocation): GitInvocation => ({
    ...invocation,
    ...(intercept?.(invocation) ?? {}),
  });
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      counted.commands.push([...invocation.args]);
      if (barrier !== undefined) {
        yield* barrier(invocation);
      }
      return yield* host.git(watched(invocation));
    },
    *gitBytes(invocation: GitInvocation): Operation<GitBytes> {
      counted.commands.push([...invocation.args]);
      if (barrier !== undefined) {
        yield* barrier(invocation);
      }
      if (host.gitBytes === undefined) {
        throw new Error("the production host lends no byte capture");
      }
      return yield* host.gitBytes(watched(invocation));
    },
    *useDirectory(): Operation<string> {
      counted.directories += 1;
      const directory = yield* host.useDirectory();
      counted.scratch.push(directory);
      return directory;
    },
    *useAuthentication(locator: string): Operation<GitAuthenticationSession> {
      counted.sessions.push(locator);
      return host.useAuthentication === undefined
        ? UNAUTHENTICATED
        : yield* host.useAuthentication(locator);
    },
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
  /** A barrier inside one `git` invocation. */
  readonly barrier?: GitBarrier;
  /** What this row changes about one invocation before the real host runs it. */
  readonly intercept?: (invocation: GitInvocation) => Partial<GitInvocation> | undefined;
  /** Whether this entry installs a managed root at all. */
  readonly root?: string | undefined;
  /** The host this entry runs through, when a row supplies its own. */
  readonly host?: RepositoryHost;
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
          host:
            options.host ??
            countingEntryHost(counted, options.barrier, options.intercept),
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

/** Let every ready task run, so "reached its wait" is about turns. */
export function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/** Wait until this path is there, or say what never appeared. */
export function* appears(path: string): Operation<void> {
  const deadline = Date.now() + 30_000;
  while (!(yield* exists(path))) {
    if (Date.now() > deadline) {
      throw new Error(`${path} never appeared`);
    }
    yield* sleep(25);
  }
}

/** Whether this process is still running, asked of the operating system. */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
