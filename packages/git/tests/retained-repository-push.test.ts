/**
 * What one REPL entry's `<Git.Push />` asks for, publishes once, and answers
 * from afterwards.
 *
 * Every row runs a document through canonical execution with the production
 * entry capability installed, against a real checkout and a real bare remote.
 * What is proven is the whole path: the authored component asks the composition
 * Api, the request is written down, the shared Git-host engine observes, real
 * `git` publishes at most once, and the destination is read back from the
 * remote itself rather than from what the run believes.
 *
 * The contract these rows hold the host to is the REPL's execution model. A
 * publication request is retained before anything is contacted, and a
 * continuation reconciles *that* request — the branch and the commit it named —
 * however far the checkout has moved since. So the rows that matter most are
 * the ones where the two disagree: HEAD advanced behind a pending request, a
 * remote that accepted the branch before the journal recorded it, and a
 * completed publication whose checkout is gone.
 *
 * These rows carry E2, E3, E4, E5, E6's history half, E7 and E8 of the
 * delivery-4 matrix.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
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
import { chmod, mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation } from "@executablemd/core";
import { Git } from "@executablemd/git/api";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import type { GitAuthenticationSession } from "../src/deno/composition/authentication.ts";
import { UNAUTHENTICATED } from "../src/deno/composition/authentication.ts";
import { replRepositoryInstallation } from "../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import {
  parseReplPushRequestRecord,
  REPL_REPOSITORY_PUSH_REQUEST,
} from "../src/retained-repository/push-records.ts";
import type { ReplPushRequestRecord } from "../src/retained-repository/push-records.ts";
import { parseGitPushInputs } from "../src/composition/git-push-records.ts";
import { useLeases } from "../src/deno/run-composition/leases.ts";
import { useCommonDirectoryLease } from "../src/deno/retained-repository/leases.ts";
import type { SlotKind } from "../src/deno/run-composition/leases.ts";
import { repositorySlot } from "../src/deno/run-composition/checkout-layout.ts";
import type { GitPushInputs } from "../src/composition/git-push-records.ts";
// From the subpath that publishes it rather than from the source module: this
// result type is public, and reaching it by relative path would bypass the
// export map the partition test holds every consumer to.
import type { GitPushOutcome } from "@executablemd/git/api";

/** The owner the CLI derives for an entry, as this suite states one. */
const OWNER = '["executablemd.repl.issue-owner",1,"execution-push","1"]';

interface Fixture {
  /** The scenario's own directory: checkouts, managed root and HOME. */
  readonly root: string;
  /** The bare repository every managed Repository is cloned from. */
  readonly origin: string;
  /** An ordinary checkout an entry is opened in. */
  readonly checkout: string;
  /** Where this scenario's managed checkouts live. */
  readonly managed: string;
  /** A symbolic link an entry is opened through. */
  readonly link: string;
}

/** One bare remote with a commit in it, plus this scenario's own root. */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-push-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const git = gitSession(denoRepositoryHost(), root);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    yield* until(mkdir(seed, { recursive: true }));
    yield* git.run(["init", "--bare", "-b", "main", origin], root);
    yield* git.run(["init", "-b", "main", seed], root);
    yield* until(writeFile(join(seed, "seed.md"), "seed\n"));
    yield* git.run(["add", "seed.md"], seed);
    yield* git.run(["commit", "-m", "seed"], seed);
    yield* git.run(["push", origin, "main:refs/heads/main"], seed);

    const checkout = join(root, "checkout");
    yield* git.run(["clone", origin, checkout], root);
    const link = join(root, "entered");
    yield* until(symlink(checkout, link));
    yield* provide({ root, origin, checkout, managed: join(root, "repositories"), link });
  });
}

/** Point the link an entry is opened through at another directory. */
function* repoint(fixture: Fixture, target: string): Operation<void> {
  yield* until(unlink(fixture.link));
  yield* until(symlink(target, fixture.link));
}

/** What the host beneath the recorder was asked to do. */
interface Counters {
  commands: string[][];
  directories: number;
  sessions: string[];
}

function counters(): Counters {
  return { commands: [], directories: 0, sessions: [] };
}

/** The Git subcommands one entry issued, in order. */
function subcommands(counted: Counters): string[] {
  return counted.commands.map((args) => args.find((arg) => !arg.startsWith("-")) ?? "");
}

/** The host filesystem, as the production one. */
function hostFiles(): FilesHandler {
  const host = hostFilesHandler();
  return {
    checkFilePath: (input: FilePathInput) => host.checkFilePath(input),
    readTextFile: (input: FilePathInput) => host.readTextFile(input),
    globFiles: (input) => host.globFiles(input),
    temporaryDirectory: () => host.temporaryDirectory(),
    writeTextFile: (input: FileWriteInput) => host.writeTextFile(input),
    deleteFile: (input) => host.deleteFile(input),
    ensureDirectory: (input) => host.ensureDirectory(input),
  };
}

