/**
 * Run a generated validator script the way the form page runs it.
 *
 * Asserting on the script's text cannot show that the browser would get working
 * validators from it. The wrapper supplies `exports` and `require`, the generated
 * code assigns into one and calls the other, and the whole thing then hands its
 * results to `__WEBFORM__.register` — a contract whose only proof is executing
 * it. So the script is written to a scratch file and imported, against the real
 * `resolveHelper` the bundled client uses.
 *
 * The extension is `.mjs`, which every runtime loads as an ECMAScript module.
 * That is stricter than the page's own classic `<script>`: the script body is one
 * IIFE, so it behaves identically either way, and passing as a module rules out
 * the sloppy-mode constructs a classic script would have tolerated.
 *
 * The bridge global and the scratch directory are both removed when the calling
 * operation shuts down, however it exits.
 */

import { ensure, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveHelper } from "../client/helpers.ts";
import type { Json, JsonObject } from "../src/json.ts";

/**
 * A validator the browser would run, plus the error count from its last call.
 *
 * Ajv's compiled functions report their failures by setting `errors` on
 * themselves, so the count is read straight after each call rather than derived.
 */
export interface BrowserValidator {
  (data: Json): boolean;
  errorCount(): number;
}

/** What the script handed to `__WEBFORM__.register`. */
export interface Registration {
  validateFns: Record<string, BrowserValidator>;
  schema: JsonObject;
  uiSchema: JsonObject | undefined;
  /** Every helper id the script asked `resolveHelper` for, in request order. */
  requestedHelpers: string[];
}

export function* runValidatorScript(script: string): Operation<Registration> {
  // @effectionx/fs has no mkdtemp. A fresh directory per call also keeps every
  // script under a distinct URL, so the module cache never answers with an
  // earlier test's script.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "webform-validator-"));
  yield* ensure(() => rm(base, { recursive: true, force: true }));

  const module = new URL("validator.mjs", pathToFileURL(`${base}/`));
  yield* writeTextFile(module, script);

  const requestedHelpers: string[] = [];
  let registration: Registration | undefined;

  yield* ensure(() => {
    Reflect.deleteProperty(globalThis, "__WEBFORM__");
  });
  Reflect.set(globalThis, "__WEBFORM__", {
    resolveHelper(id: string): { default: unknown } {
      requestedHelpers.push(id);
      return resolveHelper(id);
    },
    register(validateFns: unknown, schema: unknown, uiSchema: unknown): void {
      registration = {
        validateFns: readValidateFns(validateFns),
        schema: readObject("schema", schema),
        uiSchema: uiSchema === undefined ? undefined : readObject("uiSchema", uiSchema),
        requestedHelpers,
      };
    },
  });

  yield* until(import(module.href));

  if (!registration) {
    throw new Error("the validator script did not call __WEBFORM__.register");
  }
  return registration;
}

/**
 * The registered validators, read rather than asserted: the script hands over a
 * plain object of functions, and every entry is checked so a missing or
 * non-callable validator fails here instead of at a confusing call later.
 */
function readValidateFns(value: unknown): Record<string, BrowserValidator> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("__WEBFORM__.register received a non-object validator map");
  }
  const validators: Record<string, BrowserValidator> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "function") {
      throw new Error(`the registered validator "${key}" is not a function`);
    }
    validators[key] = asBrowserValidator(entry);
  }
  if (Object.keys(validators).length === 0) {
    throw new Error("__WEBFORM__.register received no validators");
  }
  return validators;
}

/**
 * Wrap one compiled function so its verdict and its error count are both
 * readable, without naming Ajv's internal function type.
 */
function asBrowserValidator(compiled: Function): BrowserValidator {
  let errors = 0;
  const run = (data: Json): boolean => {
    const valid = Boolean(Reflect.apply(compiled, undefined, [data]));
    const reported = Reflect.get(compiled, "errors");
    errors = Array.isArray(reported) ? reported.length : 0;
    return valid;
  };
  return Object.assign(run, { errorCount: (): number => errors });
}

function readObject(name: string, value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`__WEBFORM__.register received a non-object ${name}`);
  }
  const entries: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    define(entries, key, readJson(entry));
  }
  return entries;
}

function readJson(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(readJson);
  }
  if (typeof value === "object") {
    const entries: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      define(entries, key, readJson(entry));
    }
    return entries;
  }
  throw new Error(`__WEBFORM__.register received a non-JSON ${typeof value}`);
}

/**
 * Add one key as a plain own data property, for the same reason `src/json.ts`
 * does: assigning `__proto__` reaches an inherited setter whose effect differs by
 * engine, so what the script registered would be read back differently on
 * different runtimes.
 */
function define(entries: JsonObject, key: string, value: Json): void {
  Object.defineProperty(entries, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * The single validator a form's script registers.
 *
 * One schema compiles to one root validator, keyed by the content hash RJSF
 * derives. That key is not part of any contract this package states, so a test
 * asks for "the" validator rather than naming it.
 */
export function rootValidator(registration: Registration): BrowserValidator {
  const keys = Object.keys(registration.validateFns);
  if (keys.length !== 1) {
    throw new Error(`expected exactly one registered validator, got ${keys.length}`);
  }
  return registration.validateFns[keys[0]];
}
