/**
 * Validation failures as the browser receives them.
 *
 * Ajv's `ErrorObject` is not a wire shape: it carries a `params` bag whose
 * contents vary by keyword and a `schema`/`parentSchema` pair that can hold the
 * whole schema back. Only the four fields a person's form needs to locate and
 * explain a failure cross the boundary, so what the page renders never depends on
 * Ajv's internal representation.
 */

import type { ErrorObject } from "ajv";
import type { JsonObject } from "./json.ts";

export interface Issue extends JsonObject {
  keyword: string;
  instancePath: string;
  schemaPath: string;
  message: string;
}

export function normalizeIssues(errors: readonly ErrorObject[] | null | undefined): Issue[] {
  if (!errors) {
    return [];
  }
  return errors.map((error) => ({
    keyword: error.keyword ?? "",
    instancePath: error.instancePath ?? "",
    schemaPath: error.schemaPath ?? "",
    message: error.message ?? "",
  }));
}
