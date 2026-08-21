/**
 * The structural constructs (spec §5.3).
 *
 * These names are the language's own syntax, not components. The expansion loop
 * handles each one directly, so none of them reaches component resolution: a
 * repository file cannot supply them and a registration cannot claim them.
 *
 * The set is the single place that decides which names are reserved. Resolution
 * consults it first, and registration rejects anything in it.
 */
export const RESERVED_STRUCTURAL: ReadonlySet<string> = new Set([
  "Content",
  "Output",
  "Return",
  "Let",
  "Each",
  "If",
  "Else",
  "Loop",
  "Break",
  "PrintErrors",
  "Answers",
  "Answer",
]);

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
