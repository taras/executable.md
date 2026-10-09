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
import {
  parseWorkflowDefinition,
  sourceBundleHash,
  sourceContentHash,
  WorkflowRunStorage,
} from "@executablemd/workflow";
import type { CreateWorkflowRunRequest, WorkflowRunDatabase } from "@executablemd/workflow";
import { useWorkflowRunStorage } from "@executablemd/workflow/deno";

/** The logical entrypoint this run retains, and the bytes behind it. */
const ENTRYPOINT = "observation-loop.md";
const ENTRYPOINT_SOURCE = "# Observation loop\n";

export function useStorageRoot(): Operation<string> {
  return useTempDirectory("xmd-cli-workflow-runs-");
}

export function withStorage<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowRunStorage({ root });
    return yield* body();
  });
}

/**
 * One run of one retained document, created the way a host creates one.
 *
 * The descriptor is derived from the bytes rather than written beside them, so
 * the bundle hash this retains is the hash those bytes really produce — which
 * is what the create request verifies before it writes anything.
 */
export function* createRun(
  overrides: Partial<CreateWorkflowRunRequest> = {},
): Operation<WorkflowRunDatabase> {
  const bytes = new TextEncoder().encode(ENTRYPOINT_SOURCE);
  const sources = [
    {
      path: ENTRYPOINT,
      sourceHash: yield* sourceContentHash(bytes),
      byteLength: bytes.byteLength,
    },
  ];
  const parsed = parseWorkflowDefinition({
    hashAlgorithm: "sha256",
    bundleHash: yield* sourceBundleHash({ entrypoint: ENTRYPOINT, sources }),
    entrypoint: ENTRYPOINT,
    sources,
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  const created = yield* WorkflowRunStorage.operations.create({
    runId: "observation-run",
    definition: parsed.value,
    sourceSnapshot: [{ path: ENTRYPOINT, bytes }],
    props: {},
    ...overrides,
  });
  if (!created.ok) {
    throw created.error;
  }
  return created.value;
}
