/**
 * Tier WA — the authentication a live provider invocation borrows from its host.
 *
 * The claim is about two things that must stay apart: a run reaches a protected
 * remote as whoever is standing at the host right now, and nothing about that
 * identity survives into what the run retains. Rendered text proves neither, so
 * every test here reads one of the places an answer actually lives — what the
 * remote received, which locator a session was opened for, how many sessions one
 * document opened, and what the journal and Workspace hold afterwards.
 *
 * Nothing here reads a developer's real credential or contacts a network host,
 * and nothing here injects one either. The provider is never handed a credential
 * to inject: it re-states the helpers an invoking user configured, and Git asks
 * them. So the fixture is an invoking home with a helper program in it, and the
 * protected remote is `git http-backend` behind a loopback listener that answers
 * `401` until the credential that home's helper holds arrives.
 *
 * No assertion in this file names a credential. A remote reports whether what
 * arrived was the one it requires; a leakage check reduces to a boolean before
 * it is asserted, so a failure prints a verdict rather than a secret.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { lstat } from "@effectionx/fs";
import { chmod, writeFile } from "node:fs/promises";
import { ensure, resource, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { RepositoryCompositionError } from "../src/composition/errors.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import {
  denoGitAuthentication,
  gitTransport,
  sshCommand,
  configuredCredentialSettings,
} from "../src/deno/composition/authentication.ts";
import type {
  GitAuthentication,
  GitAuthenticationSession,
} from "../src/deno/composition/authentication.ts";
import { denoGitHubAccess, gitHubSource } from "../src/deno/composition/github.ts";
import type {
  GitHubAccess,
  GitHubHttpResponse,
  GitHubLogin,
  GitHubSource,
} from "../src/deno/composition/github.ts";
import { GITHUB, useGitHubIssues } from "../src/deno/issue/github.ts";
import { IssueApi } from "../src/issue/api.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";
import { remoteBranch, remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import { useGitHttpRemote } from "./support/git-http.ts";
import type { GitHttpRemote } from "./support/git-http.ts";
import { useHomeWithoutAuthentication, useInvokingHome } from "./support/credential-home.ts";
import {
  fixture as pullRequestFixture,
  published as publishedPullRequest,
  pullRequest as onePullRequest,
  REMOTE as PULL_REQUEST_REMOTE,
} from "./support/pull-requests.ts";
import type { InvokingHome } from "./support/credential-home.ts";
import {
  causedBy,
  compositionEvents,
  countingHost,
  countingOptions,
  gitHostOutcomes,
  inCheckout,
  raised,
  retainedRepositories,
  runDocument,
  runWorkflowDocument,
  subcommands,
  workspaceText,
} from "./support/composition.ts";

/**
 * The credential this suite's remotes require.
 *
 * Held here so a fixture can arrange both ends of an exchange it is not allowed
 * to observe. Neither string ever reaches an assertion: what a test compares is
 * a boolean this module computed, so a failure prints a verdict.
 */
const FIRST = { username: "ambient-user-one", password: "ambient-secret-one" } as const;
const SECOND = { username: "ambient-user-two", password: "ambient-secret-two" } as const;

/** Whether any credential this suite arranged appears in `text`. */
function carriesCredential(text: string): boolean {
  for (const entry of [FIRST, SECOND]) {
    if (text.includes(entry.password) || text.includes(entry.username)) {
      return true;
    }
  }
  return false;
}

const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "README.md", content: "protected\n" }] }],
} as const;

/** The shipped authentication, standing in this invoking environment. */
function hostFor(home: InvokingHome) {
  return denoRepositoryHost({
    authentication: denoGitAuthentication({ ambient: home.ambient }),
  });
}

/** Every locator a session was opened for, in order. */
interface RecordedAuthentication {
  readonly authentication: GitAuthentication;
  readonly locators: string[];
}

/**
 * The shipped authentication, counted.
 *
 * A decorator rather than a stand-in, so a suite asserting how many sessions a
 * document opened, and for what, is asserting about the sessions that were
 * actually opened.
 */
function recording(inner: GitAuthentication): RecordedAuthentication {
  const locators: string[] = [];
  return {
    locators,
    authentication: {
      open(locator: string): Operation<GitAuthenticationSession> {
        locators.push(locator);
        return inner.open(locator);
      },
    },
  };
}

/** An authentication no correct run may reach. */
function forbidden(reached: string[]): GitAuthentication {
  return {
    // deno-lint-ignore require-yield
    *open(locator: string): Operation<GitAuthenticationSession> {
      reached.push(locator);
      throw new Error("a session was opened where none may be");
    },
  };
}

