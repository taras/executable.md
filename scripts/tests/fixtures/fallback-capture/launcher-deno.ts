import { main, exit } from "effection";
import { captureProgram } from "../../../fallback-capture-deno.ts";
import { fileURLToPath } from "node:url";

main(function* () {
  const variant = Deno.args[0];
  if (!["seven", "zero", "fault", "hold", "reserved"].includes(variant)) {
    throw new Error("Unknown synthetic preflight child");
  }
  const child = fileURLToPath(new URL("./child-deno.ts", import.meta.url));
  const code = yield* captureProgram("consume", [
    "timeout", "--signal=TERM", "--kill-after=5s", "5s", Deno.execPath(), "run",
    "--allow-all", "--node-modules-dir=manual", "--cached-only", "--frozen", child, variant,
  ]);
  yield* exit(code);
});
