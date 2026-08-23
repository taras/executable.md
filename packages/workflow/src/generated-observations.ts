/**
 * The slice-1 policy a workflow run admits generated observations under
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * Core owns the mechanics: parsing the candidate fragment, preflighting all of
 * it before the first effect, invoking exactly the pinned identities it was
 * given, and recording one durable admission before any observation runs. What
 * core does *not* own is which ceilings a workflow run is willing to state, and
 * that is this module.
 *
 * Three of them are workflow concepts:
 *
 * - the retained Workspace roots a run has, and which one admitted observations
 *   address. A generated fragment cannot add a root, and a run cannot select one
 *   it never retained — so the selection is checked here, before the fragment is
 *   read at all;
 * - the exact HTTP reads a fragment may perform. An empty ceiling admits no
 *   `<Fetch>` whatsoever: the pinned identity simply is not on the allowlist,
 *   which is a different thing from admitting it and refusing every request; and
 *
 * - the host observation components this run adds beyond core's own.
 *
 * The policy is a value the trusted host holds and passes. Nothing here reads a
 * context, a registration, or the document, so no middleware and no generated
 * name can widen what a run agreed to.
 */

import { evaluateGeneratedXmd, pinnedFetch } from "@executablemd/core/host";
import type {
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedRequest,
} from "@executablemd/core/host";
import type { Workflow } from "@executablemd/durable-streams";

/** A generated fragment this run will not admit under its own ceilings. */
export class GeneratedObservationPolicyError extends Error {
  override name = "GeneratedObservationPolicyError";
}

/** What one workflow run is willing to admit a generated fragment under. */
export interface GeneratedObservationPolicy {
  /** The retained Workspace roots this run has. */
  readonly workspaceRoots: readonly string[];
  /** The one retained root admitted observations address. */
  readonly selectedRoot: string;
  /** The exact HTTP reads a fragment may perform. Empty admits `<Fetch>` not at all. */
  readonly requests: readonly GeneratedRequest[];
  /** Host observation components this run adds beside core's pinned identities. */
  readonly components?: readonly GeneratedObservation[];
}

/** The pinned identities one policy resolves to, in the order a run states them. */
function observations(policy: GeneratedObservationPolicy): GeneratedObservation[] {
  const admitted: GeneratedObservation[] = [...(policy.components ?? [])];
  if (policy.requests.length > 0) {
    admitted.push(pinnedFetch(policy.requests));
  }
  return admitted;
}

/**
 * Admit one generated fragment under this run's ceilings and perform what it
 * asks for, answering with what the admitted observations produced.
 *
 * The values rather than the rendering: an admitted `<Fetch>` written without a
 * binding renders nothing at all, and a result taken from the rendered fragment
 * would answer the Agent's question with an empty string.
 *
 * The root selection is decided before the candidate is read, because a run
 * that cannot say which retained root an observation addresses has no ceiling
 * to admit anything under — and a refusal there must cost no parse, no
 * observation, and no durable record.
 */
export function* observeGeneratedXmd(
  id: string,
  source: string,
  policy: GeneratedObservationPolicy,
): Workflow<GeneratedObservationResult> {
  const retained = new Set(policy.workspaceRoots);
  if (retained.size !== policy.workspaceRoots.length) {
    throw new GeneratedObservationPolicyError(
      "a generated-observation policy named one retained Workspace root twice.",
    );
  }
  if (!retained.has(policy.selectedRoot)) {
    throw new GeneratedObservationPolicyError(
      "a generated-observation policy selected a Workspace root this run did not retain.",
    );
  }
  return yield* evaluateGeneratedXmd({
    id,
    source,
    workspaceRoots: [...policy.workspaceRoots],
    selectedRoot: policy.selectedRoot,
    observations: observations(policy),
  });
}
