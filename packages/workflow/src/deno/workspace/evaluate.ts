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
 *   from the captured run storage, read at invocation. They are as-of-admission
 *   provenance rather than a frozen future ceiling: a continuation holds the
 *   admission's roots by membership, so the run's own later publications and an
 *   advanced retained current root change nothing the admission was granted
 *   under;
 * - the read-only `<File>` observation comes from core's pinned constructor;
 * - `<Fetch>` is admitted only when the captured request ceiling is non-empty;
 * - the write table is core's paired `<File>`, workflow's own lexical `<Dir>`
 *   built from the same definition the ordinary registration owns, and core's
 *   self-closing `<File.Delete>`; and
 * - any further read or write comes from the captured host option.
 *
 * No prop, binding, context, contextual API answer, middleware return value or
 * generated name supplies or widens any of them. The schema is closed on one
 * required string and one optional closed selection, and paired content is
 * refused — a `source` this element rendered rather than received would be a
 * fragment nobody handed it.
 *
 * ## `allow` narrows; it never grants
 *
 * `allow` names an effect *class*, and the class resolves to the table this
 * host installed before any document existed. Omitting it asks for `read`,
 * which is what this component has always done. Asking for `write` reaches
 * core's paired `<File>`, workflow's `<Dir>` and core's self-closing
 * `<File.Delete>` and nothing else — no Git, no Git host, no Issue, no process,
 * no credential — and a host that installed no write table refuses the
 * selection before the candidate is parsed.
 *
 * A deletion is admitted on the same terms as the other two, and accounted for
 * the same way: it invokes the ordinary component, crosses the run's existing
 * effect transaction, and is retained by the `workspace_file` effect that
 * transaction publishes. Nothing about it reaches the value below.
 *
 * `allow` and `as` are independent. `as` grants nothing: it is the ordinary
 * caller-owned binding for the value this component returns, and that value has
 * the same shape for every selection. An admitted write puts nothing in it.
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
import { hasContent } from "@executablemd/core";
import {
  pinnedFileDelete,
  pinnedFileRead,
  pinnedFileWrite,
  pinnedMutation,
} from "@executablemd/core/host";
import type {
  GeneratedEffectClass,
  GeneratedMutation,
  GeneratedObservation,
  GeneratedObservationResult,
  GeneratedRequest,
} from "@executablemd/core/host";
import type { ComponentInvocation } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import type { Json } from "@executablemd/durable-streams";
import type { FunctionComponent } from "@executablemd/core";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import {
  evaluateGeneratedFragment,
  type GeneratedEvaluationPolicy,
} from "../../generated-observations.ts";
import { COMPOSITION_ORIGIN, dirDefinition } from "../../composition/definitions.ts";
import { workspaceRootSelection } from "./effect.ts";

const ORIGIN = "@executablemd/workflow/generated";

/** The classes this component accepts, and the order a selection canonicalizes to. */
const EFFECT_CLASSES: readonly GeneratedEffectClass[] = ["read", "write"];

/**
 * The whole schema: one required string, one optional closed selection, and
 * nothing else accepted.
 *
 * `allow` narrows the host's already-installed policy and can do nothing else.
 * It names no identity, no root, no destination and no request — it says which
 * of the two tables this host captured before the document existed this
 * fragment may draw on, and omitting it asks for `read`.
 */
export const props = {
  type: "object",
  properties: {
    source: { type: "string" },
    allow: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: [...EFFECT_CLASSES] },
    },
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
 * Adapter-private values, supplied before the document runs. Every one of them
 * is additive: production may supply none, which is the standard profile below
 * and nothing else. A document prop supplies none of them.
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
  /** Further read components this host admits beside core's pinned ones. */
  readonly reads?: readonly GeneratedObservation[];
  /** Further mutation components this host admits beside the standard profile's. */
  readonly writes?: readonly GeneratedMutation[];
}

/**
 * The classes this element asked for, canonicalized.
 *
 * Parsed rather than read. The schema above already refuses everything but a
 * non-empty duplicate-free subset, and what this adds is the canonical order
 * the admission retains: two documents asking for the same two classes are
 * asking for the same thing, so authored order is not part of the policy a
 * continuation is held to.
 */