/** What a row may do to one `git` invocation before the real one runs. */
type GitBarrier = (invocation: GitInvocation) => Operation<void>;

/**
 * The production host, counted, and interruptible at a named subcommand.
 *
 * Every leaf is wrapped rather than replaced: what these rows need to know is
 * whether a publication really happened, and the only honest way to answer is
 * to let the real `ls-remote` and the real `push` happen and then read the
 * remote.
 */
function countingHost(counted: Counters, barrier?: GitBarrier): RepositoryHost {
  const host = denoRepositoryHost();
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      counted.commands.push([...invocation.args]);
      if (barrier !== undefined) {
        yield* barrier(invocation);
      }
      return yield* host.git(invocation);
    },
    *useDirectory(): Operation<string> {
      counted.directories += 1;
      return yield* host.useDirectory();
    },
    *useAuthentication(locator: string): Operation<GitAuthenticationSession> {
      counted.sessions.push(locator);
      return host.useAuthentication === undefined
        ? UNAUTHENTICATED
        : yield* host.useAuthentication(locator);
    },
  };
}

interface Run {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  readonly refusal: string | undefined;
}

interface RunOptions {
  /** The directory the entry is opened in. Defaults to the fixture's link. */
  readonly cwd?: string;
  /** What this row installs between the host and the recording. */
  readonly between?: () => Operation<void>;
  /** A barrier inside one `git` invocation. */
  readonly barrier?: GitBarrier;
  /** Whether this entry installs a managed root at all. */
  readonly root?: string | undefined;
  /** The owner this entry's work is retained under. */
  readonly owner?: string;
  /** The answer a question in this entry receives, when a row supplies one. */
  readonly answer?: Json;
}

