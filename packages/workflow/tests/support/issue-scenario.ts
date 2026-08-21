/**
 * What a scenario document runs inside, and what it can look at afterwards.
 *
 * The fixture — the tracker server, the journals, the provider log and the
 * components a document composes — lives in one enclosing scope and survives
 * every execution taken against it. Each execution gets a child scope of its
 * own holding exactly two things: one complete `useTesting()` session and one
 * document. That is what keeps two scenario documents from sharing a result
 * set while still sharing a tracker.
 *
 * A session admits one `execute()` call, so a document cannot run another
 * document from inside a component. Scenarios that stand on what an earlier
 * run left behind therefore *stage* those attempts through the fixture, before
 * the document that asserts about them, and read their outcomes back with
 * `<StagedAttempt>`.
 */

import { scoped, type Operation } from "effection";
import type { Result } from "effection";
import { fileURLToPath } from "node:url";
import { registerComponents } from "@executablemd/core";
import type { DocumentExecution, Json, PropsSchema } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { retainedWorkflowInstallation } from "../../src/run.ts";
import type { WorkflowRun } from "../../src/run.ts";
import { useCompositionComponents } from "../../src/composition/installation.ts";
import { ISSUE_EFFECT } from "../../src/issue/effect-type.ts";
import { IssueApi } from "../../src/issue/api.ts";
import {
  gitHubAccessFor,
  providerLog,
  useKeyRecorder,
  useProviderComponents,
} from "./issue-providers.ts";
import type { ProviderLog } from "./issue-providers.ts";
import { useGitHubIssues } from "../../src/deno/issue/github.ts";
import { credential, useIssueTrackerServer } from "./issue-tracker-server.ts";
import type { IssueTrackerServer, ServedIssue } from "./issue-tracker-server.ts";

