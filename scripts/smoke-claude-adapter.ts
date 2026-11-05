import { main, scoped, until } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { useTempDirectory } from "./lib/temp-directory.ts";
import { ClaudeRecipe } from "./lib/claude-recipe.ts";
import { inspectClaudeRuntime } from "../packages/acp/tests/fixtures/claude-packaged-exchange.mjs";

main(function* (args) {
  const binary = resolve(args[0] ?? "dist/xmd");
  const root = yield* useTempDirectory("xmd-smoke-claude-");
  const home = join(root, "home");
  yield* ensureDir(home);
  const fake = fileURLToPath(
    new URL("../packages/acp/tests/fixtures/fake-claude-cli.cjs", import.meta.url),
  );
  const log = join(root, "fake.log");
  const document = join(root, "workflow.md");
  yield* writeTextFile(document, '<Agent><Prompt text="hello" /></Agent>\n');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  );
  const result = yield* scoped(() =>
    exec(binary, {
      arguments: ["run", document, "--default-agent", "claude"],
      cwd: root,
      env: {
        ...env,
        HOME: home,
        XDG_CACHE_HOME: join(root, "cache"),
        npm_config_cache: join(root, "npm"),
        CLAUDE_CODE_EXECUTABLE: fake,
        FAKE_CLAUDE_LOG: log,
      },
    }).join(),
  );
  if (result.code !== 0 || !result.stdout.includes("answered")) {
    throw new Error(
      `Compiled Claude exchange failed (${result.code}): ${result.stdout}\n${result.stderr}`,
    );
  }
  const fakeLog = yield* readTextFile(log);
  if (!fakeLog.includes(fake) || !fakeLog.includes('"type":"user"')) {
    throw new Error(`The selected fake executable did not receive the prompt: ${fakeLog}`);
  }
  const recipe = ClaudeRecipe.parse(
    JSON.parse(
      yield* readTextFile(
        new URL("../packages/acp/vendor/adapters/claude/recipe.json", import.meta.url),
      ),
    ),
  );
  const adapters = join(home, ".xmd/adapters");
  const entries = yield* until(readdir(adapters));
  if (!entries.includes(recipe.expected.sha256)) {
    throw new Error(`Compiled payload digest differs: ${entries.join(", ")}`);
  }
  yield* inspectClaudeRuntime(
    join(adapters, recipe.expected.sha256, "node_modules/@agentclientprotocol/claude-agent-acp"),
    recipe.runtime,
  );
  console.log(
    `Compiled Claude answered; payload ${recipe.expected.sha256}, all ${Object.keys(recipe.runtime).length} executables match, original SDK absent`,
  );
});
