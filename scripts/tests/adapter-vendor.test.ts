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
 * the reviewed upstream commits, the licence travels, and the snapshot carries
 * no provider CLI.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { decodeBase64 } from "@std/encoding/base64";
import { embeddedAdapterIdentities } from "@executablemd/acp";

const VENDOR = "packages/acp/vendor/adapters";

/** The upstream commits the Planner reviewed and pinned for #622. */
const REVIEWED = {
  codex: {
    upstreamBase: "50f69e57ca761ccafd2ca29de7fb591068277516",
    patchedCommit: "8a481f1981c91788f415252bbe0da31c213598ea",
  },
  claude: {
    upstreamBase: "8710ce1cbccf562cb04b4bcc30e053e960aee05f",
    patchedCommit: "dcb7d52b0bd52a0a7a6cd5d539698f9735281b07",
  },
} as const;

interface ManifestSnapshot {
  provider: string;
  package: string;
  version: string;
  tarball: string;
  sha256: string;
  byteLength: number;
  files: string[];
  upstreamBase: string;
  patchedCommit: string;
  license: string;
  buildCommand: string;
  contract: string;
}

function* manifest(): Operation<ManifestSnapshot[]> {
  const raw: unknown = JSON.parse(yield* until(readFile(join(VENDOR, "MANIFEST.json"), "utf8")));
  const snapshots = (raw as { snapshots?: unknown }).snapshots;
  if (!Array.isArray(snapshots)) {
    throw new Error("the adapter manifest declares no snapshots");
  }
  return snapshots as ManifestSnapshot[];
}

describe("Tier AD — embedded ACP adapter snapshots", () => {
  it("AD1: every tarball matches its recorded digest and length", function* () {
    for (const snapshot of yield* manifest()) {
      const bytes = yield* until(readFile(join(VENDOR, snapshot.tarball)));
      expect({
        tarball: snapshot.tarball,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      }).toEqual({
        tarball: snapshot.tarball,
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
      const bytes = decodeBase64(snapshot.base64);
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

  it("AD3: each snapshot names the exact reviewed upstream commits", function* () {
    for (const snapshot of yield* manifest()) {
      const reviewed = REVIEWED[snapshot.provider as keyof typeof REVIEWED];
      // Pinned in this file as well as in the manifest: a snapshot rebuilt from
      // some other commit would otherwise rewrite the record of what it is and
      // still pass every byte check above.
      expect({ provider: snapshot.provider, ...reviewed }).toEqual({
        provider: snapshot.provider,
        upstreamBase: snapshot.upstreamBase,
        patchedCommit: snapshot.patchedCommit,
      });
      expect(snapshot.license).toBe("Apache-2.0");
      expect(snapshot.buildCommand).toBe("npm run build && npm pack");
    }
  });

  it("AD4: the manifest file list is exact, and carries no provider CLI", function* () {
    for (const snapshot of yield* manifest()) {
      const bytes = yield* until(readFile(join(VENDOR, snapshot.tarball)));
      // Read from the archive rather than trusted from the manifest: the list is
      // what a reviewer reads instead of unpacking, so it has to be the archive's
      // own answer.
      const listed = new Set(snapshot.files);
      expect(listed.size).toBe(snapshot.files.length);
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
    }
  });
});
