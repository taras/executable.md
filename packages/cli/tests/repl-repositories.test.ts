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
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { appendFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  parseReplLocalRecord,
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
} from "../src/repl/repositories/records.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
} from "../src/repl/repositories/placement-records.ts";
import { Execution } from "@executablemd/core/api";
import type { Json } from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { ordinaryGeneratedSelection } from "../src/evaluation-profile.ts";
import {
  replRepositoryInstallation,
  useReplRepositoryRecording,
} from "../src/repl/repositories/deno/provider.ts";
import type { HelperAssembly } from "@executablemd/git/credential-helper";
import { runGit } from "./support/fixture-git.ts";
import { gitPlugin } from "@executablemd/git";
import { replRepositoryPlugin } from "../src/repl/repositories/plugin.ts";
import { ReplHost } from "../src/repl/host.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import {
  createExecutionFile,
  executionPath,
  openExecutionFile,
  readRecords,
} from "../src/repl/journal.ts";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplExecution } from "../src/repl/journal.ts";
import type { ReplModel } from "../src/repl/model.ts";

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
  // The command's own assembly of the bundled Plugin, which is what a profile
  // carries: the vocabulary and the domain admissions come from Git, and the
  // admission that reads an entry's own repository history back belongs to this
  // command, so asking the bundled Plugin alone would declare nothing here.
  const bundled = replRepositoryPlugin(gitPlugin);
  const install = bundled.install;
  if (install === undefined) {
    throw new Error("the bundled Plugin installs nothing");
  }
  const installed = yield* install.call(bundled, { command: "repl", args: [] });
  if (installed === undefined) {
    throw new Error("the bundled Plugin declared nothing for the repl command");
  }
  return [{ admissions: [...(installed.admissions ?? [])] }];
}

/** One entry that settles, for the rows about a history nobody is continuing. */
import type { ReplEntryInstallation } from "../src/repl-entry-installation.ts";
import { registerComponents } from "@executablemd/core";
import { Component } from "@executablemd/core/api";
import { RepositoryContext, currentRepository } from "@executablemd/git/api";

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
    yield* runGit(root, ["init", "-b", "main", checkout], { home: root });
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
  // The same seam the per-entry factory registers on, because what this suite
  // is about is what an entry records rather than which host assembled it.
  yield* Execution.around({
    *init(_args, next): Operation<void> {
      yield* useReplRepositoryRecording({ helper: SUITE_HELPER, root });
      yield* next();
    },
  });
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
  yield* runGit(fixture.root, ["init", "-b", "main", origin], { home: fixture.root });
  yield* until(writeFile(join(origin, "README.md"), "origin\n"));
  yield* runGit(origin, ["add", "README.md"], { home: fixture.root });
  yield* runGit(origin, ["commit", "-m", "first"], { home: fixture.root });
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

