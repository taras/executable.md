/**
 * `<Syntax />` — what a document may write, written into the document.
 *
 * An author asking "which components do I have here?" and an agent being told
 * what to write are the same question, and `xmd syntax` already answers it from
 * outside. This is the same answer from inside: the catalog for the site the
 * element was written at, as the Markdown that command prints.
 *
 * ## Why canonical core owns it
 *
 * The catalog describes the vocabulary an execution actually has. A repository
 * `Syntax.md`, a bundled `Syntax`, a registration, an import handler or a second
 * loaded copy answering for the name would each describe a vocabulary the run
 * does not have — to whoever is reading, and to whichever agent is being told
 * what to write next. So the name is claimed by the canonical protected tier,
 * ahead of every host and author tier, and the definition canonical core
 * selected is what runs.
 *
 * Protection is about the *answer*, not about power. The component receives one
 * operation that observes catalog text and nothing else: no definitions, no
 * import witness, no invocation capability, no policy table, no provider and no
 * registration handle. A catalog naming a component is not permission to run it.
 *
 * ## What one occurrence does
 *
 * It claims the occurrence identity this execution minted, observes once, and
 * retains exactly what it observed. A continuation reads that record and hands
 * the same catalog back without consulting the filesystem, the registry, the
 * bundle, the host or the lexical observation again — so an agent resuming
 * authorship is shown the vocabulary the run actually showed it, not one
 * rebuilt from a tree that has moved since.
 */

import { createDurableOperation, StaleInputError } from "@executablemd/durable-streams";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { getExpansion } from "../expansion.ts";
import { ComponentInvocationError, invocationForm } from "../invocation-identity.ts";
import type {
  ComponentInvocation,
  IdentityClaimant,
  ProtectedBody,
} from "../invocation-identity.ts";
import { sourceDescription } from "../source-position.ts";
import type { CatalogObservation } from "../syntax-observation.ts";
import type { ProtectedComponent } from "./protected.ts";
import { CORE_ORIGIN } from "./registry.ts";
import { documented } from "./documentation.ts";
import type { Json, PropsSchema, SourcePosition } from "../types.ts";

/** The public name canonical core claims for the catalog component. */
export const SYNTAX_COMPONENT = "Syntax";

/** The durable effect one occurrence records. */
const SYNTAX_CATALOG = "syntax_catalog";

/**
 * No props at all, closed.
 *
 * The site decides what the catalog says; there is nothing for an author to
 * select. A prop written here is refused before the body runs, which is what
 * keeps a spelling nobody supports from quietly rendering the whole catalog
 * anyway.
 */
export const props: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const PAIRED_REFUSAL =
  "<Syntax /> renders the current catalog and reads no content, so it is written self-closing.";

const UNISSUED_REFUSAL =
  "<Syntax /> is invoked by canonical core; this is not an invocation the engine issued.";

const NO_OBSERVATION_REFUSAL =
  "<Syntax /> has no catalog to observe here: this expansion carries none, so nothing " +
  "established what a document may write at this site.";

const UNREADABLE_RECORD =
  "the retained <Syntax /> catalog is not a catalog this version can read, so no catalog was " +
  "produced.";

/**
 * The declaration canonical core selects for `<Syntax>`.
 *
 * Self-closing only, no props, and no `returns` — which is what makes it a text
 * component: the bare form emits the catalog through the current presentation
 * middleware, and `as` captures the same text through the engine's ordinary
 * capture and emits nothing.
 */
export const SYNTAX_PROTECTED: ProtectedComponent = {
  name: SYNTAX_COMPONENT,
  origin: CORE_ORIGIN,
  props,
  forms: ["self-closing"],
  ...documented({
    description:
      "Output available components and control flow constructs. `<Syntax />` renders the " +
      "current catalog.",
    as: "Optional. Captures the rendered catalog instead of emitting it.",
    context: null,
  }),
  build: (claim: IdentityClaimant) => syntax(claim),
};

function syntax(claim: IdentityClaimant): ProtectedBody {
  return function* observeCatalog(
    _props: Record<string, Json>,
    invocation: ComponentInvocation,
    observation: CatalogObservation | undefined,
  ): Operation<string> {
    // Read off the issuance the engine holds rather than off a method the
    // caller could have written, and answered before anything is claimed or
    // observed: a paired spelling is a document asking for something this
    // component does not have, not a catalog to go and build.
    const form = invocationForm(invocation);
    if (form === undefined) {
      throw new ComponentInvocationError(UNISSUED_REFUSAL);
    }
    if (form === "paired") {
      throw new ComponentInvocationError(PAIRED_REFUSAL);
    }
    const id = yield* claim(invocation);
    if (observation === undefined) {
      throw new Error(NO_OBSERVATION_REFUSAL);
    }
    const expansion = yield* getExpansion();
    return yield* persistCatalog(id, expansion.position, () => observation.observe());
  };
}

function* persistCatalog(
  id: string,
  position: Readonly<SourcePosition> | undefined,
  live: () => Operation<string>,
): Workflow<string> {
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: SYNTAX_CATALOG,
      name: `${SYNTAX_CATALOG}:${id}`,
      ...sourceDescription(position),
    },
    function* (): Operation<DurableJson> {
      return { catalog: yield* live() };
    },
  );
  const catalog = readCatalog(stored);
  if (catalog === undefined) {
    // A record this version cannot read is the journal no longer describing
    // this run, not a component that failed: it travels as the stale input it
    // is, rather than becoming an error segment a printing boundary could turn
    // into text and carry on past.
    throw new StaleInputError(UNREADABLE_RECORD);
  }
  return catalog;
}

/**
 * The catalog a record holds, read as a closed protocol.
 *
 * Exactly one member, a string. A record missing it, carrying a member this
 * version does not know, or holding one of the wrong type is a record this
 * version cannot read — not one to fill a default in for, because every default
 * here is a guess about what an earlier run actually showed somebody.
 */
function readCatalog(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const catalog = Reflect.get(value, "catalog");
  if (Object.keys(value).length !== 1 || typeof catalog !== "string") {
    return undefined;
  }
  return catalog;
}
