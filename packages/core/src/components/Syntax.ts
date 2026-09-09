/**
 * `<Syntax />` — what a document may write, written into the document.
 *
 * An author asking "which components do I have here?" and an agent being told
 * what to write are the same question, and `xmd syntax` already answers it from
 * outside. This is the same answer from inside: the symbols for the site the
 * element was written at, as the Markdown that command prints.
 *
 * ## Why canonical core owns it
 *
 * The symbols describe the vocabulary an execution actually has. A repository
 * `Syntax.md`, a bundled `Syntax`, a registration, an import handler or a second
 * loaded copy answering for the name would each describe a vocabulary the run
 * does not have — to whoever is reading, and to whichever agent is being told
 * what to write next. So the name is claimed by the canonical protected tier,
 * ahead of every host and author tier, and the definition canonical core
 * selected is what runs.
 *
 * Protection is about the *answer*, not about power. The component receives one
 * reference that renders symbol text and nothing else: no definitions, no
 * import witness, no invocation capability, no policy table, no provider and no
 * registration handle. Naming a component in the symbols is not permission to
 * run it.
 *
 * ## What one occurrence does
 *
 * It claims the occurrence identity this execution minted, renders once, and
 * retains exactly what it rendered. A continuation reads that record and hands
 * the same text back without consulting the filesystem, the registry, the
 * bundle, the host or the lexical reference again — so an agent resuming
 * authorship is shown the vocabulary the run actually showed it, not one
 * rebuilt from a tree that has moved since.
 */

import { createDurableOperation, StaleInputError } from "@executablemd/durable-streams";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { getExpansion } from "../expansion.ts";
import { markGeneratedRequestRefusal } from "../generated-request-refusal.ts";
import { SyntaxSelectionRefusal } from "../syntax-refusal.ts";
import { ComponentInvocationError, invocationForm } from "../invocation-identity.ts";
import type {
  ComponentInvocation,
  IdentityClaimant,
  ProtectedBody,
  ProtectedSite,
} from "../invocation-identity.ts";
import { sourceDescription } from "../source-position.ts";
import type { ProtectedComponent } from "./protected.ts";
import { CORE_ORIGIN } from "./registry.ts";
import { documented } from "./documentation.ts";
import type { Json, PropsSchema, SourcePosition } from "../types.ts";

/** The public name canonical core claims for the syntax component. */
export const SYNTAX_COMPONENT = "Syntax";

/** The durable effect one occurrence records. */
const SYNTAX_SYMBOLS = "syntax_symbols";

/**
 * One optional prop, closed.
 *
 * The site decides what the symbols say; `names` decides only whether the
 * occurrence renders the list or the selected documentation. Any other prop is
 * refused before the body runs, which is what keeps a spelling nobody supports
 * from quietly rendering every symbol anyway.
 */
export const props: PropsSchema = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      uniqueItems: true,
      description:
        "Optional. Render these components' metadata and long-form documentation " +
        "instead of the list of available symbols. Entries render once each, in symbol order.",
    },
  },
  additionalProperties: false,
};

const PAIRED_REFUSAL =
  "<Syntax /> renders the available symbols and reads no content, so it is written self-closing.";

const NAMES_REFUSAL =
  "<Syntax names={…}> takes a non-empty list of component names, each a string.";

const DUPLICATE_REFUSAL =
  "<Syntax names={…}> takes each component name once: an entry renders once however " +
  "many times it is asked for.";

const UNISSUED_REFUSAL =
  "<Syntax /> is invoked by canonical core; this is not an invocation the engine issued.";

const NO_REFERENCE_REFUSAL =
  "<Syntax /> has no symbols to read here: this expansion carries no syntax reference, so " +
  "nothing established what a document may write at this site.";

const UNREADABLE_RECORD =
  "the retained <Syntax /> text is not a record this version can read, so no symbols were " +
  "produced.";

/**
 * The declaration canonical core selects for `<Syntax>`.
 *
 * Self-closing only, one optional prop, and no `returns` — which is what makes
 * it a text component: it emits through the current presentation middleware,
 * and `as` captures the same text through the engine's ordinary capture and
 * emits nothing.
 */
export const SYNTAX_PROTECTED: ProtectedComponent = {
  name: SYNTAX_COMPONENT,
  origin: CORE_ORIGIN,
  props,
  forms: ["self-closing"],
  ...documented({
    description:
      "Inspect available components and control-flow constructs. `<Syntax />` lists the " +
      'symbols available here; `<Syntax names={["Elicit"]} />` renders selected documentation.',
    as: "Optional. Captures the rendered text instead of emitting it.",
    context: null,
  }),
  build: (claim: IdentityClaimant) => syntax(claim),
};

