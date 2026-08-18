/**
 * Tier WF — what a `<Git.Push>` retains, replays and refuses to guess.
 *
 * The claims here are about the run's database and the remote together. A
 * replayed push must reach no remote and append no second transition; a
 * retained record that no longer describes the invocation it was recorded for
 * must stop the run rather than be read around; a cancelled push must leave the
 * journal, the frontier and the materializations exactly as it found them; and
 * the request one invocation admitted must be the request it publishes for,
 * however the caller edits its own objects afterwards.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import { scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { GitOperationProtocolError, RepositoryStaleStateError } from "../src/composition/errors.ts";
import { GitHostProtocolError } from "../src/git-host/errors.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import type { RepositoryRecord } from "../src/composition/records.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome } from "../src/deno/composition/host.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { createRun, runPath, tamper, useStorageRoot, withStorage } from "./support/storage.ts";
import { remoteBranch, remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import {
  causedBy,
  compositionEvents,
  countingHost,
  countingOptions,
  gitHostEvents,
  gitHostOutcomes,
  headCommit,
  physicalGitApiCopy,
  raised,
  retainedRepositories,
  runWorkflowDocument,
  subcommands,
  survivingRoots,
  writeCheckoutFile,
} from "./support/composition.ts";
import {
  changedExactlyOne,
  committedRoot,
  dropRootClose,
  isStale,
  latestRoot,
  publishedRoots,
} from "./support/replay.ts";

const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "which.txt", content: "main\n" }] }],
} as const;

const BRANCH = "publish/1.4";
const DESTINATION = `refs/heads/${BRANCH}`;

function source(locator: string): string {
  return [
    `<Repository name="project" url="${locator}">`,
    `<Git.Switch branch="${BRANCH}" />`,
    `<Git.Push />`,
    "</Repository>",
  ].join("\n");
}

/** Every table this run's database holds, as another connection sees them. */
function tableNames(path: string): string[] {
  const names: string[] = [];
  tamper(path, (database) => {
    for (const row of database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()) {
      names.push(String(row["name"]));
    }
  });
  return names;
}

function isProtocolFailure(value: unknown): value is GitOperationProtocolError {
  return value instanceof GitOperationProtocolError;
}

function isHostProtocolFailure(value: unknown): value is GitHostProtocolError {
  return value instanceof GitHostProtocolError;
}

/**
 * Damage the one retained reconciliation record, and refuse if it damaged none.
 *
 * A tamper that matched nothing leaves the run healthy, and a regression built
 * on one passes by replaying an undamaged record.
 */
function damagePushRecord(path: string, damage: (record: Record<string, unknown>) => void): void {
  let rewritten = 0;
  tamper(path, (database) => {
    for (const row of database.prepare("SELECT sequence, record FROM journal_events").all()) {
      const parsed: unknown = JSON.parse(String(row["record"]));
      const description = Object(Reflect.get(Object(parsed), "description"));
      if (Reflect.get(description, "type") !== GIT_HOST_EFFECT) {
        continue;
      }
      damage(Object(Object(Reflect.get(Object(parsed), "result")).value));
      database
        .prepare("UPDATE journal_events SET record = ? WHERE sequence = ?")
        .run(JSON.stringify(parsed), row["sequence"]);
      rewritten += 1;
    }
  });
  if (rewritten !== 1) {
    throw new Error(`the journal holds ${rewritten} Git-host reconciliation records`);
  }
}

