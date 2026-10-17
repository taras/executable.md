/**
 * How a REPL entry gets its issues, what names them, and who never gets any.
 *
 * The entry host is the one thing this command prepares per *entry*, and an
 * issue is the first thing it prepares that lives at a service rather than in a
 * checkout. So what these rows hold is the pair of questions that follows from
 * that: which work is this entry's, and what happens to work the entry started
 * and never finished.
 *
 * Every row drives the production path — `submitReplEntry`, the real session,
 * the real per-entry installation, the shipped GitHub adapter — against a
 * tracker listening on loopback. The credential is the only substitution,
 * because a suite cannot own the process environment the production reader
 * looks at.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { exists, writeTextFile } from "@effectionx/fs";
import { rm } from "@effectionx/fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { appendFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { content, hasContent } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { Component, Execution } from "@executablemd/core/api";
import type { ComponentDefinition, FunctionComponentDefinition } from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { denoRepositoryHost } from "../../git/src/deno/composition/host.ts";
import { gitSession } from "../../git/src/deno/composition/git.ts";
import { useReplRepositoryRecording } from "../../git/src/deno/retained-repository/provider.ts";
import type { GitOutcome, RepositoryHost } from "../../git/src/deno/composition/host.ts";
import { gitPlugin } from "../../git/src/plugin.ts";
import { ISSUE_EFFECT } from "../../git/src/issue/effect-type.ts";
import { issueIdempotencyKey, parseIssueRequest } from "../../git/src/issue/records.ts";
import { issueOriginMarker } from "../../git/src/deno/issue/github.ts";
import { IssueOperations } from "../../git/src/issue/operations.ts";
import type {
  IssueOperationsApi,
  IssueReadInvocation,
  IssueUpsertInvocation,
} from "../../git/src/issue/operations.ts";
import { IssueApi } from "@executablemd/git/api";
import type { IssueDetails, IssueReference } from "@executablemd/git/api";
import { replIssueInstallation } from "../../git/src/deno/retained-repository/issues.ts";
import { gitHubSource } from "../../git/src/deno/composition/github.ts";
import { useIssueTrackerServer } from "../../git/tests/support/issue-tracker-server.ts";
import type {
  IssueTrackerServer,
  ServedIssue,
} from "../../git/tests/support/issue-tracker-server.ts";
import { gitHubAccessFor } from "../../git/tests/support/issue-providers.ts";
import type { GitHubIssuesOptions } from "@executablemd/git/deno";
import { ordinaryGeneratedSelection } from "../src/evaluation-profile.ts";
import { assembleReplProfile } from "../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import { resolveAgentStack } from "../src/agent-stack.ts";
import { NO_PLUGINS } from "../src/plugin-host.ts";
import { selectReplEntryHost } from "../src/deno-repositories.ts";
import type { HelperAssembly } from "../../git/src/deno/composition/credential-helper.ts";
import { ReplHost } from "../src/repl/host.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplEntryInstallation } from "../src/repl-entry-installation.ts";
import type { ReplExecution, RetainedStream } from "../src/repl/journal.ts";

/** The tracker every row files in, as a document writes it. */
const TRACKER = "https://github.com/octo/project";

/** The credential-helper assembly these rows' host selects. Never invoked. */
const SUITE_HELPER: HelperAssembly = Object.freeze({
  runtime: "source",
  platform: "unix",
  execPath: "/nonexistent/xmd",
});

/**
 * The repository recording an entry's execution initializes.
 *
 * Registered on the same seam the per-entry factory registers it on, because
 * what these rows are about is an entry's issue work beside its checkouts
 * rather than which host assembled either.
 */
function useReplRepositories(root: string): Operation<void> {
  return Execution.around({
    *init(_args, next): Operation<void> {
      yield* useReplRepositoryRecording({ helper: SUITE_HELPER, root });
      yield* next();
    },
  });
}

/**
 * What a command contributes to an entry's execution.
 *
 * Taken from the Git Plugin's own contribution for the `repl` command rather
 * than written out here, because that contribution is the production path.
 */
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

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly server: IssueTrackerServer;
}

function useFixture(
  issues: readonly ServedIssue[] = [],
  options: { readonly hold?: () => Operation<void> } = {},
): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-issues-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    const git = gitSession(denoRepositoryHost(), root);
    yield* git.run(["init", "-b", "main", checkout], root);
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    const server = yield* useIssueTrackerServer({
      issues,
      ...(options.hold === undefined ? {} : { hold: options.hold }),
    });
    yield* provide({ root, checkout, server });
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

/** What the suite counts about one row, across every execution it runs. */
interface Counted {
  /** Each owner the session derived, in the order entries ran. */
  readonly owners: string[];
}

function counted(): Counted {
  return { owners: [] };
}

/**
 * The entry host, as a runtime entrypoint selects it — with the transport
 * pointed at this row's loopback tracker.
 *
 * The owner is recorded on the way through, because what the session derives is
 * the thing these rows are mostly about and it appears nowhere a document can
 * see.
 */
function entryHost(
  fixture: Fixture,
  seen: Counted,
  options: GitHubIssuesOptions = {},
): ReplEntryInstallation {
  // deno-lint-ignore require-yield
  return function* (owner: string): Operation<ExecutionInstallation> {
    seen.owners.push(owner);
    return replIssueInstallation(owner, {
      access: gitHubSource(gitHubAccessFor(fixture.server.url, { credential: "valid" })),
      configuration: { ceiling: [TRACKER] },
      ...options,
    });
  };
}

