import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { RJSFSchema, UiSchema } from "@rjsf/utils";
import withTheme from "@rjsf/core/lib/withTheme.js";
import { generateTheme } from "@rjsf/shadcn/lib/Theme/index.js";
import createPrecompiledValidator from "@rjsf/validator-ajv8/lib/createPrecompiledValidator.js";
import type { ValidatorFunctions } from "@rjsf/validator-ajv8/lib/types.js";
import { resolveHelper } from "./helpers.ts";

/**
 * The receiving side of the token-scoped external validator script. The server
 * precompiles a WebForm's schema with RJSF/Ajv and serves the result as a
 * same-origin script under the fixed `script-src 'self'` policy — no inline
 * script, nonce, `unsafe-eval`, blob, or data script. This bridge is what that
 * script resolves its helpers through and registers its validators with, so the
 * browser bundle carries no `new Function` and no eval path of its
 * own.
 */
interface WebFormBridge {
  resolveHelper(id: string): { default: unknown };
  register(validateFns: ValidatorFunctions, rootSchema: RJSFSchema, uiSchema?: UiSchema): void;
}

declare global {
  var __WEBFORM__: WebFormBridge;
}

const Form = withTheme(generateTheme());

function mount(validateFns: ValidatorFunctions, rootSchema: RJSFSchema, uiSchema?: UiSchema): void {
  const validator = createPrecompiledValidator(validateFns, rootSchema);
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("the form container element #root is missing from the page shell");
  }
  createRoot(container).render(
    createElement(Form, { schema: rootSchema, uiSchema: uiSchema ?? {}, validator }),
  );
}

function loadValidator(): void {
  const script = document.createElement("script");
  script.src = "validator.js";
  document.head.appendChild(script);
}

globalThis.__WEBFORM__ = {
  resolveHelper,
  register(validateFns: ValidatorFunctions, rootSchema: RJSFSchema, uiSchema?: UiSchema): void {
    mount(validateFns, rootSchema, uiSchema);
  },
};

loadValidator();
