import { ensure, main, until } from "effection";
import { exec } from "@effectionx/process";
import * as esbuild from "esbuild";

const here = new URL("./", import.meta.url).pathname;

main(function* () {
  yield* ensure(function* () {
    yield* until(esbuild.stop());
  });

  yield* until(esbuild.build({
    entryPoints: [`${here}worker/worker.mjs`],
    bundle: true,
    format: "esm",
    outfile: `${here}dist/worker.js`,
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "warning",
  }));

  yield* exec(Deno.execPath(), {
    arguments: [
      "compile",
      "--allow-all",
      "--frozen",
      "--node-modules-dir=none",
      "--exclude-unused-npm",
      "--include",
      "vendor/workerd",
      "--include",
      "dist/worker.js",
      "--include",
      "host/config.capnp",
      "--include",
      "host/config-backends.capnp",
      "--output",
      "dist/proof",
      "host/main.ts",
    ],
    cwd: here,
  }).expect();

  console.log("built dist/proof");
});
