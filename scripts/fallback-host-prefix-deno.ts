import { main, exit } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { runOneFile, TestRuns } from "./lib/runtime-tests.ts";
import { retainedProcess } from "./fallback-capture-deno.ts";

main(function* () {
  const [checkout, evidence, channels] = z
    .tuple([z.string(), z.string(), z.string()])
    .parse(Deno.args);
  const path = fileURLToPath(new URL("./fallback-host-prefix-selection.json", import.meta.url));
  const text = yield* readTextFile(path);
  if (
    createHash("sha256").update(text).digest("hex") !==
    "6db26d5e39b4933c1043a3073a5c22a4473c987f8dcdcfaece541994510649ce"
  ) {
    throw new Error("Fixed prefix selection digest mismatch");
  }
  const selection = z
    .object({
      runtime: z.literal("bun"),
      product: z.literal("35749f4267d42449f26b6a18c4911a0ab7222923"),
      files: z.array(z.string()).length(20),
      target: z.literal("packages/cli/tests/adversarial-delivery.test.ts"),
    })
    .parse(JSON.parse(text));
  if (new Set(selection.files).size !== 20 || selection.files.includes(selection.target)) {
    throw new Error("Invalid fixed prefix inventory");
  }
  yield* writeTextFile(join(evidence, "prefix-selection.json"), text);
  let index = 0;
  yield* TestRuns.set(function* (launch) {
    index++;
    return (yield* retainedProcess(
      [launch.command, ...launch.arguments],
      launch.cwd,
      evidence,
      channels,
      `prefix-${String(index).padStart(2, "0")}`,
    )).code;
  });
  for (const file of selection.files) {
    const code = yield* runOneFile("bun", file, pathToFileURL(checkout + "/"));
    if (code !== 0) {
      yield* exit(code);
      return;
    }
  }
});
