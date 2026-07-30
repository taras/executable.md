/**
 * The loopback form server: one port, one token, one submission.
 *
 * A WebForm needs a person to answer a question, and the only thing standing
 * between that person and the workflow is this server. It exists for the length
 * of one component invocation, serves a fixed set of six routes to one browser
 * tab, accepts exactly one validated answer, and disappears.
 *
 * ## What it will not do
 *
 * The route table is closed. There is no asset route, no directory, no fallback,
 * and nothing derived from a request path — a URL either names one of the six
 * routes beneath the active token or it does not exist. Everything unrecognized
 * gets the same empty 404, so a caller learns nothing about which part it got
 * wrong: a wrong token, an unknown path, a wrong method, and a foreign `Host` are
 * indistinguishable.
 *
 * The port is bound to `127.0.0.1` only, and the token is 256 bits of randomness,
 * so the form is not reachable from another machine and not guessable from this
 * one. `Origin` is checked on the submission, where a hostile local page could
 * otherwise post on the person's behalf; browsers send no `Origin` on same-origin
 * GET, so requiring it on the asset routes would prevent the page from loading
 * itself.
 *
 * ## One submission
 *
 * Reservation is checked before the media type and before any body is read, so a
 * second submission is refused without the server doing work for it. The
 * reservation itself is a synchronous compare-and-set with no suspension point
 * between the check and the write, which is what makes two concurrent valid
 * submissions resolve to exactly one winner even though both may already have
 * read and validated their bodies.
 *
 * The winner's 204 is *observed* before the submission resolves. A caller
 * typically tears this server down the moment it has an answer, and an unobserved
 * response would let that teardown destroy the connection before the browser
 * learned it had succeeded — the person would be told nothing while the workflow
 * moved on.
 *
 * ## Failing rather than hanging
 *
 * A caller waits on `submission`, so every way this server can die has to reach
 * that operation. Listener errors before readiness fail acquisition; listener
 * errors afterwards, and any request task that throws, reject a fatal operation
 * that `submission` races against. Nothing here can leave a caller waiting on a
 * server that is no longer working.
 */

