/**
 * What `xmd test <path>` points at.
 *
 * A path names either one document or a directory to search. The search is
 * driven by the pattern list the CLI hands over — this module never decides
 * which patterns are defaults.
 */

import { dirname, join, resolve } from "node:path";
import type { Operation } from "effection";
import { glob, stat } from "@executablemd/runtime";

export interface TestDocument {
  /** Host filesystem path, used to execute the document. */
  path: string;
  /** Normalized POSIX path relative to the target root. */
  relativePath: string;
}

export type TestTarget =
  | { kind: "file"; path: string }
  | { kind: "directory"; root: string; documents: TestDocument[] };

/**
 * Resolve a target from a path and the patterns in effect.
 *
 * Only a directory searches. A file — and a path that does not exist — resolves
 * to a single document, so a missing document still produces the diagnostic
 * execution reports rather than an empty search.
 */
export function* resolveTestTarget(path: string, patterns: string[]): Operation<TestTarget> {
  const info = yield* stat(path);
  if (!info.isDirectory) {
    return { kind: "file", path };
  }

  const matches = yield* glob({ root: path, patterns });

  // A document matched by several patterns is still one document, and the
  // order it comes back in follows the walk rather than the pattern list.
  const byRelativePath = new Map<string, TestDocument>();
  for (const match of matches) {
    if (!match.isFile) {
      continue;
    }
    byRelativePath.set(match.path, {
      path: join(path, match.path),
      relativePath: match.path,
    });
  }

  const documents = [...byRelativePath.values()].sort(byCodePoint);
  return { kind: "directory", root: path, documents };
}

/**
 * Where one discovered document looks for components.
 *
 * Its own directory comes first, so a component beside a nested test wins over
 * a same-named one elsewhere in the suite; the target root comes next, so a
 * suite shares what sits at its top; the caller's directories come last. The
 * first spelling of a directory wins, so a repeat cannot promote a later
 * entry.
 */
export function componentSearchPath(
  document: TestDocument,
  root: string,
  configured: string[],
): string[] {
  const search: string[] = [];
  const seen = new Set<string>();

  for (const directory of [dirname(document.path), root, ...configured]) {
    const key = resolve(directory);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    search.push(directory);
  }

  return search;
}

// Code point order, not `localeCompare`: the report a run prints must not
// depend on the locale the host happens to be configured with.
function byCodePoint(left: TestDocument, right: TestDocument): number {
  if (left.relativePath < right.relativePath) {
    return -1;
  }
  if (left.relativePath > right.relativePath) {
    return 1;
  }
  return 0;
}
