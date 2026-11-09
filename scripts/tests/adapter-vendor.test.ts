/**
 * Tier AD — the embedded ACP adapter snapshots
 * (packages/acp/vendor/adapters/PROVENANCE.md).
 *
 * This build runs its own adapters rather than whatever `npx` resolves, because
 * no published Codex or Claude release names the turn a Prompt completed. That
 * is a temporary arrangement carried in the repository, and a vendored artifact
 * nobody re-checks becomes a fork by accident.
 *
 * These checks are offline and byte-level: each tarball matches its manifest,
 * the embedded module carries exactly those bytes, the declared identities are
 * the recorded source commits, the licence travels, and the snapshot carries
 * no provider CLI.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { AdapterManifest } from "../lib/adapter-manifest.ts";
import { ClaudeRecipe } from "../lib/claude-recipe.ts";
import { sha256 } from "../lib/claude-snapshot-module.ts";
import { embeddedAdapterIdentities } from "@executablemd/acp/embedded-adapters";

const VENDOR = "packages/acp/vendor/adapters";

/** Exact source commits carried by the adapter snapshots. */
const PINNED = {
  codex: {
    upstreamBase: "50f69e57ca761ccafd2ca29de7fb591068277516",
    patchedCommit: "e1a15637c13e85cca05cd8ba398c5cef92dcaf33",
  },
  claude: {
    upstreamBase: "8710ce1cbccf562cb04b4bcc30e053e960aee05f",
    patchedCommit: "e3a6ceb7a50e1151fb49322ea83d331a4c8b74ca",
  },
} as const;

/**
 * Every file the archive actually contains, read from its own tar headers.
 *
 * The manifest's list is what a reviewer reads instead of unpacking, so
 * comparing that list against itself proves nothing. This walks the 512-byte
 * header blocks so the comparison is against the archive.
 */
function archiveInventory(tarball: Uint8Array): string[] {
  return [...archiveFiles(tarball).keys()].sort();
}

