/**
 * Build an npm package for one @executablemd workspace member via dnt.
 *
 * Usage:
 *   deno run -A scripts/build-npm.ts <package> [version]
 *
 * <package> is one of the keys in PACKAGES below. [version] defaults to
 * 0.0.0-dev. Output lands in <dir>/npm.
 *
 * Internal @executablemd siblings are declared as external npm dependencies
 * (never inlined), so each published package resolves them from npm. External
 * dependency versions are read from the root package.json so there is a single
 * source of truth.
 */

import { build, emptyDir } from "jsr:@deno/dnt@0.42.3";
import { fromFileUrl, join } from "jsr:@std/path@1";
import { copy } from "jsr:@std/fs@1";

const repoRoot = new URL("../", import.meta.url);

const rootPkg = JSON.parse(await Deno.readTextFile(new URL("package.json", repoRoot))) as {
  dependencies: Record<string, string>;
};

const rootDeno = JSON.parse(await Deno.readTextFile(new URL("deno.json", repoRoot))) as {
  imports: Record<string, string>;
};

/**
 * Resolve a dependency's version range from the single sources of truth:
 * root package.json dependencies, falling back to the root deno.json import
 * map (npm: specifiers, e.g. "npm:configliere@^0.2.3").
 */
function depVersion(name: string): string {
  const fromPkg = rootPkg.dependencies[name];
  if (fromPkg) return fromPkg;

  const spec = rootDeno.imports[name];
  if (spec?.startsWith("npm:")) {
    const at = spec.lastIndexOf("@");
    if (at > "npm:".length) return spec.slice(at + 1);
  }
  throw new Error(`no version for "${name}" in root package.json or deno.json`);
}

/** Version range published packages use to depend on their siblings. */
const INTERNAL_RANGE = "^0.2.0";

interface EntryPoint {
  name: string;
  path: string;
  kind?: "bin";
}

interface PackageConfig {
  dir: string;
  name: string;
  description: string;
  entryPoints: (string | EntryPoint)[];
  /** External npm dependency names; versions come from root package.json. */
  deps: string[];
  /** Sibling @executablemd packages this one depends on. */
  internal: string[];
}

const PACKAGES: Record<string, PackageConfig> = {
  "code-review-agent": {
    dir: "packages/code-review-agent",
    name: "@executablemd/code-review-agent",
    description:
      "Parsers that turn git diff and Oxlint output into typed structures for executable.md reviews.",
    entryPoints: ["./mod.ts"],
    deps: [],
    internal: [],
  },
  "durable-streams": {
    dir: "durable-streams",
    name: "@executablemd/durable-streams",
    description: "Durable, replayable event streams for executable.md.",
    entryPoints: ["./mod.ts"],
    deps: ["@durable-streams/client", "effection"],
    internal: [],
  },
  runtime: {
    dir: "runtime",
    name: "@executablemd/runtime",
    description: "Runtime host APIs for executable.md documents.",
    entryPoints: [
      { name: ".", path: "./mod.ts" },
      { name: "./test", path: "./test/mod.ts" },
    ],
    deps: [
      "effection",
      "@effectionx/context-api",
      "@effectionx/fetch",
      "@effectionx/fs",
      "@effectionx/node",
      "@effectionx/process",
    ],
    internal: [],
  },
  core: {
    dir: "core",
    name: "@executablemd/core",
    description: "Core engine that evaluates executable.md documents.",
    entryPoints: ["./mod.ts"],
    deps: [
      "effection",
      "@effectionx/context-api",
      "@effectionx/converge",
      "@effectionx/fetch",
      "@effectionx/fs",
      "@effectionx/middleware",
      "@effectionx/node",
      "@effectionx/process",
      "@effectionx/scope-eval",
      "@effectionx/stream-helpers",
      "@effectionx/timebox",
      "acorn",
      "gray-matter",
      "magic-string",
      "marked",
      "marked-terminal",
      "mdast-util-to-string",
      "remark",
      "remend",
      "unist-util-select",
    ],
    internal: ["@executablemd/durable-streams", "@executablemd/runtime"],
  },
  cli: {
    dir: "cli",
    name: "@executablemd/cli",
    description: "The xmd command-line interface for executable.md.",
    entryPoints: [{ kind: "bin", name: "xmd", path: "./src/cli.ts" }],
    deps: ["effection", "@effectionx/stream-helpers", "configliere", "zod"],
    internal: ["@executablemd/core", "@executablemd/durable-streams"],
  },
};

