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
import { ensure, scoped, withResolvers } from "effection";
import type { Operation } from "effection";
import { request } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";

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
export function submitForm(
  url: string,
  data: Json,
  observe?: (request: ClientRequest) => void,
): Operation<FormResponse> {
  return postJson(new URL("submit", url), JSON.stringify(data), observe);
}

function postJson(
  url: URL,
  body: string,
  observe?: (request: ClientRequest) => void,
): Operation<FormResponse> {
  return scoped(function* () {
    const payload = new TextEncoder().encode(body);
    const settled = withResolvers<FormResponse>();
    const closed = withResolvers<void>();
    // `close`, and nothing else. A destroyed request has not necessarily
    // finished emitting: the peer's hang-up arrives afterwards, and this is
    // what says there is nothing left to observe.
    let finished = false;

    let received = "";
    let incoming: IncomingMessage | undefined;
    let outgoing: ClientRequest | undefined;

    const onData = (chunk: string): void => {
      received += chunk;
    };
    const onEnd = (): void => {
      settled.resolve({ status: incoming?.statusCode ?? 0, body: received });
    };
    const onFailure = (error: Error): void => settled.reject(error);
    const onClose = (): void => {
      finished = true;
      closed.resolve();
    };

    // Established before the request exists, because `yield* ensure(...)` is
    // itself a suspension: an owner halted while it registers unwinds with no
    // cleanup at all.
    //
    // The error observer stays attached across the destroy. `destroy()` on a
    // live request makes the peer's end arrive as an asynchronous `error` —
    // "socket hang up" — and an `error` an emitter has no listener for is
    // thrown, not dropped. So the wait for `close` is what says the request can
    // no longer emit, and only then is anything detached.
    yield* ensure(function* () {
      try {
        if (outgoing && !finished) {
          if (!outgoing.destroyed) {
            outgoing.destroy();
          }
          yield* closed.operation;
        }
      } finally {
        if (incoming) {
          incoming.off("data", onData);
          incoming.off("end", onEnd);
          incoming.off("error", onFailure);
        }
        if (outgoing) {
          outgoing.off("error", onFailure);
          outgoing.off("close", onClose);
        }
      }
    });

    outgoing = request(
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
      (response) => {
        incoming = response;
        response.setEncoding("utf8");
        response.on("data", onData);
        response.on("end", onEnd);
        response.on("error", onFailure);
      },
    );

    observe?.(outgoing);
    outgoing.on("error", onFailure);
    outgoing.on("close", onClose);
    outgoing.end(payload);

    return yield* settled.operation;
  });
}
