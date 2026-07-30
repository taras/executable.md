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
 * (`name` and `exports`). A private member such as `packages/web` omits both
 * `deno.json` fields rather than declaring `exports`-less `name`, so it never
 * warns on `deno install` and `deno publish` finds no entry to publish.
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

describe("publish-packages.yml private-member exclusion", () => {
  it("publishes every non-private member to npm and withholds every private one", function* () {
    const all = yield* members();
    const published = all.filter((member) => !member.isPrivate);
    const withheld = all.filter((member) => member.isPrivate);

    // Without a private member the exclusion would pass vacuously.
    expect(withheld.length).toBeGreaterThan(0);

    const generated = yield* workflow();
    for (const member of published) {
      expect(generated).toContain(`package: ${member.dir}`);
    }
    for (const member of withheld) {
      expect(generated).not.toContain(`package: ${member.dir}`);
    }
  });

  it("gives every non-private member a JSR identity and no private member one", function* () {
    const all = yield* members();

    for (const member of all) {
      expect(member.hasJsrIdentity).toBe(!member.isPrivate);
    }
  });

  it("withholds @executablemd/web from both npm and JSR", function* () {
    const all = yield* members();
    const web = all.find((member) => member.dir === "packages/web");

    expect(web?.isPrivate).toBe(true);
    expect(web?.hasJsrIdentity).toBe(false);
    expect(yield* workflow()).not.toContain("package: packages/web");
  });
});