interface Opened {
  readonly session: ReplSession;
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Wait until this session is holding a question. */
function* waitForQuestion(session: ReplSession): Operation<void> {
  const changes = yield* session.elicitation.changes;
  if (session.elicitation.pending !== undefined) {
    return;
  }
  yield* changes.next();
}

function execution(id: string, events: readonly DurableEvent[] = []): ReplExecution {
  return { id, stream: new InMemoryStream([...events]) };
}

/** What one row's execution did, as its assertions read it. */
interface Ran {
  readonly events: readonly DurableEvent[];
  readonly outcome: Result<unknown> | undefined;
}

interface RunOptions {
  /** The entry host this run selects, or none at all. */
  readonly host?: ReplEntryInstallation;
  /** Where authored paths resolve, when not the fixture's checkout. */
  readonly cwd?: string;
  /** Extra host installations, for the rows about public middleware. */
  readonly installations?: readonly ExecutionInstallation[];
  /** Where components are looked for. */
  readonly includes?: readonly string[];
  /** Install the production repository recording, as the REPL host does. */
  readonly repositories?: string;
  /** Leave at the first question instead of running to settlement. */
  readonly leave?: boolean;
}

/** One submitted entry, run against this execution's history. */
function submit(
  fixture: Fixture,
  source: string,
  run: ReplExecution,
  options: RunOptions = {},
): Operation<Ran> {
  return scoped(function* (): Operation<Ran> {
    yield* useNodeReplHost(run.id);
    yield* useHostFiles();
    yield* useWorkingDirectory(options.cwd ?? fixture.checkout);
    if (options.repositories !== undefined) {
      yield* useReplRepositories(options.repositories);
    }
    const installations = [...(yield* replInstallations()), ...(options.installations ?? [])];
    const session = opened(
      yield* submitReplEntry({
        execution: run,
        source,
        installations,
        generated: ordinaryGeneratedSelection(),
        ...(options.includes === undefined ? {} : { includes: options.includes }),
        ...(options.host === undefined ? {} : { entryInstallation: options.host }),
      }),
    );
    if (options.leave === true) {
      yield* waitForQuestion(session);
      // This scope's teardown halts the entry, which is what leaving one is.
      return { events: yield* run.stream.readAll(), outcome: undefined };
    }
    const outcome = yield* session.join();
    return { events: yield* run.stream.readAll(), outcome };
  });
}

/** One reopened session over a history, run to settlement or left again. */
function reopen(fixture: Fixture, run: ReplExecution, options: RunOptions = {}): Operation<Ran> {
  return scoped(function* (): Operation<Ran> {
    yield* useNodeReplHost(run.id);
    yield* useHostFiles();
    yield* useWorkingDirectory(options.cwd ?? fixture.checkout);
    if (options.repositories !== undefined) {
      yield* useReplRepositories(options.repositories);
    }
    const installations = [...(yield* replInstallations()), ...(options.installations ?? [])];
    const session = opened(
      yield* openReplSession({
        execution: run,
        installations,
        generated: ordinaryGeneratedSelection(),
        ...(options.includes === undefined ? {} : { includes: options.includes }),
        ...(options.host === undefined ? {} : { entryInstallation: options.host }),
      }),
    );
    if (options.leave === true) {
      yield* waitForQuestion(session);
      return { events: yield* run.stream.readAll(), outcome: undefined };
    }
    const outcome = yield* session.join();
    return { events: yield* run.stream.readAll(), outcome };
  });
}

/** Every Issue record this history holds, in order. */
function issueRecords(events: readonly DurableEvent[]): readonly DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === ISSUE_EFFECT,
  );
}

/**
 * Every settled Issue record, which is what an acknowledged outcome is.
 *
 * A refused operation retains a record too — its outcome is the durable
 * operation's failure — so "nothing was acknowledged" is a question about the
 * successful ones.
 */
function settledIssueRecords(events: readonly DurableEvent[]): readonly DurableEvent[] {
  return issueRecords(events).filter(
    (event) => event.type === "yield" && event.result.status === "ok",
  );
}

/** The identity every Issue record in this history was written under. */
function identities(events: readonly DurableEvent[]): readonly string[] {
  return issueRecords(events).map((event) => {
    const request =
      event.type === "yield" ? parseIssueRequest(event.description["request"]) : undefined;
    return request === undefined
      ? "<unreadable>"
      : `${request.identity.runId}\u0000${request.identity.expansionId}`;
  });
}

/** The URL every settled Issue record in this history holds. */
function urls(events: readonly DurableEvent[]): readonly unknown[] {
  return issueRecords(events).map((event) =>
    event.type === "yield" && event.result.status === "ok"
      ? Reflect.get(Object(event.result.value), "url")
      : undefined,
  );
}

/** The issue bodies this tracker holds, which is where a key leaves its mark. */
function bodies(server: IssueTrackerServer): readonly string[] {
  return server.issues.map((issue) => issue.body ?? "");
}

/** Every request path this tracker received, in order. */
function paths(server: IssueTrackerServer): readonly string[] {
  return server.requests.map((request) => `${request.method} ${request.path}`);
}

/** A seeded issue, for the rows that read one. */
const SEEDED = {
  number: 1,
  state: "open" as const,
  title: "Seeded",
  body: "what the tracker already held",
  labels: [] as string[],
  assignee: null,
};

/** What one observing middleware saw and did. */
interface Chain {
  /** Each public invocation this middleware answered, in order. */
  readonly calls: string[];
}

/**
 * Ordinary public middleware, installed as a host installation.
 *
 * It transforms the issue it is handed and delegates once, which is what the
 * seam is for — and what must not move is the identity the record is named by
 * or the key the provider is handed.
 */
function observingChain(chain: Chain, transformed: string): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* IssueOperations.around({
        *read([invocation], next): Operation<IssueDetails> {
          chain.calls.push(`read ${invocation.url}`);
          return yield* next(invocation);
        },
        *upsert([invocation], next): Operation<IssueReference> {
          chain.calls.push(`upsert ${invocation.target}`);
          return yield* next({
            ...invocation,
            issue: { ...invocation.issue, title: transformed },
          });
        },
      });
    },
  };
}

/** What a region's components were told about their own shape. */
interface Probe {
  readonly paired: boolean[];
}

/**
 * A region whose components are told the opposite of how they were written.
 *
 * Installed as a component rather than for the whole execution, because
 * `<IssueTracker>` reads the same answer to decide whether it has a region to
 * expand at all: reversing it everywhere would refuse the tracker before any
 * `<Issue>` ran. `<Shape>` is inside the region so the lie is observable rather
 * than assumed — a row that reversed nothing would otherwise pass.
 */