const RUN: WorkflowRun = Object.freeze({
  runId: "run-296-issue",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

const NO_PROPS: PropsSchema = { type: "object", properties: {}, additionalProperties: false };

/** One in-memory journal per run id, so a document can be executed twice. */
interface Journals {
  for(id: string): DurableStream;
  snapshot(id: string): DurableEvent[];
  truncate(id: string, events: readonly DurableEvent[]): void;
}

function journals(): Journals {
  const streams = new Map<string, InMemoryStream>();
  return {
    for(id: string): DurableStream {
      const held = streams.get(id);
      if (held !== undefined) {
        return held;
      }
      const made = new InMemoryStream();
      streams.set(id, made);
      return made;
    },
    snapshot(id: string): DurableEvent[] {
      return streams.get(id)?.snapshot() ?? [];
    },
    truncate(id: string, events: readonly DurableEvent[]): void {
      streams.set(id, new InMemoryStream([...events]));
    },
  };
}

/** Every Issue effect a scenario journaled, in order. */
export function issueYields(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === ISSUE_EFFECT,
  );
}

/** What one execution of a scenario document reports about itself. */
export interface ScenarioObservation {
  /**
   * The execution's own outcome, which is the authority on the suite.
   *
   * A passing suite is `Ok`. A suite that failed a test — or discovered none at
   * all — is `Err(TestFailureError)`, so a document whose tests never ran
   * cannot be mistaken for one whose tests passed.
   */
  readonly outcome: Result<Json>;
  /** This execution's complete results, and no other execution's. */
  readonly results: readonly TestResult[];
  /** The rendered document, complete or partial. */
  readonly rendered: string;
}

/** One attempt staged before the document that asserts about it. */
export interface StagedAttempt {
  /** A fixture document under `tests/scenarios/fixtures`. */
  readonly document: string;
  /** Which run's journal it continues. Defaults to the scenario's run. */
  readonly run?: string;
  /** Install no provider at all, which is what a replay must not need. */
  readonly forbidProviders?: boolean;
  /** Fail every request, so nothing about the tracker is provable. */
  readonly failsTransport?: boolean;
  /** Answer a create with a failure after the tracker accepted it. */
  readonly interruptsAfterCreate?: boolean;
  /**
   * The process ended before it could journal anything about the effect.
   *
   * A different state from journaling a failure, and the one a recovery exists
   * for: the tracker holds an issue this run has no record of.
   */
  readonly died?: boolean;
  /** The containers the staged host authorized. */
  readonly ceiling?: readonly string[];
}

/** What a staged attempt left behind. */
export interface AttemptOutcome {
  readonly ok: boolean;
  readonly output: string;
  readonly error: string;
  readonly effects: number;
  readonly calls: number;
}

/**
 * The scenario fixture: everything that outlives a single execution.
 *
 * Acquired once per scenario and shared by every execution taken against it,
 * which is what lets two documents meet the same tracker while each gets its
 * own testing session.
 */
export interface ScenarioFixture {
  readonly server: IssueTrackerServer;
  readonly log: ProviderLog;
  /** Run a fixture document as a prior attempt. No testing session. */
  stage(attempt: StagedAttempt): Operation<AttemptOutcome>;
  /**
   * Run a scenario document under its own complete testing session.
   *
   * `run` names the journal it executes against, and defaults to the
   * scenario's. Two documents observed against one fixture need journals of
   * their own: a retained history belongs to the document that wrote it, and a
   * second document replaying the first's would diverge on the first name that
   * did not match.
   */
  observe(path: string, options?: { run?: string }): Operation<ScenarioObservation>;
}

export function* useScenarioFixture(): Operation<ScenarioFixture> {
  const held = journals();
  const log = providerLog();
  const server = yield* useIssueTrackerServer();
  const staged: AttemptOutcome[] = [];

  yield* useCompositionComponents();
  yield* useProviderComponents(log);
  yield* useKeyRecorder(log);
  yield* useScenarioComponents(server, held, log, staged);

  return {
    server,
    log,
    *stage(attempt: StagedAttempt): Operation<AttemptOutcome> {
      const outcome = yield* stageAttempt(server, held, attempt);
      staged.push(outcome);
      return outcome;
    },
    observe(path: string, options?: { run?: string }): Operation<ScenarioObservation> {
      return observeDocument(path, held, options?.run ?? RUN.runId);
    },
  };
}

/**
 * Execute one checked-in scenario document under its own testing session.
 *
 * The child scope owns the session and the execution and nothing else. It
 * inherits the fixture's providers, components and server from the enclosing
 * scope, and takes its results with it when it closes.
 *
 * The document is read from disk rather than assembled here, because it is the
 * evidence: a reviewer reviews the Markdown, not a string a test built.
 */
function observeDocument(
  path: string,
  held: Journals,
  runId: string,
): Operation<ScenarioObservation> {
  return scoped(function* () {
    const tests = yield* useTesting();
    const execution = yield* executeInstalled({ path, stream: held.for(runId) }, [
      retainedWorkflowInstallation({ ...RUN, runId }),
    ]);
    // Drained to its close value first: output closes with the rendered text —
    // complete or partial — even when the execution settles Err, so a failing
    // suite still reports what the document had rendered when it failed.
    const rendered = yield* drain(execution.output);
    const outcome = yield* execution;
    const results = yield* tests.results;
    return { outcome, results, rendered };
  });
}

function* drain(output: DocumentExecution["output"]): Operation<string> {
  const subscription = yield* output;
  let next = yield* subscription.next();
  while (!next.done) {
    next = yield* subscription.next();
  }
  return next.value;
}

/**
 * The components a scenario declares its own state with.
 *
 * Each provides one thing and says which: the tracker it runs against, an issue
 * present before execution, the requests that tracker received, the retained
 * journal, and what an attempt staged ahead of this document left behind.
 */
function useScenarioComponents(
  server: IssueTrackerServer,
  held: Journals,
  log: ProviderLog,
  staged: readonly AttemptOutcome[],
): Operation<void> {
  return registerComponents([
    {
      name: "GitHubServer",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: {
          url: { type: "string" },
          repository: { type: "string" },
        },
        required: ["url", "repository"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        // Reports the scenario's tracker; it does not reset it. An attempt
        // staged before this document is exactly the state some scenarios are
        // about, and a component that cleared it would erase what it came to
        // prove. Isolation between scenarios comes from the fixture's scope.
        return {
          url: server.url,
          repository: `https://github.com/${server.owner}/${server.repository}`,
        };
      },
    },
    {
      name: "FreshTracker",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        // Declared, never implied. Tests inside one document share a tracker,
        // so a test that stands on an empty one says so — and a scenario that
        // stands on what an attempt staged before it simply does not say this.
        // A reporting component that cleared as a side effect would erase the
        // very state some scenarios came to prove.
        server.issues.length = 0;
        server.requests.length = 0;
        log.keys.length = 0;
        log.overrides = 0;
        log.atlassian.reads = 0;
        log.atlassian.upserts = 0;
        log.atlassianIssues.clear();
        return "";
      },
    },
    {
      name: "RemoteIssue",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1 },
          body: { type: "string" },
          state: { enum: ["open", "closed"] },
          tags: { type: "array", items: { type: "string", minLength: 1 } },
          assignee: { type: "string", minLength: 1 },
          pullRequest: { type: "boolean" },
        },
        required: ["number", "title"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        const seeded: ServedIssue = {
          number: Number(props.number),
          state: props.state === "closed" ? "closed" : "open",
          title: String(props.title),
          body: typeof props.body === "string" ? props.body : null,
          labels: Array.isArray(props.tags) ? props.tags.map(String) : [],
          assignee: typeof props.assignee === "string" ? props.assignee : null,
          ...(props.pullRequest === true ? { pullRequest: true } : {}),
        };
        server.issues.push(seeded);
        return "";
      },
    },
    {
      name: "ServerRequests",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: {
          methods: { type: "array", items: { type: "string" } },
          paths: { type: "array", items: { type: "string" } },
          authorizations: { type: "array", items: { type: "string" } },
          credentialed: { type: "boolean" },
          bodies: { type: "array" },
          issues: { type: "integer" },
          titles: { type: "array", items: { type: "string" } },
          labels: { type: "array" },
          assignees: { type: "array" },
          keys: { type: "array", items: { type: "string" } },
          overrides: { type: "integer" },
          atlassianReads: { type: "integer" },
          atlassianUpserts: { type: "integer" },
        },
        required: [
          "methods",
          "paths",
          "authorizations",
          "credentialed",
          "bodies",
          "issues",
          "titles",
          "labels",
          "assignees",
          "keys",
          "overrides",
          "atlassianReads",
          "atlassianUpserts",
        ],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return {
          methods: server.requests.map((request) => request.method),
          paths: server.requests.map((request) => request.path),
          // The scheme, never the credential. A document that received the
          // header itself would carry a credential in its own text and in the
          // run's retained history, which is the one thing the Issue contract
          // says a history never holds — and the fixture must not be the
          // exception that proves it. Whether the right credential arrived is
          // decided here, where it is already known, and reported as an answer.
          authorizations: server.requests.map(
            (request) => (request.authorization ?? "").split(" ")[0],
          ),
          credentialed:
            server.requests.length > 0 &&
            server.requests.every((request) => request.authorization === `Bearer ${credential()}`),
          bodies: server.requests.map((request) => (request.body ?? null) as Json),
          issues: server.issues.length,
          titles: server.issues.map((issue) => issue.title),
          labels: server.issues.map((issue) => [...issue.labels]),
          assignees: server.issues.map((issue) => issue.assignee),
          keys: [...log.keys],
          overrides: log.overrides,
          atlassianReads: log.atlassian.reads,
          atlassianUpserts: log.atlassian.upserts,
        };
      },
    },
    {
      name: "IssueJournal",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: { text: { type: "string" }, effects: { type: "integer" } },
        required: ["text", "effects"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        // The whole retained history as text, so an assertion about what is
        // absent from it is an assertion about every member rather than about
        // the members somebody remembered to look at.
        const events = held.snapshot(RUN.runId);
        return { text: JSON.stringify(events), effects: issueYields(events).length };
      },
    },
    {
      name: "StagedAttempt",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: { index: { type: "integer", minimum: 0 } },
        required: ["index"],
        additionalProperties: false,
      },
      returns: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          output: { type: "string" },
          error: { type: "string" },
          effects: { type: "integer" },
          calls: { type: "integer" },
        },
        required: ["ok", "output", "error", "effects", "calls"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<Json> {
        const index = Number(props.index);
        const outcome = staged[index];
        if (outcome === undefined) {
          throw new Error(
            `this scenario staged ${staged.length} attempts, so there is no attempt ${index}`,
          );
        }
        return { ...outcome };
      },
    },
  ]);
}

