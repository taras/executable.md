/**
 * Build an npm package for one @executablemd workspace member via dnt.
 *
 * Usage:
 *   deno run -A scripts/build-npm.ts <package-dir> [version]
 *
 * <package-dir> is a workspace member directory (e.g. "packages/core" or
 * "packages/code-review-agent"). [version] defaults to 0.0.0-dev. Output lands
 * in <package-dir>/npm.
 *
 * Everything published is derived from the member's own deno.json (name,
 * exports) and package.json (dependencies, description, bin) — those manifests
 * are the single source of truth. Internal @executablemd siblings are declared
 * as external npm dependencies, never inlined.
 *
 * A build happens in two phases, and the split is what keeps a release off the
 * registry's clock.
 *
 * **Phase 1 builds the local closure.** The requested package's internal
 * dependencies are built first, depth-first, each at most once, and handed to
 * dnt as absolute `file:` ranges pointing at the artifacts this same invocation
 * produced. Nothing asks npm for a package from the same release.
 *
 * **Phase 2 finalizes every manifest together**, once the last dnt call has
 * returned, replacing each internal `file:` range with the sibling's
 * `^<version>`. It has to be every manifest at once: in a chain A → B → C,
 * rewriting B the moment its own dnt call returns puts C's registry version
 * back in front of A's install, which is the race one level down. No install or
 * typecheck runs after finalization begins, and a surviving local reference
 * fails the build rather than reaching `npm publish`.
 *
 * `DNT_SKIP_INSTALL=1` still skips the install and typecheck for a leaf package
 * that declares no `workspace:*` dependency, for exercising the tooling. It
 * refuses anything else, and release workflows never set it.
 */

import { ensure, exit, main, scoped, until } from "effection";
import { validateDocumentation } from "./validate-documentation.ts";
import type { Operation } from "effection";
import { build } from "jsr:@deno/dnt@0.42.3";
import {
  copyFile,
  emptyDir,
  ensureDir,
  exists,
  fromFileUrl,
  readTextFile,
  rm,
  stat,
  writeTextFile,
} from "@effectionx/fs";
import { listWorkspacePaths } from "./lib/workspace.ts";
import { join, sep } from "node:path";
// Only what `@effectionx/fs` does not provide: recursive directory copy,
// temp-dir creation, and a recursive listing — its own `readdir` takes no
// options. Everything else on this path goes through the package.
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "npm:zod@^4";

/**
 * The documents a package ships, as package-relative paths.
 *
 * `src/documents/` and nothing else. Packages keep test documents and scenario
 * fixtures under `src/` as well, so publishing every Markdown found there would
 * ship a package full of fixtures; being in this one directory is what declares
 * a document part of the product.
 */
function* packagedDocuments(pkgDir: URL): Operation<string[]> {
  const shipped: string[] = [];
  // Component documentation lives beside the registration boundary it
  // documents rather than in `src/documents/`, because that is where the
  // components are and moving it would separate the two things that have to
  // stay in step. One entry per boundary, named rather than swept for: `src/`
  // also holds test documents and scenario fixtures, so being listed here is
  // what declares an asset shipped.
  for (const relative of [
    "src/components/components.md",
    "src/agent/components.md",
    "src/components.md",
    "src/composition/components.md",
  ]) {
    if (yield* exists(new URL(relative, pkgDir))) {
      shipped.push(relative);
    }
  }
  const documents = new URL("src/documents/", pkgDir);
  if (!(yield* exists(documents))) {
    return shipped;
  }
  const root = fromFileUrl(documents);
  const names = yield* until(readdir(root, { recursive: true }));
  const found: string[] = [];
  for (const name of names) {
    // A recursive listing names the directories as well as what is in them, and
    // each entry here becomes a `copyFile`. Packages whose documents sit flat in
    // `src/documents/` never noticed; the review graph keeps its documents under
    // `components/` and `policies/`, and copying a directory as a file fails the
    // whole npm build with `EINVAL`.
    const info = yield* stat(join(root, name));
    if (info.isFile()) {
      found.push(`src/documents/${name.split(sep).join("/")}`);
    }
  }
  return [...shipped, ...found];
}