function reversedRegion(probe: Probe): ExecutionInstallation {
  // Declared rather than registered inside `install()`: an entry is validated
  // against what its installations declare before anything runs, so a name only
  // a scope registration knows about does not resolve at all.
  return {
    components: [
      {
        name: "Reversed",
        origin: PROBE_ORIGIN,
        props: { type: "object", properties: {}, additionalProperties: false },
        factory: () =>
          function* Reversed(): Operation<Json> {
            yield* Component.around({
              *hasContent(_args, next): Operation<boolean> {
                return !(yield* next());
              },
            });
            return yield* content();
          },
      },
      {
        name: "Shape",
        origin: PROBE_ORIGIN,
        props: { type: "object", properties: {}, additionalProperties: false },
        factory: () =>
          function* Shape(): Operation<Json> {
            probe.paired.push(yield* hasContent());
            return null;
          },
      },
    ],
  };
}

/** Where this suite's own probe components report they come from. */
const PROBE_ORIGIN = "@executablemd/cli/tests/repl-issues";

/** The Issue definition this execution resolved, captured on the way past. */
interface Captured {
  definition: ComponentDefinition | FunctionComponentDefinition | undefined;
}

function capturingImport(captured: Captured): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* Component.around({
        *importComponent(
          [name, position],
          next,
        ): Operation<ComponentDefinition | FunctionComponentDefinition> {
          const definition = yield* next(name, position);
          if (name === "Issue") {
            captured.definition = definition;
          }
          return definition;
        },
      });
    },
  };
}

/**
 * A journal whose append can be held, which is where an interruption lands.
 *
 * The window these rows are about is between a service accepting an upsert and
 * this end writing that down: an attempt interrupted there has done the remote
 * work and acknowledged none of it. Holding the append is how a row stands in
 * that window deliberately rather than racing for it.
 */
interface HeldStream extends RetainedStream {
  /** What actually reached the journal, which is what a reopen reads. */
  readonly events: DurableEvent[];
}

function heldStream(
  hold: (event: DurableEvent) => boolean,
  reached: { resolve(value: void): void },
  retained: readonly DurableEvent[] = [],
): HeldStream {
  const events: DurableEvent[] = [...retained];
  const held: HeldStream = {
    onAppend: null,
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      return [...events];
    },
    *append(event: DurableEvent): Operation<void> {
      if (hold(event)) {
        reached.resolve();
        // Held for as long as this entry lives. Whoever is holding it decides
        // when the entry stops, and the record never lands.
        yield* suspend();
      }
      events.push(event);
      held.onAppend?.(event);
    },
    events,
  };
  return held;
}

/** A journal that refuses to retain this entry's Issue record. */
function refusingStream(): HeldStream {
  const events: DurableEvent[] = [];
  const refusing: HeldStream = {
    onAppend: null,
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      return [...events];
    },
    // deno-lint-ignore require-yield
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === ISSUE_EFFECT) {
        throw new Error("this journal cannot retain what the entry just did");
      }
      events.push(event);
      refusing.onAppend?.(event);
    },
    events,
  };
  return refusing;
}

/** Whether this event is an Issue record of the given operation. */
function issueAppend(operation: "read" | "upsert"): (event: DurableEvent) => boolean {
  return (event: DurableEvent) => {
    if (event.type !== "yield" || event.description.type !== ISSUE_EFFECT) {
      return false;
    }
    return parseIssueRequest(event.description["request"])?.operation === operation;
  };
}

/** How many times a repository capability was acquired, which must be never. */
interface Acquisitions {
  count: number;
}

/**
 * A repository host that fails the moment anything is acquired through it.
 *
 * Issue work reaches no checkout, so every one of these is a failure rather
 * than a cost: a row installing this and still filing an issue has shown that
 * nothing about an entry's issues goes looking for a repository.
 */
function failingHost(acquired: Acquisitions): RepositoryHost {
  return {
    // deno-lint-ignore require-yield
    *git(): Operation<GitOutcome> {
      acquired.count += 1;
      throw new Error("this row's host runs no git");
    },
    // deno-lint-ignore require-yield
    *useDirectory(): Operation<string> {
      acquired.count += 1;
      throw new Error("this row's host owns no isolation directory");
    },
  };
}

/** The production entry recording, over a host that refuses to be acquired. */
function failingRecording(acquired: Acquisitions, root: string): Operation<void> {
  return Execution.around({
    *init(_args, next): Operation<void> {
      yield* useReplRepositoryRecording({ host: failingHost(acquired), root });
      yield* next();
    },
  });
}

/** The normalized read one public middleware answers with, without a transport. */
const ANSWERED: IssueDetails = Object.freeze({
  url: `${TRACKER}/issues/1`,
  title: "What the middleware answered",
  description: "answered without reaching a tracker",
  tags: Object.freeze(["alpha", "beta"]),
  assignee: null,
});

/**
 * Ordinary public middleware that answers a read itself.
 *
 * The other half of what the seam is for: a handler may answer instead of
 * delegating, and what the envelope then retains is that answer. Nothing below
 * it runs, so neither the entry's transport-facing default nor the adapter is
 * reached at all.
 */
function answeringChain(chain: Chain, details: IssueDetails): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* IssueOperations.around({
        // deno-lint-ignore require-yield
        *read([invocation]): Operation<IssueDetails> {
          chain.calls.push(`read ${invocation.url}`);
          return details;
        },
        *upsert([invocation], next): Operation<IssueReference> {
          chain.calls.push(`upsert ${invocation.target}`);
          return yield* next(invocation);
        },
      });
    },
  };
}

/** How many times each chain was entered, which on a replay must be never. */
interface Chains {
  operations: number;
  api: number;
}

/**
 * Both chains, set to fail if anything reaches them.
 *
 * A replay that invoked middleware, or reached a transport before matching its
 * record, fails here rather than passing a count that happened to be right.
 */
function refusingChains(counted: Chains): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* IssueOperations.around({
        // deno-lint-ignore require-yield
        *read(): Operation<IssueDetails> {
          counted.operations += 1;
          throw new Error("a replayed read reached the profile chain");
        },
        // deno-lint-ignore require-yield
        *upsert(): Operation<IssueReference> {
          counted.operations += 1;
          throw new Error("a replayed upsert reached the profile chain");
        },
      });
      yield* IssueApi.around({
        // deno-lint-ignore require-yield
        *read(): Operation<IssueDetails> {
          counted.api += 1;
          throw new Error("a replayed read reached the transport chain");
        },
        // deno-lint-ignore require-yield
        *upsert(): Operation<IssueReference> {
          counted.api += 1;
          throw new Error("a replayed upsert reached the transport chain");
        },
      });
    },
  };
}

