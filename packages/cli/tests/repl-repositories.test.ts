/**
 * How a REPL entry gets its repository behavior, and who never gets any.
 *
 * This setup is the one thing in this command prepared per *entry* rather than
 * per command, and what follows from it are what this suite holds. An
 * entry that mutates files in the checkout the person is standing in records
 * them in its own segment of the history, so a later entry doing identical work
 * does that work rather than answering from the earlier entry's records. A view
 * that is only reading — a settled history, a frozen position — prepares
 * nothing at all, so it discovers nothing and takes no lease. And a host that
 * installs no setup runs ordinary file work with nothing retained.
 *
 * The generated half is here rather than beside the provider because a
 * generated fragment's operations cross the same one Files route an authored
 * one does: there is no second instance to wrap, and what proves it is a
 * fragment's read, write and delete being retained exactly as an authored
 * one's are.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { exists, readTextFile, rm } from "@effectionx/fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { appendFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { denoRepositoryHost } from "../../git/src/deno/composition/host.ts";
import { gitSession } from "../../git/src/deno/composition/git.ts";
import {
  parseReplLocalRecord,
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
} from "../../git/src/retained-repository/records.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
} from "../../git/src/retained-repository/placement-records.ts";
import { Execution } from "@executablemd/core/api";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { ordinaryGeneratedSelection } from "../src/evaluation-profile.ts";
import { useDenoReplRepositories } from "../src/deno-repositories.ts";
import type { HelperAssembly } from "../../git/src/deno/composition/credential-helper.ts";
import { gitPlugin } from "../../git/src/plugin.ts";
import { ReplHost } from "../src/repl/host.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplExecution } from "../src/repl/journal.ts";

/**
 * What a command contributes to an entry's execution.
 *
 * Taken from the Git Plugin's own contribution for the `repl` command rather
 * than written out here, because that contribution is the production path: the
 * admission that reads this feature's records travels with the vocabulary, and
 * a row that hand-attached its own would pass with the Plugin contributing
 * nothing.
 */
function* replInstallations(): Operation<readonly ExecutionInstallation[]> {
  // Installing it also registers this package's components in the calling
  // scope, which is what an entry needs to resolve `<Dir>`: the Plugin is one
  // contribution, and taking half of it would be assembling something no
  // command assembles.
  const install = gitPlugin.install;
  if (install === undefined) {
    throw new Error("the Git Plugin installs nothing");
  }
  const installed = yield* install.call(gitPlugin, { command: "repl", args: [] });
  if (installed === undefined) {
    throw new Error("the Git Plugin declared nothing for the repl command");
  }
  return [{ admissions: [...(installed.admissions ?? [])] }];
}

/** One entry that settles, for the rows about a history nobody is continuing. */
const SETTLED_ENTRY = '<File path="settled.md">settled</File>';

interface Fixture {
  readonly root: string;
  readonly checkout: string;
}

function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-cli-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    const git = gitSession(denoRepositoryHost(), root);
    yield* git.run(["init", "-b", "main", checkout], root);
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    yield* provide({ root, checkout });
  });
}

/** The host half a runtime entrypoint owns, installed here by the suite. */
function useNodeReplHost(name: string): Operation<void> {
  return ReplHost.around(
    {
      // deno-lint-ignore require-yield
      *identify(): Operation<string> {
        return name;
      },
      *createExclusive([path]: [string]): Operation<void> {
        const handle = yield* until(open(path, "wx"));
        yield* until(handle.close());
      },
      *appendRecord([path, record]: [string, string]): Operation<void> {
        yield* until(appendFile(path, record));
      },
    },
    { at: "min" },
  );
}

/** Where every authored path in these entries resolves. */
function useWorkingDirectory(directory: string): Operation<void> {
  return API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return directory;
      },
    },
    { at: "min" },
  );
}

interface Counted {
  /** How many executions this session initialized. */
  initialized: number;
}

/**
 * The production REPL recording, with each initialization counted.
 *
 * Counted by a second layer on the same seam rather than by instrumenting the
 * recording: what this observes is core invoking `init`, which is the rule —
 * an entry that executes initializes once, and a view that only reads a history
 * initializes not at all.
 */
function* useCountedRecording(counted: Counted, root: string): Operation<void> {
  yield* Execution.around({
    *init(_args, next): Operation<void> {
      counted.initialized += 1;
      yield* next();
    },
  });
  yield* useDenoReplRepositories(SUITE_HELPER, root);
}

