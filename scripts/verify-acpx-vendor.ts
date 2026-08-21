/**
 * Offline drift verification for the vendored ACPX override.
 *
 * The override exists to add one transient input ACPX 0.12.0 does not have
 * (`vendor/acpx/PROVENANCE.md`). What this proves is that it is still only
 * that: every file matches its recorded digest, exactly the four declared files
 * differ from their pristine bytes, and each difference is confined to the
 * `agentProcessEnv` seam.
 *
 * A vendored dependency nobody re-checks becomes a fork by accident. This is
 * what stops that, and it needs no network to do it.
 */

import { main } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "effection";
import process from "node:process";

const VENDOR = "packages/acp/vendor/acpx";

/** The only identifier the patch is allowed to introduce. */
const SEAM = "agentProcessEnv";

/** How far an introduced line may sit from one that names the seam. */
const SEAM_PROXIMITY_LINES = 8;

interface ManifestEntry {
  path: string;
  kind: string;
  sha256: string;
}

interface Manifest {
  package: string;
  version: string;
  commit: string;
  patchedFiles: string[];
  files: ManifestEntry[];
}

function* digestOf(path: string): Operation<string> {
  const bytes = yield* until(readFile(path));
  return createHash("sha256").update(bytes).digest("hex");
}

function parseManifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("vendor manifest is not an object");
  }
  const { package: name, version, commit, patchedFiles, files } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string" || typeof commit !== "string") {
    throw new Error("vendor manifest is missing its package identity");
  }
  if (!Array.isArray(patchedFiles) || !Array.isArray(files)) {
    throw new Error("vendor manifest is missing its file lists");
  }
  return {
    package: name,
    version,
    commit,
    patchedFiles: patchedFiles.map((entry) => String(entry)),
    files: files.map((entry) => {
      const { path, kind, sha256 } = entry as Record<string, unknown>;
      if (typeof path !== "string" || typeof kind !== "string" || typeof sha256 !== "string") {
        throw new Error("vendor manifest has a malformed file entry");
      }
      return { path, kind, sha256 };
    }),
  };
}

main(function* () {
  const manifest = parseManifest(
    JSON.parse(yield* until(readFile(join(VENDOR, "MANIFEST.json"), "utf8"))),
  );
  const problems: string[] = [];

  for (const entry of manifest.files) {
    let actual: string;
    try {
      actual = yield* digestOf(join(VENDOR, entry.path));
    } catch {
      problems.push(`missing: ${entry.path}`);
      continue;
    }
    if (actual !== entry.sha256) {
      problems.push(`changed: ${entry.path}`);
    }
  }

  // Every pristine copy must correspond to a declared patched file, and every
  // declared patched file must actually differ from it. A patch that no longer
  // changes anything is as much a drift as one that changes too much.
  for (const path of manifest.patchedFiles) {
    const pristine = join(VENDOR, "upstream", path.replace(/^dist\//, ""));
    const vendored = join(VENDOR, path);
    let before: string;
    let after: string;
    try {
      before = yield* until(readFile(pristine, "utf8"));
      after = yield* until(readFile(vendored, "utf8"));
    } catch {
      problems.push(`patched file has no pristine counterpart: ${path}`);
      continue;
    }
    if (before === after) {
      problems.push(`declared patched but identical to upstream: ${path}`);
      continue;
    }
    // Locality, not keyword matching. A patch introduces comment and
    // restructuring lines that name nothing, so what is checked is that every
    // introduced line sits within a few lines of one that does name the seam.
    // Exact bytes are already pinned by the digests above; this is what keeps
    // a future edit from hiding an unrelated change inside the same file.
    const beforeLines = new Set(before.split("\n").map((line) => line.trim()));
    const afterLines = after.split("\n");
    const seamAt = afterLines.flatMap((line, index) => (line.includes(SEAM) ? [index] : []));
    const strayed = afterLines.flatMap((line, index) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || beforeLines.has(trimmed)) {
        return [];
      }
      const near = seamAt.some((seam) => Math.abs(seam - index) <= SEAM_PROXIMITY_LINES);
      return near ? [] : [index + 1];
    });
    if (strayed.length > 0) {
      problems.push(
        `${path}: introduced line(s) far from any ${SEAM} reference at ` +
          `${strayed.slice(0, 5).join(", ")}`,
      );
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    console.error(
      `\nvendored ${manifest.package}@${manifest.version} has drifted from its manifest.\n` +
        `Re-vendor from ${manifest.commit} and refresh MANIFEST.json, or revert the change.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `vendored ${manifest.package}@${manifest.version} matches its manifest: ` +
      `${manifest.files.length} files, ${manifest.patchedFiles.length} patched at the ${SEAM} seam.`,
  );
});
