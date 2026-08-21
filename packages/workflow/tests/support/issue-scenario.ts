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

import { ensure, scoped, type Operation } from "effection";
import type { Result } from "effection";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
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
import { byCodePoint } from "../../src/issue/records.ts";
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

/**
 * What one staged attempt reports about itself.
 *
 * Everything that shaped it — the provider, its ceiling, the credential
 * condition, any transport fault, the run it journals into, and whether the
 * process survived to record what it did — is declared in the `.stage.md`
 * document, not passed in here. A reader who wants to know what a scenario
 * stands on reads the attempt, rather than reconstructing it from a call in a
 * TypeScript file.
 */
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
  /**
   * Run a checked-in `.stage.md` document as a prior attempt.
   *
   * No testing session: a staged attempt is a previous *run*, not a test.
   */
  stage(document: string): Operation<AttemptOutcome>;
  /**
   * Run a scenario document under its own complete testing session.
   *
   * Each asserting document executes against a journal of its own, named for
   * the document. A retained history belongs to the document that wrote it, so
   * a second document replaying the first's would diverge on the first name
   * that did not match — and an asserting document is never a continuation of a
   * staged attempt anyway. What it asks about the scenario's journal it asks
   * through `<IssueJournal>`.
   */
  observe(path: string): Operation<ScenarioObservation>;
}