/**
 * The credential-helper assembly this suite's host selects.
 *
 * Inert, and never invoked: every locator these rows select is a local path, so
 * the transport carries no identity and no broker is asked for one.
 */
const SUITE_HELPER: HelperAssembly = Object.freeze({
  runtime: "source",
  platform: "unix",
  execPath: "/nonexistent/xmd",
});

/** Where this fixture's managed checkouts live. */
function managedRoot(fixture: Fixture): string {
  return join(fixture.root, "repositories");
}

/**
 * A source repository with a commit in it, for the rows that select one.
 *
 * Made inside the row rather than in the shared fixture, so the rows about the
 * checkout the entry was opened in keep the exact repository they have had.
 */
function* useOrigin(fixture: Fixture): Operation<string> {
  const origin = join(fixture.root, "origin");
  const git = gitSession(denoRepositoryHost(), fixture.root);
  yield* git.run(["init", "-b", "main", origin], fixture.root);
  yield* until(writeFile(join(origin, "README.md"), "origin\n"));
  yield* git.run(["add", "README.md"], origin);
  yield* git.run(["commit", "-m", "first"], origin);
  return origin;
}

function execution(events: readonly DurableEvent[] = []): ReplExecution {
  return { id: "execution-1", stream: new InMemoryStream([...events]) };
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Wait until this session is holding a question.
 *
 * Subscribed before the pending one is read, because a signal delivers from
 * subscription time: checking first and subscribing after would lose a question
 * that arrived in between and wait forever for the next one.
 */
function* waitForQuestion(session: ReplSession): Operation<void> {
  const changes = yield* session.elicitation.changes;
  if (session.elicitation.pending !== undefined) {
    return;
  }
  // The stream carries each question as it arrives, so the first one it
  // delivers is the one this entry is holding.
  yield* changes.next();
}

/** The text a recorded read answers with, read off its journaled payload. */
function recordedText(event: DurableEvent | undefined): string | undefined {
  if (event?.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  const record = parseReplLocalRecord(event.result.value);
  const value = record?.outcome.ok === true ? record.outcome.value : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Every record of one type this history holds. */
function recordsOf(events: readonly DurableEvent[], type: string): readonly DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.description.type === type);
}

/** One submitted entry, run to completion against this execution's history. */
function* submit(
  fixture: Fixture,
  source: string,
  run: ReplExecution,
  counted?: Counted,
): Operation<readonly DurableEvent[]> {
  return yield* scoped(function* () {
    yield* useNodeReplHost("execution-1");
    yield* useHostFiles();
    yield* useWorkingDirectory(fixture.checkout);
    const installations = yield* replInstallations();
    // Absent for the row about a host that registers none: the entry then runs
    // on the ordinary Files provider with nothing retained.
    if (counted !== undefined) {
      yield* useCountedRecording(counted, managedRoot(fixture));
    }
    const session = opened(
      yield* submitReplEntry({
        execution: run,
        source,
        installations,
        generated: ordinaryGeneratedSelection(),
      }),
    );
    yield* session.join();
    return yield* run.stream.readAll();
  });
}

describe("how a REPL entry gets its repository behavior", () => {
  it("retains an admitted fragment's write and delete, and replays them", function* () {
    const fixture = yield* useFixture();
    const counted: Counted = { initialized: 0 };
    const run = execution();
    // A fragment that writes, a fragment that deletes, and a question nobody
    // answers — which is what leaves the entry unfinished, so reopening it is a
    // continuation rather than a reading of a settled history.
    const source = [
      `<Evaluate text={${JSON.stringify('<File path="generated.md">from a fragment</File>\n')}} allow={["write"]} />`,
      `<Evaluate text={${JSON.stringify('<File.Delete path="seed.md" />\n')}} allow={["write"]} />`,
      '<Elicit schema={{ type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false }} as="answer">Continue?</Elicit>',
    ].join("\n");

    const events = yield* scoped(function* () {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      yield* useCountedRecording(counted, managedRoot(fixture));
      const session = opened(
        yield* submitReplEntry({
          execution: run,
          source,
          installations,
          generated: ordinaryGeneratedSelection(),
        }),
      );
      yield* waitForQuestion(session);
      // Left at the question: this scope's teardown halts the entry, which is
      // what leaving through `[exit]` does.
      return yield* run.stream.readAll();
    });

    // The fragment's work happened, on the one Files route an authored
    // operation uses.
    expect(yield* readTextFile(join(fixture.checkout, "generated.md"))).toBe("from a fragment");
    expect(yield* exists(join(fixture.checkout, "seed.md"))).toBe(false);
    // And it is this entry's, recorded exactly as an authored mutation is.
    expect(recordsOf(events, REPL_REPOSITORY_LOCAL).length).toBe(2);
    expect(counted.initialized).toBe(1);

    // The checkout changes behind the records, and the entry is reopened at the
    // live head. A completed operation is answered from its record before any
    // of this execution's middleware is reached, so a provider that refuses
    // everything changes nothing about what it answers.
    yield* until(writeFile(join(fixture.checkout, "seed.md"), "put back\n"));
    yield* until(writeFile(join(fixture.checkout, "generated.md"), "edited by somebody else"));
    const again: Counted = { initialized: 0 };
    yield* scoped(function* () {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      // The document filesystem now refuses every mutation. A completed
      // operation is answered from its record without reaching a provider at
      // all, authored and generated alike.
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *writeTextFile() {
            throw new Error("the provider must not be reached by a replay");
          },
          // deno-lint-ignore require-yield
          *deleteFile() {
            throw new Error("the provider must not be reached by a replay");
          },
        },
        // The implementation slot, which is what "the provider" means: the
        // recording stands above it, so a completed operation answers from the
        // journal without delegating this far.
        { at: "min" },
      );
      yield* useCountedRecording(again, managedRoot(fixture));
      const session = opened(
        yield* openReplSession({
          execution: { id: "execution-1", stream: new InMemoryStream([...events]) },
          installations,
          generated: ordinaryGeneratedSelection(),
        }),
      );
      // The unfinished entry started once, and is holding its question again.
      yield* waitForQuestion(session);
      expect(again.initialized).toBe(1);
    });

    // Both external changes survive, which is what says neither completed
    // operation ran again: a replayed delete would have removed the file
    // somebody put back, and a replayed write would have overwritten their edit.
    expect(yield* readTextFile(join(fixture.checkout, "seed.md"))).toBe("put back\n");
    expect(yield* readTextFile(join(fixture.checkout, "generated.md"))).toBe(
      "edited by somebody else",
    );
  });

  it("denies a generated Dir, and performs nothing when access is denied", function* () {
    const fixture = yield* useFixture();
    const counted: Counted = { initialized: 0 };
    const run = execution();

    const source = [
      `<Evaluate text={${JSON.stringify('<Dir path="made">\n</Dir>\n')}} allow={["write"]} />`,
      `<Evaluate text={${JSON.stringify('<File path="refused.md">x</File>\n')}} allow={["read"]} />`,
    ].join("\n");

    const events = yield* submit(fixture, source, run, counted);

    // The write table is unchanged: carrying an ensure on the captured access
    // admits no generated `<Dir>`.
    expect(yield* exists(join(fixture.checkout, "made"))).toBe(false);
    // And a fragment admitted for reads performs no write at all.
    expect(yield* exists(join(fixture.checkout, "refused.md"))).toBe(false);
    expect(recordsOf(events, REPL_REPOSITORY_LOCAL)).toEqual([]);
  });

  it("E7: shares the recording with a generated File inside a managed Repository", function* () {
    const fixture = yield* useFixture();
    const origin = yield* useOrigin(fixture);
    const counted: Counted = { initialized: 0 };
    const run = execution();

    // An admitted generated `<File>` inside a managed Repository body, and two
    // generated selections beside it. The fragment's write crosses the same one
    // Files route an authored one does; the selections reach the generated
    // ceiling before any provider is asked.
    const source = [
      `<Repository name="project" url=${JSON.stringify(origin)}>`,
      `<Evaluate text={${JSON.stringify('<File path="generated.md">from a fragment</File>\n')}} allow={["write"]} />`,
      `<Evaluate text={${JSON.stringify(`<Repository name="other" url=${JSON.stringify(origin)} />\n`)}} allow={["write"]} />`,
      `<Evaluate text={${JSON.stringify('<Worktree name="other" branch="other" />\n')}} allow={["write"]} />`,
      `<Evaluate text={${JSON.stringify('<Dir path="made">\n</Dir>\n')}} allow={["write"]} />`,
      "</Repository>",
    ].join("\n");

    const events = yield* submit(fixture, source, run, counted);

    // One placement: the authored Repository. The generated Repository and
    // Worktree were never admitted, so neither reached a selector.
    const selected = recordsOf(events, REPL_REPOSITORY_PLACEMENT);
    expect(selected.length).toBe(1);
    const placement = parseReplPlacementRecord(
      selected[0]?.type === "yield" && selected[0].result.status === "ok"
        ? selected[0].result.value
        : undefined,
    );
    const checkout = placement?.outcome.ok === true ? placement.outcome.value.checkoutRoot : "";
    expect(checkout).not.toBe("");

    // The fragment's write happened in the managed checkout and is recorded
    // there, exactly as an authored one would be.
    expect(yield* readTextFile(join(checkout, "generated.md"))).toBe("from a fragment");
    expect(recordsOf(events, REPL_REPOSITORY_LOCAL).length).toBe(1);
    // And the generated `<Dir>` made nothing, in the managed checkout or
    // anywhere else.
    expect(yield* exists(join(checkout, "made"))).toBe(false);
    expect(yield* exists(join(fixture.checkout, "made"))).toBe(false);
  });

  it("E7: keeps two entries' equal records in their own segments", function* () {
    const fixture = yield* useFixture();
    const counted: Counted = { initialized: 0 };
    const run = execution();
    const source = '<File path="same.md">same</File>';

    yield* submit(fixture, source, run, counted);
    // Removed between the two entries, so whether the second one performed its
    // write is a question the filesystem answers rather than a counter.
    yield* rm(join(fixture.checkout, "same.md"));
    const events = yield* submit(fixture, source, run, counted);

    // One setup call per entry, prepared inside that entry rather than cached.
    expect(counted.initialized).toBe(2);
    const records = recordsOf(events, REPL_REPOSITORY_LOCAL);
    expect(records.length).toBe(2);
    const names = records.map((event) => (event.type === "yield" ? event.description.name : ""));
    // Equal work in two entries is one name, and that is allowed: nothing in a
    // record says which entry wrote it.
    expect(names[0]).toBe(names[1]);
    // What keeps them apart is the segment. The second entry replayed nothing
    // of the first entry's — it performed its own write, which is why the file
    // removed between them is back.
    expect(yield* exists(join(fixture.checkout, "same.md"))).toBe(true);
    expect(yield* readTextFile(join(fixture.checkout, "same.md"))).toBe("same");
  });

  it("E6: retains a generated read's text, and answers it after the file changes", function* () {
    const fixture = yield* useFixture();
    const counted: Counted = { initialized: 0 };
    const run = execution();
    // A fragment reads a file in the checkout, then the entry stops at a
    // question — so the read is completed and the entry is not. The fragment
    // binds the text rather than interpolating it: a generated fragment may not
    // read a binding, which is the ceiling's own rule and not this feature's.
    const source = [
      `<Evaluate text={${JSON.stringify('<File path="seed.md" as="held" />\n')}} allow={["read"]} />`,
      '<Elicit schema={{ type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false }} as="answer">Continue?</Elicit>',
    ].join("\n");

    const events = yield* scoped(function* () {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      yield* useCountedRecording(counted, managedRoot(fixture));
      const session = opened(
        yield* submitReplEntry({
          execution: run,
          source,
          installations,
          generated: ordinaryGeneratedSelection(),
        }),
      );
      yield* waitForQuestion(session);
      return yield* run.stream.readAll();
    });

    // One record, for the read a fragment performed on the one Files route,
    // carrying the exact text it answered with.
    const records = recordsOf(events, REPL_REPOSITORY_LOCAL);
    expect(records.length).toBe(1);
    expect(recordedText(records[0])).toBe("seed\n");

    // The file now says something else. A completed read is answered from what
    // it answered with the first time, so the binding a continuation offers is
    // the recorded one rather than the current text — and this execution's own
    // provider is never asked.
    yield* until(writeFile(join(fixture.checkout, "seed.md"), "changed by somebody else\n"));
    const again: Counted = { initialized: 0 };
    const continued: ReplExecution = {
      id: "execution-1",
      stream: new InMemoryStream([...events]),
    };
    const output = yield* scoped(function* () {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *readTextFile() {
            throw new Error("a completed read must not reach a provider");
          },
        },
        { at: "min" },
      );
      yield* useCountedRecording(again, managedRoot(fixture));
      const session = opened(
        yield* openReplSession({
          execution: continued,
          installations,
          generated: ordinaryGeneratedSelection(),
        }),
      );
      // Reaching the question again is the rule: the completed read was
      // answered from its record, because a provider that was asked would have
      // thrown instead.
      yield* waitForQuestion(session);
      return yield* continued.stream.readAll();
    });

    expect(again.initialized).toBe(1);
    // Nothing was appended for the read a second time.
    expect(recordsOf(output, REPL_REPOSITORY_LOCAL).length).toBe(1);
  });

  it("E9: retains nothing for a host that installs no setup", function* () {
    const fixture = yield* useFixture();
    const run = execution();

    const events = yield* submit(fixture, '<File path="plain.md">plain</File>', run);

    // The ordinary Files provider did the work, and nothing was recorded.
    expect(yield* readTextFile(join(fixture.checkout, "plain.md"))).toBe("plain");
    expect(recordsOf(events, REPL_REPOSITORY_LOCAL)).toEqual([]);
    expect(recordsOf(events, REPL_REPOSITORY_SELECTION)).toEqual([]);
  });

  it("prepares nothing for a settled history nobody is continuing", function* () {
    const fixture = yield* useFixture();
    const counted: Counted = { initialized: 0 };
    const run = execution();
    const events = yield* submit(fixture, SETTLED_ENTRY, run, counted);
    expect(counted.initialized).toBe(1);

    // Reopened as a reader, with every entry already settled.
    const reading: Counted = { initialized: 0 };
    yield* scoped(function* () {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      yield* useCountedRecording(reading, managedRoot(fixture));
      const session = opened(
        yield* openReplSession({
          execution: { id: "execution-1", stream: new InMemoryStream([...events]) },
          installations,
          generated: ordinaryGeneratedSelection(),
        }),
      );
      // Nothing is running, so there is nothing to join and nothing was prepared.
      expect(session.live).toBe(false);
    });
    expect(reading.initialized).toBe(0);
  });

  it("E7: refuses a history whose own record it cannot read, before new work", function* () {
    const fixture = yield* useFixture();
    const counted: Counted = { initialized: 0 };
    const run = execution();
    const source = [
      '<File path="recorded.md">recorded</File>',
      '<Elicit schema={{ type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false }} as="answer">Continue?</Elicit>',
      '<File path="after.md">after</File>',
    ].join("\n");

    const events = yield* scoped(function* () {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      yield* useCountedRecording(counted, managedRoot(fixture));
      const session = opened(
        yield* submitReplEntry({
          execution: run,
          source,
          installations,
          generated: ordinaryGeneratedSelection(),
        }),
      );
      yield* waitForQuestion(session);
      return yield* run.stream.readAll();
    });

    // A record of this feature's type that this version never wrote, standing
    // *past* where the entry stopped. Nothing replays it, so the operation-level
    // reader never looks at it: what refuses it is the admission the Git Plugin
    // contributes for this command, which reads the whole retained segment
    // before any of it is replayed.
    const tampered: readonly DurableEvent[] = [
      ...events,
      {
        type: "yield",
        coroutineId: "root",
        description: { type: REPL_REPOSITORY_LOCAL, name: "beyond-the-cursor" },
        result: { status: "ok", value: { version: 1, operation: "file-write" } },
      },
    ];

    const again: Counted = { initialized: 0 };
    const refusal = yield* scoped(function* (): Operation<string | undefined> {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      yield* useCountedRecording(again, managedRoot(fixture));
      try {
        const session = opened(
          yield* openReplSession({
            execution: { id: "execution-1", stream: new InMemoryStream([...tampered]) },
            installations,
            generated: ordinaryGeneratedSelection(),
          }),
        );
        if (session.live) {
          yield* session.join();
        }
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    // Raised rather than answered, and in this feature's own words.
    expect(refusal).toContain("is not one this host can read");
    // And refused before the work after the question: the suffix never ran.
    expect(yield* exists(join(fixture.checkout, "after.md"))).toBe(false);
  });

  it("records the entry's routing once, and no operation outside the checkout", function* () {
    const fixture = yield* useFixture();
    const counted: Counted = { initialized: 0 };
    const run = execution();

    const events = yield* submit(fixture, '<File path="note.md">first</File>', run, counted);
    expect(recordsOf(events, REPL_REPOSITORY_SELECTION).length).toBe(1);
    expect(recordsOf(events, REPL_REPOSITORY_LOCAL).length).toBe(1);
  });
});
