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
 * ## It answers with a value, and declares no `returns`
 *
 * Each admitted observation's own value, in invocation order, with whatever the
 * fragment rendered beside them under `output` — not the rendered output alone,
 * which for an uncaptured `<Fetch>` is empty. It binds by reference under `as`,
 * unchecked, so nothing about the value is rewritten on the way to the document;
 * a document turns it into text where it wants text, with `<Json>`. `as="observation"` captures and suppresses it exactly as it does for
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
import { componentClaim, durableIdentityOf, pinnedFileRead } from "@executablemd/core/host";
import type {
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedRequest,
} from "@executablemd/core/host";
import type { ComponentInvocation } from "@executablemd/core";
import type { ComponentClaim } from "@executablemd/core/host";
import { ephemeral } from "@executablemd/durable-streams";
import type { Json, Workflow } from "@executablemd/durable-streams";
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
 * What the document reads back: a detached value, not text.
 *
 * The observations' own values, in the order the fragment invoked them, with
 * whatever the fragment rendered kept beside them under `output`. An admitted
 * `<Fetch>` written without a binding renders nothing — a component returning a
 * non-string has nowhere to render — so a result taken from the rendered
 * fragment would answer the Agent's question with an empty string.
 *
 * A value rather than a serialization, because deciding how a value becomes text
 * is the document's to make and it has `<Json>` to make it with. The pinned
 * identity each observation ran under stays on the host-facing result and out of
 * this one: it says which implementation the host admitted, which is a fact about
 * the run rather than something the next prompt is answering.
 */
function observationValue(result: GeneratedObservationResult): Json {
  return {
    observations: result.observations.map((observation) => ({
      name: observation.name,
      value: observation.value,
    })),
    output: result.output,
  };
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

/**
 * The implementation, without the registration.
 *
 * Local: the identity it names its durable operation after is taken from the
 * capability the engine mints, so there is no calling this outside an
 * invocation, and no suite that would want to.
 */
type EvaluateComponent = (
  props: Record<string, Json>,
  invocation: ComponentInvocation,
) => Workflow<Json>;

function createEvaluate(
  database: WorkflowRunDatabase,
  options: GeneratedEvaluationOptions,
  claim: ComponentClaim,
): EvaluateComponent {
  // Copied at construction. What the host stated then is what every later
  // invocation is bounded by, whatever happens to the object it passed.
  const requests: GeneratedRequest[] = [...(options.requests ?? [])];
  const components: GeneratedObservation[] = [...(options.components ?? [])];

  return function* Evaluate(
    elementProps: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Workflow<Json> {
    if (yield* ephemeral(hasContent())) {
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
    // Taken from the capability the engine minted for this invocation, not read
    // from anywhere. Every other channel is composable: `getExpansion()` reads a
    // Context, which is addressed by name and which a loaded component may bind
    // for its descendants; a contextual Api handler an ancestor installed
    // answers ahead of the engine's own; and `importComponent` middleware may
    // wrap this implementation and call it with an argument of its own —
    // measured, not assumed. Any of them would let two `<Evaluate>` sites share
    // one durable name and each replay the other's admitted fragment.
    //
    // Claimed in this attachment's own domain, so an implementation kept from a
    // real `<Evaluate>` site and called from an invocation of something else
    // names nothing: that element's issuance belongs to another component.
    const id = durableIdentityOf(invocation, claim);

    // Wrapped where the work is not journaled: reading the element's shape and
    // reading the run's current roots are both ordinary operations, and only the
    // admission below belongs in the run's history.
    const selection = yield* ephemeral(workspaceRootSelection(database));

    const policy: GeneratedObservationPolicy = {
      workspaceRoots: selection.roots,
      selectedRoot: selection.current,
      requests,
      components: [pinnedFileRead(), ...components],
    };
    const result = yield* observeGeneratedXmd(id, source, policy);
    return observationValue(result);
  };
}

export function useGeneratedEvaluation(
  database: WorkflowRunDatabase,
  options: GeneratedEvaluationOptions = {},
): Operation<void> {
  // One domain per attachment, minted here, closed over by the implementation
  // and attached to the registration the engine resolves.
  const claim = componentClaim();
  return registerComponents([
    {
      name: "Evaluate",
      origin: ORIGIN,
      props,
      claim,
      fn: createEvaluate(database, options, claim),
    },
  ]);
}
