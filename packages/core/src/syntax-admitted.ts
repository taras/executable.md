/**
 * The vocabulary one admitted evaluation has, as symbols.
 *
 * An agent asked to write a fragment is told what a fragment may contain. That
 * is not the vocabulary of the site the `<Evaluate>` element was written at:
 * the evaluator admits the host's pinned identities and nothing else — no
 * executable code block, no expression prop, no interpolation, no `as` binding,
 * and none of the structural constructs an ordinary document has.
 *
 * So the symbols built here say exactly that. The structural and built-in
 * categories are empty, because a fragment writes neither, and the components
 * are the entries the selection resolved to. Anything else would describe a
 * vocabulary the fragment does not have, and an agent told it had `<Loop>`
 * would produce a fragment the evaluator refuses whole.
 *
 * What an author may *read about* is a separate question, and this does not
 * answer it: `SyntaxReference.available()` keeps the enclosing documentation
 * index and replaces only what may run.
 */

import type { CapturedEntry } from "./evaluation-profile.ts";
import type { CompleteComponentSyntaxEntry, SyntaxSymbols } from "./inspect.ts";
import type { ReturnsSchema } from "./types.ts";

/** The default return contract of a component that declares none. */
const UNDECLARED: ReturnsSchema = { type: "string" };

/**
 * The symbols an evaluation admitted, in the order the tables state them.
 *
 * The identity's origin is what each entry reports it came from, because that
 * is what the host stated and what a continuation is compared against. Reported
 * as a registration for ordinary entries. An exact protected answer keeps its
 * canonical documentation origin even when a different provider delegates it.
 */
export function admittedSymbols(entries: readonly CapturedEntry[]): SyntaxSymbols {
  return {
    version: 2,
    categories: [
      { kind: "structural", entries: [] },
      { kind: "built-in", entries: [] },
      { kind: "user-provided", entries: entries.map(describe) },
    ],
  };
}

function describe(entry: CapturedEntry): CompleteComponentSyntaxEntry {
  const definition = entry.definition;
  return {
    kind: "component",
    name: entry.name,
    origin:
      entry.protectedOrigin === undefined
        ? { kind: "registered", origin: entry.identity.origin, reserved: false }
        : { kind: "protected", origin: entry.protectedOrigin },
    sourceKind: entry.protectedOrigin === undefined ? "registered" : "protected",
    inspectability: "complete",
    // The forms the *host admitted this entry for*, which is narrower than the
    // forms the implementation accepts whenever one name holds two identities:
    // `<File />` observes and `<File>…</File>` writes, and a fragment told it
    // had both would be told it could write under a read selection.
    forms: [...entry.forms],
    props: entry.props,
    captures: definition.captures === undefined ? [] : [...definition.captures],
    returnMode: definition.returns === undefined ? "text" : "value",
    returns: definition.returns ?? UNDECLARED,
    // The host's own prose about the admitted entry, not the capability body's.
    // Core supplies the operation; only the host knows what admitting it under
    // this name means here, and a catalog that named a component and said
    // nothing about it would tell an agent a name and no more.
    ...(entry.description === undefined ? {} : { description: entry.description }),
    // `as` and `context` are deliberately absent whatever the implementation
    // declares: a fragment may bind nothing, and the evaluator refuses an `as`
    // before the first effect. Describing them would document a spelling that
    // refuses the whole fragment.
  };
}
