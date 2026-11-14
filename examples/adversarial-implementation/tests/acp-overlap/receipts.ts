import { exists, readTextFile } from "@effectionx/fs";
import { timebox } from "@effectionx/timebox";
import { sleep } from "effection";
import { z } from "zod";

export const overlapEnv = "XMD_TEST_DELIVERY_ACP_OVERLAP";
export const actorEnv = "XMD_TEST_DELIVERY_ACP_ACTOR";
export const actorSchema = z.enum(["winner", "contender", "later"]);
export const fableFailure = "Controlled Fable failure after the review prompt matched.";

export const promptReceipt = z.strictObject({
  provider: z.enum(["claude", "codex"]),
  disposition: z.enum(["sent", "failed", "completed", "other"]),
});
export type PromptReceipt = z.infer<typeof promptReceipt>;

export function waitForFile(path: string, timeout: number) {
  return timebox(timeout, function* () {
    while (!(yield* exists(path))) {
      yield* sleep(50);
    }
  });
}

export function* readPrompts(directory: string, actor: z.infer<typeof actorSchema>) {
  return z
    .array(promptReceipt)
    .parse(JSON.parse(yield* readTextFile(`${directory}/${actor}-prompts.json`)));
}
