/**
 * Build an npm package for one @executablemd workspace member via dnt.
 *
 * Usage:
 *   deno run -A scripts/build-npm.ts <package-dir> [version]
 *
 * <package-dir> is a workspace member directory (e.g. "core" or
 * "packages/code-review-agent"). [version] defaults to 0.0.0-dev. Output lands
 * in <package-dir>/npm.
 *
 * Everything published is derived from the member's own deno.json (name,
 * exports) and package.json (dependencies, description, bin) — those manifests
 * are the single source of truth. Internal @executablemd siblings are declared
 * as external npm dependencies (resolved to the sibling's own version), never
 * inlined, so each published package resolves them from npm.
 */

import { exit, main, until } from "effection";
import { build } from "jsr:@deno/dnt@0.42.3";
import {
  copyFile,
  emptyDir,
  exists,
  fromFileUrl,
  readTextFile,
  rm,
  writeTextFile,
} from "@effectionx/fs";
import { join } from "node:path";
// Recursive directory copy and temp-dir creation are not part of @effectionx/fs.
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "npm:zod@^4";

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

await main(function* (args) {
  const pkgArg = args[0];
  const version = args[1] ?? "0.0.0-dev";
  const skipInstall = Deno.env.get("DNT_SKIP_INSTALL") === "1";

  if (!pkgArg) {
    console.error("usage: build-npm.ts <package-dir> [version]");
    yield* exit(1);
    return;
  }

  const repoRoot = new URL("../", import.meta.url);
  const pkgDir = new URL(`${pkgArg}/`, repoRoot);

  const rootDeno = RootDenoSchema.parse(
    JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))),
  );

  // Map every @executablemd workspace member name -> its declared version, so
  // internal deps can be pinned to the sibling's own version without hardcoding.
  const siblingVersion: Record<string, string> = {};
  for (const member of rootDeno.workspace) {
    const memberDenoUrl = new URL(`${member}/deno.json`, repoRoot);
    if (!(yield* exists(memberDenoUrl))) {
      continue;
    }
    const parsed = DenoJsonSchema.safeParse(JSON.parse(yield* readTextFile(memberDenoUrl)));
    if (parsed.success && parsed.data.name.startsWith(INTERNAL_SCOPE)) {
      siblingVersion[parsed.data.name] = parsed.data.version;
    }
  }

  const denoJson = DenoJsonSchema.parse(
    JSON.parse(yield* readTextFile(new URL("deno.json", pkgDir))),
  );
  const packageJson = PackageJsonSchema.parse(
    JSON.parse(yield* readTextFile(new URL("package.json", pkgDir))),
  );

  // Dependencies come from package.json verbatim, except internal siblings
  // (workspace:* protocol) which resolve to the sibling's own version range.
  const dependencies: Record<string, string> = {};
  for (const [name, range] of Object.entries(packageJson.dependencies ?? {})) {
    if (name.startsWith(INTERNAL_SCOPE)) {
      const resolved = siblingVersion[name];
      if (!resolved) {
        throw new Error(`no workspace version found for internal dependency "${name}"`);
      }
      dependencies[name] = `^${resolved}`;
    } else {
      dependencies[name] = range;
    }
  }

  // Entry points come from deno.json exports; a package.json `bin` marks its
  // main export as an executable rather than a library entry.
  const exportsMap = normalizeExports(denoJson.exports);
  const binNames = Object.keys(packageJson.bin ?? {});
  const entryPoints: Array<{ name: string; path: string; kind?: "bin" }> = [];
  for (const binName of binNames) {
    const mainPath = exportsMap["."];
    if (!mainPath) {
      throw new Error(`package "${denoJson.name}" declares bin "${binName}" but has no "." export`);
    }
    entryPoints.push({ kind: "bin", name: binName, path: mainPath });
  }
  for (const [subpath, path] of Object.entries(exportsMap)) {
    if (subpath === "." && binNames.length > 0) {
      continue;
    }
    entryPoints.push({ name: subpath, path });
  }

  const outDir = new URL("npm/", pkgDir);
  yield* emptyDir(fromFileUrl(outDir));

  // dnt runs `npm install` inside outDir, which has its own package.json, so npm
  // treats outDir as the project root and never walks up to the repo-root
  // `.npmrc`. Any `jsr:` import (e.g. testing's `@std/assert`) becomes a
  // `@jsr/*` dependency served from npm.jsr.io, not the default registry — so
  // without this scoped mapping the install 404s. dnt writes package.json and
  // .npmignore into outDir but never an .npmrc, so this file survives the build.
  // npm excludes .npmrc from published tarballs, so it stays build-only.
  yield* writeTextFile(
    new URL(".npmrc", outDir),
    "@jsr:registry=https://npm.jsr.io\n",
  );

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
  // Preserve the manifest fields alongside the rewritten imports: cli/src/cli.ts
  // imports its own deno.json for `version`, so replacing the copy with a bare
  // import map makes that property vanish from the JSON module's type.
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

  try {
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
  } finally {
    yield* rm(buildRoot, { recursive: true, force: true });
  }

  const license = new URL("LICENSE", repoRoot);
  if (yield* exists(license)) {
    yield* copyFile(license, new URL("LICENSE", outDir));
  }

  console.log(`built ${denoJson.name}@${version} -> ${pkgArg}/npm`);
});
