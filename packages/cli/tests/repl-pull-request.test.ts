/**
 * How a REPL entry gets its pull-request capability, and who never gets one.
 *
 * The entry host prepares two kinds of thing per entry, and pull requests sit
 * on both sides of that line. The upsert needs the private initialization its
 * checkouts and publications are created by; the three evidence reads need none
 * of it, because a read names a URL. These rows hold the assembly to that
 * shape — four identities declared together, one initialization per executing
 * entry, reads that work with no managed root at all, and the existing
 * capabilities intact beside the new ones.
 *
 * Every row drives the production path: the real selector, the real per-entry
 * factory, the real session. Nothing here reaches a Git host, because none of
 * what these rows are about happens after a request exists.
 *
 * They carry V9 of the delivery-5 matrix.
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
import { replRepositoryInstallation } from "../../git/src/deno/retained-repository/provider.ts";
import { REPL_REPOSITORY_PULL_REQUEST_REQUEST } from "../../git/src/retained-repository/pull-request-records.ts";
import { PULL_REQUEST_READ } from "../../git/src/deno/composition/pull-request-operations.ts";
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
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-pr-cli-")))));
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

/** What the Git Plugin contributes for the `repl` command. */
function* replInstallations(): Operation<readonly ExecutionInstallation[]> {
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
                  host: denoRepositoryHost(),
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
            host: denoRepositoryHost(),
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

describe("how a REPL entry gets its pull-request capability", () => {
  it("D1: one executing entry declares all four identities under its own owner", function* () {
    const fixture = yield* useFixture();
    const seen = counted();
    const run = execution("execution-pr-cli-1");

    // Inspection describes the four components this capability adds, beside
    // the ones it already had.
    const built = yield* scoped(function* (): Operation<ExecutionInstallation> {
      return yield* replRepositoryInstallation(
        '["executablemd.repl.issue-owner",1,"execution-pr-cli-1","1"]',
        { host: denoRepositoryHost(), root: fixture.managed },
      );
    });
    const declared = [...(built.components ?? [])].map((component) => component.name).sort();
    expect(declared).toEqual([
      "Git.Push",
      "Issue",
      "PullRequest",
      "PullRequest.Checks",
      "PullRequest.Comments",
      "PullRequest.Reviews",
    ]);

    // And building one reaches nothing: no managed root, no `git`, no
    // credential and no service.
    expect(yield* nothingUnder(fixture.managed)).toBe(true);
    expect(seen.initialized).toBe(0);
    expect(run.id).toBe("execution-pr-cli-1");
  });

  it("D2: with no entry capability selected, all four reach the ordinary refusal", function* () {
    const fixture = yield* useFixture();

    // What Node and Bun leave: the components are declared by the Plugin for
    // this command, and reaching one is the missing-provider refusal. No
    // native work and no service call happens on the way to it.
    for (const element of [
      '<PullRequest title="Prepare notes" as="pullRequest">body</PullRequest>',
      '<PullRequest.Reviews url="https://github.com/octo/project/pull/7" as="reviews" />',
      '<PullRequest.Comments url="https://github.com/octo/project/pull/7" as="comments" />',
      '<PullRequest.Checks url="https://github.com/octo/project/pull/7" as="checks" />',
    ]) {
      const seen = counted();
      const run = execution(`execution-pr-cli-2-${element.length}`);
      const source = element.startsWith("<PullRequest.")
        ? `${element}\n`
        : [
            `<Repository name="project" url=${JSON.stringify(fixture.origin)}>`,
            `  ${element}`,
            `</Repository>`,
            "",
          ].join("\n");
      const ran = yield* submit(fixture, source, run, seen, { host: false });
      expect(ran.outcome?.ok).toBe(false);
      expect(seen.owners).toEqual([]);
      expect(types(ran.events)).not.toContain(REPL_REPOSITORY_PULL_REQUEST_REQUEST);
      expect(types(ran.events)).not.toContain(PULL_REQUEST_READ);
      expect(types(ran.events)).not.toContain(GIT_HOST_EFFECT);
    }
  });

  it("D3: an entry with no managed root still declares the reads", function* () {
    const fixture = yield* useFixture();

    // A read needs no checkout, so the identities are declared whether or not
    // this host selects a managed root — and selecting none creates none.
    const built = yield* scoped(function* (): Operation<ExecutionInstallation> {
      return yield* replRepositoryInstallation(
        '["executablemd.repl.issue-owner",1,"execution-pr-cli-3","1"]',
        { host: denoRepositoryHost() },
      );
    });
    const declared = [...(built.components ?? [])].map((component) => component.name);
    expect(declared).toContain("PullRequest.Reviews");
    expect(declared).toContain("PullRequest.Comments");
    expect(declared).toContain("PullRequest.Checks");
    expect(yield* nothingUnder(fixture.managed)).toBe(true);
  });

  it("D4: a passive view of a settled history initializes nothing", function* () {
    const fixture = yield* useFixture();
    const first = counted();
    const run = execution("execution-pr-cli-4");
    const ran = yield* submit(fixture, PUBLISHING(fixture), run, first);
    expect(ran.outcome?.ok).toBe(true);
    expect(first.initialized).toBe(1);

    const passive = counted();
    const again = yield* reopen(fixture, execution(run.id, ran.events), passive);
    expect(again.outcome?.ok).toBe(true);
    expect(passive.owners).toEqual([]);
    expect(passive.initialized).toBe(0);
  });

  it("D5: the entry declares one admission for its reads beside the others", function* () {
    const fixture = yield* useFixture();
    const built = yield* scoped(function* (): Operation<ExecutionInstallation> {
      return yield* replRepositoryInstallation(
        '["executablemd.repl.issue-owner",1,"execution-pr-cli-5","1"]',
        { host: denoRepositoryHost(), root: fixture.managed },
      );
    });
    // Three: the issues history, this entry's publication and pull-request
    // history, and its evidence reads.
    expect((built.admissions ?? []).length).toBe(3);
  });
});

/** Whether this path still holds nothing, which is what inertness looks like. */
function* nothingUnder(path: string): Operation<boolean> {
  try {
    yield* writeTextFile(join(path, "probe"), "probe");
    return false;
  } catch {
    return true;
  }
}