/** One entry-owned cleanup, and the two sides of holding it open. */
interface Cleanup {
  /** Resolved when the entry's teardown has entered the finalizer. */
  readonly entered: { resolve(value: void): void; operation: Operation<void> };
  /** Awaited inside the finalizer, so teardown cannot complete until released. */
  readonly release: { resolve(value: void): void; operation: Operation<void> };
}

/**
 * A finalizer the entry's own scope owns, registered around the live dispatch.
 *
 * Registered before the work it guards, so it is released after it — which is
 * the ordering that makes it a cleanup rather than a hope. Holding it open is
 * how a row observes that leaving an entry *waits*: the request is cancelled,
 * this runs, and nothing about the entry is finished until it returns.
 */
function heldCleanup(cleanup: Cleanup): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* IssueOperations.around({
        *upsert([invocation], next): Operation<IssueReference> {
          yield* ensure(function* (): Operation<void> {
            cleanup.entered.resolve();
            yield* cleanup.release.operation;
          });
          return yield* next(invocation);
        },
      });
    },
  };
}

/** One entry that files one issue, and one that leaves a question after it. */
const FILES_ONE = `<IssueTracker url="${TRACKER}"><Issue title="Filed" as="filed">a described issue</Issue></IssueTracker>`;

/** What a row watches for a suffix effect that must not have happened. */
const SUFFIX = '<File path="after.md">continued</File>';

const QUESTION =
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false }} as="answer">Continue?</Elicit>';