/**
 * Run one checked-in fixture document as a prior attempt.
 *
 * Its own child scope, its own provider installation, and no testing session:
 * a staged attempt is a previous *run*, not a test, and it is a plain document
 * whose only job is to leave a journal and a tracker in a particular state.
 *
 * The journal is kept per run id, so a second attempt continues the first
 * rather than starting over — which is the only way to arrange the state a
 * recovery scenario stands on. The root Close is dropped afterwards because
 * every attempt here is a continuation; `died` additionally drops the effect,
 * because a process that died after the tracker accepted its issue published
 * nothing at all, and that is a different state from one that journaled a
 * failure.
 */
function stageAttempt(
  server: IssueTrackerServer,
  held: Journals,
  attempt: StagedAttempt,
): Operation<AttemptOutcome> {
  return scoped(function* () {
    const before = server.requests.length;
    const id = attempt.run ?? RUN.runId;
    const stream = held.for(id);
    const path = fileURLToPath(
      new URL(`../scenarios/fixtures/${attempt.document}`, import.meta.url),
    );

    if (attempt.forbidProviders === true) {
      yield* forbidEveryProvider();
    } else {
      yield* useGitHubIssues({
        ceiling: [
          ...(attempt.ceiling ?? [`https://github.com/${server.owner}/${server.repository}`]),
        ],
        access: gitHubAccessFor(server.url, {
          failsTransport: attempt.failsTransport === true,
          interruptsAfterCreate: attempt.interruptsAfterCreate === true,
        }),
      });
    }

    const execution = yield* executeInstalled({ path, stream }, [
      retainedWorkflowInstallation({ ...RUN, runId: id }),
    ]);
    const output = yield* drain(execution.output);
    const outcome = yield* execution;

    const events = yield* stream.readAll();
    const died = attempt.died === true;
    held.truncate(
      id,
      events.filter(
        (event) =>
          !(event.type === "close" && event.coroutineId === "root") &&
          !(died && event.type === "yield" && event.description.type === ISSUE_EFFECT),
      ),
    );
    return {
      ok: outcome.ok,
      output,
      error: outcome.ok ? "" : outcome.error.message,
      effects: issueYields(events).length,
      calls: server.requests.length - before,
    };
  });
}

function* forbidEveryProvider(): Operation<void> {
  yield* IssueApi.around({
    // deno-lint-ignore require-yield
    *read() {
      throw new Error("a replay reached an issue provider");
    },
    // deno-lint-ignore require-yield
    *upsert() {
      throw new Error("a replay reached an issue provider");
    },
  });
}

/**
 * Execute one scenario document against a fixture of its own.
 *
 * The convenience form, for a scenario that stands on nothing an earlier run
 * left. A scenario that does stage attempts acquires the fixture itself, so it
 * can stage them between acquiring it and observing the document.
 */
export function runScenario(path: string): Operation<ScenarioObservation> {
  return scoped(function* () {
    const fixture = yield* useScenarioFixture();
    return yield* fixture.observe(path);
  });
}
