/**
 * Tier AV — the in-package ACPX snapshot (packages/acp/vendor/acpx).
 *
 * `@executablemd/acp` executes a vendored ACP runtime rather than the published
 * package, because the repository's builds and release compile run with
 * `--node-modules-dir=none --cached-only`, where a package-level override
 * cannot resolve. That is a durable arrangement, and a vendored dependency
 * nobody re-checks becomes a fork by accident.
 *
 * These checks are offline and byte-level: the snapshot matches its manifest,
 * only the declared files differ from pristine upstream, each difference sits
 * at the declared seam, the forbidden package shapes are absent, and production
 * reaches ACPX through exactly one relative module.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { scoped, until } from "effection";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";

const VENDOR = "packages/acp/vendor/acpx";
const ACP_SRC = "packages/acp/src";

/** The only identifier the behavioral patch introduces. */
const SEAM = "agentProcessEnv";

/** How far an introduced line may sit from one that names the seam. */
const SEAM_PROXIMITY_LINES = 8;

/**
 * Undo the two packaging adaptations, so what remains is behavior.
 *
 * The snapshot is five files rather than a published package: it carries no
 * `.js` for declaration-only modules, no sourcemaps for anything, and ends
 * every file with a newline. All three adaptations are declared in
 * PROVENANCE.md and none can change what runs.
 */
function unpackage(text: string): string {
  return text
    .replace(/(from "\.\/[^"]+)\.d\.ts"/g, '$1.js"')
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//# sourceMappingURL="))
    .join("\n")
    .replace(/\s+$/, "");
}

interface ManifestEntry {
  path: string;
  kind: string;
  sha256: string;
}

interface Manifest {
  package: string;
  version: string;
  commit: string;
  behaviorallyPatched: string[];
  packagingAdapted: string[];
  files: ManifestEntry[];
}

function* manifest(): Operation<Manifest> {
  const raw: unknown = JSON.parse(yield* until(readFile(join(VENDOR, "MANIFEST.json"), "utf8")));
  if (typeof raw !== "object" || raw === null) {
    throw new Error("vendor manifest is not an object");
  }
  const value = raw as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const list = value[key];
    if (!Array.isArray(list)) {
      throw new Error(`vendor manifest is missing ${key}`);
    }
    return list.map((entry) => String(entry));
  };
  const files = value.files;
  if (!Array.isArray(files)) {
    throw new Error("vendor manifest is missing files");
  }
  return {
    package: String(value.package),
    version: String(value.version),
    commit: String(value.commit),
    behaviorallyPatched: strings("behaviorallyPatched"),
    packagingAdapted: strings("packagingAdapted"),
    files: files.map((entry) => {
      const { path, kind, sha256 } = entry as Record<string, unknown>;
      if (typeof path !== "string" || typeof kind !== "string" || typeof sha256 !== "string") {
        throw new Error("vendor manifest has a malformed file entry");
      }
      return { path, kind, sha256 };
    }),
  };
}

function* digestOf(path: string): Operation<string> {
  return createHash("sha256")
    .update(yield* until(readFile(path)))
    .digest("hex");
}

function* walk(dir: string): Operation<string[]> {
  const found: string[] = [];
  for (const entry of yield* until(readdir(dir, { withFileTypes: true }))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(yield* walk(full)));
    } else {
      found.push(full);
    }
  }
  return found;
}

function* present(path: string): Operation<boolean> {
  try {
    yield* until(stat(path));
    return true;
  } catch {
    return false;
  }
}

/**
 * The module graph of the compiled entry.
 *
 * Raises when the command did not run. Every question asked of this output is
 * about something being *absent*, and an absence in output nobody produced is
 * not a finding — it is a check that has quietly stopped checking.
 */
function* moduleGraph(flags: string[]): Operation<string> {
  // The graph is the answer this parses, not something to print: several
  // hundred module lines would bury every other result in this tier.
  const info = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({
      command: [process.execPath, "info", ...flags, "packages/cli/src/compiled.ts"],
    });
  });
  if (info.exitCode !== 0) {
    throw new Error(`deno info exited ${info.exitCode}, so its output describes no module graph`);
  }
  return info.stdout;
}

