import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import { exists, readTextFile, rm } from "@effectionx/fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
