import { main, ensure, until } from "effection";
import { readTextFile, rm } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

main(function* () {
  const [pkg] = process.argv.slice(2);
  const { createEmbeddedAdapters } = yield* until(
    import(pathToFileURL(join(pkg, "esm", "embedded-adapters.js")).href),
  );
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-npm-claude-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  const adapters = createEmbeddedAdapters(join(root, "adapters"));
  yield* adapters.materialize("claude");
  const packageRoot = dirname(dirname(adapters.executablePath("claude")));
  const vendor = join(packageRoot, "vendor", "claude-agent-sdk");
  const { transformSdk } = yield* until(import(pathToFileURL(join(vendor, "transform.mjs")).href));
  const pristine = yield* readTextFile(join(vendor, "sdk.mjs"));
  const repaired = yield* readTextFile(join(packageRoot, "dist", "sdk", "sdk.mjs"));
  const license = yield* readTextFile(join(vendor, "UPSTREAM-README.md"));
  const bridge = yield* readTextFile(join(packageRoot, "dist", "claude-sdk.js"));
  if (
    transformSdk(pristine) !== repaired ||
    !license.includes("Commercial Terms of Service") ||
    !bridge.includes("../dist/sdk/sdk.mjs")
  ) {
    throw new Error("The npm Claude snapshot lost its repaired SDK source closure");
  }
  console.log("CLAUDE_SDK_SOURCE true");
});