function isRepositoryRefusal(value: unknown): value is RepositoryCompositionError {
  return value instanceof RepositoryCompositionError;
}

function* present(path: string): Operation<boolean> {
  try {
    yield* lstat(path);
    return true;
  } catch {
    return false;
  }
}

function* checkoutPath(database: WorkflowRunDatabase): Operation<string> {
  const [repository] = yield* retainedRepositories(database);
  if (repository === undefined) {
    throw new Error("the run retains no Repository");
  }
  return repository.record.checkoutPath;
}

function document(locator: string, ...lines: string[]): string {
  return [`<Repository name="project" url="${locator}">`, ...lines, "</Repository>"].join("\n");
}

/** Switch to a branch, record one commit on it and publish it. */
function published(locator: string, ...extra: string[]): string {
  return document(
    locator,
    `<Git.Switch branch="publish/1.4" />`,
    `<File path="notes.md">`,
    "prepared",
    "</File>",
    `<Git.Add paths="notes.md" />`,
    `<Git.Commit message="prepare the release" as="commit" />`,
    ...extra,
  );
}

/** Append configuration to the retained checkout mid-document. */
function plant(database: WorkflowRunDatabase, configuration: string): ComponentRegistration {
  return {
    name: "Plant",
    origin: "test",
    props: { type: "object", additionalProperties: true },
    *fn(): Operation<string> {
      const checkout = yield* checkoutPath(database);
      const written = yield* transactWorkspaceRoots(database, function* (workspace) {
        const current = yield* workspace.filesystem.readTextFile(`${checkout}/.git/config`);
        yield* workspace.filesystem.writeFile(
          `${checkout}/.git/config`,
          `${current}\n${configuration}`,
        );
        const captured = yield* workspace.capture();
        yield* workspace.publish(captured.rootId);
      });
      if (!written.ok) {
        throw written.error;
      }
      return "";
    },
  };
}

/** One protected remote, and the bare repository behind it. */
function* protectedRemote(
  credential: { username: string; password: string },
  label: string,
): Operation<GitHttpRemote> {
  const bare = yield* useBareRemote(REMOTE);
  return yield* useGitHttpRemote({ remote: bare, label, ...credential });
}