import { each, ensure, Err, Ok, race, resource, spawn, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
import { fromReadable, on } from "@effectionx/node";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { CompiledForm } from "./compile.ts";
import type { Json } from "./json.ts";
import { parseJson } from "./json.ts";
import { normalizeIssues } from "./issues.ts";
import type { Issue } from "./issues.ts";
import { PAGE_SHELL, SECURITY_HEADERS } from "./page.ts";
import { nodeResponseChannel } from "./response-channel.ts";
import type { ResponseChannel } from "./response-channel.ts";

/** The submission ceiling, in bytes, counted as the body streams in. */
const LIMIT = 1024 * 1024;

const HOST = "127.0.0.1";

export interface FormServerInput {
  compiled: CompiledForm;
  /** Already sanitized by `renderBody`; never re-processed here. */
  bodyHtml: string;
  clientJs: string;
  themeCss: string;
}

export interface FormServer {
  /** `http://127.0.0.1:<port>/f/<token>/`, trailing slash included. */
  url: string;
  /** The one validated response, or a fatal failure. */
  submission: Operation<Json>;
}

/**
 * Test seams. Package-private — nothing here reaches `mod.ts`, and the protocol
 * itself is never stubbed: routing, precedence, reservation, and validation
 * always run for real.
 */
export interface FormServerSeams {
  responseChannel?(res: ServerResponse): ResponseChannel;
  /** After the listener is up, before `provide()`. Receives the live address. */
  afterListen?(address: { host: typeof HOST; port: number }): Operation<void>;
  /** Inside a request task, before dispatch. */
  beforeDispatch?(): Operation<void>;
}

type StaticRoute = "shell" | "client" | "theme" | "validator" | "config";
type Route = StaticRoute | "submit";

const GET_ROUTES: ReadonlyMap<string, StaticRoute> = new Map<string, StaticRoute>([
  ["", "shell"],
  ["client.js", "client"],
  ["theme.css", "theme"],
  ["validator.js", "validator"],
  ["config.json", "config"],
]);

const MEDIA: Record<Route, string> = {
  shell: "text/html; charset=utf-8",
  client: "text/javascript; charset=utf-8",
  theme: "text/css; charset=utf-8",
  validator: "text/javascript; charset=utf-8",
  config: "application/json; charset=utf-8",
  submit: "application/json; charset=utf-8",
};

/** 256 bits, base64url. `crypto` is the web global on all three runtimes. */
function createToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function useFormServer(
  input: FormServerInput,
  seams: FormServerSeams = {},
): Operation<FormServer> {
  return resource(function* (provide) {
    const token = createToken();
    const sockets = new Set<Socket>();
    const accepted = withResolvers<Json>();
    const fatal = withResolvers<never>();
    const listening = withResolvers<void>();

    let reserved = false;
    let ready = false;
    let acceptor: Task<void> | undefined;

    const server = createServer();
    const channelFor = seams.responseChannel ?? nodeResponseChannel;

    const onConnection = (socket: Socket): void => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    // One long-lived observer, not a readiness-only one: an error handler that
    // stopped mattering once the server came up would leave a caller waiting on
    // a listener that had since died.
    const onError = (error: unknown): void => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (ready) {
        fatal.reject(failure);
      } else {
        listening.reject(failure);
      }
    };

    // Readiness and failure are both observed before `listen`, so neither event
    // can be emitted into a gap where nothing is listening for it.
    const onListening = (): void => listening.resolve();

    server.once("listening", onListening);
    server.on("connection", onConnection);
    server.on("error", onError);

    // Registered before `listen`, so a server that fails to bind is still torn
    // down by the same path as one that served for an hour.
    yield* ensure(function* () {
      server.removeListener("listening", onListening);
      server.removeListener("connection", onConnection);
      server.removeListener("error", onError);
      if (acceptor) {
        yield* acceptor.halt();
      }
      // Keep-alive connections outlive `close()` — the listener stops accepting
      // but established sockets keep the process and the port alive.
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      if (server.listening) {
        const closed = withResolvers<void>();
        server.once("close", () => closed.resolve());
        server.close();
        yield* closed.operation;
      }
    });

    server.listen(0, HOST);
    yield* listening.operation;
    ready = true;

    const address = server.address();
    if (!address || typeof address !== "object") {
      throw new Error("the form server bound to an unexpected address");
    }
    const { port } = address;
    const origin = `http://${HOST}:${port}`;
    const prefix = `/f/${token}/`;

    function* handle(req: IncomingMessage, res: ServerResponse): Operation<void> {
      const channel = channelFor(res);
      const route = routeFor(req, prefix);

      if (route === undefined || req.headers.host !== `${HOST}:${port}`) {
        return yield* respond(channel, 404);
      }
      if (route !== "submit") {
        return yield* respond(channel, 200, bodyFor(route, input), MEDIA[route]);
      }

      if (req.headers.origin !== origin) {
        return yield* respond(channel, 403);
      }
      // Before the media type and before any body: a submission that arrives
      // after the form is spoken for costs this server nothing.
      if (reserved) {
        return yield* respond(channel, 409);
      }
      if (!isJsonMedia(req.headers["content-type"])) {
        return yield* respond(channel, 415);
      }

      const body = yield* readBody(req);
      if (!body.ok) {
        const refused = body.error;
        if (!(refused instanceof BodyRefusal)) {
          throw refused;
        }
        if (refused.status === 413) {
          // Refused mid-flight: say so, make sure it was said, and drop the
          // connection this arrived on without disturbing the listener.
          yield* respond(channel, 413, undefined, undefined, { Connection: "close" });
          req.socket.destroy();
          return;
        }
        return yield* respond(
          channel,
          422,
          JSON.stringify({ issues: refused.issues }),
          MEDIA.submit,
        );
      }

      if (!input.compiled.validate(body.value)) {
        const issues = normalizeIssues(input.compiled.validate.errors);
        return yield* respond(channel, 422, JSON.stringify({ issues }), MEDIA.submit);
      }

      // The reservation. No suspension point between the check and the write, so
      // two concurrent valid submissions cannot both pass it.
      if (reserved) {
        return yield* respond(channel, 409);
      }
      reserved = true;

      yield* respond(channel, 204);
      accepted.resolve(body.value);
    }

    acceptor = yield* spawn(function* () {
      for (const [req, res] of yield* each(
        on<[IncomingMessage, ServerResponse]>(server, "request"),
      )) {
        yield* spawn(function* () {
          try {
            if (seams.beforeDispatch) {
              yield* seams.beforeDispatch();
            }
            yield* handle(req, res);
          } catch (error) {
            // A request task that died is the server failing, not one request
            // failing: nothing else observes this task, so the failure is routed
            // to the operation the caller is waiting on.
            fatal.reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        yield* each.next();
      }
    });

    if (seams.afterListen) {
      yield* seams.afterListen({ host: HOST, port });
    }

    yield* provide({
      url: `${origin}${prefix}`,
      submission: {
        *[Symbol.iterator]() {
          return yield* race([accepted.operation, fatal.operation]);
        },
      },
    });
  });
}

/**
 * Send one response and wait until it has actually been sent.
 *
 * Every response carries the same fixed security headers, including the empty
 * error ones — a 404 is still a page the browser could be told to treat as
 * something else.
 */
function* respond(
  channel: ResponseChannel,
  status: number,
  body?: string,
  contentType?: string,
  extra?: Record<string, string>,
): Operation<void> {
  const headers: Record<string, string> = { ...SECURITY_HEADERS, ...extra };
  if (contentType !== undefined) {
    headers["Content-Type"] = contentType;
  }
  // Declared rather than chunked. A response whose length is stated is one a
  // client can read to completion without interpreting transfer framing, which
  // is what lets the tests assert on the exact bytes this server wrote. 204 is
  // the exception: it carries no body, so a length would be meaningless.
  if (status !== 204) {
    headers["Content-Length"] = String(new TextEncoder().encode(body ?? "").byteLength);
  }
  channel.head(status, headers);
  channel.end(body);
  yield* channel.finished;
}

function routeFor(req: IncomingMessage, prefix: string): Route | undefined {
  const path = (req.url ?? "").split("?")[0];
  if (!path.startsWith(prefix)) {
    return undefined;
  }
  const rest = path.slice(prefix.length);
  if (rest === "submit") {
    return req.method === "POST" ? "submit" : undefined;
  }
  const route = GET_ROUTES.get(rest);
  if (route === undefined) {
    return undefined;
  }
  return req.method === "GET" ? route : undefined;
}

function bodyFor(route: StaticRoute, input: FormServerInput): string {
  switch (route) {
    case "shell":
      return PAGE_SHELL;
    case "client":
      return input.clientJs;
    case "theme":
      return input.themeCss;
    case "validator":
      return input.compiled.validatorScript;
    case "config":
      // The body and nothing else. Schema and UI schema reach the page through
      // the validator script, which already carries them.
      return JSON.stringify({ bodyHtml: input.bodyHtml });
  }
}

function isJsonMedia(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return value.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * A body the server will not accept, carrying the status that says why.
 *
 * An error rather than a variant of the success type, so reading a body answers
 * with an ordinary `Result` and the refusal travels with its own status and
 * issues instead of being reconstructed by the caller.
 */
class BodyRefusal extends Error {
  override name = "BodyRefusal";
  constructor(
    readonly status: 413 | 422,
    readonly issues: Issue[],
  ) {
    super(`the request body was refused with ${status}`);
  }
}

function refusal(status: 413 | 422, keyword: string, message: string): BodyRefusal {
  return new BodyRefusal(status, [{ keyword, instancePath: "", schemaPath: "", message }]);
}

/**
 * Read the request body, counting bytes as they arrive.
 *
 * The ceiling is enforced against the stream, not against a finished request: a
 * chunked upload carries no length to check up front, so a server that waited for
 * the end before measuring would have already accepted whatever was sent. Once
 * the count is exceeded this stops consuming immediately — it does not drain the
 * remainder and does not wait for the terminating chunk — so the refusal reaches
 * the client while it is still sending.
 */
function* readBody(req: IncomingMessage): Operation<Result<Json>> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (const chunk of yield* each(fromReadable(req))) {
    size += chunk.byteLength;
    if (size > LIMIT) {
      return Err(refusal(413, "size", "the request body exceeds the size limit"));
    }
    chunks.push(chunk);
    yield* each.next();
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    return Err(refusal(422, "encoding", "the request body is not valid UTF-8"));
  }

  try {
    return Ok(parseJson(JSON.parse(text)));
  } catch {
    return Err(refusal(422, "parse", "the request body is not JSON"));
  }
}
