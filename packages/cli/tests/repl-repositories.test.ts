/**
 * R10/R13 — the REPL entry that owns a retained repository host.
 *
 * What this suite drives is the real session: the profile a command assembles,
 * the entry task that owns one entry, and the retained host that task builds
 * for it. No terminal is injected, because none of what is under test is drawn
 * — the terminal journey is `repl-repositories-pty.test.ts`, which runs the
 * actual command on a real pty. Here the question is ownership and ordering:
 * who builds the host, when, with whose identity, and what a view that executes
 * nothing acquires.
 *
 * Every scenario gets its own data root, checkout, managed root and bare
 * remote. Nothing is shared, because most of these assert what a *second* open
 * of one history does, and a shared checkout would make that depend on the
 * previous scenario's leftovers.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { exists } from "@effectionx/fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { rm } from "@effectionx/fs";
import { API, hostFilesHandler, useHostFiles } from "@executablemd/runtime";
import { useTempFileCompiler } from "@executablemd/core";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { HelperAssembly } from "@executablemd/git/credential-helper";
import {
  REPL_REPOSITORY_REQUEST,
  REPL_REPOSITORY_RESULT,
  parseReplRepositoryRequest,
  parseReplRepositoryResult,
} from "../../git/src/retained-repository/records.ts";
import { denoRepositoryHost, useRetainedRepositoryEntry } from "@executablemd/git/deno";
import { parseSelectionResult } from "../../git/src/deno/retained-repository/selections.ts";
import type { RepositoryHost } from "@executablemd/git/deno";
import type { GitInvocation, GitOutcome } from "../../git/src/deno/composition/host.ts";
import { gitHubSource } from "../../git/src/deno/composition/github.ts";
import type { GitHubAccess, GitHubHttpResponse } from "../../git/src/deno/composition/github.ts";
import { evidenceRoutes } from "../../git/tests/support/run-composition-tier.ts";
import {
  creations,
  fakeGitHubAccess,
  gitHubStore,
  issueCreations,
} from "../../git/tests/support/github.ts";
import type { GitHubStore } from "../../git/tests/support/github.ts";
import { denoReplEntryHost } from "../src/deno-repositories.ts";
import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import { installReplHost } from "../src/repl-assembly.ts";
import type { ReplEntryHostFactory, ReplEntryHostRequest } from "../src/repl-repositories.ts";
import { createExecutionFile, openExecutionFile, replRepository } from "../src/repl/journal.ts";
import { projectRepl } from "../src/repl/model.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import { useCompositionComponents } from "../../git/src/composition/installation.ts";

/** The credential-helper assembly this suite's host is given. */
const HELPER: HelperAssembly = {
  runtime: "source",
  platform: process.platform === "win32" ? "windows" : "unix",
  execPath: process.execPath,
  modulePath: join(import.meta.dirname ?? ".", "..", "src", "credential-helper-entry.ts"),
  launcherEnvironment: {},
};

