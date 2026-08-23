/**
 * One workflow run, opened the way a host opens one.
 *
 * Everything here goes through `@executablemd/workflow`'s published surface —
 * the same one `packages/cli` itself uses — so a suite driving a run is driving
 * what a run is, not a stand-in for one.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { parseWorkflowDefinition, WorkflowRunStorage } from "@executablemd/workflow";
import type { CreateWorkflowRunRequest, WorkflowRunDatabase } from "@executablemd/workflow";
import { useWorkflowRunStorage } from "@executablemd/workflow/deno";

/** A commit id of the right shape; nothing fetches it. */
const OBJECT_ID = "1".repeat(40);

export function useStorageRoot(): Operation<string> {
  return useTempDirectory("xmd-cli-workflow-runs-");
}

export function withStorage<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowRunStorage({ root });
    return yield* body();
  });
}

export function* createRun(
  overrides: Partial<CreateWorkflowRunRequest> = {},
): Operation<WorkflowRunDatabase> {
  const parsed = parseWorkflowDefinition({
    version: 1,
    kind: "git",
    objectFormat: "sha1",
    objectId: OBJECT_ID,
    rootDocumentPath: "workflows/observation-loop.md",
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  const created = yield* WorkflowRunStorage.operations.create({
    runId: "observation-run",
    definition: parsed.value,
    base: "main",
    props: {},
    ...overrides,
  });
  if (!created.ok) {
    throw created.error;
  }
  return created.value;
}