describe("workflow ambient Git authentication", () => {
  it("clones a protected remote through the helper the invoking host configured", function* () {
    const root = yield* useStorageRoot();
    const served = yield* protectedRemote(FIRST, "first");
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(home));
      const output = yield* runDocument(
        database,
        document(served.locator, `<File path="README.md" as="readme" />`, "", "read: {readme}"),
        countingOptions(counting),
      );

      expect(String(output)).toContain("read: protected");

      // The exchange the remote saw: a first request with no credential, which
      // is what produces the challenge, and then one it accepted.
      expect(served.requests[0]?.credentialed).toBe(false);
      expect(served.requests.some((request) => request.accepted)).toBe(true);

      // What was retained is the credential-free locator, unchanged.
      const [retained] = yield* retainedRepositories(database);
      expect(retained?.locator).toBe(served.locator);
      expect(subcommands(counting.counters)).toContain("clone");
    });
  });

  it("refuses a protected clone this host has no mechanism for, distinctly", function* () {
    const root = yield* useStorageRoot();
    const served = yield* protectedRemote(FIRST, "first");
    const home = yield* useHomeWithoutAuthentication();

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(home));
      const failure = yield* raised(
        runDocument(database, document(served.locator, "unreachable"), countingOptions(counting)),
      );

      // Its own word. A locator this provider could have used, reached with no
      // way to prove who this run is, is a live host condition rather than a
      // fault in what the document wrote — and neither is it remote absence.
      expect(causedBy(failure, isRepositoryRefusal)?.reason).toBe("authentication-unavailable");

      // Nothing was adopted and nothing was published: no request the remote saw
      // was accepted, and the run retains no repository. The one journaled event
      // is the failed establishment, which is what makes a later attempt a new
      // attempt rather than a replay of a completion nobody reached.
      expect(served.requests.every((request) => !request.accepted)).toBe(true);
      expect(yield* retainedRepositories(database)).toHaveLength(0);
      const events = yield* compositionEvents(database);
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0])).toContain('"status":"err"');
    });
  });

  it("publishes to a protected remote through the same ambient authentication", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    const served = yield* useGitHttpRemote({ remote: bare, label: "first", ...FIRST });
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(home));
      yield* runWorkflowDocument(
        database,
        published(served.locator, `<Git.Push />`),
        countingOptions(counting),
      );

      // The other end of the transport is what proves a push happened.
      expect(remoteBranch(bare, "publish/1.4")).toBeDefined();
      expect((yield* gitHostOutcomes(database))[0]?.status).toBe("ok");
      const ran = subcommands(counting.counters);
      expect(ran).toContain("push");
      expect(ran).toContain("ls-remote");
    });
  });

  it("opens one session per provider invocation, not per command", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    const served = yield* useGitHttpRemote({ remote: bare, label: "first", ...FIRST });
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const recorded = recording(denoGitAuthentication({ ambient: home.ambient }));
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );
      yield* runWorkflowDocument(
        database,
        published(served.locator, `<Git.Push />`),
        countingOptions(counting),
      );

      // Two live provider invocations — the Repository's creation and the
      // Push's reconciliation — and therefore two sessions, each for this
      // Repository's own retained locator.
      expect(recorded.locators).toEqual([served.locator, served.locator]);

      // Three commands left the materialization: the clone, the push and the
      // observation that decided it. The observation and the mutation share one
      // session, so they go out under one identity rather than two.
      const ran = subcommands(counting.counters);
      const transporting = ran.filter(
        (name) => name === "clone" || name === "push" || name === "ls-remote",
      );
      expect(transporting.length).toBeGreaterThan(recorded.locators.length);
    });
  });

  it("cannot use one protected locator's authentication for another", function* () {
    const root = yield* useStorageRoot();
    const first = yield* protectedRemote(FIRST, "first");
    const second = yield* protectedRemote(SECOND, "second");
    // The invoking host can prove an identity to the first remote and to no
    // other. The second is protected by a different credential entirely.
    const home = yield* useInvokingHome([{ host: first.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const recorded = recording(denoGitAuthentication({ ambient: home.ambient }));
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );
      const failure = yield* raised(
        runDocument(
          database,
          [
            `<Repository name="reachable" url="${first.locator}" />`,
            `<Repository name="unreachable" url="${second.locator}" />`,
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      // Each Repository opened its own session, for its own locator.
      expect(recorded.locators).toEqual([first.locator, second.locator]);

      // The first was authenticated and the second was refused: what the host
      // could prove to one remote proved nothing at the other, and nothing this
      // run held carried across.
      expect(first.requests.some((request) => request.accepted)).toBe(true);
      expect(second.requests.length).toBeGreaterThan(0);
      expect(second.requests.every((request) => !request.accepted)).toBe(true);
      expect(causedBy(failure, isRepositoryRefusal)).toBeDefined();
      expect((yield* retainedRepositories(database)).map((entry) => entry.record.name)).toEqual([
        "reachable",
      ]);
    });
  });

  it("opens no session when a completed run replays", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    const served = yield* useGitHttpRemote({ remote: bare, label: "first", ...FIRST });
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const source = document(
        served.locator,
        `<File path="README.md" as="readme" />`,
        "",
        "read: {readme}",
      );
      yield* runDocument(database, source, countingOptions(countingHost(hostFor(home))));

      const reached: string[] = [];
      const counting = countingHost(denoRepositoryHost({ authentication: forbidden(reached) }));
      const before = served.requests.length;
      const output = yield* runDocument(database, source, countingOptions(counting));

      expect(String(output)).toContain("read: protected");
      expect(reached).toEqual([]);
      expect(subcommands(counting.counters)).not.toContain("clone");
      // And no remote was contacted, authenticated or otherwise.
      expect(served.requests).toHaveLength(before);
    });
  });

  it("keeps the credential out of every durable and observable surface", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    const served = yield* useGitHttpRemote({ remote: bare, label: "first", ...FIRST });
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(home));
      const output = yield* runWorkflowDocument(
        database,
        published(
          served.locator,
          `<Git.Push />`,
          `<File path="README.md" as="readme" />`,
          "",
          "read: {readme}",
        ),
        countingOptions(counting),
      );

      // Rendered output, every journaled event, the retained records, the whole
      // command list this run issued, and the Workspace's own configuration.
      // Each is reduced to a verdict before it is asserted.
      expect(carriesCredential(String(output))).toBe(false);
      expect(carriesCredential(JSON.stringify(yield* compositionEvents(database)))).toBe(false);
      expect(carriesCredential(JSON.stringify(yield* gitHostOutcomes(database)))).toBe(false);
      expect(carriesCredential(JSON.stringify(yield* retainedRepositories(database)))).toBe(false);
      expect(carriesCredential(JSON.stringify(counting.counters.commands))).toBe(false);

      const [retained] = yield* retainedRepositories(database);
      const config = yield* workspaceText(
        database,
        `${retained?.record.checkoutPath ?? ""}/.git/config`,
      );
      expect(carriesCredential(config)).toBe(false);
    });
  });

  it("keeps it out of a refusal, its diagnostics and its causes too", function* () {
    const root = yield* useStorageRoot();
    const served = yield* protectedRemote(FIRST, "first");
    // A home whose helper answers for somewhere else entirely, so the exchange
    // happens and still proves nothing at this remote.
    const home = yield* useInvokingHome([{ host: "elsewhere.invalid", ...SECOND }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(home));
      const failure = yield* raised(
        runDocument(database, document(served.locator, "unreachable"), countingOptions(counting)),
      );

      const refusal = causedBy(failure, isRepositoryRefusal);
      expect(refusal).toBeDefined();
      // The failure itself, everything under it, and what the journal kept of
      // it. A refusal is where a provider is most tempted to explain itself.
      expect(carriesCredential(String(refusal?.message ?? ""))).toBe(false);
      expect(carriesCredential(String(failure))).toBe(false);
      expect(carriesCredential((failure as Error)?.stack ?? "")).toBe(false);
      expect(carriesCredential(JSON.stringify(yield* compositionEvents(database)))).toBe(false);
      expect(carriesCredential(JSON.stringify(counting.counters.commands))).toBe(false);
      expect(served.requests.every((request) => !request.accepted)).toBe(true);
    });
  });
});

