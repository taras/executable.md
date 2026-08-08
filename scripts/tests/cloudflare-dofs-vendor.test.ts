import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exec } from "@executablemd/runtime";
import { ensure } from "effection";

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

function* refused(edit: (copy: string) => void) {
  const temporary = mkdtempSync(join(tmpdir(), "xmd-dofs-drift-"));
  yield* ensure(() => {
    rmSync(temporary, { recursive: true, force: true });
  });
  const copy = join(temporary, "snapshot");
  cpSync(SNAPSHOT, copy, { recursive: true });
  edit(copy);
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
    const mismatch = yield* refused((copy) => {
      const path = join(copy, "MANIFEST.json");
      const manifest = readFileSync(path, "utf8");
      writeFileSync(path, manifest.replace(`"compiler": "${COMPILER}"`, '"compiler": "0.0.0"'));
    });

    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr).toContain("TypeScript compiler provenance mismatch");
    expect(mismatch.stderr).toContain("manifest:  0.0.0");
    expect(mismatch.stderr).toContain(`installed: ${COMPILER}`);
  });

  it("rejects changed source or generated output, missing, and extra files", function* () {
    const changed = yield* refused((copy) => {
      writeFileSync(join(copy, "upstream/src/path.ts"), "changed\n");
    });
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr).toContain("vendored file changed");

    const generated = yield* refused((copy) => {
      writeFileSync(join(copy, "generated/path.js"), "changed\n");
    });
    expect(generated.exitCode).not.toBe(0);
    expect(generated.stderr).toContain("vendored file changed");

    const missing = yield* refused((copy) => {
      unlinkSync(join(copy, "upstream/src/path.ts"));
    });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("vendored inventory differs");

    const extra = yield* refused((copy) => {
      writeFileSync(join(copy, "unrecorded.ts"), "export {};\n");
    });
    expect(extra.exitCode).not.toBe(0);
    expect(extra.stderr).toContain("vendored inventory differs");
  });
});
