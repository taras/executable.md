/**
 * What each changed path means for test selection.
 *
 * Deno's module graph decides which tests a *TypeScript* change affects. It
 * cannot decide anything about the rest, and measuring showed how much of the
 * rest there is: a changed fixture, a runtime-loaded `.md` component, a deleted
 * source file, `pnpm-lock.yaml`, and `tsconfig.node.json` each select **zero**
 * tests while changing what the suite does.
 *
 * Every changed path therefore lands in exactly one class here, and a class
 * either runs the whole corpus, contributes nothing on its own, or hands the
 * path to Deno. Nothing falls through: a path this table does not recognise is
 * `unknown`, and `unknown` runs everything. Widening the table is how a new
 * kind of input becomes cheaper — never by letting it go unmatched.
 */

import type { Change } from "./git-changes.ts";

export type ClassName =
  | "deletion"
  | "workspace-config"
  | "runtime-dependencies"
  | "selection-machinery"
  | "test-harness"
  | "runtime-documents"
  | "bundle-inputs"
  | "no-runtime-tests"
  | "test-file"
  | "typescript"
  | "unknown";

export interface Classified {
  change: Change;
  className: ClassName;
}

export interface Classification {
  classified: Classified[];
  /** Classes that run the complete corpus, in the order their paths appear. */
  full: Classified[];
  /** Changed TypeScript whose reachability Deno must confirm before it is trusted. */
  typescript: string[];
  /** Changed paths that are themselves test files, which always run. */
  testFiles: string[];
}

/** Classes whose response is the whole corpus. */
const FULL: ReadonlySet<ClassName> = new Set<ClassName>([
  "deletion",
  "workspace-config",
  "runtime-dependencies",
  "selection-machinery",
  "test-harness",
  "runtime-documents",
  "bundle-inputs",
  "unknown",
]);

/** The directories discovery walks, as a path shape rather than a second walk. */
const MEMBER_TESTS = /^(?:packages\/[^/]+|scripts|site)\/tests\//;

const WORKSPACE_CONFIG = [
  /^deno\.json$/,
  /^deno\.lock$/,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^packages\/[^/]+\/deno\.json$/,
  /^packages\/[^/]+\/package\.json$/,
];

const RUNTIME_DEPENDENCIES = [
  /^pnpm-lock\.yaml$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^\.npmrc$/,
  /^tsconfig[^/]*\.json$/,
];

/**
 * Discovery, the exclusion manifest, the selector itself, and the lint
 * configuration the rule tests lint through: each one changes what the corpus
 * *is* or what running it means, so none can be judged by the graph.
 */
const SELECTION_MACHINERY = [
  /^scripts\/lib\/test-files\.ts$/,
  /^scripts\/lib\/runtime-tests\.ts$/,
  /^scripts\/lib\/git-changes\.ts$/,
  /^scripts\/lib\/change-classes\.ts$/,
  /^scripts\/lib\/affected\.ts$/,
  /^scripts\/lib\/shard\.ts$/,
  /^scripts\/runtime-tests\.ts$/,
  /^scripts\/runtime-test-exclusions\.ts$/,
  /^scripts\/affected-tests\.ts$/,
  /^scripts\/measure-weights\.ts$/,
  /^test-weights\.json$/,
  /^\.oxlintrc\.json$/,
  /^\.oxfmtrc\.json$/,
  /^\.gitignore$/,
  /^scripts\/oxlint-plugin\.js$/,
  /^scripts\/oxlint-rules\//,
];

/**
 * Documents and data that execute or are read at run time. They reach tests
 * through paths assembled while running, so no static analysis and no literal
 * scan of the corpus can say which tests depend on them.
 */
const RUNTIME_DOCUMENTS = [
  /^packages\/[^/]+\/components\//,
  /^packages\/[^/]+\/src\/.*\.md$/,
  /^specs\//,
  /^smoke-test\//,
  /^\.reviews\//,
  /^\.github\/workflows\//,
  /^[^/]+\.md$/,
];

const BUNDLE_INPUTS = [
  /^scripts\/build-web-client\.ts$/,
  /^scripts\/lib\/web-client-module\.ts$/,
  /^scripts\/lib\/side-effect-free\.ts$/,
  /^packages\/web\/client\//,
];

/**
 * The bounded set of paths no test reads. `.github/workflows/**` is not among
 * them — the publish-workflow tests read the generated workflow — and neither
 * is the lint configuration, which the rule tests lint through.
 */
const NO_RUNTIME_TESTS = [
  /^\.github\/(?!workflows\/)/,
  /^\.vscode\//,
  /(?:^|\/)\.claude\//,
  /^\.editorconfig$/,
  /^LICENSE$/,
];

function some(patterns: RegExp[], path: string): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function classNameOf(change: Change, corpus: ReadonlySet<string>): ClassName {
  if (change.kind === "deleted") {
    return "deletion";
  }
  if (corpus.has(change.path)) {
    return "test-file";
  }
  if (some(WORKSPACE_CONFIG, change.path)) {
    return "workspace-config";
  }
  if (some(RUNTIME_DEPENDENCIES, change.path)) {
    return "runtime-dependencies";
  }
  if (some(SELECTION_MACHINERY, change.path)) {
    return "selection-machinery";
  }
  if (change.path.startsWith("packages/test-support/")) {
    return "test-harness";
  }
  if (MEMBER_TESTS.test(change.path) || some(RUNTIME_DOCUMENTS, change.path)) {
    return "runtime-documents";
  }
  if (some(BUNDLE_INPUTS, change.path)) {
    return "bundle-inputs";
  }
  if (some(NO_RUNTIME_TESTS, change.path)) {
    return "no-runtime-tests";
  }
  if (/\.tsx?$/.test(change.path)) {
    return "typescript";
  }
  return "unknown";
}

/** Whether a class runs the complete corpus on its own. */
export function runsEverything(className: ClassName): boolean {
  return FULL.has(className);
}

export function classify(changes: Change[], corpus: string[]): Classification {
  const known = new Set(corpus);
  const classified = changes.map((change) => ({
    change,
    className: classNameOf(change, known),
  }));

  return {
    classified,
    full: classified.filter((entry) => runsEverything(entry.className)),
    typescript: classified
      .filter((entry) => entry.className === "typescript")
      .map((entry) => entry.change.path),
    testFiles: classified
      .filter((entry) => entry.className === "test-file")
      .map((entry) => entry.change.path),
  };
}
