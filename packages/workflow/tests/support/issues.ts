/**
 * What the `<Issue>` suites agree on: one run, one target, two providers.
 *
 * These need no SQLite, no Git and no Workspace, and that is not an economy —
 * it is the contract. An issue provider need not own a Git repository, so the
 * primitive that reaches one must not need a Repository to work, and a harness
 * that gave it one would hide the day that stopped being true.
 *
 * What is real here is the component, the context, the routing surface, the
 * reconciliation and the GitHub adapter. What is substituted is the transport,
 * which is the whole of what the adapter asks its host for.
 */

import { call, Err, Ok, scoped, type Operation, type Result } from "effection";
import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { retainedWorkflowInstallation } from "../../src/run.ts";
import type { WorkflowRun } from "../../src/run.ts";
import { useCompositionComponents } from "../../src/composition/installation.ts";
import { ISSUE_EFFECT } from "../../src/issue/effect-type.ts";
import { useIssueProvider } from "../../src/issue/effect.ts";
import type { IssueProvider } from "../../src/issue/api.ts";
import { IssueProviderError, IssueUnavailableError } from "../../src/issue/errors.ts";
import {
  issueObservationsJson,
  issuePreStateJson,
  issueRecordResultJson,
  issueAgrees,
  parseIssueInputs,
  parseIssuePreState,
  parseIssueReconciliationRecord,
  type CompleteIssueRequest,
  type IssueCompletion,
  type IssueObservation,
  type IssueReconciliationRecord,
  type IssueSnapshot,
} from "../../src/issue/records.ts";
import { withinIssueCeiling } from "../../src/issue/target.ts";
import { IssueTargetContext } from "../../src/issue/context.ts";
import { builtInIssueProvider } from "../../src/deno/issue/resolution.ts";
import { gitHubIssueProvider } from "../../src/deno/issue/github.ts";
import { fakeGitHubAccess, gitHubStore, type GitHubStore } from "./github.ts";

