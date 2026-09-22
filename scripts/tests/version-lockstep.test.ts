import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { pathToFileURL } from "node:url";

import { parseBunLockfile } from "../lib/bun-lockfile.ts";
import { publishableMembers, publishedName } from "../lib/publishable-members.ts";
import { versionLockstepFindings } from "../lib/version-lockstep.ts";

const repoRoot = new URL("../../", import.meta.url);

interface MemberSpec {
  dir: string;
  /** `deno.json`'s name; omitted writes no `deno.json` at all. */
  denoName?: string;
  /** `package.json`'s name; omitted writes no `package.json` at all. */
  packageName?: string;
  /** What both manifests declare, unless `denoVersion` overrides `deno.json`. */
  version?: string;
  denoVersion?: string;
  private?: boolean;
  /** What `bun.lock` records; omitted writes no entry for the member. */
  locked?: string;
}

/** A workspace of `members`, with the `bun.lock` their `locked` versions describe. */
function* workspace(members: MemberSpec[]): Operation<URL> {
  const base = yield* useTempDirectory("version-lockstep-");
  const root = pathToFileURL(`${base}/`);

  yield* writeTextFile(
    new URL("deno.json", root),
    `${JSON.stringify({ workspace: ["packages/*"] }, null, 2)}\n`,
  );

  const entries = ['    "": {\n      "name": "root",\n    },'];
  for (const member of members) {
    yield* ensureDir(new URL(`packages/${member.dir}/`, root));
    if (member.denoName !== undefined) {
      yield* writeTextFile(
        new URL(`packages/${member.dir}/deno.json`, root),
        `${JSON.stringify(
          {
            name: member.denoName,
            version: member.denoVersion ?? member.version,
            exports: "./mod.ts",
          },
          null,
          2,
        )}\n`,
      );
    }
    if (member.packageName !== undefined) {
      yield* writeTextFile(
        new URL(`packages/${member.dir}/package.json`, root),
        `${JSON.stringify(
          { name: member.packageName, version: member.version, private: member.private },
          null,
          2,
        )}\n`,
      );
    }
    if (member.locked !== undefined) {
      entries.push(`    "packages/${member.dir}": {\n      "version": "${member.locked}",\n    },`);
    }
  }

  // Written with the trailing commas Bun writes, so every case reads the
  // lockfile through the same parse the repository's own does.
  yield* writeTextFile(
    new URL("bun.lock", root),
    `{\n  "lockfileVersion": 1,\n  "workspaces": {\n${entries.join("\n")}\n  },\n}\n`,
  );

  return root;
}

/** One publishable member, in lockstep, as the baseline every case varies. */
const SCOPED: MemberSpec = {
  dir: "scoped",
  denoName: "@executablemd/scoped",
  packageName: "@executablemd/scoped",
  version: "1.0.0",
  locked: "1.0.0",
};

describe("publishedName", () => {
  it("names a member from deno.json, whatever package.json calls it", function* () {
    expect(publishedName({ name: "@executablemd/renamed" }, { name: "renamed-on-npm" })).toEqual(
      "@executablemd/renamed",
    );
  });

  /**
   * The inverse, and the reason identity cannot come from `package.json`: this
   * member publishes nothing, because the publish generator and the npm
   * builder both read `deno.json`.
   */
  it("names no member whose scope is only in package.json", function* () {
    expect(
      publishedName({ name: "local-tool" }, { name: "@executablemd/looks-published" }),
    ).toBeUndefined();
  });

  it("names no private member", function* () {
    const withheld = { name: "@executablemd/support" };
    expect(
      publishedName(withheld, { name: "@executablemd/support", private: true }),
    ).toBeUndefined();
  });

  it("names no member that declares no name at all", function* () {
    expect(publishedName({ version: "1.0.0" }, { name: "@executablemd/nameless" })).toBeUndefined();
  });
});

