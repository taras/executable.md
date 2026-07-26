/**
 * `@executablemd/testing` used to depend on `@std/assert`, which dnt emitted as
 * `npm:@jsr/std__assert` — a package the default npm registry does not serve.
 * That single dependency made `npm install @executablemd/cli` fail for anyone
 * who had not configured `@jsr:registry`, and it is why the build wrote an
 * `.npmrc` into its own output directory.
 *
 * This suite proves the dependency is gone at the boundary that matters: build
 * the package the normal way, then install the emitted tarball into a scratch
 * directory using npm's *default* configuration. The install runs outside the
 * repository, with no `.npmrc` of its own, and with the machine's user and
 * global npm config pointed at empty files — otherwise an ambient
 * `@jsr:registry` on the developer's box or a CI runner would mask a
 * regression and the test would prove nothing.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import type { ProcessResult } from "@effectionx/process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PKG_DIR = "packages/testing";
const OUT_DIR = path.join(ROOT, PKG_DIR, "npm");

/** A scratch root outside the repository, so no repo `.npmrc` is in scope. */
function* scratchDir(): Operation<string> {
  const dir = Deno.makeTempDirSync({ prefix: "executablemd-npm-install-" });
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function* buildTestingPackage(version: string): Operation<ProcessResult> {
  // The builder narrates every file it emits; only its exit code matters here.
  yield* Stdio.around({
    *stdout() {},
    *stderr() {},
  });

  return yield* exec(Deno.execPath(), {
    arguments: ["run", "-A", "scripts/build-npm.ts", PKG_DIR, version],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      // @effectionx/* peer-depend on effection `^3 || ^4`, which npm will not
      // match against the pinned 4.x prerelease — the same allowance
      // publish-one.yml makes.
      NPM_CONFIG_LEGACY_PEER_DEPS: "true",
    },
  }).join();
}

/**
 * npm's environment with every source of ambient configuration neutralized.
 * `userconfig` and `globalconfig` point at empty files, so a developer's
 * `~/.npmrc` cannot supply the `@jsr` mapping this test exists to prove
 * unnecessary. Any `npm_config_*` variable already in the environment is
 * dropped for the same reason.
 */
function* pristineNpmEnv(scratch: string): Operation<Record<string, string>> {
  // Two separate files: npm refuses to load one path as both user and global.
  const userConfig = path.join(scratch, "empty-user-npmrc");
  const globalConfig = path.join(scratch, "empty-global-npmrc");
  yield* writeTextFile(userConfig, "");
  yield* writeTextFile(globalConfig, "");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (key.toLowerCase().startsWith("npm_config_")) {
      continue;
    }
    env[key] = value;
  }
  env.npm_config_userconfig = userConfig;
  env.npm_config_globalconfig = globalConfig;
  env.npm_config_registry = "https://registry.npmjs.org/";
  env.npm_config_legacy_peer_deps = "true";
  return env;
}

describe("npm install with default registry configuration", () => {
  it("installs the built testing package without a @jsr registry mapping", function* () {
    yield* ensure(() => rm(OUT_DIR, { recursive: true, force: true }));
    const manifest = JSON.parse(yield* readTextFile(path.join(ROOT, PKG_DIR, "deno.json")));

    const built = yield* buildTestingPackage(manifest.version ?? "0.0.0-dev");
    if (built.code !== 0) {
      throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
    }

    // The emitted manifest is the contract users resolve against.
    const emitted = JSON.parse(yield* readTextFile(path.join(OUT_DIR, "package.json")));
    const jsrDeps = Object.entries(emitted.dependencies ?? {}).filter(
      ([name, range]) => name.startsWith("@jsr/") || String(range).includes("@jsr/"),
    );
    expect(jsrDeps).toEqual([]);

    const scratch = yield* scratchDir();
    const packed = yield* exec("npm", {
      arguments: ["pack", "--pack-destination", scratch, "--json"],
      cwd: OUT_DIR,
    }).join();
    if (packed.code !== 0) {
      throw new Error(`npm pack exited ${packed.code}\n${packed.stderr}`);
    }
    const tarball = path.join(scratch, JSON.parse(packed.stdout)[0].filename);

    const project = path.join(scratch, "project");
    Deno.mkdirSync(project);
    yield* writeTextFile(
      path.join(project, "package.json"),
      JSON.stringify({ name: "install-probe", private: true, version: "0.0.0" }, null, 2),
    );

    const installed = yield* exec("npm", {
      arguments: ["install", "--no-audit", "--no-fund", tarball],
      cwd: project,
      env: yield* pristineNpmEnv(scratch),
    }).join();

    // A surviving @jsr dependency fails here as
    // `404 Not Found - GET https://registry.npmjs.org/@jsr%2f...`.
    if (installed.code !== 0) {
      throw new Error(`npm install exited ${installed.code}\n${installed.stderr}`);
    }
    expect(installed.stderr).not.toContain("@jsr");
  });
});
