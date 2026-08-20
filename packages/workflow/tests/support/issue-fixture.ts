/**
 * The host the `<Issue>` scenario documents run against.
 *
 * These documents are the contract's evidence, so what stands in for a service
 * has to be a service and not a stub of the code under test: the GitHub
 * middleware here is the shipped one, over a transport that answers out of an
 * in-memory store. What this module adds is everything a document cannot write
 * for itself — a second provider to be routed away from, counters to assert on,
 * faults to inject, and a way to run one document twice against one journal.
 *
 * Nothing here needs SQLite, Git or a Workspace, and that is the contract
 * rather than an economy: an issue provider need not own a Git repository, so
 * the primitive that reaches one must not need one to be exercised.
 */

import { scoped, type Operation } from "effection";
import { fileURLToPath } from "node:url";
import { collect, registerComponents } from "@executablemd/core";
import type { Json, PropsSchema, ReturnsSchema } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { installTestingComponents, Test } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { retainedWorkflowInstallation } from "../../src/run.ts";
import type { WorkflowRun } from "../../src/run.ts";
import { useCompositionComponents } from "../../src/composition/installation.ts";
import { IssueApi } from "../../src/issue/api.ts";
import type { IssueInput, IssueResult, IssueUpsertOptions } from "../../src/issue/api.ts";
import { IssueUnavailableError } from "../../src/issue/errors.ts";
import { ISSUE_EFFECT } from "../../src/issue/effect-type.ts";
import { withinIssueCeiling } from "../../src/issue/tracker.ts";
import { useGitHubIssues } from "../../src/deno/issue/github.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../../src/deno/composition/github.ts";
import { gitHubStore, respond, type GitHubStore } from "./github.ts";

/** The GitHub repository issue collection the scenarios write into. */
export const GITHUB_TARGET = "https://github.com/octo/project";

/** An Atlassian Cloud project, for the routing the contract requires. */
export const ATLASSIAN_TARGET = "https://acme.atlassian.net/browse/PROJ";

/** A self-hosted deployment only an explicit discriminator can reach. */
export const SELF_HOSTED_TARGET = "https://git.example.invalid/octo/project";

export const ENDPOINT = "https://api.github.test";

/** A credential no journal, result or assertion may ever hold. */
export const TOKEN = "github-credential-for-this-scenario";

const RUN: WorkflowRun = Object.freeze({
  runId: "run-296-issue",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

/** One issue an Atlassian-shaped tracker holds. */
interface AtlassianIssue {
  key: string;
  title: string;
  description: string;
  tags: readonly string[];
  assignee: string | null;
  marker: string;
}

/** What a scenario can make the fixture do instead of answering. */
export interface IssueFault {
  /** Fail the transport outright, so nothing is provable. */
  transport?: boolean;
  /** Answer the create with a failure after the issue was already filed. */
  interruptAfterCreate?: boolean;
}

export interface IssueFixture {
  readonly github: GitHubStore;
  readonly atlassian: Map<string, AtlassianIssue>;
  /** Every request the Atlassian-shaped middleware was given. */
  readonly atlassianRequests: IssueUpsertOptions[];
  /** Whether the Atlassian-shaped middleware refuses after matching. */
  atlassianRefuses: boolean;
  fault: IssueFault;
  ceiling: string[];
  reset(): void;
}

export function issueFixture(): IssueFixture {
  const fixture: IssueFixture = {
    github: gitHubStore({ token: TOKEN }),
    atlassian: new Map(),
    atlassianRequests: [],
    atlassianRefuses: false,
    fault: {},
    ceiling: [GITHUB_TARGET, ATLASSIAN_TARGET, SELF_HOSTED_TARGET],
    reset(): void {
      fixture.github.issues.length = 0;
      fixture.github.pullRequests.length = 0;
      fixture.github.requests.length = 0;
      fixture.github.fault = undefined;
      fixture.atlassian.clear();
      fixture.atlassianRequests.length = 0;
      fixture.atlassianRefuses = false;
      fixture.fault = {};
      fixture.ceiling.splice(
        0,
        fixture.ceiling.length,
        GITHUB_TARGET,
        ATLASSIAN_TARGET,
        SELF_HOSTED_TARGET,
      );
    },
  };
  return fixture;
}

/** The transport the shipped GitHub middleware runs over. */
function access(fixture: IssueFixture): GitHubAccess {
  return {
    endpoint: ENDPOINT,
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      return fixture.github.token;
    },
    // deno-lint-ignore require-yield
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      if (fixture.fault.transport === true) {
        throw new Error("the fixture transport refused the connection");
      }
      const answer = respond(fixture.github, request);
      if (
        fixture.fault.interruptAfterCreate === true &&
        request.method === "POST" &&
        answer.status === 201
      ) {
        // The issue is filed and this end never learns that it is: the gap the
        // idempotency key exists to close.
        throw new Error("the fixture died after the tracker accepted the issue");
      }
      return answer;
    },
  };
}

