/**
 * Every component name a repository could supply, for one search path.
 *
 * Selection answers "what does this name mean"; this answers the question
 * before it — "which names are there to ask about" — and it answers with names
 * alone. Nothing here decides precedence, reads a file, or parses anything: the
 * names it collects go back through `selectComponent()`, so include order, the
 * `.md`/`.ts` and direct/index candidate order, repository override and
 * registered fallback stay decided in exactly one place (spec §5.3).
 *
 * The mapping inverted here is `probeComponentPath()`'s, exactly: a name's dots
 * are its path separators, and the four suffixes are the four it probes. A
 * segment that could not have been written as a dotted name segment — a
 * lowercase directory, a file whose stem holds a dot — inverts to nothing,
 * because the name it would produce is not the name that file answers to.
 *
 * A symbolic link is where enumeration and probing can disagree, so it is where
 * this refuses. Probing follows a link and finds a file; traversal cannot follow
 * a link to a directory without risking a cycle, and would silently miss every
 * component beneath it. A link to a file is therefore an ordinary candidate,
 * and any other link fails the whole request rather than producing a catalog
 * that quietly omits things.
 *
 * The refusal does not depend on how the link is spelled. What a linked
 * directory holds is unknown precisely because it was not walked, so a name
 * that could not have come from the link's own path says nothing about the
 * names that could have come from inside it — and a lower-case or dotted
 * directory is where a `components/` tree is as likely to be reached from as
 * anywhere else. Refusing on the spelling would be answering a question the
 * traversal deliberately did not ask.
 */

import { glob, lstat, stat } from "@executablemd/runtime";
import type { Operation } from "effection";
import { isComponentName, isComponentNameSegment } from "./registration.ts";

/** An include that exists but cannot be enumerated as a component directory. */
export class ComponentIncludeError extends Error {
  override name = "ComponentIncludeError";
}

function includeFailure(include: string, reason: string): ComponentIncludeError {
  return new ComponentIncludeError(
    `cannot list the components in --include ${JSON.stringify(include)}: ${reason}`,
  );
}

/** Strip leading ./ from paths for workspace-relative normalization. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

/** The path an entry has relative to the working directory, not to its root. */
function within(include: string, path: string): string {
  return normalizePath(include === "." ? path : `${include}/${path}`);
}

/**
 * The name a repository path answers to, or `undefined` when it answers to
 * none.
 *
 * Each path segment is held to the single-segment grammar rather than to the
 * dotted one, because that is what the forward mapping produces: `File.Delete`
 * is probed at `File/Delete.md`, so a file literally named `File.Delete.md`
 * answers to no name at all and must not be reported as though it did.
 */
export function repositoryComponentName(path: string): string | undefined {
  const segments = path.split("/");
  const last = segments.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const stem =
    last === "index.md" || last === "index.ts" ? segments.slice(0, -1) : withoutSuffix(segments);
  if (stem === undefined || stem.length === 0 || !stem.every(isComponentNameSegment)) {
    return undefined;
  }
  const name = stem.join(".");
  return isComponentName(name) ? name : undefined;
}

function withoutSuffix(segments: string[]): string[] | undefined {
  const last = segments[segments.length - 1] ?? "";
  if (!last.endsWith(".md") && !last.endsWith(".ts")) {
    return undefined;
  }
  return [...segments.slice(0, -1), last.slice(0, -3)];
}

/**
 * Every component name the configured includes could supply, in no particular
 * order and without duplicates.
 *
 * A missing include is ordinary absence and contributes nothing. An include
 * that exists but cannot be walked fails the whole request: a catalog that
 * silently omitted a directory would read as complete.
 */
export function* repositoryCandidateNames(includes: readonly string[]): Operation<Set<string>> {
  const names = new Set<string>();

  for (const include of includes) {
    const root = yield* lstat(include);
    if (!root.exists) {
      continue;
    }
    if (root.isSymbolicLink) {
      throw includeFailure(
        include,
        "it is a symbolic link, and a linked directory is never walked. Name the directory it " +
          "points at instead.",
      );
    }
    if (!root.isDirectory) {
      throw includeFailure(include, "it is not a directory.");
    }

    for (const entry of yield* glob({ patterns: ["**/*"], root: include })) {
      if (entry.isFile) {
        add(names, entry.path);
        continue;
      }

      // Reported and not a file: `glob` reports a symbolic link by its own path
      // and never follows it, so this is the one shape left.
      //
      // `stat` follows the link, which is the only thing asked of it here — what
      // the link leads to, never where. The resolved host path stays out of the
      // classification and out of every message below.
      const target = yield* stat(within(include, entry.path));
      if (target.exists && target.isFile) {
        add(names, entry.path);
        continue;
      }
      throw includeFailure(
        include,
        `${JSON.stringify(entry.path)} is a symbolic link to ${
          target.exists ? "a directory" : "nothing"
        }, and a link is never followed — so what lies beyond it cannot be listed and this ` +
          "include cannot be complete. Name directories that hold no such link, as in " +
          "`xmd syntax --include components`.",
      );
    }
  }

  return names;
}

function add(names: Set<string>, path: string): void {
  const name = repositoryComponentName(path);
  if (name !== undefined) {
    names.add(name);
  }
}
