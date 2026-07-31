/**
 * The form page.
 *
 * Everything the page does happens inside one Effection scope, opened by `run()`
 * at startup and closed when the tab goes away. That is not ceremony: an
 * `XMLHttpRequest` started by a React callback outlives the callback, and without
 * an owner it would keep pointing at a page that is being unloaded. The scope is
 * the owner, and leaving it aborts whatever is still in flight.
 *
 * The scope stays open by waiting on `pagehide`. Returning from the root
 * operation is what ends it — there is no `destroy()` to forget and no detached
 * scope to leak.
 *
 * React callbacks run outside any operation, so they re-enter through the
 * captured scope. Each re-entry contains its own failure: a task started with
 * `scope.run()` that throws propagates into the scope and takes its siblings with
 * it, which here would mean one failed submission killing the whole form.
 *
 * ## Order of appearance
 *
 * Nothing operable is shown until both halves are ready — the configuration and
 * the precompiled validator. A form mounted before its validator would accept
 * input it cannot check, and the person would find out only after submitting.
 * Until then, and on any failure, the page shows fixed text: no author content,
 * no server text, nothing executable.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { RJSFSchema, UiSchema } from "@rjsf/utils";
import withTheme from "@rjsf/core/lib/withTheme.js";
import { generateTheme } from "@rjsf/shadcn/lib/Theme/index.js";
import createPrecompiledValidator from "@rjsf/validator-ajv8/lib/createPrecompiledValidator.js";
import type { ValidatorFunctions } from "@rjsf/validator-ajv8/lib/types.js";
import { action, run, useScope, withResolvers } from "effection";
import type { Operation, Scope } from "effection";

import { resolveHelper } from "./helpers.ts";
import { markRequired } from "./field-template.ts";
import { parseConfig } from "./config.ts";
import type { FormConfig } from "./config.ts";
import { bannerFor, outcomeFor, TRANSPORT_MESSAGE } from "./outcome.ts";
import type { Banner, Outcome } from "./outcome.ts";
import { get, postJson } from "./request.ts";

interface Registration {
  validateFns: ValidatorFunctions;
  rootSchema: RJSFSchema;
  uiSchema?: UiSchema;
}

/**
 * The receiving side of the token-scoped external validator script. The server
 * precompiles a WebForm's schema with RJSF/Ajv and serves the result as a
 * same-origin script under the fixed `script-src 'self'` policy — no inline
 * script, nonce, `unsafe-eval`, blob, or data script. This bridge is what that
 * script resolves its helpers through and registers its validators with, so the
 * browser bundle carries no `new Function` and no eval path of its own.
 */
interface WebFormBridge {
  resolveHelper(id: string): { default: unknown };
  register(validateFns: ValidatorFunctions, rootSchema: RJSFSchema, uiSchema?: UiSchema): void;
}

declare global {
  var __WEBFORM__: WebFormBridge;
}

const STARTUP_FAILED =
  "This form could not be prepared. Close this tab and run the workflow again.";

const theme = generateTheme();

// Every template is optional to a theme, and this one wraps rather than
// replaces: without something to delegate to there is no field to render.
const themed = theme.templates?.FieldTemplate;
if (!themed) {
  throw new Error("the shadcn theme provided no FieldTemplate to wrap");
}

const Form = withTheme({
  ...theme,
  templates: { ...theme.templates, FieldTemplate: markRequired(themed) },
});

const registered = withResolvers<Registration>();

// Installed before the validator script is ever requested, so the script cannot
// arrive ahead of the bridge that receives it.
globalThis.__WEBFORM__ = {
  resolveHelper,
  register(validateFns: ValidatorFunctions, rootSchema: RJSFSchema, uiSchema?: UiSchema): void {
    registered.resolve({ validateFns, rootSchema, uiSchema });
  },
};

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`the page shell is missing #${id}`);
  }
  return found;
}

/**
 * Fixed text only. Author content never reaches the status region.
 *
 * The banner is stamped as an attribute rather than derived in CSS: whether an
 * answer landed is knowable here and nowhere in the stylesheet. Until the first
 * message there is no attribute, which is what keeps an empty region unpainted.
 */
function say(message: string, banner: Banner): void {
  const status = element("status");
  status.textContent = message;
  status.setAttribute("data-outcome", banner);
}

/**
 * Load the validator script the server precompiled for this form.
 *
 * The page runs under `script-src 'self'` with no `unsafe-eval`, so a validator
 * cannot be compiled here; it arrives as a same-origin script that calls back
 * into the bridge. Loading it is an operation so a halt removes the element's
 * listeners rather than leaving them attached to a page that is going away.
 */
function loadValidatorScript(): Operation<void> {
  return action<void>((resolve, reject) => {
    const script = document.createElement("script");
    const onLoad = (): void => resolve();
    const onError = (): void => reject(new Error("the validator script failed to load"));
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    script.src = "validator.js";
    document.head.appendChild(script);
    return () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
  });
}

/** Resolves when the tab is going away, which is what ends the scope. */
function untilPageHide(): Operation<void> {
  return action<void>((resolve) => {
    const onHide = (): void => resolve();
    globalThis.addEventListener("pagehide", onHide);
    return () => globalThis.removeEventListener("pagehide", onHide);
  });
}

function* submit(formData: unknown): Operation<void> {
  const result = yield* postJson("submit", JSON.stringify(formData ?? null));
  apply(outcomeFor(result.status));
}

function apply(outcome: Outcome): void {
  say(outcome.message, bannerFor(outcome));
  if (!outcome.formUsable) {
    element("root").setAttribute("hidden", "hidden");
  }
  if (outcome.closable) {
    // A script can only close a window it opened, so this may do nothing at
    // all. The message above is the actual fallback.
    globalThis.close();
  }
}

function mount(config: FormConfig, registration: Registration, scope: Scope): void {
  // Sanitized on the server by `renderBody`. This is the only place author
  // content enters the DOM.
  element("content").innerHTML = config.bodyHtml;

  const validator = createPrecompiledValidator(registration.validateFns, registration.rootSchema);

  createRoot(element("root")).render(
    createElement(Form, {
      schema: registration.rootSchema,
      uiSchema: registration.uiSchema ?? {},
      validator,
      onSubmit: (event: { formData?: unknown }) => {
        // React calls this outside any operation. Re-entering through the
        // captured scope gives the request an owner; catching inside keeps a
        // failed submission from tearing the scope down with it.
        scope.run(function* () {
          try {
            yield* submit(event.formData);
          } catch {
            say(TRANSPORT_MESSAGE, "failed");
          }
        });
      },
    }),
  );
}

function* start(): Operation<void> {
  const scope = yield* useScope();

  const response = yield* get("config.json");
  if (response.status !== 200) {
    throw new Error(`the form configuration could not be loaded (${response.status})`);
  }
  const config = parseConfig(response.body);

  yield* loadValidatorScript();
  const registration = yield* registered.operation;

  mount(config, registration, scope);
}

run(function* () {
  try {
    yield* start();
  } catch {
    // Fixed text, never the failure's own message: nothing the server or the
    // author wrote is rendered on a path that has already gone wrong.
    say(STARTUP_FAILED, "failed");
    return;
  }
  yield* untilPageHide();
});