function requestedClasses(value: Json | undefined): readonly GeneratedEffectClass[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new GeneratedEvaluationError(
      "<Evaluate> takes `allow` as a non-empty array of effect classes.",
    );
  }
  const selected = new Set<GeneratedEffectClass>();
  for (const entry of value) {
    const effect = EFFECT_CLASSES.find((known) => known === entry);
    if (effect === undefined) {
      throw new GeneratedEvaluationError(
        "<Evaluate> admits the effect classes `read` and `write`, and nothing else.",
      );
    }
    if (selected.has(effect)) {
      throw new GeneratedEvaluationError("<Evaluate> takes each effect class in `allow` once.");
    }
    selected.add(effect);
  }
  return EFFECT_CLASSES.filter((effect) => selected.has(effect));
}

/**
 * The implementation, built from the claimant the execution delivered.
 *
 * Called once per attachment, by canonical execution, with the claimant it
 * minted for this component — and by nothing else. The claimant is the argument
 * of that call: it is closed over here and reachable from nowhere, so an
 * implementation kept from this attachment names nothing anywhere else.
 */
function createEvaluate(
  database: WorkflowRunDatabase,
  options: GeneratedEvaluationOptions,
  claim: IdentityClaimant,
): FunctionComponent {
  // Copied at construction. What the host stated then is what every later
  // invocation is bounded by, whatever happens to the object it passed.
  const requests: GeneratedRequest[] = [...(options.requests ?? [])];
  // The standard profile, captured with them. Core's read-only `<File>` is the
  // read table; core's paired `<File>`, workflow's own lexical `<Dir>` and
  // core's self-closing `<File.Delete>` are the write table, and the Dir
  // identity is built from the same definition the ordinary registration owns so
  // the two cannot drift. Both tables are stated whether or not a document asks
  // for the class — `allow` selects from what this host already installed, and
  // can add nothing to it.
  //
  // The order is the retained policy, so it is stated once and kept: a
  // continuation compares what it was granted under against what this profile
  // holds now, and a host extension arriving last is what keeps a profile that
  // took none comparable to itself.
  const dir = dirDefinition();
  const reads: GeneratedObservation[] = [pinnedFileRead(), ...(options.reads ?? [])];
  const writes: GeneratedMutation[] = [
    pinnedFileWrite(),
    pinnedMutation(dir.name, `${COMPOSITION_ORIGIN}#Dir`, dir, "paired"),
    pinnedFileDelete(),
    ...(options.writes ?? []),
  ];

  return function* Evaluate(
    elementProps: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<Json> {
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
    // Before the durable name is claimed and before the candidate is read: a
    // selection this host cannot state is not a fragment being refused.
    const allow = requestedClasses(elementProps.allow);

    // The durable identity of this observation is this element's own invocation,
    // so a replay restores the fragment this position admitted rather than
    // whichever one a later turn happens to be holding.
    //
    // Claimed here, in the frame the engine invoked this in and on the exact
    // invocation it was handed: the claimant answers only for an invocation this
    // execution minted where resolution selected this implementation, and for
    // nothing a handler substituted. It is read from no Context, no contextual
    // Api answer, no definition and no registry answer — every one of those is
    // composable, and any of them would let two `<Evaluate>` sites share one
    // durable name and each replay the other's admitted fragment.
    const id = yield* claim(invocation);

    // Read where the work is not journaled: the element's shape and the run's
    // current roots are both ordinary operations, and only the admission below
    // belongs in the run's history.
    const selection = yield* workspaceRootSelection(database);

    const policy: GeneratedEvaluationPolicy = {
      workspaceRoots: selection.roots,
      selectedRoot: selection.current,
      requests,
      reads,
      writes,
      ...(allow === undefined ? {} : { allow }),
    };
    return yield* admit(id, source, policy);
  };
}

/** The admission itself, and the only part of this that is journaled. */
function* admit(id: string, source: string, policy: GeneratedEvaluationPolicy): Operation<Json> {
  const result = yield* evaluateGeneratedFragment(id, source, policy);
  return observationValue(result);
}

/**
 * What a workflow host declares to the execution for one attachment.
 *
 * `<Evaluate>` is not registered with the rest of the workflow's components:
 * its implementation names durable work after its own invocation, so canonical
 * execution builds it from the claimant it minted (executable-mdx-spec §5.6). A
 * run whose host declares none has no `<Evaluate>` at all.
 */
export function evaluationComponents(
  database: WorkflowRunDatabase,
  options: GeneratedEvaluationOptions = {},
): readonly IdentityComponent[] {
  return [
    {
      name: "Evaluate",
      origin: ORIGIN,
      props,
      factory: (claim: IdentityClaimant) => createEvaluate(database, options, claim),
    },
  ];
}