/** The projected model, or the refusal the row reports instead of asserting past. */
function projected(events: readonly DurableEvent[]): ReplModel {
  const result = projectRepl(events);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** One named value out of a reading, named so a miss says what was there. */
function value(bindings: readonly { name: string; value: Json }[], name: string): Json {
  const found = bindings.find((binding) => binding.name === name);
  if (found === undefined) {
    throw new Error(`these bindings hold ${bindings.map((one) => one.name).join(", ")}`);
  }
  return found.value;
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

/**
 * Who this suite's entries commit under.
 *
 * `<Git.Commit>` borrows the invoking person's identity, read with `git var`
 * from the environment the command started in. A continuous-integration runner
 * commonly has none, so the row would fail for a reason about the runner. This
 * states one instead, through the seam the host reads it with.
 */
const STATED_IDENTITY: Readonly<Record<string, string | undefined>> = Object.freeze({
  GIT_AUTHOR_IDENT: "Suite Author <suite-author@example.test> 1700000000 +0000",
  GIT_COMMITTER_IDENT: "Suite Author <suite-author@example.test> 1700000000 +0000",
});

/** That identity, as the host reads one. */
// deno-lint-ignore require-yield
function* statedIdentity(variable: string): Operation<string | undefined> {
  return STATED_IDENTITY[variable];
}

/** How many commits this suite's repository host was actually asked to make. */
interface Committed {
  commits: number;
}

/**
 * The real repository handle, with each `commit` it is asked to perform counted.
 *
 * Counted below the `Git` Api rather than at it: the provider's own
 * implementation of `commit` consults the journal, so it is entered on a replay
 * and answers from the record. What a replay must not do is reach the
 * repository, and this method is where reaching it happens. The real one is
 * delegated to unchanged, so the commit and the refs it writes are real.
 */
function countingCommits(
  committed: Committed,
  helper: HelperAssembly,
): () => Operation<DenoRepositoryOperations> {
  return function* (): Operation<DenoRepositoryOperations> {
    const operations = yield* useDenoRepositoryOperations(helper);
    const wrapped: DenoRepositoryOperations = {
      ...operations,
      *commit(checkout, workingDirectory, message, messageSource, identity) {
        committed.commits += 1;
        return yield* operations.commit(
          checkout,
          workingDirectory,
          message,
          messageSource,
          identity,
        );
      },
    };
    return wrapped;
  };
}

/** The production REPL recording over that counted host. */
function* useCountedCommits(committed: Committed, fixture: Fixture): Operation<void> {
  yield* Execution.around({
    *init(_args, next): Operation<void> {
      yield* useReplRepositoryRecording({
        root: managedRoot(fixture),
        identity: statedIdentity,
        operations: countingCommits(committed, SUITE_HELPER),
      });
      yield* next();
    },
  });
}

/**
 * A checkout with a commit already in it, and one file left to stage.
 *
 * Its own rather than the shared fixture's: discovering the ambient repository
 * reads its head, so a checkout with no commit in it has no ambient owner for
 * a root `<Git.Commit>` to belong to.
 */
function* useCommittedCheckout(fixture: Fixture): Operation<string> {
  const checkout = join(fixture.root, "committed");
  yield* runGit(fixture.root, ["init", "-b", "main", checkout], { home: fixture.root });
  yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
  yield* runGit(checkout, ["add", "seed.md"], { home: fixture.root });
  yield* runGit(checkout, ["commit", "-m", "first"], { home: fixture.root });
  yield* until(writeFile(join(checkout, "note.md"), "note\n"));
  return checkout;
}

/** One entry that commits at its root and captures the object id. */
const COMMITS_AT_ROOT = [
  '<Git.Commit message="Record the note" as="proofCommit">',
  '<Git.Add paths="note.md" />',
  "</Git.Commit>",
  "",
  "Committed {proofCommit}.",
  "",
].join("\n");

/** One entry that consumes the object id the entry before it captured. */
const CONSUMES_THE_COMMIT = ["Earlier commit: {proofCommit}", ""].join("\n");

/** The same entry, held at a question after the commit it captured. */
const COMMITS_THEN_ASKS = [
  '<Git.Commit message="Record the note" as="proofCommit">',
  '<Git.Add paths="note.md" />',
  "</Git.Commit>",
  "",
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false }} as="answer">Continue?</Elicit>',
  "",
  "Committed {proofCommit}, answered {answer.decision}.",
  "",
].join("\n");

