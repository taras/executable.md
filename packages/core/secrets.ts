/**
 * @module
 *
 * The configured secret gate, for runtimes that cannot load the package root.
 *
 * `createSecretScanner` is already public from the package root. This subpath
 * exists so a consumer can select the gate without loading the root barrel,
 * which reaches a terminal renderer and the rest of the host surface — a
 * Cloudflare Worker resolving that graph fails to load it at all. The gate
 * itself is the recommended Secretlint preset and this repository's own
 * credential rule, and it generates no code, so it runs wherever the run's
 * owner does.
 *
 * Same scanner, same rules, same findings. Narrower resolution path.
 */

export { createSecretScanner } from "./src/secrets/scanner.ts";
export type { SecretScanner } from "./src/secrets/scanner.ts";
export { SecretDetectedError } from "./src/secrets/findings.ts";
export type { SecretFinding } from "./src/secrets/findings.ts";