describe("workflow ambient authentication containment", () => {
  /**
   * A checkout's own configuration, naming the two settings this change adds to
   * the family the provider fixes.
   *
   * Both name a program, both are things a document can write into a Workspace
   * the run restores on replay, and both would otherwise decide how a remote
   * operation authenticates. The trap is armed rather than assumed: after the
   * provider's push, the same checkout is pushed the ordinary way, and that one
   * does run the planted helper. A setting Git would have ignored anyway would
   * prove nothing.
   */
  it("cannot be replaced by a credential helper planted in retained configuration", function* () {
    const root = yield* useStorageRoot();
    const witness = yield* useTempDirectory("xmd-ambient-helper-");
    const sentinel = `${witness}/helper-ran`;
    const planted = `${witness}/helper.sh`;
    yield* until(
      writeFile(planted, ["#!/bin/sh", `echo ran > ${sentinel}`, "exit 1", ""].join("\n"), {
        mode: 0o700,
      }),
    );
    yield* until(chmod(planted, 0o700));

    const bare = yield* useBareRemote(REMOTE);
    const served = yield* useGitHttpRemote({ remote: bare, label: "first", ...FIRST });
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);
    const hostile = [
      "[credential]",
      `\thelper = ${planted}`,
      "[core]",
      `\tsshCommand = ${planted}`,
      "",
    ].join("\n");

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(home));
      yield* runWorkflowDocument(
        database,
        published(served.locator, `<Plant />`, `<Git.Push />`),
        countingOptions(counting),
        (run) =>
          scoped(function* () {
            yield* registerComponents([plant(database, hostile)]);
            return yield* run();
          }),
      );

      // The push happened, through the host's own helper, and the program the
      // document named never ran.
      expect(remoteBranch(bare, "publish/1.4")).toBeDefined();
      expect(yield* present(sentinel)).toBe(false);
      expect((yield* gitHostOutcomes(database))[0]?.status).toBe("ok");

      // The trap really was armed. The same checkout, pushed the ordinary way —
      // with its own configuration in force rather than a session that resets
      // it — does reach the planted helper, and publishes nothing.
      //
      // Asynchronously, because the remote is a listener in this process: a
      // synchronous child would hold the event loop the server answers on and
      // the two would wait for each other.
      const checkout = yield* checkoutPath(database);
      const ordinary = yield* inCheckout(database, checkout, function* (run) {
        return yield* raised(run(["push", "origin", "publish/1.4:refs/heads/ordinary"]));
      });
      expect(ordinary).toBeDefined();
      expect(yield* present(sentinel)).toBe(true);
      expect(remoteRefs(bare).has("refs/heads/ordinary")).toBe(false);
    });
  });
});

/**
 * What a cancelled invocation leaves behind, which must be nothing.
 *
 * Cancellation is the case where a completion is most easily invented and a
 * resource most easily leaked: the operation stops between establishing an
 * identity and proving anything with it. These drive it deterministically —
 * blocked in the acquisition, and blocked in the transport it authenticated —
 * and then read the two places an answer could wrongly appear.
 */