describe("Tier AV — vendored ACPX snapshot", () => {
  it("AV1: every file matches its recorded digest", function* () {
    const record = yield* manifest();
    for (const entry of record.files) {
      expect({ path: entry.path, sha256: yield* digestOf(join(VENDOR, entry.path)) }).toEqual({
        path: entry.path,
        sha256: entry.sha256,
      });
    }
  });

  it("AV2: the manifest inventory is exact — no extra or missing file", function* () {
    const record = yield* manifest();
    const onDisk = (yield* walk(VENDOR))
      .map((path) => path.slice(VENDOR.length + 1))
      .filter((path) => path !== "MANIFEST.json")
      .sort();
    expect(onDisk).toEqual(record.files.map((entry) => entry.path).sort());
  });

  it("AV3: only the declared files differ from pristine upstream", function* () {
    const record = yield* manifest();
    const declared = new Set([...record.behaviorallyPatched, ...record.packagingAdapted]);
    for (const entry of record.files.filter((file) => file.kind === "generated")) {
      const pristine = join(VENDOR, "upstream", entry.path.replace(/^generated\//, ""));
      const same = (yield* digestOf(pristine)) === entry.sha256;
      // A generated file identical to upstream must not claim a change, and a
      // changed one must be declared. Either way the manifest tells the truth.
      expect({ path: entry.path, changed: !same }).toEqual({
        path: entry.path,
        changed: declared.has(entry.path),
      });
    }
  });

  it("AV4: behavioral differences stay at the declared seam", function* () {
    const record = yield* manifest();
    for (const path of record.behaviorallyPatched) {
      const before = yield* until(
        readFile(join(VENDOR, "upstream", path.replace(/^generated\//, "")), "utf8"),
      );
      const after = yield* until(readFile(join(VENDOR, path), "utf8"));
      const known = new Set(
        unpackage(before)
          .split("\n")
          .map((line) => line.trim()),
      );
      const lines = unpackage(after).split("\n");
      const seamAt = lines.flatMap((line, index) => (line.includes(SEAM) ? [index] : []));
      // Locality rather than keyword matching: a patch introduces comment and
      // restructuring lines that name nothing. Exact bytes are pinned by AV1;
      // this is what stops an unrelated edit hiding in the same file.
      const strayed = lines.flatMap((line, index) => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || known.has(trimmed)) {
          return [];
        }
        const near = seamAt.some((seam) => Math.abs(seam - index) <= SEAM_PROXIMITY_LINES);
        return near ? [] : [index + 1];
      });
      expect({ path, strayed }).toEqual({ path, strayed: [] });
    }
  });

  it("AV5: packaging adaptations reduce back to pristine upstream", function* () {
    const record = yield* manifest();
    const behavioral = new Set(record.behaviorallyPatched);
    for (const path of record.packagingAdapted.filter((file) => !behavioral.has(file))) {
      const before = yield* until(
        readFile(join(VENDOR, "upstream", path.replace(/^generated\//, "")), "utf8"),
      );
      const after = yield* until(readFile(join(VENDOR, path), "utf8"));
      // Nothing but the declared retarget and the dropped sourcemap reference:
      // undoing them must reproduce upstream exactly, or the file carries a
      // change nobody wrote down.
      expect({ path, restored: unpackage(after) }).toEqual({
        path,
        restored: unpackage(before),
      });
    }
  });

  it("AV6: the snapshot is source, not a package", function* () {
    // Each of these would reintroduce the resolution the cache-only build
    // refused: a nested package, a hidden build output, an installed tree.
    for (const shape of ["package.json", "dist", "node_modules"]) {
      expect({ shape, present: yield* present(join(VENDOR, shape)) }).toEqual({
        shape,
        present: false,
      });
    }
  });

  it("AV7: no root link or workspace link resolves ACPX", function* () {
    const root: unknown = JSON.parse(yield* until(readFile("deno.json", "utf8")));
    expect(Object.hasOwn(root as Record<string, unknown>, "links")).toBe(false);
    const workspace = yield* until(readFile("pnpm-workspace.yaml", "utf8"));
    expect(workspace).not.toContain("vendor/acpx");
    // Read as data rather than as text: a formatter rewrites the spelling of
    // this file, and a check that depends on the spelling stops checking.
    const pkg = JSON.parse(yield* until(readFile("packages/acp/package.json", "utf8")));
    const dependencies = (pkg as Record<string, Record<string, string>>).dependencies ?? {};
    expect(dependencies.acpx).toBe("0.12.0");
    // Sibling packages resolve through the workspace, as they always have.
    // What must not appear is a local protocol standing in for ACPX, or any
    // dependency reaching into the snapshot: either makes the runtime
    // resolvable only where a node_modules tree exists, which is the
    // arrangement the cache-only build refused.
    const local = Object.entries(dependencies).filter(
      ([name, specifier]) =>
        specifier.includes("vendor/acpx") ||
        (name === "acpx" && /^(workspace|link|file|portal):/.test(specifier)),
    );
    expect(local).toEqual([]);
  });

  it("AV8: production reaches ACPX through exactly one relative module", function* () {
    // The package entry too, not only `src/`: a re-export there is production
    // that reaches every consumer, and it is the easiest place to miss.
    const sources = [
      ...(yield* walk(ACP_SRC)).filter((path) => path.endsWith(".ts")),
      "packages/acp/mod.ts",
    ];
    const importers: string[] = [];
    for (const path of sources) {
      const text = yield* until(readFile(path, "utf8"));
      if (/from "acpx(\/[a-z]+)?"/.test(text)) {
        importers.push(path);
      }
    }
    // Production executing the published package instead of the patched
    // snapshot is the defect this arrangement exists to prevent, and it would
    // be invisible at runtime until an executable binding failed to apply.
    expect(importers).toEqual([]);

    const adapter = yield* until(readFile(join(ACP_SRC, "acpx-runtime.ts"), "utf8"));
    expect(adapter).toContain("../vendor/acpx/generated/runtime.js");
    expect(adapter).toContain("../vendor/acpx/generated/runtime.d.ts");
  });

  it("AV9: the compiled module graph resolves no published ACPX", function* () {
    // The decisive proof, and the one the other checks only approximate: what
    // the release binary is built from. `deno compile` runs with no
    // node_modules, which is why the snapshot exists at all — a graph that
    // still names `npm:acpx` would mean production runs the unpatched package.
    const graph = yield* moduleGraph(["--node-modules-dir=none"]);

    expect(graph).not.toContain("npm:acpx");
    expect(graph).toContain("vendor/acpx/generated/runtime.js");
  });

  it("AV10: the graph probe refuses a command that did not run", function* () {
    // The regression for how the check above was first written wrong. `deno
    // info` rejects unknown flags, writes nothing to stdout, and exits
    // nonzero; searching that empty output reported "npm:acpx is absent" for a
    // command that had never inspected anything.
    //
    // An absence is only evidence when the thing that would have shown a
    // presence actually ran, so the probe raises rather than returning output
    // nobody produced.
    let refused: unknown;
    try {
      yield* moduleGraph(["--not-a-real-flag"]);
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("deno info");
  });

  it("AV11: the package declares its own licence", function* () {
    // JSR reads the licence from the tarball root. Vendoring puts a second
    // LICENSE inside the package, and an undeclared licence field lets that
    // file be taken for this package's own terms.
    const config: unknown = JSON.parse(yield* until(readFile("packages/acp/deno.json", "utf8")));
    expect((config as Record<string, unknown>).license).toBe("MIT");
  });

  it("AV12: the upstream licence travels with the package", function* () {
    const notices = yield* until(readFile("packages/acp/THIRD_PARTY_NOTICES.md", "utf8"));
    expect(notices).toContain("MIT License");
    expect(notices).toContain("OpenClaw Team");
    expect(notices).toContain("acpx");
  });
});
