/**
 * Fixtures and observation helpers for the form-server tests.
 *
 * Two things every test here needs and neither should re-invent: a real compiled
 * form (PR 2's parser and compiler, never a stand-in), and a way to ask whether
 * `submission` has settled *without waiting on it*. The second is what lets a
 * test assert "this request was refused and the form is still open" — the whole
 * point of the refusal paths.
 */

import { spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { connect } from "node:net";

import { compileForm } from "../src/compile.ts";
import { parseDeclaration } from "../src/declaration.ts";
import type { Json } from "../src/json.ts";
import type { FormServerInput } from "../src/server.ts";
import type { FormServer } from "../src/server.ts";

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    note: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
};

/** A schema whose only property is an unbounded string, for size tests. */
export const NOTE_SCHEMA = {
  type: "object",
  properties: { note: { type: "string" } },
  required: ["note"],
  additionalProperties: false,
};

export const CLIENT_JS = "/* client bundle fixture */\nglobalThis.__CLIENT__ = 1;\n";
export const THEME_CSS = ":root { --fixture: 1; }\n";
export const BODY_HTML = "<h1>Review</h1>\n<p>Please decide.</p>";

export function formInput(schema: unknown = REVIEW_SCHEMA): FormServerInput {
  return {
    compiled: compileForm(parseDeclaration("WebForm", schema)),
    bodyHtml: BODY_HTML,
    clientJs: CLIENT_JS,
    themeCss: THEME_CSS,
  };
}

/** The port and origin a URL names, so tests can address the live server. */
export function addressOf(url: string): { port: number; origin: string; prefix: string } {
  const parsed = new URL(url);
  return {
    port: Number(parsed.port),
    origin: `${parsed.protocol}//${parsed.host}`,
    prefix: parsed.pathname,
  };
}

export type SubmissionState =
  | { readonly kind: "pending" }
  | { readonly kind: "resolved"; readonly value: Json }
  | { readonly kind: "rejected"; readonly error: Error };

/**
 * Watch `submission` without waiting on it.
 *
 * The watcher is a spawned task, so the result is observed the moment it settles
 * and a test can read the state at any synchronization point it already has —
 * after a response it read, for instance. No test needs a timer to decide whether
 * something "hasn't happened yet".
 */
export function* watchSubmission(server: FormServer): Operation<() => SubmissionState> {
  let state: SubmissionState = { kind: "pending" };
  yield* spawn(function* () {
    try {
      state = { kind: "resolved", value: yield* server.submission };
    } catch (error) {
      state = {
        kind: "rejected",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
  return () => state;
}

/** Whether a fresh connection to this port is refused. */
export function* portRefuses(port: number): Operation<boolean> {
  const socket = connect(port, "127.0.0.1");
  const settled = withResolvers<boolean>();
  socket.once("connect", () => settled.resolve(false));
  socket.once("error", () => settled.resolve(true));
  const refused = yield* settled.operation;
  socket.destroy();
  return refused;
}

/** A JSON body whose UTF-8 encoding is exactly `bytes` long. */
export function noteBodyOfBytes(bytes: number, filler = "x"): string {
  const overhead = new TextEncoder().encode(JSON.stringify({ note: "" })).byteLength;
  const fillerBytes = new TextEncoder().encode(filler).byteLength;
  const remaining = bytes - overhead;
  if (remaining < 0 || remaining % fillerBytes !== 0) {
    throw new Error(`cannot build a ${bytes}-byte body from ${fillerBytes}-byte filler`);
  }
  return JSON.stringify({ note: filler.repeat(remaining / fillerBytes) });
}
