import { z } from "zod";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ScenarioModels } from "@executablemd/testing";
import type { PropsSchema } from "@executablemd/core";

const id = z.string().min(1);
const efforts = z
  .object({ selected: id, options: z.array(id).min(1) })
  .strict()
  .refine(
    (value) =>
      new Set(value.options).size === value.options.length &&
      value.options.includes(value.selected),
    "effort selections must be unique members of their options",
  );
export const modelsSchema = z
  .object({
    selected: id,
    options: z.array(z.object({ id, efforts: efforts.nullish() }).strict()).min(1),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.options.map((option) => option.id)).size === value.options.length &&
      value.options.some((option) => option.id === value.selected),
    "model selections must be unique members of their options",
  );

export function normalizeModels(value: unknown): ScenarioModels | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = modelsSchema.parse(value);
  return Object.freeze({
    selected: parsed.selected,
    options: Object.freeze(
      parsed.options.map((model) =>
        Object.freeze({
          id: model.id,
          ...(model.efforts == null
            ? {}
            : {
                efforts: Object.freeze({
                  selected: model.efforts.selected,
                  options: Object.freeze([...model.efforts.options]),
                }),
              }),
        }),
      ),
    ),
  });
}

export function selectConfiguration(
  models: ScenarioModels | undefined,
  configId: string,
  value: string,
): ScenarioModels {
  if (models === undefined) {
    throw new Error("Configuration choices are unavailable.");
  }
  if (configId === "model" && models.options.some((model) => model.id === value)) {
    return { ...models, selected: value };
  }
  const selected = models.options.find((model) => model.id === models.selected);
  const efforts = selected?.efforts;
  if (configId === "effort" && efforts?.options.includes(value)) {
    return {
      ...models,
      options: models.options.map((model) =>
        model.id !== selected?.id ? model : { ...model, efforts: { ...efforts, selected: value } },
      ),
    };
  }
  throw new Error("Unsupported configuration choice.");
}

export interface ConfigurationSnapshot {
  model: string | null;
  effort: string | null;
}
export function configurationSnapshot(models: ScenarioModels | undefined): ConfigurationSnapshot {
  return {
    model: models?.selected ?? null,
    effort:
      models?.options.find((model) => model.id === models.selected)?.efforts?.selected ?? null,
  };
}

export function configOptions(
  models: ScenarioModels | undefined,
): SessionConfigOption[] | undefined {
  if (models === undefined) {
    return undefined;
  }
  const options: SessionConfigOption[] = [
    {
      id: "model",
      name: "model",
      category: "model",
      type: "select",
      currentValue: models.selected,
      options: models.options.map((model) => ({ value: model.id, name: model.id })),
    },
  ];
  const selected = models.options.find((model) => model.id === models.selected);
  if (selected?.efforts != null) {
    options.push({
      id: "effort",
      name: "effort",
      category: "thought_level",
      type: "select",
      currentValue: selected.efforts.selected,
      options: selected.efforts.options.map((value) => ({ value, name: value })),
    });
  }
  return options;
}

export const MODELS_PROPS: PropsSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        selected: { type: "string", minLength: 1 },
        options: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1 },
              efforts: {
                anyOf: [
                  { type: "null" },
                  {
                    type: "object",
                    properties: {
                      selected: { type: "string", minLength: 1 },
                      options: {
                        type: "array",
                        minItems: 1,
                        uniqueItems: true,
                        items: { type: "string", minLength: 1 },
                      },
                    },
                    required: ["selected", "options"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["selected", "options"],
      additionalProperties: false,
    },
  ],
};
