import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildNpmPackage } from "../build-npm.ts";
import type { BuildEvent } from "../build-npm.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The npm output directory for `pkgDir`. It stays on disk for the rest of the
 * test, so assertions can read the artifact, and is removed once the test
 * settles — whether the builder succeeded, failed, or the assertions threw.
 */
function* npmOutDir(pkgDir: string): Operation<string> {
  const outDir = path.join(ROOT, pkgDir, "npm");
  yield* ensure(() => rm(outDir, { recursive: true, force: true }));
  return outDir;
}

function* buildNpm(pkgDir: string) {
  // The builder's own output is an assertion subject, not test output.
  yield* Stdio.around({
    *stdout() {},
    *stderr() {},
  });

  // Deno.execPath() so the child builder runs the same executable as the suite.
  return yield* exec(Deno.execPath(), {
    arguments: ["run", "-A", "scripts/build-npm.ts", pkgDir, "0.4.2"],
    cwd: ROOT,
    env: { ...Deno.env.toObject(), DNT_SKIP_INSTALL: "1" },
  }).join();
}

/** Every file the generated package.json points at, as outDir-relative paths. */
function* declaredEntries(outDir: string): Operation<string[]> {
  const manifest = JSON.parse(yield* readTextFile(path.join(outDir, "package.json")));
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) {
        found.push(value.slice(2));
      }
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  for (const field of ["exports", "main", "module", "types", "bin"]) {
    visit(manifest[field]);
  }
  return found;
}

describe("build-npm skip-install mode", () => {
  it("refuses a package with workspace dependencies and names them", function* () {
    yield* npmOutDir("packages/acp");

    const result = yield* buildNpm("packages/acp");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("DNT_SKIP_INSTALL");
    expect(result.stderr).toContain("@executablemd/core");
    expect(result.stderr).toContain("@executablemd/runtime");
    expect(result.stdout).not.toContain("built @executablemd/acp");
  });

  it("leaves no output that could be mistaken for a current build", function* () {
    const outDir = yield* npmOutDir("packages/acp");

    yield* buildNpm("packages/acp");

    for (const generated of ["esm", "types", "package.json"]) {
      expect({ generated, exists: yield* exists(path.join(outDir, generated)) }).toEqual({
        generated,
        exists: false,
      });
    }
  });

  it("builds a package with no workspace dependencies", function* () {
    const outDir = yield* npmOutDir("packages/durable-streams");

    expect((yield* buildNpm("packages/durable-streams")).code).toBe(0);

    for (const entry of yield* declaredEntries(outDir)) {
      expect({ entry, exists: yield* exists(path.join(outDir, entry)) }).toEqual({
        entry,
        exists: true,
      });
    }
    expect(yield* exists(path.join(outDir, "esm/mod.js"))).toBe(true);

    for (const sibling of ["esm/core", "esm/runtime", "esm/durable-streams", "esm/acp"]) {
      expect({ sibling, exists: yield* exists(path.join(outDir, sibling)) }).toEqual({
        sibling,
        exists: false,
      });
    }

    const packed = yield* exec("npm", {
      arguments: ["pack", "--dry-run", "--json"],
      cwd: outDir,
    }).expect();
    const files: string[] = JSON.parse(packed.stdout)[0].files.map((f: { path: string }) => f.path);
    for (const entry of yield* declaredEntries(outDir)) {
      expect({ entry, packed: files.includes(entry) }).toEqual({ entry, packed: true });
    }
  });
});

/**
 * A version no `@executablemd/fixture-*` package has on npm, so nothing here
 * resolves unless the artifact beside it was the one consumed.
 */
const FIXTURE_VERSION = "9.9.9-closure";

function scoped(name: string): string {
  return `@executablemd/fixture-${name}`;
}

const C_SOURCE = `export interface CValue {\n  readonly c: string;\n}\nexport const c: CValue = { c: "c" };\n`;

function* member(
  root: URL,
  name: string,
  dependencies: Record<string, string>,
  source: string,
): Operation<void> {
  yield* ensureDir(new URL(`packages/${name}/`, root));
  yield* writeTextFile(
    new URL(`packages/${name}/deno.json`, root),
    `${JSON.stringify({ name: scoped(name), version: FIXTURE_VERSION, exports: "./mod.ts" }, null, 2)}\n`,
  );
  yield* writeTextFile(
    new URL(`packages/${name}/package.json`, root),
    `${JSON.stringify(
      { name: scoped(name), version: FIXTURE_VERSION, type: "module", dependencies },
      null,
      2,
    )}\n`,
  );
  yield* writeTextFile(new URL(`packages/${name}/mod.ts`, root), source);
}

/**
 * `a -> b -> c`, in a workspace of its own. Never the repository's members: the
 * point is a closure whose versions npm has never seen.
 */