/** Git for the fixture itself, with an environment nothing inherits from. */
function git(args: readonly string[], cwd: string, home: string): string {
  const outcome = spawnSync("git", [...args], {
    cwd,
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (outcome.status !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${outcome.stderr}`);
  }
  return outcome.stdout.trim();
}

interface Fixture {
  /** The directory every path of this world canonicalizes under. */
  readonly root: string;
  /** The data root the REPL keeps its histories under. */
  readonly data: string;
  /** The directory those histories live in. */
  readonly histories: string;
  /** The checkout this REPL is started in. */
  readonly checkout: string;
  /** Where managed checkouts would be placed. */
  readonly managed: string;
  /** A bare repository a `<Repository>` can be cloned from. */
  readonly remote: string;
  /** Every entry host this execution's entries asked for. */
  readonly asked: ReplEntryHostRequest[];
  /** The factory a profile carries, counting what it is asked for. */
  readonly entryHost: ReplEntryHostFactory;
}

/**
 * One REPL world: a data root, a checkout to be started in, a managed root and
 * a bare remote.
 *
 * The REPL host and the contextual working directory are installed here too,
 * because both are facts about the command a person ran: the directory an
 * ambient checkout is discovered from is the one the command started in.
 */
function* useFixture(
  // How this scenario spells the root it hands the host. A placement reached
  // through a symlink is the same directory as the one it points at, and a host
  // that derives two identities from the two spellings loses a write inside its
  // own selected checkout — so one scenario says it the other way on purpose.
  placement: "canonical" | "through a symlink" = "canonical",
): Operation<Fixture> {
  {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "xmd-repl-repos-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const data = join(root, "data");
    const checkout = join(root, "checkout");
    const placed = join(root, "placed");
    if (placement === "through a symlink") {
      yield* until(mkdir(placed, { recursive: true }));
      yield* until(symlink(placed, join(root, "link"), "dir"));
    }
    const managed =
      placement === "canonical" ? join(root, "managed") : join(root, "link", "managed");
    const remote = join(root, "remote.git");
    const home = join(root, "home");

    git(["init", "--bare", "-b", "main", remote], root, home);
    const seed = join(root, "seed");
    git(["clone", "--", remote, seed], root, home);
    yield* until(writeFile(join(seed, "seed.md"), "seed\n"));
    git(["add", "seed.md"], seed, home);
    git(["commit", "-m", "seed"], seed, home);
    git(["push", "origin", "main"], seed, home);
    git(["clone", "--", remote, checkout], root, home);
    git(["config", "user.name", "Entry"], checkout, home);
    git(["config", "user.email", "entry@example.invalid"], checkout, home);

    yield* installReplHost({
      dataRoot: () => data,
      identify: () => `execution-${Math.random().toString(16).slice(2, 10)}`,
      createExclusive: (path) =>
        import("node:fs/promises").then((fs) => fs.open(path, "wx").then((h) => h.close())),
      appendRecord: (path, record) =>
        import("node:fs/promises").then((fs) => fs.appendFile(path, record)),
    });
    // The directory this command was started in. The entry host reads it
    // through the same contextual Api an ordinary run reads it through.
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return checkout;
        },
      },
      { at: "min" },
    );
    // What every entrypoint installs, because `API.Files` has no host default.
    // The retained host's own layer sits inside this one and delegates the
    // mutations it retains.
    yield* useHostFiles();

    const asked: ReplEntryHostRequest[] = [];
    const inner = denoReplEntryHost(HELPER, managed);
    return {
      root,
      data,
      histories: join(data, "xmd", "repl"),
      checkout,
      managed,
      remote,
      asked,
      *entryHost(request) {
        asked.push(request);
        return yield* inner(request);
      },
    };
  }
}

/** What this suite's REPL declares to every entry it opens. */
function installations() {
  return [{ evaluation: ordinaryEvaluationProfile() }];
}

/** The repository a journey document names, which the host rewrites. */
const LOCATOR = "https://github.com/octo/project";

/** The same production host, with one locator standing in for another. */
function rewriting(to: string, inner: RepositoryHost): RepositoryHost {
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      const outcome = yield* inner.git({
        ...invocation,
        args: invocation.args.map((argument) => (argument === LOCATOR ? to : argument)),
      });
      return { ...outcome, stdout: outcome.stdout.split(to).join(LOCATOR) };
    },
    useDirectory: inner.useDirectory,
    ...(inner.useAuthentication === undefined
      ? {}
      : { useAuthentication: inner.useAuthentication }),
  };
}

/** The endpoint the modeled forge answers at. */
const ENDPOINT = "https://api.github.test";

/**
 * One access over the modeled forge and the modeled evidence beside it.
 *
 * The store answers everything it owns — the pull request this journey opens,
 * the issue it files — and the three evidence collections are canned bodies at
 * the routes the adapter reads them from. One access rather than two, because
 * one entry has one pull-request transport: a journey that needed two would be
 * proving something about the fixture.
 */
function forgeAccess(store: GitHubStore): GitHubAccess {
  const canned = Object.fromEntries(
    Object.entries(evidenceRoutes(ENDPOINT))
      // The pull request itself is the store's to describe: it is the one this
      // journey opened, and its head is the commit this journey made.
      .filter(([path]) => path !== "/repos/octo/project/pulls/4")
      // The number travels in the paths *and* in the subjects each body
      // names: an answer about another pull request is the wrong answer, and
      // the adapter says so.
      .map(([path, body]) => [
        path.replace("/4/", "/1/"),
        body.split("/pulls/4").join("/pulls/1").split("/issues/4").join("/issues/1"),
      ]),
  );
  const inner = fakeGitHubAccess(store, ENDPOINT);
  return {
    endpoint: ENDPOINT,
    token: () => inner.token(),
    *send(request): Operation<GitHubHttpResponse> {
      const path = new URL(request.url).pathname;
      // The checks of one commit are asked for by that commit, and an answer
      // about another one is the wrong answer — so the canned body is answered
      // under whichever head this journey actually made.
      const commit = /\/commits\/([0-9a-f]+)\//.exec(path)?.[1];
      const asked = commit === undefined ? path : path.replace(commit, "a".repeat(40));
      const canonical = canned[asked];
      const body =
        canonical === undefined || commit === undefined
          ? canonical
          : canonical.split("a".repeat(40)).join(commit);
      if (body !== undefined && request.method === "GET") {
        store.requests.push(request);
        return { status: 200, body };
      }
      return yield* inner.send(request);
    },
  };
}

/**
 * An entry host over a modeled forge, built the way the Deno one is.
 *
 * The same `useRetainedRepositoryEntry()` the shipped factory calls, with two
 * substitutions a journey cannot arrange for itself: the locator a document
 * writes stands for the bare repository beside the test, and the Git host it
 * publishes to and opens pull requests at is the model in the Git package's own
 * fixtures. Everything between those two boundaries is the shipped code.
 */
function forgeEntryHost(
  fixture: Fixture,
  store: GitHubStore,
  asked: ReplEntryHostRequest[],
): ReplEntryHostFactory {
  const host = rewriting(fixture.remote, denoRepositoryHost());
  return function* (request) {
    asked.push(request);
    const entry = yield* useRetainedRepositoryEntry({
      executionId: request.executionId,
      entryKey: request.entryKey,
      source: request.source,
      cwd: fixture.checkout,
      managedRoot: fixture.managed,
      host,
      files: hostFilesHandler(),
      gitHubIssues: {
        access: gitHubSource(fakeGitHubAccess(store)),
        configuration: { ceiling: [LOCATOR] },
      },
      gitHubPullRequests: {
        access: gitHubSource(forgeAccess(store)),
        configuration: { allowed: [LOCATOR] },
      },
    });
    return { installation: entry.installation, files: entry.files };
  };
}

/** How long one entry's own work may take before it reaches its question. */
const QUESTION_MS = 60_000;

/**
 * The question this session is waiting on.
 *
 * Subscribed before the pending one is read, because a signal delivers from
 * subscription time: checking first and subscribing after would lose a question
 * that arrived in between and wait forever for the next one.
 */
function* nextQuestion(session: ReplSession): Operation<ReplQuestion> {
  const changes = yield* session.elicitation.changes;
  if (session.elicitation.pending !== undefined) {
    return session.elicitation.pending;
  }
  const deadline = Date.now() + QUESTION_MS;
  while (true) {
    // Raced against a deadline, because an entry that failed before it could
    // ask asks nothing ever again: the signal never completes, and waiting on
    // it alone turns a refusal into a test that hangs and reports a pending
    // promise instead of what the entry said.
    const next = yield* race([
      changes.next(),
      (function* () {
        yield* sleep(50);
        return undefined;
      })(),
    ]);
    if (next === undefined) {
      if (Date.now() > deadline) {
        throw new Error(
          `this entry asked nothing within ${QUESTION_MS}ms. live=${session.live} output=` +
            JSON.stringify(session.overlay.output),
        );
      }
      continue;
    }
    if (next.done) {
      throw new Error(
        `this entry asked nothing and its questions ended. output=` +
          JSON.stringify(session.overlay.output),
      );
    }
    if (next.value !== undefined) {
      return next.value;
    }
  }
}

/** The program one entry's `<Evaluate>` runs, which writes inside the checkout. */
const FRAGMENT = '<File path="generated.md">generated\n</File>\n';

/** One execution of this REPL, named by its own host. */
function* useExecution(fixture: Fixture) {
  return yield* replRepository(fixture.histories).create();
}

/** The records one execution's history holds. */
function* recordsOf(execution: { readonly stream: { readAll(): Operation<DurableEvent[]> } }) {
  return yield* execution.stream.readAll();
}

/**
 * One execution whose history is exactly these records.
 *
 * Written through the host's own append, so what the session reads is a file
 * the REPL could have written. What makes it a *crafted* history is which
 * records it holds: a prefix of a real one, which is what an entry that was
 * interrupted leaves behind, and what a reopen has to continue from.
 */
function* useCraftedExecution(
  fixture: Fixture,
  events: readonly DurableEvent[],
  // The execution the records were written under. Kept, because the owner they
  // are retained under is this identifier and the entry's key: a history moved
  // to another execution is another owner's, which the entry refuses for its
  // own reason, and that is not what these scenarios are about.
  id: string,
) {
  const root = join(fixture.data, "xmd", "crafted", id);
  const execution = yield* createExecutionFile(root, id);
  for (const event of events) {
    yield* until(
      import("node:fs/promises").then((fs) =>
        // Already newline-terminated: a record is one line, and the
        // serializer writes the terminator.
        fs.appendFile(join(root, `${id}.jsonl`), serializeDurableEvent(event)),
      ),
    );
  }
  expect(execution.id).toBe(id);
  return yield* openExecutionFile(root, id);
}

/** The same history with its closes removed: one entry that never finished. */
function unfinished(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type !== "close");
}

/**
 * The directory each of these records was asked for in.
 *
 * Read out of the record's own authored request, which is where a file
 * operation says what it was asked to do: the working directory the document
 * was standing in and the path it named. A record carries no checkout state and
 * no selection token, so "which checkout did this write belong to" is answered
 * by resolving what it actually asked for.
 */
function directoriesOf(records: readonly { readonly request: Json }[]): string[] {
  return records.map((record) => {
    const request = record.request;
    const named =
      request !== null && typeof request === "object" && !Array.isArray(request)
        ? request["cwd"]
        : undefined;
    if (typeof named !== "string") {
      throw new Error(`this record names no working directory: ${JSON.stringify(request)}`);
    }
    return named;
  });
}

/** The recorded results of one operation this history holds. */
function resultsOf(events: readonly DurableEvent[], operation: string) {
  const held = [];
  for (const event of events) {
    if (
      event.type !== "yield" ||
      event.description.type !== REPL_REPOSITORY_RESULT ||
      event.result.status !== "ok"
    ) {
      continue;
    }
    const result = parseReplRepositoryResult(event.result.value ?? null);
    if (result !== undefined && result.operation === operation) {
      held.push(result);
    }
  }
  return held;
}

/** The resolved external requests of one operation this history holds. */
function requestsOf(events: readonly DurableEvent[], operation: string) {
  const held = [];
  for (const event of events) {
    if (
      event.type !== "yield" ||
      event.description.type !== REPL_REPOSITORY_REQUEST ||
      event.result.status !== "ok"
    ) {
      continue;
    }
    const request = parseReplRepositoryRequest(event.result.value ?? null);
    if (request !== undefined && request.operation === operation) {
      held.push(request);
    }
  }
  return held;
}

/** Where in the journal each durable type's records stand. */
function positionsOf(events: readonly DurableEvent[], type: string): number[] {
  const at: number[] = [];
  events.forEach((event, index) => {
    if (event.type === "yield" && event.description.type === type) {
      at.push(index);
    }
  });
  return at;
}

/** How many recorded results this history holds. */
function completions(events: readonly DurableEvent[]): number {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_RESULT,
  ).length;
}

describe("REPL repositories: one retained host per entry", () => {
  it("R10: each entry builds its own host, and the command builds none", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const execution = yield* useExecution(fixture);

    // Assembling the profile and opening the execution asked for no host at
    // all: a command is policy, and a history is a file.
    expect(fixture.asked).toHaveLength(0);

    const session = yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost: fixture.entryHost,
        source: '<File path="notes.md">first</File>\n',
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const outcome = yield* opened.value.join();
      if (!outcome.ok) {
        throw outcome.error;
      }
      const second = yield* opened.value.submit('<File path="later.md">second</File>\n');
      expect(second.ok).toBe(true);
      const settled = yield* opened.value.join();
      if (!settled.ok) {
        throw settled.error;
      }
      return opened.value;
    });
    expect(session.execution).toBe(execution.id);

    // One host per entry, each one asked for by the entry that is running and
    // named by the execution and that entry's own admitted key.
    expect(fixture.asked.map((request) => request.entryKey)).toEqual(["entry-1", "entry-2"]);
    expect(new Set(fixture.asked.map((request) => request.executionId))).toEqual(
      new Set([execution.id]),
    );

    // And the records they wrote are two different owners': the entry is half
    // of the owner, so the second entry inherits nothing the first established.
    const events = yield* recordsOf(execution);
    const owners = new Set(resultsOf(events, "file-write").map((intent) => intent.owner));
    expect(owners.size).toBe(2);
    expect(completions(events)).toBeGreaterThan(0);
  });

  it("R10: a cold view of a settled history builds no host and touches nothing", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const execution = yield* useExecution(fixture);

    // A live entry first, so there is something to be cold about.
    yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost: fixture.entryHost,
        source: '<File path="notes.md">first</File>\n',
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const settled = yield* opened.value.join();
      if (!settled.ok) {
        throw settled.error;
      }
    });
    expect(fixture.asked).toHaveLength(1);
    const after = (yield* recordsOf(execution)).length;
    const asked = fixture.asked.length;

    // The same history, opened to be read. Nothing executes, so nothing asks
    // for a host: no checkout is discovered, no lease is taken and the file
    // does not move.
    const cold = yield* scoped(function* () {
      const opened = yield* openReplSession({
        execution: yield* replRepository(fixture.histories).open(execution.id),
        installations: installations(),
        entryHost: fixture.entryHost,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      return opened.value.model.entries.length;
    });
    expect(cold).toBe(1);
    expect(fixture.asked).toHaveLength(asked);
    expect((yield* recordsOf(execution)).length).toBe(after);
    // And nothing was placed under the managed root either, which is where a
    // host that had been built would have put its first checkout.
    expect(yield* exists(fixture.managed)).toBe(false);
  });

  it("R10: a generated write inside the checkout is this entry's own, retained", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const execution = yield* useExecution(fixture);

    // An `<Evaluate>` fragment that writes inside the checkout this entry is
    // standing in. The ceiling is the command's — a generated program may
    // write a file and nothing else — and what it reaches is this entry's own
    // captured access, so the write is retained exactly as an authored one is.
    yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost: fixture.entryHost,
        source:
          '<File path="authored.md">authored\n</File>\n\n' +
          `<Evaluate text={${JSON.stringify(FRAGMENT)}} allow={["write"]} />\n`,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const settled = yield* opened.value.join();
      if (!settled.ok) {
        throw settled.error;
      }
    });

    const events = yield* recordsOf(execution);
    const written = resultsOf(events, "file-write");
    // Two writes, one authored and one generated, and they are two
    // occurrences of one entry: the fragment's write is its own effect, and it
    // reached this entry's own access rather than the command's.
    expect(written).toHaveLength(2);
    expect(JSON.stringify(written[1]?.request)).toContain("generated.md");
    expect(written[0]?.site.occurrence).not.toBe(written[1]?.site.occurrence);
    expect(new Set(written.map((intent) => intent.owner)).size).toBe(1);
    expect(yield* exists(join(fixture.checkout, "generated.md"))).toBe(true);
  });

  it("R10: a refused entry and an unresolvable location build no host", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const execution = yield* useExecution(fixture);

    // Preflight refuses this entry's source, so nothing is admitted and
    // nothing is asked for: validation is a reading of the document.
    yield* scoped(function* () {
      const refused = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost: fixture.entryHost,
        source: "<Unknown.Component />\n",
      });
      expect(refused.ok).toBe(false);
    });
    expect(fixture.asked).toHaveLength(0);
    expect(yield* recordsOf(execution)).toHaveLength(0);
    expect(yield* exists(fixture.managed)).toBe(false);
  });

  it("R10/R11: reopening an interrupted entry continues its work once", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const first = yield* useExecution(fixture);

    const source = [
      '<File path="notes.md">prepared</File>',
      '<Git.Add paths="notes.md" />',
      '<Git.Commit message="Prepare" as="commit" />',
      '<File path="later.md">later</File>',
      "",
      "committed {commit.commit}",
    ].join("\n");
    yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution: first,
        installations: installations(),
        entryHost: fixture.entryHost,
        source,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const settled = yield* opened.value.join();
      if (!settled.ok) {
        throw settled.error;
      }
    });
    const whole = yield* recordsOf(first);
    const committed = git(["rev-parse", "HEAD"], fixture.checkout, fixture.checkout);

    // The same entry, cut where its last write was not yet asked for: the
    // prefix a process that stopped there would have left. The file that write
    // created is removed with it, because the state the prefix describes is the
    // state before it — and an entry whose checkout holds work its history does
    // not account for refuses rather than continuing.
    const asked = fixture.asked.length;
    const retained = positionsOf(whole, REPL_REPOSITORY_RESULT);
    const cut = retained[retained.length - 1] ?? 0;
    const interrupted = yield* useCraftedExecution(
      fixture,
      unfinished(whole).slice(0, cut),
      first.id,
    );
    yield* rm(join(fixture.checkout, "later.md"), { force: true });

    yield* scoped(function* () {
      const opened = yield* openReplSession({
        execution: interrupted,
        installations: installations(),
        entryHost: fixture.entryHost,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const settled = yield* opened.value.join();
      if (!settled.ok) {
        throw settled.error;
      }
    });

    // One continuation, by one host this entry asked for: the records before
    // the cut replayed, the write after it was performed once, and the commit
    // this entry had already made was not made again.
    expect(fixture.asked.length).toBe(asked + 1);
    expect(fixture.asked[asked]?.entryKey).toBe("entry-1");
    expect(yield* exists(join(fixture.checkout, "later.md"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], fixture.checkout, fixture.checkout)).toBe(committed);
    expect(git(["rev-list", "--count", "HEAD"], fixture.checkout, fixture.checkout)).toBe("2");
  });

  it("R10: a frozen view of an unfinished entry continues nothing until it is left", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const execution = yield* useExecution(fixture);

    // A real entry first, so the prefix below is one the product wrote rather
    // than one this test invented: a write, a commit, and a second write.
    const source = [
      '<File path="notes.md">prepared</File>',
      '<Git.Add paths="notes.md" />',
      '<Git.Commit message="Prepare" as="commit" />',
      '<File path="later.md">later</File>',
      "",
      "committed {commit.commit}",
    ].join("\n");
    yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost: fixture.entryHost,
        source,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const settled = yield* opened.value.join();
      if (!settled.ok) {
        throw settled.error;
      }
    });
    const whole = yield* recordsOf(execution);
    const committed = git(["rev-parse", "HEAD"], fixture.checkout, fixture.checkout);

    // The same entry, cut before its last write and with that write's file
    // removed: an entry that stopped there, which a later open continues.
    const retained = positionsOf(unfinished(whole), REPL_REPOSITORY_RESULT);
    const cut = retained[retained.length - 1] ?? 0;
    const events = unfinished(whole).slice(0, cut);
    const interrupted = yield* useCraftedExecution(fixture, events, execution.id);
    yield* rm(join(fixture.checkout, "later.md"), { force: true });

    // A position this prefix itself holds, which is what a location names.
    const projected = projectRepl(events);
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.entries.at(-1)?.settled).toBe(false);
    const frozen = projected.value.checkpoints.at(-1)?.marker;
    if (frozen === undefined) {
      throw new Error("this prefix holds no history position to freeze at");
    }

    const asked = fixture.asked.length;
    yield* scoped(function* () {
      const cold = yield* openReplSession({
        execution: interrupted,
        selection: frozen,
        installations: installations(),
        entryHost: fixture.entryHost,
      });
      if (!cold.ok) {
        throw cold.error;
      }

      // 1. Frozen, and therefore a reading: nothing runs, nothing is asked and
      //    no host exists, so no lease, credential or scratch directory does
      //    either. The work the prefix stops before has not happened.
      expect(cold.value.live).toBe(false);
      expect(cold.value.elicitation.pending).toBeUndefined();
      expect(fixture.asked).toHaveLength(asked);
      expect(yield* exists(join(fixture.checkout, "later.md"))).toBe(false);

      // 2. Back to the head, which is what the public control does. Said twice,
      //    because a driver says it on every frame that stands there — and the
      //    entry is live from the first word, which is the part that is decided
      //    without suspending.
      yield* cold.value.resume();
      yield* cold.value.resume();
      expect(cold.value.live).toBe(true);

      const settled = yield* cold.value.join();
      if (!settled.ok) {
        throw settled.error;
      }

      // 3. One continuation, by one host, for the entry that was unfinished:
      //    the second word above started nothing, and a word after the entry
      //    settled starts nothing either.
      yield* cold.value.resume();
      expect(fixture.asked).toHaveLength(asked + 1);
      expect(fixture.asked[asked]?.entryKey).toBe("entry-1");
    });
    expect(yield* exists(join(fixture.checkout, "later.md"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], fixture.checkout, fixture.checkout)).toBe(committed);
    expect(git(["rev-list", "--count", "HEAD"], fixture.checkout, fixture.checkout)).toBe("2");
  });

  it("R10: a view change leaves the entry that is already running alone", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const execution = yield* useExecution(fixture);

    // An entry that is still running when the view moves: it stands at a
    // question, which is the one state a person has time to navigate in.
    const source = [
      "```js eval",
      'const ask = { type: "object", properties: { ok: { type: "string" } }, ' +
        'required: ["ok"], additionalProperties: false };',
      "```",
      '<File path="running.md">running</File>',
      '<Git.Add paths="running.md" />',
      '<Git.Commit message="Running" as="commit" />',
      '<Elicit schema={ask} as={"answer"}>Ready?</Elicit>',
      "",
      "answered {answer.ok}",
    ].join("\n");

    yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost: fixture.entryHost,
        source,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const session = opened.value;
      const question = yield* nextQuestion(session);
      expect(fixture.asked).toHaveLength(1);

      // The driver returning to the head while that entry runs. Nothing is
      // started beside it and nothing is taken from it: the same question is
      // still the one waiting, and answering it still settles the entry.
      yield* session.resume();
      yield* session.resume();
      expect(fixture.asked).toHaveLength(1);
      expect(session.live).toBe(true);
      expect(session.elicitation.pending).toBe(question);

      expect(question.submit({ ok: "yes" }).kind).toBe("answered");
      const settled = yield* session.join();
      if (!settled.ok) {
        throw settled.error;
      }
      expect(session.overlay.output).toContain("answered yes");
    });
    expect(resultsOf(yield* recordsOf(execution), "commit")).toHaveLength(1);
  });

  for (const placement of ["canonical", "through a symlink"] as const) {
    it(`R3/R6: a managed placement ${placement} owns the writes inside it`, function* () {
      const fixture = yield* useFixture(placement);
      yield* useTempFileCompiler();
      yield* useCompositionComponents();
      const execution = yield* useExecution(fixture);

      // An explicit `<Repository>`, two writes inside it — one authored and
      // one from a generated program — and the stage that follows. Both have to
      // be *this entry's*, in the checkout it selected, and the Add after them
      // has to find a checkout its own history accounts for.
      const source = [
        `<Repository name="project" url="${LOCATOR}">`,
        '<File path="placed.md">placed</File>',
        `<Evaluate text={${JSON.stringify(FRAGMENT)}} allow={["write"]} />`,
        '<Git.Add paths="." />',
        '<Git.Commit message="Placed" as="commit" />',
        "</Repository>",
        "",
        "committed {commit.commit}",
      ].join("\n");

      const output = yield* scoped(function* () {
        const opened = yield* submitReplEntry({
          execution,
          installations: installations(),
          entryHost: forgeEntryHost(fixture, gitHubStore({ token: "placement" }), []),
          source,
        });
        if (!opened.ok) {
          throw opened.error;
        }
        const settled = yield* opened.value.join();
        if (!settled.ok) {
          throw settled.error;
        }
        return opened.value.overlay.output;
      });

      // The write is retained, and so is the Add after it: a write this host
      // did not recognize as its own would leave no intent here, and the Add
      // would have refused a change nothing accounts for.
      const events = yield* recordsOf(execution);
      const writes = resultsOf(events, "file-write");
      expect(writes).toHaveLength(2);
      expect(resultsOf(events, "add")).toHaveLength(1);
      expect(resultsOf(events, "commit")).toHaveLength(1);
      expect(completions(events)).toBe(resultsOf(events, "repository").length + writes.length + 2);

      // Under one canonical identity, whichever way the root was spelled: the
      // checkout the selection's own result names is the path the filesystem
      // answers with, and it is inside this world's own canonical root.
      const selected = resultsOf(events, "repository")[0]?.result;
      const selection = selected === undefined ? undefined : parseSelectionResult(selected);
      if (selection === undefined) {
        throw new Error(`this selection's record is unreadable: ${JSON.stringify(selected)}`);
      }
      const named = selection.checkout;
      expect(named).toBe(yield* until(realpath(named)));
      expect(named.startsWith(fixture.root)).toBe(true);
      expect(named.includes("/link/")).toBe(false);

      // Both writes were asked for *in* that checkout — the authored one and
      // the generated one alike — and neither named the directory the command
      // was started in.
      expect(directoriesOf(writes)).toEqual([named, named]);
      expect(yield* exists(join(fixture.checkout, "generated.md"))).toBe(false);

      // The bytes are where the document put them, staged, and committed.
      expect(yield* until(readFile(join(named, "placed.md"), "utf8"))).toBe("placed");
      expect(yield* until(readFile(join(named, "generated.md"), "utf8"))).toBe("generated\n");
      expect(git(["show", "HEAD:placed.md"], named, fixture.checkout)).toBe("placed");
      expect(git(["show", "HEAD:generated.md"], named, fixture.checkout)).toBe("generated");
      expect(output).toContain("committed ");

      // And the history reopens: a settled entry projected from records that
      // name one checkout, with nothing left to continue and no host built.
      const asked = fixture.asked.length;
      const reopened = yield* scoped(function* () {
        const opened = yield* openReplSession({
          execution: yield* replRepository(fixture.histories).open(execution.id),
          installations: installations(),
          entryHost: fixture.entryHost,
        });
        if (!opened.ok) {
          throw opened.error;
        }
        return opened.value.model.entries[0]?.settled;
      });
      expect(reopened).toBe(true);
      expect(fixture.asked).toHaveLength(asked);
    });
  }

  it("R6: a generated write in a continuation belongs to the selected checkout", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const execution = yield* useExecution(fixture);
    const entryHost = forgeEntryHost(fixture, gitHubStore({ token: "continued" }), []);

    // The question stands *before* the `<Evaluate>`, so the fragment runs in a
    // continuation and nowhere else: whatever directory a replayed selection
    // leaves behind is the directory that write is resolved against.
    const source = [
      "```js eval",
      'const ask = { type: "object", properties: { ok: { type: "string" } }, ' +
        'required: ["ok"], additionalProperties: false };',
      "```",
      "",
      `<Repository name="project" url="${LOCATOR}">`,
      '<File path="authored.md">authored</File>',
      '<Elicit schema={ask} as="ready">Ready?</Elicit>',
      `<Evaluate text={${JSON.stringify(FRAGMENT)}} allow={["write"]} />`,
      '<Git.Add paths="." />',
      '<Git.Commit message="Continued" as="commit" />',
      "</Repository>",
      "",
      "committed {commit.commit} after {ready.ok}",
    ].join("\n");

    /**
     * The records the file holds now.
     *
     * Through a fresh open, because a continuation appends through its own
     * handle: the handle this entry was submitted with stops where that
     * invocation stopped, and reading it would report the continuation's work
     * as missing.
     */
    function* recordsNow(): Operation<DurableEvent[]> {
      return yield* recordsOf(yield* replRepository(fixture.histories).open(execution.id));
    }

    /** Reopen this history the way a later invocation does. */
    function* reopened(): Operation<ReplSession> {
      const opened = yield* openReplSession({
        execution: yield* replRepository(fixture.histories).open(execution.id),
        installations: installations(),
        entryHost,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      return opened.value;
    }

    // 1. Left standing at the question, with the authored write done and the
    //    generated one not started.
    yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost,
        source,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const question = yield* nextQuestion(opened.value);
      expect(question.message).toContain("Ready?");
    });

    const left = yield* recordsNow();
    const placement = resultsOf(left, "repository")[0]?.result;
    const selection = placement === undefined ? undefined : parseSelectionResult(placement);
    if (selection === undefined) {
      throw new Error(`this selection's record is unreadable: ${JSON.stringify(placement)}`);
    }
    const selected = selection.checkout;
    expect(directoriesOf(resultsOf(left, "file-write"))).toEqual([selected]);
    expect(yield* exists(join(selected, "generated.md"))).toBe(false);

    // 2. Reopened and answered: the fragment runs now, in the continuation.
    const output = yield* scoped(function* () {
      const session = yield* reopened();
      const question = yield* nextQuestion(session);
      expect(question.submit({ ok: "yes" }).kind).toBe("answered");
      const settled = yield* session.join();
      if (!settled.ok) {
        throw settled.error;
      }
      return session.overlay.output;
    });
    expect(output).toContain("after yes");

    // Its write belongs to the same checkout the authored one did, is retained
    // there, and left nothing where the command was started.
    const events = yield* recordsNow();
    const writes = resultsOf(events, "file-write");
    expect(directoriesOf(writes)).toEqual([selected, selected]);
    expect(yield* until(readFile(join(selected, "generated.md"), "utf8"))).toBe("generated\n");
    expect(yield* exists(join(fixture.checkout, "generated.md"))).toBe(false);
    // Staged and committed with the authored one, which is the Add and the
    // Commit agreeing with the document about which checkout this is.
    expect(git(["show", "HEAD:generated.md"], selected, fixture.checkout)).toBe("generated");
    expect(git(["show", "HEAD:authored.md"], selected, fixture.checkout)).toBe("authored");

    // 3. Reopened once more. Nothing is performed again: the same two writes,
    //    the same commit, and the file untouched.
    const commit = git(["rev-parse", "HEAD"], selected, fixture.checkout);
    const asked = fixture.asked.length;
    const settled = yield* scoped(function* () {
      return (yield* reopened()).model.entries[0]?.settled;
    });
    expect(settled).toBe(true);
    expect(resultsOf(yield* recordsNow(), "file-write")).toHaveLength(2);
    expect(completions(yield* recordsNow())).toBe(completions(events));
    expect(git(["rev-parse", "HEAD"], selected, fixture.checkout)).toBe(commit);
    expect(fixture.asked).toHaveLength(asked);
  });

  it("R11: one entry's whole repository journey, left and reopened", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const store = gitHubStore({ token: "journey-credential" });
    store.resolveHead = (branch) =>
      git(["rev-parse", branch], fixture.remote, fixture.checkout) || undefined;
    const asked: ReplEntryHostRequest[] = [];
    const entryHost = forgeEntryHost(fixture, store, asked);
    const execution = yield* useExecution(fixture);

    // Everything one entry can do to a repository, in the order a person
    // writes it: a managed checkout of its own, a linked worktree inside it, a
    // generated file, an authored directory, a branch, a commit, a publication,
    // a pull request, the three evidence collections and a deferred issue —
    // with an ordinary question after the local work and another after the
    // external work, which is where this entry is going to be left.
    const source = [
      "```js eval",
      'const ask = { type: "object", properties: { ok: { type: "string" } }, ' +
        'required: ["ok"], additionalProperties: false };',
      "```",
      "",
      `<Repository name="project" url="${LOCATOR}">`,
      `<Git.Switch branch="publish/1.4" />`,
      `<Dir path="notes">`,
      `<File path="authored.md">authored</File>`,
      `</Dir>`,
      `<Evaluate text={${JSON.stringify(FRAGMENT)}} allow={["write"]} />`,
      `<Git.Add paths="." />`,
      `<Git.Commit message="Prepare 1.4" as="commit" />`,
      `<Elicit schema={ask} as="local">Local work ready?</Elicit>`,
      `<Git.Push />`,
      `<PullRequest title="Prepare 1.4" as="pullRequest">`,
      "the body",
      "</PullRequest>",
      `<PullRequest.Reviews url="${LOCATOR}/pull/1" as="reviews" />`,
      `<PullRequest.Comments url="${LOCATOR}/pull/1" as="comments" />`,
      `<PullRequest.Checks url="${LOCATOR}/pull/1" as="checks" />`,
      `<Elicit schema={ask} as="external">External work ready?</Elicit>`,
      `<Worktree name="review" branch="review/1.4">`,
      `<File path="review.md">reviewing</File>`,
      `</Worktree>`,
      `<IssueTracker url="${LOCATOR}">`,
      `<Issue title="Follow up on 1.4" as="filed">`,
      "the description",
      "</Issue>",
      `</IssueTracker>`,
      `</Repository>`,
      "",
      "opened {pullRequest.number} at {commit.commit} filed {filed.url}",
      "read {reviews.length} {comments.length} {checks.length}",
      "answered {local.ok} {external.ok}",
    ].join("\n");

    /**
     * The records the file holds now.
     *
     * Read through a fresh open rather than through the handle the first
     * invocation wrote with: each continuation appends through its own handle,
     * and the first one's view of the stream stops where that invocation did.
     * Asking the handle would have read a journal that ends at the first leave
     * and called the work after it missing.
     */
    function* recordsNow(): Operation<DurableEvent[]> {
      return yield* recordsOf(yield* replRepository(fixture.histories).open(execution.id));
    }

    /** Reopen the history this execution is, the way a later invocation does. */
    function* reopened(): Operation<ReplSession> {
      const opened = yield* openReplSession({
        execution: yield* replRepository(fixture.histories).open(execution.id),
        installations: installations(),
        entryHost,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      return opened.value;
    }

    // 1. Submitted, and left standing at the first question — the scope goes
    //    with nothing answered, which is a person walking away from a terminal
    //    rather than an entry that failed.
    yield* scoped(function* (): Operation<void> {
      const opened = yield* submitReplEntry({
        execution,
        installations: installations(),
        entryHost,
        source,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const question = yield* nextQuestion(opened.value);
      expect(question.message).toContain("Local work ready?");
    });

    // The local work is done and the external work has not started: the entry
    // reached a question that stands after one and before the other.
    const left = yield* recordsNow();
    expect(resultsOf(left, "commit")).toHaveLength(1);
    expect(requestsOf(left, "push")).toHaveLength(0);
    expect(creations(store)).toBe(0);

    // 2. Reopened, answered, and left again at the second question. Everything
    //    before the first question replays from its records: the clone, the
    //    branch, the writes and the commit are not done a second time.
    const beforeSecond = yield* scoped(function* (): Operation<number> {
      const session = yield* reopened();
      const first = yield* nextQuestion(session);
      expect(first.message).toContain("Local work ready?");
      expect(first.submit({ ok: "yes" }).kind).toBe("answered");
      const second = yield* nextQuestion(session);
      expect(second.message).toContain("External work ready?");
      return store.requests.length;
    });

    // The publication and the pull request happened once, between the two
    // questions, and the forge was asked for them exactly once.
    expect(requestsOf(yield* recordsNow(), "push")).toHaveLength(1);
    expect(creations(store)).toBe(1);
    expect(issueCreations(store)).toBe(0);

    // 3. Reopened again, answered, and settled. The external work replays from
    //    its records, so the forge is asked nothing more for it.
    const output = yield* scoped(function* (): Operation<string> {
      const session = yield* reopened();
      const question = yield* nextQuestion(session);
      expect(question.message).toContain("External work ready?");
      expect(question.submit({ ok: "yes" }).kind).toBe("answered");
      const settled = yield* session.join();
      if (!settled.ok) {
        throw settled.error;
      }
      return session.overlay.output;
    });
    // Replaying the publication, the pull request and the three evidence reads
    // asked the forge nothing of its own: every request this continuation made
    // belongs to the issue after them, which is the one boundary it had not
    // reached. Named by what each request is for rather than by how many there
    // are, because how many an issue takes is the worker's business.
    expect(
      store.requests.slice(beforeSecond).map((request) => new URL(request.url).pathname),
    ).toEqual(
      store.requests
        .slice(beforeSecond)
        .map((request) => new URL(request.url).pathname)
        .filter((pathname) => pathname.includes("/issues")),
    );
    expect(store.requests.length).toBeGreaterThan(beforeSecond);
    expect(output).toContain("answered yes yes");

    // The work happened, once each: a branch at the remote, a pull request and
    // an issue at the forge, and the files where the document put them.
    expect(output).toContain("opened 1");
    expect(output).toContain("read 1 2 2");
    expect(creations(store)).toBe(1);
    expect(issueCreations(store)).toBe(1);
    const events = yield* recordsNow();
    expect(resultsOf(events, "repository")).toHaveLength(1);
    expect(resultsOf(events, "worktree")).toHaveLength(1);
    expect(requestsOf(events, "push")).toHaveLength(1);
    expect(requestsOf(events, "pull-request")).toHaveLength(1);
    expect(resultsOf(events, "commit")).toHaveLength(1);
    // Two writes inside the repository's own checkout and one inside the
    // worktree, each its own occurrence of one entry.
    expect(resultsOf(events, "file-write")).toHaveLength(3);
    expect(resultsOf(events, "dir-ensure")).toHaveLength(1);

    // Settled, and reopened once more: the whole entry is projected, and this
    // time nothing is asked, nothing is performed and no host is built at all.
    const forgeCalls = store.requests.length;
    const hosts = asked.length;
    const settled = yield* scoped(function* () {
      return (yield* reopened()).model.entries[0]?.settled;
    });
    expect(settled).toBe(true);
    expect(store.requests).toHaveLength(forgeCalls);
    expect(creations(store)).toBe(1);
    expect(issueCreations(store)).toBe(1);
    expect(asked).toHaveLength(hosts);
    // One host per continuation, each for the same entry: three times the entry
    // ran, three hosts, and the settled view above built none.
    expect(asked).toHaveLength(3);
    expect(new Set(asked.map((request) => request.entryKey))).toEqual(new Set(["entry-1"]));
  });

  it("R2/R13: a record retained under another entry grants this one nothing", function* () {
    const fixture = yield* useFixture();
    yield* useTempFileCompiler();
    yield* useCompositionComponents();
    const first = yield* useExecution(fixture);

    yield* scoped(function* () {
      const opened = yield* submitReplEntry({
        execution: first,
        installations: installations(),
        entryHost: fixture.entryHost,
        source: '<File path="notes.md">prepared</File>\n',
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const settled = yield* opened.value.join();
      if (!settled.ok) {
        throw settled.error;
      }
    });
    const whole = unfinished(yield* recordsOf(first));

    // The same history with one record's owner replaced: a result that belongs
    // to another entry, standing in this entry's own segment. It is what a
    // copied or borrowed record looks like, and the continuation refuses before
    // anything is performed rather than replaying somebody else's work.
    const crafted = yield* useCraftedExecution(
      fixture,
      whole.map((event) =>
        event.type === "yield" &&
        event.description.type === REPL_REPOSITORY_RESULT &&
        event.result.status === "ok" &&
        event.result.value !== null &&
        typeof event.result.value === "object" &&
        !Array.isArray(event.result.value)
          ? {
              ...event,
              result: {
                ...event.result,
                value: { ...event.result.value, owner: 'repl:v1:["somebody-else","entry-1"]' },
              },
            }
          : event,
      ),
      first.id,
    );

    const outcome = yield* scoped(function* () {
      const opened = yield* openReplSession({
        execution: crafted,
        installations: installations(),
        entryHost: fixture.entryHost,
      });
      if (!opened.ok) {
        return opened.error.message;
      }
      const settled = yield* opened.value.join();
      return settled.ok ? "continued" : settled.error.message;
    });
    expect(outcome).not.toBe("continued");
    expect(String(outcome)).toContain("another entry's owner");
  });
});
