/**
 * Binding a host's own description, as one setup operation.
 *
 * The thing a host actually has is not a set of symbols — it is a profile it
 * can inspect, plus the documentation its packages contributed. Both have to be
 * taken here, in the scope the host assembled, because only one of them is
 * lazy: the source runs later, when an occurrence renders, but the
 * contributions are gone as soon as that assembly's scope ends. A host that
 * bootstrapped its profile and then handed over a bare symbols callback would
 * keep the first and lose the second, and a named lookup would fall back to
 * whichever catalog the execution happened to have.
 */

import type { Operation } from "effection";
import type { SyntaxSymbols } from "./inspect.ts";
import { capturedDocumentation } from "./documentation-api.ts";
import { Syntax } from "./syntax-api.ts";
import { profileSyntaxReference } from "./syntax-reference.ts";

/**
 * Describe this scope with the host's own profile.
 *
 * The source is not read here. Installing is binding, not inspecting, so a
 * command that prints nothing and a run whose document never writes
 * `<Syntax />` both enumerate nothing.
 *
 * Installed at `min`, which is the implementation slot: this is a host stating
 * what it has, so ordinary middleware nearer the caller still answers,
 * delegates to it or transforms what it returns. Symbols and named
 * documentation both, because a host supplying one and not the other would
 * describe its own vocabulary with somebody else's prose.
 */
export function* useSyntax(source: () => Operation<SyntaxSymbols>): Operation<void> {
  const value = profileSyntaxReference(source, yield* capturedDocumentation());
  yield* Syntax.around(
    {
      symbols: () => value.symbols(),
      documentation: ([names]) => value.documentation(names),
    },
    { at: "min" },
  );
}
