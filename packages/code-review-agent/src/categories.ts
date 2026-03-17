/**
 * Rule categorization for Oxlint diagnostics.
 *
 * Rules are grouped by what kind of code issue they detect.
 * A rule may appear in multiple categories.
 */

export const STRUCTURAL_RULES = [
  "no-unused-vars",
  "no-empty-function",
  "no-empty-object-type",
  "no-static-only-class",
  "no-useless-empty-export",
  "no-unnecessary-type-constraint",
  "no-unnecessary-parameter-property-assignment",
  "no-unnecessary-type-arguments",
  "no-unnecessary-type-assertion",
  "no-redundant-type-constituents",
  "no-unnecessary-boolean-literal-compare",
] as const;

export const VERBOSITY_RULES = [
  "no-inferrable-types",
  "no-console",
  "no-debugger",
] as const;

export const TYPE_AWARE_RULES = [
  "no-unnecessary-type-assertion",
  "no-redundant-type-constituents",
  "no-unnecessary-type-arguments",
  "no-unnecessary-boolean-literal-compare",
] as const;

const structuralSet = new Set<string>(STRUCTURAL_RULES);
const verbositySet = new Set<string>(VERBOSITY_RULES);
const typeAwareSet = new Set<string>(TYPE_AWARE_RULES);

/**
 * Categorize a rule ID into one or more categories.
 * Returns an array of category names the rule belongs to.
 */
export function categorizeRule(
  ruleId: string,
): ("structural" | "verbosity" | "typeAware" | "other")[] {
  // Strip plugin prefix (e.g., "eslint/no-unused-vars" → "no-unused-vars")
  const bare = ruleId.includes("/") ? ruleId.split("/").pop()! : ruleId;

  const categories: ("structural" | "verbosity" | "typeAware" | "other")[] =
    [];

  if (structuralSet.has(bare)) categories.push("structural");
  if (verbositySet.has(bare)) categories.push("verbosity");
  if (typeAwareSet.has(bare)) categories.push("typeAware");
  if (categories.length === 0) categories.push("other");

  return categories;
}