function* closureWorkspace(): Operation<URL> {
  const base = yield* useTempDirectory("build-npm-closure-");
  const root = pathToFileURL(`${base}/`);

  yield* writeTextFile(
    new URL("deno.json", root),
    `${JSON.stringify({ workspace: ["packages/*"], imports: {} }, null, 2)}\n`,
  );

  // `b` takes a type from `c`, so `b`'s own typecheck resolves `c` through the
  // artifact phase 1 built for it. A chain of plain values would compile even
  // if `c` were never consumed as a package at all.
  yield* member(root, "c", {}, C_SOURCE);
  yield* member(
    root,
    "b",
    { [scoped("c")]: "workspace:*" },
    `import type { CValue } from "${scoped("c")}";\nimport { c } from "${scoped(
      "c",
    )}";\nexport const b: CValue = c;\n`,
  );
  yield* member(
    root,
    "a",
    { [scoped("b")]: "workspace:*" },
    `import { b } from "${scoped("b")}";\nexport const a = b.c + "a";\n`,
  );

  return root;
}

function* manifestOf(root: URL, name: string): Operation<Record<string, string>> {
  const text = yield* readTextFile(new URL(`packages/${name}/npm/package.json`, root));
  return JSON.parse(text).dependencies ?? {};
}

function localRange(root: URL, name: string): string {
  return `file:${fileURLToPath(new URL(`packages/${name}/npm`, root))}`;
}

/**
 * npm's supported packed-dependency layout, for the length of one case.
 *
 * By default npm symlinks a directory `file:` dependency, so a dependent can
 * reach whatever the sibling's own build left in its `node_modules` — which
 * hides what a finalized sibling would actually cost. `install-links=true`
 * packs and installs it as an ordinary dependency instead, so the sibling's own
 * manifest is the only thing that says where its dependencies come from.
 *
 * The cache and registry are invocation-private, and the registry is
 * unreachable, so a range that has to be resolved fails here rather than
 * depending on what npmjs.org happens to answer. The environment is restored
 * however the case ends: every other build in this file is the ordinary one.
 */
function* usePackedLocalDependencies(): Operation<void> {
  const cache = yield* useTempDirectory("npm-cache-");
  const scopedEnvironment: Record<string, string> = {
    NPM_CONFIG_INSTALL_LINKS: "true",
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:1/",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    // The unreachable registry is the expected outcome here, not a flake worth
    // waiting out; npm's default retries would spend minutes proving it.
    NPM_CONFIG_FETCH_RETRIES: "0",
  };

  const restore = new Map<string, string | undefined>(
    Object.keys(scopedEnvironment).map((key) => [key, Deno.env.get(key)]),
  );
  // Registered before anything is set, so a halt between the two still restores.
  yield* ensure(() => {
    for (const [key, value] of restore) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  });
  for (const [key, value] of Object.entries(scopedEnvironment)) {
    Deno.env.set(key, value);
  }
}

/**
 * The builder's own two phases, observed on a closure npm has never published.
 *
 * The repository's own members cannot tell a local closure apart from a
 * registry build, because every version they name is already on npm. These
 * fixtures can: nothing here resolves unless the artifact beside it was the one
 * consumed.
 */
