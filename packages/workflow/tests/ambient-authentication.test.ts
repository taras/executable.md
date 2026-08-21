/**
 * Tier WA — the authentication a live provider invocation borrows from its host.
 *
 * The claim is about two things that must stay apart: a run reaches a protected
 * remote as whoever is standing at the host right now, and nothing about that
 * identity survives into what the run retains. Rendered text proves neither, so
 * every test here reads one of the four places an answer actually lives — what
 * the remote received, which locator the host was asked about, what the journal
 * and Workspace hold afterwards, and which Git commands ran.
 *
 * Nothing here reads a developer's real credential or contacts a network host.
 * The protected remote is `git http-backend` behind a loopback listener that
 * demands a credential this suite invented; the broker that answers for it is
 * either one the suite supplies or the shipped one pointed at a fixture home.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { lstat } from "@effectionx/fs";
import { chmod, writeFile } from "node:fs/promises";
import { scoped, until } from "effection";
import { join } from "node:path";
import process from "node:process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { RepositoryCompositionError } from "../src/composition/errors.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { RepositoryHost } from "../src/deno/composition/host.ts";
import {
  credentialRequest,
  denoCredentialBroker,
  denoGitAuthentication,
  gitTransport,
  sshCommand,
} from "../src/deno/composition/authentication.ts";
import type {
  CredentialBroker,
  CredentialRequest,
  GitAttachment,
  GitAuthentication,
  GitCredential,
} from "../src/deno/composition/authentication.ts";
import { denoGitHubAccess } from "../src/deno/composition/github.ts";
import type { GitHubLogin } from "../src/deno/composition/github.ts";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import { createRun, useStorageRoot, withStorage } from "./support/storage.ts";
import { remoteBranch, remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import { useGitHttpRemote } from "./support/git-http.ts";
import type { GitHttpRemote } from "./support/git-http.ts";
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
import type { WorkflowRunDatabase } from "../src/storage/api.ts";

/**
 * The credential this suite's remote requires.
 *
 * Two ordinary words with a distinctive marker in the password, because half of
 * what is under test is that this exact string reaches no durable or observable
 * surface. It is never written into a document and never rendered, so the
 * repository's own secret gate has nothing to detect and this suite is not
 * arranging for it to.
 */
const USERNAME = "ambient-user";
const PASSWORD = "ambient-marker-a7f3c1";

const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "README.md", content: "protected\n" }] }],
} as const;

/** A broker that answers for one host and refuses every other. */
function brokerFor(host: string, asked: CredentialRequest[]): CredentialBroker {
  return {
    // deno-lint-ignore require-yield
    *fill(request: CredentialRequest): Operation<GitCredential | undefined> {
      asked.push(request);
      return request.host === host
        ? Object.freeze({ username: USERNAME, password: PASSWORD })
        : undefined;
    },
  };
}

/** A broker that holds nothing at all, however it is asked. */
function emptyBroker(asked: CredentialRequest[]): CredentialBroker {
  return {
    // deno-lint-ignore require-yield
    *fill(request: CredentialRequest): Operation<GitCredential | undefined> {
      asked.push(request);
      return undefined;
    },
  };
}

/**
 * The invoking environment this suite pretends to be standing in.
 *
 * `HOME` is deliberately a path that does not exist: the shipped attachment
 * reads a `known_hosts` out of it, and a suite that let the real one through
 * would be describing the machine it ran on.
 */
const AMBIENT = {
  ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  HOME: "/nonexistent-invoking-home",
};

/** The shipped authentication, over a broker the suite supplies. */
function hostFor(broker: CredentialBroker): RepositoryHost {
  return denoRepositoryHost({
    authentication: denoGitAuthentication({ ambient: AMBIENT, broker }),
  });
}

/** Every locator the host was asked to authenticate, in order. */
interface RecordedAuthentication {
  readonly authentication: GitAuthentication;
  readonly locators: string[];
}

/**
 * The shipped authentication, counted.
 *
 * A decorator rather than a stand-in, so a suite asserting which locator was
 * asked about is asserting about the acquisition that actually happened.
 */
function recording(inner: GitAuthentication): RecordedAuthentication {
  const locators: string[] = [];
  return {
    locators,
    authentication: {
      acquire(locator: string): Operation<GitAttachment> {
        locators.push(locator);
        return inner.acquire(locator);
      },
    },
  };
}