/**
 * An Atlassian-shaped provider: the same normalized fields, another service.
 *
 * It exists to prove the contract is portable rather than GitHub's shape with
 * another name on it, and to be the provider a routed-away request must not
 * reach. It matches `*.atlassian.net` by URL and `atlassian` by discriminator.
 */
function* useAtlassianIssues(fixture: IssueFixture): Operation<void> {
  yield* IssueApi.around(
    {
      *upsert([issue, upsert], next): Operation<IssueResult> {
        const mine =
          upsert.provider === undefined
            ? hostOf(upsert.url)?.endsWith(".atlassian.net") === true
            : upsert.provider === "atlassian";
        if (!mine) {
          return yield* next(issue, upsert);
        }
        fixture.atlassianRequests.push(upsert);
        // Matched, so this middleware owns the answer from here.
        if (fixture.atlassianRefuses || !withinIssueCeiling(fixture.ceiling, upsert.url)) {
          throw new IssueUnavailableError();
        }
        const held = fixture.atlassian.get(upsert.idempotencyKey);
        if (held !== undefined) {
          return { url: `https://acme.atlassian.net/browse/${held.key}` };
        }
        const key = `PROJ-${fixture.atlassian.size + 1}`;
        fixture.atlassian.set(upsert.idempotencyKey, {
          key,
          title: issue.title,
          description: issue.description,
          tags: issue.tags,
          assignee: issue.assignee,
          marker: upsert.idempotencyKey,
        });
        return { url: `https://acme.atlassian.net/browse/${key}` };
      },
    },
    { at: "min" },
  );
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const NO_PROPS: PropsSchema = { type: "object", properties: {}, additionalProperties: false };

/**
 * The components a scenario document uses to arrange and inspect the fixture.
 *
 * Deliberately few, and none of them is the code under test: they reset the
 * fixture, report what it holds, and arrange the two conditions a document
 * cannot create for itself — a transport that fails, and an attempt that dies
 * after the tracker accepted its issue.
 */
function* useFixtureComponents(fixture: IssueFixture, journals: Journals): Operation<void> {
  const STATE_RETURNS: ReturnsSchema = {
    type: "object",
    properties: {
      issues: { type: "integer" },
      creates: { type: "integer" },
      updates: { type: "integer" },
      requests: { type: "integer" },
      titles: { type: "array", items: { type: "string" } },
      labels: { type: "array", items: { type: "array", items: { type: "string" } } },
      assignees: { type: "array" },
      atlassian: { type: "integer" },
      atlassianRequests: { type: "integer" },
    },
    required: [
      "issues",
      "creates",
      "updates",
      "requests",
      "titles",
      "labels",
      "assignees",
      "atlassian",
      "atlassianRequests",
    ],
    additionalProperties: false,
  };

  yield* registerComponents([
    {
      name: "IssueFixture",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          ceiling: { type: "array", items: { type: "string" } },
          atlassianRefuses: { type: "boolean" },
          transportFails: { type: "boolean" },
          interruptAfterCreate: { type: "boolean" },
        },
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>): Operation<string> {
        fixture.reset();
        journals.clear();
        if (Array.isArray(props.ceiling)) {
          // In place, because the installed middleware closed over this array.
          fixture.ceiling.splice(
            0,
            fixture.ceiling.length,
            ...props.ceiling.map((entry) => String(entry)),
          );
        }
        fixture.atlassianRefuses = props.atlassianRefuses === true;
        fixture.fault = {
          ...(props.transportFails === true ? { transport: true } : {}),
          ...(props.interruptAfterCreate === true ? { interruptAfterCreate: true } : {}),
        };
        return "";
      },
    },
    {
      name: "IssueAttempt",
      origin: "@executablemd/workflow/test",
      props: {
        type: "object",
        properties: {
          document: { type: "string", minLength: 1 },
          run: { type: "string", minLength: 1 },
          forbidProviders: { type: "boolean" },
        },
        required: ["document"],
        additionalProperties: false,
      },
      returns: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          url: { type: ["string", "null"] },
          error: { type: "string" },
          effects: { type: "integer" },
          calls: { type: "integer" },
        },
        required: ["ok", "url", "error", "effects", "calls"],
        additionalProperties: false,
      },
      *fn(props: Record<string, Json>): Operation<Json> {
        const document = typeof props.document === "string" ? props.document : "";
        const id = typeof props.run === "string" ? props.run : RUN.runId;
        return yield* attemptOnce(fixture, journals, document, id, props.forbidProviders === true);
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
      *fn(): Operation<Json> {
        // The whole retained history as text, so an assertion about what is
        // absent from it is an assertion about every member rather than about
        // the members somebody remembered to look at.
        const events = journals.snapshot(RUN.runId);
        return { text: JSON.stringify(events), effects: issueYields(events).length };
      },
    },
    {
      name: "IssueState",
      origin: "@executablemd/workflow/test",
      props: NO_PROPS,
      returns: STATE_RETURNS,
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        const requests = fixture.github.requests;
        return {
          issues: fixture.github.issues.length,
          creates: requests.filter(
            (request) =>
              request.method === "POST" && new URL(request.url).pathname.endsWith("/issues"),
          ).length,
          updates: requests.filter((request) => request.method === "PATCH").length,
          requests: requests.length,
          titles: fixture.github.issues.map((issue) => issue.title),
          labels: fixture.github.issues.map((issue) => [...(issue.labels ?? [])]),
          assignees: fixture.github.issues.map((issue) => issue.assignee ?? null),
          atlassian: fixture.atlassian.size,
          atlassianRequests: fixture.atlassianRequests.length,
        };
      },
    },
  ]);
}

