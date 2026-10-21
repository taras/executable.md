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
import type { Operation, WithResolvers } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { chmod, mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import process from "node:process";
import { readGit, runGit } from "./support/fixture-git.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation, registerComponents } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";
import { cwd } from "@executablemd/runtime";
import { GitHost } from "@executablemd/git/api";
import { Git } from "@executablemd/git/api";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import type { GitHostProvider } from "@executablemd/git";
import { replRepositoryInstallation } from "../src/repl/repositories/deno/provider.ts";
import { admitReplRepositoryHistory } from "../src/repl/repositories/admission.ts";
import { useCompositionComponents } from "@executablemd/git";
import { GIT_HOST_EFFECT } from "@executablemd/git";
import { parseGitHostReconciliationRecord } from "@executablemd/git";
import {
  parseReplPushRequestRecord,
  REPL_REPOSITORY_PUSH_REQUEST,
} from "../src/repl/repositories/push-records.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
} from "../src/repl/repositories/placement-records.ts";
import type { ReplPushRequestRecord } from "../src/repl/repositories/push-records.ts";
import { parseGitPushInputs } from "@executablemd/git";
import { useLeases } from "@executablemd/git/deno";
import { useCommonDirectoryLease } from "../src/repl/repositories/deno/leases.ts";
import type { SlotKind } from "@executablemd/git/deno";
import { repositorySlot } from "@executablemd/git/deno";
import type { GitPushInputs } from "@executablemd/git";
// From the subpath that publishes it rather than from the source module: this
// result type is public, and reaching it by relative path would bypass the
// export map the partition test holds every consumer to.
import type { GitPushOutcome } from "@executablemd/git";
import type { GitPushInvocation } from "@executablemd/git/api";
import { currentRepository } from "@executablemd/git/api";

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
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    yield* until(mkdir(seed, { recursive: true }));
    yield* runGit(root, ["init", "--bare", "-b", "main", origin]);
    yield* runGit(root, ["init", "-b", "main", seed]);
    yield* until(writeFile(join(seed, "seed.md"), "seed\n"));
    yield* runGit(seed, ["add", "seed.md"]);
    yield* runGit(seed, ["commit", "-m", "seed"]);
    yield* runGit(seed, ["push", origin, "main:refs/heads/main"]);

    const checkout = join(root, "checkout");
    yield* runGit(root, ["clone", origin, checkout]);
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

/** What the handle beneath the recorder was asked to do. */
interface Counters {
  /** Every handle method this entry called, by name, in order. */
  methods: string[];
}

function counters(): Counters {
  return { methods: [] };
}

/** The handle methods one entry called, in order. */
function methodsCalled(counted: Counters): string[] {
  return [...counted.methods];
}

/**
 * The author and committer this suite's host states.
 *
 * These rows commit before they publish, and `<Git.Commit>` borrows the
 * *invoking person's* identity: the production reader asks native Git for it in
 * the environment the command was started in. A developer's machine
 * auto-detects one from the operating-system user; a continuous-integration
 * runner whose hostname carries no domain detects nothing, `git var` fails, and
 * every row here would report the ordinary missing-identity refusal instead of
 * reaching the publication it is about. Stating it is also what keeps the
 * commits these rows make from carrying whoever happened to run them.
 */
const STATED_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_IDENT: "Entry Author <author@example.test> 1700000000 +0000",
  GIT_COMMITTER_IDENT: "Entry Committer <committer@example.test> 1700000000 +0000",
};

