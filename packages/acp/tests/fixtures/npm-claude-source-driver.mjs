import { main, until } from "effection";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { packagedClaudeExchange } from "./claude-packaged-exchange.mjs";

main(function* () {
  const [pkg, fake, recipePath] = process.argv.slice(2);
  const { createEmbeddedAdapters } = yield* until(
    import(pathToFileURL(join(pkg, "esm/embedded-adapters.js")).href),
  );
  const recipe = JSON.parse(yield* until(readFile(recipePath, "utf8")));
  const result = yield* packagedClaudeExchange(
    createEmbeddedAdapters,
    resolve(fake),
    recipe.runtime,
  );
  console.log("CLAUDE_PACKAGED", JSON.stringify(result));
});
