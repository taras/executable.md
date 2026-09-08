/**
 * @module
 *
 * The elicitation response judgment, for runtimes that cannot load the root.
 *
 * `prepareResponseValidator` is already public from the package root. This
 * subpath exists so a consumer can select it without loading the root barrel,
 * which reaches a terminal renderer, `node:crypto` and the rest of the host
 * surface — a Cloudflare Worker resolving that graph fails to load it at all.
 *
 * The judgment itself generates no code, so it runs wherever a run's owner
 * does, and a response schema receives one verdict whichever boundary asks.
 */

export { prepareResponseValidator, ResponseSchemaError } from "./src/elicitation-schema.ts";
export type { ResponseValidator } from "./src/elicitation-schema.ts";
export type { NormalizedIssue } from "./src/validate.ts";
