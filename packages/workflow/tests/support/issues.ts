/**
 * What the `<Issue>` suites agree on: one repository, one pull request, and one
 * approval somebody has to give.
 *
 * The document half is written the way a real workflow writes it — publish the
 * branch, open the pull request, bind it, and record one deferred obligation
 * against that binding — because the binding is what the element is authorized
 * by. The run half is the executor's: a durable wait ends an execution, so a
 * suite that wants to see what happens after the approval has to be the thing
 * that settles the run, delivers the answer and resumes it.
 */

import { call, race, scoped, suspend, type Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Result } from "effection";
import { WorkflowInputDelivery, type WorkflowAnswerRetention } from "../../mod.ts";
import { createSuspensionController } from "../../src/deno/suspension.ts";
import type { SuspensionNotice } from "../../src/deno/suspension.ts";
import { useWorkflowInputDelivery } from "../../src/deno/delivery.ts";
import { SUSPENSION_REQUEST } from "../../src/suspension/suspend.ts";
import type { WorkflowWorkspaceOptions } from "../../src/deno/workspace/host.ts";
import { creation, withExecutorRun, withRunHost } from "./storage.ts";
import type { WorkflowRunDatabase } from "../../src/storage/api.ts";
import { gitHostOutcomes, retainedRepositories, runWorkflowDocument } from "./composition.ts";
import type { GitHostOutcomeRecord } from "./composition.ts";
import type { StoredRepository } from "../../src/deno/workspace/repositories.ts";
import { published, pullRequest } from "./pull-requests.ts";

export const RUN = "release-1.4";

export const FINDING = "F-17";

export const ISSUE_TITLE = "Retry the publish step on a 5xx";

export const RATIONALE = "The retry needs a backoff policy nobody has settled yet.";

export const IMPACT = "Blocks nothing; the publish step is manual until it lands.";

export const TIMING = "Next release train.";

export const EVIDENCE = "The publish step failed twice in a row on 503.";

/** One `<Issue>`, and a line that reads what it bound. */
export function issue(...attributes: string[]): string[] {
  return [
    `<Issue finding="${FINDING}" disposition="defer" pullRequest={pullRequest}` +
      ` title="${ISSUE_TITLE}" rationale="${RATIONALE}" dependencyImpact="${IMPACT}"` +
      ` intendedTiming="${TIMING}"${attributes.join("")} as="issue">`,
    EVIDENCE,
    "</Issue>",
    "",
    "recorded {issue.number} at {issue.url} as {issue.state} by {issue.decision}",
  ];
}

/** The same element, with one attribute replaced by what a suite is testing. */
export function issueWith(replacements: Readonly<Record<string, string>>): string[] {
  const attributes: Record<string, string> = {
    finding: `"${FINDING}"`,
    disposition: `"defer"`,
    pullRequest: "{pullRequest}",
    title: `"${ISSUE_TITLE}"`,
    rationale: `"${RATIONALE}"`,
    dependencyImpact: `"${IMPACT}"`,
    intendedTiming: `"${TIMING}"`,
    ...replacements,
  };
  const written = Object.entries(attributes)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  return [
    `<Issue ${written} as="issue">`,
    EVIDENCE,
    "</Issue>",
    "",
    "recorded {issue.disposition}",
  ];
}

/** Publish a branch, open a pull request, and record one deferred obligation. */
export function deferring(...lines: string[]): string {
  return published(...pullRequest(), ...(lines.length === 0 ? issue() : lines));
}

/** The same, written so the run can read what a skipped decision bound. */
export function decidable(replacements: Readonly<Record<string, string>> = {}): string {
  return published(...pullRequest(), ...issueWith(replacements));
}

/** What one execution of a document under a real executor lock did. */
export interface WorkflowAttempt {
  readonly notice: SuspensionNotice | undefined;
  readonly thrown: unknown;
  readonly rendered: string | undefined;
  readonly events: readonly DurableEvent[];
  readonly outcomes: readonly GitHostOutcomeRecord[];
  /** What the run retains, read while its executor lock is still held. */
  readonly repositories: readonly StoredRepository[];
}

/**
 * Run one document as this run's next execution, and settle what it did.
 *
 * The controller stands in for the executor exactly as the CLI arranges it: it
 * observes a reported wait, `race` halts the execution around it, and the run is
 * settled `suspended` with a stop reason naming the retained request — which is
 * the state delivery reads. A run that finished is settled `completed`, and one
 * that failed settles nothing, which is what a dead process leaves behind.
 */
