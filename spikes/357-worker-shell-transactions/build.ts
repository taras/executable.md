import { exec } from "@effectionx/process";
import { main } from "effection";

const here = new URL("./", import.meta.url).pathname;

main(function* () {
  for (
    const [source, output] of [
      ["host/main.ts", "dist/proof"],
      ["host/crash-host.ts", "dist/crash-host"],
    ]
  ) {
    yield* exec(Deno.execPath(), {
      arguments: [
        "compile",
        "--allow-all",
        "--unstable-worker-options",
        "--node-modules-dir=manual",
        "--include",
        "host/shell-worker.ts",
        "--output",
        output,
        source,
      ],
      cwd: here,
    }).expect();
  }
  console.log("built dist/proof and dist/crash-host");
});
