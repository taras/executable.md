/**
 * The Elicitation Api — how a document asks a person something.
 *
 * A provider is installed by the host, never chosen by the document. `<Elicit>`
 * describes the question; where the asking happens — a browser form, a terminal,
 * the Effection Inspector, a scripted test — is the host's decision, and
 * changing it changes no Markdown.
 *
 * The request is the whole contract between the two sides. A provider receives
 * the rendered message and the compiled schema and nothing else: no `as`, no
 * workflow run id, no journal handle, no component execution identity. What it
 * returns is `unknown`, because a provider produces a value core has not yet
 * judged — core validates it against the same schema before anything binds.
 *
 * The default handler throws. There is no fallback interaction and no silent
 * skip: a document that asks a question when nobody is listening has not
 * received an answer, and saying so is the only honest outcome.
 *
 * ## Installing a provider
 *
 * ```ts
 * yield* Elicitation.around({
 *   *elicit([request], next) {
 *     return yield* ask(request.message, request.schema);
 *   },
 * }, { at: "min" });
 * ```
 *
 * `{ at: "min" }` is not optional decoration. Middleware installed at the
 * default position runs *outermost*, so an outer scope's provider would answer
 * ahead of one installed in a nested scope — the opposite of what a provider
 * is. At `min` the nearest installed provider answers and the outer one is
 * restored when that scope ends, which is what makes a test, a `<TempDir>`-style
 * region, or an embedding host able to override the ambient provider at all.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { JsonObject } from "./types.ts";

/** What a provider is given. Everything it needs, and nothing more. */
export interface ElicitationRequest {
  /** The invocation content, expanded and rendered. */
  message: string;
  /** The normalized draft-07 schema the answer must satisfy. */
  schema: JsonObject;
}

export interface ElicitationApi {
  elicit(request: ElicitationRequest): Operation<unknown>;
}

/** No provider is installed in this scope. Raised before anything is asked. */
export class ElicitationProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElicitationProviderError";
  }
}

export const Elicitation: Api<ElicitationApi> = createApi<ElicitationApi>("Elicitation", {
  // deno-lint-ignore require-yield
  *elicit(_request: ElicitationRequest): Operation<unknown> {
    throw new ElicitationProviderError(
      "no elicitation provider configured — a host installs one with " +
        "yield* Elicitation.around({ *elicit([request], next) { ... } }). The CLI " +
        "installs the WebForm provider; tests install scripted responses with " +
        "scriptElicitations().",
    );
  },
});