const ExportsSchema = z.union([z.string(), z.record(z.string(), z.string())]);

const DenoJsonSchema = z.object({
  name: z.string(),
  version: z.string(),
  exports: ExportsSchema,
});

const PackageJsonSchema = z.object({
  description: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  bin: z.record(z.string(), z.string()).optional(),
});

const RootDenoSchema = z.object({
  workspace: z.array(z.string()),
  imports: z.record(z.string(), z.string()),
});

const INTERNAL_SCOPE = "@executablemd/";

function normalizeExports(exports: z.infer<typeof ExportsSchema>): Record<string, string> {
  if (typeof exports === "string") {
    return { ".": exports };
  }
  return exports;
}

/** A workspace member's directory and declared version, keyed by package name. */
interface WorkspaceMember {
  dir: string;
  version: string;
}

/**
 * What one invocation reports as it runs. Diagnostic observation only: an
 * observer chooses no build, no dependency resolution and no finalization
 * policy, which is what keeps the regression watching the real path instead of
 * a second one.
 */
export type BuildEvent =
  | {
      readonly type: "package-build-started";
      readonly package: string;
      /** Exactly what dnt was handed, so a test can see the local ranges. */
      readonly dependencies: Readonly<Record<string, string>>;
    }
  | { readonly type: "package-build-completed"; readonly package: string }
  | { readonly type: "closure-finalization-started" }
  | { readonly type: "package-manifest-finalized"; readonly package: string };

export interface BuildNpmOptions {
  /** The workspace root the closure is built from. */
  repoRoot: URL;
  /** The requested member's directory, e.g. `packages/cli`. */
  package: string;
  /** The npm version for the requested artifact; siblings use their own. */
  version: string;
  observe?: (event: BuildEvent) => Operation<void>;
}

/** One package this invocation built, awaiting closure-wide finalization. */
interface BuiltArtifact {
  name: string;
  dir: string;
  /** Internal dependency name -> the workspace version to finalize it to. */
  internal: Record<string, string>;
}

interface BuildContext {
  repoRoot: URL;
  rootDeno: z.infer<typeof RootDenoSchema>;
  members: Record<string, WorkspaceMember>;
  skipInstall: boolean;
  /** Artifacts already built in this process, so a diamond builds once. */
  built: Map<string, BuiltArtifact>;
  observe: (event: BuildEvent) => Operation<void>;
}

/**
 * npm resolves a relative `file:` against the dependent's own location, which
 * differs for a sibling installed under another package's node_modules, so the
 * range this invocation hands dnt is absolute.
 */
function localRange(repoRoot: URL, dir: string): string {
  return `file:${fromFileUrl(new URL(`${dir}/npm`, repoRoot))}`;
}

function* observeNothing(): Operation<void> {}

/**
 * Build `options.package` and its internal closure, and leave every generated
 * manifest publishable. This is the whole builder; the command below is an
 * adapter over it, so the regression exercises the release path itself.
 */
export function* buildNpmPackage(options: BuildNpmOptions): Operation<void> {
  const { repoRoot } = options;

  const rootDeno = RootDenoSchema.parse(
    JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))),
  );

  // Map every @executablemd workspace member name -> where it lives and which
  // version it declares, so internal deps resolve without hardcoding either.
  const members: Record<string, WorkspaceMember> = {};
  for (const member of yield* listWorkspacePaths(rootDeno.workspace, repoRoot)) {
    const memberDenoUrl = new URL(`${member}/deno.json`, repoRoot);
    if (!(yield* exists(memberDenoUrl))) {
      continue;
    }
    const parsed = DenoJsonSchema.safeParse(JSON.parse(yield* readTextFile(memberDenoUrl)));
    if (parsed.success && parsed.data.name.startsWith(INTERNAL_SCOPE)) {
      members[parsed.data.name] = { dir: member, version: parsed.data.version };
    }
  }

  const ctx: BuildContext = {
    repoRoot,
    rootDeno,
    members,
    skipInstall: Deno.env.get("DNT_SKIP_INSTALL") === "1",
    built: new Map(),
    observe: options.observe ?? observeNothing,
  };

  yield* buildPackage(options.package, options.version, ctx);
  yield* finalizeClosure(ctx);
}

