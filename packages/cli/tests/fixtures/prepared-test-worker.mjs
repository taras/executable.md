import { Plugin } from "@executablemd/core/api";
import { API } from "@executablemd/runtime";
import { fileURLToPath } from "node:url";

const denoEntrypoint = fileURLToPath(new URL("../../src/deno.ts", import.meta.url));

export default Plugin({
  name: "prepared-test-worker",
  *install() {
    yield* API.Env.around({
      *command([args], next) {
        const argv = yield* next(args);
        if (args?.[0] !== "test-agent" || argv[3] !== denoEntrypoint) {
          return argv;
        }
        // A Deno worker otherwise reinitializes the Bun or pnpm links.
        return [
          ...argv.slice(0, 3),
          "--node-modules-dir=manual",
          "--cached-only",
          "--frozen",
          ...argv.slice(3),
        ];
      },
    });
  },
});
