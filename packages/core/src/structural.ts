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
  "Capture",
  "Each",
  "If",
  "Else",
  "Loop",
  "Break",
  "CollectFailures",
  "Answers",
  "Answer",
]);

export function isStructural(name: string): boolean {
  return RESERVED_STRUCTURAL.has(name);
}
