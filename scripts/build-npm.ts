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
 * as external npm dependencies (resolved to the sibling's own version), never
 * inlined, so each published package resolves them from npm.
 *
 * `DNT_LOCAL_SIBLINGS=1` builds each internal sibling first and depends on those
 * artifacts by path instead of by published version, so a branch can build and
 * type-check against its own workspace sources. The resulting package.json names
 * local directories and is therefore unpublishable; release workflows never set
 * the variable.
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
  writeTextFile,
} from "@effectionx/fs";
import { listWorkspacePaths } from "./lib/workspace.ts";
import { join, sep } from "node:path";
// Recursive directory copy and temp-dir creation are not part of @effectionx/fs.
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
  const names = yield* until(readdir(fromFileUrl(documents), { recursive: true }));
  return [...shipped, ...names.map((name) => `src/documents/${name.split(sep).join("/")}`)];
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

interface BuildContext {
  repoRoot: URL;
  rootDeno: z.infer<typeof RootDenoSchema>;
  members: Record<string, WorkspaceMember>;
  /** Depend on locally built sibling artifacts instead of published versions. */
  localSiblings: boolean;
  skipInstall: boolean;
  /** Package names already built in this process, so a diamond builds once. */
  built: Set<string>;
}

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
  // the components it documents would install cleanly and refuse the first time
  // somebody asked it for documentation. The same assembly the run profile uses
  // runs here, so a missing, unknown or duplicated section fails the build for
  // exactly the reason it would fail a run.
  yield* validateDocumentation();

  const repoRoot = new URL("../", import.meta.url);

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

  yield* buildPackage(pkgArg, version, {
    repoRoot,
    rootDeno,
    members,
    localSiblings: Deno.env.get("DNT_LOCAL_SIBLINGS") === "1",
    skipInstall: Deno.env.get("DNT_SKIP_INSTALL") === "1",
    built: new Set(),
  });
});

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
  // (workspace:* protocol) which resolve to the sibling's own version range —
  // or, with local siblings, to the artifact this process just built for it.
  const dependencies: Record<string, string> = {};
  for (const [name, range] of Object.entries(packageJson.dependencies ?? {})) {
    if (!name.startsWith(INTERNAL_SCOPE)) {
      dependencies[name] = range;
      continue;
    }
    const member = ctx.members[name];
    if (!member) {
      throw new Error(`no workspace version found for internal dependency "${name}"`);
    }
    if (!ctx.localSiblings) {
      dependencies[name] = `^${member.version}`;
      continue;
    }
    if (!ctx.built.has(name)) {
      yield* buildPackage(member.dir, member.version, ctx);
    }
    // An absolute path: npm resolves a relative `file:` against the dependent's
    // own location, which differs for a sibling installed under another
    // package's node_modules.
    dependencies[name] = `file:${fromFileUrl(new URL(`${member.dir}/npm`, repoRoot))}`;
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
        // Internal @executablemd deps are published tier-by-tier, so a downstream
        // package's siblings are already on npm when it builds in CI. For local
        // builds (before siblings are published) set DNT_SKIP_INSTALL=1 to skip
        // the npm install + type check that would otherwise 404 on them.
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

  ctx.built.add(denoJson.name);
  const provenance =
    ctx.localSiblings && workspaceDeps.length > 0 ? " (local siblings — not publishable)" : "";
  console.log(`built ${denoJson.name}@${version} -> ${pkgArg}/npm${provenance}`);
}