/**
 * Run one checked-in fixture document as its own execution.
 *
 * The journal is kept per run id, so a second attempt continues the first
 * rather than starting over — which is the only way to arrange the two states
 * these scenarios are about: an attempt interrupted after the tracker accepted
 * its issue, and a completed one being replayed.
 *
 * The root Close is dropped afterwards, because every attempt here is a
 * continuation: a completed journal answers with its recorded root result and
 * would replay nothing at all.
 */
function* attemptOnce(
  fixture: IssueFixture,
  journals: Journals,
  document: string,
  id: string,
  forbidProviders: boolean,
): Operation<Json> {
  const before = fixture.github.requests.length;
  const stream = journals.for(id);
  const path = fileURLToPath(new URL(`../scenarios/fixtures/${document}`, import.meta.url));
  let ok = true;
  let url: string | null = null;
  let error = "";
  try {
    const rendered = String(
      yield* scoped(function* () {
        if (forbidProviders) {
          // Nothing may be reached, so nothing is left installed to reach.
          yield* IssueApi.around({
            // deno-lint-ignore require-yield
            *upsert(): Operation<IssueResult> {
              throw new Error("a replay reached an issue provider");
            },
          });
        }
        return yield* collect(
          yield* executeInstalled({ path, stream }, [
            retainedWorkflowInstallation({ ...RUN, runId: id }),
          ]),
        );
      }),
    );
    const found = /filed (\S+)/.exec(rendered);
    url = found?.[1] ?? null;
  } catch (raised) {
    ok = false;
    error = raised instanceof Error ? raised.message : String(raised);
  }
  const events = yield* stream.readAll();
  journals.truncate(
    id,
    events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
  return {
    ok,
    url,
    error,
    effects: issueYields(events).length,
    calls: fixture.github.requests.length - before,
  };
}

/** One in-memory journal per run id, so a document can be executed twice. */
interface Journals {
  for(id: string): DurableStream;
  snapshot(id: string): DurableEvent[];
  /** Replace a journal with the prefix an interrupted run would have left. */
  truncate(id: string, events: readonly DurableEvent[]): void;
  clear(): void;
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
    clear(): void {
      streams.clear();
    },
  };
}

export interface ScenarioRun {
  readonly rendered: string;
  readonly thrown: unknown;
  readonly events: readonly DurableEvent[];
  readonly fixture: IssueFixture;
  /** What each `<Test>` in the document decided. */
  readonly results: TestResult[];
}

/**
 * Execute one checked-in scenario document.
 *
 * The document is read from disk rather than assembled here, because it is the
 * evidence: a reader reviews the Markdown, not a string a test built.
 */
export function runScenario(path: string): Operation<ScenarioRun> {
  return scoped(function* () {
    const fixture = issueFixture();
    const held = journals();
    const stream = held.for(RUN.runId);

    const results: TestResult[] = [];
    yield* Test.around({
      *record([result], next) {
        results.push(result);
        yield* next(result);
      },
    });
    // Activated without `useTesting()`'s session: a session supports one
    // `execute()` call, and these scenarios run fixture documents of their own
    // to arrange an interrupted attempt and a replay. What the session adds
    // beyond activation is a completion failure this runner reads off the
    // results itself.
    yield* installTestingComponents();
    yield* Test.around({ testing: () => true });

    yield* useCompositionComponents();
    yield* useFixtureComponents(fixture, held);
    yield* useAtlassianIssues(fixture);
    yield* useGitHubIssues({ ceiling: fixture.ceiling, access: access(fixture) });

    let rendered = "";
    let thrown: unknown;
    try {
      rendered = String(
        yield* collect(
          yield* executeInstalled({ path, stream }, [retainedWorkflowInstallation(RUN)]),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    return { rendered, thrown, events: yield* stream.readAll(), fixture, results };
  });
}

/** Every Issue effect a scenario journaled, in order. */
export function issueYields(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === ISSUE_EFFECT,
  );
}

export type { IssueInput };
