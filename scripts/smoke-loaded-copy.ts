import { ensure, main, until } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceCore = join(repoRoot, "packages/core");

await main(function* () {
  const fixture = yield* until(mkdtemp(join(tmpdir(), "xmd-loaded-copy-")));
  yield* ensure(() => rm(fixture, { recursive: true, force: true }));

  const installedCore = join(fixture, "node_modules/@executablemd/core/mod.js");
  yield* ensureDir(dirname(installedCore));
  const entry = join(fixture, "installed-core-entry.ts");
  yield* writeTextFile(
    entry,
    `export { printErrors } from ${JSON.stringify(
      pathToFileURL(join(sourceCore, "src/component-failures.ts")).href,
    )};\n`,
  );
  const bundle = yield* exec(Deno.execPath(), {
    arguments: [
      "--cached-only",
      "--frozen",
      "bundle",
      "--node-modules-dir=none",
      entry,
      "--output",
      installedCore,
    ],
    cwd: repoRoot,
  }).join();
  if (bundle.code !== 0) {
    throw new Error(
      `could not build the separately loaded core:\n${bundle.stdout}${bundle.stderr}`,
    );
  }

  const components = join(fixture, "components");
  yield* ensureDir(components);
  yield* writeTextFile(
    join(components, "LoadedCopyPrintedError.ts"),
    [
      'import { printErrors } from "../node_modules/@executablemd/core/mod.js";',
      "",
      "export default printErrors(function* () {",
      '  throw new Error("LOADED_COPY_PRINT_ERRORS");',
      "});",
      "",
    ].join("\n"),
  );

  const result = yield* exec(join(repoRoot, "dist/xmd"), {
    arguments: [
      "-e",
      "<LoadedCopyPrintedError />\n\nAFTER_LOADED_COPY",
      "--component-dir",
      components,
      "--raw",
    ],
    cwd: fixture,
  }).join();
  const output = `${result.stdout}${result.stderr}`;

  if (result.code !== 0) {
    throw new Error(`loaded-copy smoke failed with exit ${result.code}:\n${output}`);
  }
  for (const marker of ["LOADED_COPY_PRINT_ERRORS", "AFTER_LOADED_COPY"]) {
    if (!result.stdout.includes(marker)) {
      throw new Error(`loaded-copy smoke did not render ${marker}:\n${output}`);
    }
  }
});
