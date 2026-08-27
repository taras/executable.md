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
 * component beneath it. A relevant link to a file is therefore an ordinary
 * candidate, and a relevant link to anything else fails the whole request rather
 * than producing a catalog that quietly omits things.
 *
 * Relevance is the link's own logical path, and it is decided there because that
 * path is what `probeComponentPath()` would have had to walk. A link behind a
 * lower-case, dotted or hidden prefix is ignored: no component name produces a
 * probe through that prefix, so what the link leads to cannot hide an
 * implementation execution would have selected. Refusing it anyway would fail
 * `xmd syntax` in any ordinary package repository, whose `node_modules` is full
 * of directory links no name reaches.
 *
 * That same relevance decides where the walk goes, not just what it reports.
 * `probeComponentPath()` enters a directory only through a valid name segment,
 * so a directory whose own segment is not one holds nothing any name reaches,
 * and its whole subtree is skipped without being read. The default includes are
 * `["components", "."]`, and reading a repository's `node_modules`, `.git` and
 * build output to discard every path in them is what made `xmd syntax` take
 * thirteen seconds where the walk it actually needs takes well under one.
 */

import { lstat, readDirectory, stat } from "@executablemd/runtime";
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

/**
 * The include as a path prefix, so that joining a relative entry to it cannot
 * change what kind of path it is.
 *
 * Read segment by segment rather than by trimming spellings: `.` segments and
 * empty ones between separators carry no meaning, so `.`, `./` and `.//` all
 * name the working directory and reduce to `.`.
 *
 * The include's own leading separators are kept exactly as written, and they
 * are the only thing that decides whether a read is absolute. No relative
 * spelling can therefore produce an absolute read, and a root that a leading
 * run names — `//server/share` is a UNC share on Windows, and two leading
 * separators are implementation-defined on POSIX — stays the root the caller
 * configured rather than a different directory one separator away.
 *
 * A `..` segment is kept rather than resolved. Resolving it would take the
 * working directory this deliberately never reads, and keeping it lexical is
 * what a relative include already meant.
 */
function includePrefix(include: string): string {
  const leading = /^\/*/.exec(include)?.[0] ?? "";
  const segments = include.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (leading !== "") {
    return `${leading}${segments.join("/")}`;
  }
  return segments.length === 0 ? "." : segments.join("/");
}

/** Where a directory read is issued, for an entry `prefix` below the include. */
function readPath(include: string, prefix: string): string {
  const root = includePrefix(include);
  if (prefix === "") {
    return root;
  }
  if (root === ".") {
    return prefix;
  }
  return root.endsWith("/") ? `${root}${prefix}` : `${root}/${prefix}`;
}

/**
 * The path an entry has relative to the working directory, not to its root.
 *
 * Spelled as `probeComponentPath()` spells a candidate, because this is what
 * the link classification asks `stat` about and the two have to agree about
 * what a link under a given include leads to.
 */
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
 * Whether a logical entry could take part in component selection at all.
 *
 * Two ways it could: the path is one of the four candidate spellings, or every
 * one of its segments could be a name segment — which is what a directory
 * holding `index.md`, or an ancestor of one, looks like. Anything else is a path
 * no probe visits, so what it is made of is not this enumeration's business.
 */
function selectionRelevant(path: string): boolean {
  if (repositoryComponentName(path) !== undefined) {
    return true;
  }
  return path.split("/").every(isComponentNameSegment);
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

    yield* collect(include, "", names);
  }

  return names;
}

/**
 * Every name one directory contributes, and every name the directories worth
 * entering beneath it contribute.
 *
 * `prefix` is the directory's path relative to the include, so what the
 * grammar is applied to is the logical path a name would have to produce —
 * never the host path the read is issued against.
 */
function* collect(include: string, prefix: string, names: Set<string>): Operation<void> {
  const directory = readPath(include, prefix);

  for (const entry of yield* readDirectory(directory)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isFile) {
      add(names, path);
      continue;
    }

    if (entry.isDirectory) {
      // Every segment above this one was admitted by the same test, so the
      // segment alone decides whether any component name reaches inside.
      if (isComponentNameSegment(entry.name)) {
        yield* collect(include, path, names);
      }
      continue;
    }

    if (!entry.isSymbolicLink) {
      continue;
    }
    if (!selectionRelevant(path)) {
      continue;
    }
    // `stat` follows the link, which is the only thing asked of it here — what
    // the link leads to, never where. The resolved host path stays out of the
    // classification and out of every message below.
    const target = yield* stat(within(include, path));
    if (target.exists && target.isFile) {
      add(names, path);
      continue;
    }
    throw includeFailure(
      include,
      `${JSON.stringify(path)} is a symbolic link to ${
        target.exists ? "a directory" : "nothing"
      }, and a link is never followed — so the components it could have supplied ` +
        "cannot be listed.",
    );
  }
}

function add(names: Set<string>, path: string): void {
  const name = repositoryComponentName(path);
  if (name !== undefined) {
    names.add(name);
  }
}