export const RUN: WorkflowRun = Object.freeze({
  runId: "run-296-issue",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

/** The GitHub repository issue collection every suite writes into. */
export const TARGET = "https://github.com/octo/project";

/** An Atlassian Cloud project, for the routing the amendment requires. */
export const ATLASSIAN_TARGET = "https://acme.atlassian.net/browse/PROJ";

/** The endpoint the fake transport answers on. */
export const ENDPOINT = "https://api.github.test";

export const TITLE = "Retry the publish step on a 5xx";

export const DESCRIPTION = "The publish step failed twice in a row on 503.";

/** A credential no journal, result or routing observation may ever hold. */
export const TOKEN = "github-credential-for-this-test";

/** One `<Issue>`, written inside a target, and a line that reads what it bound. */
export function document(target: string = TARGET, attributes = "", provider?: string): string {
  const discriminator = provider === undefined ? "" : ` provider="${provider}"`;
  return [
    `<IssueTarget url="${target}"${discriminator}>`,
    `<Issue title="${TITLE}" description="${DESCRIPTION}"${attributes} as="issue" />`,
    "</IssueTarget>",
    "",
    "recorded {issue.url}",
  ].join("\n");
}

/** A GitHub store whose issues this run creates, with a token it must send. */
export function store(): GitHubStore {
  const created = gitHubStore({ token: TOKEN });
  return created;
}

/** The production GitHub provider, over a transport that answers from `state`. */
export function gitHub(state: GitHubStore, ceiling: readonly string[] = [TARGET]): IssueProvider {
  return gitHubIssueProvider({ ceiling, access: fakeGitHubAccess(state, ENDPOINT) });
}

/** One issue an Atlassian-shaped provider holds. */
export interface AtlassianIssue {
  key: string;
  title: string;
  description: string;
  tags: readonly string[];
  assignee: string | null;
}

export interface AtlassianTracker {
  readonly issues: Map<string, AtlassianIssue>;
  /** Every request this provider was given, so a suite can prove selection. */
  readonly observed: CompleteIssueRequest[];
  readonly performed: CompleteIssueRequest[];
  readonly ceiling: string[];
}

export function atlassianTracker(ceiling: string[] = [ATLASSIAN_TARGET]): AtlassianTracker {
  return { issues: new Map(), observed: [], performed: [], ceiling };
}

/**
 * An Atlassian-shaped provider: the same normalized fields, another service.
 *
 * It exists to prove the contract is portable rather than GitHub's shape with
 * another name on it. It keys its issues the way a tracker does — by an opaque
 * project key it mints — and it reads the natural key out of the request rather
 * than out of anything GitHub-specific.
 */
export function atlassianProvider(tracker: AtlassianTracker): IssueProvider {
  function keyOf(request: CompleteIssueRequest): string {
    return JSON.stringify(request.naturalKey);
  }

  function snapshotOf(issue: AtlassianIssue): IssueSnapshot {
    return Object.freeze({
      providerId: issue.key,
      url: `https://acme.atlassian.net/browse/${issue.key}`,
      state: "open" as const,
      title: issue.title,
      description: issue.description,
      tags: issue.tags,
      assignee: issue.assignee,
    });
  }

  function completion(request: CompleteIssueRequest, issue: AtlassianIssue): IssueCompletion {
    const snapshot = snapshotOf(issue);
    return {
      observations: issueObservationsJson({ issue: snapshot }),
      result: issueRecordResultJson({
        provider: "atlassian",
        target: request.target,
        providerId: snapshot.providerId,
        url: snapshot.url,
      }),
    };
  }

  return {
    *observe(request): Operation<Result<IssueObservation>> {
      tracker.observed.push(request);
      if (
        request.provider !== "atlassian" ||
        !withinIssueCeiling(tracker.ceiling, request.target)
      ) {
        return Err(
          new IssueProviderError("this tracker creates issues only in projects it was given"),
        );
      }
      const inputs = parseIssueInputs(request.inputs);
      if (inputs === undefined) {
        return Err(new IssueUnavailableError());
      }
      const held = tracker.issues.get(keyOf(request));
      if (held === undefined) {
        return Ok({ state: "absent", preState: issuePreStateJson({ issue: null }) });
      }
      const snapshot = snapshotOf(held);
      if (issueAgrees(snapshot, inputs)) {
        const adopted = completion(request, held);
        return Ok({
          state: "compatible",
          preState: issuePreStateJson({ issue: snapshot }),
          observations: adopted.observations,
          result: adopted.result,
        });
      }
      return Ok({ state: "absent", preState: issuePreStateJson({ issue: snapshot }) });
    },

    *perform(request, observation): Operation<Result<IssueCompletion>> {
      tracker.performed.push(request);
      const inputs = parseIssueInputs(request.inputs);
      const before = parseIssuePreState(observation.preState);
      if (inputs === undefined || before === undefined) {
        return Err(new IssueUnavailableError());
      }
      const existing = tracker.issues.get(keyOf(request));
      const issue: AtlassianIssue = {
        key: existing?.key ?? `PROJ-${tracker.issues.size + 1}`,
        title: inputs.title,
        description: inputs.description,
        tags: inputs.tags,
        assignee: inputs.assignee,
      };
      tracker.issues.set(keyOf(request), issue);
      return Ok(completion(request, issue));
    },
  };
}

/** A provider that fails the suite if any phase reaches it. */
export function forbiddenProvider(name: string): IssueProvider {
  return {
    // deno-lint-ignore require-yield
    *observe(): Operation<Result<IssueObservation>> {
      throw new Error(`the ${name} provider was observed where nothing may reach it`);
    },
    // deno-lint-ignore require-yield
    *perform(): Operation<Result<IssueCompletion>> {
      throw new Error(`the ${name} provider performed where nothing may reach it`);
    },
  };
}

export interface InstalledProvider {
  readonly discriminator: string;
  readonly provider: IssueProvider;
}

export interface RunOptions {
  readonly stream?: DurableStream;
  readonly source?: string;
  readonly providers?: readonly InstalledProvider[];
  readonly around?: (operation: Operation<unknown>) => Operation<unknown>;
}

export interface IssueAttempt {
  readonly rendered: string | undefined;
  readonly thrown: unknown;
  readonly events: DurableEvent[];
  readonly records: IssueReconciliationRecord[];
  readonly stream: DurableStream;
}

/**
 * One document execution under one retained run.
 *
 * The run is retained rather than allocated so every execution in a test
 * carries the same external identity, which is what the reconciliation keys on.
 * The document's failure is captured rather than raised: what each test
 * measures is the provider traffic and the journal, and both outlive it.
 */
export function runIssueDocument(options: RunOptions = {}): Operation<IssueAttempt> {
  return scoped(function* () {
    const stream = options.stream ?? new InMemoryStream();
    const source = options.source ?? document();
    let rendered: string | undefined;
    let thrown: unknown;

    yield* scoped(function* () {
      yield* useCompositionComponents();
      // The host's own mapping, installed the way `useIssueProviders()`
      // installs it: this harness stands in for the trusted host.
      yield* IssueTargetContext.around(
        {
          // deno-lint-ignore require-yield
          *resolve([target]): Operation<string | undefined> {
            return builtInIssueProvider(target);
          },
        },
        { at: "min" },
      );
      for (const installed of options.providers ?? []) {
        yield* useIssueProvider(installed.discriminator, installed.provider);
      }
      // Lazy on purpose. `around` installs the middleware a suite is testing,
      // so the execution has to start inside it — an operation built by
      // yielding here would already have run outside every handler.
      const execution: Operation<unknown> = call(function* (): Operation<unknown> {
        return yield* collect(
          yield* executeInstalled({ ...inlineSource(source), stream }, [
            retainedWorkflowInstallation(RUN),
          ]),
        );
      });
      const around = options.around ?? ((operation: Operation<unknown>) => operation);
      try {
        rendered = String(yield* around(execution));
      } catch (error) {
        thrown = error;
      }
    });

    const events = yield* stream.readAll();
    return { rendered, thrown, events, records: recordsIn(events), stream };
  });
}

/** Every Issue effect this run journaled, in order. */
export function issueYields(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === ISSUE_EFFECT,
  );
}

function recordsIn(events: readonly DurableEvent[]): IssueReconciliationRecord[] {
  const records: IssueReconciliationRecord[] = [];
  for (const event of issueYields(events)) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    const record = parseIssueReconciliationRecord(event.result.value);
    if (record !== undefined) {
      records.push(record);
    }
  }
  return records;
}

/** The history a run leaves behind when it was interrupted before it closed. */
export function partial(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => !(event.type === "close" && event.coroutineId === "root"));
}

/** What one Issue effect settled as, whichever way it settled. */
export function issueOutcomes(events: readonly DurableEvent[]): { status: string; name: string }[] {
  return issueYields(events).map((event) => {
    const result = Object(Reflect.get(event, "result"));
    const error = Object(Reflect.get(result, "error"));
    return {
      status: String(Reflect.get(result, "status")),
      name: String(Reflect.get(error, "name") ?? ""),
    };
  });
}

/** What an operation threw, so a suite can assert on it rather than fail. */
export function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The failure of this kind somewhere in this one's causes. */
export function causedBy<T>(
  error: unknown,
  is: (candidate: unknown) => candidate is T,
): T | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (is(current)) {
      return current;
    }
    if (current instanceof Error) {
      queue.push(current.cause);
      if (current instanceof AggregateError) {
        queue.push(...current.errors);
      }
    }
  }
  return undefined;
}
