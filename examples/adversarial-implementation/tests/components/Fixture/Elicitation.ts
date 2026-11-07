import { Component } from "@executablemd/core/api";
import { Elicitation } from "@executablemd/core";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { suspend } from "effection";
import type { Operation } from "effection";
import { z } from "zod";

export const props = {
  type: "object",
  properties: {
    record: { type: "string", pattern: "^/" },
    hold: { type: "string", pattern: "^/" },
    mode: { enum: ["answer", "fail", "suspend"] },
    answer: { type: "object", default: {} },
  },
  required: ["record", "hold", "mode"],
  additionalProperties: false,
};

const input = z.strictObject({
  record: z.string().startsWith("/"),
  hold: z.string().startsWith("/"),
  mode: z.enum(["answer", "fail", "suspend"]),
  answer: z.record(z.string(), z.unknown()),
});

function* present(path: string): Operation<boolean> {
  try {
    yield* readTextFile(path);
    return true;
  } catch {
    return false;
  }
}

function* recorded(path: string): Operation<unknown[]> {
  try {
    return z.array(z.unknown()).parse(JSON.parse(yield* readTextFile(path)));
  } catch {
    return [];
  }
}

export default function* ElicitationFixture(value: unknown): Operation<unknown> {
  const { record, hold, mode, answer } = input.parse(value);
  yield* Elicitation.around(
    {
      *elicit([request]) {
        const prior = yield* recorded(record);
        const held = yield* present(hold);
        yield* writeTextFile(record, JSON.stringify([...prior, { ...request, held }]));
        if (mode === "fail") {
          throw new Error("The fixture elicitation provider could not reach anyone.");
        }
        if (mode === "suspend") {
          yield* suspend();
        }
        return answer;
      },
    },
    { at: "min" },
  );
  return yield* Component.operations.content();
}
