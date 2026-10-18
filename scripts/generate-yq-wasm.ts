/**
 * Generate the committed byte module for the pinned `yq.rs` WebAssembly engine.
 *
 * The engine core queries values with is `yq.rs`, and the package publishes two
 * entries. Its root and `./inline` compile an embedded module and instantiate a
 * singleton while they are being evaluated, which would start a WebAssembly
 * compilation in every process that imports core. `./loader` does none of that:
 * it exports `createYq(source)` and compiles exactly the bytes it is handed. So
 * core imports the loader and supplies the bytes from a module of its own, and
 * this script is what writes that module.
 *
 * ## Why the bytes are committed rather than read
 *
 * A compiled binary and an installed npm package each carry core's own module
 * graph and nothing beside it, so bytes reached through a path, a `fetch` or a
 * host filesystem API would be present in a source checkout and absent in both.
 * The encoded module is in the static import graph instead, which is the one
 * place every distribution agrees about.
 *
 * ## Generation is deliberate, and a check is read-only
 *
 * Nothing regenerates these bytes on its way to doing something else: no build,
 * no test and no check writes them, and this script installs nothing and
 * resolves no dependency state. `--check` reproduces what generation would emit
 * and compares, so drift is a refusal that writes nothing — which is what
 * `deno task lint`'s companion check and the distribution regression read.
 *
 * The expectations below are the pin. A package resolving to another version,
 * or to the same version with different bytes, is refused here rather than
 * encoded: the integrity of the dependency is the lockfile's, and the identity
 * of these exact bytes is this file's.
 */

