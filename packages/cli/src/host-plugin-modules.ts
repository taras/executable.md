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

/**
 * What one specifier names, decided before anything is resolved or loaded.
 *
 * Four answers, and they are decided in this order because two of them overlap
 * in shape. `C:\\plugins\\review.mjs` is a filesystem path on Windows, and it
 * also matches the grammar of a URI scheme — `C:` — so a classifier that asked
 * about schemes first would refuse an operator's own disk as a remote URL. The
 * drive prefix is therefore read first, and a scheme is only a scheme once the
 * specifier is not a path.
 */
export type PluginSpecifierKind = "path" | "file-url" | "package" | "remote";

/**
 * A Windows drive prefix: a single letter, a colon, then a separator.
 *
 * Read on every host rather than through `isAbsolute`, which answers for the
 * platform the test happens to run on. The classification of a Windows path is
 * a fact about the specifier, and it must be the same answer everywhere so the
 * regression is visible from a Linux or macOS run.
 */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** A URI scheme, once the specifier is known not to be a path. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** What a specifier names. */
export function classifyPluginSpecifier(specifier: string): PluginSpecifierKind {
  if (WINDOWS_DRIVE.test(specifier)) {
    return "path";
  }
  if (specifier.startsWith("file:")) {
    return "file-url";
  }
  if (SCHEME.test(specifier)) {
    return "remote";
  }
  // `.` and `..` relative, POSIX absolute, and a UNC share. `isAbsolute` is
  // asked last and only widens this: whatever the running host calls absolute
  // is a path here too.
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    isAbsolute(specifier)
  ) {
    return "path";
  }
  return "package";
}

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
 * A path — relative, absolute, a Windows drive path, or already a `file:` URL —
 * resolves against that directory. Anything else is a package specifier and
 * resolves through the package environment rooted there, so a global install,
 * an npm install and a compiled binary agree about what one name means rather
 * than each answering from wherever its own modules happen to live.
 */
export function resolvePluginSpecifier(specifier: string, directory: string): URL {
  switch (classifyPluginSpecifier(specifier)) {
    case "remote":
      throw remote(specifier);
    case "file-url":
      return new URL(specifier);
    case "path":
      return pathToFileURL(resolve(directory, specifier));
    case "package": {
      const from = createRequire(pathToFileURL(join(directory, "package.json")));
      return pathToFileURL(from.resolve(specifier));
    }
  }
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
