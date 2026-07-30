/**
 * The compilation boundary: one schema, two validators that must agree.
 *
 * A submission is validated twice — once in the browser so a person sees a field
 * error where they made it, and once on the server, which is authoritative. The
 * two agree because they are the same compilation: both come from this function,
 * from one normalized schema, under one Ajv policy (`AJV_OPTIONS`, formats
 * disabled). Nothing here lets the two sides be configured apart.
 *
 * The browser's copy is *code*, not a schema. The form page runs under
 * `script-src 'self'` with no `unsafe-eval`, so an Ajv that compiles a schema in
 * the browser cannot run there at all. RJSF's precompiled-validator path exists
 * for exactly this, and `compileSchemaValidatorsCode` is its generator: the
 * server compiles the schema to JavaScript and serves it as a same-origin
 * script.
 *
 * That generated code is written for a CommonJS module — it assigns to `exports`
 * and reaches Ajv's runtime helpers through `require`. Neither exists on the form
 * page, so the script this module emits supplies both as function-local
 * bindings: `exports` is a fresh object, and `require` resolves only through
 * `__WEBFORM__.resolveHelper`, which answers for two vetted helpers and throws
 * for anything else. The wrapper then hands the collected functions, the schema,
 * and the UI schema to `__WEBFORM__.register`. There is no `eval`, no
 * `new Function`, no inline script, and no author-controlled code — the author's
 * schema reaches the page only as JSON data inside a string literal.
 */

import type { ValidateFunction } from "ajv";
import { compileSchemaValidatorsCode } from "@rjsf/validator-ajv8/lib/compileSchemaValidatorsCode.js";

import { AJV_OPTIONS, createServerAjv } from "./ajv-options.ts";
import type { Declaration } from "./declaration.ts";
import type { Json, JsonObject } from "./json.ts";
import { parseJsonObject } from "./json.ts";

/** A schema that survived declaration parsing but could not be compiled. */
export class SchemaCompileError extends Error {
  override name = "SchemaCompileError";
}

export interface CompiledForm {
  /** The normalized schema, as the browser and the fingerprint see it. */
  schema: JsonObject;
  /** The normalized UI schema, carried through uncompiled. */
  uiSchema: JsonObject | undefined;
  /** The authoritative synchronous validator for a submitted value. */
  validate: ValidateFunction;
  /** The same-origin script text the browser loads to build its validator. */
  validatorScript: string;
}

/**
 * The Ajv runtime helpers a compiled schema is allowed to ask for.
 *
 * With formats disabled, a draft-07 schema can only reach these two. Anything
 * else means the compilation policy changed underneath us, and the page would
 * fail at load with a thrown helper request — so it is refused here instead,
 * before a port exists. `client/helpers.ts` answers for exactly these ids; a
 * test proves the two lists still agree.
 */
const RUNTIME_HELPERS: readonly string[] = [
  "ajv/dist/runtime/equal",
  "ajv/dist/runtime/ucs2length",
];

export function compileForm(declaration: Declaration): CompiledForm {
  const validate = compileServerValidator(declaration.schema);
  const validatorScript = buildValidatorScript(declaration);
  return {
    schema: declaration.schema,
    uiSchema: declaration.uiSchema,
    validate,
    validatorScript,
  };
}

function compileServerValidator(schema: JsonObject): ValidateFunction {
  let validate: ValidateFunction;
  try {
    validate = createServerAjv().compile(schema);
  } catch (error) {
    throw new SchemaCompileError(`<WebForm> schema could not be compiled: ${messageOf(error)}`);
  }
  // Declaration parsing refuses `$async: true`, and this is the same check
  // against the compiled result: the property is what decides whether the
  // validator returns a promise, and only the validator can be asked.
  if ("$async" in validate && validate.$async === true) {
    throw new SchemaCompileError(
      "<WebForm> schema compiled to an asynchronous validator: submission validation is synchronous.",
    );
  }
  return validate;
}

