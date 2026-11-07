import { Agent } from "@executablemd/core/api";
import type { Operation } from "effection";
import { z } from "zod";
import { describeFailure, isFilesFailure } from "./failure.ts";
import { retained } from "./observation.ts";
import { catalogSchema } from "./records.ts";

export const props = {
  type: "object",
  properties: {
    agent: { type: "string", minLength: 1 },
    choices: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
  },
  required: ["agent", "choices"],
  additionalProperties: false,
};

const input = z.strictObject({
  agent: z.string().min(1),
  choices: z.array(z.string().min(1)).min(1),
});

export default function* Inspect(value: unknown): Operation<unknown> {
  const { agent, choices } = input.parse(value);
  return yield* retained("delivery-review-catalog", catalogSchema, function* () {
    let advertised: string[] | null;
    try {
      const options = yield* Agent.operations.options(agent);
      advertised = options.model === null ? null : options.model.options.map((option) => option.id);
    } catch (error) {
      if (isFilesFailure(error)) {
        throw error;
      }
      return { state: "failed", choices, model: null, advertised: null, failure: describeFailure(error) };
    }
    const model = choices.find((choice) => advertised?.includes(choice) === true) ?? null;
    return {
      state: model === null ? "unavailable" : "selected",
      choices,
      model,
      advertised,
      failure: null,
    };
  });
}