describe("workflow Git.Push durability", () => {
  it("replays without reaching a remote or appending a second transition", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(database, source(remote.locator));
      const head = yield* headCommit(
        database,
        (yield* retainedRepositories(database))[0]?.record.checkoutPath ?? "",
      );
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);
      const published = publishedRoots(path);

      dropRootClose(path);
      // Deleted, so what continues this run is what it retained or nothing.
      yield* remote.remove();

      const counting = countingHost();
      yield* runWorkflowDocument(database, source(remote.locator), countingOptions(counting));

      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      // The control repository is built on first use, so a replay that reaches
      // no provider builds none either.
      expect(subcommands(counting.counters)).not.toContain("init");
      expect(yield* gitHostEvents(database)).toHaveLength(1);
      expect(publishedRoots(path)).toBe(published);
      expect(yield* survivingRoots(counting.counters)).toEqual([]);
    });
  });

  /**
   * A completed push derives and parses its retained request, and asks the
   * object source for nothing.
   *
   * Containment is the live provider's first act, so a replay that performed it
   * anyway would fail here — the object graph is left in a state no push may
   * read from before the replay runs. It succeeds, which is the claim: the
   * shared engine hands back the retained record without reaching a provider,
   * so no graph is walked, no control repository is built and no Git runs for
   * the push.
   */
  it("replays a completed push over an object graph no live push would accept", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");
    const foreign = yield* useBareRemote({
      commits: [{ message: "foreign", entries: [{ path: "foreign.txt", content: "foreign\n" }] }],
    });

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(database, source(remote.locator));
      const published = yield* gitHostOutcomes(database);
      expect(published[0]?.status).toBe("ok");

      const [repository] = yield* retainedRepositories(database);
      const checkout = repository?.record.checkoutPath ?? "";
      yield* writeCheckoutFile(
        database,
        `${checkout}/.git/objects/info/alternates`,
        `${foreign.locator}/objects\n`,
        0o644,
      );
      dropRootClose(path);
      yield* remote.remove();

      const counting = countingHost();
      yield* runWorkflowDocument(database, source(remote.locator), countingOptions(counting));

      expect(subcommands(counting.counters)).not.toContain("init");
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(1);
      expect(yield* gitHostOutcomes(database)).toEqual(published);
    });
  });

  /**
   * Every way a retained record can stop describing the invocation it was
   * recorded for.
   *
   * Shape is the cheap half. The rest is meaning: a remote that is not origin,
   * a destination that is not the branch's ref, a refspec that is not this
   * commit published to that destination, an object id that is not one, and a
   * decision the pre-state cannot support. Each is damage a hand-edited or
   * foreign database can hold, and each has to stop the replay.
   */
  const DAMAGE: { name: string; damage: (record: Record<string, unknown>) => void }[] = [
    {
      name: "is missing a member the protocol declares",
      damage: (record) => {
        delete Object(record.result).observedRemoteCommit;
      },
    },
    {
      name: "carries more than the protocol declares",
      damage: (record) => {
        Object(record.result).stderr = "remote: everything is fine";
      },
    },
    {
      name: "names a remote that is not origin",
      damage: (record) => {
        Object(record.result).remote = "upstream";
      },
    },
    {
      name: "names a destination that is not the branch's ref",
      damage: (record) => {
        Object(record.result).destinationRef = "refs/heads/other";
      },
    },
    {
      name: "carries a refspec the commit and destination do not make",
      damage: (record) => {
        Object(record.result).refspec = `${"0".repeat(40)}:${DESTINATION}`;
      },
    },
    {
      name: "holds an object id in the wrong case",
      damage: (record) => {
        const commit = String(Object(record.result).sourceCommit).toUpperCase();
        Object(record.result).sourceCommit = commit;
        Object(record.result).refspec = `${commit}:${DESTINATION}`;
      },
    },
    {
      name: "observed a commit the push did not publish",
      damage: (record) => {
        Object(record.result).observedRemoteCommit = "0".repeat(40);
      },
    },
    {
      name: "disagrees with its own observations",
      damage: (record) => {
        Object(record.observations).remoteCommit = "0".repeat(40);
      },
    },
    {
      name: "claims a decision its pre-state cannot support",
      damage: (record) => {
        record.decision = "adopted";
      },
    },
    {
      name: "names another Repository",
      damage: (record) => {
        Object(Object(record.result).repository).name = "ghost";
      },
    },
  ];

  for (const { name, damage } of DAMAGE) {
    it(`fails a replay whose retained record ${name}`, function* () {
      const root = yield* useStorageRoot();
      const remote = yield* useBareRemote(REMOTE);
      const path = runPath(root, "release-1.4");

      yield* withStorage(root, function* () {
        const database = yield* createRun();
        yield* runWorkflowDocument(database, source(remote.locator));

        dropRootClose(path);
        damagePushRecord(path, damage);

        const counting = countingHost();
        const failure = yield* raised(
          runWorkflowDocument(database, source(remote.locator), countingOptions(counting)),
        );

        expect(causedBy(failure, isProtocolFailure)).toBeInstanceOf(GitOperationProtocolError);
        // Nothing was re-run to make up for the damage.
        expect(subcommands(counting.counters)).not.toContain("push");
        expect(subcommands(counting.counters)).not.toContain("ls-remote");
      });
    });
  }

  it("fails a replay whose retained record answers a different request", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(database, source(remote.locator));

      dropRootClose(path);
      damagePushRecord(path, (record) => {
        Object(Object(Object(record.request).inputs)).branch = "other";
      });

      const counting = countingHost();
      const failure = yield* raised(
        runWorkflowDocument(database, source(remote.locator), countingOptions(counting)),
      );

      expect(causedBy(failure, isHostProtocolFailure)).toBeInstanceOf(GitHostProtocolError);
      expect(subcommands(counting.counters)).not.toContain("push");
    });
  });

  it("publishes nothing and moves nothing when a blocked push is halted", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const observing = withResolvers<void>();
      const roots: string[] = [];
      const host = {
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "ls-remote") {
            observing.resolve();
            yield* suspend();
          }
          return yield* inner.git(invocation);
        },
        *useDirectory(): Operation<string> {
          const directory = yield* inner.useDirectory();
          roots.push(directory);
          return directory;
        },
      };

      yield* scoped(function* () {
        const task = yield* spawn(() =>
          runWorkflowDocument(database, source(remote.locator), { composition: { host } }),
        );
        yield* observing.operation;
        yield* task.halt();
      });

      // A cancelled attempt is not an outcome: no completion was invented, and
      // no failure was published for it either.
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(yield* survivingRoots({ commands: [], roots, effects: [], attachments: [] })).toEqual(
        [],
      );
    });
  });

  it("kills and reaps a blocked remote child before halt returns", function* () {
    const directory = yield* useTempDirectory("xmd-push-fifo-");
    const pipe = `${directory}/blocked`;
    const created = spawnSync("mkfifo", [pipe]);
    if (created.status !== 0) {
      throw new Error(`mkfifo exited ${created.status}: ${created.stderr}`);
    }

    const inner = denoRepositoryHost();
    // The remote observation, standing in for one that never answers: a real
    // Git child, really blocked, reached through the same host the push uses.
    const writer = yield* scoped(function* () {
      const task = yield* spawn(() =>
        inner.git({ args: ["hash-object", "--", pipe], cwd: directory, home: directory }),
      );
      // Returns only once the child has the read end open, so what is halted
      // below is a Git process that is provably running.
      const opened = yield* until(open(pipe, "w"));
      yield* task.halt();
      return opened;
    });

    // Sampled once, immediately: teardown waits for the child to close, so by
    // the time `halt()` returned there is nothing left holding the read end. A
    // cleanup that only signalled would still be racing here.
    const refused = yield* raised(until(writer.write("content")));
    yield* until(writer.close());
    expect(Reflect.get(Object(refused), "code")).toBe("EPIPE");
  });

  it("publishes for the request it admitted, however the caller edits its own", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const inner = denoRepositoryHost();
      const observing = withResolvers<void>();
      const editing = withResolvers<void>();
      const counting = countingHost({
        *git(invocation: GitInvocation): Operation<GitOutcome> {
          if (invocation.args[0] === "ls-remote") {
            observing.resolve();
            yield* editing.operation;
          }
          return yield* inner.git(invocation);
        },
        useDirectory: inner.useDirectory,
      });

      /**
       * A caller that keeps editing the objects it handed over.
       *
       * The request and the record inside it are the caller's own objects, and
       * a push has suspension points across which they can still change. What
       * this proves is that none of those edits reaches the effect: admission
       * took a snapshot before the first of them.
       */
      const mutating = (): ComponentRegistration => ({
        name: "Mutating",
        origin: "test",
        props: { type: "object", additionalProperties: true },
        *fn(): Operation<string> {
          const [repository] = yield* retainedRepositories(database);
          const record = repository?.record as RepositoryRecord;
          const observed: Record<string, unknown> = { ...record };
          const request = { repository: observed, workingDirectory: record.checkoutPath };
          const task = yield* spawn(() =>
            GitComposition.operations.pushCurrentBranch(
              request as unknown as { repository: RepositoryRecord; workingDirectory: string },
            ),
          );
          yield* observing.operation;
          observed.name = "ghost";
          observed.checkoutPath = "/repositories/ghost";
          observed.primaryBranch = "other";
          Reflect.set(request, "repository", { ...observed });
          Reflect.set(request, "workingDirectory", "/repositories/ghost");
          editing.resolve();
          yield* task;
          return "";
        },
      });

      yield* runWorkflowDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Git.Switch branch="${BRANCH}" />`,
          `<Mutating />`,
          "</Repository>",
        ].join("\n"),
        countingOptions(counting),
        (run) =>
          scoped(function* () {
            yield* registerComponents([mutating()]);
            return yield* run();
          }),
      );

      const head = yield* headCommit(
        database,
        (yield* retainedRepositories(database))[0]?.record.checkoutPath ?? "",
      );
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);

      const [outcome] = yield* gitHostOutcomes(database);
      expect(outcome?.status).toBe("ok");
      const published = JSON.stringify(outcome?.record);
      expect(published).toContain(`"name":"project"`);
      expect(published).not.toContain("ghost");
    });
  });

  it("routes a second loaded copy's request through the installed provider", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const loaded = yield* physicalGitApiCopy();
      const counting = countingHost();

      const through = (): ComponentRegistration => ({
        name: "Loaded",
        origin: "test",
        props: { type: "object", additionalProperties: true },
        *fn(): Operation<string> {
          const [repository] = yield* retainedRepositories(database);
          const record = repository?.record as RepositoryRecord;
          // A second physical module holding the same Api name. Sharing the
          // name is how composition works; it is deliberately not how authority
          // works, so this still reaches the one installed provider.
          yield* loaded.GitComposition.operations.pushCurrentBranch({
            repository: record,
            workingDirectory: record.checkoutPath,
          });
          return "";
        },
      });

      yield* runWorkflowDocument(
        database,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Git.Switch branch="${BRANCH}" />`,
          `<Loaded />`,
          "</Repository>",
        ].join("\n"),
        countingOptions(counting),
        (run) =>
          scoped(function* () {
            yield* registerComponents([through()]);
            return yield* run();
          }),
      );

      const head = yield* headCommit(
        database,
        (yield* retainedRepositories(database))[0]?.record.checkoutPath ?? "",
      );
      expect(remoteBranch(remote, BRANCH)).toBe(head.commit);
      expect(counting.counters.effects).toContain("git:push");
      expect((yield* gitHostOutcomes(database))[0]?.status).toBe("ok");
    });
  });

  it("moves no retained row and publishes no Workspace root", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(database, source(remote.locator));

      // Two Workspace effects published a root: the Repository and the switch.
      // The push published none — it imports no bytes and moves no frontier.
      expect(publishedRoots(path)).toBe(2);
      expect(committedRoot(path)).toBe(latestRoot(path));
      expect(yield* gitHostEvents(database)).toHaveLength(1);

      // The retained Repository row is the one its creation effect journaled:
      // a Push retains no host path, no materialization and no current branch.
      const [repository] = yield* retainedRepositories(database);
      const created = yield* compositionEvents(database);
      const journaled = Reflect.get(
        Object(Reflect.get(Object(Reflect.get(created[0] ?? {}, "result")), "value")),
        "record",
      );
      expect(repository?.record).toEqual(journaled);

      // The same run without a push, for the schema to be compared against: a
      // fixed list here would be a copy of the schema rather than a claim about
      // what Push adds to it, which is nothing.
      const unpushed = yield* createRun({ runId: "no-push" });
      yield* runWorkflowDocument(
        unpushed,
        [
          `<Repository name="project" url="${remote.locator}">`,
          `<Git.Switch branch="${BRANCH}" />`,
          "</Repository>",
        ].join("\n"),
      );
      expect(tableNames(path)).toEqual(tableNames(runPath(root, "no-push")));
    });
  });

  /**
   * Retained state that stopped agreeing with the identity naming it.
   *
   * Damaged between the Repository's attachment and the push, so the condition
   * is the one this operation's own selection finds rather than one attachment
   * had already found. Placement is a function of identity, so a `checkout_path`
   * that is no longer the one this run's placement gives that name is state the
   * run cannot have written — fatal, unrepaired, and reached before a host path
   * is joined or a remote exists in the story.
   */
  it("fails on retained state that no longer agrees, without reaching a remote", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const path = runPath(root, "release-1.4");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost();

      const damaging: ComponentRegistration = {
        name: "Damage",
        origin: "test",
        props: { type: "object", additionalProperties: true },
        // deno-lint-ignore require-yield
        *fn(): Operation<string> {
          changedExactlyOne(
            path,
            "UPDATE workspace_repositories SET checkout_path = ? WHERE name = ?",
            ["/repositories/moved", "project"],
          );
          return "";
        },
      };

      const failure = yield* raised(
        runWorkflowDocument(
          database,
          [
            `<Repository name="project" url="${remote.locator}">`,
            `<Git.Switch branch="${BRANCH}" />`,
            `<Damage />`,
            `<Git.Push />`,
            "</Repository>",
          ].join("\n"),
          countingOptions(counting),
          (run) =>
            scoped(function* () {
              yield* registerComponents([damaging]);
              return yield* run();
            }),
        ),
      );

      expect(causedBy(failure, isStale)).toBeInstanceOf(RepositoryStaleStateError);
      expect(subcommands(counting.counters)).not.toContain("ls-remote");
      expect(subcommands(counting.counters)).not.toContain("push");
      expect(yield* gitHostEvents(database)).toHaveLength(0);
      expect(remoteRefs(remote).has(DESTINATION)).toBe(false);
    });
  });
});