function* buildPackage(pkgArg: string, version: string, ctx: BuildContext): Operation<void> {
  const { repoRoot, rootDeno, skipInstall } = ctx;
  const pkgDir = new URL(`${pkgArg}/`, repoRoot);
  const siblingVersion: Record<string, string> = Object.fromEntries(
    Object.entries(ctx.members).map(([name, member]) => [name, member.version]),
  );

  const denoJson = DenoJsonSchema.parse(
    JSON.parse(yield* readTextFile(new URL("deno.json", pkgDir))),
  );
  const packageJson = PackageJsonSchema.parse(
    JSON.parse(yield* readTextFile(new URL("package.json", pkgDir))),
  );

  // Dependencies come from package.json verbatim, except internal siblings
  // (workspace:* protocol), which are built first and named by the artifact
  // this invocation just produced. Phase 2 turns those into version ranges.
  const dependencies: Record<string, string> = {};
  const internal: Record<string, string> = {};
  for (const [name, range] of Object.entries(packageJson.dependencies ?? {})) {
    if (!name.startsWith(INTERNAL_SCOPE)) {
      dependencies[name] = range;
      continue;
    }
    const member = ctx.members[name];
    if (!member) {
      // No registry fallback: reaching npm for an unmapped internal name is how
      // a misspelled or removed member would silently restore the release race.
      throw new Error(
        `"${denoJson.name}" depends on internal package "${name}", which is not a workspace member`,
      );
    }
    if (!ctx.built.has(name)) {
      yield* buildPackage(member.dir, member.version, ctx);
    }
    internal[name] = member.version;
    dependencies[name] = localRange(repoRoot, member.dir);
  }

  // Library entry points come from deno.json exports. An executable comes from
  // package.json `bin`, which names the entrypoint for the runtime the npm
  // package runs under — not the one deno.json exports for JSR.
  const exportsMap = normalizeExports(denoJson.exports);
  const binEntries = Object.entries(packageJson.bin ?? {});
  const binNames = binEntries.map(([name]) => name);
  const entryPoints: Array<{ name: string; path: string; kind?: "bin" }> = [];
  for (const [binName, binPath] of binEntries) {
    entryPoints.push({ kind: "bin", name: binName, path: binPath });
  }
  for (const [subpath, path] of Object.entries(exportsMap)) {
    if (subpath === "." && binNames.length > 0) {
      continue;
    }
    entryPoints.push({ name: subpath, path });
  }

  const workspaceDeps = Object.entries(packageJson.dependencies ?? {})
    .filter(([, range]) => range.startsWith("workspace:"))
    .map(([name]) => name);

  const outDir = new URL("npm/", pkgDir);
  yield* emptyDir(fromFileUrl(outDir));

  // A sibling's declarations exist only once it is installed, and dnt resolves
  // them from outDir. Skipping the install silently emits the sibling's
  // workspace source into the package instead (#148), so refuse rather than
  // build. outDir is already empty, so nothing survives to look current.
  if (skipInstall && workspaceDeps.length > 0) {
    console.error(
      `DNT_SKIP_INSTALL=1 cannot build "${denoJson.name}": it depends on ${workspaceDeps.join(
        ", ",
      )}.`,
    );
    console.error(
      "Build without DNT_SKIP_INSTALL once those versions are published; skip-install builds only packages with no workspace dependencies.",
    );
    yield* exit(1);
    return;
  }

  // dnt externalizes any import that resolves to an `npm:` specifier (that's how
  // effection/@effectionx end up as dependencies) and inlines anything that
  // resolves to a local file. Sibling @executablemd packages resolve locally via
  // Deno *workspace* membership, which no import-map override can suppress. So
  // build in a copy OUTSIDE the workspace tree, with a generated import map that
  // redirects the siblings to `npm:` specifiers — dnt then declares them as
  // dependencies instead of inlining them.
  const buildRoot = yield* until(mkdtemp(join(tmpdir(), "dnt-")));
  const srcCopy = join(buildRoot, "pkg");
  yield* until(cp(fromFileUrl(pkgDir), srcCopy, { recursive: true }));
  for (const excluded of ["npm", "tests", "node_modules", "demo"]) {
    yield* rm(join(srcCopy, excluded), { recursive: true, force: true });
  }

  const isolatedImports: Record<string, string> = {};
  for (const [key, value] of Object.entries(rootDeno.imports)) {
    if (value.startsWith("npm:") || value.startsWith("jsr:") || value.startsWith("http")) {
      isolatedImports[key] = value;
    } else {
      isolatedImports[key] = new URL(value, repoRoot).href;
    }
  }
  for (const [name, siblingVer] of Object.entries(siblingVersion)) {
    if (name === denoJson.name) {
      continue;
    }
    isolatedImports[name] = `npm:${name}@^${siblingVer}`;
    isolatedImports[`${name}/`] = `npm:${name}@^${siblingVer}/`;
  }
  // The CLI imports its own deno.json for `version`, so replacing the copy with
  // a bare import map would make that property vanish from the JSON module's type.
  yield* writeTextFile(
    join(srcCopy, "deno.json"),
    JSON.stringify(
      {
        name: denoJson.name,
        version: denoJson.version,
        exports: denoJson.exports,
        imports: isolatedImports,
      },
      null,
      2,
    ),
  );

  yield* ctx.observe({ type: "package-build-started", package: denoJson.name, dependencies });

  // The build tree is removed when this scope closes, before the finished
  // package is completed below.
  yield* scoped(function* () {
    yield* ensure(() => rm(buildRoot, { recursive: true, force: true }));

    yield* until(
      build({
        entryPoints: entryPoints.map((entry) => ({ ...entry, path: join(srcCopy, entry.path) })),
        outDir: fromFileUrl(outDir),
        importMap: join(srcCopy, "deno.json"),
        shims: { deno: false },
        test: false,
        // The install resolves internal siblings from the artifacts phase 1
        // already built, so it never reaches npm for a package from this
        // release. DNT_SKIP_INSTALL=1 drops the install and typecheck entirely,
        // which only a leaf package may ask for (refused above).
        skipNpmInstall: skipInstall,
        typeCheck: skipInstall ? false : "single",
        declaration: "separate",
        scriptModule: false,
        skipSourceOutput: true,
        // Match the repo's TS target so the ES2022 `new Error(msg, { cause })`
        // form in cli.ts type-checks.
        compilerOptions: {
          target: "ES2022",
          lib: ["ESNext", "DOM"],
        },
        // dnt writes `_dnt.polyfills.ts` itself and then type-checks its own
        // output alongside ours. At 0.42.3 that file does not compile: the
        // ImportMeta.resolve polyfill hands an `unknown` parentURL to
        // createRequire (TS2345). The emitted JavaScript is correct, and no
        // change on our side can fix a file dnt generates — so drop exactly
        // that diagnostic, matched to both the code and the generated
        // filename. Diagnostics in our own sources still fail the build.
        filterDiagnostic: (diagnostic) =>
          !(
            diagnostic.code === 2345 &&
            (diagnostic.file?.fileName ?? "").endsWith("_dnt.polyfills.ts")
          ),
        package: {
          name: denoJson.name,
          version,
          description: packageJson.description ?? "",
          license: "MIT",
          homepage: "https://executable.md",
          repository: {
            type: "git",
            url: "git+https://github.com/taras/executable.md.git",
          },
          bugs: { url: "https://github.com/taras/executable.md/issues" },
          dependencies,
        },
      }),
    );
  });

  const license = new URL("LICENSE", repoRoot);
  if (yield* exists(license)) {
    yield* copyFile(license, new URL("LICENSE", outDir));
  }

  // A package that executes its own Markdown ships that Markdown beside its
  // emitted module. dnt emits the module graph and nothing else, so an asset no
  // TypeScript imports would be absent from the published package while the
  // source checkout kept working — the command would find nothing at runtime,
  // on Node and Bun only.
  for (const asset of yield* packagedDocuments(pkgDir)) {
    const target = new URL(`esm/${asset}`, outDir);
    yield* ensureDir(fromFileUrl(new URL(".", target)));
    yield* copyFile(new URL(asset, pkgDir), target);
  }

  ctx.built.set(denoJson.name, { name: denoJson.name, dir: pkgArg, internal });
  yield* ctx.observe({ type: "package-build-completed", package: denoJson.name });
  console.log(`built ${denoJson.name}@${version} -> ${pkgArg}/npm`);
}

