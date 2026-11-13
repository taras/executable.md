import { useProviderInstallation } from "@executablemd/core";
import { Agent } from "@executablemd/core/api";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  DurablePersistenceError,
  StaleInputError,
  TerminalDivergenceError,
} from "@executablemd/durable-streams";
import { API, parseFilesFailure } from "@executablemd/runtime";
import { asFilesFatal } from "@executablemd/runtime/files";
import { all } from "effection";
import type { Operation } from "effection";
import { z } from "zod";
import { retainedVerdict } from "../Delivery/observation.ts";
import { inspectionRecipeSchema } from "../Phase/ProviderName.ts";

export const props = {
  type: "object",
  properties: {
    repository: { type: "string", minLength: 1 },
    recipe: z.toJSONSchema(inspectionRecipeSchema),
  },
  required: ["repository", "recipe"],
  additionalProperties: false,
};

const input = z.strictObject({ repository: z.string().min(1), recipe: inspectionRecipeSchema });
type Recipe = z.infer<typeof inspectionRecipeSchema>;

function infrastructure(...errors: unknown[]): Error | undefined {
  const seen = new Set<unknown>();
  let files: Error | undefined;
  for (const error of errors) {
    if (!(error instanceof Error) || seen.has(error)) {
      continue;
    }
    seen.add(error);
    if (
      error instanceof ContinuePastCloseDivergenceError ||
      error instanceof DivergenceError ||
      error instanceof DurablePersistenceError ||
      error instanceof StaleInputError ||
      error instanceof TerminalDivergenceError
    ) {
      return error;
    }
    files ??= asFilesFatal(error) ?? (parseFilesFailure(error) === undefined ? undefined : error);
    errors.push(error.cause);
    if (error instanceof AggregateError) {
      errors.push(...error.errors);
    }
  }
  return files;
}

export default function* Admission(value: unknown): Operation<boolean> {
  const { repository, recipe } = input.parse(value);
  return yield* admit(repository, recipe);
}

export function admit(repository: string, recipe: Recipe): Operation<boolean> {
  return retainedVerdict("entry-codex-verdict", z.boolean(), () => observe(repository, recipe));
}

function* observe(repository: string, recipe: Recipe): Operation<boolean> {
  const { registration, agent, model, effort } = recipe;
  let bodyFailure: Error | undefined;
  function* inspect(): Operation<boolean> {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return repository;
        },
      },
      { at: "min" },
    );
    try {
      yield* useProviderInstallation(registration, {
        defaultAgent: agent,
        permissionMode: "deny-all",
      });
      const options = yield* Agent.operations.options(agent, { model });
      return (
        options.model?.options.some((choice) => choice.id === model) === true &&
        options.effort?.options.some((choice) => choice.id === effort) === true
      );
    } catch (error) {
      // Teardown can replace the body's error at the join.
      bodyFailure = infrastructure(error);
      throw error;
    }
  }

  try {
    const [admitted] = yield* all([inspect()]);
    return admitted;
  } catch (error) {
    const failure = infrastructure(bodyFailure, error);
    if (failure !== undefined) {
      throw failure;
    }
    return false;
  }
}
