import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { content, Elicitation } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { cwd } from "@executablemd/runtime";
import type { Operation } from "effection";
import { join } from "node:path";

export const props = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

export default function* OwnerAnswer(elementProps: Record<string, Json>): Operation<string> {
  if (typeof elementProps.path !== "string") {
    throw new Error("the fixture requires its counter path");
  }
  const path = join(yield* cwd(), elementProps.path);
  yield* Elicitation.around({
    *elicit([request]) {
      const before = (yield* exists(path)) ? yield* readTextFile(path) : "";
      const answer = request.message.trim();
      yield* writeTextFile(path, `${before}${answer}\n`);
      return answer;
    },
  });
  return yield* content();
}