/** The dependency maps npm reads, so validation misses none of them. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every string anywhere in `value`, so a workspace path cannot hide in a field nobody checks. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* strings(item);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      yield* strings(item);
    }
  }
}

/**
 * Why `manifest` cannot be published, or `undefined` when it can.
 *
 * A release gate rather than cleanup. A known internal local range is rewritten
 * by the caller before this runs; anything local still standing is an
 * unexpected dependency, and normalizing it away would be the one edit that
 * makes an unpublishable artifact look fine.
 */
function unpublishable(manifest: unknown, repoRoot: URL): string | undefined {
  if (!isRecord(manifest)) {
    return "it is not an object";
  }

  for (const field of DEPENDENCY_FIELDS) {
    const map = manifest[field];
    if (!isRecord(map)) {
      continue;
    }
    for (const [name, range] of Object.entries(map)) {
      if (
        typeof range === "string" &&
        (range.startsWith("workspace:") || range.startsWith("file:"))
      ) {
        return `${field}["${name}"] is the local range ${range}`;
      }
    }
  }

  const nativeRoot = fromFileUrl(repoRoot).replace(new RegExp(`${sep}$`), "");
  const urlRoot = repoRoot.href.replace(/\/$/, "");
  for (const value of strings(manifest)) {
    if (value.includes(nativeRoot)) {
      return `it names the workspace path ${nativeRoot}`;
    }
    if (value.includes(urlRoot)) {
      return `it names the workspace URL ${urlRoot}`;
    }
  }

  return undefined;
}

