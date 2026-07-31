/**
 * Answering a form without a person.
 *
 * Two pieces, deliberately separate. `FormResponder.respond` receives only the
 * form's URL: whoever installs it has already closed over the answer, so nothing
 * downstream ever carries predetermined data — not a component prop, not a
 * live-form input, not the authoring contract. Production answers nothing.
 *
 * `submitForm` is the submission itself, and it speaks the same HTTP a browser
 * speaks to the same token-scoped URL. An injected responder goes through it, so
 * the token, the exact `Host`, the loopback `Origin`, the media type, the 1 MiB
 * ceiling, schema validation, the single reservation, the 409, and the wait for
 * the 204 all still apply. A responder able to skip any of those would make a
 * green test say nothing about whether a browser could submit.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import { action } from "effection";
import type { Operation } from "effection";
import { request } from "node:http";

import type { Json } from "./json.ts";

export interface FormResponderApi {
  /**
   * Answer the form at `url`.
   *
   * The URL is the only input. An implementation that needs an answer holds it
   * already; asking for one here is what would push test data into the caller.
   */
  respond(url: string): Operation<void>;
}

export const FormResponder: Api<FormResponderApi> = createApi<FormResponderApi>("FormResponder", {
  // A live form is answered by a person, so the default does nothing at all and
  // the submission stays pending until one arrives.
  // deno-lint-ignore require-yield
  *respond(): Operation<void> {},
});

export const respond: Operations<FormResponderApi>["respond"] = FormResponder.operations.respond;

export interface FormResponse {
  status: number;
  body: string;
}

/**
 * Submit to a form's URL exactly as its page would.
 *
 * `Origin` is set to the form's own origin because the server refuses a
 * submission without it. That is not a bypass — it is what a browser on that page
 * sends, and the server still checks it. `Host` is left to `node:http` to derive
 * from the URL, so it names where the request is actually going.
 */
export function submitForm(url: string, data: Json): Operation<FormResponse> {
  return postJson(new URL("submit", url), JSON.stringify(data));
}

function postJson(url: URL, body: string): Operation<FormResponse> {
  return action<FormResponse>((resolve, reject) => {
    const payload = new TextEncoder().encode(body);

    const outgoing = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.byteLength),
          Origin: url.origin,
        },
      },
      (incoming) => {
        let received = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          received += chunk;
        });
        incoming.on("end", () => {
          resolve({ status: incoming.statusCode ?? 0, body: received });
        });
        incoming.on("error", (error: Error) => reject(error));
      },
    );

    outgoing.on("error", (error: Error) => reject(error));
    outgoing.end(payload);

    // Runs however the action ends, so a halted responder leaves no socket.
    return () => {
      outgoing.destroy();
    };
  });
}
