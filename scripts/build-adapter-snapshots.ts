/**
 * Regenerate the embedded ACP adapter snapshots.
 *
 * `packages/acp/vendor/adapters` holds one npm tarball per provider, built from
 * an exact patched upstream commit by that project's own build and `npm pack`.
 * A tarball is bytes on disk, and bytes on disk are not reachable from a
 * compiled binary or from the npm artifact — so the same bytes are also carried
 * as a module in the graph, which every distribution inlines the same way.
 *
 * This writes that module. It is committed rather than built, because a
 * generated file the source distribution needs cannot be one the source
 * distribution has to build first; `scripts/tests/adapter-vendor.test.ts` is
 * what keeps it honest, by regenerating in memory and comparing.
 *
 *     deno run --allow-all scripts/build-adapter-snapshots.ts
 */

import { main, until } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { encodeBase64 } from "@std/encoding/base64";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const VENDOR = "packages/acp/vendor/adapters";
const GENERATED = `${VENDOR}/generated/snapshots.ts`;

/** How wide an embedded line is, so a diff of this file stays readable. */
const COLUMNS = 96;

interface ManifestSnapshot {
  readonly provider: string;
  readonly package: string;
  readonly version: string;
  readonly tarball: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * The encoded bytes as a joined array of chunks.
 *
 * An array rather than concatenated literals: `"a" + "b" + …` across thousands
 * of chunks is one binary-expression tree thousands deep, and TypeScript
 * overflows its stack walking it. An array literal is flat, and still wraps for
 * a readable diff.
 */
function wrap(value: string): string {
  const lines: string[] = [];
  for (let at = 0; at < value.length; at += COLUMNS) {
    lines.push(`    "${value.slice(at, at + COLUMNS)}",`);
  }
  return `[\n${lines.join("\n")}\n  ].join("")`;
}

await main(function* () {
  const manifest: { snapshots: ManifestSnapshot[] } = JSON.parse(
    yield* until(readFile(`${VENDOR}/MANIFEST.json`, "utf8")),
  );

  const parts: string[] = [];
  for (const snapshot of manifest.snapshots) {
    const bytes = yield* until(readFile(`${VENDOR}/${snapshot.tarball}`));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== snapshot.sha256 || bytes.byteLength !== snapshot.byteLength) {
      throw new Error(
        `${snapshot.tarball} does not match MANIFEST.json — refresh the manifest first`,
      );
    }
    parts.push(
      `/** \`${snapshot.package}@${snapshot.version}\`, sha256 ${snapshot.sha256}. */\n` +
        `const ${snapshot.provider.toUpperCase()}: string = ${wrap(encodeBase64(bytes))};`,
    );
  }

  const entries = manifest.snapshots
    .map((snapshot) =>
      [
        "  Object.freeze({",
        `    provider: ${JSON.stringify(snapshot.provider)},`,
        `    package: ${JSON.stringify(snapshot.package)},`,
        `    version: ${JSON.stringify(snapshot.version)},`,
        `    sha256: ${JSON.stringify(snapshot.sha256)},`,
        `    byteLength: ${snapshot.byteLength},`,
        `    base64: ${snapshot.provider.toUpperCase()},`,
        "  }),",
      ].join("\n"),
    )
    .join("\n");

  yield* writeTextFile(
    GENERATED,
    [
      "/**",
      " * The embedded ACP adapter snapshots. Generated — do not edit.",
      " *",
      " * Each value is one `npm pack` tarball, base64-encoded, byte-identical to the",
      " * file beside it under `packages/acp/vendor/adapters`. Written by",
      " * `scripts/build-adapter-snapshots.ts` and verified by",
      " * `scripts/tests/adapter-vendor.test.ts`.",
      " *",
      " * It is a module rather than a file read so that one mechanism serves every",
      " * distribution: the source tree, the dnt npm artifact, and the compiled binary",
      " * all inline exactly these bytes.",
      " */",
      "",
      ...parts.map((part) => `${part}\n`),
      "/** One adapter, and the identity its bytes must prove before anything runs it. */",
      "export interface EmbeddedAdapterSnapshot {",
      "  /** The agent name this adapter serves. */",
      "  readonly provider: string;",
      "  /** The upstream package these bytes were packed from. */",
      "  readonly package: string;",
      "  /** That package's version. */",
      "  readonly version: string;",
      "  /** SHA-256 of the tarball. Checked against the decoded bytes before use. */",
      "  readonly sha256: string;",
      "  /** The tarball's exact length. */",
      "  readonly byteLength: number;",
      "  /** The tarball itself. */",
      "  readonly base64: string;",
      "}",
      "",
      "/** Every embedded snapshot, in manifest order. */",
      "export const EMBEDDED_ADAPTER_SNAPSHOTS: readonly EmbeddedAdapterSnapshot[] = Object.freeze([",
      entries,
      "]);",
      "",
    ].join("\n"),
  );

  console.log(`wrote ${GENERATED} (${manifest.snapshots.length} snapshots)`);
});
