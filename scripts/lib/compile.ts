/**
 * Share compile inputs across local builds, releases and `verify:clean`; callers
 * choose only the output path and target. `deno compile` embeds only `--include`
 * assets, so a missing document can survive compilation and startup and fail
 * only when requested, as omitted component documentation did in releases.
 */

import { exec } from "@effectionx/process";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";

import { RELEASE_ENTRYPOINT, RELEASE_TARGETS } from "./release-targets.ts";

/** What a release compiles, and what every other site compiles too. */
export const COMPILE_ENTRYPOINT = RELEASE_ENTRYPOINT;

/**
 * The flags every compile carries.
 *
 * The first three are the isolation a build is held to: a compile may resolve
 * nothing it has not already cached, may not manage `node_modules`, and may not
 * rewrite the tracked lock. They are on the release's command line rather than
 * inherited from a task, because `release.yml` compiles at tag time from a
 * tagged commit and a compile that fetched there would install something no
 * review saw.
 */
export const COMPILE_FLAGS = [
  "--node-modules-dir=none",
  "--cached-only",
  "--frozen",
  "--exclude-unused-npm",
  "--allow-all",
];

/**
 * Whole imported packages whose Markdown assets the binary needs. Selected
 * Plugins load their own assets from their installed location. An entry here
 * must name an imported package; unreachable bytes serve no binary code.
 */
export const EMBEDDED_PACKAGES: readonly string[] = [];

/**
 * Packages whose assets the binary deliberately does not carry.
 *
 * `scripts/tests/packaged-document.test.ts` walks the repository for packages
 * that ship documents and holds the lists above to what it finds, which is what
 * keeps a new asset from being forgotten. A package outside the binary would
 * fail that walk for the right reason and the wrong subject, so it is named
 * here — and the same test checks that exclusion rather than trusting it, by proving
 * no CLI production module imports one.
 */
export const UNEMBEDDED_PACKAGES: readonly string[] = ["packages/code-review-agent"];

/**
 * Each package's `src/documents/`, embedded whole.
 *
 * A directory rather than a file per entry, so a document added beside its
 * module needs no build change — only a package shipping its *first* one adds
 * an entry here, which is what
 * `scripts/tests/packaged-document.test.ts` discovers and enforces.
 */
export const PACKAGED_DOCUMENTS = ["packages/cli/src/documents"];

/**
 * Every `components.md` a package ships, named individually.
 *
 * These are the long-form component descriptions `<Syntax>` and `xmd syntax`
 * render. Each is located from its own module's URL rather than from the
 * working directory, so the compile has to keep it at the same relative path;
 * a build that drops one produces a binary that lists every component and can
 * document none of them.
 *
 * A file rather than a directory per entry, because these sit beside the source
 * of the boundary that registers them and embedding those directories whole
 * would carry the package's TypeScript into the binary a second time.
 * `scripts/tests/packaged-document.test.ts` discovers the assets that exist and
 * fails when this list omits one.
 */
export const PACKAGED_DOCUMENTATION = [
  "packages/core/src/components/components.md",
  "packages/core/src/agent/components.md",
  "packages/cli/src/components.md",
  "packages/testing/src/components.md",
  "packages/web/src/components.md",
  "packages/git/src/composition/components.md",
];

/** Everything a compile embeds, in the order the argv names it. */
export const EMBEDDED_ASSETS = [
  ...EMBEDDED_PACKAGES,
  ...PACKAGED_DOCUMENTS,
  ...PACKAGED_DOCUMENTATION,
];

export interface CompileRequest {
  /** Where the binary is written, relative to the repository root. */
  readonly output: string;
  /**
   * The platform to compile for. Absent compiles for the host, which is what a
   * local `deno task build` wants and what no release job ever does.
   */
  readonly target?: string;
}

/**
 * The complete `deno compile` argv for one binary.
 *
 * An unknown target throws here, before a caller can spawn anything — the same
 * refusal `preparationArguments` makes, because a target this cannot compile is
 * a target nothing prepared either.
 */
export function compileArguments(request: CompileRequest): string[] {
  if (request.target !== undefined && !RELEASE_TARGETS[request.target]) {
    throw new Error(
      `unknown release target "${request.target}" — expected one of ${Object.keys(
        RELEASE_TARGETS,
      ).join(", ")}`,
    );
  }
  return [
    "compile",
    ...COMPILE_FLAGS,
    ...EMBEDDED_ASSETS.flatMap((asset) => ["--include", asset]),
    ...(request.target === undefined ? [] : ["--target", request.target]),
    "--output",
    request.output,
    COMPILE_ENTRYPOINT,
  ];
}

/** Compile one binary from the repository root, failing the caller if it does. */
export function* compile(request: CompileRequest): Operation<void> {
  yield* exec(Deno.execPath(), {
    arguments: compileArguments(request),
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
  }).expect();
}
