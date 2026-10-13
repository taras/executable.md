/**
 * The vocabulary one admitted evaluation has, as symbols.
 *
 * An agent asked to write a fragment is told what a fragment may contain. That
 * is not the vocabulary of the site the `<Evaluate>` element was written at:
 * the evaluator admits the trusted composition table and the host's pinned
 * identities for the selected classes, and nothing else — no executable code
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
import type { FragmentCapability } from "./fragment-capabilities.ts";
import type { CompleteComponentSyntaxEntry, SyntaxSymbols } from "./inspect.ts";
import type { ReturnsSchema } from "./types.ts";

/** The default return contract of a component that declares none. */
const UNDECLARED: ReturnsSchema = { type: "string" };

/**
 * The component canonical core owns that performs each of these operations.
 *
 * A capability is core's operation under the name the host chose, so neither
 * half alone identifies a component: a host may admit `file:write` as
 * `<Scribe>`, and nothing stops it admitting `files:glob` as `<File>`. The
 * pair does. When a host admits the operation core's own component of that name
 * performs, the component an author was shown under that name is the one they
 * may run here — and availability is exactly that comparison, so reporting this
 * entry as an ordinary registration would answer `no` for a component the
 * fragment can write.
 *
 * Only the operations core owns a component for appear here. A read and a write
 * both belong to `<File>`, because one name holds both forms.
 */
const OWNED_CAPABILITIES: Readonly<Partial<Record<FragmentCapability, string>>> = Object.freeze({
  "file:read": "File",
  "file:write": "File",
  "file:delete": "File.Delete",
  "directory:ensure": "Dir",
});

/**
 * Core's documentation origin for this entry, when the entry is core's own
 * component however the host admitted it.
 *
 * Documentation provenance only. The identity stays what the host stated,
 * because that is what a continuation compares and what the grant was recorded
 * as — a host's directory entry is still the host's grant even though the
 * component behind the name is core's.
 */
function ownedOrigin(entry: CapturedEntry): string | undefined {
  if (entry.protectedOrigin !== undefined) {
    return entry.protectedOrigin;
  }
  const owned = entry.capability === undefined ? undefined : OWNED_CAPABILITIES[entry.capability];
  return owned === entry.name ? protectedComponent(entry.name)?.origin : undefined;
}

/**
 * The symbols an evaluation admitted, in the order the tables state them.
 *
 * The identity's origin is what each entry reports it came from, because that
 * is what the host stated and what a continuation is compared against. Reported
 * as a registration for ordinary entries. An exact protected answer keeps its
 * canonical documentation origin even when a different provider delegates it,
 * and so does a capability performing an operation canonical core owns a
 * component for, under that component's name.
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
        ? { kind: "registered", origin: entry.identity.origin, reserved: false }
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
    // The host's own prose about the admitted entry, not the capability body's.
    // Core supplies the operation; only the host knows what admitting it under
    // this name means here, and a catalog that named a component and said
    // nothing about it would tell an agent a name and no more.
    ...(entry.description === undefined ? {} : { description: entry.description }),
    // `as` and `context` are deliberately absent whatever the implementation
    // declares, for two different reasons. Binding is engine-owned language
    // syntax rather than something a profile entry grants, so it belongs to no
    // entry's description; and a fragment gives content only to an entry
    // admitted in its paired form, so describing a context would document a
    // spelling preflight refuses.
  };
}