export function* useScenarioFixture(): Operation<ScenarioFixture> {
  const held = journals();
  const log = providerLog();
  const server = yield* useIssueTrackerServer();
  const staged: AttemptOutcome[] = [];
  const attempting: Attempting = { current: undefined };

  yield* useCompositionComponents();
  yield* useProviderComponents(log);
  yield* useKeyRecorder(log);
  yield* useScenarioComponents(server, held, log, staged, attempting);

  return {
    server,
    log,
    *stage(document: string): Operation<AttemptOutcome> {
      const outcome = yield* stageAttempt(server, held, attempting, document, staged.length + 1);
      staged.push(outcome);
      return outcome;
    },
    observe(path: string): Operation<ScenarioObservation> {
      return observeDocument(path, held, `observing:${basename(path)}`);
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
 * There is deliberately no component that arranges "the usual setup" and none
 * that reports "everything". Each one owns a single piece of state, and the
 * four pieces are genuinely independent: what the GitHub tracker holds, what it
 * was sent, what the provider boundary was handed, and what the Atlassian-shaped
 * tracker did. A scenario declares the ones it depends on, so a reader can see
 * from the document which state it stands on and which it never touches.
 */
function useScenarioComponents(
  server: IssueTrackerServer,
  held: Journals,
  log: ProviderLog,
  staged: readonly AttemptOutcome[],
  attempting: Attempting,
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
        // Reports where the tracker is. It changes nothing: an attempt staged
        // before this document is exactly the state some scenarios are about,
        // and a reporting component that cleared as a side effect would erase
        // what the scenario came to prove.
        return {
          url: server.url,
          repository: `https://github.com/${server.owner}/${server.repository}`,
        };
      },
    },

    {
      name: "EmptyTracker",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        server.issues.length = 0;
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
      name: "DuplicateIssue",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
          when: { type: "boolean" },
        },
        required: ["number", "when"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        // A second issue carrying the first one's body, and so the first one's
        // marker. The copy is made here because the marker is a digest of a
        // key: a document that could write one would be writing a run's
        // internal identity into its own text.
        if (props.when !== true) {
          return "";
        }
        const held = numbered(server, props.number, "duplicate");
        server.issues.push({ ...held, number: server.issues.length + 1 });
        return "";
      },
    },
    {
      name: "RetitleIssue",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
          to: { type: "string", minLength: 1 },
          when: { type: "boolean" },
        },
        required: ["number", "to", "when"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        if (props.when !== true) {
          return "";
        }
        numbered(server, props.number, "retitle").title = String(props.to);
        return "";
      },
    },
    {
      name: "MoveIssue",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
          to: { type: "string", minLength: 1 },
          when: { type: "boolean" },
        },
        required: ["number", "to", "when"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        if (props.when !== true) {
          return "";
        }
        numbered(server, props.number, "move").repository = String(props.to);
        return "";
      },
    },
    {
      name: "CloseIssue",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
          when: { type: "boolean" },
        },
        required: ["number", "when"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        if (props.when !== true) {
          return "";
        }
        numbered(server, props.number, "close").state = "closed";
        return "";
      },
    },
    {
      name: "TrackerIssues",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: {
          count: { type: "integer" },
          titles: { type: "array", items: { type: "string" } },
          states: { type: "array", items: { type: "string" } },
          repositories: { type: "array", items: { type: "string" } },
          labels: { type: "array" },
          assignees: { type: "array" },
        },
        required: ["count", "titles", "states", "repositories", "labels", "assignees"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return {
          count: server.issues.length,
          titles: server.issues.map((issue) => issue.title),
          states: server.issues.map((issue) => issue.state),
          // Empty for an issue this tracker never reported moving: the adapter
          // reads the repository an issue belongs to, and a scenario about one
          // that moved needs to say where it stayed.
          repositories: server.issues.map((issue) => issue.repository ?? ""),
          labels: server.issues.map((issue) => [...issue.labels]),
          assignees: server.issues.map((issue) => issue.assignee),
        };
      },
    },

    {
      name: "EmptyRequestLog",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        server.requests.length = 0;
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
          schemes: { type: "array", items: { type: "string" } },
          credentialed: { type: "boolean" },
          bodyKeys: { type: "array" },
          titles: { type: "array", items: { type: "string" } },
          descriptions: { type: "array", items: { type: "string" } },
          labels: { type: "array" },
          assignees: { type: "array" },
          markers: { type: "integer" },
        },
        required: [
          "methods",
          "paths",
          "schemes",
          "credentialed",
          "bodyKeys",
          "titles",
          "descriptions",
          "labels",
          "assignees",
          "markers",
        ],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        const sent = server.requests.map((request) => authoredIn(request.body));
        return {
          methods: server.requests.map((request) => request.method),
          paths: server.requests.map((request) => request.path),
          // The scheme, never the credential. A document that received the
          // header itself would carry a credential in its own text and in the
          // run's retained history — the one thing this contract says a history
          // never holds — and would not settle at all
          // (taras/executable.md#524). Whether the credential the tracker wants
          // actually arrived is decided here, where it is already known, and
          // reported as an answer.
          schemes: server.requests.map((request) => schemeOf(request.authorization)),
          credentialed:
            server.requests.length > 0 &&
            server.requests.every((request) => request.authorization === `Bearer ${credential()}`),
          // The member names each body carried, so a scenario can assert the
          // exact JSON shape the adapter sends without the body's contents —
          // and the origin marker in particular — reaching the document.
          bodyKeys: sent.map((body) => body.keys),
          titles: sent.map((body) => body.title),
          descriptions: sent.map((body) => body.description),
          labels: sent.map((body) => body.labels),
          assignees: sent.map((body) => body.assignee),
          markers: sent.filter((body) => body.marker).length,
        };
      },
    },

    {
      name: "EmptyProviderLog",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        log.keys.length = 0;
        log.overrides = 0;
        return "";
      },
    },
    {
      name: "ProviderLog",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" } },
          overrides: { type: "integer" },
        },
        required: ["keys", "overrides"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return { keys: [...log.keys], overrides: log.overrides };
      },
    },

    {
      name: "EmptyAtlassianTracker",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        log.atlassian.reads = 0;
        log.atlassian.upserts = 0;
        log.atlassianIssues.clear();
        return "";
      },
    },
    {
      name: "AtlassianTracker",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: {
          reads: { type: "integer" },
          upserts: { type: "integer" },
          issues: { type: "integer" },
        },
        required: ["reads", "upserts", "issues"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return {
          reads: log.atlassian.reads,
          upserts: log.atlassian.upserts,
          issues: log.atlassianIssues.size,
        };
      },
    },

    {
      name: "IssueJournal",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: {
          effects: { type: "integer" },
          retains: {
            type: "object",
            properties: {
              credential: { type: "boolean" },
              endpoint: { type: "boolean" },
              payload: { type: "boolean" },
              marker: { type: "boolean" },
              providerId: { type: "boolean" },
              hostPath: { type: "boolean" },
            },
            required: ["credential", "endpoint", "payload", "marker", "providerId", "hostPath"],
            additionalProperties: false,
          },
        },
        required: ["effects", "retains"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        // Asked of every Issue effect the run retained rather than of the
        // members somebody remembered to look at, and answered here rather than
        // handed over: the credential and the marker would not survive
        // rendering at all, and the rest would put a deployment's addresses and
        // a provider's private identifiers into a document's own text.
        //
        // Scoped to those effects, because they are what this boundary wrote.
        // The run's own records are a different question with a different
        // answer — `import_component` retains the host path of every module the
        // run loaded, which is the run's business and not something `<Issue>`
        // may either cause or prevent.
        const events = held.snapshot(RUN.runId);
        const text = JSON.stringify(issueYields(events));
        return {
          effects: issueYields(events).length,
          retains: {
            credential: text.includes(credential()),
            endpoint: text.includes(server.url),
            payload: PROVIDER_PAYLOAD.test(text),
            marker: ANY_MARKER_TEXT.test(text),
            providerId: PROVIDER_ID.test(text),
            hostPath: text.includes(scenarioDirectory()),
          },
        };
      },
    },
    {
      name: "StagedRun",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        // Declared *and* checked. The runner has to choose a journal before the
        // document can say anything, so the document states which one it is
        // journaling into and this refuses if the two disagree. That keeps the
        // run a visible fact of the attempt rather than an argument in a call a
        // reader of the Markdown never sees.
        const attempt = attempting.current;
        if (attempt === undefined) {
          throw new Error("<StagedRun> describes a staged attempt, and none is running");
        }
        if (attempt.runId !== String(props.id)) {
          throw new Error(
            `this attempt journals into "${attempt.runId}", and declares "${String(props.id)}"`,
          );
        }
        return "";
      },
    },
    {
      name: "Attempt",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: {
        type: "object",
        properties: { number: { type: "integer" } },
        required: ["number"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        // Which attempt of this run is expanding, counting from one.
        //
        // Recovery needs two attempts of the *same* request, and a request's
        // identity includes the expansion it was made at — so the two attempts
        // have to be one document, executed twice. What differs between them is
        // therefore stated inside that document, in terms of this number,
        // rather than by writing two documents that could never share a key.
        const attempt = attempting.current;
        if (attempt === undefined) {
          throw new Error("<Attempt> describes a staged attempt, and none is running");
        }
        return { number: attempt.number };
      },
    },
    {
      name: "Interrupted",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: { when: { type: "boolean" } },
        required: ["when"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        const attempt = attempting.current;
        if (attempt === undefined) {
          throw new Error("<Interrupted> describes a staged attempt, and none is running");
        }
        // The process ended before it could journal anything about its effect.
        // A different state from journaling a failure, and the one a recovery
        // exists for: the tracker holds an issue this run has no record of.
        //
        // Declared at the top of an attempt, because an attempt that fails
        // never reaches the bottom of its own document.
        if (props.when === true) {
          attempt.interrupted = true;
        }
        return "";
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

/** Members only a provider's own payload has. */
const PROVIDER_PAYLOAD = /"(node_id|html_url|repository_url|pull_request)"/;

/** A provider-native identifier, as this tracker mints them. */
const PROVIDER_ID = /I_node_\d+/;

/** An origin marker anywhere in a text, not only at the end of a body. */
const ANY_MARKER_TEXT = /executablemd-issue:/;

/** Where this suite's documents live on the machine running it. */
function scenarioDirectory(): string {
  return fileURLToPath(new URL("../scenarios/", import.meta.url));
}

/**
 * The issue a perturbation names, or a refusal that says which one is missing.
 *
 * Only consulted when the perturbation applies. A perturbation describes what
 * happened to the tracker *between* two attempts, so the issues it names are
 * the ones an earlier attempt filed and do not exist while that attempt is the
 * one running.
 */
function numbered(server: IssueTrackerServer, value: Json, what: string): ServedIssue {
  const number = Number(value);
  const held = server.issues.find((issue) => issue.number === number);
  if (held === undefined) {
    throw new Error(
      `this tracker holds ${server.issues.length} issues, so there is no issue ${number} to ${what}`,
    );
  }
  return held;
}

/** The authorization scheme a request carried, without its credential. */
function schemeOf(authorization: string | undefined): string {
  return authorization === undefined ? "" : authorization.split(" ")[0];
}

/** A JSON object, narrowed rather than asserted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The strings in a value that should be a list of them. */
function stringsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** An origin marker, whoever wrote it. Matched, never reported. */
const ANY_ORIGIN_MARKER = /\n\n<!-- executablemd-issue: [0-9a-f]+ -->\n?$/;

interface AuthoredBody {
  readonly keys: string[];
  readonly title: string;
  readonly description: string;
  readonly labels: string[];
  readonly assignee: string;
  readonly marker: boolean;
}

/**
 * What a request body authored, separated from what the adapter added to it.
 *
 * The marker is reported as a boolean and never as text. It is a digest of the
 * idempotency key, so handing it to a document would put a run's internal
 * identity into that document's rendered output and into its retained history,
 * and a scenario proves the marker was written by saying that it was.
 */
function authoredIn(body: unknown): AuthoredBody {
  if (!isRecord(body)) {
    return { keys: [], title: "", description: "", labels: [], assignee: "", marker: false };
  }
  const described = typeof body.body === "string" ? body.body : "";
  const marker = ANY_ORIGIN_MARKER.test(described);
  const [first] = stringsIn(body.assignees);
  return {
    keys: Object.keys(body).sort(byCodePoint),
    title: typeof body.title === "string" ? body.title : "",
    description: marker ? described.replace(ANY_ORIGIN_MARKER, "") : described,
    labels: stringsIn(body.labels),
    assignee: first ?? "",
    marker,
  };
}

/**
 * The attempt currently being staged, for the components that describe it.
 *
 * A stage document declares the run it journals into and whether its process
 * survived; both are read back here after it has expanded. Outside a staged
 * attempt there is nothing to describe, and the components say so rather than
 * inventing an answer.
 */
interface Attempting {
  current?: { readonly runId: string; readonly number: number; interrupted: boolean };
}

/**
 * Run one checked-in `.stage.md` document as a prior attempt.
 *
 * Its own child scope and no testing session. It installs **no provider**: the
 * document declares its own, with its ceiling, its credential condition and any
 * transport fault written where a reader meets them. An attempt that reaches
 * for a provider it did not declare fails, which is the same rule the asserting
 * documents run under.
 *
 * The journal is kept per run id, so a second attempt continues the first
 * rather than starting over — the only way to arrange the state a recovery
 * scenario stands on. The root Close is dropped afterwards because every
 * attempt here is a continuation. A document that declared `<Interrupted />`
 * additionally loses its Issue effect, because a process that died after the
 * tracker accepted its issue published nothing at all, and that is a different
 * state from one that journaled a failure.
 */
function stageAttempt(
  server: IssueTrackerServer,
  held: Journals,
  attempting: Attempting,
  document: string,
  number: number,
): Operation<AttemptOutcome> {
  return scoped(function* () {
    const before = server.requests.length;
    const id = RUN.runId;
    const stream = held.for(id);
    const path = fileURLToPath(new URL(`../scenarios/${document}`, import.meta.url));

    attempting.current = { runId: id, number, interrupted: false };
    // deno-lint-ignore require-yield
    yield* ensure(function* () {
      attempting.current = undefined;
    });

    const execution = yield* executeInstalled({ path, stream }, [
      retainedWorkflowInstallation({ ...RUN, runId: id }),
    ]);
    const output = yield* drain(execution.output);
    const outcome = yield* execution;
    const interrupted = attempting.current?.interrupted === true;

    const events = yield* stream.readAll();
    const continuing = events.filter(
      (event) => !(event.type === "close" && event.coroutineId === "root"),
    );
    // A process that died left a *prefix*. Everything from its first Issue
    // effect onward goes, not just the effect records: removing those from the
    // middle would leave every later position shifted, and the next attempt
    // would diverge against a history it should have been able to continue.
    const died = interrupted
      ? continuing.findIndex(
          (event) => event.type === "yield" && event.description.type === ISSUE_EFFECT,
        )
      : -1;
    const retained = died === -1 ? continuing : continuing.slice(0, died);
    held.truncate(id, retained);
    return {
      ok: outcome.ok,
      output,
      error: outcome.ok ? "" : outcome.error.message,
      // What the attempt *left behind*, not what it managed to write before it
      // stopped existing. An interrupted process journaled nothing, and the
      // count a scenario asks about is the one the next attempt inherits.
      effects: issueYields(retained).length,
      calls: server.requests.length - before,
    };
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
