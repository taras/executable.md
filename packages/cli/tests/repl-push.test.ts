/**
 * How a REPL entry gets its publication capability, and who never gets one.
 *
 * The entry host is the one thing this command prepares per *entry*, and with
 * publication it prepares two things at once: the declarations and admissions
 * an entry runs with, and the private initialization its own checkouts, local
 * Git and publications are created by. These rows hold the assembly to that
 * shape — one initialization per executing entry, nothing at all for a session
 * that only reads, and the existing capabilities intact beside the new one.
 *
 * Every row drives the production path: the real selector, the real per-entry
 * factory, the real session. Nothing here reaches a Git host, because none of
 * what these rows are about happens after a request exists.
 *
 * They carry E9 of the delivery-4 matrix.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { appendFile, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core/api";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { denoRepositoryHost } from "../../git/src/deno/composition/host.ts";
import { gitSession } from "../../git/src/deno/composition/git.ts";
import { gitPlugin } from "../../git/src/plugin.ts";
import { replRepositoryPlugin } from "../src/repl/repositories/plugin.ts";
import { replRepositoryInstallation } from "../src/repl/repositories/deno/provider.ts";
import { REPL_REPOSITORY_PUSH_REQUEST } from "../src/repl/repositories/push-records.ts";
import { GIT_HOST_EFFECT } from "../../git/src/git-host/effect-type.ts";
import type { HelperAssembly } from "../../git/src/deno/composition/credential-helper.ts";
import { selectReplEntryHost } from "../src/deno-repositories.ts";
import { assembleReplProfile } from "../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import { resolveAgentStack } from "../src/agent-stack.ts";
import { NO_PLUGINS } from "../src/plugin-host.ts";
import { ordinaryGeneratedSelection } from "../src/evaluation-profile.ts";
import { ReplHost } from "../src/repl/host.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplExecution } from "../src/repl/journal.ts";

/** The credential-helper assembly these rows' host selects. Never invoked. */
const SUITE_HELPER: HelperAssembly = Object.freeze({
  runtime: "source",
  platform: "unix",
  execPath: "/nonexistent/xmd",
});

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly origin: string;
  readonly managed: string;
}

/** One checkout and one bare remote, which is all these rows need. */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-push-cli-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const git = gitSession(denoRepositoryHost(), root);
    const checkout = join(root, "checkout");
    const origin = join(root, "origin.git");
    yield* git.run(["init", "--bare", "-b", "main", origin], root);
    yield* git.run(["init", "-b", "main", checkout], root);
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    yield* git.run(["add", "seed.md"], checkout);
    yield* git.run(["commit", "-m", "seed"], checkout);
    yield* git.run(["push", origin, "main:refs/heads/main"], checkout);
    yield* provide({ root, checkout, origin, managed: join(root, "repositories") });
  });
}

/**
 * The author and committer this suite's host states.
 *
 * `<Git.Commit>` borrows the *invoking person's* identity, which the production
 * reader asks native Git for in the environment the command was started in. On
 * a developer's machine Git auto-detects one from the operating-system user; a
 * continuous-integration runner whose hostname carries no domain can detect
 * nothing, `git var` fails, and the commit in these entries would report its
 * ordinary missing-identity refusal — failing the row for a reason that is
 * about the runner rather than about the assembly these rows are measuring.
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

/**
 * What the Git Plugin contributes for the `repl` command.
 *
 * Called in the scope the session is opened in, because installing is what
 * registers the vocabulary: `<Git.Push />` resolves in preflight and in the
 * entry through this registry, exactly as it does under the real command, and
 * this harness supplies no component catalog of its own.
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

/** What one run's assembly did, as these rows read it. */
interface Counted {
  /** Every owner the session derived and handed to the factory. */
  readonly owners: string[];
  /** How many times core invoked `init` for an execution. */
  initialized: number;
}