describe("workflow ambient authentication cancellation", () => {
  /** The shipped authentication, with every session's life recorded. */
  function tracked(inner: GitAuthentication, gate?: () => Operation<void>) {
    const opened: string[] = [];
    const disposed: string[] = [];
    return {
      opened,
      disposed,
      authentication: {
        open(locator: string): Operation<GitAuthenticationSession> {
          return resource(function* (provide) {
            opened.push(locator);
            // Registered before anything can suspend, so a halt between here
            // and the block below still runs it.
            yield* ensure(() => {
              disposed.push(locator);
            });
            if (gate !== undefined) {
              yield* gate();
            }
            yield* provide(yield* inner.open(locator));
          });
        },
      },
    };
  }

  /**
   * The working directories this run's own sessions opened and released.
   *
   * Watched rather than scanned for: a prefix search of the temporary directory
   * is a claim about the whole machine, and two concurrent invocations would
   * each see the other's.
   */
  function watching() {
    const opened: string[] = [];
    const released: string[] = [];
    return {
      observe: {
        opened: (directory: string) => opened.push(directory),
        released: (directory: string) => released.push(directory),
      },
      /** Every directory this run opened and did not release. */
      surviving: () => opened.filter((directory) => !released.includes(directory)),
    };
  }

  it("invents nothing when cancelled while acquisition is blocked", function* () {
    const root = yield* useStorageRoot();
    const served = yield* protectedRemote(FIRST, "first");
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const reached = withResolvers<void>();
      const watcher = watching();
      const recorded = tracked(
        denoGitAuthentication({ ambient: home.ambient, observe: watcher.observe }),
        function* () {
          reached.resolve();
          yield* suspend();
        },
      );
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );

      yield* scoped(function* () {
        const running = yield* spawn(() =>
          runDocument(database, document(served.locator, "unreachable"), countingOptions(counting)),
        );
        yield* reached.operation;
        yield* running.halt();
      });

      // One session opened, one disposed, and nothing performed: the remote was
      // never contacted, nothing is retained, and no completion exists.
      expect(recorded.opened).toEqual([served.locator]);
      expect(recorded.disposed).toEqual([served.locator]);
      expect(served.requests).toHaveLength(0);
      expect(yield* retainedRepositories(database)).toHaveLength(0);
      expect(subcommands(counting.counters)).not.toContain("clone");
      expect(watcher.surviving()).toEqual([]);
    });
  });

  it("invents nothing when cancelled mid-transport, after the remote accepted it", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    const reached = withResolvers<void>();
    let holding = true;
    // Held on the remote rather than around the host: the point of this case is
    // that a real Git child has a real connection open to a server that proved
    // the credential and will not answer. Suspending before `git()` would stop
    // before any of that exists.
    const served = yield* useGitHttpRemote({
      remote: bare,
      label: "first",
      ...FIRST,
      hold: (request) => {
        if (holding && request.accepted) {
          reached.resolve();
          return true;
        }
        return false;
      },
    });
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);
    const source = document(
      served.locator,
      `<File path="README.md" as="readme" />`,
      "",
      "read: {readme}",
    );

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const watcher = watching();
      const recorded = tracked(
        denoGitAuthentication({ ambient: home.ambient, observe: watcher.observe }),
      );
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );

      yield* scoped(function* () {
        const running = yield* spawn(() =>
          runDocument(database, source, countingOptions(counting)),
        );
        yield* reached.operation;
        // The halt returns only once teardown is complete, which for this host
        // means the Git child is gone and both its pipes have ended — a
        // cancellation that merely signalled would return here with the child
        // still holding the connection.
        yield* running.halt();
      });

      // The remote did accept a request, so the transport really was live and
      // authenticated when it stopped.
      expect(served.requests.some((request) => request.accepted)).toBe(true);
      // The session existed, was disposed exactly once, and produced no
      // completion — a cancelled clone is not a repository this run has.
      expect(recorded.opened).toEqual([served.locator]);
      expect(recorded.disposed).toEqual([served.locator]);
      expect(yield* retainedRepositories(database)).toHaveLength(0);
      expect(watcher.surviving()).toEqual([]);

      // And the attempt after it acquires again rather than continuing under an
      // identity nobody re-proved.
      holding = false;
      const output = yield* runDocument(database, source, countingOptions(counting));
      expect(String(output)).toContain("read: protected");
      expect(recorded.opened).toEqual([served.locator, served.locator]);
      expect(watcher.surviving()).toEqual([]);
    });
  });

  it("disposes one session per invocation on success and on refusal alike", function* () {
    const root = yield* useStorageRoot();
    const reachable = yield* protectedRemote(FIRST, "first");
    const refused = yield* protectedRemote(SECOND, "second");
    const home = yield* useInvokingHome([{ host: reachable.host, ...FIRST }]);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const watcher = watching();
      const recorded = tracked(
        denoGitAuthentication({ ambient: home.ambient, observe: watcher.observe }),
      );
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );
      yield* raised(
        runDocument(
          database,
          [
            `<Repository name="reachable" url="${reachable.locator}" />`,
            `<Repository name="unreachable" url="${refused.locator}" />`,
          ].join("\n"),
          countingOptions(counting),
        ),
      );

      // Two invocations, two sessions, each disposed once — the one that
      // succeeded and the one that was refused.
      expect(recorded.opened).toEqual([reachable.locator, refused.locator]);
      expect(recorded.disposed).toHaveLength(2);
      expect(new Set(recorded.disposed)).toEqual(new Set(recorded.opened));
      expect(watcher.surviving()).toEqual([]);
    });
  });

  it("performs a fresh acquisition on the attempt after a cancelled one", function* () {
    const root = yield* useStorageRoot();
    const served = yield* protectedRemote(FIRST, "first");
    const home = yield* useInvokingHome([{ host: served.host, ...FIRST }]);
    const source = document(
      served.locator,
      `<File path="README.md" as="readme" />`,
      "",
      "read: {readme}",
    );

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const blocked = withResolvers<void>();
      let block = true;
      const watcher = watching();
      const inner = denoGitAuthentication({ ambient: home.ambient, observe: watcher.observe });
      const recorded = tracked(inner, function* () {
        if (block) {
          blocked.resolve();
          yield* suspend();
        }
      });
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );

      yield* scoped(function* () {
        const running = yield* spawn(() =>
          runDocument(database, source, countingOptions(counting)),
        );
        yield* blocked.operation;
        yield* running.halt();
      });
      expect(recorded.opened).toHaveLength(1);

      // Nothing was retained, so the next attempt is a first attempt — and it
      // opens its own session rather than continuing under one nobody re-proved.
      block = false;
      const output = yield* runDocument(database, source, countingOptions(counting));
      expect(String(output)).toContain("read: protected");
      expect(recorded.opened).toEqual([served.locator, served.locator]);
      expect(recorded.disposed).toHaveLength(2);
      expect(watcher.surviving()).toEqual([]);
    });
  });
});

