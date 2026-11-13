import { each } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, toPath, walk } from "@effectionx/fs";
import { listWorkspacePaths } from "./workspace.ts";
import { exclusions } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

const EXTRA_MEMBERS = ["scripts"];

/**
 * The one directory whose Markdown documents are suites of their own. Only its
 * immediate regular `*.test.md` children are, so the helper documents and
 * deliberately failing fixtures nested beneath it never run as a suite.
 */
export const MARKDOWN_SUITES = "examples/adversarial-implementation/tests/";

/**
 * The Markdown suites admitted so far. Each joins with the retirement of its
 * TypeScript launcher, so no journey runs twice.
 */
const ADMITTED_MARKDOWN = new Set(["Implementation.test.md"]);

interface RootManifest {
  workspace: string[];
}

function parseWorkspace(source: string): RootManifest {
  return JSON.parse(source);
}

/** Whether `file` is a Markdown suite rather than a TypeScript test file. */
export function isMarkdownSuite(file: string): boolean {
  return file.endsWith(".test.md");
}

/**
 * Every test file in the repository, as sorted repository-relative POSIX paths.
 *
 * TypeScript discovery covers `tests/` beneath each workspace member and
 * `scripts/tests/`, and nothing else. Walking those concrete directories rather
 * than the repository root is what keeps nested worktrees, `site`, and the
 * deliberately malformed `scripts/tests/fixtures` out without naming any of
 * them. Markdown discovery adds the admitted immediate children of
 * `MARKDOWN_SUITES`.
 */
export function* listTestFiles(root: URL): Operation<string[]> {
  const { workspace } = parseWorkspace(yield* readTextFile(new URL("deno.json", root)));
  const members = [...(yield* listWorkspacePaths(workspace, root)), ...EXTRA_MEMBERS];

  const files: string[] = [];
  for (const member of members) {
    const tests = new URL(`${member}/tests/`, root);
    if (!(yield* exists(tests))) {
      continue;
    }
    for (const entry of yield* each(
      walk(tests, { includeDirs: false, match: [/\.test\.ts$/], skip: [/node_modules/] }),
    )) {
      files.push(`${member}/tests/${within(toPath(tests), entry.path)}`);
      yield* each.next();
    }
  }
  return [...files, ...(yield* listMarkdownSuites(root))].sort();
}

function* listMarkdownSuites(root: URL): Operation<string[]> {
  const directory = new URL(MARKDOWN_SUITES, root);
  if (!(yield* exists(directory))) {
    return [];
  }
  const suites: string[] = [];
  for (const entry of yield* each(walk(directory, { maxDepth: 0, includeDirs: false }))) {
    if (entry.isFile && !entry.isSymlink && ADMITTED_MARKDOWN.has(entry.name)) {
      suites.push(`${MARKDOWN_SUITES}${entry.name}`);
    }
    yield* each.next();
  }
  return suites;
}

/**
 * The test files `runtime` runs: everything discovery finds, minus that
 * runtime's recorded exclusions, still sorted.
 *
 * This is the one derivation all three runtimes share. Reading discovery and
 * the manifest separately at each call site is how a runtime comes to run a
 * corpus nobody weighed or partitioned.
 */
export function* applicableTestFiles(runtime: Runtime, root: URL): Operation<string[]> {
  const skip = new Set(exclusions[runtime].map((entry) => entry.path));
  return (yield* listTestFiles(root)).filter((file) => !skip.has(file));
}

function posix(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * `path` relative to `directory`, as POSIX.
 *
 * Compares filesystem paths rather than a URL pathname: on Windows those
 * disagree — `/C:/repo/tests/` against `C:\repo\tests\file.ts` — and a naive
 * match yields an absolute path while reporting it as repository-relative.
 * Anything outside `directory` is a discovery bug, so it throws rather than
 * silently returning an absolute path.
 */
function within(directory: string, path: string): string {
  const base = posix(directory).replace(/\/*$/, "/");
  const target = posix(path);
  if (!target.startsWith(base)) {
    throw new Error(`walked ${target}, which is outside ${base}`);
  }
  return target.slice(base.length);
}

/** Exported for the boundary tests; `listTestFiles` is the supported entry. */
export const relativeWithin = within;
