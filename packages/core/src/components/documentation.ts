/**
 * What a component says about itself, for a reader rather than for the engine.
 *
 * These three fields are descriptive only. They take no part in expansion,
 * resolution, validation, authority or the journal, and a component that states
 * none of them behaves exactly as it always has. `xmd syntax` prints them; a
 * document run never reads them.
 */

/** Prose a registration or execution declaration carries. Every field optional. */
export interface ComponentDocumentation {
  /** What the component is for, in a sentence a reader can act on. */
  readonly description?: string;
  /** What binding the component's `as` prop produces. */
  readonly as?: string;
  /** What the content written between the tags means to this component. */
  readonly context?: string;
}

/**
 * The same prose, as a first-party declaration is required to state it.
 *
 * `as` and `context` are `string | null` rather than optional, so a first-party
 * declaration decides whether each one applies instead of leaving an omitted
 * field to mean either "not applicable" or "forgotten". `null` is the explicit
 * "this component takes no binding" / "this component reads no content", and it
 * contributes no field to the public catalog.
 *
 * The public registration contract stays the optional strings above: this is
 * the discipline first-party packages hold themselves to, not a rule imposed on
 * anybody who registers a component.
 */
export interface FirstPartyDocumentation {
  readonly description: string;
  readonly as: string | null;
  readonly context: string | null;
}

/** The optional-field spelling of an explicit first-party decision. */
export function documented(documentation: FirstPartyDocumentation): ComponentDocumentation {
  const { description, as, context } = documentation;
  return {
    description,
    ...(as === null ? {} : { as }),
    ...(context === null ? {} : { context }),
  };
}

/**
 * The prose a declaration states, keeping only the fields that are strings.
 *
 * Read rather than asserted, because one caller is Markdown frontmatter: a
 * document's meta is whatever its author wrote, and a `description:` holding a
 * list is still that document's metadata rather than a validation failure. A
 * value that is not a string is left where it was and documents nothing.
 */
export function documentationOf(source: object): ComponentDocumentation {
  const description = Reflect.get(source, "description");
  const as = Reflect.get(source, "as");
  const context = Reflect.get(source, "context");
  return {
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof as === "string" ? { as } : {}),
    ...(typeof context === "string" ? { context } : {}),
  };
}
