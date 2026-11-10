import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import {
  copyFile,
  ensureDir,
  exists,
  readTextFile,
  readdir,
  rm,
  writeTextFile,
} from "@effectionx/fs";
import { ProcessApi } from "@effectionx/process";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { packClaude } from "../lib/prepare-claude.ts";
import { sha256 } from "../lib/claude-snapshot-module.ts";
import {
  buildTtyRuntime,
  compilerHost,
  publishTty,
  readTtyRecipe,
  TTY_OUTPUT,
} from "../lib/prepare-tty.ts";
import type { TtyInputs } from "../lib/prepare-tty.ts";
import type { TtyRecipe } from "../lib/tty-recipe.ts";
import { FileWrites } from "../lib/staged-write.ts";
import { PREPARED_INPUTS, recordedCopy } from "../lib/prepared.ts";

const REPO = new URL("../../", import.meta.url);
const PRIOR = "previous complete runtime\n";

/** A directory holding one complete earlier output, which every refusal must leave alone. */
function* priorOutput(): Operation<URL> {
  const root = yield* useTempDirectory("tty-prior-");
  yield* ensureDir(join(root, "tty"));
  yield* writeTextFile(join(root, "tty", "mod.js"), PRIOR);
  return pathToFileURL(join(root, "tty"));
}

function* unchanged(output: URL): Operation<void> {
  const path = fileURLToPath(output);
  expect(yield* readdir(dirname(path))).toEqual(["tty"]);
  expect(yield* readdir(path)).toEqual(["mod.js"]);
  expect(yield* readTextFile(join(path, "mod.js"))).toBe(PRIOR);
}

function prepareInto(output: URL, recipe: TtyRecipe, inputs: TtyInputs): Operation<void> {
  return scoped(function* () {
    yield* publishTty(output, yield* buildTtyRuntime(REPO, recipe, inputs), recipe);
  });
}

function pin(bytes: Uint8Array): { sha256: string; bytes: number } {
  return { sha256: sha256(bytes), bytes: bytes.length };
}

function archive(files: Record<string, string>): Operation<Uint8Array> {
  return packClaude(
    Object.entries(files).map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) })),
  );
}

/**
 * Small archives that reach the local patch's preimage check, and a recipe
 * pinned to them. The upstream patch and its target are real enough for
 * `git apply`; the engine source is not the pinned one.
 */
function* syntheticInputs(engine: string): Operation<{ recipe: TtyRecipe; inputs: TtyInputs }> {
  const recipe = yield* readTtyRecipe(REPO);
  const upstream = "--- a/clay.h\n+++ b/clay.h\n@@ -1 +1 @@\n-header\n+patched header\n";
  const inputs: TtyInputs = {
    source: yield* archive({
      "patches/clay-debug-mode-enabled.patch": upstream,
      "src/clayterm.c": engine,
    }),
    clay: yield* archive({ "clay.h": "header\n" }),
    npm: yield* archive({ "esm/mod.js": "export {};\n" }),
    compiler: yield* archive({ "bin/clang": "#!/bin/sh\nexit 1\n" }),
  };
  const host = recipe.compiler.archives[compilerHost()];
  if (!host) {
    throw new Error(`No pinned WASI SDK archive for ${compilerHost()}`);
  }
  recipe.source = { ...recipe.source, ...pin(inputs.source) };
  recipe.clay = { ...recipe.clay, ...pin(inputs.clay), headerSha256: sha256("header\n") };
  recipe.npm = {
    ...recipe.npm,
    ...pin(inputs.npm),
    integrity: `sha512-${createHash("sha512").update(inputs.npm).digest("base64")}`,
  };
  recipe.compiler.archives[compilerHost()] = { ...host, ...pin(inputs.compiler) };
  recipe.upstreamPatch = { ...recipe.upstreamPatch, sha256: sha256(upstream) };
  recipe.preimages = { ...recipe.preimages, "clay/clay.h": sha256("patched header\n") };
  return { recipe, inputs };
}