describe("versionLockstepFindings", () => {
  it("reports nothing when every manifest and the lockfile agree", function* () {
    const root = yield* workspace([SCOPED]);

    expect(yield* versionLockstepFindings(root)).toEqual([]);
    // Non-vacuous: a walk that found no members would report nothing too.
    expect((yield* publishableMembers(root)).map((member) => member.dir)).toEqual([
      "packages/scoped",
    ]);
  });

  it("reports a member the bump left behind", function* () {
    const root = yield* workspace([
      SCOPED,
      {
        dir: "behind",
        denoName: "@executablemd/behind",
        packageName: "@executablemd/behind",
        version: "0.9.0",
        locked: "0.9.0",
      },
    ]);

    expect(yield* versionLockstepFindings(root)).toEqual([
      "the workspace declares more than one version: 0.9.0 (packages/behind/deno.json, " +
        "packages/behind/package.json); 1.0.0 (packages/scoped/deno.json, " +
        "packages/scoped/package.json)",
    ]);
  });

  it("reports one member whose two manifests disagree", function* () {
    const root = yield* workspace([{ ...SCOPED, denoVersion: "0.9.0" }]);

    expect(yield* versionLockstepFindings(root)).toEqual([
      "the workspace declares more than one version: 0.9.0 (packages/scoped/deno.json); " +
        "1.0.0 (packages/scoped/package.json)",
    ]);
  });

  it("reports a manifest that declares no version", function* () {
    const root = yield* workspace([
      { dir: "scoped", denoName: "@executablemd/scoped", packageName: "@executablemd/scoped" },
    ]);

    expect(yield* versionLockstepFindings(root)).toEqual([
      "packages/scoped/deno.json declares no version",
      "packages/scoped/package.json declares no version",
      "bun.lock has no workspace entry for packages/scoped",
    ]);
  });

  /**
   * The member the reviewed commit let through: the publish workflow generates
   * a job for it, so the release version has to cover it too.
   */
  it("holds a member whose npm name differs from its JSR name", function* () {
    const root = yield* workspace([
      SCOPED,
      {
        dir: "renamed",
        denoName: "@executablemd/renamed",
        packageName: "renamed-on-npm",
        version: "0.9.0",
        locked: "0.9.0",
      },
    ]);

    expect(yield* versionLockstepFindings(root)).toEqual([
      "the workspace declares more than one version: 0.9.0 (packages/renamed/deno.json, " +
        "packages/renamed/package.json); 1.0.0 (packages/scoped/deno.json, " +
        "packages/scoped/package.json)",
    ]);
  });

  it("holds no private member to the release version", function* () {
    const root = yield* workspace([
      SCOPED,
      {
        dir: "support",
        denoName: "@executablemd/support",
        packageName: "@executablemd/support",
        version: "0.0.0",
        private: true,
      },
    ]);

    expect(yield* versionLockstepFindings(root)).toEqual([]);
  });

  it("holds no member outside the @executablemd scope to it either", function* () {
    const root = yield* workspace([
      SCOPED,
      { dir: "outside", denoName: "outside-tool", packageName: "outside-tool", version: "7.7.7" },
    ]);

    expect(yield* versionLockstepFindings(root)).toEqual([]);
  });

  it("reports a member the lockfile has never heard of", function* () {
    const root = yield* workspace([{ ...SCOPED, locked: undefined }]);

    expect(yield* versionLockstepFindings(root)).toEqual([
      "bun.lock has no workspace entry for packages/scoped",
    ]);
  });

  it("reports a lockfile entry left at the previous release", function* () {
    const root = yield* workspace([{ ...SCOPED, locked: "0.9.0" }]);

    expect(yield* versionLockstepFindings(root)).toEqual([
      "bun.lock records packages/scoped at 0.9.0, not 1.0.0",
    ]);
  });

  /**
   * The gate against the tree it guards. `packages/git` reached `main` at
   * `0.12.1` while every sibling moved to `0.13.0`, and `v0.13.0` published
   * binaries and no packages because only the package gate read every
   * manifest — this is that state, asserted where a pull request can see it.
   */
  it("holds this workspace in lockstep", function* () {
    expect(yield* versionLockstepFindings(repoRoot)).toEqual([]);
    expect((yield* publishableMembers(repoRoot)).length).toBeGreaterThan(1);
  });
});

describe("parseBunLockfile", () => {
  it("reads the workspace members Bun's trailing commas would hide from JSON", function* () {
    const parsed = parseBunLockfile(
      `{\n  "workspaces": {\n    "packages/one": {\n      "version": "1.2.3",\n    },\n  },\n}\n`,
    );

    expect(parsed).toEqual({ "packages/one": { version: "1.2.3" } });
  });

  it("keeps a comma that closes nothing because it is inside a string", function* () {
    const parsed = parseBunLockfile(
      `{\n  "workspaces": {\n    "packages/one": {\n      "name": "weird, }",\n      "version": "1.2.3",\n    },\n  },\n}\n`,
    );

    expect(parsed["packages/one"]).toEqual({ name: "weird, }", version: "1.2.3" });
  });
});
