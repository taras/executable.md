/**
 * The description in effect here, as a contextual Api.
 *
 * `<Syntax />`, `xmd syntax` and a Plan's authorship all ask the same three
 * questions — what are the symbols, what is the text, what do these names
 * mean — of one descriptor, dispatched by name, so a host, a trusted boundary
 * or ordinary middleware can answer, delegate or transform any of them.
 *
 * ## Why the properties are Operations
 *
 * `symbols` and `text` are values a caller reads, not calls it makes, and they
 * are also work: a description is inspected lazily, from a filesystem, on
 * demand. `Operation`-valued properties are both at once. A caller writes
 * `yield* Syntax.operations.text` with no parentheses, and a provider's body
 * may suspend, read a file and delegate — with no cast hiding an operation
 * behind a string.
 *
 * The defaults are *reusable* operations. `call(factory)` starts fresh
 * generator work on each read, so two reads of one property are two answers
 * rather than one consumed generator and then nothing.
 *
 * ## The fallback is not middleware
 *
 * An execution derives a description from what it captured
 * (`syntax-reference.ts`), and that has to be what answers when nothing else
 * does — while still losing to a host that stated its own profile. Those are
 * different slots, and conflating them is the bug this module exists to avoid:
 *
 * - {@link useRootSyntaxReference} binds the execution's own reference as the
 *   value the *default* reads. A default is the furthest thing from the
 *   caller, so an enclosing `useSyntax()` profile still wins.
 * - {@link useNarrowedSyntax} installs real middleware at `min` for a
 *   boundary that has admitted less than its enclosing site. That one is meant
 *   to shadow: it is reporting an admission, not offering a fallback, and it
 *   ends with the scope that installed it.
 *
 * Neither grants anything, and neither takes anything away: a description that
 * names a component does not admit it, and one that hides a component does not
 * disable it. Component selection, invocation identity and durable recording
 * stay canonical whatever the description says, which is why composing on this
 * Api is ordinary rather than privileged work. The boundary itself is
 * architecture.md's *The syntax symbols boundary*.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { call, createContext, type Operation } from "effection";
import type { SyntaxReference } from "./syntax-reference.ts";
import type { SyntaxSymbols } from "./inspect.ts";
import { renderSyntaxMarkdown } from "./syntax-markdown.ts";

/** The three questions anything describing this site answers. */
export interface SyntaxApi {
  /** The effective structured description of this site. */
  readonly symbols: Operation<SyntaxSymbols>;
  /**
   * The effective text, which is what `xmd syntax` prints.
   *
   * Its *default* renders {@link SyntaxApi.symbols}. Middleware may answer with
   * text of its own, so the two are not two views of one value by construction.
   */
  readonly text: Operation<string>;
  /** These components' metadata and long-form documentation. */
  documentation(names: readonly string[]): Operation<string>;
}

/**
 * The execution's own reference, read by the defaults below.
 *
 * A context rather than installed middleware, because this is the answer of
 * last resort: middleware would sit in front of an enclosing host profile and
 * shadow it, which is precisely backwards.
 */
const DefaultReference = createContext<SyntaxReference | undefined>(
  "executablemd.core.syntax.defaultReference",
  undefined,
);

function* reference(): Operation<SyntaxReference> {
  const value = yield* DefaultReference.get();
  if (value === undefined) {
    throw new Error("Syntax has no descriptive reference in this scope.");
  }
  return value;
}

export const Syntax: Api<SyntaxApi> = createApi<SyntaxApi>("executablemd.core.syntax", {
  symbols: call(function* (): Operation<SyntaxSymbols> {
    return yield* (yield* reference()).symbols();
  }),
  // Through the Api, not through the reference: a nearer provider that replaced
  // the symbols is describing this site, so the text has to render what that
  // provider said rather than what the fallback would have.
  text: call(function* (): Operation<string> {
    return renderSyntaxMarkdown(yield* Syntax.operations.symbols);
  }),
  documentation(names): Operation<string> {
    return call(function* () {
      return yield* (yield* reference()).documentation(names);
    });
  },
});

/**
 * The authoring basis one named lookup is resolving, while it resolves it.
 *
 * Set by the reference that owns the lookup and read by its own default symbols
 * provider, so an occurrence that needs both its metadata and its availability
 * inspects a moving root once rather than twice. Nothing outside that one
 * lookup's scope sees it.
 */
export const NamedBasis = createContext<SyntaxSymbols | undefined>(
  "executablemd.core.syntax.namedBasis",
  undefined,
);

/** Bind the reference this execution derived as the Api's fallback answer. */
export function* useRootSyntaxReference(value: SyntaxReference): Operation<void> {
  // A fresh execution resolves its own basis. Started inside a named lookup —
  // an isolated child, or a fragment evaluated while one is open — it would
  // otherwise inherit that occurrence's basis as its root symbols.
  yield* NamedBasis.set(undefined);
  yield* DefaultReference.set(value);
}

/** Report a narrowed admission for the scope a boundary is evaluating. */
export function useNarrowedSyntax(value: SyntaxReference): Operation<void> {
  // Symbols only. Named documentation stays with the enclosing owner, because a
  // subtree that may run less is still entitled to read about what it may not
  // run — and the entry it reads says so.
  return Syntax.around({ symbols: () => value.symbols() }, { at: "min" });
}