/** An authentication no correct run may reach. */
function forbidden(reached: string[]): GitAuthentication {
  return {
    // deno-lint-ignore require-yield
    *acquire(locator: string): Operation<GitAttachment> {
      reached.push(locator);
      throw new Error(`authentication was acquired for ${locator}`);
    },
  };
}

function isRepositoryRefusal(value: unknown): value is RepositoryCompositionError {
  return value instanceof RepositoryCompositionError;
}

/** A protected remote, plus the local bare repository behind it. */
function* protectedRemote(): Operation<GitHttpRemote> {
  const bare = yield* useBareRemote(REMOTE);
  return yield* useGitHttpRemote({ remote: bare, username: USERNAME, password: PASSWORD });
}

function document(locator: string, ...lines: string[]): string {
  return [`<Repository name="project" url="${locator}">`, ...lines, "</Repository>"].join("\n");
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

/**
 * Append configuration to the retained checkout mid-document.
 *
 * A component rather than a second execution: a workflow definition is
 * immutable, so state a scenario needs planted between two elements has to be
 * planted by an element.
 */
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

describe("workflow ambient Git authentication", () => {
  it("clones a remote that demands a credential the invoking host holds", function* () {
    const root = yield* useStorageRoot();
    const served = yield* protectedRemote();
    const asked: CredentialRequest[] = [];

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(brokerFor(served.host, asked)));
      const output = yield* runDocument(
        database,
        document(served.locator, `<File path="README.md" as="readme" />`, "", "read: {readme}"),
        countingOptions(counting),
      );

      expect(String(output)).toContain("read: protected");

      // The broker was asked about the locator itself — its scheme, its host and
      // its path — rather than about a host in general.
      expect(asked).toHaveLength(1);
      expect(asked[0]?.protocol).toBe("http");
      expect(asked[0]?.host).toBe(served.host);
      expect(asked[0]?.path).toBe("remote.git");

      // The exchange the remote saw: a first request with no credential, which
      // is what produces the challenge, and then the accepted one.
      expect(served.requests.length).toBeGreaterThan(1);
      expect(served.requests[0]?.credentialed).toBe(false);
      expect(served.requests.some((request) => request.accepted)).toBe(true);

      // What was retained is the credential-free locator, unchanged.
      const [retained] = yield* retainedRepositories(database);
      expect(retained?.locator).toBe(served.locator);
      expect(subcommands(counting.counters)).toContain("clone");
    });
  });

  it("refuses a clone the host holds no credential for, and retains nothing", function* () {
    const root = yield* useStorageRoot();
    const served = yield* protectedRemote();
    const asked: CredentialRequest[] = [];

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(emptyBroker(asked)));
      const failure = yield* raised(
        runDocument(database, document(served.locator, "unreachable"), countingOptions(counting)),
      );

      // An ordinary live refusal. The remote's answer is a challenge nobody
      // could meet, which is a locator this run could not use.
      expect(causedBy(failure, isRepositoryRefusal)?.reason).toBe("invalid-locator");
      expect(asked).toHaveLength(1);
      // Nothing was adopted and nothing was published: every request the remote
      // saw was refused, and the run retains no repository. The one event the
      // journal holds is the failed establishment itself, recorded as an error
      // — which is what makes a later attempt a new attempt rather than a
      // replay of a completion nobody reached.
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
    const served = yield* useGitHttpRemote({
      remote: bare,
      username: USERNAME,
      password: PASSWORD,
    });
    const asked: CredentialRequest[] = [];

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(brokerFor(served.host, asked)));
      yield* runWorkflowDocument(
        database,
        document(
          served.locator,
          `<Git.Switch branch="publish/1.4" />`,
          `<File path="notes.md">`,
          "prepared",
          "</File>",
          `<Git.Add paths="notes.md" />`,
          `<Git.Commit message="prepare the release" as="commit" />`,
          `<Git.Push />`,
        ),
        countingOptions(counting),
      );

      // The other end of the transport is what proves a push happened. The
      // bare repository the server serves is the same one the fixture built.
      expect(remoteBranch(bare, "publish/1.4")).toBeDefined();
      const ran = subcommands(counting.counters);
      expect(ran).toContain("push");
      expect(ran).toContain("ls-remote");
      // Clone, the reconciliation's observation and the push itself. Each one
      // is its own acquisition, so a credential is never held across commands.
      expect(asked.length).toBeGreaterThanOrEqual(3);
      expect(asked.every((request) => request.host === served.host)).toBe(true);
    });
  });

  /**
   * The reacquisition an interrupted external effect performs.
   *
   * Two `<Git.Push>` elements are the shape of an attempt that reached the
   * remote and then had to be made again: the second observes the exact
   * destination, finds the commit already there and adopts it. What this adds to
   * the reconciliation the push suite already proves is that the second attempt
   * borrowed authentication of its own — a run that carried the first one's
   * forward would show fewer acquisitions than commands.
   */
  it("reacquires for an interrupted push and adopts without publishing twice", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    const served = yield* useGitHttpRemote({
      remote: bare,
      username: USERNAME,
      password: PASSWORD,
    });
    const asked: CredentialRequest[] = [];

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const recorded = recording(
        denoGitAuthentication({ ambient: AMBIENT, broker: brokerFor(served.host, asked) }),
      );
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );
      yield* runWorkflowDocument(
        database,
        document(
          served.locator,
          `<Git.Switch branch="publish/1.4" />`,
          `<File path="notes.md">`,
          "prepared",
          "</File>",
          `<Git.Add paths="notes.md" />`,
          `<Git.Commit message="prepare the release" as="commit" />`,
          `<Git.Push />`,
          `<Git.Push />`,
        ),
        countingOptions(counting),
      );

      const outcomes = yield* gitHostOutcomes(database);
      expect(outcomes).toHaveLength(2);
      expect(parseGitHostReconciliationRecord(outcomes[0]?.record)?.decision).toBe("performed");
      expect(parseGitHostReconciliationRecord(outcomes[1]?.record)?.decision).toBe("adopted");

      // Two observations, one mutation — and one acquisition per command that
      // left the materialization: the clone, both observations and the push.
      const ran = subcommands(counting.counters);
      expect(ran.filter((name) => name === "ls-remote")).toHaveLength(2);
      expect(ran.filter((name) => name === "push")).toHaveLength(1);
      expect(recorded.locators).toEqual([
        served.locator,
        served.locator,
        served.locator,
        served.locator,
      ]);
    });
  });

  it("acquires for each exact locator, and carries none of them forward", function* () {
    const root = yield* useStorageRoot();
    const first = yield* useBareRemote(REMOTE);
    const second = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const recorded = recording(
        denoGitAuthentication({ ambient: AMBIENT, broker: emptyBroker([]) }),
      );
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );
      yield* runDocument(
        database,
        [
          `<Repository name="first" url="${first.locator}" />`,
          `<Repository name="second" url="${second.locator}" />`,
        ].join("\n"),
        countingOptions(counting),
      );

      // Two clones, two acquisitions, each naming its own locator. A run that
      // reused one repository's authentication for another would show one.
      expect(recorded.locators).toEqual([first.locator, second.locator]);
    });
  });

  it("asks for nothing on a command that stays inside the materialization", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const recorded = recording(
        denoGitAuthentication({ ambient: AMBIENT, broker: emptyBroker([]) }),
      );
      const counting = countingHost(
        denoRepositoryHost({ authentication: recorded.authentication }),
      );
      yield* runWorkflowDocument(
        database,
        document(
          remote.locator,
          `<Git.Switch branch="work" />`,
          `<File path="notes.md">`,
          "prepared",
          "</File>",
          `<Git.Add paths="notes.md" />`,
          `<Git.Commit message="record it" as="commit" />`,
        ),
        countingOptions(counting),
      );

      // Many commands ran; exactly one of them left the materialization.
      expect(counting.counters.commands.length).toBeGreaterThan(5);
      expect(recorded.locators).toEqual([remote.locator]);
    });
  });

  it("reaches no authentication mechanism when a completed run replays", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const source = document(
        remote.locator,
        `<File path="README.md" as="readme" />`,
        "",
        "read: {readme}",
      );
      yield* runDocument(database, source);

      // The remote is gone, so anything that reached for it would fail rather
      // than quietly succeed.
      yield* remote.remove();

      const reached: string[] = [];
      const counting = countingHost(denoRepositoryHost({ authentication: forbidden(reached) }));
      const output = yield* runDocument(database, source, countingOptions(counting));

      expect(String(output)).toContain("read: protected");
      expect(reached).toEqual([]);
      expect(subcommands(counting.counters)).not.toContain("clone");
    });
  });

  it("keeps the credential out of every durable and observable surface", function* () {
    const root = yield* useStorageRoot();
    const bare = yield* useBareRemote(REMOTE);
    const served = yield* useGitHttpRemote({
      remote: bare,
      username: USERNAME,
      password: PASSWORD,
    });
    const asked: CredentialRequest[] = [];

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(brokerFor(served.host, asked)));
      const output = yield* runWorkflowDocument(
        database,
        document(
          served.locator,
          `<Git.Switch branch="publish/1.4" />`,
          `<File path="notes.md">`,
          "prepared",
          "</File>",
          `<Git.Add paths="notes.md" />`,
          `<Git.Commit message="prepare the release" as="commit" />`,
          `<Git.Push />`,
          `<File path="README.md" as="readme" />`,
          "",
          "read: {readme}",
        ),
        countingOptions(counting),
      );

      expect(asked.length).toBeGreaterThanOrEqual(1);

      // Rendered output, every journaled event, the retained records and the
      // Workspace's own checkout configuration.
      expect(String(output)).not.toContain(PASSWORD);
      const events = yield* compositionEvents(database);
      expect(JSON.stringify(events)).not.toContain(PASSWORD);
      expect(JSON.stringify(yield* retainedRepositories(database))).not.toContain(PASSWORD);

      // Not an argument either: the whole command list this run issued.
      expect(JSON.stringify(counting.counters.commands)).not.toContain(PASSWORD);
      expect(JSON.stringify(counting.counters.commands)).not.toContain(USERNAME);

      const [retained] = yield* retainedRepositories(database);
      const config = yield* workspaceText(
        database,
        `${retained?.record.checkoutPath ?? ""}/.git/config`,
      );
      expect(config).not.toContain(PASSWORD);
      expect(config).not.toContain(USERNAME);
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
    const served = yield* useGitHttpRemote({
      remote: bare,
      username: USERNAME,
      password: PASSWORD,
    });
    const hostile = [
      "[credential]",
      `\thelper = ${planted}`,
      "[core]",
      `\tsshCommand = ${planted}`,
      "",
    ].join("\n");
    const asked: CredentialRequest[] = [];

    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const counting = countingHost(hostFor(brokerFor(served.host, asked)));
      yield* runWorkflowDocument(
        database,
        document(
          served.locator,
          `<Git.Switch branch="publish/1.4" />`,
          `<Plant />`,
          `<File path="notes.md">`,
          "prepared",
          "</File>",
          `<Git.Add paths="notes.md" />`,
          `<Git.Commit message="prepare the release" as="commit" />`,
          `<Git.Push />`,
        ),
        countingOptions(counting),
        (run) =>
          scoped(function* () {
            yield* registerComponents([plant(database, hostile)]);
            return yield* run();
          }),
      );

      // The push went through the host's own broker, and the program the
      // document named never ran.
      expect(remoteBranch(bare, "publish/1.4")).toBeDefined();
      expect(asked.length).toBeGreaterThanOrEqual(1);
      expect(yield* present(sentinel)).toBe(false);
      expect((yield* gitHostOutcomes(database))[0]?.status).toBe("ok");

      // The trap really was armed. The same checkout, pushed the ordinary way —
      // with its own configuration in force rather than an attachment that
      // resets it — does reach the planted helper, and publishes nothing.
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

  it("asks about the whole locator rather than about its host", function* () {
    expect(credentialRequest("https://example.invalid/owner/project.git")).toEqual({
      protocol: "https",
      host: "example.invalid",
      path: "owner/project.git",
    });
    expect(credentialRequest("http://127.0.0.1:9000/project.git")).toEqual({
      protocol: "http",
      host: "127.0.0.1:9000",
      path: "project.git",
    });
    expect(credentialRequest("ssh://git@example.invalid/owner/project.git")).toBeUndefined();
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

  it("fixes the settings a retained repository could otherwise name", function* () {
    const attached = yield* denoGitAuthentication({
      ambient: AMBIENT,
      broker: emptyBroker([]),
    }).acquire("https://example.invalid/owner/project.git");

    // The reset is what makes the list one entry long: `credential.helper` is
    // multi-valued, so a helper in a configuration file would otherwise be
    // tried beside whatever the host attached.
    expect(attached.configuration).toContain("credential.helper=");
    expect(attached.configuration.some((entry) => entry.startsWith("core.sshCommand="))).toBe(true);
  });

  it("lends the invoking agent to an SSH locator and nothing else", function* () {
    const attached = yield* denoGitAuthentication({
      ambient: { ...AMBIENT, SSH_AUTH_SOCK: "/tmp/ambient-agent.sock" },
      broker: emptyBroker([]),
    }).acquire("ssh://git@example.invalid/owner/project.git");

    expect(attached.environment).toEqual({ SSH_AUTH_SOCK: "/tmp/ambient-agent.sock" });
  });

  it("lends nothing at all to a locator no mechanism applies to", function* () {
    const attached = yield* denoGitAuthentication({
      ambient: AMBIENT,
      broker: emptyBroker([]),
    }).acquire("/tmp/xmd-remote/remote.git");

    expect(attached.environment).toEqual({});
    expect(attached.configuration).toEqual([]);
  });
});

describe("workflow credential broker", () => {
  /** A fixture home whose Git configuration names one helper program. */
  function* fixtureHome(script: string): Operation<string> {
    const home = yield* useTempDirectory("xmd-ambient-home-");
    const helper = join(home, "helper.sh");
    yield* until(writeFile(helper, script, { mode: 0o700 }));
    yield* until(chmod(helper, 0o700));
    yield* until(
      writeFile(join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`, {
        mode: 0o600,
      }),
    );
    return home;
  }

  it("reads what the invoking user's own helper answers for one locator", function* () {
    const home = yield* fixtureHome(
      [
        "#!/bin/sh",
        'if [ "$1" != "get" ]; then exit 0; fi',
        `echo username=${USERNAME}`,
        `echo password=${PASSWORD}`,
        "",
      ].join("\n"),
    );

    const found = yield* denoCredentialBroker({
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
    }).fill({ protocol: "https", host: "example.invalid", path: "owner/project.git" });

    expect(found?.username).toBe(USERNAME);
    expect(found?.password).toBe(PASSWORD);
  });

  it("refuses an answer that is about somewhere else", function* () {
    const home = yield* fixtureHome(
      [
        "#!/bin/sh",
        'if [ "$1" != "get" ]; then exit 0; fi',
        // A helper is free to rewrite the request's own fields, and an answer
        // about another host has not authorized this one.
        "echo host=elsewhere.invalid",
        `echo username=${USERNAME}`,
        `echo password=${PASSWORD}`,
        "",
      ].join("\n"),
    );

    const found = yield* denoCredentialBroker({
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
    }).fill({ protocol: "https", host: "example.invalid", path: "owner/project.git" });

    expect(found).toBeUndefined();
  });

  it("answers none when the invoking host holds nothing", function* () {
    const home = yield* useTempDirectory("xmd-ambient-home-");
    const found = yield* denoCredentialBroker({
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      // Without this, a machine whose Git is configured to prompt would stop
      // here rather than answer.
      GIT_TERMINAL_PROMPT: "0",
    }).fill({ protocol: "https", host: "example.invalid", path: "owner/project.git" });

    expect(found).toBeUndefined();
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

  it("prefers GH_TOKEN, then GITHUB_TOKEN, then the host's own login", function* () {
    const consulted: number[] = [];
    const supplied = login("from-login", consulted);

    expect(
      yield* denoGitHubAccess(undefined, {
        environment: { GH_TOKEN: "from-gh", GITHUB_TOKEN: "from-github" },
        login: supplied,
      }).token(),
    ).toBe("from-gh");
    expect(
      yield* denoGitHubAccess(undefined, {
        environment: { GITHUB_TOKEN: "from-github" },
        login: supplied,
      }).token(),
    ).toBe("from-github");
    // Neither variable is set at all: the machine's own login is what a person
    // who has already run `gh auth login` has, and it is asked last.
    expect(yield* denoGitHubAccess(undefined, { environment: {}, login: supplied }).token()).toBe(
      "from-login",
    );
    expect(consulted).toHaveLength(1);
  });

  it("treats an empty variable as an explicit absence rather than a fallback", function* () {
    const consulted: number[] = [];
    const supplied = login("from-login", consulted);

    // An empty variable names no credential. Sending `Bearer ` would ask GitHub
    // to decide what an empty token means, and looking elsewhere would ignore a
    // caller who said outright which credential to use.
    expect(
      yield* denoGitHubAccess(undefined, {
        environment: { GH_TOKEN: "" },
        login: supplied,
      }).token(),
    ).toBeUndefined();
    expect(
      yield* denoGitHubAccess(undefined, {
        environment: { GITHUB_TOKEN: "" },
        login: supplied,
      }).token(),
    ).toBeUndefined();
    expect(consulted).toEqual([]);
  });

  it("answers none when the host's login holds nothing either", function* () {
    const consulted: number[] = [];
    expect(
      yield* denoGitHubAccess(undefined, {
        environment: {},
        login: login(undefined, consulted),
      }).token(),
    ).toBeUndefined();
    expect(consulted).toHaveLength(1);
  });
});
