/**
 * The structural constructs (spec §5.3).
 *
 * These names are the language's own syntax, not components. The expansion loop
 * handles each one directly, so none of them reaches component resolution: a
 * repository file cannot supply them and a registration cannot claim them.
 *
 * The table below is the single place that decides which names are reserved,
 * and it carries the documentation `xmd syntax` prints beside each one.
 * Resolution consults the derived set first, and registration rejects anything
 * in it.
 */

/**
 * One construct, as both a reservation and a description of itself.
 *
 * `syntax` holds the canonical authored forms — documentation a reader copies,
 * not a grammar anything parses. Optional props stay in `description` rather
 * than multiplying the examples.
 *
 * `as` and `context` are decided rather than omitted: `null` states that the
 * construct takes no binding, or reads no content, so a missing sentence is a
 * fact about the construct instead of an unfinished entry.
 */
export interface StructuralDeclaration {
  readonly name: string;
  readonly syntax: readonly string[];
  readonly description: string;
  /** What `as` binds here, or `null` when the construct takes no `as`. */
  readonly as: string | null;
  /** What the construct's content means, or `null` when it reads none. */
  readonly context: string | null;
}

export const STRUCTURAL_DECLARATIONS: readonly StructuralDeclaration[] = [
  {
    name: "Content",
    syntax: ["<Content />", '<Content slot="name" />'],
    description:
      "Renders the content the caller wrote at the invocation site. Without a slot it renders " +
      "everything the caller passed; `slot` selects one named partition of it.",
    as: null,
    context: null,
  },
  {
    name: "Output",
    syntax: ["<Output>…</Output>"],
    description:
      "Declares the region a document or component presents as its output. Everything outside " +
      "the region is working detail the reader of a run never sees.",
    as: null,
    context: "The rendered output the run presents.",
  },
  {
    name: "Return",
    syntax: ["<Return value={value} />"],
    description:
      "Returns a value from a component that declares a `returns` schema, instead of returning " +
      "its rendered markdown. The value is validated against that schema.",
    as: null,
    context: null,
  },
  {
    name: "Let",
    syntax: ['<Let as="name">…</Let>', '<Let as="name" value={value} />'],
    description:
      "Binds a name for the rest of the enclosing region. The paired form binds what its " +
      "content rendered; `value` binds the exact value its expression produced, by reference. " +
      "An optional `select` prop narrows rendered content to one CSS selection.",
    as: "Required. The binding name the value is available under.",
    context: "Markdown whose rendered text becomes the binding, in the paired form.",
  },
  {
    name: "Each",
    syntax: ['<Each in={items} let="item">…</Each>'],
    description:
      "Renders its content once per element of an array, with the element bound to the name " +
      "`let` states.",
    as: "Optional. Captures the whole rendered loop instead of emitting it.",
    context: "Markdown rendered once per element.",
  },
  {
    name: "If",
    syntax: ["<If condition={condition}>…</If>"],
    description:
      "Expands one branch of a document. Only the selected branch expands, so the other runs " +
      "nothing at all.",
    as: null,
    context: "The branch taken when the condition holds, up to an `<Else>`.",
  },
  {
    name: "Else",
    syntax: ["<Else>…</Else>"],
    description:
      "The alternative branch of the `<If>` it is written directly inside. Written anywhere " +
      "else it names no component and is a printed error.",
    as: null,
    context: "The branch taken when the enclosing condition does not hold.",
  },
  {
    name: "Loop",
    syntax: ["<Loop max={count}>…</Loop>"],
    description:
      "Expands its content more than once, under the bound `max` states. The bound is required " +
      "and must be a positive integer — there is no unbounded form. An optional `name` prop " +
      "labels the loop diagnostically.",
    as: null,
    context: "Markdown expanded once per iteration.",
  },
  {
    name: "Break",
    syntax: ["<Break />"],
    description:
      "Ends the nearest enclosing `<Loop>`. The rest of the current iteration does not expand, " +
      "so it imports nothing, runs no block and writes no journal entry.",
    as: null,
    context: null,
  },
  {
    name: "PrintErrors",
    syntax: ["<PrintErrors>…</PrintErrors>"],
    description:
      "Prints the failures its content produces as error segments instead of failing the " +
      "document, so a region can report what went wrong and carry on.",
    as: null,
    context: "The region whose failures are printed rather than raised.",
  },
  {
    name: "Answers",
    syntax: ["<Answers>…</Answers>"],
    description:
      "Answers the elicitations its content performs from the `<Answer>` matchers declared " +
      "inside it, so a region never stops for a person. An optional `delegate` boolean passes " +
      "an unmatched elicitation outward instead of failing it.",
    as: null,
    context: "`<Answer>` matchers, and the body they answer for.",
  },
  {
    name: "Answer",
    syntax: ['<Answer template="text" value={value} />', "<Answer value={value}>…</Answer>"],
    description:
      "One matcher inside an `<Answers>` region. `template` matches the whole rendered message " +
      "— literal text constrains it, `{?name}` matches any text — and `value` is the answer. " +
      "The first declared matching answer wins, and a matcher answers as often as it matches.",
    as: null,
    context: "A multiline template, in place of the single-line `template` prop.",
  },
];

/**
 * The names the engine owns, derived from the declarations above so a construct
 * cannot be reserved without also describing itself.
 */
export const RESERVED_STRUCTURAL: ReadonlySet<string> = new Set(
  STRUCTURAL_DECLARATIONS.map((declaration) => declaration.name),
);

export function isStructural(name: string): boolean {
  return RESERVED_STRUCTURAL.has(name);
}

/**
 * The prop each construct binds by reference rather than as data.
 *
 * `<Let value>` binds the exact value its expression produced (spec §6.5).
 * Resolving that prop to JSON while scanning would be a projection like any
 * other: it turns `undefined` into `null`, and JSON has no shape for a
 * function, a class instance or a cycle. The authored expression is kept
 * instead, and evaluated where the by-reference contract holds.
 */
const REFERENCE_PROPS: ReadonlyMap<string, string> = new Map([["Let", "value"]]);

/** Whether this prop is authored text a construct evaluates for itself. */
export function bindsByReference(componentName: string, propName: string): boolean {
  return REFERENCE_PROPS.get(componentName) === propName;
}
