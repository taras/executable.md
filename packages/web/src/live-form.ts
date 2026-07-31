/**
 * One live form, from listener to answer.
 *
 * Two halves, because *when* compilation happens is part of the contract. A
 * schema that cannot be compiled must fail before anything observable — before
 * assets are read, before a durable operation begins, before a port is bound.
 * `prepareForm` is everything that can fail cheaply; `runPreparedForm` is
 * everything that cannot be undone.
 *
 * `liveForm` joins them for a caller that has no durability of its own — #197's
 * `<Elicit>`, or anything else that needs a person's answer without owning a
 * server. `<WebForm>` calls the halves separately, so its compilation lands
 * outside its journal entry.
 *
 * Everything the run starts lives in one scope: the listener, its sockets, the
 * launch task, and the responder. Returning or failing dismantles all of it, and
 * the server's own contract means the browser has been told its answer was
 * accepted first.
 */

import { scoped, spawn } from "effection";
import type { Operation } from "effection";

import { assets } from "./assets.ts";
import { compileForm } from "./compile.ts";
import type { CompiledForm } from "./compile.ts";
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

/** A form whose schema has compiled. Nothing observable has happened yet. */
export interface PreparedForm {
  compiled: CompiledForm;
  content: string;
}

/**
 * Compile a form's schema for both sides.
 *
 * Synchronous and effect-free: it either produces a form that can be served or
 * throws, and a caller that has not yet begun anything can still stop.
 */
export function prepareForm(input: LiveFormInput): PreparedForm {
  return {
    compiled: compileForm({ schema: input.schema, uiSchema: input.uiSchema }),
    content: input.content,
  };
}

/** Serve a prepared form and wait for its one validated answer. */
export function runPreparedForm(prepared: PreparedForm): Operation<Json> {
  return scoped(function* () {
    const { clientJs, themeCss } = yield* assets();

    const server = yield* useFormServer({
      compiled: prepared.compiled,
      bodyHtml: prepared.content,
      clientJs,
      themeCss,
    });

    yield* announceForm(server.url);

    // Spawned rather than awaited: production answers nothing, and a responder
    // that blocked would hold the form open against its own answer. The scope
    // owns it, so leaving halts it.
    yield* spawn(function* () {
      yield* respond(server.url);
    });

    return yield* server.submission;
  });
}

/** Compile and serve in one step, for a caller with no durability of its own. */
export function liveForm(input: LiveFormInput): Operation<Json> {
  return runPreparedForm(prepareForm(input));
}
