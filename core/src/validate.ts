/**
 * Prop validation for component invocations (spec §5.5).
 *
 * Components only accept props declared in their `inputs` frontmatter.
 * Runtime operation — deterministic, no journal entry.
 */

import type { InputDefinition, Json } from "./types.ts";

/**
 * Error thrown when prop validation fails.
 */
export class PropValidationError extends Error {
  componentName: string;
  errors: string[];

  constructor(componentName: string, errors: string[]) {
    super(`Prop validation failed for <${componentName} />:\n  - ${errors.join("\n  - ")}`);
    this.name = "PropValidationError";
    this.componentName = componentName;
    this.errors = errors;
  }
}

/**
 * Validate caller props against declared inputs.
 *
 * - Rejects undeclared props
 * - Enforces required props
 * - Applies default values
 * - Validates types and enum constraints
 */
export function validateProps(
  componentName: string,
  callerProps: Record<string, Json>,
  inputs: Record<string, InputDefinition>,
): Record<string, Json> {
  const validated: Record<string, Json> = {};
  const errors: string[] = [];

  // Check for undeclared props
  for (const key of Object.keys(callerProps)) {
    if (!(key in inputs)) {
      errors.push(
        `Unknown prop "${key}" passed to <${componentName} />. ` +
          `Declared inputs: ${Object.keys(inputs).join(", ") || "(none)"}`,
      );
    }
  }

  // Validate and fill defaults for each declared input
  for (const [key, def] of Object.entries(inputs)) {
    if (key in callerProps) {
      const value = callerProps[key]!;

      // Type check
      if (def.type !== "any" && !checkType(value, def.type)) {
        errors.push(
          `Prop "${key}" on <${componentName} /> expected ${def.type}, ` + `got ${typeof value}`,
        );
      }

      // Enum check
      if (def.enum && !def.enum.includes(value)) {
        errors.push(
          `Prop "${key}" on <${componentName} /> must be one of: ` +
            `${def.enum.join(", ")}. Got: ${JSON.stringify(value)}`,
        );
      }

      validated[key] = value;
    } else if ("default" in def && def.default !== undefined) {
      // Apply default
      validated[key] = def.default;
    } else if (def.required) {
      errors.push(`Required prop "${key}" missing on <${componentName} />`);
    }
    // Optional with no default and not provided → not in validated
  }

  if (errors.length > 0) {
    throw new PropValidationError(componentName, errors);
  }

  return validated;
}

function checkType(value: Json, type: InputDefinition["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "any":
      return true;
  }
}