/** That identity, as the host reads one. */
// deno-lint-ignore require-yield
function* statedIdentity(variable: string): Operation<string | undefined> {
  return STATED_IDENTITY[variable];
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

/** What a row may do to one handle method before the real one runs. */
type MethodBarrier = (method: string) => Operation<void>;

/** What a row may do to a provider's own result before the caller sees it. */
type ProviderGate = (stage: "observe" | "perform") => Operation<void>;

/**
 * The production handle, counted, and interruptible at a named method.
 *
 * Every method is wrapped rather than replaced: what these rows need to know is
 * whether a publication really happened, and the only honest way to answer is
 * to let the real provider do it and then read the remote.
 *
 * `pushProvider` is wrapped twice over. A barrier on the method itself holds
 * *before* a provider is built, which is the window an acknowledged request
 * that contacted nothing lives in. A gate on the returned provider holds after
 * a real `observe` or `perform` has finished and before its result is handed
 * back — the window a remote-completed, unacknowledged outcome lives in.
 */
function countingOperations(
  counted: Counters,
  barrier?: MethodBarrier,
  gate?: ProviderGate,
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
      ...operations,
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
      *pushProvider(commonDirectory, origin, inputs) {
        yield* note("pushProvider");
        const provider = yield* operations.pushProvider(commonDirectory, origin, inputs);
        if (gate === undefined) {
          return provider;
        }
        const gated: GitHostProvider = {
          *observe(...given) {
            const observed = yield* provider.observe(...given);
            yield* gate("observe");
            return observed;
          },
          *perform(...given) {
            const performed = yield* provider.perform(...given);
            yield* gate("perform");
            return performed;
          },
        };
        return gated;
      },
    };
    return wrapped;
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
  /** A barrier inside one handle method, before it performs anything. */
  readonly barrier?: MethodBarrier;
  /** A gate after a real provider stage finished and before its result returns. */
  readonly gate?: ProviderGate;
  /** The journal this entry runs over, when a row seeds one. */
  readonly stream?: DurableStream;
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
      operations: countingOperations(counted, options.barrier, options.gate),
      identity: statedIdentity,
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
    const stream = options.stream ?? new InMemoryStream();
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
  at: (method: string) => boolean,
  options: RunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* spawn(() =>
      run(fixture, source, stream, counted, {
        ...options,
        *barrier(method): Operation<void> {
          if (options.barrier !== undefined) {
            yield* options.barrier(method);
          }
          if (at(method)) {
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
  return yield* readGit(fixture.origin, ["rev-parse", "--verify", `refs/heads/${branch}`]);
}

/** The commit a checkout's branch holds. */
function* localCommit(fixture: Fixture, checkout: string, revision = "HEAD"): Operation<string> {
  const resolved = yield* readGit(checkout, ["rev-parse", revision]);
  if (resolved === undefined) {
    throw new Error(`${revision} does not resolve in ${checkout}`);
  }
  return resolved;
}

/** Commit one more file in a managed checkout, as a person at a shell would. */
function* commitThere(checkout: string, name: string): Operation<string> {
  yield* writeTextFile(join(checkout, name), `${name}\n`);
  yield* runGit(checkout, ["add", name]);
  yield* runGit(checkout, [
    "-c",
    "user.name=Shell",
    "-c",
    "user.email=shell@example.test",
    "commit",
    "-m",
    `outside ${name}`,
  ]);
  return yield* runGit(checkout, ["rev-parse", "HEAD"]);
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

/** A promise this row resolves when it decides a pending acquisition may finish. */
function gate(): { readonly released: Promise<void>; release(): void } {
  let open = (): void => {};
  const released = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { released, release: () => open() };
}

/** Let every ready task run, so "reached its wait" is about turns. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
}

/** Wait until this path is there, or say what never appeared. */
function* appears(path: string): Operation<void> {
  const deadline = Date.now() + 30_000;
  while (!(yield* exists(path))) {
    if (Date.now() > deadline) {
      throw new Error(`${path} never appeared`);
    }
    yield* sleep(25);
  }
}

/** The journal events this history's saved requests stand at. */
function requestEvents(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_PUSH_REQUEST,
  );
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
    expect(methodsCalled(first)).toContain("pushProvider");

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
    expect(methodsCalled(second)).toEqual([]);
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
      (method) => method === "pushProvider",
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
    expect(methodsCalled(first).filter((name) => name === "pushProvider")).toHaveLength(1);

    // The continuation observes the destination, finds this exact commit, and
    // adopts it. "Nothing is published a second time" is the decision it
    // recorded and the ref it left: a provider is built either way, because
    // adopting is something it has to look to decide. That an adoption runs no
    // `git push` is proved where the invocation is, by `git-push.test.ts`'s
    // "adopts a destination that already holds the commit, and pushes nothing
    // more".
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
    yield* runGit(fixture.root, ["clone", fixture.origin, elsewhere]);
    yield* runGit(elsewhere, ["checkout", "-B", "review/advance"]);
    yield* commitThere(elsewhere, "theirs.md");
    yield* runGit(elsewhere, ["push", "--force", fixture.origin, "review/advance"]);
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
    // party left it — which is what "nothing was published" means here. The
    // conflict is discovered by observing, so a provider is built to find it.
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
    expect(methodsCalled(replaying)).toEqual([]);
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
    expect(methodsCalled(synthetic).filter((name) => name === "pushProvider")).toEqual([]);
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
    expect(methodsCalled(doubled).filter((name) => name === "pushProvider")).toHaveLength(1);
  });

  it("P6: a saved request bypasses the middleware it already passed", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const prefix = yield* interrupted(
      fixture,
      publishing(fixture, "review/bypass", "notes.md", QUESTION),
      counted,
      (method) => method === "pushProvider",
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
    expect(methodsCalled(counted).filter((name) => name === "pushProvider")).toEqual([]);
    expect(methodsCalled(counted).filter((name) => name === "pushProvider")).toEqual([]);
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
      (method) => method === "pushProvider",
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
    expect(methodsCalled(refused)).toEqual([]);

    // And the same history with an origin this host *would* hand to Git, which
    // is not the one the Repository identity was fingerprinted from: the codec
    // admits the grammar and the provider asks the digest, because reconciling a
    // restored request uses the origin it recorded rather than today's.
    const elsewhere = [...prefix].map((event) => {
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
          value: { ...payload, resolved: { ...resolved, origin: join(fixture.root, "other.git") } },
        },
      };
    });
    const foreign = counters();
    const named = yield* run(
      fixture,
      publishing(fixture, "review/unreadable", "notes.md", QUESTION),
      new InMemoryStream(elsewhere),
      foreign,
      { answer: { choice: "continue" } },
    );
    expect(named.refusal).not.toBe(undefined);
    // Refused before the request is reconciled: nothing was pushed and the
    // origin it named was never contacted.
    expect(methodsCalled(foreign)).not.toContain("pushProvider");

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
    expect(methodsCalled(contended).filter((name) => name === "pushProvider")).toEqual([]);

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
    yield* runGit(fixture.root, ["init", "--bare", hostile]);
    yield* runGit(checkout, ["config", "remote.origin.pushurl", hostile]);
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
    expect(yield* readGit(hostile, ["rev-parse", "--verify", "refs/heads/review/hostile2"])).toBe(
      undefined,
    );
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
    expect(methodsCalled(contended).filter((name) => name === "pushProvider")).toEqual([]);
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
      (method) => method === "pushProvider",
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
    expect(methodsCalled(contended).filter((name) => name === "pushProvider")).toEqual([]);
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

  it("P14: a real unfinished prefix replays after the checkout and the remote are gone", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = publishing(fixture, "review/removed", "notes.md", QUESTION);

    // A genuine unfinished entry: the publication is acknowledged and the
    // question is standing there, with nothing removed from the journal.
    const prefix = yield* left(fixture, source, counted);
    expect(requests(prefix)).toHaveLength(1);
    expect(outcomes(prefix)).toHaveLength(1);
    const published = requests(prefix)[0]?.resolved.inputs.sourceCommit;
    const checkout = managedCheckout(prefix);
    expect(yield* remoteCommit(fixture, "review/removed")).toBe(published);

    // Both resources this publication read are now unavailable.
    yield* rm(checkout, { recursive: true, force: true });
    yield* rm(fixture.origin, { recursive: true, force: true });
    expect(yield* exists(checkout)).toBe(false);
    expect(yield* exists(fixture.origin)).toBe(false);

    // The continuation reaches the question again. Nothing native, nothing of
    // the source, no authentication and no Git-host middleware is reached, and
    // no second publication is appended.
    const replaying = counters();
    const middleware: string[] = [];
    const resumed = new InMemoryStream([...prefix]);
    const again = yield* left(fixture, source, replaying, {
      stream: resumed,
      *between(): Operation<void> {
        yield* GitHost.around({
          *route(): Operation<unknown> {
            middleware.push("routed");
            throw new Error("a completed publication reached the Git-host surface");
          },
        });
      },
    });
    expect(methodsCalled(replaying)).toEqual([]);
    expect(middleware).toEqual([]);
    expect(requests(again)).toHaveLength(1);
    expect(outcomes(again)).toHaveLength(1);
    expect(requests(again)[0]?.resolved.inputs.sourceCommit).toBe(published);
  });

  it("P15: a cut before the request is acknowledged resolves today's commit", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = publishing(fixture, "review/precut", "notes.md", QUESTION);

    // Cut with the request append in flight: the journal holds the selection
    // and the local Git of commit A, and no publication at all.
    const backing = new InMemoryStream();
    const held = withResolvers<void>();
    const prefix = yield* scoped(function* (): Operation<readonly DurableEvent[]> {
      const task = yield* spawn(() =>
        run(fixture, source, holdingAppend(backing, REPL_REPOSITORY_PUSH_REQUEST, held), counted, {
          answer: { choice: "continue" },
        }),
      );
      yield* race([
        held.operation,
        (function* (): Operation<never> {
          yield* sleep(30_000);
          throw new Error("the entry never reached its request append");
        })(),
      ]);
      const events = [...(yield* backing.readAll())];
      yield* task.halt();
      return events;
    });
    expect(requests(prefix)).toEqual([]);
    expect(outcomes(prefix)).toEqual([]);
    // Nothing was contacted: the request had to be acknowledged first.
    expect(methodsCalled(counted).filter((name) => name === "pushProvider")).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/precut")).toBe(undefined);

    const checkout = (yield* placements(prefix))[0];
    expect(checkout).not.toBe(undefined);
    const a = yield* localCommit(fixture, checkout ?? "");

    // Somebody advances the branch while the entry is away. The publication was
    // never asked for, so the continuation resolves it now — at B.
    const b = yield* commitThere(checkout ?? "", "later.md");
    expect(b).not.toBe(a);

    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
    });
    expect(again.refusal).toBe(undefined);
    const events = yield* stream.readAll();
    expect(requests(events)).toHaveLength(1);
    expect(requests(events)[0]?.resolved.inputs.sourceCommit).toBe(b);
    expect(yield* remoteCommit(fixture, "review/precut")).toBe(b);
  });

  it("P16: two spawned publications are two occurrences, resumed in either order", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // Two branches, two managed repositories, two questions. Each publishes at
    // its own position in its own coroutine.
    const branch = (name: string) =>
      [
        `<Spawn><Repository name=${JSON.stringify(name)} url=${JSON.stringify(fixture.origin)}>`,
        `<Git.Switch branch=${JSON.stringify(`review/${name}`)} />`,
        `<File path="${name}.md">${name}</File>`,
        `<Git.Add paths="${name}.md" />`,
        `<Git.Commit message="Prepare ${name}" as="commit" />`,
        "<Git.Push />",
        `<Elicit schema={{ type: "object" }} as="answer">Question for ${name}</Elicit>`,
        `<File path="after-${name}.md">continued</File>`,
        "</Repository></Spawn>",
      ].join("\n");
    const source = ["<All>", branch("alpha"), branch("beta"), "</All>", ""].join("\n");

    const prefix = yield* scoped(function* (): Operation<readonly DurableEvent[]> {
      const stream = new InMemoryStream();
      const waiting = withResolvers<void>();
      let asked = 0;
      const task = yield* spawn(() =>
        run(fixture, source, stream, counted, {
          *between(): Operation<void> {
            yield* Elicitation.around({
              *elicit(): Operation<unknown> {
                asked += 1;
                if (asked === 2) {
                  waiting.resolve();
                }
                return yield* suspend();
              },
            });
          },
        }),
      );
      yield* race([
        waiting.operation,
        (function* (): Operation<never> {
          yield* sleep(60_000);
          throw new Error("both branches never reached their questions");
        })(),
      ]);
      const held = [...(yield* stream.readAll())];
      yield* task.halt();
      return held;
    });

    // Two publications, each named by its own canonical invocation, each
    // standing in its own coroutine with its own outcome beside it.
    const asked = requests(prefix);
    expect(asked).toHaveLength(2);
    expect(new Set(asked.map((record) => record.site)).size).toBe(2);
    expect(new Set(asked.map((record) => record.owner)).size).toBe(1);
    expect(new Set(asked.map((record) => record.resolved.inputs.branch)).size).toBe(2);
    const published = outcomes(prefix);
    expect(published).toHaveLength(2);
    const coroutines = new Set(
      [...requestEvents(prefix), ...published].map((event) =>
        event.type === "yield" ? event.coroutineId : "",
      ),
    );
    expect(coroutines.size).toBe(2);
    for (const event of requestEvents(prefix)) {
      const paired = published.find(
        (outcome) =>
          outcome.type === "yield" &&
          event.type === "yield" &&
          outcome.coroutineId === event.coroutineId,
      );
      expect(paired).not.toBe(undefined);
    }
    for (const name of ["alpha", "beta"]) {
      expect(yield* remoteCommit(fixture, `review/${name}`)).not.toBe(undefined);
    }

    // Continued with the answers arriving in the other order. Each branch
    // replays its own publication and runs its own suffix once.
    const replaying = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, replaying, {
      *between(): Operation<void> {
        yield* Elicitation.around({
          *elicit([request]: [ElicitationRequest]): Operation<unknown> {
            yield* sleep(request.message.includes("alpha") ? 40 : 0);
            return {};
          },
        });
      },
    });
    expect(again.refusal).toBe(undefined);
    const events = yield* stream.readAll();
    // No publication happened twice, and neither branch consumed the other's.
    expect(requests(events)).toHaveLength(2);
    expect(outcomes(events)).toHaveLength(2);
    expect(methodsCalled(replaying).filter((name) => name === "pushProvider")).toEqual([]);
    for (const name of ["alpha", "beta"]) {
      const checkout = asked.find((record) => record.resolved.inputs.branch === `review/${name}`)
        ?.resolved.checkoutRoot;
      expect(checkout).not.toBe(undefined);
      expect(yield* exists(join(checkout ?? "", `after-${name}.md`))).toBe(true);
    }
  });

  it("P17: one authored site evaluated twice is two publications", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();

    const ran = yield* run(
      fixture,
      [
        `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
        '<Git.Switch branch="review/twice" />',
        '<File path="notes.md">ready</File>',
        '<Git.Add paths="notes.md" />',
        '<Git.Commit message="Prepare notes" as="commit" />',
        '<Each in={[1, 2]} let="turn">',
        "<Git.Push />",
        "</Each>",
        "</Repository>",
        "",
      ].join("\n"),
      stream,
      counted,
    );
    expect(ran.refusal).toBe(undefined);

    // Two occurrences of one authored element: two requests under two
    // canonical sites, and two outcomes. The second observes the destination
    // this run just published and adopts it rather than pushing again.
    const asked = requests(ran.events);
    expect(asked).toHaveLength(2);
    expect(new Set(asked.map((record) => record.site)).size).toBe(2);
    expect(new Set(asked.map((record) => record.resolved.inputs.sourceCommit)).size).toBe(1);
    const published = outcomes(ran.events);
    expect(published).toHaveLength(2);
    // One publication and one adoption: the decisions are what say the second
    // occurrence did not push again.
    expect(published.map((event) => decisionOf(event))).toEqual(["performed", "adopted"]);
    expect(methodsCalled(counted).filter((name) => name === "pushProvider")).toHaveLength(2);
  });

  it("P18: a kept delegation, a later answer and a standalone dispatch reach nothing", function* () {
    const fixture = yield* useFixture();

    // A handler that keeps its continuation, delegates once, and then uses the
    // kept one again after that invocation has ended. The first publication
    // stands; the second use reaches a revoked default.
    const kept: ((invocation: GitPushInvocation) => Operation<GitPushOutcome>)[] = [];
    const counted = counters();
    const stream = new InMemoryStream();
    const reused = yield* run(
      fixture,
      [
        `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
        '<Git.Switch branch="review/kept" />',
        '<File path="notes.md">ready</File>',
        '<Git.Add paths="notes.md" />',
        '<Git.Commit message="Prepare notes" as="commit" />',
        "<PrintErrors>",
        "<Git.Push />",
        "<Git.Push />",
        "</PrintErrors>",
        "</Repository>",
        "",
      ].join("\n"),
      stream,
      counted,
      {
        *between(): Operation<void> {
          yield* Git.around({
            *push([request], next): Operation<GitPushOutcome> {
              if (kept.length > 0) {
                // The continuation the *first* invocation handed over, used
                // from inside the second one.
                const stale = kept[0];
                return yield* (stale ?? next)(request);
              }
              kept.push(next);
              return yield* next(request);
            },
          });
        },
      },
    );
    const published = requests(yield* stream.readAll());
    // One publication was retained and the stale continuation retained
    // nothing: the second element reported rather than publishing.
    expect(published).toHaveLength(1);
    expect(outcomes(yield* stream.readAll())).toHaveLength(1);
    // The stale continuation names no invocation, and that is admission rather
    // than an outcome: it is fatal, nothing was asked of the Git host, and the
    // printing region around it does not make it an answer.
    expect(reused.refusal).toContain("names no invocation");
    expect(reused.refusal).toContain("Nothing was asked of the Git host");
    expect(yield* remoteCommit(fixture, "review/kept")).toBe(
      published[0]?.resolved.inputs.sourceCommit,
    );

    // A handler that delegates and then throws cannot replace the receipt the
    // worker already published.
    const raising = counters();
    const second = new InMemoryStream();
    const thrown = yield* run(
      fixture,
      publishing(fixture, "review/raised", "raised.md"),
      second,
      raising,
      {
        *between(): Operation<void> {
          yield* Git.around({
            *push([request], next): Operation<GitPushOutcome> {
              yield* next(request);
              throw new Error("a handler's own failure after delegating");
            },
          });
        },
      },
    );
    expect(thrown.refusal).toContain("after delegating");
    const receipt = requests(yield* second.readAll());
    expect(receipt).toHaveLength(1);
    expect(outcomes(yield* second.readAll())).toHaveLength(1);
    expect(yield* remoteCommit(fixture, "review/raised")).toBe(
      receipt[0]?.resolved.inputs.sourceCommit,
    );

    // A handler that delegates and then answers with something else of its own
    // cannot replace the receipt either: a return value is not evidence.
    const replaced = counters();
    const fourth = new InMemoryStream();
    const answered = yield* run(
      fixture,
      publishing(fixture, "review/replaced", "replaced.md"),
      fourth,
      replaced,
      {
        *between(): Operation<void> {
          yield* Git.around({
            *push([request], next): Operation<GitPushOutcome> {
              yield* next(request);
              return SYNTHETIC;
            },
          });
        },
      },
    );
    expect(answered.refusal).toBe(undefined);
    const definitive = requests(yield* fourth.readAll());
    expect(definitive).toHaveLength(1);
    expect(definitive[0]?.resolved.inputs.branch).toBe("review/replaced");
    expect(outcomes(yield* fourth.readAll())).toHaveLength(1);
    expect(yield* remoteCommit(fixture, "review/replaced")).toBe(
      definitive[0]?.resolved.inputs.sourceCommit,
    );

    // And a dispatch made outside the trusted invocation reaches the ordinary
    // missing-provider refusal, retaining nothing.
    const standalone = counters();
    const third = new InMemoryStream();
    const direct = yield* run(
      fixture,
      [
        `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
        "<PrintErrors>",
        "<Standalone />",
        "</PrintErrors>",
        "</Repository>",
        "",
      ].join("\n"),
      third,
      standalone,
      {
        *between(): Operation<void> {
          yield* registerComponents([
            {
              name: "Standalone",
              origin: "tier-push",
              props: { type: "object", properties: {}, additionalProperties: false },
              *fn() {
                // The lexical selection this row writes, read through the published
                // contextual descriptor rather than Git's private convenience over it.
                const repository = yield* currentRepository();
                if (repository === undefined) {
                  throw new Error("this row needs a Repository in scope");
                }
                yield* Git.operations.push({ repository, workingDirectory: yield* cwd() });
                return "";
              },
            },
          ]);
        },
      },
    );
    expect(direct.output).toContain("composition provider is installed");
    expect(requests(yield* third.readAll())).toEqual([]);
    expect(outcomes(yield* third.readAll())).toEqual([]);
    expect(methodsCalled(standalone).filter((name) => name === "pushProvider")).toEqual([]);
  });

  it("P19: a synthetic answer leaves nothing to restore, so a continuation asks again", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    let asked = 0;
    const synthetic = function* (): Operation<void> {
      yield* Git.around({
        // deno-lint-ignore require-yield
        *push(): Operation<GitPushOutcome> {
          asked += 1;
          return SYNTHETIC;
        },
      });
    };
    const source = publishing(fixture, "review/resynthetic", "notes.md", QUESTION);

    const prefix = yield* left(fixture, source, counted, { between: synthetic });
    expect(asked).toBe(1);
    expect(requests(prefix)).toEqual([]);
    expect(outcomes(prefix)).toEqual([]);

    // Nothing was retained for it, so the continuation reaches the chain again
    // — and still retains nothing.
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
      between: synthetic,
    });
    expect(again.refusal).toBe(undefined);
    expect(asked).toBe(2);
    const events = yield* stream.readAll();
    expect(requests(events)).toEqual([]);
    expect(outcomes(events)).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/resynthetic")).toBe(undefined);
  });

  it("P20: a halt before the provider waits for the attempt's own cleanup", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const reached = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    const attempt: { cleaned: boolean } = { cleaned: false };
    let returned = false;

    // A resource of the attempt's own, armed before the wait this row halts
    // into. Armed first because the halt is started off that announcement: an
    // `ensure` yielded afterwards registers nothing on a scope already
    // unwinding, and the cancellation would reach an acquisition with no
    // cleanup on it. It suspends, so it is an `ensure` and not a `finally` — a
    // `finally` that yields takes the frame out of return-mode while the scope
    // is being torn down.
    //
    // Which resource it stands for is not this suite's business. That the
    // publication's own scratch space is waited for while still pending and
    // removed once delivered is proved where the acquisition is, by
    // `git-host-owned.test.ts`'s OW12 and OW13.
    const barrier: MethodBarrier = function* (method): Operation<void> {
      if (method !== "pushProvider") {
        return;
      }
      yield* ensure(function* () {
        cleaning.resolve();
        yield* release.operation;
        attempt.cleaned = true;
      });
      reached.resolve();
      yield* suspend();
    };

    const stream = new InMemoryStream();
    yield* scoped(function* (): Operation<void> {
      const task = yield* spawn(() =>
        run(fixture, publishing(fixture, "review/scratch", "notes.md"), stream, counted, {
          barrier,
        }),
      );
      yield* reached.operation;

      // The boundary this row is about: the request is acknowledged, and no
      // provider has been built, so nothing has been contacted.
      const atBarrier = yield* stream.readAll();
      expect(requests(atBarrier)).toHaveLength(1);
      expect(outcomes(atBarrier)).toEqual([]);

      // The halt is observed rather than merely started, so `returned` says
      // that `task.halt()` came back and not that something asked it to.
      const halting = yield* spawn(function* (): Operation<void> {
        yield* task.halt();
        returned = true;
      });
      try {
        yield* cleaning.operation;
        expect(attempt.cleaned).toBe(false);
        expect(returned).toBe(false);
      } finally {
        // In a `finally` with no yield in it, so an assertion that failed above
        // leaves the joined cleanup nothing to wait for.
        release.resolve();
      }
      yield* halting;
    });

    // The halt waited for the attempt's own cleanup, and the request it had
    // already acknowledged is still history for the next attempt.
    expect(attempt.cleaned).toBe(true);
    expect(returned).toBe(true);
    const events = yield* stream.readAll();
    expect(requests(events)).toHaveLength(1);
    expect(outcomes(events)).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/scratch")).toBe(undefined);
  });

  it("P20b: a halt after a real observation releases what the attempt took", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const observing = withResolvers<void>();
    const attempt: { cleaned: boolean } = { cleaned: false };

    // The cut is after the provider really observed its destination and before
    // any outcome, so what it releases is a resource the attempt had already
    // received rather than one it was still waiting for.
    const stream = new InMemoryStream();
    yield* scoped(function* (): Operation<void> {
      const task = yield* spawn(() =>
        run(fixture, publishing(fixture, "review/scratch2", "notes.md"), stream, counted, {
          *barrier(method): Operation<void> {
            if (method !== "pushProvider") {
              return;
            }
            yield* ensure(function* (): Operation<void> {
              attempt.cleaned = true;
            });
          },
          *gate(stage): Operation<void> {
            if (stage !== "observe") {
              return;
            }
            observing.resolve();
            yield* suspend();
          },
        }),
      );
      yield* observing.operation;
      yield* task.halt();
    });

    // The provider was built and really did observe; what it held is released,
    // and no outcome was invented for the publication it never finished.
    expect(methodsCalled(counted)).toContain("pushProvider");
    expect(attempt.cleaned).toBe(true);
    const events = yield* stream.readAll();
    expect(requests(events)).toHaveLength(1);
    expect(outcomes(events)).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/scratch2")).toBe(undefined);
  });

  it("P21: a cancelled attempt keeps its request, and the next one reconciles it", function* () {
    const fixture = yield* useFixture();
    const counted = counters();

    // Cut before the provider exists, so nothing was contacted for the request
    // this attempt had already written down. That the credential session a live
    // attempt opens is for the exact admitted locator, and that a delivery
    // arriving after cancellation began is released by its own cleanup before
    // the halt returns, is proved where the session is, by
    // `git-host-owned.test.ts`'s OW14.
    const prefix = yield* interrupted(
      fixture,
      publishing(fixture, "review/credential", "notes.md"),
      counted,
      (method) => method === "pushProvider",
    );

    expect(requests(prefix)).toHaveLength(1);
    expect(outcomes(prefix)).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/credential")).toBe(undefined);

    // And that acknowledged request is what the next attempt reconciles.
    const resumed = counters();
    const again = yield* run(
      fixture,
      publishing(fixture, "review/credential", "notes.md"),
      new InMemoryStream([...prefix].filter(terminal)),
      resumed,
    );
    expect(again.refusal).toBe(undefined);
    expect(yield* remoteCommit(fixture, "review/credential")).toBe(
      requests(prefix)[0]?.resolved.inputs.sourceCommit,
    );
  });

  it("P22: a publication the remote completed but nobody acknowledged is adopted", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const performed = withResolvers<void>();

    // The window this row exists for: the branch is really on the remote, and
    // the journal says nothing about it. The gate holds after the delegated
    // `perform` has finished and before its result reaches the caller, which is
    // the one moment those two are both true.
    //
    // That the native child this contact spawns is genuinely running and is
    // joined before the attempt settles is proved where the invocation is, by
    // `git-host-owned.test.ts`'s OW15.
    const stream = new InMemoryStream();
    yield* scoped(function* (): Operation<void> {
      const task = yield* spawn(() =>
        run(fixture, publishing(fixture, "review/blocked", "notes.md"), stream, counted, {
          *gate(stage): Operation<void> {
            if (stage !== "perform") {
              return;
            }
            performed.resolve();
            yield* suspend();
          },
        }),
      );
      yield* performed.operation;
      yield* task.halt();
    });

    // The remote has it; the journal holds the request and no outcome.
    const events = yield* stream.readAll();
    const asked = requests(events)[0]?.resolved.inputs.sourceCommit;
    expect(asked).not.toBe(undefined);
    expect(outcomes(events)).toEqual([]);
    expect(yield* remoteCommit(fixture, "review/blocked")).toBe(asked);

    // So the next attempt adopts what is already there rather than publishing
    // it twice or refusing over it.
    const resumed = counters();
    const continued = new InMemoryStream([...events].filter(terminal));
    const again = yield* run(
      fixture,
      publishing(fixture, "review/blocked", "notes.md"),
      continued,
      resumed,
    );
    expect(again.refusal).toBe(undefined);
    const adopted = outcomes(yield* continued.readAll())[0];
    expect(adopted).not.toBe(undefined);
    expect(decisionOf(adopted as DurableEvent)).toBe("adopted");
    expect(yield* remoteCommit(fixture, "review/blocked")).toBe(asked);
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
    expect(methodsCalled(counted)).toEqual([]);
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

/**
 * A journal that holds every append of one durable type, and says when it did.
 *
 * What makes a cut before acknowledgement deterministic: the append is in
 * flight when the row halts the entry, so what the journal holds is everything
 * up to the publication request and nothing of it.
 */
function holdingAppend(
  inner: InMemoryStream,
  type: string,
  reached: WithResolvers<void>,
): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === type) {
        reached.resolve();
        yield* suspend();
      }
      yield* inner.append(event);
    },
  };
}

/** Every managed checkout a history's placement records name. */
function* placements(events: readonly DurableEvent[]): Operation<string[]> {
  const found: string[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== REPL_REPOSITORY_PLACEMENT) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parseReplPlacementRecord(event.result.value);
    if (record !== undefined && record.outcome.ok) {
      found.push(record.outcome.value.checkoutRoot);
    }
  }
  return found;
}

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
