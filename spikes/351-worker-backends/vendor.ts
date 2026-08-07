// Builds the vendored @cloudflare/dofs the #349 spike pins, then re-links it
// here. The dependency is declared as a file: path into that spike so a single
// vendored copy — with one provenance record — serves both.

import { main } from "effection";
import { exec } from "@effectionx/process";

const here = new URL("./", import.meta.url).pathname;
const dofsDir = new URL("../349-dofs/vendor/dofs/", import.meta.url).pathname;

main(function* () {
  yield* exec("npm", {
    arguments: ["install", "--no-audit", "--no-fund"],
    cwd: dofsDir,
  }).expect();
  yield* exec("npx", {
    arguments: ["tsc", "-p", "tsconfig.build.json"],
    cwd: dofsDir,
  }).expect();
  // --install-links copies the file: dependency, and npm reuses that copy on a
  // later install even when the source has been rebuilt since. Drop it so the
  // freshly built dist is the one that lands here.
  try {
    Deno.removeSync(new URL("./node_modules/@cloudflare/dofs", import.meta.url), {
      recursive: true,
    });
  } catch {
    // nothing to drop on a first run
  }
  yield* exec("npm", {
    arguments: ["install", "--install-links", "--no-audit", "--no-fund"],
    cwd: here,
  }).expect();
  console.log("vendored dofs built and linked");
});
