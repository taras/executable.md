/**
 * The shared Ajv options for WebForm schema validation. The server precompiles
 * every runtime schema with exactly these options, and the client's precompiled
 * validator runs under the same policy, so client and server always agree on
 * what a valid submission is. Formats are disabled on both sides, which is what
 * keeps a compiled validator's runtime-helper surface down to `equal` and
 * `ucs2length` — the only two helpers the bundled client resolves.
 */
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
