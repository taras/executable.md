/**
 * `<Evaluate source={…} />` — the workflow host's generated-XMD boundary
 * (specs/workflow-workspace-spec.md §8.4).
 *
 * An Agent proposes an observation by returning a fragment of Executable
 * Markdown. This is the operation an authored workflow uses to have that
 * fragment admitted and performed. It is an ordinary registered function
 * component, not a new execution primitive: the document writes it where it
 * wants the observation to happen, and everything else about the loop —
 * `<Loop>`, `<Parse>`, `<If>`, `<Break>` — is Markdown the reader can audit.
 *
 * ## Registration is availability, not authority
 *
 * Being registered is what makes this operation *reachable* from a trusted
 * workflow document. It carries none of the authority the operation exercises.
 * Every ceiling comes from values captured here, when the host installs the
 * component and before any document exists:
 *
 * - the retained Workspace roots and the run's authoritative current root come
 *   from the captured run storage, read at invocation;
 * - the read-only `<File>` observation comes from core's pinned constructor;
 * - `<Fetch>` is admitted only when the captured request ceiling is non-empty;
 *   and
 * - any further observation comes from the captured host option.
 *
 * No prop, binding, context, contextual API answer, middleware return value or
 * generated name supplies or widens any of them. The schema is closed and holds
 * exactly one required string prop, and paired content is refused — a `source`
 * this element rendered rather than received would be a fragment nobody handed
 * it.
 *
 * A repository component named `Evaluate` shadows this default, exactly as it
 * shadows any other. That can change what a trusted workflow document does; it
 * cannot recover the closure this registration holds. Agent-generated source
 * never resolves through here at all: the evaluator resolves only its own closed
 * table of pinned identities.
 *
 * ## It declares no `returns`
 *
 * What it answers with is deterministic JSON text carrying each admitted
 * observation's own value — not the fragment's rendered output, which for an
 * uncaptured `<Fetch>` is empty. It renders where it is written. `as="observation"` captures and suppresses it exactly as it does for
 * any other component, which is how a document renders the result into the next
 * `<Prompt>` in the same session.
 *
 * It is deliberately **not** wrapped in `printErrors`. A refused or failed
 * observation must stop the authored loop unless the document puts a recovery
 * boundary around it: returning a refusal as observation text would leave the
 * Agent reasoning from a read that never happened.
 */

import type { Operation } from "effection";
import { hasContent, registerComponents } from "@executablemd/core";
import { pinnedFileRead } from "@executablemd/core/host";
import type {
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedRequest,
} from "@executablemd/core/host";
import type { ComponentInvocation } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import {
  observeGeneratedXmd,
  type GeneratedObservationPolicy,
} from "../../generated-observations.ts";
import { workspaceRootSelection } from "./effect.ts";

const ORIGIN = "@executablemd/workflow/generated";

/** The whole schema: one required string, and nothing else accepted. */
export const props = {
  type: "object",
  properties: {
    source: { type: "string" },
  },
  required: ["source"],
  additionalProperties: false,
};

/**
 * What the document reads back, as text it can render into the next `<Prompt>`.
 *
 * The observations' own values, in the order the fragment invoked them, with
 * whatever the fragment rendered kept beside them. An admitted `<Fetch>` written
 * without a binding renders nothing — a component returning a non-string has
 * nowhere to render — so a result taken from the rendered fragment would answer
 * the Agent's question with an empty string.
 *
 * Deterministic JSON, because the next thing that happens to it is that a
 * document interpolates it into a prompt, and an Agent reading its own previous
 * observation should read the same shape every time.
 */
function observationText(result: GeneratedObservationResult): string {
  return JSON.stringify(
    {
      observations: result.observations.map((observation) => ({
        name: observation.name,
        value: observation.value,
      })),
      rendered: result.rendered,
    },
    undefined,
    2,
  );
}

/** A generated fragment offered to this host in a form it does not take. */
export class GeneratedEvaluationError extends Error {
  override name = "GeneratedEvaluationError";
}

/**
 * What a host may configure about generated evaluation.
 *
 * Adapter-private values, supplied before the document runs. Production may
 * supply neither, which admits exactly the read-only `<File>` identity.
 */
export interface GeneratedEvaluationOptions {
  /**
   * The exact HTTP reads an admitted fragment may perform.
   *
   * Empty admits `<Fetch>` not at all — the pinned identity is simply not on the
   * allowlist, which is a different thing from admitting it and refusing every
   * request.
   */
  readonly requests?: readonly GeneratedRequest[];
  /** Further observation components this host admits beside core's pinned ones. */
  readonly components?: readonly GeneratedObservation[];
}

export function useGeneratedEvaluation(
  database: WorkflowRunDatabase,
  options: GeneratedEvaluationOptions = {},
): Operation<void> {
  // Copied at installation. What the host stated then is what every later
  // invocation is bounded by, whatever happens to the object it passed.
  const requests: GeneratedRequest[] = [...(options.requests ?? [])];
  const components: GeneratedObservation[] = [...(options.components ?? [])];

  function* Evaluate(
    elementProps: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<string> {
    if (yield* hasContent()) {
      throw new GeneratedEvaluationError(
        "<Evaluate> takes the generated source as its `source` prop and renders no content of " +
          "its own. Write it self-closing.",
      );
    }
    const source = elementProps.source;
    if (typeof source !== "string") {
      throw new GeneratedEvaluationError("<Evaluate> requires a `source` string to evaluate.");
    }

    // The durable identity of this observation is this element's own invocation,
    // so a replay restores the fragment this position admitted rather than
    // whichever one a later turn happens to be holding.
    //
    // Handed by the engine at the call site, not read from anywhere. Both
    // other channels are composable: `getExpansion()` reads a Context, which is
    // addressed by name and which a loaded component may bind for its
    // descendants, and a contextual Api handler an ancestor installed answers
    // ahead of the engine's own — measured, not assumed. Either would let two
    // `<Evaluate>` sites share one durable name and each replay the other's
    // admitted fragment.
    const id = invocation.id;
    const selection = yield* workspaceRootSelection(database);

    const policy: GeneratedObservationPolicy = {
      workspaceRoots: selection.roots,
      selectedRoot: selection.current,
      requests,
      components: [pinnedFileRead(), ...components],
    };
    const result = yield* observeGeneratedXmd(id, source, policy);
    return observationText(result);
  }

  return registerComponents([{ name: "Evaluate", origin: ORIGIN, props, fn: Evaluate }]);
}
