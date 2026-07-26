/**
 * The npm CLI is produced by dnt, not by `deno compile`, and nothing else in
 * the repository runs that build: `deno task check`, the compiled-binary
 * smoke test and the Deno suite all type-check and execute the source against
 * Deno, where a bare `Deno.*` global is perfectly valid. In the Node output
 * the same global fails to compile and, once compiled, fails at runtime —
 * which is how `@executablemd/cli@0.5.0` missed npm.
 *
 * This suite closes that gap the only way that proves anything: build
 * packages/cli exactly as the release workflow does, then run the emitted bin
 * under Node through the test-agent smoke document. That document drives a
 * full session/prompt/text path, so the Node parent has to relaunch *itself*
 * as `xmd test-agent` for the run to pass.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { rm } from "@effectionx/fs";
import { timebox } from "@effectionx/timebox";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PKG_DIR = "packages/cli";
const OUT_DIR = path.join(ROOT, PKG_DIR, "npm");
const BIN = path.join(OUT_DIR, "esm/src/cli.js");
const DOC = path.join(ROOT, "smoke-test/test-agent/README.md");
const INTERNAL_SCOPE = "@executablemd/";

/** npm install and a full dnt type-check dominate this; the run itself is quick. */
const TIMEOUT = 600_000;

interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
}

/**
 * Read synchronously: the skip decision below happens while the module is
 * evaluated, before any test registers, and the repository forbids `await`
 * outside Effection operations.
 */
function readManifest(...segments: string[]): Manifest {
  return JSON.parse(Deno.readTextFileSync(path.join(ROOT, ...segments)));
}

/** Run npm and hand back stdout, or `undefined` when it fails. */
function npmQuery(args: string[]): string | undefined {
  const result = new Deno.Command("npm", {
    args,
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return result.success ? new TextDecoder().decode(result.stdout) : undefined;
}

/**
 * Every workspace member's declared version, keyed by package name — the same
 * map build-npm.ts builds to pin internal dependencies.
 */
function workspaceVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const entry of Deno.readDirSync(path.join(ROOT, "packages"))) {
    if (!entry.isDirectory) {
      continue;
    }
    try {
      const manifest = readManifest("packages", entry.name, "deno.json");
      if (manifest.name?.startsWith(INTERNAL_SCOPE) && manifest.version) {
        versions[manifest.name] = manifest.version;
      }
    } catch {
      // Not every packages/* member is a publishable Deno package.
    }
  }
  return versions;
}

/**
 * The internal dependency specifiers that prevent this build from running
 * against the default registry today.
 *
 * dnt resolves each `workspace:*` sibling to `^<its declared version>` and
 * installs it from the registry to type-check against, so packages/cli builds
 * only once its siblings are published, at the version the manifests declare
 * and free of `@jsr/*` dependencies — the same rule the DNT_SKIP_INSTALL
 * refusal already enforces. Both conditions hold on an ordinary branch and
 * throughout a release, where packages publish in dependency order. Neither
 * holds on a release-bump branch (the manifests name a version no publish has
 * produced), and the second does not hold until the first release after
 * `@std/assert` was dropped. Naming the specifiers keeps such a skip legible
 * instead of letting it read as a pass.
 */
function unbuildableSiblings(): string[] {
  const versions = workspaceVersions();
  const cli = readManifest(PKG_DIR, "package.json");
  const missing: string[] = [];
  for (const [name, range] of Object.entries(cli.dependencies ?? {})) {
    if (!name.startsWith(INTERNAL_SCOPE) || !range.startsWith("workspace:")) {
      continue;
    }
    const declared = versions[name];
    if (!declared) {
      missing.push(`${name} (no workspace version)`);
      continue;
    }
    const spec = `${name}@^${declared}`;
    if (npmQuery(["view", spec, "version"]) === undefined) {
      missing.push(spec);
      continue;
    }
    // A sibling published before the @std/assert removal still declares
    // `@jsr/std__assert`, which the default registry does not serve. dnt
    // installs that published sibling to type-check against, and the build no
    // longer writes an `.npmrc`, so the build cannot succeed until a clean
    // version of the sibling is on npm.
    const deps = npmQuery(["view", spec, "dependencies", "--json"]) ?? "";
    if (deps.includes("@jsr/")) {
      missing.push(`${spec} (published copy still depends on @jsr/*)`);
    }
  }
  return missing;
}

function* buildCliPackage(version: string): Operation<ProcessResult> {
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

/** Run the built bin under Node, the way an `npm i -g @executablemd/cli` user would. */
function* runEmittedBin(args: string[]): Operation<ProcessResult> {
  const result = yield* timebox<ProcessResult>(TIMEOUT, function* () {
    return yield* exec("node", {
      arguments: [BIN, ...args],
      cwd: ROOT,
      env: Deno.env.toObject(),
    }).join();
  });
  if (result.timeout) {
    throw new Error("the emitted npm bin timed out");
  }
  return result.value;
}

const unbuildable = unbuildableSiblings();

describe("npm CLI package", { sanitizeOps: false, sanitizeResources: false }, () => {
  if (unbuildable.length > 0) {
    it.skip(`relaunches its test-agent worker under Node — blocked on ${unbuildable.join(", ")}`);
    return;
  }

  it("relaunches its test-agent worker under Node", function* () {
    yield* ensure(() => rm(OUT_DIR, { recursive: true, force: true }));
    const { version } = readManifest(PKG_DIR, "deno.json");

    const built = yield* buildCliPackage(version ?? "0.0.0-dev");
    if (built.code !== 0) {
      throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
    }

    const run = yield* runEmittedBin(["test", DOC]);
    // The document asserts both replies itself, so a non-zero exit means the
    // Node parent never got a worker to answer them.
    if (run.code !== 0) {
      throw new Error(`the emitted npm bin exited ${run.code}\n${run.stderr}`);
    }

    expect(run.stdout).toContain("The review of **packages/core** at `abc123` passed.");
    expect(run.stdout).toContain("The review of **packages/core** passed.");
    expect(run.stdout).not.toContain("ERROR");
  });
});