/** One entry, over one journal, in one checkout. */
function run(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  counted: Counters,
  options: RunOptions = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const working = options.cwd ?? fixture.link;
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return working;
        },
      },
      { at: "min" },
    );
    const files = hostFiles();
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
    if (options.answer !== undefined) {
      const answer = options.answer;
      yield* Elicitation.around(
        {
          // deno-lint-ignore require-yield
          *elicit(): Operation<unknown> {
            return answer;
          },
        },
        { at: "min" },
      );
    }
    if (options.between !== undefined) {
      yield* options.between();
    }
    const managed = "root" in options ? options.root : fixture.managed;
    // Built the way the session builds it: one per-entry factory, called in the
    // entry's own task, for the owner the CLI derived.
    const installation = yield* replRepositoryInstallation(options.owner ?? OWNER, {
      host: countingHost(counted, options.barrier),
      ...(managed === undefined ? {} : { root: managed }),
    });
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream, includes: [fixture.root] }, [
            // What the Git Plugin contributes for `repl`, attached directly:
            // this suite assembles no command Plugins.
            { admissions: [(retained) => admitReplRepositoryHistory(retained)] },
            installation,
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
 * A real unfinished history, not a complete one with its closes removed: a
 * journal whose run finished replays every position it holds and runs no
 * component, so a continuation with a new suffix would never reach it.
 */
function left(
  fixture: Fixture,
  source: string,
  counted: Counters,
  options: RunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* spawn(() =>
      run(fixture, source, stream, counted, {
        ...options,
        *between(): Operation<void> {
          if (options.between !== undefined) {
            yield* options.between();
          }
          yield* Elicitation.around({
            *elicit(): Operation<unknown> {
              reached.resolve();
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

/**
 * The history an entry left behind when it was cut at a named invocation.
 *
 * The honest shape of an interrupted publication: the barrier stops the entry
 * before the real `git` runs, so what the journal holds is whatever had already
 * been acknowledged and nothing else. The cut is the halt below, not a
 * fabricated prefix.
 */
function interrupted(
  fixture: Fixture,
  source: string,
  counted: Counters,
  at: (invocation: GitInvocation) => boolean,
  options: RunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* spawn(() =>
      run(fixture, source, stream, counted, {
        ...options,
        *barrier(invocation): Operation<void> {
          if (options.barrier !== undefined) {
            yield* options.barrier(invocation);
          }
          if (at(invocation)) {
            reached.resolve();
            yield* suspend();
          }
        },
      }),
    );
    yield* race([
      reached.operation,
      (function* (): Operation<never> {
        yield* sleep(30_000);
        throw new Error("the entry never reached the invocation it was cut at");
      })(),
    ]);
    const prefix = [...(yield* stream.readAll())];
    yield* task.halt();
    return prefix;
  });
}

/** The commit a ref on the bare remote holds, or `undefined` for absence. */
function* remoteCommit(fixture: Fixture, branch: string): Operation<string | undefined> {
  const git = gitSession(denoRepositoryHost(), fixture.root);
  const outcome = yield* git.run(["rev-parse", "--verify", `refs/heads/${branch}`], fixture.origin);
  return outcome.code === 0 ? outcome.stdout.trim() : undefined;
}

/** The commit a checkout's branch holds. */
function* localCommit(fixture: Fixture, checkout: string, revision = "HEAD"): Operation<string> {
  const git = gitSession(denoRepositoryHost(), fixture.root);
  const outcome = yield* git.run(["rev-parse", revision], checkout);
  if (outcome.code !== 0) {
    throw new Error(`${revision} does not resolve in ${checkout}`);
  }
  return outcome.stdout.trim();
}

/** Commit one more file in a managed checkout, as a person at a shell would. */
function* commitThere(checkout: string, name: string): Operation<string> {
  const git = gitSession(denoRepositoryHost(), checkout);
  yield* writeTextFile(join(checkout, name), `${name}\n`);
  yield* git.run(["add", name], checkout);
  yield* git.run(
    [
      "-c",
      "user.name=Shell",
      "-c",
      "user.email=shell@example.test",
      "commit",
      "-m",
      `outside ${name}`,
    ],
    checkout,
  );
  const outcome = yield* git.run(["rev-parse", "HEAD"], checkout);
  return outcome.stdout.trim();
}

/** Hold one managed slot's own lock from outside, as another entry would. */
function useForeignSlot(root: string, slot: string, kind: SlotKind): Operation<void> {
  return resource<void>(function* (provide) {
    const leases = yield* useLeases(root);
    yield* leases.hold(kind, slot, "another entry");
    yield* provide();
  });
}

/** Every saved publication request this history holds, parsed. */
function requests(events: readonly DurableEvent[]): ReplPushRequestRecord[] {
  const found: ReplPushRequestRecord[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== REPL_REPOSITORY_PUSH_REQUEST) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parseReplPushRequestRecord(event.result.value);
    if (record !== undefined) {
      found.push(record);
    }
  }
  return found;
}

/** Every Git-host outcome this history holds, as the journal holds it. */
function outcomes(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === GIT_HOST_EFFECT,
  );
}

/** The Push inputs one retained outcome names. */
function outcomeInputs(event: DurableEvent): GitPushInputs {
  if (event.type !== "yield" || event.result.status !== "ok") {
    throw new Error("that outcome holds no successful reconciliation record");
  }
  const record = parseGitHostReconciliationRecord(event.result.value);
  const inputs = record === undefined ? undefined : parseGitPushInputs(record.request.inputs);
  if (inputs === undefined) {
    throw new Error("that outcome does not describe a publication");
  }
  return inputs;
}

/** The managed checkout a `<Repository name="project">` row selects. */
function managedCheckout(events: readonly DurableEvent[]): string {
  const saved = requests(events)[0];
  if (saved === undefined) {
    throw new Error("this history holds no saved publication request");
  }
  return saved.resolved.checkoutRoot;
}

/** A document that publishes a branch and then asks a question. */
function publishing(fixture: Fixture, branch: string, file: string, after?: string): string {
  return [
    `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
    `  <Git.Switch branch=${JSON.stringify(branch)} />`,
    `  <File path=${JSON.stringify(file)}>ready</File>`,
    `  <Git.Add paths=${JSON.stringify(file)} />`,
    `  <Git.Commit message="Prepare notes" as="commit" />`,
    `  <Git.Push />`,
    after ?? "",
    `</Repository>`,
    "",
  ].join("\n");
}

/** A question with nothing after it, so the next live work is the publication. */
const QUESTION_ONLY = [
  `  <Elicit schema={{ type: "object", properties: { choice: { enum: ["continue"] } },`,
  `    required: ["choice"], additionalProperties: false }} as="answer">`,
  `The branch was published. Continue?`,
  `  </Elicit>`,
].join("\n");

/** The question half every left-at-a-question row writes. */
const QUESTION = [
  `  <Elicit schema={{ type: "object", properties: { choice: { enum: ["continue"] } },`,
  `    required: ["choice"], additionalProperties: false }} as="answer">`,
  `The branch was published. Continue?`,
  `  </Elicit>`,
  `  <File path="after.md">continued</File>`,
].join("\n");

describe("one entry's publication", () => {
  it("P1: publishes once, and answers a completed publication with no Git at all", function* () {
    const fixture = yield* useFixture();
    const first = counters();
    const stream = new InMemoryStream();

    const ran = yield* run(fixture, publishing(fixture, "review/push", "notes.md"), stream, first);
    expect(ran.refusal).toBe(undefined);

    // One request, one outcome, and the remote holds exactly what was asked.
    const saved = requests(ran.events);
    expect(saved).toHaveLength(1);
    expect(outcomes(ran.events)).toHaveLength(1);
    const checkout = managedCheckout(ran.events);
    const published = yield* localCommit(fixture, checkout);
    expect(saved[0]?.resolved.inputs.branch).toBe("review/push");
    expect(saved[0]?.resolved.inputs.sourceCommit).toBe(published);
    expect(saved[0]?.resolved.origin).toBe(fixture.origin);
    expect(yield* remoteCommit(fixture, "review/push")).toBe(published);
    expect(subcommands(first)).toContain("push");

    // The same entry again, over the history it left. Nothing native happens:
    // no `git`, no isolation directory, no authentication session.
    const second = counters();
    const replayed = new InMemoryStream([...ran.events].filter(terminal));
    const again = yield* run(
      fixture,
      publishing(fixture, "review/push", "notes.md"),
      replayed,
      second,
    );
    expect(again.refusal).toBe(undefined);
    expect(second.commands).toEqual([]);
    expect(second.directories).toBe(0);
    expect(second.sessions).toEqual([]);
    expect(requests(yield* replayed.readAll())).toHaveLength(1);
    expect(outcomes(yield* replayed.readAll())).toHaveLength(1);
  });

  it("P2: a pending request publishes what it named, after HEAD moved", function* () {
    const fixture = yield* useFixture();
    const counted = counters();

    // Cut with the request acknowledged and the remote never contacted: the
    // entry is stopped before its first `ls-remote` runs.
    const prefix = yield* interrupted(
      fixture,
      publishing(fixture, "review/pending", "notes.md", QUESTION),
      counted,
      (invocation) => invocation.args.includes("ls-remote"),
    );
    expect(requests(prefix)).toHaveLength(1);
    expect(outcomes(prefix)).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/pending")).toBe(undefined);

    const asked = requests(prefix)[0]?.resolved.inputs.sourceCommit;
    const checkout = managedCheckout(prefix);

    // Somebody advances the branch at a shell while the entry is away.
    const moved = yield* commitThere(checkout, "later.md");
    expect(moved).not.toBe(asked);

    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(
      fixture,
      publishing(fixture, "review/pending", "notes.md", QUESTION),
      stream,
      resumed,
      { answer: { choice: "continue" } },
    );
    expect(again.refusal).toBe(undefined);

    // The commit the request named is what was published, not today's HEAD.
    expect(yield* remoteCommit(fixture, "review/pending")).toBe(asked);
    const events = yield* stream.readAll();
    expect(requests(events)).toHaveLength(1);
    expect(outcomes(events)).toHaveLength(1);
    expect(outcomeInputs(outcomes(events)[0] as DurableEvent).sourceCommit).toBe(asked);
  });
  it("P3: a remote that accepted the branch is adopted, never pushed twice", function* () {
    const fixture = yield* useFixture();
    const first = counters();
    const backing = new InMemoryStream();

    // The remote accepts the publication and the journal refuses to record it,
    // which is the window this whole protocol is about.
    const ran = yield* run(
      fixture,
      publishing(fixture, "review/adopt", "notes.md", QUESTION),
      refusing(backing, GIT_HOST_EFFECT),
      first,
      { answer: { choice: "continue" } },
    );
    expect(ran.refusal).not.toBe(undefined);
    const prefix = yield* backing.readAll();
    expect(requests(prefix)).toHaveLength(1);
    expect(outcomes(prefix)).toEqual([]);
    const asked = requests(prefix)[0]?.resolved.inputs.sourceCommit;
    expect(yield* remoteCommit(fixture, "review/adopt")).toBe(asked);
    expect(subcommands(first).filter((name) => name === "push")).toHaveLength(1);

    // The continuation observes the destination, finds this exact commit, and
    // adopts it. Nothing is published a second time.
    const second = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(
      fixture,
      publishing(fixture, "review/adopt", "notes.md", QUESTION),
      stream,
      second,
      { answer: { choice: "continue" } },
    );
    expect(again.refusal).toBe(undefined);
    expect(subcommands(second).filter((name) => name === "push")).toEqual([]);
    const events = yield* stream.readAll();
    expect(requests(events)).toHaveLength(1);
    const settled = outcomes(events)[0];
    expect(settled).not.toBe(undefined);
    expect(decisionOf(settled as DurableEvent)).toBe("adopted");
    expect(yield* remoteCommit(fixture, "review/adopt")).toBe(asked);
  });

  it("P4: advances a proven ancestor once, and refuses a divergent destination", function* () {
    const fixture = yield* useFixture();
    const counted = counters();

    // One publication, then a second commit on the same branch in the same
    // managed checkout: the destination holds an ancestor of what is published.
    const stream = new InMemoryStream();
    const first = yield* run(
      fixture,
      publishing(fixture, "review/advance", "one.md"),
      stream,
      counted,
    );
    expect(first.refusal).toBe(undefined);
    const base = yield* remoteCommit(fixture, "review/advance");

    const advanced = new InMemoryStream();
    const second = yield* run(
      fixture,
      publishing(fixture, "review/advance", "two.md"),
      advanced,
      counted,
    );
    expect(second.refusal).toBe(undefined);
    const head = yield* remoteCommit(fixture, "review/advance");
    expect(head).not.toBe(base);
    const ancestor = outcomes(yield* advanced.readAll())[0];
    expect(decisionOf(ancestor as DurableEvent)).toBe("performed");

    // Somebody else publishes an unrelated commit over that branch.
    const elsewhere = join(fixture.root, "elsewhere");
    const git = gitSession(denoRepositoryHost(), fixture.root);
    yield* git.run(["clone", fixture.origin, elsewhere], fixture.root);
    yield* git.run(["checkout", "-B", "review/advance"], elsewhere);
    yield* commitThere(elsewhere, "theirs.md");
    yield* git.run(["push", "--force", fixture.origin, "review/advance"], elsewhere);
    const theirs = yield* remoteCommit(fixture, "review/advance");

    const refused = counters();
    const conflicted = new InMemoryStream();
    const third = yield* run(
      fixture,
      publishing(fixture, "review/advance", "three.md"),
      conflicted,
      refused,
    );
    expect(third.refusal).not.toBe(undefined);
    // Nothing was published, and the destination is exactly where the other
    // party left it.
    expect(subcommands(refused).filter((name) => name === "push")).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/advance")).toBe(theirs);
    const events = yield* conflicted.readAll();
    expect(requests(events)).toHaveLength(1);
    const failure = outcomes(events)[0];
    expect(failure?.type === "yield" ? failure.result.status : undefined).toBe("err");

    // And it replays as itself, reaching no provider: no `git` at all.
    const replaying = counters();
    const replayed = new InMemoryStream([...events].filter(terminal));
    const fourth = yield* run(
      fixture,
      publishing(fixture, "review/advance", "three.md"),
      replayed,
      replaying,
    );
    expect(fourth.refusal).not.toBe(undefined);
    expect(replaying.commands).toEqual([]);
  });

  it("P5: public middleware composes, and only a delegation retains anything", function* () {
    const fixture = yield* useFixture();

    // A handler that answers without delegating has answered the document.
    // Nothing is written down and nothing is contacted.
    const synthetic = counters();
    const stream = new InMemoryStream();
    const answered = yield* run(
      fixture,
      publishing(fixture, "review/synthetic", "synthetic.md"),
      stream,
      synthetic,
      {
        *between(): Operation<void> {
          yield* Git.around({
            // deno-lint-ignore require-yield
            *push(): Operation<GitPushOutcome> {
              // A shape a handler can build and offer as a completion. The
              // component ignores it, and this operation retains nothing for
              // it: nothing was asked of a Git host.
              return SYNTHETIC;
            },
          });
        },
      },
    );
    expect(answered.refusal).toBe(undefined);
    const events = yield* stream.readAll();
    expect(requests(events)).toEqual([]);
    expect(outcomes(events)).toEqual([]);
    expect(subcommands(synthetic).filter((name) => name === "push")).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/synthetic")).toBe(undefined);

    // A handler that transforms and delegates is retained as both readings: the
    // question the invocation asked, and what the dispatch received.
    const transformed = counters();
    const delegated = new InMemoryStream();
    const published = yield* run(
      fixture,
      publishing(fixture, "review/delegated", "delegated.md"),
      delegated,
      transformed,
      {
        *between(): Operation<void> {
          yield* Git.around({
            *push([request], next): Operation<GitPushOutcome> {
              return yield* next({
                repository: request.repository,
                workingDirectory: `${request.workingDirectory}/.`,
              });
            },
          });
        },
      },
    );
    expect(published.refusal).toBe(undefined);
    const saved = requests(yield* delegated.readAll())[0];
    expect(saved).not.toBe(undefined);
    expect(saved?.requested.workingDirectory).not.toBe(saved?.received.workingDirectory);
    expect(saved?.received.workingDirectory.endsWith("/.")).toBe(true);
    // Both readings still name the same checkout, which is what the resolved
    // answer is about.
    expect(saved?.resolved.checkoutRoot).toBe(saved?.requested.selectionCheckout);
    expect(yield* remoteCommit(fixture, "review/delegated")).toBe(
      saved?.resolved.inputs.sourceCommit,
    );

    // A second delegation of one invocation is refused, and the first one's
    // acknowledged work stands.
    const doubled = counters();
    const twice = new InMemoryStream();
    const refused = yield* run(
      fixture,
      publishing(fixture, "review/doubled", "doubled.md"),
      twice,
      doubled,
      {
        *between(): Operation<void> {
          yield* Git.around({
            *push([request], next): Operation<GitPushOutcome> {
              yield* next(request);
              return yield* next(request);
            },
          });
        },
      },
    );
    expect(refused.refusal).not.toBe(undefined);
    const after = yield* twice.readAll();
    expect(requests(after)).toHaveLength(1);
    expect(outcomes(after)).toHaveLength(1);
    expect(subcommands(doubled).filter((name) => name === "push")).toHaveLength(1);
  });

  it("P6: a saved request bypasses the middleware it already passed", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const prefix = yield* interrupted(
      fixture,
      publishing(fixture, "review/bypass", "notes.md", QUESTION),
      counted,
      (invocation) => invocation.args.includes("ls-remote"),
    );
    const asked = requests(prefix)[0]?.resolved.inputs.sourceCommit;
    expect(asked).not.toBe(undefined);

    // The continuation installs a handler that would retarget the publication.
    // It is never asked: the saved request is consumed before any dispatch.
    const asks: number[] = [];
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(
      fixture,
      publishing(fixture, "review/bypass", "notes.md", QUESTION),
      stream,
      resumed,
      {
        answer: { choice: "continue" },
        *between(): Operation<void> {
          yield* Git.around({
            *push([request], next): Operation<GitPushOutcome> {
              asks.push(1);
              return yield* next({
                repository: request.repository,
                workingDirectory: fixture.root,
              });
            },
          });
        },
      },
    );
    expect(again.refusal).toBe(undefined);
    expect(asks).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/bypass")).toBe(asked);
  });

  it("P7: a refused request append contacts nothing, and fences what follows", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const backing = new InMemoryStream();

    const ran = yield* run(
      fixture,
      publishing(fixture, "review/fenced", "notes.md", QUESTION),
      refusing(backing, REPL_REPOSITORY_PUSH_REQUEST),
      counted,
      { answer: { choice: "continue" } },
    );
    expect(ran.refusal).not.toBe(undefined);
    const events = yield* backing.readAll();
    expect(requests(events)).toEqual([]);
    expect(outcomes(events)).toEqual([]);
    // No remote was read and nothing was published: the request had to be
    // acknowledged first.
    expect(subcommands(counted).filter((name) => name === "ls-remote")).toEqual([]);
    expect(subcommands(counted).filter((name) => name === "push")).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/fenced")).toBe(undefined);
    // And the work after the question never ran.
    expect(ran.output).not.toContain("continued");
  });

  it("P8: refuses a history it cannot read, before any native work", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const prefix = yield* interrupted(
      fixture,
      publishing(fixture, "review/unreadable", "notes.md", QUESTION),
      counted,
      (invocation) => invocation.args.includes("ls-remote"),
    );

    // The saved request, with its answer edited after the fact.
    const edited = [...prefix].map((event) => {
      if (event.type !== "yield" || event.description.type !== REPL_REPOSITORY_PUSH_REQUEST) {
        return event;
      }
      if (event.result.status !== "ok") {
        return event;
      }
      const payload = event.result.value as Record<string, Json>;
      const resolved = payload["resolved"] as Record<string, Json>;
      return {
        ...event,
        result: {
          status: "ok" as const,
          value: { ...payload, resolved: { ...resolved, origin: "ext::sh -c id" } },
        },
      };
    });

    const refused = counters();
    const stream = new InMemoryStream(edited);
    const again = yield* run(
      fixture,
      publishing(fixture, "review/unreadable", "notes.md", QUESTION),
      stream,
      refused,
      { answer: { choice: "continue" } },
    );
    expect(again.refusal).not.toBe(undefined);
    // Admission runs before replay policy and before anything native.
    expect(refused.commands).toEqual([]);
    expect(refused.sessions).toEqual([]);

    // And an outcome standing where no request asked for one.
    const orphaned = new InMemoryStream(
      [...prefix].filter(
        (event) =>
          !(event.type === "yield" && event.description.type === REPL_REPOSITORY_PUSH_REQUEST),
      ),
    );
    const settled = yield* run(
      fixture,
      publishing(fixture, "review/unreadable", "notes.md", QUESTION),
      orphaned,
      counters(),
      { answer: { choice: "continue" } },
    );
    // Nothing in that prefix is a Push outcome, so this history is readable:
    // what it holds is a selection and a commit, and the publication is new.
    expect(settled.refusal).toBe(undefined);
  });

  it("P9: contention appends nothing, and hostile checkout settings reach nothing", function* () {
    const fixture = yield* useFixture();

    // A publication whose managed slot another entry is holding. Contention is
    // decided before the request exists, so nothing is written down.
    const slot = repositorySlot(fixture.managed, fixture.origin, "project");
    const contended = counters();
    const stream = new InMemoryStream();
    const refused = yield* scoped(function* (): Operation<Run> {
      yield* useForeignSlot(fixture.managed, slot, "repository");
      return yield* run(
        fixture,
        publishing(fixture, "review/contended", "notes.md"),
        stream,
        contended,
      );
    });
    expect(refused.refusal).not.toBe(undefined);
    expect(requests(yield* stream.readAll())).toEqual([]);
    expect(subcommands(contended).filter((name) => name === "push")).toEqual([]);

    // A publication from a checkout whose own configuration names another
    // destination and another program. The transport runs in a repository this
    // run created, so neither is read.
    const published = new InMemoryStream();
    const counted = counters();
    const first = yield* run(
      fixture,
      publishing(fixture, "review/hostile", "notes.md"),
      published,
      counted,
    );
    expect(first.refusal).toBe(undefined);
    const checkout = managedCheckout(yield* published.readAll());
    const hostile = join(fixture.root, "hostile.git");
    const git = gitSession(denoRepositoryHost(), fixture.root);
    yield* git.run(["init", "--bare", hostile], fixture.root);
    yield* git.run(["config", "remote.origin.pushurl", hostile], checkout);
    const marker = join(fixture.root, "hook-ran");
    yield* writeTextFile(
      join(checkout, ".git/hooks/pre-push"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
    );
    yield* until(chmod(join(checkout, ".git/hooks/pre-push"), 0o755));

    const second = new InMemoryStream();
    const after = yield* run(
      fixture,
      publishing(fixture, "review/hostile2", "second.md"),
      second,
      counted,
    );
    expect(after.refusal).toBe(undefined);
    const saved = requests(yield* second.readAll())[0];
    expect(yield* remoteCommit(fixture, "review/hostile2")).toBe(
      saved?.resolved.inputs.sourceCommit,
    );
    expect(yield* exists(marker)).toBe(false);
    const diverted = gitSession(denoRepositoryHost(), fixture.root);
    const elsewhere = yield* diverted.run(
      ["rev-parse", "--verify", "refs/heads/review/hostile2"],
      hostile,
    );
    expect(elsewhere.code).not.toBe(0);
  });

  it("P11: a publication after the question takes the slot a restored placement left", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // The question comes *before* the publication here, so a continuation's
    // first new operation is the Push itself: the selection and the commit
    // replay, and neither of them takes a managed slot on that path.
    const source = [
      `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
      `  <Git.Switch branch="review/after" />`,
      `  <File path="notes.md">ready</File>`,
      `  <Git.Add paths="notes.md" />`,
      `  <Git.Commit message="Prepare notes" as="commit" />`,
      QUESTION_ONLY,
      // Nothing between the question and the publication: a continuation's
      // first live work is the Push itself, so what refuses under contention
      // is this operation rather than a file write beside it.
      `  <Git.Push />`,
      `</Repository>`,
      "",
    ].join("\n");

    const prefix = yield* left(fixture, source, counted);
    expect(requests(prefix)).toEqual([]);

    // Another entry holds that checkout's managed slot while this one
    // continues. Contention is decided before the request exists.
    const slot = repositorySlot(fixture.managed, fixture.origin, "project");
    const contended = counters();
    const stream = new InMemoryStream([...prefix]);
    const refused = yield* scoped(function* (): Operation<Run> {
      yield* useForeignSlot(fixture.managed, slot, "repository");
      return yield* run(fixture, source, stream, contended, {
        answer: { choice: "continue" },
      });
    });
    expect(refused.refusal).not.toBe(undefined);
    expect(requests(yield* stream.readAll())).toEqual([]);
    expect(outcomes(yield* stream.readAll())).toEqual([]);
    expect(subcommands(contended).filter((name) => name === "ls-remote")).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/after")).toBe(undefined);

    // Released, the same continuation publishes: the slot is reacquired by the
    // publication itself rather than inherited from the replayed selection.
    const released = counters();
    const resumed = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, resumed, released, {
      answer: { choice: "continue" },
    });
    expect(again.refusal).toBe(undefined);
    const saved = requests(yield* resumed.readAll())[0];
    expect(yield* remoteCommit(fixture, "review/after")).toBe(saved?.resolved.inputs.sourceCommit);
  });

  it("P13: a pending request reacquires its saved slot before it reads anything", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const prefix = yield* interrupted(
      fixture,
      publishing(fixture, "review/pendlock", "notes.md", QUESTION),
      counted,
      (invocation) => invocation.args.includes("ls-remote"),
    );
    const asked = requests(prefix)[0]?.resolved.inputs.sourceCommit;
    expect(asked).not.toBe(undefined);

    // The saved request is reconciled by a continuation while another entry
    // holds that checkout's slot. The slot is what says which entry owns a
    // managed checkout, and a publication reads its objects, so it is taken
    // before anything is read — and contention writes nothing down.
    const slot = repositorySlot(fixture.managed, fixture.origin, "project");
    const contended = counters();
    const stream = new InMemoryStream([...prefix]);
    const refused = yield* scoped(function* (): Operation<Run> {
      yield* useForeignSlot(fixture.managed, slot, "repository");
      return yield* run(
        fixture,
        publishing(fixture, "review/pendlock", "notes.md", QUESTION),
        stream,
        contended,
        { answer: { choice: "continue" } },
      );
    });
    expect(refused.refusal).not.toBe(undefined);
    const after = yield* stream.readAll();
    // The pending request it could not reconcile is still exactly one, and no
    // outcome was invented for it.
    expect(requests(after)).toHaveLength(1);
    expect(requests(after)[0]?.resolved.inputs.sourceCommit).toBe(asked);
    expect(outcomes(after)).toEqual([]);
    expect(subcommands(contended).filter((name) => name === "ls-remote")).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/pendlock")).toBe(undefined);

    // Released, that same saved request publishes what it named.
    const released = counters();
    const resumed = new InMemoryStream([...prefix]);
    const again = yield* run(
      fixture,
      publishing(fixture, "review/pendlock", "notes.md", QUESTION),
      resumed,
      released,
      { answer: { choice: "continue" } },
    );
    expect(again.refusal).toBe(undefined);
    expect(yield* remoteCommit(fixture, "review/pendlock")).toBe(asked);
  });

  it("P12: publishes while another entry holds only the mutation lease", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();

    // A publication reads authenticated objects and changes a branch on a
    // remote. It changes nothing in the repository, so the lease that says
    // which entry is changing one is not its to take — and another holder of
    // that lease does not stop it.
    const first = yield* run(
      fixture,
      publishing(fixture, "review/leased", "one.md"),
      stream,
      counted,
    );
    expect(first.refusal).toBe(undefined);
    const common = join(managedCheckout(yield* stream.readAll()), ".git");

    const second = new InMemoryStream();
    const held = counters();
    const published = yield* scoped(function* (): Operation<Run> {
      yield* useCommonDirectoryLease(common);
      return yield* run(
        fixture,
        [
          `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
          `  <Git.Push />`,
          `</Repository>`,
          "",
        ].join("\n"),
        second,
        held,
      );
    });
    expect(published.refusal).toBe(undefined);
    const saved = requests(yield* second.readAll())[0];
    expect(saved).not.toBe(undefined);
    expect(yield* remoteCommit(fixture, "review/leased")).toBe(saved?.resolved.inputs.sourceCommit);
  });

  it("P10: an entry with no managed root refuses to publish anything", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();

    const ran = yield* run(
      fixture,
      [
        `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
        `  <Git.Push />`,
        `</Repository>`,
        "",
      ].join("\n"),
      stream,
      counted,
      { root: undefined },
    );
    expect(ran.refusal).not.toBe(undefined);
    expect(requests(yield* stream.readAll())).toEqual([]);
    expect(counted.commands).toEqual([]);
  });
});

/** The decision one retained outcome records. */
function decisionOf(event: DurableEvent): string | undefined {
  if (event.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  return parseGitHostReconciliationRecord(event.result.value)?.decision;
}

/**
 * A completion a handler can build out of nothing.
 *
 * Every member is a shape the public contract declares, and none of it is
 * evidence: a value returned to a component is not a receipt, and this is what
 * the rows about synthetic answers offer in place of one.
 */
const SYNTHETIC: GitPushOutcome = Object.freeze({
  decision: "performed" as const,
  result: Object.freeze({
    repository: Object.freeze({
      name: "project",
      locatorFingerprint: "0".repeat(64),
      requestedBase: null,
      creationCommit: "0".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1" as const,
    }),
    remote: "origin",
    branch: "review/synthetic",
    destinationRef: "refs/heads/review/synthetic",
    refspec: `${"0".repeat(40)}:refs/heads/review/synthetic`,
    sourceCommit: "0".repeat(40),
    observedRemoteCommit: "0".repeat(40),
  }),
});

/** A journal that refuses every append of one durable type. */
function refusing(inner: InMemoryStream, type: string): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === type) {
        throw new Error("the journal backend refused this append");
      }
      yield* inner.append(event);
    },
  };
}

/** Every event but the root's own close, which is what an unfinished run has. */
function terminal(event: DurableEvent): boolean {
  return !(event.type === "close" && event.coroutineId === "root");
}
