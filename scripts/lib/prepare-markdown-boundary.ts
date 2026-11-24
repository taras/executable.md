import { scoped, until } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, readTextFile } from "@effectionx/fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { MARKDOWN_BOUNDARY_SOURCE, MARKDOWN_BOUNDARY_OUTPUT } from "./prepared.ts";
import { verifyHash } from "./prepare-claude.ts";
import { replaceThroughStaging } from "./staged-write.ts";
import { useTempDirectory } from "./temp-directory.ts";

const Recipe = z.object({
  toolchain: z.string().regex(/^\d+\.\d+\.\d+$/),
  compilerCommit: z.string().regex(/^[0-9a-f]{40}$/),
  target: z.literal("wasm32-unknown-unknown"),
  wasmSha256: z.string().regex(/^[0-9a-f]{64}$/),
  moduleSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export function prepareMarkdownBoundary(
  root: URL,
  output = new URL(MARKDOWN_BOUNDARY_OUTPUT, root),
): Operation<void> {
  return scoped(function* () {
    const source = new URL(MARKDOWN_BOUNDARY_SOURCE, root);
    const recipe = Recipe.parse(JSON.parse(yield* readTextFile(new URL("recipe.json", source))));
    const cwd = resolve(fileURLToPath(source));
    function* rustup(args: string[]): Operation<string> {
      const result = yield* exec("rustup", { cwd, arguments: args }).expect();
      return result.stdout;
    }

    const installed = yield* rustup(["toolchain", "list"]);
    const hasCompiler = installed
      .split("\n")
      .some((line) => line.startsWith(recipe.toolchain + "-"));
    if (!hasCompiler) {
      yield* rustup([
        "toolchain",
        "install",
        recipe.toolchain,
        "--profile",
        "minimal",
        "--no-self-update",
      ]);
    }
    const targets = yield* rustup([
      "target",
      "list",
      "--installed",
      "--toolchain",
      recipe.toolchain,
    ]);
    if (!targets.split(/\s+/).includes(recipe.target)) {
      yield* rustup(["target", "add", "--toolchain", recipe.toolchain, recipe.target]);
    }
    const version = yield* rustup(["run", recipe.toolchain, "rustc", "--version", "--verbose"]);
    if (!version.split(/\r?\n/).includes("commit-hash: " + recipe.compilerCommit)) {
      throw new Error("The Markdown tracker Rust compiler does not match the preparation recipe");
    }

    yield* rustup([
      "run",
      recipe.toolchain,
      "cargo",
      "fetch",
      "--locked",
      "--target",
      recipe.target,
    ]);
    const targetDir = yield* useTempDirectory("xmd-markdown-boundary-");
    const cargoHome = resolve(cwd, Deno.env.get("CARGO_HOME") ?? join(homedir(), ".cargo"));
    // Panic locations survive stripping and must not contain host cache paths.
    const rustflags = JSON.stringify([
      `--remap-path-prefix=${join(cargoHome, "registry", "src")}=/cargo-registry`,
      `--remap-path-prefix=${cwd}=/markdown-boundary`,
    ]);
    yield* rustup([
      "run",
      recipe.toolchain,
      "cargo",
      "build",
      "--locked",
      "--offline",
      "--release",
      "--target",
      recipe.target,
      "--target-dir",
      targetDir,
      "--config",
      `target.${recipe.target}.rustflags=${rustflags}`,
    ]);
    const wasm = yield* until(
      readFile(join(targetDir, recipe.target, "release", "xmd_markdown_boundary.wasm")),
    );
    verifyHash("Markdown boundary WASM", wasm, recipe.wasmSha256);
    const module = `export const markdownBoundaryBase64: string = "${Buffer.from(wasm).toString("base64")}";\n`;
    verifyHash("Markdown boundary module", module, recipe.moduleSha256);
    yield* ensureDir(new URL("./", output));
    yield* replaceThroughStaging(output, module);
    console.log(`prepared ${MARKDOWN_BOUNDARY_OUTPUT} (${wasm.length} bytes of WASM)`);
  });
}