/**
 * Phase 2. Every artifact this invocation produced becomes publishable at once,
 * after the last dnt call returned — see the two-phase note at the top of this
 * file for why it cannot happen package by package.
 */
function* finalizeClosure(ctx: BuildContext): Operation<void> {
  yield* ctx.observe({ type: "closure-finalization-started" });

  const candidates: Array<{ name: string; url: URL; manifest: Record<string, unknown> }> = [];

  for (const artifact of ctx.built.values()) {
    const url = new URL(`${artifact.dir}/npm/package.json`, ctx.repoRoot);
    const manifest: unknown = JSON.parse(yield* readTextFile(url));
    if (!isRecord(manifest)) {
      throw new Error(`${artifact.name}'s generated package.json is not an object`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const map = manifest[field];
      if (!isRecord(map)) {
        continue;
      }
      for (const [name, version] of Object.entries(artifact.internal)) {
        const member = ctx.members[name];
        if (member && map[name] === localRange(ctx.repoRoot, member.dir)) {
          map[name] = `^${version}`;
        }
      }
    }
    candidates.push({ name: artifact.name, url, manifest });
  }

  // Every manifest is judged before any is written, so a closure that cannot be
  // published in full is never half-published.
  for (const candidate of candidates) {
    const refusal = unpublishable(candidate.manifest, ctx.repoRoot);
    if (refusal !== undefined) {
      throw new Error(`${candidate.name} cannot be published: ${refusal}`);
    }
  }

  for (const candidate of candidates) {
    yield* writeTextFile(candidate.url, `${JSON.stringify(candidate.manifest, null, 2)}\n`);
    yield* ctx.observe({ type: "package-manifest-finalized", package: candidate.name });
  }
}

if (import.meta.main) {
  await main(function* (args) {
    const pkgArg = args[0];
    const version = args[1] ?? "0.0.0-dev";

    if (!pkgArg) {
      console.error("usage: build-npm.ts <package-dir> [version]");
      yield* exit(1);
      return;
    }

    // Before anything is emitted. Copying the documentation assets is not the
    // same as validating them: a package built from a set that has drifted from
    // the components it documents would install cleanly and refuse the first
    // time somebody asked it for documentation. The same assembly the run
    // profile uses runs here, so a missing, unknown or duplicated section fails
    // the build for exactly the reason it would fail a run.
    yield* validateDocumentation();

    yield* buildNpmPackage({
      repoRoot: new URL("../", import.meta.url),
      package: pkgArg,
      version,
    });
  });
}
