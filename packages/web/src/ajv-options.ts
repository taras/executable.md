/**
 * The shared Ajv policy for WebForm schema validation.
 *
 * `AJV_OPTIONS` is what both sides override RJSF's own configuration with, and
 * `createServerAjv` is how the server gets an Ajv that matches the browser's.
 * Formats are disabled on both sides, which is what keeps a compiled validator's
 * runtime-helper surface down to `equal` and `ucs2length` — the only two helpers
 * the bundled client resolves.
 *
 * Equivalence is a property of the *construction path*, not of a list of
 * options. `compileSchemaValidatorsCode` builds its Ajv through RJSF's
 * `createAjvInstance`, which starts from RJSF's `AJV_CONFIG` and then spreads
 * these overrides on top. A bare `new Ajv({ ...AJV_OPTIONS })` therefore differs
 * from it by everything in `AJV_CONFIG` these options do not mention —
 * `multipleOfPrecision: 8`, `verbose: true`, `discriminator: false` — and by the
 * `data-url` and `color` formats and the RJSF property-flag keyword that
 * function registers.
 *
 * That is not hypothetical: `multipleOfPrecision` alone made a bare server
 * reject `4.22` against `{ type: "number", multipleOf: 0.01 }` while the browser
 * accepted it, because binary floating point leaves `4.22 / 0.01` a hair away
 * from an integer. So the server is built through the same function rather than
 * by restating any single default here, and a future change to `AJV_CONFIG`
 * reaches both sides at once.
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
 * The server's Ajv: RJSF's construction, these overrides, no formats.
 *
 * `Ajv` from `"ajv"` is the draft-07 entry — the draft the authoring contract
 * names — rather than `ajv/dist/2020`, and it is the class `createAjvInstance`
 * defaults to. Nothing in the browser bundle imports this module; the client's
 * copy of the policy is baked into the validator the server precompiles for it.
 */
export function createServerAjv(): Ajv {
  return createAjvInstance(undefined, undefined, AJV_OPTIONS, false);
}
