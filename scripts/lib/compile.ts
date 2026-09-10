/**
 * Everything a compiled `xmd` is made of, stated once.
 *
 * `deno compile` embeds what `--include` names and nothing else. An asset left
 * out costs nothing at compile time and nothing at startup: the binary runs,
 * resolves the name, and fails at the moment a person asks it for the thing
 * that was omitted. Three sites compile this entrypoint — `deno task build`,
 * `release.yml`'s matrix, and `verify:clean`'s release phase — and while each
 * carried its own copy of the list the three disagreed: the release shipped no
 * component documentation at all, so every published binary refused
 * `xmd syntax TempDir`, and `verify:clean` proved a binary narrower than the one
 * a release publishes.
 *
 * So the inputs live here and each site asks for the argv. What the sites still
 * choose for themselves is the two things that genuinely differ between them:
 * where the binary is written, and which platform it is for.
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
 * Packages embedded whole, because the binary runs their Markdown rather than
 * importing it. Nothing discovers these: a package is here because a command
 * executes documents from it, which is a decision rather than a file layout.
 */
export const EMBEDDED_PACKAGES = ["packages/code-review-agent"];

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
  "packages/workflow/src/composition/components.md",
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
