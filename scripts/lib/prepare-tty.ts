/**
 * Produce the CLI's terminal runtime from pinned `@bomb.sh/tty` 0.9.0 source.
 *
 * The published 0.9.0 engine keys its text-measurement cache by hash alone, so
 * two different texts that share a hash share one width (#1216). The readable
 * `clay-text-cache.patch` compares the retained text and measurement inputs
 * after a hash match. Preparation compiles the patched engine with the pinned
 * WASI SDK in invocation-private scratch and assembles it into the published
 * runtime modules: only `wasm.js`'s encoded payload changes, each module gains
 * a Deno self-types directive, and the supplied declarations stay byte for
 * byte. Every input, patch site, compiler identity and output file is checked
 * against `recipe.json`; a host whose compiler yields other bytes refuses.
 */
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { readTextFile, readdir } from "@effectionx/fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TtyRecipe } from "./tty-recipe.ts";
import {
  downloadClaudeInput,
  ensureDirectory,
  verifyHash,
  writeScratch,
} from "./prepare-claude.ts";
import { useTempDirectory } from "./temp-directory.ts";
import { replaceDirectoryThroughStaging } from "./staged-write.ts";

export const TTY_RECIPE = "packages/cli/vendor/tty/recipe.json";
export const TTY_OUTPUT = "packages/cli/generated/tty";
const VENDOR = "packages/cli/vendor/tty/";

/** Archive bytes a caller already holds; each is verified exactly like a download. */
export interface TtyInputs {
  source: Uint8Array;
  clay: Uint8Array;
  npm: Uint8Array;
  compiler: Uint8Array;
}

/** The recipe key of the WASI SDK archive this host runs. */
export function compilerHost(): string {
  return `${Deno.build.arch}-${Deno.build.os}`;
}

export function* readTtyRecipe(repoRoot: URL): Operation<TtyRecipe> {
  return TtyRecipe.parse(JSON.parse(yield* readTextFile(new URL(TTY_RECIPE, repoRoot))));
}

function* command(cwd: string, executable: string, args: string[]): Operation<string> {
  console.log(`tty preparation: ${executable} ${args.join(" ")}`);
  const result = yield* scoped(() => exec(executable, { arguments: args, cwd }).expect());
  return result.stdout;
}

function* images(root: string, expected: Record<string, string>): Operation<void> {
  for (const [name, hash] of Object.entries(expected)) {
    verifyHash(name, yield* until(readFile(join(root, name))), hash);
  }
}

function pinned(
  name: string,
  bytes: Uint8Array,
  pin: { sha256: string; bytes: number },
): Uint8Array {
  verifyHash(name, bytes, pin.sha256);
  if (bytes.length !== pin.bytes) {
    throw new Error(`${name}: expected ${pin.bytes} bytes, actual ${bytes.length}`);
  }
  return bytes;
}

function* extract(scratch: string, name: string, bytes: Uint8Array): Operation<string> {
  const directory = join(scratch, name);
  yield* ensureDirectory(directory);
  yield* writeScratch(join(scratch, `${name}.tgz`), bytes);
  yield* command(scratch, "tar", ["-xzf", `${name}.tgz`, "--strip-components=1", "-C", directory]);
  return directory;
}

/**
 * Exactly one occurrence of `pattern`, replaced through a function so the Z85
 * payload's `$` characters are never read as replacement syntax.
 */
function replaceOnce(text: string, pattern: RegExp, replacement: string, name: string): string {
  let count = 0;
  const result = text.replace(pattern, () => {
    count++;
    return replacement;
  });
  if (count !== 1) {
    throw new Error(`${name}: expected one encoded engine payload, found ${count}`);
  }
  return result;
}