describe("workflow ambient authentication mechanisms", () => {
  it("names the transport a locator uses, and authenticates only two of them", function* () {
    expect(gitTransport("https://example.invalid/owner/project.git")).toBe("http");
    expect(gitTransport("http://127.0.0.1:8080/project.git")).toBe("http");
    expect(gitTransport("ssh://git@example.invalid/owner/project.git")).toBe("ssh");
    expect(gitTransport("git@example.invalid:owner/project.git")).toBe("ssh");
    // Neither of these carries an identity, so there is nothing to borrow.
    expect(gitTransport("/tmp/xmd-remote/remote.git")).toBe("none");
    expect(gitTransport("file:///tmp/xmd-remote/remote.git")).toBe("none");
    expect(gitTransport("git://example.invalid/project.git")).toBe("none");
  });

  it("pins SSH so no configuration redirects it and no prompt can appear", function* () {
    const pinned = sshCommand("/home/person", "/tmp/agent.sock");
    expect(pinned).toContain("'-F' '/dev/null'");
    expect(pinned).toContain("'BatchMode=yes'");
    expect(pinned).toContain("'StrictHostKeyChecking=yes'");
    expect(pinned).toContain("'IdentityAgent=/tmp/agent.sock'");
    expect(pinned).toContain("'UserKnownHostsFile=/home/person/.ssh/known_hosts'");
    // Host verification is never turned off, whatever the invoking host looks
    // like.
    expect(pinned).not.toContain("StrictHostKeyChecking=no");
    expect(pinned).not.toContain("StrictHostKeyChecking=accept-new");

    // No agent is an answer rather than a search for key files.
    expect(sshCommand("/home/person", undefined)).toContain("'IdentityAgent=none'");
    expect(sshCommand("/home/person", "")).toContain("'IdentityAgent=none'");
  });

  it("lends the invoking agent to an SSH locator, and says it has one", function* () {
    const home = yield* useHomeWithoutAuthentication();
    const session = yield* denoGitAuthentication({
      ambient: { ...home.ambient, SSH_AUTH_SOCK: "/tmp/ambient-agent.sock" },
    }).open("ssh://git@example.invalid/owner/project.git");

    expect(session.attachment.environment).toEqual({
      SSH_AUTH_SOCK: "/tmp/ambient-agent.sock",
    });
    expect(session.mechanism).toBe("ssh-agent");
  });

  it("stands on nothing for SSH with no agent, and says so", function* () {
    const home = yield* useHomeWithoutAuthentication();
    const session = yield* denoGitAuthentication({ ambient: home.ambient }).open(
      "ssh://git@example.invalid/owner/project.git",
    );

    expect(session.attachment.environment).toEqual({});
    expect(session.mechanism).toBe("none");
  });

  it("fixes the settings a retained repository could otherwise name", function* () {
    const home = yield* useInvokingHome([]);
    const session = yield* denoGitAuthentication({ ambient: home.ambient }).open(
      "https://example.invalid/owner/project.git",
    );

    // The reset is what makes the helper list this host's own: it is
    // multi-valued, so a helper in a configuration file would otherwise be
    // tried beside whatever the session states after it.
    expect(session.attachment.configuration).toContain("credential.helper=");
    const settings = session.attachment.configuration;
    for (const key of ["core.sshCommand=", "core.excludesFile=", "core.attributesFile="]) {
      expect(settings.some((entry) => entry.startsWith(key))).toBe(true);
    }
    // The reset comes before anything this host chose, or it would clear it.
    const reset = settings.indexOf("credential.helper=");
    const chosen = settings.findIndex(
      (entry) => entry.startsWith("credential.") && entry !== "credential.helper=",
    );
    expect(reset).toBeGreaterThanOrEqual(0);
    if (chosen >= 0) {
      expect(reset).toBeLessThan(chosen);
    }
  });

  it("lends nothing at all to a locator no mechanism applies to", function* () {
    const home = yield* useInvokingHome([]);
    const session = yield* denoGitAuthentication({ ambient: home.ambient }).open(
      "/tmp/xmd-remote/remote.git",
    );

    expect(session.attachment.environment).toEqual({});
    expect(session.attachment.configuration).toEqual([]);
    expect(session.mechanism).toBe("none");
  });
});

