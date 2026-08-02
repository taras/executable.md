/**
 * Answering an elicitation with a browser form.
 *
 * `<Elicit>` describes a question without saying how it is asked. This is one
 * answer to "how": a host installs it, and every elicitation in that scope opens
 * the same loopback form `<WebForm>` serves.
 *
 * The adapter is deliberately thin, and what it does *not* do is the point. It
 * closes over nothing. It never calls `content()`, `invocation()`, or reads a
 * binding environment — everything it uses arrives in the request, which carries
 * the rendered message and the compiled schema and nothing else. No `as`, no run
 * identity, no journal handle crosses this boundary, so the provider cannot
 * depend on the component that asked and can be replaced without it noticing.
 *
 * There is no UI schema. `<Elicit>` has no way to express one, and inventing a
 * default here would make the same document render differently depending on
 * which provider a host installed. An author who wants RJSF presentation control
 * writes `<WebForm>`, which is exactly what it is for.
 *
 * It lives here rather than in the CLI because the sanitization boundary does.
 * `renderBody` is the only supported way to turn a document's markdown into
 * page content, and its threat model is documented beside it; exporting it so a
 * second package could call it correctly would be worse than keeping the one
 * caller here.
 *
 * `parseDeclaration` re-checks what core already refused — a `__proto__`
 * declared name, a reference leaving the schema. Reached through `<Elicit>`
 * those are unreachable, because core refuses both before any provider is
 * contacted. They stay as defense in depth for a host calling `liveForm`
 * directly, and because this module should not depend on which of its callers
 * happens to be strict.
 */

import { Elicitation } from "@executablemd/core";
import type { Operation } from "effection";

import { parseDeclaration } from "./declaration.ts";
import type { Json } from "./json.ts";
import { liveForm } from "./live-form.ts";
import { renderBody } from "./markdown.ts";

/**
 * Answer elicitations in this scope with a browser form.
 *
 * Installed at `{ at: "min" }` like any provider: the nearest one answers, so a
 * document's own `<Answers>` region still wins inside it and the host's form is
 * what everything else falls back to.
 */
export function installWebElicitation(): Operation<void> {
  return Elicitation.around(
    {
      *elicit([request]): Operation<Json> {
        const declaration = parseDeclaration("Elicit", request.schema);
        return yield* liveForm({
          schema: declaration.schema,
          content: renderBody(request.message),
        });
      },
    },
    { at: "min" },
  );
}
