/**
 * The policy a workflow run admits generated XMD under
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * Core owns the mechanics: parsing the candidate fragment, preflighting all of
 * it before the first effect, resolving each name and authored form to exactly
 * one pinned identity, invoking only those, and recording one durable admission
 * before the first generated effect. What core does *not* own is which ceilings
 * a workflow run is willing to state, and that is this module.
 *
 * Four of them are workflow concepts:
 *
 * - the retained Workspace roots a run has, and which one admitted effects
 *   address. The list is the run's current immutable retained set and the
 *   selected root is the authoritative live root, a member of that set; a
 *   generated fragment cannot supply, add, or select either — so the selection
 *   is checked here, before the fragment is read at all. On a continuation the
 *   admission's root basis is held by membership: the run's own progress may
 *   have retained further roots and advanced the current one, while every
 *   non-root term is held exactly;
 * - the exact HTTP reads a fragment may perform. An empty ceiling admits no
 *   `<Fetch>` whatsoever: the pinned identity simply is not on the allowlist,
 *   which is a different thing from admitting it and refusing every request;
 * - the read identities this run adds beyond core's own; and
 * - the mutation identities this run is willing to expose at all. They are
 *   stated whether or not a caller asks for them, because what selects them is
 *   the caller's `allow`, and a class a run has no table for is refused before
 *   the candidate is parsed.
 *
 * The policy is a value the trusted host holds and passes. Nothing here reads a
 * context, a registration, or the document, so no middleware and no generated
 * name can widen what a run agreed to.
 */

import { evaluateGeneratedXmd, pinnedFetch } from "@executablemd/core/host";
import type {
  GeneratedEffectClass,
  GeneratedMutation,
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedRequest,
} from "@executablemd/core/host";
import type { SourcePosition } from "@executablemd/core";
import type { Operation } from "effection";

/** A generated fragment this run will not admit under its own ceilings. */
export class GeneratedEvaluationPolicyError extends Error {
  override name = "GeneratedEvaluationPolicyError";
}

/** What one workflow run is willing to admit a generated fragment under. */
export interface GeneratedEvaluationPolicy {
  /** The retained Workspace roots this run has. */
  readonly workspaceRoots: readonly string[];
  /** The one retained root admitted effects address. */
  readonly selectedRoot: string;
  /** The exact HTTP reads a fragment may perform. Empty admits `<Fetch>` not at all. */
  readonly requests: readonly GeneratedRequest[];
  /** The read identities this run states, beside the bounded `<Fetch>` below. */
  readonly reads: readonly GeneratedObservation[];
  /** The mutation identities this run states. Absent admits `write` not at all. */
  readonly writes?: readonly GeneratedMutation[];
  /** The classes the caller selected. Omitted means `read`, as core's own default does. */
  readonly allow?: readonly GeneratedEffectClass[];
}

/** The read identities one policy resolves to, in the order a run states them. */
function reads(policy: GeneratedEvaluationPolicy): GeneratedObservation[] {
  const admitted: GeneratedObservation[] = [...policy.reads];
  if (policy.requests.length > 0) {
    admitted.push(pinnedFetch(policy.requests));
  }
  return admitted;
}

/**
 * Admit one generated fragment under this run's ceilings and perform what it
 * asks for, answering with what the admitted reads produced.
 *
 * The values rather than the rendering: an admitted `<Fetch>` written without a
 * binding renders nothing at all, and a result taken from the rendered fragment
 * would answer the Agent's question with an empty string. An admitted mutation
 * contributes nothing here — its own durable effect is the account of it.
 *
 * The root selection is decided before the candidate is read, because a run
 * that cannot say which retained root an effect addresses has no ceiling to
 * admit anything under — and a refusal there must cost no parse, no effect,
 * and no durable record.
 */
export function* evaluateGeneratedFragment(
  id: string,
  source: string,
  policy: GeneratedEvaluationPolicy,
  position?: Readonly<SourcePosition>,
): Operation<GeneratedObservationResult> {
  const retained = new Set(policy.workspaceRoots);
  if (retained.size !== policy.workspaceRoots.length) {
    throw new GeneratedEvaluationPolicyError(
      "a generated-evaluation policy named one retained Workspace root twice.",
    );
  }
  if (!retained.has(policy.selectedRoot)) {
    throw new GeneratedEvaluationPolicyError(
      "a generated-evaluation policy selected a Workspace root this run did not retain.",
    );
  }
  return yield* evaluateGeneratedXmd({
    id,
    source,
    workspaceRoots: [...policy.workspaceRoots],
    selectedRoot: policy.selectedRoot,
    observations: reads(policy),
    ...(policy.writes === undefined ? {} : { mutations: [...policy.writes] }),
    ...(policy.allow === undefined ? {} : { allow: [...policy.allow] }),
    ...(position === undefined ? {} : { position }),
  });
}
