import { main, scoped, until } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, exists, readTextFile, readdir, writeTextFile } from "@effectionx/fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TtyRecipe } from "../../lib/tty-recipe.ts";
import { buildTtyRuntime, compilerHost, publishTty, readTtyRecipe } from "../../lib/prepare-tty.ts";
import type { TtyInputs } from "../../lib/prepare-tty.ts";
import { downloadClaudeInput } from "../../lib/prepare-claude.ts";
import { sha256 } from "../../lib/claude-snapshot-module.ts";

const repo = new URL("../../../", import.meta.url);

function* run(argv: string[], cwd: string, receipt: string): Operation<void> {
  const result = yield* scoped(() => exec(argv[0]!, { arguments: argv.slice(1), cwd }).join());
  yield* writeTextFile(`${receipt}.log`, result.stdout + result.stderr);
  if (result.code !== 0) { throw new Error(`${argv.join(" ")} failed; see ${receipt}.log`); }
}

function* manifest(directory: string): Operation<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (yield* readdir(directory)).sort()) { files[name] = sha256(yield* until(readFile(join(directory, name)))); }
  return files;
}

/** Repack one verified archive with `path` changed, and pin the recipe to the repacked bytes. */
function* repacked(work: string, bytes: Uint8Array, path: string, recipe: TtyRecipe): Operation<{ source: Uint8Array; recipe: TtyRecipe }> {
  yield* ensureDir(work);
  yield* until(writeFile(join(work, "input.tgz"), bytes));
  yield* run(["tar", "-xzf", "input.tgz"], work, join(work, "extract"));
  const prefix = `tty-${recipe.source.commit}`;
  const target = join(work, prefix, path);
  yield* writeTextFile(target, (yield* readTextFile(target)).replace("void reduce(", "void reduced("));
  yield* run(["tar", "-czf", "changed.tgz", prefix], work, join(work, "repack"));
  const source = new Uint8Array(yield* until(readFile(join(work, "changed.tgz"))));
  const altered = TtyRecipe.parse(recipe);
  altered.source.sha256 = sha256(source);
  altered.source.bytes = source.length;
  return { source, recipe: altered };
}

main(function* (args) {
  if (args[0] !== "--artifacts" || !args[1]) { throw new Error("usage: tty-preparation-driver.ts --artifacts <private destination>"); }
  const evidence = resolve(args[1]);
  if (yield* exists(evidence)) { throw new Error(`Evidence destination already exists: ${evidence}`); }
  yield* ensureDir(evidence);
  const listed = yield* exec("git", { arguments: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd: fileURLToPath(repo) }).expect();
  const candidate: Record<string, string> = {};
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    if (yield* exists(new URL(path, repo))) { candidate[path] = sha256(yield* until(readFile(new URL(path, repo)))); }
  }
  yield* writeTextFile(join(evidence, "candidate.json"), JSON.stringify(candidate, null, 2) + "\n");

  const recipe = yield* readTtyRecipe(repo);
  const archive = recipe.compiler.archives[compilerHost()];
  if (!archive) { throw new Error(`No pinned WASI SDK archive for ${compilerHost()}`); }
  const inputs: TtyInputs = {
    source: yield* downloadClaudeInput(recipe.source),
    clay: yield* downloadClaudeInput(recipe.clay),
    npm: yield* downloadClaudeInput(recipe.npm),
    compiler: yield* downloadClaudeInput(archive),
  };

  const fresh: unknown[] = [];
  for (const index of [1, 2]) {
    const output = join(evidence, `fresh-${index}`, "tty");
    yield* scoped(function* () {
      const files = yield* buildTtyRuntime(repo, recipe, inputs);
      yield* publishTty(pathToFileURL(output), files, recipe);
    });
    const files = yield* manifest(output);
    const expected = JSON.stringify(recipe.expected.runtime, Object.keys(recipe.expected.runtime).sort());
    if (JSON.stringify(files, Object.keys(files).sort()) !== expected) { throw new Error(`Fresh preparation ${index} differs from the recipe runtime`); }
    fresh.push({ index, host: compilerHost(), wasm: recipe.expected.wasm, wasmSource: recipe.expected.wasmSource, files });
  }
  yield* writeTextFile(join(evidence, "fresh-output-correspondence.json"), JSON.stringify(fresh, null, 2) + "\n");

  const negative = join(evidence, "negative");
  const output = join(negative, "tty");
  yield* ensureDir(output);
  yield* writeTextFile(join(output, "mod.js"), "previous complete runtime\n");
  const corrupt = inputs.source.slice();
  corrupt[0] = corrupt[0]! ^ 1;
  const missing = yield* repacked(join(negative, "preimage"), inputs.source, "src/clayterm.c", recipe);
  const cases: Array<{ name: string; inputs: TtyInputs; recipe: TtyRecipe }> = [
    { name: "corrupt-source-archive", inputs: { ...inputs, source: corrupt }, recipe },
    { name: "missing-patch-preimage", inputs: { ...inputs, source: missing.source }, recipe: missing.recipe },
  ];
  const refusals: unknown[] = [];
  for (const test of cases) {
    let failure: unknown;
    try {
      yield* scoped(function* () {
        const files = yield* buildTtyRuntime(repo, test.recipe, test.inputs);
        yield* publishTty(pathToFileURL(output), files, test.recipe);
      });
    } catch (error) { failure = error; }
    if (!(failure instanceof Error)) { throw new Error(`Negative control passed: ${test.name}`); }
    const preserved = (yield* readdir(output)).join(",") === "mod.js" && (yield* readTextFile(join(output, "mod.js"))) === "previous complete runtime\n";
    if (!preserved) { throw new Error(`Negative control replaced prior output: ${test.name}`); }
    refusals.push({ name: test.name, refusal: failure.message, priorOutputPreserved: preserved });
  }
  yield* writeTextFile(join(evidence, "negative-controls.json"), JSON.stringify(refusals, null, 2) + "\n");
  console.log(JSON.stringify({ evidence, fresh: fresh.length, refusals }));
});
