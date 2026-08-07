import { main } from "effection";
import { exec } from "@effectionx/process";

const here = new URL("./", import.meta.url).pathname;

main(function* () {
  yield* exec(Deno.execPath(), {
    arguments: [
      "compile",
      "--allow-all",
      "--unstable-worker-options",
      "--node-modules-dir=manual",
      "--include",
      "host/loader.ts",
      "--output",
      "dist/proof",
      "host/main.ts",
    ],
    cwd: here,
  }).expect();
  console.log("built dist/proof");
});
