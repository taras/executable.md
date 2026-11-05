import { Component } from "@executablemd/core/api";
import { API } from "@executablemd/runtime";
import type { Operation } from "effection";
import { readFinite } from "./native-node.ts";

export const props = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1, maximum: 8_388_608, default: 8_388_608 } },
  additionalProperties: false,
};

export default function* Finite(input: { limit: number }): Operation<string> {
  yield* API.Fs.around({
    *readTextFile([path]) {
      return yield* readFinite(path, input.limit);
    },
  });
  const outcome = yield* Component.operations.tryContent();
  if (outcome.failure !== undefined) {
    throw outcome.failure;
  }
  return outcome.text;
}