/** Build the complete runtime file set in private scratch; nothing outside it is written. */
export function* buildTtyRuntime(
  repoRoot: URL,
  recipe: TtyRecipe,
  inputs?: TtyInputs,
): Operation<Record<string, string>> {
  const host = compilerHost();
  const archive = recipe.compiler.archives[host];
  if (!archive) {
    throw new Error(`No pinned WASI SDK archive for ${host}`);
  }
  const patch = yield* readTextFile(new URL(`${VENDOR}clay-text-cache.patch`, repoRoot));
  const notice = yield* readTextFile(new URL(`${VENDOR}NOTICE.txt`, repoRoot));
  verifyHash("clay-text-cache.patch", patch, recipe.patchSha256);
  verifyHash("NOTICE.txt", notice, recipe.noticeSha256);

  const sourceBytes = pinned(
    "tty source archive",
    inputs?.source ?? (yield* downloadClaudeInput(recipe.source)),
    recipe.source,
  );
  const clayBytes = pinned(
    "Clay source archive",
    inputs?.clay ?? (yield* downloadClaudeInput(recipe.clay)),
    recipe.clay,
  );
  const npmBytes = pinned(
    "tty npm archive",
    inputs?.npm ?? (yield* downloadClaudeInput(recipe.npm)),
    recipe.npm,
  );
  if (`sha512-${createHash("sha512").update(npmBytes).digest("base64")}` !== recipe.npm.integrity) {
    throw new Error("tty npm archive: SHA-512 integrity mismatch");
  }
  const compilerBytes = pinned(
    "WASI SDK archive",
    inputs?.compiler ?? (yield* downloadClaudeInput(archive)),
    archive,
  );

  const scratch = yield* useTempDirectory("xmd-tty-prepare-");
  const source = yield* extract(scratch, "source", sourceBytes);
  const clay = yield* extract(scratch, "clay", clayBytes);
  const npm = yield* extract(scratch, "npm", npmBytes);
  const sdk = yield* extract(scratch, "sdk", compilerBytes);

  const header = yield* until(readFile(join(clay, recipe.clay.header)));
  verifyHash("clay.h", header, recipe.clay.headerSha256);
  yield* ensureDirectory(join(source, "clay"));
  yield* writeScratch(join(source, "clay", recipe.clay.header), header);
  const upstream = join(source, recipe.upstreamPatch.path);
  verifyHash(
    recipe.upstreamPatch.path,
    yield* until(readFile(upstream)),
    recipe.upstreamPatch.sha256,
  );
  const patchDirectory = join(source, recipe.upstreamPatch.directory);
  yield* command(patchDirectory, "git", ["apply", "--check", upstream]);
  yield* command(patchDirectory, "git", ["apply", upstream]);

  yield* images(source, recipe.preimages);
  const local = join(scratch, "clay-text-cache.patch");
  yield* writeScratch(local, patch);
  yield* command(source, "git", ["apply", "--check", local]);
  yield* command(source, "git", ["apply", local]);
  yield* images(source, recipe.postimages);

  const clang = join(sdk, "bin", Deno.build.os === "windows" ? "clang.exe" : "clang");
  const version = (yield* command(source, clang, ["--version"])).split("\n")[0]?.trim();
  if (version !== recipe.compiler.version) {
    throw new Error(`WASI SDK compiler: expected ${recipe.compiler.version}, actual ${version}`);
  }
  yield* command(source, clang, recipe.compiler.arguments);
  pinned(
    "clayterm.wasm",
    yield* until(readFile(join(source, "clayterm.wasm"))),
    recipe.expected.wasm,
  );

  const generator = join(source, recipe.generator.path);
  verifyHash(recipe.generator.path, yield* until(readFile(generator)), recipe.generator.sha256);
  yield* command(source, Deno.execPath(), [
    "run",
    "--no-config",
    "--no-lock",
    "--allow-read",
    "--allow-write",
    generator,
  ]);
  const generated = yield* readTextFile(join(source, "wasm.ts"));
  pinned("wasm.ts", new TextEncoder().encode(generated), recipe.expected.wasmSource);
  const payload = /const compressed=d\(("[^"]*"),(\d+)\);/.exec(generated);
  if (!payload) {
    throw new Error("wasm.ts: no encoded engine payload");
  }

  const files: Record<string, string> = { "NOTICE.txt": notice };
  const esm = join(npm, "esm");
  for (const name of (yield* readdir(esm)).sort()) {
    if (name === "package.json") {
      continue;
    }
    let text = yield* readTextFile(join(esm, name));
    if (name.endsWith(".js")) {
      if (name === "wasm.js") {
        text = replaceOnce(
          text,
          /const compressed = d\("[^"]*", \d+\);/,
          `const compressed = d(${payload[1]}, ${payload[2]});`,
          name,
        );
      }
      text = `// @ts-self-types="./${name.slice(0, -".js".length)}.d.ts"\n${text}`;
    }
    files[name] = text;
  }
  return files;
}

/** Refuse any set that is not exactly the recipe's runtime, byte for byte. */
export function verifyTtyRuntime(
  files: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): void {
  for (const name of new Set([...Object.keys(files), ...Object.keys(expected)])) {
    const hash = expected[name];
    const text = files[name];
    if (hash === undefined || text === undefined) {
      throw new Error(
        `tty runtime ${name}: expected ${hash ?? "absent"}, actual ${text === undefined ? "missing" : "unexpected file"}`,
      );
    }
    verifyHash(`tty runtime ${name}`, text, hash);
  }
}

export function* publishTty(
  output: URL,
  files: Readonly<Record<string, string>>,
  recipe: TtyRecipe,
): Operation<void> {
  verifyTtyRuntime(files, recipe.expected.runtime);
  yield* ensureDirectory(fileURLToPath(new URL(".", output)));
  yield* replaceDirectoryThroughStaging(output, files);
}

export function prepareTty(repoRoot: URL, output = new URL(TTY_OUTPUT, repoRoot)): Operation<void> {
  return scoped(function* () {
    const recipe = yield* readTtyRecipe(repoRoot);
    const files = yield* buildTtyRuntime(repoRoot, recipe);
    yield* publishTty(output, files, recipe);
    console.log(`prepared ${TTY_OUTPUT}`);
  });
}
