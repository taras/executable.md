/**
 * The vocabulary one admitted evaluation has, as symbols.
 *
 * An agent asked to write a fragment is told what a fragment may contain. That
 * is not the vocabulary of the site the `<Evaluate>` element was written at:
 * the evaluator admits the trusted composition table and the names the host
 * selected for the selected classes, and nothing else — no executable code
 * block, no interpolation, and none of the structural constructs an ordinary
 * document has.
 *
 * So the symbols built here say exactly that. The structural and built-in
 * categories are empty, because a fragment writes neither, and the components
 * are the composition entries beside the ones the selection resolved to.
 * Anything else would describe a vocabulary the fragment does not have, and an
 * agent told it had `<Loop>` would produce a fragment the evaluator refuses
 * whole.
 *
 * What an author may *read about* is a separate question, and this does not
 * answer it: `SyntaxReference.available()` keeps the enclosing documentation
 * index and replaces only what may run.
 */

import { protectedComponent } from "./components/protected.ts";
import type { CapturedEntry } from "./evaluation-profile.ts";
import type { CompleteComponentSyntaxEntry, SyntaxSymbols } from "./inspect.ts";
import type { ReturnsSchema } from "./types.ts";

/** The default return contract of a component that declares none. */
const UNDECLARED: ReturnsSchema = { type: "string" };

/**
 * Core's documentation origin for this entry, when canonical core owns the name.
 *
 * Documentation provenance only. It changes nothing a continuation compares:
 * what the grant was recorded as is the identity the owning declaration offers
 * the admitted spelling under, and that is core's wherever core supplies the
 * component behind the name.
 *
 * Two sources, in order. An exact routed answer carries its own canonical
 * origin, which survives a provider delegating it. Otherwise a name in the
 * canonical protected tier is core's by construction — nothing else can answer
 * for it — so reporting it as an ordinary registration would answer "could I
 * supply this name myself?" with yes about a name no host can take.
 */
function ownedOrigin(entry: CapturedEntry): string | undefined {
  if (entry.protectedOrigin !== undefined) {
    return entry.protectedOrigin;
  }
  return protectedComponent(entry.name)?.origin;
}

/**
 * The symbols an evaluation admitted, in the order the tables state them.
 *
 * Each entry reports the origin its implementation came from: core's own where
 * canonical resolution answered with core's, and the publishing provider
 * installation's where a provider answered. Reported as a registration for
 * ordinary entries, and as protected for a name the canonical protected tier
 * owns — including an exact protected answer a different provider delegated,
 * which keeps its canonical documentation origin.
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
  const owned = ownedOrigin(entry);
  return {
    kind: "component",
    name: entry.name,
    origin:
      owned === undefined
        ? { kind: "registered", origin: entry.origin, reserved: false }
        : { kind: "protected", origin: owned },
    sourceKind: owned === undefined ? "registered" : "protected",
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
    // The owning declaration's own prose. A host selects a name and says
    // nothing about it, so what describes an admitted entry is what describes
    // the component everywhere else.
    ...(entry.description === undefined ? {} : { description: entry.description }),
    // `as` and `context` are deliberately absent whatever the implementation
    // declares, for two different reasons. Binding is engine-owned language
    // syntax rather than something a profile entry grants, so it belongs to no
    // entry's description; and a fragment gives content only to an entry
    // admitted in its paired form, so describing a context would document a
    // spelling preflight refuses.
  };
}