describe("build-npm local closure", () => {
  it("N1: hands dnt the artifacts it just built, for the whole closure", function* () {
    const root = yield* closureWorkspace();
    const events: BuildEvent[] = [];

    yield* buildNpmPackage({
      repoRoot: root,
      package: "packages/a",
      version: FIXTURE_VERSION,
      *observe(event) {
        events.push(event);
      },
    });

    const started = events.filter((event) => event.type === "package-build-started");
    expect(started.map((event) => event.package)).toEqual([scoped("c"), scoped("b"), scoped("a")]);
    expect(started[1].dependencies).toEqual({ [scoped("c")]: localRange(root, "c") });
    expect(started[2].dependencies).toEqual({ [scoped("b")]: localRange(root, "b") });
  });

  it("N2: finalizes nothing until every build in the closure has returned", function* () {
    const root = yield* closureWorkspace();
    const events: BuildEvent[] = [];
    const atStartOfA: Record<string, string>[] = [];

    yield* buildNpmPackage({
      repoRoot: root,
      package: "packages/a",
      version: FIXTURE_VERSION,
      *observe(event) {
        events.push(event);
        if (event.type === "package-build-started" && event.package === scoped("a")) {
          // b is built by now, and must still name c locally. Once b
          // describes c by a registry range, whether a's install survives
          // depends on npm's layout and on b's own build residue — which is
          // exactly what this contract refuses to rest on.
          atStartOfA.push(yield* manifestOf(root, "b"));
        }
      },
    });

    expect(atStartOfA).toEqual([{ [scoped("c")]: localRange(root, "c") }]);

    const order = events.map((event) => event.type);
    const finalization = order.indexOf("closure-finalization-started");
    expect(finalization).toBeGreaterThan(-1);
    expect(order.lastIndexOf("package-build-completed")).toBeLessThan(finalization);
    expect(order.lastIndexOf("package-build-started")).toBeLessThan(finalization);
    expect(order.filter((type) => type === "package-manifest-finalized")).toHaveLength(3);
  });

  it("N3: leaves every manifest in the closure publishable", function* () {
    const root = yield* closureWorkspace();

    yield* buildNpmPackage({ repoRoot: root, package: "packages/a", version: FIXTURE_VERSION });

    expect(yield* manifestOf(root, "a")).toEqual({ [scoped("b")]: `^${FIXTURE_VERSION}` });
    expect(yield* manifestOf(root, "b")).toEqual({ [scoped("c")]: `^${FIXTURE_VERSION}` });
    expect(yield* manifestOf(root, "c")).toEqual({});

    const workspacePath = fileURLToPath(root).replace(/\/$/, "");
    for (const name of ["a", "b", "c"]) {
      const text = yield* readTextFile(new URL(`packages/${name}/npm/package.json`, root));
      expect({ name, leaked: text.includes(workspacePath) || text.includes("workspace:") }).toEqual(
        { name, leaked: false },
      );
    }
  });

  /**
   * N4. What an early-finalized `b` costs, once `b` is installed the way a
   * published `b` would be.
   *
   * The positive control comes first: packed local artifacts have to work
   * before a failure afterwards means anything.
   */
  it("N4: a child finalized before its dependent builds fails that build", function* () {
    yield* usePackedLocalDependencies();

    const sound = yield* closureWorkspace();
    yield* buildNpmPackage({ repoRoot: sound, package: "packages/a", version: FIXTURE_VERSION });
    expect(yield* manifestOf(sound, "b")).toEqual({ [scoped("c")]: `^${FIXTURE_VERSION}` });

    const broken = yield* closureWorkspace();
    const events: BuildEvent[] = [];
    let caught: unknown;

    try {
      yield* buildNpmPackage({
        repoRoot: broken,
        package: "packages/a",
        version: FIXTURE_VERSION,
        *observe(event) {
          events.push(event);
          if (event.type === "package-build-completed" && event.package === scoped("b")) {
            const manifest = new URL("packages/b/npm/package.json", broken);
            const parsed = JSON.parse(yield* readTextFile(manifest));
            parsed.dependencies[scoped("c")] = `^${FIXTURE_VERSION}`;
            yield* writeTextFile(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
          }
        },
      });
    } catch (error) {
      caught = error;
    }

    // `a` reached dnt, which is what makes the failure below evidence about the
    // mutation rather than about the observer that applied it: an observer that
    // threw would leave this list one short.
    expect(
      events
        .filter((event) => event.type === "package-build-started")
        .map((event) => event.package),
    ).toEqual([scoped("c"), scoped("b"), scoped("a")]);

    // And it failed where a registry range has to be resolved.
    expect(caught).toMatchObject({ message: "npm install failed with exit code 1" });

    // Before `a` completed and before anything was finalized: the closure never
    // reaches a state where a half-rewritten set could be mistaken for output.
    expect(events.map((event) => event.type)).not.toContain("closure-finalization-started");
    expect(
      events
        .filter((event) => event.type === "package-build-completed")
        .map((event) => event.package),
    ).toEqual([scoped("c"), scoped("b")]);
  });

  it("N5: refuses an internal dependency no workspace member declares", function* () {
    const root = yield* closureWorkspace();
    yield* member(
      root,
      "b",
      { [scoped("c")]: "workspace:*", [scoped("absent")]: "workspace:*" },
      `import { c } from "${scoped("c")}";\nexport const b = c;\n`,
    );
    let caught: unknown;

    try {
      yield* buildNpmPackage({ repoRoot: root, package: "packages/a", version: FIXTURE_VERSION });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      message: `"${scoped("b")}" depends on internal package "${scoped(
        "absent",
      )}", which is not a workspace member`,
    });
    // Refused before the dependent was built, so no artifact claims otherwise.
    expect(yield* exists(new URL("packages/b/npm/package.json", root))).toBe(false);
  });

  it("N5: refuses a publishable manifest that kept an unrelated local dependency", function* () {
    const root = yield* closureWorkspace();
    yield* ensureDir(new URL("vendor/local-dep/", root));
    yield* writeTextFile(
      new URL("vendor/local-dep/package.json", root),
      `${JSON.stringify({ name: "fixture-local-dep", version: "1.0.0", type: "module" }, null, 2)}\n`,
    );
    yield* writeTextFile(new URL("vendor/local-dep/index.js", root), "export default {};\n");
    yield* member(
      root,
      "c",
      { "fixture-local-dep": `file:${fileURLToPath(new URL("vendor/local-dep", root))}` },
      C_SOURCE,
    );
    let caught: unknown;

    try {
      yield* buildNpmPackage({ repoRoot: root, package: "packages/a", version: FIXTURE_VERSION });
    } catch (error) {
      caught = error;
    }

    // Consumable during dnt, refused at the gate: normalizing it away is what
    // would turn an unpublishable artifact into one npm would accept.
    expect(caught).toMatchObject({
      message: `${scoped("c")} cannot be published: dependencies["fixture-local-dep"] is the local range file:${fileURLToPath(
        new URL("vendor/local-dep", root),
      )}`,
    });
  });
});