function syntax(claim: IdentityClaimant): ProtectedBody {
  return function* renderSyntax(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
    site: ProtectedSite,
  ): Operation<string> {
    const reference = site.syntax;
    // Read off the issuance the engine holds rather than off a method the
    // caller could have written, and answered before anything is claimed or
    // rendered: a paired spelling is a document asking for something this
    // component does not have, not symbols to go and build.
    const form = invocationForm(invocation);
    if (form === undefined) {
      throw new ComponentInvocationError(UNISSUED_REFUSAL);
    }
    if (form === "paired") {
      throw markGeneratedRequestRefusal(
        new ComponentInvocationError(PAIRED_REFUSAL),
        PAIRED_REFUSAL,
      );
    }
    // Read before anything is claimed or rendered, so a list this component
    // cannot answer for refuses with no durable record and no partial text.
    // The schema has already rejected an empty list, a duplicate and a
    // non-string member; what is left is whether the value is the array shape
    // this reads, because a protected body is handed props rather than trusting
    // that somebody validated them.
    const names = requestedNames(props.names);
    const id = yield* claim(invocation);
    if (reference === undefined) {
      throw new Error(NO_REFERENCE_REFUSAL);
    }
    const expansion = yield* getExpansion();
    // A refusal is *retained*, not signalled out of band. Core's own selection
    // refusal becomes a value the record distinguishes, so it is read back the
    // same way on a live run and on a replay; a provider that throws is not
    // caught here at all and fails the operation, which is what keeps it
    // terminal whatever it names its error.
    return yield* persistSymbols(id, expansion.position, function* () {
      try {
        return {
          symbols:
            names === undefined
              ? yield* reference.symbols()
              : yield* reference.documentation(names),
        };
      } catch (error) {
        if (error instanceof SyntaxSelectionRefusal) {
          return { refused: error.message };
        }
        throw error;
      }
    });
  };
}

/**
 * The names this occurrence asked to document, or nothing for the bare form.
 *
 * The declared schema is the first gate and rejects an empty list, a duplicate
 * and a non-string member before the body is entered. This is the second, and it
 * exists because a body is handed a props object rather than a promise that one
 * was checked: a value that is not the shape this reads is refused here rather
 * than becoming an empty selection that renders every symbol.
 */
function requestedNames(value: Json | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ComponentInvocationError(NAMES_REFUSAL);
  }
  const names: string[] = [];
  for (const member of value) {
    if (typeof member !== "string" || member.length === 0) {
      throw markGeneratedRequestRefusal(new ComponentInvocationError(NAMES_REFUSAL), NAMES_REFUSAL);
    }
    if (names.includes(member)) {
      throw markGeneratedRequestRefusal(
        new ComponentInvocationError(DUPLICATE_REFUSAL),
        DUPLICATE_REFUSAL,
      );
    }
    names.push(member);
  }
  return names;
}

/**
 * Retain what this occurrence answered, and read it back the same way whether
 * it just happened or happened in an earlier run.
 *
 * The interpretation is *after* the durable operation, deliberately. If
 * publication of the result fails — the append, the journal, the secret gate —
 * `createDurableOperation` throws and this line is never reached, so a run that
 * could not record the refusal does not act on it either. That failure is the
 * run ending, and it stays terminal.
 */
function* persistSymbols(
  id: string,
  position: Readonly<SourcePosition> | undefined,
  live: () => Operation<SyntaxRecord>,
): Workflow<string> {
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: SYNTAX_SYMBOLS,
      name: `${SYNTAX_SYMBOLS}:${id}`,
      ...sourceDescription(position),
    },
    function* (): Operation<DurableJson> {
      return { ...(yield* live()) };
    },
  );
  const record = readSyntaxRecord(stored);
  if (record === undefined) {
    // A record this version cannot read is the journal no longer describing
    // this run, not a component that failed: it travels as the stale input it
    // is, rather than becoming an error segment a printing boundary could turn
    // into text and carry on past.
    throw new StaleInputError(UNREADABLE_RECORD);
  }
  if ("refused" in record) {
    // Raised here rather than retained as an error, because a failure crossing
    // the durable boundary is rebuilt without its class and without any
    // non-enumerable property. Re-raising from the retained *value* is what
    // makes a replayed refusal identical to a live one.
    throw markGeneratedRequestRefusal(new SyntaxSelectionRefusal(record.refused), record.refused);
  }
  return record.symbols;
}

/**
 * What one occurrence answered: the rendered symbols, or core's own refusal of
 * the names it was given.
 *
 * Two alternatives rather than one, because the refusal has to survive replay
 * and an error does not. `{ symbols }` is unchanged, so every record an earlier
 * version wrote still reads as exactly what it meant.
 */
type SyntaxRecord = { readonly symbols: string } | { readonly refused: string };

/**
 * What a record holds, read as a closed protocol.
 *
 * Exactly one member, a string, under one of the two names this version knows.
 * A record missing it, carrying a member this version does not know, holding
 * both, or holding one of the wrong type is a record this version cannot read —
 * not one to fill a default in for, because every default here is a guess about
 * what an earlier run actually showed somebody.
 */
function readSyntaxRecord(value: unknown): SyntaxRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (Object.keys(value).length !== 1) {
    return undefined;
  }
  const symbols = Reflect.get(value, "symbols");
  if (typeof symbols === "string") {
    return { symbols };
  }
  const refused = Reflect.get(value, "refused");
  return typeof refused === "string" && refused.length > 0 ? { refused } : undefined;
}
