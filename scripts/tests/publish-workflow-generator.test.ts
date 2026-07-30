/**
 * The generator's private-member rule, isolated over a fixture workspace.
 *
 * The repository's own private member cannot exercise it. `packages/web` also
 * carries no `deno.json` name, so the earlier identity check already excludes
 * it: delete the private rule and the repository assertions and the committed
 * `publish-packages.yml` are all unchanged. Only a member that holds a full
 * `@executablemd/` JSR identity *and* declares `"private": true` reaches the
 * rule, and the repository has none — by design, since a real private member is
 * withheld from JSR too.
 *
 * So the fixture supplies one, runs the real committed generator over it, and
 * checks the workflow it wrote.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = new URL("../../", import.meta.url);
const CONFIG = fileURLToPath(new URL("deno.json", REPO_ROOT));
const CLI = fileURLToPath(new URL("packages/cli/src/deno.ts", REPO_ROOT));
const GENERATOR = fileURLToPath(new URL("scripts/gen-publish-workflow.md", REPO_ROOT));

interface FixtureMember {
  dir: string;
  name: string;
  /** Merged over the member's `package.json`; this is where `private` goes. */
  pkgJson: Record<string, unknown>;
}

/**
 * Build a workspace of `members` and return the workflow the generator writes
 * for it. Every member gets a full JSR identity, so `private` is the only thing
 * that varies between cases.
 */
function* generate(members: FixtureMember[]): Operation<string> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "publish-workflow-"));
  yield* ensure(() => rm(base, { recursive: true, force: true }));
  const root = pathToFileURL(`${base}/`);

  yield* writeTextFile(
    new URL("deno.json", root),
    `${JSON.stringify({ workspace: ["packages/*"] })}\n`,
  );
  yield* ensureDir(new URL(".github/workflows/", root));

  for (const member of members) {
    yield* ensureDir(new URL(`${member.dir}/`, root));
    yield* writeTextFile(
      new URL(`${member.dir}/deno.json`, root),
      `${JSON.stringify({ name: member.name, version: "0.0.0", exports: { ".": "./mod.ts" } })}\n`,
    );
    yield* writeTextFile(
      new URL(`${member.dir}/package.json`, root),
      `${JSON.stringify({ name: member.name, version: "0.0.0", ...member.pkgJson })}\n`,
    );
  }

  yield* exec(Deno.execPath(), {
    arguments: ["run", "--allow-all", "--config", CONFIG, CLI, "run", GENERATOR],
    cwd: base,
  }).expect();

  return yield* readTextFile(new URL(".github/workflows/publish-packages.yml", root));
}

const ALPHA: FixtureMember = {
  dir: "packages/alpha",
  name: "@executablemd/alpha",
  pkgJson: {},
};

function beta(pkgJson: Record<string, unknown>): FixtureMember {
  return {
    dir: "packages/beta",
    name: "@executablemd/beta",
    pkgJson: { dependencies: { "@executablemd/alpha": "workspace:*" }, ...pkgJson },
  };
}

describe("publish-packages.yml generation", () => {
  it("withholds a member that carries a JSR identity and declares private", function* () {
    const workflow = yield* generate([ALPHA, beta({ private: true })]);

    expect(workflow).toContain("package: packages/alpha");
    expect(workflow).not.toContain("package: packages/beta");
    expect(workflow).not.toContain("packages/beta/deno.json");
  });

  it("publishes that same member, after its dependency, once private is cleared", function* () {
    const workflow = yield* generate([ALPHA, beta({})]);

    expect(workflow).toContain("package: packages/alpha");
    expect(workflow).toContain("package: packages/beta");
    expect(workflow).toContain("needs: [version, alpha]");
    expect(workflow).toContain("packages/beta/deno.json");
  });
});
