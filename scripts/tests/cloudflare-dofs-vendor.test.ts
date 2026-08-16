import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exec } from "@executablemd/runtime";
import { until } from "effection";
import type { Operation } from "effection";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const SNAPSHOT = join(REPOSITORY, "packages/workflow/vendor/cloudflare-computer-dofs");
const VERIFY = join(REPOSITORY, "scripts/verify-cloudflare-dofs.ts");
const COMMIT = "63d363632e558f7e077794988d36ed75017c2a62";
const COMPILER = "5.9.3";

function verify(snapshot: string) {
  return exec({
    command: [
      process.execPath,
      "run",
      "--allow-read",
      "--allow-write=/tmp",
      "--allow-env",
      "--allow-run",
      "--cached-only",
      "--frozen",
      VERIFY,
      snapshot,
    ],
    cwd: REPOSITORY,
  });
}

function* refused(edit: (copy: string) => Operation<void>) {
  const temporary = yield* useTempDirectory("xmd-dofs-drift-");
  const copy = join(temporary, "snapshot");
  yield* until(cp(SNAPSHOT, copy, { recursive: true }));
  yield* edit(copy);
  return yield* verify(copy);
}

describe("Cloudflare Computer DOFS vendored snapshot", () => {
  it("verifies the unchanged snapshot and regenerates its deterministic output", function* () {
    const result = yield* verify(SNAPSHOT);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `verified Cloudflare Computer DOFS ${COMMIT}: 104 recorded files`,
    );
    expect(result.stdout).toContain(`regenerated with TypeScript ${COMPILER}`);
  });

  it("refuses mismatched compiler provenance", function* () {
    const mismatch = yield* refused(function* (copy) {
      const path = join(copy, "MANIFEST.json");
      const manifest = yield* readTextFile(path);
      yield* writeTextFile(
        path,
        manifest.replace(`"compiler": "${COMPILER}"`, '"compiler": "0.0.0"'),
      );
    });

    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr).toContain("TypeScript compiler provenance mismatch");
    expect(mismatch.stderr).toContain("manifest:  0.0.0");
    expect(mismatch.stderr).toContain(`installed: ${COMPILER}`);
  });

  it("rejects changed source or generated output, missing, and extra files", function* () {
    const changed = yield* refused(function* (copy) {
      yield* writeTextFile(join(copy, "upstream/src/path.ts"), "changed\n");
    });
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr).toContain("vendored file changed");

    const generated = yield* refused(function* (copy) {
      yield* writeTextFile(join(copy, "generated/path.js"), "changed\n");
    });
    expect(generated.exitCode).not.toBe(0);
    expect(generated.stderr).toContain("vendored file changed");

    const missing = yield* refused(function* (copy) {
      yield* rm(join(copy, "upstream/src/path.ts"));
    });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("vendored inventory differs");

    const extra = yield* refused(function* (copy) {
      yield* writeTextFile(join(copy, "unrecorded.ts"), "export {};\n");
    });
    expect(extra.exitCode).not.toBe(0);
    expect(extra.stderr).toContain("vendored inventory differs");
  });
});