import { readTextFile, writeTextFile } from "@effectionx/fs";
import { main, until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The exact package version core is pinned to. */
const PINNED_VERSION = "0.1.0";

/** The exact byte length of that version's published `dist/yq.wasm`. */
const PINNED_BYTES = 468387;

/** The lowercase SHA-256 of those exact bytes. */
const PINNED_SHA256 = "97252eddd0dd7c2d80c25f8b73aec0874af954ca77ea33d8eb892c0a845eac46";

/** The vendor files that accompany the bytes as attribution. */
const NOTICES = ["LICENSE", "THIRD_PARTY_NOTICES.md"] as const;

/**
 * How wide one encoded line is.
 *
 * The encoding is one array of string literals joined back together, because a
 * single literal of six hundred thousand characters is a line no reader, diff or
 * formatter handles well. The width is arbitrary and fixed: what matters is that
 * generation and `--check` agree, and that the decoded bytes are unaffected.
 */
const LINE = 1024;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODULE = join(ROOT, "packages/core/src/yq-wasm.ts");
const PROVENANCE = join(ROOT, "packages/core/src/yq-wasm.provenance.json");
const NOTICE_DIRECTORY = join(ROOT, "packages/core/src/yq-vendor-notices");

/** What one generated file is, so a check and a write read one description. */
interface Generated {
  readonly path: string;
  readonly label: string;
  readonly content: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The resolved package directory of the pinned engine.
 *
 * Resolved through package resolution rather than assembled from a layout: the
 * manifest maps `./yq.wasm` to the published asset, so asking for that subpath
 * is asking the package where its own WebAssembly is. The directory above
 * `dist/` is the package root, which is where its manifest and notices sit.
 */
function packageDirectory(): { readonly wasm: string; readonly root: string } {
  const resolved = import.meta.resolve("yq.rs/yq.wasm");
  if (!resolved.startsWith("file:")) {
    throw new Error(
      `yq.rs/yq.wasm resolved to ${resolved}, which is not a prepared package file. ` +
        "Run `deno task setup` before generating.",
    );
  }
  const wasm = fileURLToPath(resolved);
  return { wasm, root: dirname(dirname(wasm)) };
}

/** The pinned bytes, refused unless the package is the one that was pinned. */
function* pinnedBytes(): Operation<Uint8Array> {
  const { wasm, root } = packageDirectory();
  const manifest: unknown = JSON.parse(yield* readTextFile(join(root, "package.json")));
  const described =
    manifest !== null && typeof manifest === "object" ? (manifest as Record<string, unknown>) : {};
  if (described.name !== "yq.rs" || described.version !== PINNED_VERSION) {
    throw new Error(
      `expected yq.rs@${PINNED_VERSION}, resolved ${String(described.name)}@${String(
        described.version,
      )}`,
    );
  }

  const bytes = new Uint8Array(yield* until(readFile(wasm)));
  if (bytes.byteLength !== PINNED_BYTES) {
    throw new Error(`expected ${PINNED_BYTES} bytes of WebAssembly, read ${bytes.byteLength}`);
  }
  const sha256 = digest(bytes);
  if (sha256 !== PINNED_SHA256) {
    throw new Error(`expected SHA-256 ${PINNED_SHA256}, read ${sha256}`);
  }
  return bytes;
}

/** The encoded module, exactly as it is committed. */
function byteModule(base64: string): string {
  const chunks: string[] = [];
  for (let at = 0; at < base64.length; at += LINE) {
    chunks.push(`  "${base64.slice(at, at + LINE)}",`);
  }
  return `/**
 * The pinned \`yq.rs\` WebAssembly module, base64-encoded as immutable source.
 *
 * Generated by \`scripts/generate-yq-wasm.ts\` from yq.rs@${PINNED_VERSION}'s published
 * \`dist/yq.wasm\` — ${PINNED_BYTES} bytes, SHA-256
 * \`${PINNED_SHA256}\`.
 * \`yq-wasm.provenance.json\` records that attribution and
 * \`yq-vendor-notices/\` carries the vendor's own license and notices.
 *
 * Do not edit. Regenerate with:
 *
 * \`\`\`
 * deno run --allow-all scripts/generate-yq-wasm.ts
 * \`\`\`
 *
 * This is source data and not a ready engine: nothing here decodes, compiles or
 * instantiates anything. One execution's own lazy initialization decodes this
 * string and hands the bytes to the loader (\`value-query.ts\`), so a document
 * that queries nothing compiles nothing.
 *
 * The encoding is an array of lines joined back together because one literal of
 * this length is a line nothing reads well. The decoded bytes are the same
 * either way.
 */

const LINES: readonly string[] = [
${chunks.join("\n")}
];

/** Base64 of the exact published WebAssembly module. */
export const YQ_WASM_BASE64: string = LINES.join("");
`;
}

/** What the attribution records, beside the bytes it is about. */
function provenance(notices: readonly { name: string; sha256: string }[]): string {
  return `${JSON.stringify(
    {
      format: 1,
      package: "yq.rs",
      version: PINNED_VERSION,
      asset: "dist/yq.wasm",
      bytes: PINNED_BYTES,
      sha256: PINNED_SHA256,
      license: "MIT AND Apache-2.0",
      homepage: "https://github.com/taras/yq.rs#readme",
      runtimeExport: "yq.rs/loader",
      generator: "scripts/generate-yq-wasm.ts",
      encoded: "packages/core/src/yq-wasm.ts",
      notices: notices.map((notice) => ({
        path: `yq-vendor-notices/${notice.name}`,
        sha256: notice.sha256,
      })),
    },
    null,
    2,
  )}\n`;
}

/** Every file generation produces, in a fixed order. */
function* generated(): Operation<Generated[]> {
  const { root } = packageDirectory();
  const bytes = yield* pinnedBytes();

  const copied: Generated[] = [];
  const recorded: { name: string; sha256: string }[] = [];
  for (const name of NOTICES) {
    const text = yield* readTextFile(join(root, name));
    copied.push({
      path: join(NOTICE_DIRECTORY, name),
      label: `packages/core/src/yq-vendor-notices/${name}`,
      content: text,
    });
    recorded.push({ name, sha256: digest(new TextEncoder().encode(text)) });
  }

  // Encoded through the platform's own base64, in bounded slices: one
  // `String.fromCharCode(...bytes)` over four hundred thousand arguments
  // overflows the call stack on every runtime this ships to.
  let binary = "";
  for (let at = 0; at < bytes.byteLength; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return [
    { path: MODULE, label: "packages/core/src/yq-wasm.ts", content: byteModule(btoa(binary)) },
    {
      path: PROVENANCE,
      label: "packages/core/src/yq-wasm.provenance.json",
      content: provenance(recorded),
    },
    ...copied,
  ];
}

/** What a file currently holds, or nothing when it does not exist. */
function* current(path: string): Operation<string | undefined> {
  try {
    return yield* readTextFile(path);
  } catch {
    return undefined;
  }
}

function* check(files: readonly Generated[]): Operation<void> {
  const drifted: string[] = [];
  for (const file of files) {
    const held = yield* current(file.path);
    if (held === undefined) {
      drifted.push(`${file.label}: missing`);
    } else if (held !== file.content) {
      drifted.push(`${file.label}: differs from what the pinned package generates`);
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      `generated yq assets are out of date:\n  ${drifted.join(
        "\n  ",
      )}\n\nRegenerate with: deno run --allow-all scripts/generate-yq-wasm.ts`,
    );
  }
  console.log(`generated yq assets match yq.rs@${PINNED_VERSION} (${files.length} files)`);
}

function* write(files: readonly Generated[]): Operation<void> {
  yield* until(mkdir(NOTICE_DIRECTORY, { recursive: true }));
  for (const file of files) {
    yield* writeTextFile(file.path, file.content);
    console.log(`wrote ${file.label}`);
  }
}

await main(function* () {
  const checking = Deno.args.includes("--check");
  const unknown = Deno.args.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    throw new Error(`unexpected argument ${unknown[0]} — this script takes only --check`);
  }
  const files = yield* generated();
  yield* checking ? check(files) : write(files);
});
