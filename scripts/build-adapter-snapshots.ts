/** Regenerate the maintained Codex snapshot; deps owns prepared Claude output. */
import { AdapterManifest } from "./lib/adapter-manifest.ts";
import { main, until } from "effection";
import { writeTextFile } from "@effectionx/fs";
import { encodeBase64 } from "@std/encoding/base64";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const VENDOR = "packages/acp/vendor/adapters";
const GENERATED = `${VENDOR}/generated/snapshots.ts`;

/** How wide an embedded line is, so a diff of this file stays readable. */
const COLUMNS = 96;

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
  const manifest = AdapterManifest.parse(
    JSON.parse(yield* until(readFile(`${VENDOR}/MANIFEST.json`, "utf8"))),
  );
  const maintained = manifest.snapshots.filter((entry) => "tarball" in entry);

  const parts: string[] = [];
  for (const snapshot of maintained) {
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

  const entries = maintained
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
      'import type { EmbeddedAdapterSnapshot } from "../../../src/adapter-snapshot-type.ts";',
      'export type { EmbeddedAdapterSnapshot } from "../../../src/adapter-snapshot-type.ts";',
      "",
      "/** Every embedded snapshot, in manifest order. */",
      "export const EMBEDDED_ADAPTER_SNAPSHOTS: readonly EmbeddedAdapterSnapshot[] = Object.freeze([",
      entries,
      "]);",
      "",
    ].join("\n"),
  );

  console.log(`wrote ${GENERATED} (${maintained.length} snapshots)`);
});