describe("workflow configured credential settings", () => {
  it("re-states the helper the invoking user configured, and never a secret", function* () {
    const home = yield* useInvokingHome([{ host: "example.invalid", ...FIRST }]);
    const settings = yield* configuredCredentialSettings(home.ambient);

    expect(settings.some((entry) => entry.startsWith("credential.helper="))).toBe(true);
    // What crosses is the program's name. The credential it holds is exchanged
    // between Git and that program, and never passes through here.
    expect(carriesCredential(settings.join("\n"))).toBe(false);
  });

  it("finds nothing for a host that configured nothing", function* () {
    const home = yield* useHomeWithoutAuthentication();
    expect(yield* configuredCredentialSettings(home.ambient)).toEqual([]);
  });
});

/**
 * The one GitHub credential source, through both adapters that share it.
 *
 * `<PullRequest>` and `<Issue>` reach different services with different
 * ceilings, routing and durable records, and after #522 they read their
 * credential the same way. What has to hold for both is the shape of the
 * session: opened per live invocation, after that invocation's own checks, and
 * never spanning two of them.
 */
describe("workflow GitHub source sessions", () => {
  /** An access that counts what a session asks it, and from whom. */
  function counted(token: string | undefined) {
    const reads: number[] = [];
    const sent: string[] = [];
    return {
      reads,
      sent,
      access: {
        endpoint: "https://api.invalid",
        // deno-lint-ignore require-yield
        *token(): Operation<string | undefined> {
          reads.push(1);
          return token;
        },
        // deno-lint-ignore require-yield
        *send(request: { method: string; url: string }): Operation<GitHubHttpResponse> {
          sent.push(`${request.method} ${request.url}`);
          return { status: 200, body: "[]" };
        },
      },
    };
  }

  it("reads the credential once for a session, however many requests it makes", function* () {
    const counting = counted("from-host");
    const source = gitHubSource(counting.access);

    yield* scoped(function* () {
      const access = yield* source.open();
      // Compared here and reported as a verdict, so a failure prints whether
      // the session answered with what the host holds rather than printing it.
      for (let request = 0; request < 3; request += 1) {
        expect((yield* access.token()) === "from-host").toBe(true);
      }
    });

    // One read. An observation and the mutation it decided carry the identity
    // the invocation's first request established, rather than whatever the host
    // happens to hold a moment later.
    expect(counting.reads).toHaveLength(1);
  });

  it("gives two invocations two sessions rather than one identity", function* () {
    const counting = counted("from-host");
    const source = gitHubSource(counting.access);

    yield* scoped(function* () {
      const access = yield* source.open();
      yield* access.token();
    });
    yield* scoped(function* () {
      const access = yield* source.open();
      yield* access.token();
    });

    // Two reads, because nothing survived the first invocation. That is what
    // makes an interrupted attempt reacquire rather than resume under an
    // identity nobody re-proved.
    expect(counting.reads).toHaveLength(2);
  });

  it("holds a source without holding an identity", function* () {
    const counting = counted("from-host");
    // Constructed and kept, exactly as installed middleware keeps one, and
    // never opened. A source that read a credential to exist would be an
    // identity retained for a middleware's whole lifetime.
    gitHubSource(counting.access);
    expect(counting.reads).toEqual([]);
    expect(counting.sent).toEqual([]);
  });

  it("opens no session when a completed PullRequest replays", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(PULL_REQUEST_REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const live = pullRequestFixture(remote);
      const source = publishedPullRequest(...onePullRequest());
      yield* runWorkflowDocument(database, source, live.options);

      // The same document again, over a source that cannot be opened. A replay
      // that established an identity would reach it.
      const opened: number[] = [];
      const refusing: GitHubSource = {
        endpoint: "https://api.invalid",
        *open(): Operation<GitHubAccess> {
          opened.push(1);
          throw new Error("a session was opened during replay");
        },
      };
      const replay = pullRequestFixture(remote);
      yield* runWorkflowDocument(database, source, {
        composition: { ...replay.options.composition, gitHub: refusing },
      });

      expect(opened).toEqual([]);
    });
  });

  it("refuses an Issue outside the ceiling before any session is opened", function* () {
    const opened: number[] = [];
    const source: GitHubSource = {
      endpoint: "https://api.invalid",
      *open(): Operation<GitHubAccess> {
        opened.push(1);
        throw new Error("a session was opened for a target the ceiling had not admitted");
      },
    };

    const refusal = yield* scoped(function* () {
      yield* useGitHubIssues({
        ceiling: ["https://github.com/octo/authorized"],
        access: source,
      });
      return yield* raised(
        IssueApi.operations.read("https://github.com/octo/elsewhere/issues/7", {
          provider: GITHUB,
        }),
      );
    });

    // The ceiling is a host decision and it is asked first. A session opened
    // before it would be an identity established for a target this host never
    // authorized.
    expect(refusal).toBeDefined();
    expect(opened).toEqual([]);
  });
});