const pkgKey = Deno.args[0];
const version = Deno.args[1] ?? "0.0.0-dev";
const skipInstall = Deno.env.get("DNT_SKIP_INSTALL") === "1";

const config = PACKAGES[pkgKey];
if (!config) {
  console.error(`unknown package "${pkgKey}". known: ${Object.keys(PACKAGES).join(", ")}`);
  Deno.exit(1);
}

const pkgDir = new URL(`${config.dir}/`, repoRoot);
const outDir = new URL("npm/", pkgDir);

await emptyDir(fromFileUrl(outDir));

const dependencies: Record<string, string> = {};
for (const name of config.deps) dependencies[name] = depVersion(name);
for (const name of config.internal) dependencies[name] = INTERNAL_RANGE;

// dnt externalizes any import that resolves to an `npm:` specifier (that's how
// effection/@effectionx end up as dependencies), and inlines anything that
// resolves to a local file. Sibling @executablemd packages resolve locally via
// Deno *workspace* membership, which no import-map override or dnt mapping can
// suppress. So build in an isolated copy OUTSIDE the workspace tree, with a
// generated import map that redirects the siblings to `npm:` specifiers — dnt
// then declares them as dependencies instead of inlining them.
const buildRoot = await Deno.makeTempDir({ prefix: `dnt-${pkgKey}-` });
const srcCopy = join(buildRoot, "pkg");
await copy(fromFileUrl(pkgDir), srcCopy);
for (const excluded of ["npm", "tests", "node_modules", "demo"]) {
  await Deno.remove(join(srcCopy, excluded), { recursive: true }).catch(() => {});
}

const isolatedImports: Record<string, string> = {};
for (const [key, value] of Object.entries(rootDeno.imports)) {
  isolatedImports[key] =
    value.startsWith("npm:") || value.startsWith("jsr:") || value.startsWith("http")
      ? value
      : new URL(value, repoRoot).href;
}
for (const name of config.internal) {
  isolatedImports[name] = `npm:${name}@${INTERNAL_RANGE}`;
  isolatedImports[`${name}/`] = `npm:${name}@${INTERNAL_RANGE}/`;
}
await Deno.writeTextFile(
  join(srcCopy, "deno.json"),
  JSON.stringify({ imports: isolatedImports }, null, 2),
);

try {
  await build({
    entryPoints: config.entryPoints.map((entry) =>
      typeof entry === "string"
        ? join(srcCopy, entry)
        : {
            ...entry,
            path: join(srcCopy, entry.path),
          },
    ),
    outDir: fromFileUrl(outDir),
    importMap: join(srcCopy, "deno.json"),
    shims: { deno: false },
    test: false,
    // Internal @executablemd deps are published tier-by-tier, so when building a
    // downstream package in CI its siblings are already on npm. For local builds
    // (before siblings are published) set DNT_SKIP_INSTALL=1 to skip the npm
    // install + type check that would otherwise 404 on the unpublished siblings.
    skipNpmInstall: skipInstall,
    typeCheck: skipInstall ? false : "single",
    declaration: "separate",
    scriptModule: false,
    skipSourceOutput: true,
    // Match the repo's TS target (ESNext) so modern APIs the sources rely on —
    // e.g. the ES2022 `new Error(msg, { cause })` form in cli.ts — type-check.
    compilerOptions: {
      target: "ES2022",
      lib: ["ESNext", "DOM"],
    },
    package: {
      name: config.name,
      version,
      description: config.description,
      license: "MIT",
      homepage: "https://executable.md",
      repository: {
        type: "git",
        url: "git+https://github.com/taras/executable.md.git",
      },
      bugs: { url: "https://github.com/taras/executable.md/issues" },
      dependencies,
    },
    async postBuild() {
      const license = new URL("LICENSE", repoRoot);
      try {
        await Deno.copyFile(fromFileUrl(license), fromFileUrl(new URL("LICENSE", outDir)));
      } catch {
        // LICENSE is optional
      }
    },
  });
} finally {
  await Deno.remove(buildRoot, { recursive: true }).catch(() => {});
}

console.log(`built ${config.name}@${version} -> ${config.dir}/npm`);
