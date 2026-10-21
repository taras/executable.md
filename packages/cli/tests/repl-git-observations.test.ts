/**
 * What a REPL entry's local Git reads retain, inherit and read again.
 *
 * The four reads are the only thing in this suite that is new; everything
 * around them is the production REPL — a journal that is a file on disk, a
 * session and a model this process builds from those bytes, the Git Plugin's
 * own contribution for the `repl` command, and the per-entry recording core
 * initialization establishes. What that combination has to do is answer a
 * reopened entry from what it recorded, carry those answers to the entry after
 * it, and read the repository again when a new entry asks.
 *
 * ## Why the counters are on the host
 *
 * "Answered from the record" is only worth asserting if the alternative was
 * reachable. So the host beneath these entries counts every `git` invocation,
 * every scratch directory and every authentication session, and the rows that
 * expect nothing to have run assert on those rather than on the absence of a
 * difference.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { appendFile, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { denoRepositoryHost } from "../../git/src/deno/composition/host.ts";
import { gitSession } from "../../git/src/deno/composition/git.ts";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import type { GitObservationRequest } from "@executablemd/git/api";
import { useReplRepositoryRecording } from "../src/repl/repositories/deno/provider.ts";
import { gitPlugin } from "../../git/src/plugin.ts";
import { replRepositoryPlugin } from "../src/repl/repositories/plugin.ts";
import { REPL_REPOSITORY_OBSERVATION } from "../src/repl/repositories/observation-records.ts";
import { ordinaryGeneratedSelection } from "../src/evaluation-profile.ts";
import { ReplHost } from "../src/repl/host.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import { entryInitialBindings } from "../src/repl/model.ts";
import {
  createExecutionFile,
  executionPath,
  openExecutionFile,
  readRecords,
} from "../src/repl/journal.ts";
import type { ReplSession } from "../src/repl/session.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A synthetic GitHub token, format-realistic and assembled at run time. */
const CANARY = ["ghp", "_", ALPHABET].join("");

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly journals: string;
  /** The first commit, which every pinned read names. */
  readonly first: string;
  run(...args: string[]): Operation<string>;
}

/**
 * A committed checkout an entry is opened in.
 *
 * Committed, because a Repository identity is pinned at the commit HEAD named
 * when the entry opened: a checkout with no commit is one no selection can
 * name, which is a different story from this one.
 */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-git-reads-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    const git = gitSession(denoRepositoryHost(), root);
    yield* git.run(["init", "-b", "main", checkout], root);
    yield* git.run(["config", "user.name", "Fixture"], checkout);
    yield* git.run(["config", "user.email", "fixture@example.invalid"], checkout);
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    yield* until(writeFile(join(checkout, "notes.md"), "first notes\n"));
    yield* git.run(["add", "--", "seed.md", "notes.md"], checkout);
    yield* git.run(["commit", "-m", "first"], checkout);
    const head = yield* git.read(["rev-parse", "HEAD"], checkout);
    yield* provide({
      root,
      checkout,
      journals: join(root, "journals"),
      first: head ?? "",
      *run(...args: string[]): Operation<string> {
        const outcome = yield* git.run([...args], checkout);
        if (outcome.code !== 0) {
          throw new Error(`git ${args.join(" ")} exited ${outcome.code}: ${outcome.stderr}`);
        }
        return outcome.stdout.trim();
      },
    });
  });
}

interface Counted {
  /** What each observation this entry performed asked for, in order. */
  readonly reads: GitObservationRequest[];
}

function counters(): Counted {
  return { reads: [] };
}

/**
 * The reads these entries performed, by the kind each one asked for.
 *
 * The kind the element named, not the Git subcommand underneath it: two
 * different reads share `git diff`, so a subcommand could not tell which of
 * them ran.
 */
function reads(counted: Counted): string[] {
  return counted.reads.map((request) => request.kind);
}

/**
 * The production handle, with every observation it is asked to perform counted.
 *
 * The real method is delegated to unchanged, so what a row watches is a read
 * that really happened rather than one a substitute agreed to.
 */
function countingOperations(counted: Counted): () => Operation<DenoRepositoryOperations> {
  return function* (): Operation<DenoRepositoryOperations> {
    const operations = yield* useDenoRepositoryOperations();
    const wrapped: DenoRepositoryOperations = {
      ...operations,
      *observe(element, request, place) {
        counted.reads.push(request);
        return yield* operations.observe(element, request, place);
      },
    };
    return wrapped;
  };
}

/**
 * What a command contributes to an entry's execution.
 *
 * Taken from the Git Plugin's own contribution for the `repl` command rather
 * than written out here, because that contribution is the production path: the
 * admission that reads this feature's records travels with the vocabulary.
 */