describe("workflow GitHub ambient credentials", () => {
  function login(token: string | undefined, consulted: number[]): GitHubLogin {
    return {
      // deno-lint-ignore require-yield
      *token(): Operation<string | undefined> {
        consulted.push(1);
        return token;
      },
    };
  }

  /**
   * Which source answered, never what it answered with.
   *
   * A token is a token whether it is real or synthetic, and an assertion that
   * compares one prints it when it fails. So each source is given a value only
   * this function knows, and what a test compares is the label it maps back to.
   */
  const SOURCES = new Map([
    ["gh-token-value", "GH_TOKEN"],
    ["github-token-value", "GITHUB_TOKEN"],
    ["login-token-value", "login"],
  ]);

  function whichSource(token: string | undefined): string {
    return token === undefined ? "none" : (SOURCES.get(token) ?? "unrecognized");
  }

  it("prefers GH_TOKEN, then GITHUB_TOKEN, then the host's own login", function* () {
    const consulted: number[] = [];
    const supplied = login("login-token-value", consulted);

    expect(
      whichSource(
        yield* denoGitHubAccess(undefined, {
          environment: { GH_TOKEN: "gh-token-value", GITHUB_TOKEN: "github-token-value" },
          login: supplied,
        }).token(),
      ),
    ).toBe("GH_TOKEN");
    expect(
      whichSource(
        yield* denoGitHubAccess(undefined, {
          environment: { GITHUB_TOKEN: "github-token-value" },
          login: supplied,
        }).token(),
      ),
    ).toBe("GITHUB_TOKEN");
    // Neither variable is set at all: the machine's own login is what a person
    // who has already run `gh auth login` has, and it is asked last.
    expect(
      whichSource(yield* denoGitHubAccess(undefined, { environment: {}, login: supplied }).token()),
    ).toBe("login");
    expect(consulted).toHaveLength(1);
  });

  it("treats an empty variable as an explicit absence rather than a fallback", function* () {
    const consulted: number[] = [];
    const supplied = login("login-token-value", consulted);

    // An empty variable names no credential. Sending `Bearer ` would ask GitHub
    // to decide what an empty token means, and looking further would ignore a
    // caller who said outright which credential to use.
    expect(
      yield* denoGitHubAccess(undefined, {
        environment: { GH_TOKEN: "" },
        login: supplied,
      }).token(),
    ).toBeUndefined();
    expect(
      whichSource(
        yield* denoGitHubAccess(undefined, {
          environment: { GITHUB_TOKEN: "" },
          login: supplied,
        }).token(),
      ),
    ).toBe("none");
    expect(consulted).toEqual([]);
  });

  it("answers none when the host's login holds nothing either", function* () {
    const consulted: number[] = [];
    expect(
      whichSource(
        yield* denoGitHubAccess(undefined, {
          environment: {},
          login: login(undefined, consulted),
        }).token(),
      ),
    ).toBe("none");
    expect(consulted).toHaveLength(1);
  });
});
