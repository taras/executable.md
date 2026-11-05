import { main, scoped, until } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { copyFile, ensureDir, exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { ClaudeRecipe, recipeInputsSha256 } from "../../lib/claude-recipe.ts";
import { buildClaudePayload, downloadClaudeInput, publishClaude } from "../../lib/prepare-claude.ts";
import { claudeSnapshotModule, sha256 } from "../../lib/claude-snapshot-module.ts";

const repo = new URL("../../../", import.meta.url);
function* child(argv: string[], cwd: string, env: Record<string, string>, receipt: string): Operation<void> {
  const start = Date.now();
  const result = yield* scoped(() => exec(argv[0]!, { arguments: argv.slice(1), cwd, env }).join());
  yield* writeTextFile(`${receipt}.log`, result.stdout + result.stderr);
  yield* writeTextFile(`${receipt}.json`, JSON.stringify({ argv, cwd, exitCode: result.code, signal: result.signal, elapsedMs: Date.now() - start }, null, 2) + "\n");
  if (result.code !== 0) { throw new Error(`${argv.join(" ")} failed; see ${receipt}.log`); }
}

main(function* (args) {
  if (args[0] !== "--artifacts" || !args[1]) { throw new Error("usage: claude-preparation-driver.ts --artifacts <private destination>"); }
  const evidence = resolve(args[1]);
  yield* ensureDir(evidence);
  const inherited = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  const tracked = yield* exec("git", { arguments: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd: fileURLToPath(repo) }).expect();
  const paths = tracked.stdout.split("\0").filter(Boolean);
  const inputs: Record<string, string> = {};
  for (const path of paths) {
    if (yield* exists(new URL(path, repo))) { inputs[path] = sha256(yield* until(readFile(new URL(path, repo)))); }
  }
  yield* writeTextFile(join(evidence, "candidate.json"), JSON.stringify(inputs, null, 2) + "\n");
  const recipe = ClaudeRecipe.parse(JSON.parse(yield* readTextFile(new URL("packages/acp/vendor/adapters/claude/recipe.json", repo))));
  const outputs: unknown[] = [];
  for (const index of [1, 2]) {
    const root = join(evidence, `fresh-${index}`);
    if (yield* exists(root)) { throw new Error(`Fresh destination already exists: ${root}`); }
    yield* ensureDir(root);
    for (const path of Object.keys(inputs)) {
      yield* ensureDir(dirname(join(root, path)));
      yield* copyFile(new URL(path, repo), join(root, path));
    }
    const env = { ...inherited, HOME: join(evidence, `home-${index}`), DENO_DIR: join(evidence, `deno-${index}`), npm_config_cache: join(evidence, `npm-${index}`), npm_config_store_dir: join(evidence, `pnpm-${index}`) };
    yield* ensureDir(env.HOME);
    if (yield* exists(join(root, "packages/acp/generated/claude-snapshot.ts"))) { throw new Error("Fresh tree contains prepared Claude output"); }
    yield* child([Deno.execPath(), "task", "setup"], root, env, join(evidence, `setup-${index}`));
    const source = yield* readTextFile(join(root, "packages/acp/generated/claude-snapshot.ts"));
    if (sha256(source) !== recipe.expected.moduleSha256) { throw new Error(`Fresh module ${index} differs`); }
    outputs.push({ index, moduleSha256: sha256(source), expected: recipe.expected });
  }
  yield* writeTextFile(join(evidence, "fresh-output-correspondence.json"), JSON.stringify(outputs, null, 2) + "\n");
  const source = yield* downloadClaudeInput(recipe.source);
  const sdk = yield* downloadClaudeInput(recipe.sdk);
  const negativeRoot = join(evidence, "negative");
  yield* ensureDir(negativeRoot);
  const output = pathToFileURL(join(negativeRoot, "claude.ts"));
  const sentinel = "previous complete module\n";
  yield* writeTextFile(output, sentinel);
  const failures: unknown[] = [];
  const corrupt = source.slice(); corrupt[0] = corrupt[0]! ^ 1;
  const cases: Array<{name: string; source: Uint8Array; sdk: Uint8Array; recipe: ClaudeRecipe}> = [
    { name: "corrupt-source-archive", source: corrupt, sdk, recipe },
  ];
  // Repack a verified input only to reach a distinct inner validation boundary.
  for (const kind of ["lock", "sdk-input", "adapter-preimage"]) {
    const work = join(negativeRoot, kind); yield* ensureDir(work);
    const bytes = kind === "sdk-input" ? sdk : source;
    yield* until(writeFile(join(work, "input.tgz"), bytes));
    yield* child(["tar", "-xzf", "input.tgz"], work, inherited, join(work, "extract"));
    const prefix = kind === "sdk-input" ? "package" : `claude-agent-acp-${recipe.upstreamCommit}`;
    const path = kind === "lock" ? "package-lock.json" : kind === "sdk-input" ? "sdk.mjs" : "src/acp-agent.ts";
    const target = join(work, prefix, path);
    yield* writeTextFile(target, (yield* readTextFile(target)) + "\n");
    yield* child(["tar", "-czf", "changed.tgz", prefix], work, inherited, join(work, "repack"));
    const changed = yield* until(readFile(join(work, "changed.tgz")));
    const altered = ClaudeRecipe.parse(recipe);
    if (kind === "sdk-input") {
      altered.sdk.sha256 = sha256(changed); altered.sdk.bytes = changed.length;
      const { createHash } = yield* until(import("node:crypto"));
      altered.sdk.integrity = `sha512-${createHash("sha512").update(changed).digest("base64")}`;
    } else { altered.source.sha256 = sha256(changed); altered.source.bytes = changed.length; }
    altered.inputsSha256 = recipeInputsSha256(altered);
    cases.push({ name: kind, source: kind === "sdk-input" ? source : changed, sdk: kind === "sdk-input" ? changed : sdk, recipe: altered });
  }
  for (const test of cases) {
    let failure: unknown;
    try {
      const bytes = yield* scoped(() => buildClaudePayload(repo, test.recipe, test));
      yield* publishClaude(output, bytes, test.recipe);
    } catch (error) { failure = error; }
    if (!(failure instanceof Error)) { throw new Error(`Negative control passed: ${test.name}`); }
    if ((yield* readTextFile(output)) !== sentinel) { throw new Error(`Negative control replaced prior output: ${test.name}`); }
    failures.push({ name: test.name, refusal: failure.message, priorOutputPreserved: true });
  }
  const sdkWork = join(negativeRoot, "sdk-input/package/sdk.mjs");
  const pristine = (yield* readTextFile(sdkWork)).slice(0, -1);
  const transform = yield* until(import(new URL("packages/acp/vendor/adapters/claude/sdk-transform.mjs", repo).href));
  for (const [name, input] of [["missing-sdk-site", pristine.replace("class yk{options;process;", "class absent{")], ["duplicate-sdk-site", pristine + "class yk{options;process;"]]) {
    let failure: unknown;
    try { transform.transformSdk(input); } catch (error) { failure = error; }
    if (!(failure instanceof Error) || !failure.message.includes("exactly once")) { throw new Error(`Patch-site control did not refuse: ${name}`); }
    failures.push({ name, refusal: failure.message, priorOutputPreserved: (yield* readTextFile(output)) === sentinel });
  }
  if (yield* exists(join(negativeRoot, "node_modules/.xmd-prepared"))) { throw new Error("Negative probe claimed readiness"); }
  yield* writeTextFile(join(evidence, "negative-controls.json"), JSON.stringify(failures, null, 2) + "\n");
  console.log(`Claude preparation evidence: ${evidence}`);
});