function archiveFiles(tarball: Uint8Array): Map<string, Buffer> {
  const raw = gunzipSync(tarball);
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= raw.length; ) {
    const header = raw.subarray(at, at + 512);
    // Two consecutive zero blocks end the archive.
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = Buffer.from(header.subarray(0, 100)).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(
      Buffer.from(header.subarray(124, 136)).toString("utf8").replace(/\0.*$/, "").trim(),
      8,
    );
    const type = String.fromCharCode(header[156] ?? 0);
    // '0' and '\0' are ordinary files; directories and metadata entries are not
    // what the manifest lists.
    if (type === "0" || type === "\0") {
      files.set(name, raw.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil((Number.isNaN(size) ? 0 : size) / 512) * 512;
  }
  return files;
}

function* manifest() {
  return AdapterManifest.parse(
    JSON.parse(yield* until(readFile(join(VENDOR, "MANIFEST.json"), "utf8"))),
  ).snapshots;
}

function* snapshotBytes(snapshot: { provider: string; tarball?: string }): Operation<Uint8Array> {
  if (snapshot.tarball) {
    return yield* until(readFile(join(VENDOR, snapshot.tarball)));
  }
  const embedded = embeddedAdapterIdentities().find(
    (entry) => entry.provider === snapshot.provider,
  );
  if (!embedded) {
    throw new Error(`Missing snapshot ${snapshot.provider}`);
  }
  return Buffer.from(embedded.base64, "base64");
}

describe("Tier AD — embedded ACP adapter snapshots", () => {
  it("AD1: every tarball matches its recorded digest and length", function* () {
    for (const snapshot of yield* manifest()) {
      const bytes = yield* snapshotBytes(snapshot);
      expect({
        tarball: "tarball" in snapshot ? snapshot.tarball : snapshot.recipe,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      }).toEqual({
        tarball: "tarball" in snapshot ? snapshot.tarball : snapshot.recipe,
        sha256: snapshot.sha256,
        byteLength: snapshot.byteLength,
      });
    }
  });

  it("AD2: the embedded module carries exactly those bytes", function* () {
    const declared = yield* manifest();
    const embedded = embeddedAdapterIdentities();

    // The module is what every distribution actually runs; the tarball beside it
    // is what a reader can inspect. A drift between them would mean the file
    // reviewed and the bytes executed are different things.
    expect(embedded.map((snapshot) => snapshot.provider)).toEqual(
      declared.map((snapshot) => snapshot.provider),
    );
    for (const snapshot of embedded) {
      const bytes = Buffer.from(snapshot.base64, "base64");
      expect({
        provider: snapshot.provider,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      }).toEqual({
        provider: snapshot.provider,
        sha256: snapshot.sha256,
        byteLength: snapshot.byteLength,
      });
    }
  });

  it("AD3: each snapshot names the exact source commits", function* () {
    for (const snapshot of yield* manifest()) {
      const reviewed = snapshot.provider === "claude" ? PINNED.claude : PINNED.codex;
      // Pinned in this file as well as in the manifest: a snapshot rebuilt from
      // some other commit would otherwise rewrite the record of what it is and
      // still pass every byte check above.
      expect({ provider: snapshot.provider, ...reviewed }).toEqual({
        provider: snapshot.provider,
        upstreamBase: snapshot.upstreamBase,
        patchedCommit: snapshot.patchedCommit,
      });
      expect(snapshot.license).toBe("Apache-2.0");
      expect(snapshot.buildCommand).toBe(
        snapshot.provider === "claude"
          ? "deno task deps"
          : "git apply adapter.patch && npm ci --ignore-scripts && npm run build && npm pack --ignore-scripts",
      );
    }
  });

  it("AD4: the manifest inventory is exactly what the archive contains", function* () {
    for (const snapshot of yield* manifest()) {
      const bytes = yield* snapshotBytes(snapshot);

      // The archive's own answer, not the manifest compared with itself. A file
      // added to or dropped from the tarball has to show up here, because this
      // is the list a reviewer trusts instead of unpacking.
      expect({
        tarball: "tarball" in snapshot ? snapshot.tarball : snapshot.recipe,
        files: archiveInventory(bytes),
      }).toEqual({
        tarball: "tarball" in snapshot ? snapshot.tarball : snapshot.recipe,
        files: [...snapshot.files].sort(),
      });

      expect(snapshot.files.some((name) => name.endsWith("package.json"))).toBe(true);
      expect(snapshot.files.some((name) => name.endsWith("LICENSE"))).toBe(true);
      // The agent itself is a dependency, never a vendored byte. A snapshot
      // carrying one would be this repository redistributing somebody's CLI.
      expect(snapshot.files.some((name) => /claude$|\/codex$|\.node$/.test(name))).toBe(false);
      expect(bytes.byteLength).toBeLessThan(4_000_000);
    }
  });

  it("AD5: each vendored provider ships the upstream licence beside it", function* () {
    for (const snapshot of yield* manifest()) {
      const directory = join(VENDOR, snapshot.provider);
      const present = yield* until(readdir(directory));
      expect(present).toContain("LICENSE");
      const licence = yield* until(readFile(join(directory, "LICENSE"), "utf8"));
      expect(licence).toContain("Apache License");
    }
  });

  it("AD6: the manifest inventory is exact — no extra or missing snapshot", function* () {
    const declared = yield* manifest();
    const providers = new Set(declared.map((snapshot) => snapshot.provider));
    // Both providers, because Codex-only delivery does not satisfy the contract
    // this vendoring exists for.
    expect([...providers].sort()).toEqual(["claude", "codex"]);
    for (const snapshot of declared) {
      expect(snapshot.contract).toMatch(/^_meta\./);
      // A second contract of its own, not an overload of the first: which turn
      // completed and whether a backend accepted one are different claims, and
      // an adapter can carry either without the other.
      expect(snapshot.materializationContract).toContain("executablemd.session-materialization/v1");
    }

    // Identity confirmation is independent of allocation provenance.
    expect(
      Object.fromEntries(
        declared.map((snapshot) => [snapshot.provider, snapshot.identityContract]),
      ),
    ).toEqual({ codex: "_meta.agentSessionId", claude: "_meta.agentSessionId" });
    for (const snapshot of declared) {
      if (snapshot.identityContract !== undefined) {
        expect(snapshot.identityContract).toMatch(/^_meta\./);
      }
    }
  });
  it("AD7: Claude carries exactly the reviewed runtime, metadata and separate SDK terms", function* () {
    const recipe = ClaudeRecipe.parse(
      JSON.parse(yield* until(readFile(join(VENDOR, "claude/recipe.json"), "utf8"))),
    );
    const snapshot = embeddedAdapterIdentities().find((entry) => entry.provider === "claude");
    if (!snapshot) {
      throw new Error("Claude snapshot missing");
    }
    const files = archiveFiles(Buffer.from(snapshot.base64, "base64"));
    expect([...files.keys()].sort()).toEqual(recipe.files.map((path) => `package/${path}`).sort());
    for (const [path, expected] of Object.entries(recipe.runtime)) {
      const bytes = files.get(`package/${path}`);
      if (!bytes) {
        throw new Error(`Missing executable ${path}`);
      }
      expect({ path, sha256: sha256(bytes) }).toEqual({ path, sha256: expected });
    }
    const pkg = JSON.parse(files.get("package/package.json")!.toString("utf8"));
    expect(pkg.dependencies).toEqual({
      "@agentclientprotocol/sdk": "1.3.0",
      zod: "^3.25.0 || ^4.0.0",
    });
    expect(pkg.scripts).toBeUndefined();
    expect(pkg.types).toBeUndefined();
    expect(pkg.exports).toEqual({ ".": { import: "./dist/lib.js" }, "./*": "./*" });
    expect(files.get("package/SDK-NOTICE.md")!.toString("utf8")).toContain(
      "Commercial Terms of Service",
    );
    expect(files.get("package/dist/claude-sdk.js")!.toString("utf8")).toContain(
      "../dist/sdk/sdk.mjs",
    );
    expect(sha256(yield* until(readFile(join(VENDOR, "claude/adapter.patch"))))).toBe(
      recipe.patchSha256,
    );
    expect(sha256(yield* until(readFile(join(VENDOR, "claude/sdk-transform.mjs"))))).toBe(
      recipe.transformSha256,
    );
  });
  it("H5/H6: Codex carries its reviewed source build and no Codex CLI dependency", function* () {
    const snapshot = (yield* manifest()).find((entry) => entry.provider === "codex");
    if (snapshot === undefined || !("tarball" in snapshot)) {
      throw new Error("Codex snapshot missing");
    }
    const files = archiveFiles(yield* snapshotBytes(snapshot));
    const pkg = JSON.parse(files.get("package/package.json")!.toString("utf8"));
    // The adapter runs the host's CLI; npm has nothing of Codex to install.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@agentclientprotocol/sdk",
      "diff",
      "open",
      "vscode-jsonrpc",
      "zod",
    ]);
    expect(pkg.optionalDependencies).toBeUndefined();
    const executable = files.get("package/dist/index.js")!;
    expect(executable.toString("utf8")).not.toContain("@openai/codex");
    // The shipped executable is the recorded output of the pinned source plus
    // the readable patch beside it.
    expect(sha256(executable)).toBe(snapshot.executableSha256);
    expect(sha256(yield* until(readFile(join(VENDOR, snapshot.patch))))).toBe(snapshot.patchSha256);
  });
});
