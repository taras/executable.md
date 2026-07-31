/**
 * One live form, from listener to answer.
 *
 * This is the whole browser interaction and the only thing that performs it, so
 * `<WebForm>` and #197's `<Elicit>` can both ask for a person's answer without
 * either owning a server. It takes what a form *is* — a schema, an optional UI
 * schema, and content to show — and nothing about where those came from: no
 * props, no `as`, no journal state, no element.
 *
 * Everything it starts lives in one scope: the listener, its sockets, the launch
 * task, and the responder. Returning or failing dismantles all of it, and the
 * server's own contract means the browser has been told its answer was accepted
 * before that happens.
 */

import { scoped, spawn } from "effection";
import type { Operation } from "effection";

import { assets } from "./assets.ts";
import { compileForm } from "./compile.ts";
import type { Json, JsonObject } from "./json.ts";
import { announceForm } from "./opener.ts";
import { respond } from "./responder.ts";
import { useFormServer } from "./server.ts";

export interface LiveFormInput {
  /** Normalized draft-07 schema. */
  schema: JsonObject;
  /** Normalized RJSF UI schema, if the author supplied one. */
  uiSchema?: JsonObject;
  /** Already sanitized by `renderBody`; served as-is. */
  content: string;
}

export function liveForm(input: LiveFormInput): Operation<Json> {
  return scoped(function* () {
    const { clientJs, themeCss } = yield* assets();
    const compiled = compileForm({ schema: input.schema, uiSchema: input.uiSchema });

    const server = yield* useFormServer({
      compiled,
      bodyHtml: input.content,
      clientJs,
      themeCss,
    });

    yield* announceForm(server.url);

    // Spawned rather than awaited: production answers nothing, and a responder
    // that blocked would otherwise hold the form open against its own answer.
    // The scope owns it, so leaving halts it.
    yield* spawn(function* () {
      yield* respond(server.url);
    });

    return yield* server.submission;
  });
}
