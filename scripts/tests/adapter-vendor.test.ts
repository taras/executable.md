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
import { ensure, until } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
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
  materializationContract: string;
  identityContract?: string;
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
      const reviewed = PINNED[snapshot.provider as keyof typeof PINNED];
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

  it("AD4: the manifest inventory is exactly what the archive contains", function* () {
    for (const snapshot of yield* manifest()) {
      const bytes = yield* until(readFile(join(VENDOR, snapshot.tarball)));

      // The archive's own answer, not the manifest compared with itself. A file
      // added to or dropped from the tarball has to show up here, because this
      // is the list a reviewer trusts instead of unpacking.
      expect({ tarball: snapshot.tarball, files: archiveInventory(bytes) }).toEqual({
        tarball: snapshot.tarball,
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
  it("AD7: the shipped Claude SDK regenerates offline from exact carried source", function* () {
    const snapshot = (yield* manifest()).find((entry) => entry.provider === "claude");
    if (!snapshot) {
      throw new Error("Claude snapshot missing");
    }
    const files = archiveFiles(yield* until(readFile(join(VENDOR, snapshot.tarball))));
    const text = (name: string): string => {
      const bytes = files.get(`package/${name}`);
      if (!bytes) {
        throw new Error(`Snapshot member missing: ${name}`);
      }
      return bytes.toString("utf8");
    };
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-sdk-source-")));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    for (const [name, bytes] of files) {
      if (name.startsWith("package/vendor/claude-agent-sdk/")) {
        const target = join(root, name);
        yield* ensureDir(dirname(target));
        yield* writeTextFile(target, bytes.toString("utf8"));
      }
    }
    const module = yield* until(
      import(pathToFileURL(join(root, "package/vendor/claude-agent-sdk/transform.mjs")).href),
    );
    if (typeof module.transformSdk !== "function") {
      throw new Error("Carried SDK transform missing");
    }
    const pristine = text("vendor/claude-agent-sdk/sdk.mjs");
    expect(createHash("sha256").update(pristine).digest("hex")).toBe(
      "fa36c6862927f6f1d0c3bff35d524a1d8fa81f1746bebfc7aeddb6fbf4b572c8",
    );
    expect(
      createHash("sha256").update(text("vendor/claude-agent-sdk/sdk.d.ts")).digest("hex"),
    ).toBe("544c4efabd6761a66110bf32b2e3749b77bbee4f958e2c929dd1045f52302653");
    expect(module.transformSdk(pristine)).toBe(text("dist/sdk/sdk.mjs"));
    expect(() => module.transformSdk(pristine + "\n")).toThrow("SHA-256 mismatch");
    expect(() =>
      module.transformSdk(pristine.replace("class yk{options;process;", "class missing{")),
    ).toThrow("found 0");
    expect(() => module.transformSdk(pristine + "class yk{options;process;")).toThrow("found 2");
    expect(text("dist/claude-sdk.js")).toContain('export * from "../dist/sdk/sdk.mjs"');
    for (const [name, bytes] of files) {
      if (name.startsWith("package/dist/") && name.endsWith(".js")) {
        expect(bytes.toString("utf8")).not.toMatch(/from ["']@anthropic-ai\/claude-agent-sdk["']/);
      }
    }
    expect(text("vendor/claude-agent-sdk/UPSTREAM-README.md")).toContain(
      "Commercial Terms of Service",
    );
    expect(text("vendor/claude-agent-sdk/PROVENANCE.json")).toContain("0.3.238");
    expect(JSON.parse(text("package.json")).dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(
      "0.3.238",
    );
  });
});
