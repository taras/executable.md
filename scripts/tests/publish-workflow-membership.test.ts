import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";

import { listWorkspacePaths } from "../lib/workspace.ts";

const SCOPE = "@executablemd/";
const repoRoot = new URL("../../", import.meta.url);

interface Member {
  dir: string;
  isPrivate: boolean;
  hasJsrIdentity: boolean;
}

/**
 * Every `@executablemd` workspace member, identified by `package.json` name —
 * the identity both npm and the generator key membership on — together with
 * whether it is private and whether its `deno.json` carries a JSR identity
 * (`name` and `exports`). A private member omits both `deno.json` fields rather
 * than declaring an `exports`-less `name`, so it never warns on `deno install`
 * and `deno publish` finds no entry to publish.
 */
function* members(): Operation<Member[]> {
  const root = JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot)));
  const found: Member[] = [];
  for (const dir of yield* listWorkspacePaths(root.workspace, repoRoot)) {
    let denoJson;
    let pkgJson;
    try {
      denoJson = JSON.parse(yield* readTextFile(new URL(`${dir}/deno.json`, repoRoot)));
      pkgJson = JSON.parse(yield* readTextFile(new URL(`${dir}/package.json`, repoRoot)));
    } catch {
      continue;
    }
    if (typeof pkgJson.name !== "string" || !pkgJson.name.startsWith(SCOPE)) {
      continue;
    }
    found.push({
      dir,
      isPrivate: pkgJson.private === true,
      hasJsrIdentity: typeof denoJson.name === "string" && denoJson.exports !== undefined,
    });
  }
  return found;
}

function* workflow(): Operation<string> {
  return yield* readTextFile(new URL(".github/workflows/publish-packages.yml", repoRoot));
}

describe("publish-packages.yml membership", () => {
  it("publishes every non-private member to npm", function* () {
    const all = yield* members();
    const generated = yield* workflow();

    // Non-vacuous: the workspace always has publishable members.
    expect(all.filter((member) => !member.isPrivate).length).toBeGreaterThan(0);

    for (const member of all.filter((member) => !member.isPrivate)) {
      expect(generated).toContain(`package: ${member.dir}`);
    }
  });

  it("gives every non-private member a JSR identity and no private member one", function* () {
    for (const member of yield* members()) {
      expect({ dir: member.dir, jsr: member.hasJsrIdentity }).toEqual({
        dir: member.dir,
        jsr: !member.isPrivate,
      });
    }
  });

  /**
   * The exclusion itself is currently unexercised: `packages/web` was the one
   * private member, and it is published as of #195. The assertion is kept rather
   * than deleted because it costs nothing and starts working the moment a private
   * member exists again — but until one does, nothing here proves the generator
   * skips it, and the guarantee rests on §3 of the release spec alone.
   */
  it("withholds any private member from npm", function* () {
    const withheld = (yield* members()).filter((member) => member.isPrivate);
    const generated = yield* workflow();

    for (const member of withheld) {
      expect(generated).not.toContain(`package: ${member.dir}`);
    }
  });
});
