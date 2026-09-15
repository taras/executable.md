/**
 * How a runtime entrypoint loads one selected Plugin module.
 *
 * A host boundary, not shared orchestration. Loading a module means reaching
 * the host: a dynamic `import()` of a computed specifier, and the host package
 * resolution behind a bare one. The shared command reaches neither — it holds
 * the operation an entrypoint supplied and calls it, exactly as it holds the
 * standard-input reader, the service installer and the repository installer.
 *
 * All four entrypoints supply *this* adapter today, and that is a fact about
 * the four runtimes rather than a default: `import()` is a language feature and
 * `node:module` resolution is available under each of them, so a second copy
 * would be one implementation written four times. Nothing here asks which
 * runtime is running, and a runtime that needed its own would pass its own.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Schemes this CLI will not load code from. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** What a remote specifier is refused with. */
function remote(specifier: string): Error {
  return new Error(
    `--plugin ${specifier} names a remote module, and xmd loads no code over the network. ` +
      "Name a package installed where this command is running, or a path to a module on this " +
      "filesystem.",
  );
}

/**
 * The module URL one specifier names, resolved from the invocation directory.
 *
 * A path — relative, absolute, or already a `file:` URL — resolves against that
 * directory. Anything else is a package specifier and resolves through the
 * package environment rooted there, so a global install, an npm install and a
 * compiled binary agree about what one name means rather than each answering
 * from wherever its own modules happen to live.
 */
export function resolvePluginSpecifier(specifier: string, directory: string): URL {
  if (SCHEME.test(specifier)) {
    if (!specifier.startsWith("file:")) {
      throw remote(specifier);
    }
    return new URL(specifier);
  }
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return pathToFileURL(resolve(directory, specifier));
  }
  const from = createRequire(pathToFileURL(join(directory, "package.json")));
  return pathToFileURL(from.resolve(specifier));
}

/**
 * Import one selected module.
 *
 * Through `until`, so the load has the operation's lifetime rather than
 * outliving a cancelled command.
 */
export function* importPluginModule(specifier: string, directory: string): Operation<unknown> {
  const url = resolvePluginSpecifier(specifier, directory);
  return yield* until(import(url.href));
}