describe("a root capture a REPL entry commits (#939)", () => {
  it("P7: the commit id survives a cold reopen, and the commit is never made twice", function* () {
    const fixture = yield* useFixture();
    const checkout = yield* useCommittedCheckout(fixture);
    const committed: Committed = { commits: 0 };
    const journals = join(fixture.root, "journals");

    // One real commit, through a root `<Git.Commit as>` capture, over a journal
    // that is a file on disk.
    const first = yield* scoped(function* (): Operation<{ id: string; path: string }> {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(checkout);
      yield* useCountedCommits(committed, fixture);
      const created = yield* createExecutionFile(journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          source: COMMITS_AT_ROOT,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      const outcome = yield* session.join();
      if (!outcome.ok) {
        throw outcome.error;
      }
      const published = entryInitialBindings(session.model)["proofCommit"];
      if (typeof published !== "string") {
        throw new Error("the entry published no commit id");
      }
      return { id: published, path: executionPath(journals, "execution-1") };
    });

    expect(first.id).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.commits).toBe(1);

    // Reopened from the bytes on disk, by a session and a model this process has
    // not held before: nothing of the first run's event graph, projection or
    // live handles is reused.
    const reread = yield* readRecords(first.path);
    expect(reread.length).toBeGreaterThan(0);

    const consumed = yield* scoped(function* (): Operation<string> {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(checkout);
      yield* useCountedCommits(committed, fixture);
      const reopened = yield* openExecutionFile(journals, "execution-1");
      const session = opened(
        yield* openReplSession({
          execution: reopened,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      // A settled history is read, never resumed, so the capture is in the
      // record this reading derives rather than in anything that ran.
      expect(session.live).toBe(false);
      expect(entryInitialBindings(session.model)["proofCommit"]).toBe(first.id);
      const submitted = yield* session.submit(CONSUMES_THE_COMMIT);
      if (!submitted.ok) {
        throw submitted.error;
      }
      const outcome = yield* session.join();
      if (!outcome.ok) {
        throw outcome.error;
      }
      return session.model.entries[1]?.terminal?.output ?? "";
    });

    expect(consumed).toContain(`Earlier commit: ${first.id}`);
    // Reopening and consuming added no commit at all: the value came from the
    // record, and the repository was not asked to do the work again.
    expect(committed.commits).toBe(1);
  });

  it("P7: an unfinished entry resumes its suffix, repeats no commit, and settles it", function* () {
    const fixture = yield* useFixture();
    const checkout = yield* useCommittedCheckout(fixture);
    const committed: Committed = { commits: 0 };
    const run = execution();

    // Left at the question, which is what leaves the entry unfinished: the
    // commit before it is retained and the suffix after it is not.
    yield* scoped(function* () {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(checkout);
      yield* useCountedCommits(committed, fixture);
      const session = opened(
        yield* submitReplEntry({
          execution: run,
          source: COMMITS_THEN_ASKS,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      yield* waitForQuestion(session);
    });

    const retained = yield* run.stream.readAll();
    // The commit really happened and its own record is retained. The capture
    // has no record of its own — the commit's effect record is what the resume
    // restores it from — and the entry has settled nothing.
    expect(committed.commits).toBe(1);
    expect(retained.some((event) => event.type === "close")).toBe(false);
    expect(recordsOf(retained, "root_binding").length).toBe(0);

    // Resumed by a fresh session, which replays the retained prefix.
    const settled = yield* scoped(function* (): Operation<string> {
      yield* useNodeReplHost("execution-1");
      yield* useHostFiles();
      yield* useWorkingDirectory(checkout);
      yield* useCountedCommits(committed, fixture);
      const session = opened(
        yield* openReplSession({
          execution: run,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      yield* waitForQuestion(session);
      session.elicitation.pending?.submit({ decision: "go" });
      const outcome = yield* session.join();
      if (!outcome.ok) {
        throw outcome.error;
      }
      return session.model.entries[0]?.terminal?.output ?? "";
    });

    // The suffix ran and the commit did not: the capture came back from the
    // commit's own retained record, and the repository was asked for nothing a
    // second time.
    expect(settled).toContain("answered go");
    expect(committed.commits).toBe(1);
    const after = yield* run.stream.readAll();
    expect(after.slice(0, retained.length)).toEqual(retained);
    // Still no record of its own for the capture, at any point: what the
    // resumed entry hands on is in its ordinary settled result, which carries
    // the reconstructed commit id and the answer it went on to receive.
    expect(recordsOf(after, "root_binding").length).toBe(0);
    const projection = projected(after);
    const outcome = projection.entries[0]?.terminal;
    expect(outcome?.status).toBe("ok");
    expect(value(outcome?.bindings ?? [], "proofCommit")).toBe(
      entryInitialBindings(projection)["proofCommit"],
    );
    expect(value(outcome?.bindings ?? [], "answer")).toEqual({ decision: "go" });
  });
});

function d3SourceFactory(
  fixture: Fixture,
  path: string | undefined,
  read: () => void,
): ReplEntryInstallation {
  return function* (owner, placement) {
    const options = {
      ...placement,
      root: managedRoot(fixture),
      observeWorktree: path,
      *operations() {
        const operations = yield* useDenoRepositoryOperations();
        const counted: DenoRepositoryOperations = {
          ...operations,
          *observe(element, request, place) {
            read();
            return yield* operations.observe(element, request, place);
          },
        };
        return counted;
      },
    };
    const installed = yield* replRepositoryInstallation(owner, options);
    options.observeWorktree = join(fixture.root, "not-the-selected-root");
    return installed;
  };
}

function* d3SourceFixture(): Operation<Fixture> {
  const fixture = yield* useFixture();
  yield* useHostFiles();
  yield* useWorkingDirectory(fixture.checkout);
  yield* useNodeReplHost("execution-1");
  yield* runGit(fixture.checkout, ["add", "seed.md"], { home: fixture.root });
  yield* runGit(fixture.checkout, ["commit", "-m", "source base"], { home: fixture.root });
  return fixture;
}

describe("D3 — existing-root admission before directory effects", () => {
  for (const mode of ["missing", "replaced", "unregistered", "cross-repository"]) {
    it("refuses a " + mode + " root without creating or repairing it", function* () {
      const fixture = yield* d3SourceFixture();
      const path = join(fixture.root, "observed");
      if (mode === "replaced" || mode === "unregistered") {
        yield* runGit(fixture.checkout, ["worktree", "add", "-b", "observed", path], {
          home: fixture.root,
        });
        const pointer = yield* readTextFile(join(path, ".git"));
        yield* runGit(fixture.checkout, ["worktree", "remove", path], { home: fixture.root });
        yield* ensureDir(path);
        yield* writeTextFile(join(path, "seed.md"), "replacement\n");
        if (mode === "unregistered") {
          yield* writeTextFile(join(path, ".git"), pointer);
        }
      }
      if (mode === "cross-repository" || mode === "replaced") {
        yield* runGit(fixture.root, ["init", "-b", "main", path], { home: fixture.root });
        yield* writeTextFile(join(path, "other.md"), "other repository\n");
        yield* runGit(path, ["add", "other.md"], { home: fixture.root });
        yield* runGit(path, ["commit", "-m", "other"], { home: fixture.root });
      }
      const before = yield* exists(path);
      let reads = 0;
      const created = yield* createExecutionFile(join(fixture.root, "journals"), "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          projectCwd: fixture.checkout,
          entryInstallation: d3SourceFactory(fixture, path, () => {
            reads += 1;
          }),
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
          source: "<Dir path=" + JSON.stringify(path) + '><Git.Files as="files" /></Dir>',
        }),
      );
      expect((yield* session.join()).ok).toBe(false);
      expect(reads).toBe(0);
      expect(yield* exists(path)).toBe(before);
      expect(yield* exists(join(path, "created-by-entry"))).toBe(false);
      expect(yield* readTextFile(join(fixture.checkout, "seed.md"))).toBe("seed\n");
      expect(
        yield* runGit(fixture.checkout, ["status", "--porcelain"], { home: fixture.root }),
      ).toBe("");
    });
  }

  it("detaches the configured root and refuses a copied Repository selection", function* () {
    const fixture = yield* d3SourceFixture();
    const path = join(fixture.root, "observed");
    yield* runGit(fixture.checkout, ["worktree", "add", "-b", "observed", path], {
      home: fixture.root,
    });
    yield* registerComponents([
      {
        name: "CopiedSelection",
        origin: "fixture:d3",
        props: { type: "object", additionalProperties: false },
        fn: function* () {
          const current = yield* currentRepository();
          if (current === undefined) {
            throw new Error("D3 fixture lacks its ambient repository");
          }
          yield* RepositoryContext.around({ current: () => ({ ...current, checkoutPath: path }) });
          yield* Component.operations.content();
        },
      },
    ]);
    let reads = 0;
    const created = yield* createExecutionFile(join(fixture.root, "journals"), "execution-1");
    const session = opened(
      yield* submitReplEntry({
        execution: created,
        projectCwd: fixture.checkout,
        entryInstallation: d3SourceFactory(fixture, path, () => {
          reads += 1;
        }),
        installations: yield* replInstallations(),
        generated: ordinaryGeneratedSelection(),
        source: "<Dir path=" + JSON.stringify(path) + '><Git.Files as="files" /></Dir>',
      }),
    );
    const result = yield* session.join();
    if (!result.ok) {
      throw result.error;
    }
    expect(reads).toBe(1);
    const submitted = yield* session.submit(
      "<CopiedSelection><Dir path=" +
        JSON.stringify(path) +
        '><Git.Files as="files" /></Dir></CopiedSelection>',
    );
    expect(submitted.ok).toBe(true);
    expect((yield* session.join()).ok).toBe(false);
    expect(reads).toBe(1);
  });
});