/** Every command the producer starts, by executable and first argument. */
function* counted(): Operation<string[]> {
  const started: string[] = [];
  yield* ProcessApi.around({
    *exec([command, options], next) {
      started.push(`${command.split("/").pop()} ${options?.arguments?.[0] ?? ""}`);
      return yield* next(command, options);
    },
  });
  return started;
}

describe("tty preparation refuses before replacing a complete output", () => {
  it("refuses a corrupt input archive before any tool starts", function* () {
    const output = yield* priorOutput();
    const started = yield* counted();
    const { recipe, inputs } = yield* syntheticInputs("void reduce(void) {}\n");
    const corrupt = inputs.source.slice();
    corrupt[0] = (corrupt[0] ?? 0) ^ 1;
    let failure: unknown;
    try {
      yield* prepareInto(output, recipe, { ...inputs, source: corrupt });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("tty source archive: expected SHA-256");
    expect(started).toEqual([]);
    yield* unchanged(output);
  });

  it("refuses an engine source that is not the local patch's preimage", function* () {
    const output = yield* priorOutput();
    const started = yield* counted();
    const { recipe, inputs } = yield* syntheticInputs("void reduced(void) {}\n");
    let failure: unknown;
    try {
      yield* prepareInto(output, recipe, inputs);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("src/clayterm.c: expected SHA-256");
    // Extraction and the upstream patch ran; no local patch and no compiler did.
    expect(started).toEqual([
      "tar -xzf",
      "tar -xzf",
      "tar -xzf",
      "tar -xzf",
      "git apply",
      "git apply",
    ]);
    yield* unchanged(output);
  });

  it("joins a held tool before removing scratch when halted", function* () {
    const output = yield* priorOutput();
    const { recipe, inputs } = yield* syntheticInputs("void reduce(void) {}\n");
    const { createServer } = yield* until(import("node:net"));
    const { once } = yield* until(import("@effectionx/node/events"));
    const connected = withResolvers<void>();
    const server = createServer();
    const handler = (): void => {
      connected.resolve();
    };
    yield* ensure(function* () {
      server.off("connection", handler);
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    server.on("connection", handler);
    server.listen(0, "127.0.0.1");
    yield* once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No gate address");
    }
    let scratch = "";
    yield* ProcessApi.around({
      *exec([_command, options], next) {
        // The first tool extracts an archive inside the scratch directory itself.
        scratch = options?.cwd ?? "";
        return yield* next("node", {
          cwd: scratch,
          arguments: ["-e", `require("node:net").connect(${address.port}, "127.0.0.1");`],
        });
      },
    });
    const task = yield* spawn(() => prepareInto(output, recipe, inputs));
    yield* connected.operation;
    expect(yield* exists(scratch)).toBe(true);
    yield* task.halt();
    expect(yield* exists(scratch)).toBe(false);
    yield* unchanged(output);
  });
});

describe("tty publication", () => {
  function* runtimeRecipe(files: Record<string, string>): Operation<TtyRecipe> {
    const recipe = yield* readTtyRecipe(REPO);
    recipe.expected.runtime = Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, sha256(text)]),
    );
    return recipe;
  }

  it("replaces a complete directory and leaves no staging", function* () {
    const output = yield* priorOutput();
    const files = { "mod.js": "export const complete = true;\n", "NOTICE.txt": "notice\n" };
    yield* publishTty(output, files, yield* runtimeRecipe(files));
    const path = fileURLToPath(output);
    expect(yield* readdir(dirname(path))).toEqual(["tty"]);
    expect((yield* readdir(path)).sort()).toEqual(["NOTICE.txt", "mod.js"]);
    expect(yield* readTextFile(join(path, "mod.js"))).toBe(files["mod.js"]);
  });

  it("refuses a missing, unexpected or altered file", function* () {
    const output = yield* priorOutput();
    const files = { "mod.js": "complete\n", "NOTICE.txt": "notice\n" };
    const recipe = yield* runtimeRecipe(files);
    for (const [offered, refusal] of [
      [{ "mod.js": "complete\n" }, "tty runtime NOTICE.txt: expected"],
      [{ ...files, "extra.js": "x" }, "tty runtime extra.js: expected absent"],
      [{ ...files, "mod.js": "altered\n" }, "tty runtime mod.js: expected SHA-256"],
    ] as const) {
      let failure: unknown;
      try {
        yield* publishTty(output, offered, recipe);
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain(refusal);
      yield* unchanged(output);
    }
  });

  it("joins a held staged write on halt and keeps the previous directory", function* () {
    const output = yield* priorOutput();
    const files = { "mod.js": "complete\n", "NOTICE.txt": "notice\n" };
    const recipe = yield* runtimeRecipe(files);
    const started = withResolvers<void>();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    yield* FileWrites.with(
      (path, text) => {
        order.push("write:start");
        started.resolve();
        return held
          .then(() => writeFile(path, text))
          .then(() => {
            order.push("write:settle");
          });
      },
      function* () {
        try {
          const task = yield* spawn(() => scoped(() => publishTty(output, files, recipe)));
          yield* started.operation;
          const haltStarted = withResolvers<void>();
          const halting = yield* spawn(function* () {
            const completion = task.halt();
            order.push("halt:start");
            haltStarted.resolve();
            yield* completion;
            order.push("halt:return");
          });
          yield* haltStarted.operation;
          release();
          yield* halting;
        } finally {
          release();
        }
      },
    );
    expect(order).toEqual(["write:start", "halt:start", "write:settle", "halt:return"]);
    yield* unchanged(output);
  });
});

describe("prepared tty preflight", () => {
  it("refuses missing, altered, unexpected and stale output before graph consumption", function* () {
    const { unprepared, assertPrepared } = yield* until(import("../lib/preflight-deno.ts"));
    const base = yield* useTempDirectory("tty-preflight-");
    const root = pathToFileURL(`${base}/`);
    for (const input of PREPARED_INPUTS) {
      for (const relative of [input, recordedCopy(input)]) {
        yield* ensureDir(dirname(fileURLToPath(new URL(relative, root))));
        yield* copyFile(new URL(input, REPO), new URL(relative, root));
      }
    }
    const claude = "packages/acp/generated/claude-snapshot.ts";
    yield* ensureDir(fileURLToPath(new URL("packages/acp/generated/", root)));
    yield* copyFile(new URL(claude, REPO), new URL(claude, root));
    expect(unprepared(root)).toBe(`${TTY_OUTPUT} is missing`);
    expect(() => assertPrepared(root)).toThrow("deno task setup");

    const output = fileURLToPath(new URL(`${TTY_OUTPUT}/`, root));
    yield* ensureDir(output);
    for (const name of yield* readdir(new URL(`${TTY_OUTPUT}/`, REPO))) {
      yield* copyFile(new URL(`${TTY_OUTPUT}/${name}`, REPO), join(output, name));
    }
    expect(unprepared(root)).toBeUndefined();

    yield* writeTextFile(join(output, "wasm.js"), "altered");
    expect(unprepared(root)).toBe(`${TTY_OUTPUT}/wasm.js does not match the prepared recipe`);
    expect(() => assertPrepared(root)).toThrow("deno task setup");
    yield* copyFile(new URL(`${TTY_OUTPUT}/wasm.js`, REPO), join(output, "wasm.js"));

    yield* rm(join(output, "NOTICE.txt"));
    expect(unprepared(root)).toBe(`${TTY_OUTPUT}/NOTICE.txt does not match the prepared recipe`);
    yield* copyFile(new URL(`${TTY_OUTPUT}/NOTICE.txt`, REPO), join(output, "NOTICE.txt"));

    yield* writeTextFile(join(output, "extra.js"), "");
    expect(unprepared(root)).toBe(`${TTY_OUTPUT}/extra.js does not match the prepared recipe`);
    yield* rm(join(output, "extra.js"));
    expect(unprepared(root)).toBeUndefined();

    const patch = new URL("packages/cli/vendor/tty/clay-text-cache.patch", root);
    yield* writeTextFile(patch, (yield* readTextFile(patch)) + "\n");
    expect(unprepared(root)).toBe(
      "packages/cli/vendor/tty/clay-text-cache.patch changed since dependencies were installed",
    );
    expect(() => assertPrepared(root)).toThrow("deno task setup");
  });
});