describe("how a REPL entry gets its issues", () => {
  it("E1: composes public middleware once, under the key the request itself names", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();
    const chain: Chain = { calls: [] };

    const ran = yield* submit(fixture, FILES_ONE, execution("execution-1"), {
      host: entryHost(fixture, seen),
      installations: [observingChain(chain, "Transformed")],
    });

    expect(ran.outcome?.ok).toBe(true);
    // Once. A second delegation would be a second attempt at one position.
    expect(chain.calls).toEqual([`upsert ${TRACKER}`]);
    // What the provider was sent is what the middleware transformed.
    expect(fixture.server.issues.map((issue) => issue.title)).toEqual(["Transformed"]);
    // What the journal holds is the request as the document made it: a
    // middleware that rewrote the issue did not rewrite the durable identity.
    const record = issueRecords(ran.events)[0];
    const asked =
      record?.type === "yield" ? parseIssueRequest(record.description["request"]) : undefined;
    expect(asked?.operation).toBe("upsert");
    expect(asked?.operation === "upsert" ? asked.issue.title : "").toBe("Filed");
    // And the mark the provider carried is the one this record's own identity
    // and the authored target produce — not anything the middleware supplied.
    expect(bodies(fixture.server)[0]).toContain(
      issueOriginMarker(
        issueIdempotencyKey(
          asked === undefined ? { runId: "", expansionId: "" } : asked.identity,
          "upsert",
          TRACKER,
        ),
      ),
    );
  });

  it("E1: a nested read finishes at its own position, before the upsert around it", function* (): Operation<void> {
    const fixture = yield* useFixture([SEEDED]);
    const seen = counted();
    const source = [
      `<IssueTracker url="${TRACKER}">`,
      `<Issue title="Parent" as="parent">`,
      `<Issue url="${TRACKER}/issues/1" as="child" />`,
      "a described issue",
      "</Issue>",
      "</IssueTracker>",
    ].join("\n");

    const ran = yield* submit(fixture, source, execution("execution-1"), {
      host: entryHost(fixture, seen),
    });

    expect(ran.outcome?.ok).toBe(true);
    const asked = issueRecords(ran.events).map((event) =>
      event.type === "yield"
        ? parseIssueRequest(event.description["request"])?.operation
        : undefined,
    );
    // One envelope per Issue, and the child's is complete before the parent's
    // is offered: the content is rendered outside the upsert's boundary.
    expect(asked).toEqual(["read", "upsert"]);
  });

  it("E2: keeps one site's key across a reopen, and gives every other site its own", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();
    const two = [
      `<IssueTracker url="${TRACKER}">`,
      '<Issue title="First" as="a">the first issue</Issue>',
      '<Issue title="Second" as="b">the second issue</Issue>',
      "</IssueTracker>",
      QUESTION,
    ].join("\n");

    const first = execution("execution-1");
    const left = yield* submit(fixture, two, first, {
      host: entryHost(fixture, seen),
      leave: true,
    });

    // Two sites, two issues, two different marks.
    expect(fixture.server.issues.length).toBe(2);
    const marks = bodies(fixture.server);
    expect(marks[0]).not.toBe(marks[1]);
    expect(new Set(identities(left.events)).size).toBe(2);

    // Reopened: the same unfinished entry, the same execution, the same sites.
    // Nothing is filed again and no mark changes.
    const posts = paths(fixture.server).filter((path) => path.startsWith("POST"));
    const again = yield* reopen(
      fixture,
      { id: first.id, stream: first.stream },
      {
        host: entryHost(fixture, seen),
        leave: true,
      },
    );
    expect(paths(fixture.server).filter((path) => path.startsWith("POST"))).toEqual(posts);
    expect(bodies(fixture.server)).toEqual(marks);
    expect(identities(again.events)).toEqual(identities(left.events));

    // Another execution's first entry, with identical text: its own owner, its
    // own sites, its own issues.
    const other = execution("execution-2");
    yield* submit(fixture, two, other, { host: entryHost(fixture, seen), leave: true });
    expect(fixture.server.issues.length).toBe(4);
    const everything = bodies(fixture.server);
    expect(new Set(everything).size).toBe(4);
    expect(
      new Set([...identities(again.events), ...identities(yield* other.stream.readAll())]).size,
    ).toBe(4);
  });

  it("E2: a successor entry of one execution is not the entry before it", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();
    const run = execution("execution-1");

    yield* scoped(function* (): Operation<void> {
      yield* useNodeReplHost(run.id);
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      const session = opened(
        yield* submitReplEntry({
          execution: run,
          source: FILES_ONE,
          installations,
          generated: ordinaryGeneratedSelection(),
          entryInstallation: entryHost(fixture, seen),
        }),
      );
      expect((yield* session.join()).ok).toBe(true);
      // The same text again, as the next entry of the same execution. One
      // entry's retained work is not an answer to another's.
      const admitted = yield* session.submit(FILES_ONE);
      expect(admitted.ok).toBe(true);
      expect((yield* session.join()).ok).toBe(true);
    });

    expect(seen.owners.length).toBe(2);
    expect(seen.owners[0]).not.toBe(seen.owners[1]);
    expect(fixture.server.issues.length).toBe(2);
    expect(new Set(bodies(fixture.server)).size).toBe(2);
  });

  it("E2: no replaceable answer moves the owner, the site or the key", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const plain = yield* submit(fixture, FILES_ONE, execution("execution-1"), {
      host: entryHost(fixture, counted()),
    });
    expect(plain.outcome?.ok).toBe(true);

    // The same entry of a second execution, with a middleware that rewrites
    // the issue it is handed. What it sends changes and what names the work
    // does not: the site is the same site, and only the owner differs, because
    // the execution does.
    const second = yield* submit(fixture, FILES_ONE, execution("execution-2"), {
      host: entryHost(fixture, counted()),
      installations: [observingChain({ calls: [] }, "Rewritten")],
    });
    expect(second.outcome?.ok).toBe(true);

    const site = (events: readonly DurableEvent[]): string | undefined =>
      identities(events)[0]?.split("\u0000")[1];
    expect(site(second.events)).toBe(site(plain.events));
    expect(identities(second.events)[0]).not.toBe(identities(plain.events)[0]);
  });

  it("E2: the authored form selects the effect, whatever the chain answers", function* (): Operation<void> {
    const fixture = yield* useFixture([SEEDED]);
    const probe: Probe = { paired: [] };
    const source = [
      `<IssueTracker url="${TRACKER}">`,
      "<Reversed>",
      "<Shape>written with content</Shape>",
      `<Issue url="${TRACKER}/issues/1" as="read" />`,
      '<Issue title="Filed" as="filed">a described issue</Issue>',
      "</Reversed>",
      "</IssueTracker>",
    ].join("\n");

    const ran = yield* submit(fixture, source, execution("execution-1"), {
      host: entryHost(fixture, counted()),
      installations: [reversedRegion(probe)],
    });

    expect(ran.outcome?.ok).toBe(true);
    // The chain really is answering the opposite: a paired element was told it
    // was written self-closing.
    expect(probe.paired).toEqual([false]);
    const asked = issueRecords(ran.events).map((event) =>
      event.type === "yield"
        ? parseIssueRequest(event.description["request"])?.operation
        : undefined,
    );
    expect(asked).toEqual(["read", "upsert"]);
  });

  it("E2: an invocation the engine did not issue names nothing", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const captured: Captured = { definition: undefined };
    const ran = yield* submit(fixture, FILES_ONE, execution("execution-1"), {
      host: entryHost(fixture, counted()),
      installations: [capturingImport(captured)],
    });
    expect(ran.outcome?.ok).toBe(true);

    const fn = Reflect.get(Object(captured.definition), "fn");
    if (typeof fn !== "function") {
      throw new Error("the entry's Issue definition carries no implementation to call");
    }
    const before = paths(fixture.server).length;
    let refusal: string | undefined;
    try {
      // A definition a handler kept, called with an object of the right shape.
      // There is no shape a forger cannot copy, which is why what answers here
      // is the issuance the engine holds rather than anything handed in.
      yield* fn({ title: "Forged" }, { hasContent: () => true });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal ?? "").toContain("without the invocation the engine issued");
    expect(paths(fixture.server).length).toBe(before);
  });

  it("E3: adopts an upsert the tracker accepted and this end never wrote down", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();
    const reached = withResolvers<void>();
    const stream = heldStream(issueAppend("upsert"), reached);
    const run: ReplExecution = { id: "execution-1", stream };

    yield* scoped(function* (): Operation<void> {
      yield* useNodeReplHost(run.id);
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      opened(
        yield* submitReplEntry({
          execution: run,
          source: [FILES_ONE, SUFFIX].join("\n"),
          installations,
          generated: ordinaryGeneratedSelection(),
          entryInstallation: entryHost(fixture, seen),
        }),
      );
      // Held exactly where the interesting state is: the tracker has the issue
      // and this journal has nothing about it.
      yield* reached.operation;
    });

    expect(fixture.server.issues.length).toBe(1);
    const mark = bodies(fixture.server)[0];
    expect(issueRecords(stream.events).length).toBe(0);
    // A cancelled append publishes no outcome: there is no root close in the
    // history, and what the document wrote after the issue never ran.
    expect(stream.events.some((event) => event.type === "close")).toBe(false);
    expect(yield* exists(join(fixture.checkout, "after.md"))).toBe(false);

    // Reopened. The same execution and the same entry, so the same owner and
    // the same key — and the adapter finds its own mark and adopts rather than
    // filing a second issue.
    const posts = paths(fixture.server).filter((path) => path.startsWith("POST"));
    const again = yield* reopen(
      fixture,
      { id: run.id, stream: new InMemoryStream(stream.events) },
      { host: entryHost(fixture, seen) },
    );

    expect(again.outcome?.ok).toBe(true);
    expect(fixture.server.issues.length).toBe(1);
    expect(bodies(fixture.server)[0]).toBe(mark);
    expect(paths(fixture.server).filter((path) => path.startsWith("POST"))).toEqual(posts);
    expect(urls(again.events)).toEqual([`${TRACKER}/issues/1`]);
    expect(seen.owners[0]).toBe(seen.owners[1]);
    // And the suffix runs now, for the first time, on the continuation.
    expect(yield* exists(join(fixture.checkout, "after.md"))).toBe(true);
  });

  it("E3: an acknowledged upsert replays with no provider call at all", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();
    const source = [FILES_ONE, QUESTION].join("\n");
    const run = execution("execution-1");

    const left = yield* submit(fixture, source, run, {
      host: entryHost(fixture, seen),
      leave: true,
    });
    expect(issueRecords(left.events).length).toBe(1);
    const before = paths(fixture.server).length;

    const again = yield* reopen(
      fixture,
      { id: run.id, stream: run.stream },
      {
        host: entryHost(fixture, seen),
        leave: true,
      },
    );

    // The control: an acknowledged record is replayed, and the provider is not
    // reached at all — not to observe, not to adopt, not to confirm.
    expect(paths(fixture.server).length).toBe(before);
    expect(issueRecords(again.events).length).toBe(1);
  });

  it("E3: an unacknowledged read is repeated, and repeating it is safe", function* (): Operation<void> {
    const fixture = yield* useFixture([SEEDED]);
    const seen = counted();
    const reached = withResolvers<void>();
    const stream = heldStream(issueAppend("read"), reached);
    const run: ReplExecution = { id: "execution-1", stream };
    const source = `<IssueTracker url="${TRACKER}"><Issue url="${TRACKER}/issues/1" as="read" /></IssueTracker>`;

    yield* scoped(function* (): Operation<void> {
      yield* useNodeReplHost(run.id);
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      opened(
        yield* submitReplEntry({
          execution: run,
          source,
          installations,
          generated: ordinaryGeneratedSelection(),
          entryInstallation: entryHost(fixture, seen),
        }),
      );
      yield* reached.operation;
    });

    const observed = paths(fixture.server).filter((path) => path.startsWith("GET"));
    expect(observed.length).toBeGreaterThan(0);
    expect(issueRecords(stream.events).length).toBe(0);

    const again = yield* reopen(
      fixture,
      { id: run.id, stream: new InMemoryStream(stream.events) },
      { host: entryHost(fixture, seen) },
    );

    // A read reconciles nothing and has no key, so repeating it is an ordinary
    // second observation of the same object rather than a second effect.
    expect(again.outcome?.ok).toBe(true);
    expect(paths(fixture.server).filter((path) => path.startsWith("GET")).length).toBeGreaterThan(
      observed.length,
    );
    expect(fixture.server.issues.length).toBe(1);
    expect(issueRecords(again.events).length).toBe(1);
  });

  it("E4: files an issue outside a checkout without acquiring one", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const acquired: Acquisitions = { count: 0 };
    const outside = join(fixture.root, "outside");
    yield* until(writeFile(join(fixture.root, "keep.md"), "keep\n"));
    const managed = join(fixture.root, "repositories");

    const ran = yield* scoped(function* (): Operation<Ran> {
      yield* failingRecording(acquired, managed);
      return yield* submit(fixture, FILES_ONE, execution("execution-1"), {
        host: entryHost(fixture, counted()),
        cwd: fixture.root,
      });
    });

    expect(ran.outcome?.ok).toBe(true);
    expect(urls(ran.events)).toEqual([`${TRACKER}/issues/1`]);
    // Nothing was acquired: no git session, no isolation directory, no managed
    // root, and no lease.
    expect(acquired.count).toBe(0);
    expect(yield* exists(managed)).toBe(false);
    expect(yield* exists(outside)).toBe(false);
  });

  it("E4: behaves the same inside a checkout, and still makes no managed root", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const acquired: Acquisitions = { count: 0 };
    const managed = join(fixture.root, "repositories");

    const ran = yield* scoped(function* (): Operation<Ran> {
      yield* failingRecording(acquired, managed);
      return yield* submit(fixture, FILES_ONE, execution("execution-1"), {
        host: entryHost(fixture, counted()),
        cwd: fixture.checkout,
      });
    });

    expect(ran.outcome?.ok).toBe(true);
    expect(urls(ran.events)).toEqual([`${TRACKER}/issues/1`]);
    expect(acquired.count).toBe(0);
    expect(yield* exists(managed)).toBe(false);
  });

  it("E5: sends nothing at all to a target this host did not authorize", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const elsewhere =
      '<IssueTracker url="https://github.com/other/repo"><Issue title="Filed" as="filed">a described issue</Issue></IssueTracker>';

    const ran = yield* submit(fixture, elsewhere, execution("execution-1"), {
      host: entryHost(fixture, counted()),
    });

    expect(ran.outcome?.ok).toBe(false);
    // No request, so no credential either: the ceiling is asked before a
    // session is opened and before anything is built.
    expect(paths(fixture.server)).toEqual([]);
    // The refusal is retained as this position's failed outcome, and nothing
    // about it is an acknowledged issue.
    expect(settledIssueRecords(ran.events).length).toBe(0);
  });

  it("E5: a settled history installs no issue host and reaches nothing", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const run = execution("execution-1");
    const ran = yield* submit(fixture, FILES_ONE, run, { host: entryHost(fixture, counted()) });
    expect(ran.outcome?.ok).toBe(true);
    const before = paths(fixture.server).length;

    // Reopened as a reader: the entry settled, so nothing executes, the factory
    // is never called and the tracker never hears from this process again.
    const passive = counted();
    yield* reopen(
      fixture,
      { id: run.id, stream: run.stream },
      {
        host: entryHost(fixture, passive),
      },
    );

    expect(passive.owners).toEqual([]);
    expect(paths(fixture.server).length).toBe(before);
  });

  it("E6: leaving a blocked request acknowledges nothing and admits no successor", function* (): Operation<void> {
    const blocked = withResolvers<void>();
    const arrived = withResolvers<void>();
    // Counted in the hold, because the server records a request only after it
    // has answered one: while this row is standing in the window, the request
    // it is holding is not in that list yet.
    const holding = { count: 0 };
    const fixture = yield* useFixture([], {
      *hold(): Operation<void> {
        holding.count += 1;
        arrived.resolve();
        yield* blocked.operation;
      },
    });
    const run = execution("execution-1");

    yield* scoped(function* (): Operation<void> {
      yield* useNodeReplHost(run.id);
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      const session = opened(
        yield* submitReplEntry({
          execution: run,
          source: FILES_ONE,
          installations,
          generated: ordinaryGeneratedSelection(),
          entryInstallation: entryHost(fixture, counted()),
        }),
      );
      yield* arrived.operation;
      // While the request is in flight, nothing may follow this entry: an
      // entry with no outcome is not something a successor starts after.
      const admitted = yield* session.submit(FILES_ONE);
      expect(admitted.ok).toBe(false);
    });

    // The request was really in flight, and leaving acknowledged none of it.
    expect(holding.count).toBeGreaterThan(0);
    expect(settledIssueRecords(yield* run.stream.readAll()).length).toBe(0);
  });

  it("E6: a journal that cannot retain the result allows no suffix effect", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const stream = refusingStream();
    const source = [FILES_ONE, SUFFIX].join("\n");

    const ran = yield* submit(
      fixture,
      source,
      { id: "execution-1", stream },
      {
        host: entryHost(fixture, counted()),
      },
    );

    expect(ran.outcome?.ok).toBe(false);
    // The tracker did the work and this end could not write it down, which is
    // fail-stop: no acknowledged success, and nothing after it ran.
    expect(fixture.server.issues.length).toBe(1);
    expect(issueRecords(stream.events).length).toBe(0);
    expect(yield* exists(join(fixture.checkout, "after.md"))).toBe(false);
  });

  it("E2: a repository component named Issue keeps its ordinary precedence", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const local = join(fixture.root, "local");
    yield* until(mkdir(local, { recursive: true }));

    // Neither form: the entry's own implementation refuses this, which is what
    // makes the next run's success evidence that a different component ran.
    const refused = yield* submit(fixture, '<Issue as="local" />', execution("execution-1"), {
      host: entryHost(fixture, counted()),
      includes: [local],
    });
    expect(refused.outcome?.ok).toBe(false);
    expect(String(refused.outcome?.ok === false ? refused.outcome.error.message : "")).toContain(
      "either reads an issue",
    );

    yield* writeTextFile(join(local, "Issue.md"), "a repository component ran\n");
    const overridden = yield* submit(fixture, '<Issue as="local" />', execution("execution-2"), {
      host: entryHost(fixture, counted()),
      includes: [local],
    });

    // A repository file outranks a registered default, and this one is a
    // default — so the entry's implementation is not reached, files nothing and
    // retains nothing.
    expect(overridden.outcome?.ok).toBe(true);
    expect(issueRecords(overridden.events).length).toBe(0);
    expect(paths(fixture.server)).toEqual([]);
  });

  it("E5: a frozen position installs no issue host and reaches nothing", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const run = execution("execution-1");
    const passive = counted();

    const marker = yield* scoped(function* (): Operation<string> {
      yield* useNodeReplHost(run.id);
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      const session = opened(
        yield* submitReplEntry({
          execution: run,
          source: FILES_ONE,
          installations,
          generated: ordinaryGeneratedSelection(),
          entryInstallation: entryHost(fixture, counted()),
        }),
      );
      expect((yield* session.join()).ok).toBe(true);
      const checkpoint = session.navigation.checkpoints[0];
      if (checkpoint === undefined) {
        throw new Error("this history offers no position to stand at");
      }
      return checkpoint.marker;
    });

    const before = paths(fixture.server).length;
    yield* scoped(function* (): Operation<void> {
      yield* useNodeReplHost(run.id);
      yield* useHostFiles();
      yield* useWorkingDirectory(fixture.checkout);
      const installations = yield* replInstallations();
      opened(
        yield* openReplSession({
          execution: run,
          installations,
          generated: ordinaryGeneratedSelection(),
          selection: marker,
          entryInstallation: entryHost(fixture, passive),
        }),
      );
    });

    // A reader standing at a recorded position executes nothing, so the
    // factory is never called and the tracker never hears from this process.
    expect(passive.owners).toEqual([]);
    expect(paths(fixture.server).length).toBe(before);
  });

  it("E1: retains what public middleware answered, and replays past both chains", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();
    const chain: Chain = { calls: [] };
    const source = [
      `<IssueTracker url="${TRACKER}">`,
      '<Issue title="Filed" as="filed">a described issue</Issue>',
      `<Issue url="${TRACKER}/issues/1" as="found" />`,
      "</IssueTracker>",
      QUESTION,
    ].join("\n");

    const run = execution("execution-1");
    const left = yield* submit(fixture, source, run, {
      host: entryHost(fixture, seen),
      installations: [answeringChain(chain, ANSWERED)],
      leave: true,
    });

    // The read was answered by the chain and never reached a transport; the
    // upsert delegated through it and did, which is the list-then-create its
    // own reconciliation makes.
    expect(chain.calls).toEqual([`upsert ${TRACKER}`, `read ${TRACKER}/issues/1`]);
    expect(paths(fixture.server).filter((path) => path.endsWith("/issues/1"))).toEqual([]);
    const sent = paths(fixture.server);
    const retained = issueRecords(left.events).map((event) =>
      event.type === "yield" && event.result.status === "ok" ? event.result.value : undefined,
    );
    // Exactly what the middleware answered, normalized and retained.
    expect(retained).toEqual([
      { url: `${TRACKER}/issues/1` },
      { ...ANSWERED, tags: [...ANSWERED.tags] },
    ]);

    // Reopened with both chains set to fail if anything reaches them. A replay
    // that asked middleware first, or a transport at all, fails here.
    const refusing: Chains = { operations: 0, api: 0 };
    const again = yield* reopen(
      fixture,
      { id: run.id, stream: run.stream },
      {
        host: entryHost(fixture, seen),
        installations: [refusingChains(refusing)],
        leave: true,
      },
    );

    expect(refusing).toEqual({ operations: 0, api: 0 });
    expect(
      issueRecords(again.events).map((event) =>
        event.type === "yield" && event.result.status === "ok" ? event.result.value : undefined,
      ),
    ).toEqual(retained);
    // Not one further request of any kind: both records answered from the
    // journal, so neither chain and neither destination was asked anything.
    expect(paths(fixture.server)).toEqual(sent);
  });

  it("E2: two evaluations of one authored site are two sites", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();
    // One element, evaluated twice, with the same text both times: if an
    // identity were derived from the element or from what it says, these two
    // would collapse into one — one issue filed, one key, one record.
    const source = [
      `<IssueTracker url="${TRACKER}">`,
      '<Each in={[1, 2]} let="turn">',
      '<Issue title="Looped" as="filed">the same described issue</Issue>',
      "</Each>",
      "</IssueTracker>",
      QUESTION,
    ].join("\n");

    const run = execution("execution-1");
    const left = yield* submit(fixture, source, run, {
      host: entryHost(fixture, seen),
      leave: true,
    });

    // Two canonical sites, two keys, two issues.
    const sites = identities(left.events);
    expect(sites.length).toBe(2);
    expect(sites[0]).not.toBe(sites[1]);
    expect(new Set(sites.map((site) => site.split("\u0000")[0])).size).toBe(1);
    expect(fixture.server.issues.length).toBe(2);
    expect(new Set(bodies(fixture.server)).size).toBe(2);
    const posts = paths(fixture.server).filter((path) => path.startsWith("POST"));
    expect(posts.length).toBe(2);

    // And the iteration a record belongs to survives the reopen: the same two
    // sites, in the same order, with nothing filed again.
    const again = yield* reopen(
      fixture,
      { id: run.id, stream: run.stream },
      {
        host: entryHost(fixture, seen),
        leave: true,
      },
    );
    expect(identities(again.events)).toEqual(sites);
    expect(paths(fixture.server).filter((path) => path.startsWith("POST"))).toEqual(posts);
    expect(fixture.server.issues.length).toBe(2);
  });

  it("E6: leaving waits for the request cleanup the entry owns", function* (): Operation<void> {
    const blocked = withResolvers<void>();
    const arrived = withResolvers<void>();
    const holding = { count: 0 };
    const fixture = yield* useFixture([], {
      *hold(): Operation<void> {
        holding.count += 1;
        arrived.resolve();
        yield* blocked.operation;
      },
    });
    const cleanup: Cleanup = { entered: withResolvers<void>(), release: withResolvers<void>() };
    const run = execution("execution-1");

    let finished = false;
    const leaving = yield* spawn(function* (): Operation<void> {
      yield* scoped(function* (): Operation<void> {
        yield* useNodeReplHost(run.id);
        yield* useHostFiles();
        yield* useWorkingDirectory(fixture.checkout);
        const installations = [...(yield* replInstallations()), heldCleanup(cleanup)];
        opened(
          yield* submitReplEntry({
            execution: run,
            source: FILES_ONE,
            installations,
            generated: ordinaryGeneratedSelection(),
            entryInstallation: entryHost(fixture, counted()),
          }),
        );
        // Left while the request is in flight, which is what makes the cleanup
        // below a cancellation rather than an ordinary release.
        yield* arrived.operation;
      });
      finished = true;
    });

    // The entry's own finalizer has started, so the cancellation reached it.
    yield* cleanup.entered.operation;
    // And leaving is not finished: the scope cannot complete while a cleanup
    // registered inside it has not returned. Nothing is retained either.
    expect(finished).toBe(false);
    expect(settledIssueRecords(yield* run.stream.readAll()).length).toBe(0);

    // Released, and only now does leaving join.
    cleanup.release.resolve();
    yield* leaving;
    expect(finished).toBe(true);
    expect(holding.count).toBeGreaterThan(0);
    expect(settledIssueRecords(yield* run.stream.readAll()).length).toBe(0);
  });

  it("E5: the REPL profile captures the host's selected entry factory, and absence", function* (): Operation<void> {
    const flags = {
      agentProvider: "acpx",
      defaultAgent: "claude",
      approveAll: false,
      approveReads: false,
      denyAll: true,
    };
    const planWriterRoot = yield* until(
      realpath(yield* until(mkdtemp(join(tmpdir(), "repl-issues-profile-")))),
    );

    // With the host's selection in scope — made by the production selector, in
    // the command scope, before the profile is assembled.
    const selected = yield* scoped(function* (): Operation<ReplExecutionProfile> {
      const stack = yield* resolveAgentStack(flags, undefined);
      if (!stack.ok) {
        throw stack.error;
      }
      yield* selectReplEntryHost(SUITE_HELPER, planWriterRoot);
      return yield* assembleReplProfile(stack.value, NO_PLUGINS, { planWriterRoot });
    });
    // Behavioural rather than by identity: the production selector builds the
    // factory from this host's own configuration, so what the profile carries
    // is a closure over it rather than a module-level value to compare against.
    const factory = selected.entryInstallation;
    expect(typeof factory).toBe("function");

    // And without it: the same assembly, in a scope nothing selected in, leaves
    // the member absent rather than reaching for a default.
    const absent = yield* scoped(function* (): Operation<ReplExecutionProfile> {
      const stack = yield* resolveAgentStack(flags, undefined);
      if (!stack.ok) {
        throw stack.error;
      }
      return yield* assembleReplProfile(stack.value, NO_PLUGINS, { planWriterRoot });
    });
    expect(absent.entryInstallation).toBe(undefined);

    // Selecting reaches nothing, and what it selected declares both halves of
    // an entry's external capability: an installation is built per entry, and
    // this command has run none.
    const built = yield* scoped(function* (): Operation<ExecutionInstallation> {
      if (factory === undefined) {
        throw new Error("the production selector selected no entry capability");
      }
      return yield* factory('["executablemd.repl.issue-owner",1,"execution-1","1"]');
    });
    expect([...(built.components ?? [])].map((component) => component.name).sort()).toEqual([
      "Git.Push",
      "Issue",
    ]);
  });

  it("E2: shadows the inherited default, and refuses where no host selected one", function* (): Operation<void> {
    const fixture = yield* useFixture();
    const seen = counted();

    // No entry host: `<Issue>` is still declared by the Plugin for this
    // command, and reaching it is the ordinary missing-provider refusal.
    const without = yield* submit(fixture, FILES_ONE, execution("execution-1"));
    expect(without.outcome?.ok).toBe(false);
    expect(String(without.outcome?.ok === false ? without.outcome.error.message : "")).toContain(
      "no Issue provider is installed",
    );
    expect(issueRecords(without.events).length).toBe(0);
    expect(paths(fixture.server)).toEqual([]);

    // With one, the entry's own implementation answers instead — one retained
    // record, and one issue at the tracker.
    const with_ = yield* submit(fixture, FILES_ONE, execution("execution-2"), {
      host: entryHost(fixture, seen),
    });
    expect(with_.outcome?.ok).toBe(true);
    expect(issueRecords(with_.events).length).toBe(1);
    expect(urls(with_.events)).toEqual([`${TRACKER}/issues/1`]);
    expect(seen.owners.length).toBe(1);
  });
});
