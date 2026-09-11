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
      "Render what the caller wrote inside this component. `<Content />` renders all of " +
      'it; `<Content slot="footer" />` renders just the part the caller marked ' +
      '`slot="footer"`.',
    as: null,
    context: null,
  },
  {
    name: "Output",
    syntax: ["<Output>…</Output>"],
    description:
      "Restrict what a document or component renders. `<Output>…</Output>` becomes its " +
      "entire output; anything outside the region is not rendered.",
    as: null,
    context: "The rendered output the run presents.",
  },
  {
    name: "Return",
    syntax: ["<Return value={value} />"],
    description:
      "Return a value instead of rendered markdown. `<Return value={result} />` hands the " +
      "value to the caller, checked against the component's declared `returns` schema.",
    as: null,
    context: null,
  },
  {
    name: "Let",
    syntax: ['<Let as="name">…</Let>', '<Let as="name" value={value} />'],
    description:
      'Bind a name for the rest of the region. `<Let as="plan">…</Let>` binds what its ' +
      'content rendered; `<Let as="plan" value={result} />` binds the value. `select` ' +
      "narrows the rendered content to one CSS selection.",
    as: "Required. The binding name the value is available under.",
    context: "Markdown whose rendered text becomes the binding, in the paired form.",
  },
  {
    name: "Each",
    syntax: ['<Each in={list} let="item">…</Each>'],
    description:
      "Repeat content for each item in an array. " +
      '`<Each in={list} let="item">…</Each>` binds each one to `item` inside.',
    as: "Optional. Captures the whole rendered loop instead of emitting it.",
    context: "Markdown rendered once per element.",
  },
  {
    name: "If",
    syntax: ["<If condition={condition}>…</If>"],
    description:
      "Expand content only when a condition is true. " +
      "`<If condition={ready}>…</If>` expands its content, or the `<Else>` branch " +
      "instead. The branch not taken never runs.",
    as: null,
    context: "The branch taken when the condition holds, up to an `<Else>`.",
  },
  {
    name: "Else",
    syntax: ["<Else>…</Else>"],
    description:
      "The branch `<If>` takes when its condition is false. `<Else>…</Else>` is written " +
      "directly inside an `<If>`, and is an error anywhere else.",
    as: null,
    context: "The branch taken when the enclosing condition does not hold.",
  },
  {
    name: "Switch",
    syntax: ["<Switch value={value}>…</Switch>"],
    description:
      "Choose one branch by comparing a value with `===`. " +
      '`<Switch value={status}><Case value="ready">…</Case><Case default>…</Case></Switch>` ' +
      "expands the first matching case, or the final default when none matches.",
    as: null,
    context: "Direct `<Case>` branches considered in source order.",
  },
  {
    name: "Case",
    syntax: ["<Case value={value}>…</Case>", "<Case default>…</Case>"],
    description:
      'Define one branch of a `<Switch>`. `<Case value="ready">…</Case>` matches with ' +
      "`===`; `<Case default>…</Case>` is the final fallback.",
    as: null,
    context: "Markdown expanded when this case is selected.",
  },
  {
    name: "Loop",
    syntax: ["<Loop max={count}>…</Loop>"],
    description:
      "Repeat content up to `max` times. `<Loop max={5}>…</Loop>` expands its content " +
      "again and again until a `<Break>` inside it, or until `max` is reached. `max` is " +
      "required.",
    as: null,
    context: "Markdown expanded once per iteration.",
  },
  {
    name: "Break",
    syntax: ["<Break />"],
    description:
      "Exit the nearest enclosing `<Loop>`. `<Break />` stops the current iteration " +
      "where it is; nothing after it in that iteration runs.",
    as: null,
    context: null,
  },
  {
    name: "PrintErrors",
    syntax: ["<PrintErrors>…</PrintErrors>"],
    description:
      "Convert thrown errors into output without failing. " +
      "`<PrintErrors>…</PrintErrors>` renders any failure inside it as part of the " +
      "output.",
    as: null,
    context: "The region whose failures are printed rather than raised.",
  },
  {
    name: "Answers",
    syntax: ["<Answers>…</Answers>"],
    description:
      "Answer any `<Elicit>` in its content without asking a person. " +
      "`<Answers>…</Answers>` replies from the `<Answer>` matchers declared inside it, " +
      "reaching elicitations from nested components too. `delegate` passes an unmatched " +
      "one outward instead of failing.",
    as: null,
    context: "`<Answer>` matchers, and the body they answer for.",
  },
  {
    name: "Answer",
    syntax: ['<Answer template="text" value={value} />', "<Answer value={value}>…</Answer>"],
    description:
      "Supply one answer inside `<Answers>`. " +
      '`<Answer template="Approve {?what}?" value={{ ok: true }} />` answers any ' +
      "elicitation its template matches — `{?name}` matches any text. The first " +
      "matching `<Answer>` wins.",
    as: null,
    context: "A multiline template, in place of the single-line `template` prop.",
  },
  {
    name: "Terminal.Grid",
    syntax: ["<Terminal.Grid columns={2}>…</Terminal.Grid>"],
    description:
      "Open several terminals in one view. " +
      '`<Terminal.Grid columns={2}><Terminal title="Agent">…</Terminal></Terminal.Grid>`',
    as: null,
    context: "The `<Terminal>` panes the grid lays out.",
  },
  {
    name: "Terminal",
    syntax: ['<Terminal title="Agent">…</Terminal>', '<Terminal title="Shell" />'],
    description:
      "Expand Markdown or open a shell in a pane. " +
      '`<Terminal title="Agent">…</Terminal>` runs content; ' +
      '`<Terminal title="Shell" />` opens a shell.',
    as: null,
    context: "Markdown the pane runs, in the paired form.",
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