function buildValidatorScript(declaration: Declaration): string {
  let generated: string;
  try {
    generated = compileSchemaValidatorsCode(declaration.schema, {
      ajvOptionsOverrides: AJV_OPTIONS,
      ajvFormatOptions: false,
    });
  } catch (error) {
    throw new SchemaCompileError(
      `<WebForm> schema could not be compiled for the browser: ${messageOf(error)}`,
    );
  }

  assertHelpersAllowed(generated);
  assertExportsValidators(generated);

  const schema = jsonLiteral(declaration.schema);
  const uiSchema =
    declaration.uiSchema === undefined ? "undefined" : jsonLiteral(declaration.uiSchema);

  return `"use strict";
(function () {
  var bridge = globalThis.__WEBFORM__;
  var exports = {};
  function require(id) {
    return bridge.resolveHelper(id);
  }
${generated}
  bridge.register(exports, ${schema}, ${uiSchema});
})();
`;
}

/**
 * Every helper the generated code asks for is one the page can answer.
 *
 * The ids are read out of the generated text because that is where the requests
 * are: the compiler emits `require("…").default` at the top of the module, and a
 * request the bridge would refuse is a page that loads and then breaks.
 */
function assertHelpersAllowed(generated: string): void {
  for (const match of generated.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    const id = match[1];
    if (!RUNTIME_HELPERS.includes(id)) {
      throw new SchemaCompileError(
        `<WebForm> the compiled schema requests the runtime helper "${id}", which the form ` +
          "page does not provide. Only " +
          RUNTIME_HELPERS.join(" and ") +
          " are available under the fixed formats-disabled policy.",
      );
    }
  }
}

/**
 * The generated code assigns its validators to `exports[...]`.
 *
 * Ajv's standalone compiler emits `module.exports = fn` for a lone anonymous
 * schema and `exports[key] = fn` when it is given named schemas, which is what
 * RJSF always does. Checking the shape turns a change in that contract into a
 * clear failure here rather than an empty validator map in the browser.
 */
function assertExportsValidators(generated: string): void {
  if (!/\bexports\[/.test(generated)) {
    throw new SchemaCompileError(
      "<WebForm> the compiled schema produced no exports[...] validator assignment, so the " +
        "form page would receive no validators.",
    );
  }
}

/**
 * A JSON value as an expression the generated script evaluates back to it.
 *
 * The result is `JSON.parse("…")` — a string literal the script parses
 * — rather than the serialization pasted in as a JavaScript object literal. The
 * two are not interchangeable, because JSON and JavaScript object initializers
 * disagree about exactly one key: in JSON `{"__proto__": {}}` is an ordinary
 * member, while as JavaScript source it sets the object's prototype and leaves no
 * own property. Pasting the text as source therefore dropped that key on its way
 * to the browser, so the page would build its form from a schema the server never
 * compiled. Handing the script JSON text and letting `JSON.parse` rebuild it keeps
 * JSON semantics all the way to the DOM.
 *
 * This is still data, not code. `JSON.parse` cannot execute anything, and there is
 * no `eval`, no `new Function`, and nothing author-controlled outside the string
 * literal.
 *
 * Serializing twice follows from that: the inner call produces the JSON text, and
 * the outer one turns that text into the JavaScript string literal the script
 * parses.
 *
 * The value is re-parsed from its own serialization first, so what the script
 * carries is provably nothing but JSON. `<` and the two Unicode line separators
 * are then escaped, which keeps the literal inert wherever it lands and
 * independent of how the bytes are delivered.
 *
 * That last point is a property of this literal, not of the whole script. Ajv's
 * generated code embeds the schema again, in its own `JSON.stringify` output,
 * which escapes neither — so a schema whose text contains `</script>` puts that
 * sequence in the script. It is delivered as a same-origin external script under
 * `script-src 'self'` and is never inlined into markup, which is what makes that
 * harmless; inlining it is not a supported delivery and the route table does not
 * offer one.
 */
function jsonLiteral(value: JsonObject): string {
  const roundTripped: Json = parseJsonObject(JSON.parse(JSON.stringify(value)));
  const literal = JSON.stringify(JSON.stringify(roundTripped))
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `JSON.parse(${literal})`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
