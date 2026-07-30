/**
 * The shared Ajv options for WebForm schema validation. The server precompiles
 * every runtime schema with exactly these options, and the client's precompiled
 * validator runs under the same policy, so client and server always agree on
 * what a valid submission is. Formats are disabled on both sides, which is what
 * keeps a compiled validator's runtime-helper surface down to `equal` and
 * `ucs2length` — the only two helpers the bundled client resolves.
 */

import { Ajv } from "ajv";
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
 * The server's Ajv, under exactly `AJV_OPTIONS` and with no formats installed.
 *
 * `Ajv` from `"ajv"` is the draft-07 entry — the draft the authoring contract
 * names — rather than `ajv/dist/2020`. Formats are disabled by
 * `validateFormats: false` and by adding no format plugin, which is the same
 * policy `compileSchemaValidatorsCode` is given through `ajvFormatOptions:
 * false`. Nothing in the browser bundle imports this module; the client's copy
 * of the policy is baked into the validator the server precompiles for it.
 */
export function createServerAjv(): Ajv {
  return new Ajv({ ...AJV_OPTIONS });
}