function* replInstallations(): Operation<readonly ExecutionInstallation[]> {
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
function useCountedRecording(counted: Counted, root: string): Operation<void> {
  // The same seam the per-entry factory registers on, because what this suite
  // is about is what an entry records rather than which host assembled it.
  return Execution.around({
    *init(_args, next): Operation<void> {
      yield* useReplRepositoryRecording({ operations: countingOperations(counted), root });
      yield* next();
    },
  });
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Everything a row needs installed around one session. */
function* prepare(fixture: Fixture, counted: Counted): Operation<void> {
  yield* useNodeReplHost("execution-1");
  yield* useHostFiles();
  yield* useWorkingDirectory(fixture.checkout);
  yield* useCountedRecording(counted, join(fixture.root, "repositories"));
}

/** Wait until this session is holding a question. */
function* waitForQuestion(session: ReplSession): Operation<void> {
  const changes = yield* session.elicitation.changes;
  if (session.elicitation.pending !== undefined) {
    return;
  }
  yield* changes.next();
}

/** The four reads at root, each binding its page. */
const READS_AT_ROOT = (fixture: Fixture): string =>
  [
    '<Git.Files limit={100} as="files" />',
    "",
    '<Git.Changes compare="unstaged" as="changes" />',
    "",
    '<Git.Diff compare="unstaged" limit={100000} as="diff" />',
    "",
    `<Git.File commit="${fixture.first}" path="notes.md" as="source" />`,
    "",
    "Read {files.paths.length} paths.",
    "",
  ].join("\n");

/** How many observation records this history holds. */
function observationCount(records: readonly DurableEvent[]): number {
  return records.filter(
    (record) => record.type === "yield" && record.description.type === REPL_REPOSITORY_OBSERVATION,
  ).length;
}

describe("RGO1 — a reopened entry answers from what it recorded", () => {
  it("carries all four pages through a cold reopen and into the entry after it", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    yield* writeTextFile(join(fixture.checkout, "notes.md"), "edited notes\n");

    const first = yield* scoped(function* (): Operation<{
      bindings: Record<string, Json | undefined>;
      path: string;
      output: string;
    }> {
      yield* prepare(fixture, live);
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          source: READS_AT_ROOT(fixture),
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      const outcome = yield* session.join();
      if (!outcome.ok) {
        throw outcome.error;
      }
      return {
        bindings: entryInitialBindings(session.model),
        path: executionPath(fixture.journals, "execution-1"),
        output: session.model.entries[0]?.terminal?.output ?? "",
      };
    });

    expect(first.output).toContain("Read 2 paths.");
    expect(reads(live)).toContain("files");
    const recorded = yield* readRecords(first.path);
    expect(observationCount(recorded)).toBe(4);

    // Everything the first entry read is now gone.
    yield* rm(fixture.checkout, { recursive: true, force: true });

    const cold = counters();
    const reopened = yield* scoped(function* (): Operation<{
      bindings: Record<string, Json | undefined>;
      output: string;
    }> {
      yield* prepare(fixture, cold);
      const file = yield* openExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* openReplSession({
          execution: file,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      // A settled history is read, never resumed.
      expect(session.live).toBe(false);
      const inherited = entryInitialBindings(session.model);
      // Entry 2 inherits all four and renders selected members through Json.
      const submitted = yield* session.submit(
        [
          "Paths: {files.paths.length}",
          "",
          "<Json value={changes.comparison} />",
          "",
          "<Json value={diff.length} />",
          "",
          "<Json value={source.commit} />",
          "",
        ].join("\n"),
      );
      if (!submitted.ok) {
        throw submitted.error;
      }
      const outcome = yield* session.join();
      if (!outcome.ok) {
        throw outcome.error;
      }
      return {
        bindings: inherited,
        output: session.model.entries[1]?.terminal?.output ?? "",
      };
    });

    // The pages a fresh session and a fresh model derived from the bytes on
    // disk are the pages the first entry bound.
    for (const name of ["files", "changes", "diff", "source"]) {
      expect(`${name}: ${JSON.stringify(reopened.bindings[name])}`).toBe(
        `${name}: ${JSON.stringify(first.bindings[name])}`,
      );
    }
    expect(reopened.output).toContain("Paths: 2");
    expect(reopened.output).toContain(`"${fixture.first}"`);
    expect(reopened.output).toContain('"compare": "unstaged"');
    // And nothing live happened for any of it, with the checkout unavailable:
    // not one observation was performed, so nothing beneath one was acquired
    // either. That public construction acquires nothing is proved in
    // `packages/git/tests/run-composition-lazy.test.ts`.
    expect(reads(cold)).toEqual([]);
  });
});

describe("RGO2 — an unfinished entry restores its prefix and reads today", () => {
  it("resumes after a question and sees data the saved pages never held", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      '<Git.Files prefix="n" as="before" />',
      "",
      "Before: {before.paths.length}",
      "",
      '<Elicit schema={{ type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false }} as="answer">Continue?</Elicit>',
      "",
      '<Git.Files prefix="n" as="after" />',
      "",
      "After: {after.paths.length}, answered {answer.decision}.",
      "",
    ].join("\n");

    yield* scoped(function* () {
      yield* prepare(fixture, live);
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          source,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      yield* waitForQuestion(session);
    });

    const prefix = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    expect(observationCount(prefix)).toBe(1);
    expect(prefix.some((event) => event.type === "close")).toBe(false);

    // New data behind the question: a tracked path the saved page never held.
    yield* writeTextFile(join(fixture.checkout, "newer.md"), "newer\n");
    yield* fixture.run("add", "--", "newer.md");

    const resumed = counters();
    const settled = yield* scoped(function* (): Operation<string> {
      yield* prepare(fixture, resumed);
      const file = yield* openExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* openReplSession({
          execution: file,
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

    // The prefix answered from its record — one path, as it was — and the
    // suffix read live and found two.
    expect(settled).toContain("Before: 1");
    expect(settled).toContain("After: 2, answered go.");
    // Exactly one fresh read for the suffix.
    expect(reads(resumed)).toEqual(["files"]);
    const after = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    expect(observationCount(after)).toBe(2);
  });
});

describe("RGO3 — a recorded refusal is the same refusal next time", () => {
  it("replays an ordinary bad-revision refusal with no git", function* () {
    const fixture = yield* useFixture();
    const live = counters();
    const source = [
      "<PrintErrors>",
      '<Git.File commit="no-such-revision" path="notes.md" as="source" />',
      "Source: {source.text}",
      "</PrintErrors>",
      "",
    ].join("\n");

    const first = yield* scoped(function* (): Operation<string> {
      yield* prepare(fixture, live);
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          source,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      const outcome = yield* session.join();
      if (!outcome.ok) {
        throw outcome.error;
      }
      return session.model.entries[0]?.terminal?.output ?? "";
    });

    expect(first).toContain("names no commit in the selected repository");
    const records = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    expect(observationCount(records)).toBe(1);

    const replayed = counters();
    const again = yield* scoped(function* (): Operation<string> {
      yield* prepare(fixture, replayed);
      const file = yield* openExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* openReplSession({
          execution: file,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      return session.model.entries[0]?.terminal?.output ?? "";
    });

    expect(again).toBe(first);
    expect(reads(replayed)).toEqual([]);
  });
});

describe("RGO4 — two identical entries are two questions", () => {
  it("reads the repository again rather than answering from the entry before", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = [
      '<Git.Files prefix="n" as="files" />',
      "",
      "Paths: {files.paths.length}",
      "",
    ].join("\n");

    const outputs = yield* scoped(function* (): Operation<string[]> {
      yield* prepare(fixture, counted);
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          source,
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      const firstOutcome = yield* session.join();
      if (!firstOutcome.ok) {
        throw firstOutcome.error;
      }
      // Between the two identical entries, the repository changes.
      yield* writeTextFile(join(fixture.checkout, "newer.md"), "newer\n");
      yield* fixture.run("add", "--", "newer.md");
      const submitted = yield* session.submit(source);
      if (!submitted.ok) {
        throw submitted.error;
      }
      const secondOutcome = yield* session.join();
      if (!secondOutcome.ok) {
        throw secondOutcome.error;
      }
      return [
        session.model.entries[0]?.terminal?.output ?? "",
        session.model.entries[1]?.terminal?.output ?? "",
      ];
    });

    // The same source twice, and two different answers: each entry executes
    // against its own segment, so the second one read rather than replayed.
    expect(outputs[0]).toContain("Paths: 1");
    expect(outputs[1]).toContain("Paths: 2");
    expect(reads(counted).filter((kind) => kind === "files")).toHaveLength(2);
    const records = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    expect(observationCount(records)).toBe(2);
  });
});

describe("RGO5 — the secret gate still decides what reaches the journal", () => {
  it("keeps a canary the repository holds out of the journal, fatally", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // The canary is in the repository, not in the document: what a read carries
    // is host data, and the gate has to hold that to the same rule as a
    // document's own bytes.
    yield* writeTextFile(join(fixture.checkout, "token.md"), `token ${CANARY}\n`);
    yield* fixture.run("add", "--", "token.md");
    yield* fixture.run("commit", "-m", "token");
    const tainted = yield* fixture.run("rev-parse", "HEAD");

    const reported = yield* scoped(function* (): Operation<string> {
      yield* prepare(fixture, counted);
      const created = yield* createExecutionFile(fixture.journals, "execution-1");
      const session = opened(
        yield* submitReplEntry({
          execution: created,
          source: [
            `<Git.File commit="${tainted}" path="token.md" as="source" />`,
            "",
            "Read {source.length} characters.",
            "",
          ].join("\n"),
          installations: yield* replInstallations(),
          generated: ordinaryGeneratedSelection(),
        }),
      );
      const outcome = yield* session.join();
      return outcome.ok
        ? (session.model.entries[0]?.terminal?.output ?? "")
        : String(outcome.error);
    });

    // The read really happened, so the gate had something to refuse.
    expect(reads(counted)).toContain("file");
    // And nothing it carried reached the file on disk.
    const journal = yield* readTextFile(executionPath(fixture.journals, "execution-1"));
    expect(journal).not.toContain(CANARY);
    expect(reported).not.toContain(CANARY);
    // The existing classification: a detected secret ends the entry rather
    // than becoming a value a printing region could carry on past.
    expect(reported).toContain("secret");
    const records = yield* readRecords(executionPath(fixture.journals, "execution-1"));
    expect(observationCount(records)).toBe(0);
  });
});
