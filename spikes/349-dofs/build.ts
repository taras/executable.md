import { main } from "effection";
import { exec } from "@effectionx/process";

const here = new URL("./", import.meta.url).pathname;

main(function* () {
  yield* exec(Deno.execPath(), {
    arguments: [
      "compile",
      "--allow-all",
      "--frozen",
      "--node-modules-dir=manual",
      "--output",
      "dist/proof",
      "host/main.ts",
    ],
    cwd: here,
  }).expect();
  console.log("built dist/proof");
});
