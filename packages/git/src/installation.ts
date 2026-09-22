/**
 * Associating one document execution with a Git-defined workflow run.
 *
 * `workflowInstallation({ base })` is a value, not an installation act. It
 * creates no workflow run: a run comes into being when a document execution
 * reaches its first durable operation, which resolves the base once, records
 * one immutable value, and only then lets the root document be imported.
 *
 * What this package supplies is the half that knows about Git — how the run is
 * described, how it is allocated when nothing is recorded yet, and what a
 * recorded run has to agree with. Everything the run is then held to is
 * `@executablemd/workflow`'s: the installation slot, when retained history is
 * admitted, the parser that reads the durable record back, and where the
 * current run is published. A base that would not resolve is recorded as a
 * failed effect, so a run replays that failure rather than resolving again.
 */

import type { Operation } from "effection";
import type { ExecutionInstallation } from "@executablemd/core/host";
import {
  baseMismatch,
  createWorkflowRunInstallation,
  describeGitWorkflowRun,
  isGitWorkflowRun,
  retainedRunMismatch,
} from "@executablemd/workflow";
import type { WorkflowRun, WorkflowRunPreparation } from "@executablemd/workflow";
import { resolveGitRevision } from "./git.ts";

function allocating(base: string): WorkflowRunPreparation {
  return {
    description: describeGitWorkflowRun(base),
    // A base that would not resolve is recorded as a failed effect (§6), and a
    // history whose only record is that failure is this run's own. Requiring a
    // successful one would retry Git instead of replaying what happened.
    required: false,
    *allocate(): Operation<WorkflowRun> {
      const pinnedCommit = yield* resolveGitRevision(`${base}^{commit}`);
      // Web Crypto rather than `node:crypto`: a run id is allocated in shared
      // code, which names no host.
      return { runId: crypto.randomUUID(), base, pinnedCommit };
    },
    /**
     * The description carries the base for a reader; divergence detection
     * compares only type and name, so the base this run supplied is checked
     * against the stored *value* rather than against the entry's identity.
     */
    agree(recorded: WorkflowRun): WorkflowRun {
      // This installation allocates a Git run, so a recorded source bundle is
      // not a base disagreement — it is a different kind of run entirely.
      if (!isGitWorkflowRun(recorded)) {
        throw retainedRunMismatch(["definition version"]);
      }
      if (recorded.base !== base) {
        throw baseMismatch(recorded.base, base);
      }
      return recorded;
    },
  };
}

/**
 * The installation that associates one document execution with a workflow run
 * resolved from a Git base.
 *
 * Constructing it creates nothing. Executing a document under it does.
 *
 * ```ts
 * yield* executeInstalled(options, [workflowInstallation({ base: "main" })]);
 * ```
 */
export function workflowInstallation(options: { base: string }): ExecutionInstallation {
  return createWorkflowRunInstallation(allocating(options.base));
}
