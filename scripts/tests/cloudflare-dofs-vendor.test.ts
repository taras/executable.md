import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

function* refused(edit: (copy: string) => void) {
  const temporary = mkdtempSync(join(tmpdir(), "xmd-dofs-drift-"));
  yield* ensure(() => {
    rmSync(temporary, { recursive: true, force: true });
  });
  const copy = join(temporary, "snapshot");
  cpSync(SNAPSHOT, copy, { recursive: true });
  edit(copy);
  return yield* exec({
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
      copy,
    ],
    cwd: REPOSITORY,
  });
}

describe("Cloudflare Computer DOFS vendored snapshot", () => {
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