function counted(): Counted {
  return { owners: [], initialized: 0 };
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function execution(id: string, events: readonly DurableEvent[] = []): ReplExecution {
  return { id, stream: new InMemoryStream([...events]) };
}

interface Ran {
  readonly events: readonly DurableEvent[];
  readonly outcome: Result<unknown> | undefined;
}

interface RunOptions {
  /** Whether this host selects a managed root at all. */
  readonly root?: string | undefined;
  /** Whether this host selects an entry capability at all. */
  readonly host?: boolean;
}

/**
 * One submitted entry, run through the production session.
 *
 * The factory is the one the production selector selects, and the owner is the
 * one the session derives: what these rows are about is that assembly, so none
 * of it is substituted.
 */
function submit(
  fixture: Fixture,
  source: string,
  run: ReplExecution,
  seen: Counted,
  options: RunOptions = {},
): Operation<Ran> {
  return scoped(function* (): Operation<Ran> {
    yield* useNodeReplHost(run.id);
    yield* useHostFiles();
    yield* useWorkingDirectory(fixture.checkout);
    // Counted on the same seam core invokes, so "one initialization per
    // executing entry" is measured rather than inferred.
    yield* Execution.around({
      *init(_args, next): Operation<void> {
        seen.initialized += 1;
        yield* next();
      },
    });
    const managed = "root" in options ? options.root : fixture.managed;
    const session = opened(
      yield* submitReplEntry({
        execution: run,
        source,
        installations: [...(yield* replInstallations())],
        generated: ordinaryGeneratedSelection(),
        ...(options.host === false
          ? {}
          : {
              entryInstallation: (owner: string) => {
                seen.owners.push(owner);
                return replRepositoryInstallation(owner, {
                  identity: statedIdentity,
                  ...(managed === undefined ? {} : { root: managed }),
                });
              },
            }),
      }),
    );
    const outcome = yield* session.join();
    return { events: yield* run.stream.readAll(), outcome };
  });
}

/** One reopened session over a history nobody is continuing. */
function reopen(
  fixture: Fixture,
  run: ReplExecution,
  seen: Counted,
  options: RunOptions = {},
): Operation<Ran> {
  return scoped(function* (): Operation<Ran> {
    yield* useNodeReplHost(run.id);
    yield* useHostFiles();
    yield* useWorkingDirectory(fixture.checkout);
    yield* Execution.around({
      *init(_args, next): Operation<void> {
        seen.initialized += 1;
        yield* next();
      },
    });
    const managed = "root" in options ? options.root : fixture.managed;
    const session = opened(
      yield* openReplSession({
        execution: run,
        installations: [...(yield* replInstallations())],
        generated: ordinaryGeneratedSelection(),
        entryInstallation: (owner: string) => {
          seen.owners.push(owner);
          return replRepositoryInstallation(owner, {
            identity: statedIdentity,
            ...(managed === undefined ? {} : { root: managed }),
          });
        },
      }),
    );
    const outcome = yield* session.join();
    return { events: yield* run.stream.readAll(), outcome };
  });
}

/** The durable types one history holds, in order. */
function types(events: readonly DurableEvent[]): string[] {
  return events.flatMap((event) => (event.type === "yield" ? [event.description.type] : []));
}

const PUBLISHING = (fixture: Fixture): string =>
  [
    `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
    `  <Git.Switch branch="review/cli" />`,
    `  <File path="notes.md">ready</File>`,
    `  <Git.Add paths="notes.md" />`,
    `  <Git.Commit message="Prepare notes" as="commit" />`,
    `  <Git.Push />`,
    `</Repository>`,
    "",
  ].join("\n");

describe("how a REPL entry gets its publication capability", () => {
  it("C1: one executing entry initializes once, and publishes under its own owner", function* () {
    const fixture = yield* useFixture();
    const seen = counted();
    const run = execution("execution-cli-1");

    const ran = yield* submit(fixture, PUBLISHING(fixture), run, seen);
    expect(ran.outcome?.ok).toBe(true);

    // Exactly one owner, derived by the session, and exactly one
    // initialization: the factory registers it and core calls it once.
    expect(seen.owners).toHaveLength(1);
    expect(seen.owners[0]).toContain("executablemd.repl");
    expect(seen.initialized).toBe(1);
    // The capability its entry ran with is the whole of what this host selects:
    // the checkouts, the local Git and the publication, in one history.
    const held = types(ran.events);
    expect(held).toContain("repl_repository_placement");
    expect(held).toContain("repl_repository_git");
    expect(held).toContain("repl_repository_local");
    expect(held).toContain(REPL_REPOSITORY_PUSH_REQUEST);
    expect(held).toContain(GIT_HOST_EFFECT);
  });

  it("C2: a session that only reads a history initializes nothing", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const run = execution("execution-cli-2");
    const ran = yield* submit(fixture, PUBLISHING(fixture), run, first);
    expect(ran.outcome?.ok).toBe(true);
    expect(first.initialized).toBe(1);

    // Reopened over the settled history: a passive view runs no entry, so the
    // factory is never called, nothing is initialized, and no managed root or
    // publication is reached.
    const passive = counted();
    const again = yield* reopen(fixture, execution(run.id, ran.events), passive);
    expect(again.outcome?.ok).toBe(true);
    expect(passive.owners).toEqual([]);
    expect(passive.initialized).toBe(0);
  });

  it("C3: two entries of one execution are two owners and two initializations", function* () {
    const fixture = yield* useFixture();
    const seen = counted();
    const run = execution("execution-cli-3");

    const first = yield* submit(fixture, PUBLISHING(fixture), run, seen);
    expect(first.outcome?.ok).toBe(true);
    const second = yield* submit(
      fixture,
      [
        `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
        `  <File path="second.md">second</File>`,
        `  <Git.Add paths="second.md" />`,
        `  <Git.Commit message="Second" as="commit" />`,
        `  <Git.Push />`,
        `</Repository>`,
        "",
      ].join("\n"),
      execution(run.id, first.events),
      seen,
    );
    expect(second.outcome?.ok).toBe(true);

    expect(seen.initialized).toBe(2);
    expect(seen.owners).toHaveLength(2);
    expect(new Set(seen.owners).size).toBe(2);
  });

  it("C4: with no entry capability selected, publishing reaches the ordinary refusal", function* () {
    const fixture = yield* useFixture();
    const seen = counted();
    const run = execution("execution-cli-4");

    // What Node and Bun leave: the components are declared by the Plugin for
    // this command, and reaching one is the missing-provider refusal.
    const ran = yield* submit(fixture, PUBLISHING(fixture), run, seen, { host: false });
    expect(ran.outcome?.ok).toBe(false);
    expect(seen.owners).toEqual([]);
    expect(types(ran.events)).not.toContain(REPL_REPOSITORY_PUSH_REQUEST);
    expect(types(ran.events)).not.toContain(GIT_HOST_EFFECT);
  });

  it("C5: an entry with no managed root declares the component and publishes nothing", function* () {
    const fixture = yield* useFixture();
    const seen = counted();
    const run = execution("execution-cli-5");

    const ran = yield* submit(
      fixture,
      [
        `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
        `  <Git.Push />`,
        `</Repository>`,
        "",
      ].join("\n"),
      run,
      seen,
      { root: undefined },
    );
    expect(ran.outcome?.ok).toBe(false);
    // It initialized — an entry with no managed root still records its file
    // work — and no publication exists to retain.
    expect(seen.initialized).toBe(1);
    expect(types(ran.events)).not.toContain(REPL_REPOSITORY_PUSH_REQUEST);
  });

  it("C6: the production selector carries one factory for every retained capability", function* () {
    const fixture = yield* useFixture();
    const flags = {
      agentProvider: "acpx",
      defaultAgent: "claude",
      approveAll: false,
      approveReads: false,
      denyAll: true,
    };

    const selected = yield* scoped(function* (): Operation<ReplExecutionProfile> {
      const stack = yield* resolveAgentStack(flags, undefined);
      if (!stack.ok) {
        throw stack.error;
      }
      yield* selectReplEntryHost(SUITE_HELPER, fixture.managed);
      return yield* assembleReplProfile(stack.value, NO_PLUGINS, {
        planWriterRoot: fixture.root,
      });
    });

    const factory = selected.entryInstallation;
    expect(typeof factory).toBe("function");
    if (factory === undefined) {
      throw new Error("the production selector selected no entry capability");
    }

    // Building one reaches nothing — no directory, no `git`, no credential, no
    // managed root and no pull-request session — and what it declares is the six
    // operations this entry retains, under names the command's scope has
    // already registered. The three evidence reads are named after their own
    // occurrences, which is why each is declared rather than left to the
    // registered default.
    const built = yield* scoped(function* (): Operation<ExecutionInstallation> {
      return yield* factory('["executablemd.repl.issue-owner",1,"execution-cli-6","1"]');
    });
    expect([...(built.components ?? [])].map((component) => component.name).sort()).toEqual([
      "Git.Push",
      "Issue",
      "PullRequest",
      "PullRequest.Checks",
      "PullRequest.Comments",
      "PullRequest.Reviews",
    ]);
    // Three admissions: the Issue history, the one walk that admits this
    // entry's saved Push and pull-request requests beside their outcomes, and
    // the retained reads, which are named by a question rather than paired with
    // an outcome.
    expect((built.admissions ?? []).length).toBe(3);
    expect(yield* nothingUnder(fixture.managed)).toBe(true);
  });
});

/** Whether this path still holds nothing, which is what inertness looks like. */
function* nothingUnder(path: string): Operation<boolean> {
  try {
    yield* writeTextFile(join(path, "probe"), "probe");
    return false;
  } catch {
    // The directory does not exist, which is the answer: nothing created it.
    return true;
  }
}
