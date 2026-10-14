/**
 * Both validators use RJSF's `createAjvInstance` with these overrides and formats
 * disabled. A bare Ajv with the same overrides omits RJSF defaults and keywords:
 * notably `multipleOfPrecision: 8`, without which the server rejects `4.22` for
 * `multipleOf: 0.01` while the browser accepts it. Sharing the construction path
 * keeps future RJSF defaults aligned, too. Disabling formats limits the client's
 * runtime helpers to `equal` and `ucs2length`.
 */

import createAjvInstance from "@rjsf/validator-ajv8/lib/createAjvInstance.js";
import type { Ajv } from "ajv";

export const AJV_OPTIONS = {
  strict: true,
  allErrors: true,
  validateSchema: true,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
  addUsedSchema: false,
  validateFormats: false,
};

/**
 * Uses RJSF's default draft-07 Ajv entry. Only the server imports this module;
 * the browser receives its policy through the precompiled validator.
 */
export function createServerAjv(): Ajv {
  return createAjvInstance(undefined, undefined, AJV_OPTIONS, false);
}