export interface AttemptOptions {
  /**
   * What else this execution's scope does once the document has finished.
   *
   * A run's database is reachable only while its executor lock is held, so a
   * claim about what the run retained — or a replay of the same document
   * against it — belongs here rather than after the lock is released.
   */
  readonly after?: (database: WorkflowRunDatabase) => Operation<void>;
  /**
   * Halt the document when this settles.
   *
   * An execution somebody interrupted is not one that finished, so nothing is
   * settled for it: what is left behind is the state a dead process leaves.
   */
  readonly interrupt?: Operation<unknown>;
}

export function attemptWorkflow(
  root: string,
  action: "start" | "resume",
  source: string,
  options: WorkflowWorkspaceOptions,
  extra: AttemptOptions = {},
): Operation<WorkflowAttempt> {
  return withRunHost(root, function* (transitions) {
    return yield* withExecutorRun(
      transitions,
      action === "start" ? { runId: RUN, action, creation: creation() } : { runId: RUN, action },
      function* (begun, executorLock) {
        const { database } = begun;
        const suspension = createSuspensionController({ database });
        let thrown: unknown;
        let rendered: string | undefined;
        let notice: SuspensionNotice | undefined;
        let interrupted = false;

        yield* race([
          call(function* (): Operation<void> {
            try {
              rendered = String(
                yield* suspension.own(runWorkflowDocument(database, source, options)),
              );
            } catch (error) {
              thrown = error;
            }
          }),
          call(function* (): Operation<void> {
            notice = yield* suspension.notice;
          }),
          ...(extra.interrupt === undefined
            ? []
            : [
                call(function* (): Operation<void> {
                  yield* extra.interrupt ?? suspend();
                  interrupted = true;
                }),
              ]),
        ]);

        if (extra.after !== undefined) {
          yield* extra.after(database);
        }

        const events = yield* database.journal.readAll();
        const outcomes = yield* gitHostOutcomes(database);
        const repositories = yield* retainedRepositories(database);

        if (notice === undefined && thrown === undefined && !interrupted) {
          const finished = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "completed",
          });
          if (!finished.ok) {
            throw finished.error;
          }
        }

        if (notice !== undefined) {
          const entries = yield* database.readJournalEntries();
          const request = entries.ok
            ? entries.value.find(
                (entry) =>
                  entry.event.type === "yield" &&
                  entry.event.description.type === SUSPENSION_REQUEST &&
                  entry.event.description.name === notice?.suspensionId,
              )
            : undefined;
          const settled = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "suspended",
            ...(request === undefined
              ? {}
              : { reason: { kind: "journal" as const, eventId: request.eventId } }),
          });
          if (!settled.ok) {
            throw settled.error;
          }
        }

        return { notice, thrown, rendered, events, outcomes, repositories };
      },
    );
  });
}

/**
 * One deferring document approved and resumed: two executions, one delivery.
 *
 * That is what a durable approval is. The first execution ends at the wait, the
 * answer is retained while nothing is running, and the second spends it.
 */
export interface RecordedOptions extends AttemptOptions {
  /** What is delivered to the wait. Absent approves it. */
  readonly value?: Json;
  /** What to assert about the first execution, before the answer exists. */
  readonly between?: (first: WorkflowAttempt) => void;
}

export function* recorded(
  root: string,
  source: string,
  options: WorkflowWorkspaceOptions,
  extra: RecordedOptions = {},
): Operation<{ first: WorkflowAttempt; second: WorkflowAttempt }> {
  const first = yield* attemptWorkflow(root, "start", source, options);
  extra.between?.(first);
  const delivered = yield* answer(
    root,
    waitOf(first).suspensionId,
    extra.value ?? {
      approved: true,
    },
  );
  if (!delivered.ok) {
    throw delivered.error;
  }
  const second = yield* attemptWorkflow(root, "resume", source, options, extra);
  return { first, second };
}

/** Deliver one typed answer to the wait this run reported. */
export function answer(
  root: string,
  suspensionId: string,
  value: Json,
): Operation<Result<WorkflowAnswerRetention>> {
  return scoped(function* () {
    yield* useWorkflowInputDelivery({ root });
    return yield* WorkflowInputDelivery.operations.deliver({
      runId: RUN,
      suspensionId,
      value,
      secretDetection: true,
    });
  });
}

/**
 * The wait this attempt reported, refusing an attempt that reported none.
 *
 * A suite whose next step is a delivery cannot continue without one, and
 * continuing with `undefined` would deliver to nothing and assert nothing.
 */
export function waitOf(attempt: WorkflowAttempt): SuspensionNotice {
  if (attempt.notice === undefined) {
    throw new Error("the document did not reach a durable wait");
  }
  return attempt.notice;
}

/** The suspension requests this run retained, as the journal holds them. */
export function suspensionRequests(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === SUSPENSION_REQUEST,
  );
}
