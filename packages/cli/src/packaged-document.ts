/**
 * The Markdown documents this CLI ships and executes itself.
 *
 * `xmd prompt` runs a first-party document rather than a TypeScript policy, so
 * that document has to be present wherever the command is: a source checkout, a
 * published npm package, and a compiled binary with no checkout at all. It is
 * located from this module's own URL, never from the working directory and never
 * through the component search path — the command must find the same program
 * whatever directory a person happens to be standing in, and a repository file
 * must not be able to answer for it.
 *
 * Each build keeps `src/documents/` beside its module: `deno compile --include`
 * embeds each file at the same relative path, and the npm build copies the
 * directory into the emitted tree. So the one lookup below is correct in all
 * four places, and a build that forgets the asset fails loudly on first use
 * rather than silently choosing different behavior.
 */

import { readFile } from "node:fs/promises";
import { until } from "effection";
import type { Operation } from "effection";

/** The plan program `xmd prompt` executes. */
export const PROMPT_PLAN = "prompt-plan.md";

/**
 * Where a packaged document lives, as a URL beside this module.
 *
 * One directory rather than "any Markdown under `src/`": packages keep test
 * documents and scenario fixtures beside their modules too, and a build that
 * swept those up would publish them and grow the binary for no reason. Being in
 * here is what declares a document shipped.
 */
export function packagedDocumentUrl(name: string): URL {
  return new URL(`./documents/${name}`, import.meta.url);
}

/**
 * Read one packaged document.
 *
 * `node:fs` rather than a host File Api: this is the CLI reading its own
 * program, not a document reaching the caller's filesystem, and it must not be
 * answerable by whatever the running document installed.
 */
export function* readPackagedDocument(name: string): Operation<string> {
  const url = packagedDocumentUrl(name);
  try {
    return yield* until(readFile(url, "utf8"));
  } catch (error) {
    throw new Error(
      `the packaged document ${name} is missing from this build (looked in ${url.href})`,
      { cause: error },
    );
  }
}
