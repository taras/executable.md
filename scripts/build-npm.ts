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

await main(function* (args) {
  const repoRoot = new URL("../", import.meta.url);

  const rootPkg = JSON.parse(yield* readTextFile(new URL("package.json", repoRoot))) as {
    dependencies: Record<string, string>;
  };
  const rootDeno = JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))) as {
    imports: Record<string, string>;
  };

  // Version range from the single sources of truth: root package.json
  // dependencies, falling back to the root deno.json import map (npm:
  // specifiers, e.g. "npm:configliere@^0.2.3").
  const depVersion = (name: string): string => {
    const fromPkg = rootPkg.dependencies[name];
    if (fromPkg) return fromPkg;
    const spec = rootDeno.imports[name];
    if (spec?.startsWith("npm:")) {
      const at = spec.lastIndexOf("@");
      if (at > "npm:".length) return spec.slice(at + 1);
    }
    throw new Error(`no version for "${name}" in root package.json or deno.json`);
  };

  const pkgKey = args[0];
  const version = args[1] ?? "0.0.0-dev";
  const skipInstall = Deno.env.get("DNT_SKIP_INSTALL") === "1";

  const config = PACKAGES[pkgKey];
  if (!config) {
    console.error(`unknown package "${pkgKey}". known: ${Object.keys(PACKAGES).join(", ")}`);
    yield* exit(1);
    return;
  }

  const pkgDir = new URL(`${config.dir}/`, repoRoot);
  const outDir = new URL("npm/", pkgDir);

  yield* emptyDir(fromFileUrl(outDir));

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
  const buildRoot = yield* until(mkdtemp(join(tmpdir(), `dnt-${pkgKey}-`)));
  const srcCopy = join(buildRoot, "pkg");
  yield* until(cp(fromFileUrl(pkgDir), srcCopy, { recursive: true }));
  for (const excluded of ["npm", "tests", "node_modules", "demo"]) {
    yield* rm(join(srcCopy, excluded), { recursive: true, force: true });
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
  yield* writeTextFile(
    join(srcCopy, "deno.json"),
    JSON.stringify({ imports: isolatedImports }, null, 2),
  );

  try {
    yield* until(
      build({
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
        // dnt's postBuild runs npm install first; copy LICENSE afterwards instead.
      }),
    );
  } finally {
    yield* rm(buildRoot, { recursive: true, force: true });
  }

  const license = new URL("LICENSE", repoRoot);
  if (yield* exists(license)) {
    yield* copyFile(license, new URL("LICENSE", outDir));
  }

  console.log(`built ${config.name}@${version} -> ${config.dir}/npm`);
});
