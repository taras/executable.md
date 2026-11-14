import { exists, writeTextFile } from "@effectionx/fs";
import { timebox } from "@effectionx/timebox";
import { env } from "@executablemd/runtime";
import { sleep, until } from "effection";
import { appendFile } from "node:fs/promises";
import { z } from "zod";

export const props = {
  type: "object",
  properties: { directory: { type: "string" }, call: { type: "object" } },
  required: ["directory", "call"],
  additionalProperties: false,
};

export const reviewProcessEnv = "XMD_TEST_DELIVERY_REVIEW_PROCESS";
const processName = z.enum(["winner", "contender", "later"]);
export const reviewCall = z.strictObject({
  position: z.number().int(),
  revision: z.string(),
  reviewer: z.record(z.string(), z.json()),
  prompted: z.boolean(),
});

export function waitForFile(path: string, timeout: number) {
  return timebox(timeout, function* () {
    while (!(yield* exists(path))) {
      yield* sleep(50);
    }
  });
}

export default function* ReviewDispatch(value: unknown) {
  const selected = yield* env(reviewProcessEnv);
  if (selected === undefined) {
    return false;
  }

  const actor = processName.parse(selected);
  const { directory, call } = z
    .strictObject({ directory: z.string(), call: reviewCall })
    .parse(value);
  const evidence = `${directory}/overlap`;
  yield* until(appendFile(`${evidence}/${actor}.jsonl`, `${JSON.stringify(call)}\n`));
  if (actor === "winner" && call.position === 1) {
    yield* writeTextFile(`${evidence}/ready`, "");
    if ((yield* waitForFile(`${evidence}/release`, 45_000)).timeout) {
      throw new Error("Timed out waiting to release the replacement reviewer.");
    }
  }
  return true;
}
