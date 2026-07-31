import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn } from "effection";
import type { Operation } from "effection";

import { PAGE_SHELL, SECURITY_HEADERS } from "../src/page.ts";
import { useFormServer } from "../src/server.ts";
import type { FormServer } from "../src/server.ts";
import {
  addressOf,
  BODY_HTML,
  CLIENT_JS,
  formInput,
  NOTE_SCHEMA,
  noteBodyOfBytes,
  portRefuses,
  THEME_CSS,
  watchSubmission,
} from "./server-support.ts";
import { chunk, chunkedHead, requestBytes, requestText, useConnection } from "./http-client.ts";
import type { HttpConnection, HttpResponse } from "./http-client.ts";

const LIMIT = 1024 * 1024;

/** One request on its own connection, answered. */
function* fetchOnce(
  server: FormServer,
  init: { method: string; path?: string; headers?: Record<string, string>; body?: string },
): Operation<HttpResponse> {
  const { port, origin, prefix } = addressOf(server.url);
  return yield* scoped(function* () {
    const connection = yield* useConnection(port);
    connection.write(
      requestText({
        method: init.method,
        path: `${prefix}${init.path ?? ""}`,
        host: `127.0.0.1:${port}`,
        headers: init.headers,
        body: init.body,
      }),
    );
    void origin;
    return yield* connection.response();
  });
}

function tokenOf(url: string): string {
  const segments = new URL(url).pathname.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1];
}

function decodeBase64Url(token: string): Uint8Array {
  const padded = token.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** A valid submission, with everything the protocol requires. */
function* submit(server: FormServer, body: string): Operation<HttpResponse> {
  const { origin } = addressOf(server.url);
  return yield* fetchOnce(server, {
    method: "POST",
    path: "submit",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body,
  });
}

describe("form server: the route table", () => {
  it("serves each route's exact bytes and media type", function* () {
    const input = formInput();
    const server = yield* useFormServer(input);

    const cases: Array<[string, string, string]> = [
      ["", PAGE_SHELL, "text/html; charset=utf-8"],
      ["client.js", CLIENT_JS, "text/javascript; charset=utf-8"],
      ["theme.css", THEME_CSS, "text/css; charset=utf-8"],
      ["validator.js", input.compiled.validatorScript, "text/javascript; charset=utf-8"],
    ];

    for (const [path, body, media] of cases) {
      const response = yield* fetchOnce(server, { method: "GET", path });

      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(response.body).toBe(body);
      expect(response.headers.get("content-type")).toBe(media);
    }
  });

  it("serves a config carrying the body and nothing else", function* () {
    const server = yield* useFormServer(formInput());
    const response = yield* fetchOnce(server, { method: "GET", path: "config.json" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(response.body)).toEqual({ bodyHtml: BODY_HTML });
    // The schema reaches the page through validator.js, never through config.
    expect(Object.keys(JSON.parse(response.body))).toEqual(["bodyHtml"]);
    expect(response.body.includes("decision")).toBe(false);
    expect(response.body.includes("uiSchema")).toBe(false);
  });

  it("has no route beyond the six", function* () {
    const server = yield* useFormServer(formInput());

    for (const path of [
      "logo.png",
      "assets/logo.png",
      "../server.ts",
      "index.html",
      "config.json/",
      "submit/",
      "..%2Fserver.ts",
    ]) {
      const response = yield* fetchOnce(server, { method: "GET", path });

      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });
});

describe("form server: the same bare 404", () => {
  it("answers a wrong token, route, method, and Host identically", function* () {
    const server = yield* useFormServer(formInput());
    const { port, prefix } = addressOf(server.url);

    const responses: HttpResponse[] = [];
    // Wrong token.
    responses.push(
      yield* scoped(function* () {
        const connection = yield* useConnection(port);
        connection.write(
          requestText({ method: "GET", path: "/f/not-the-token/", host: `127.0.0.1:${port}` }),
        );
        return yield* connection.response();
      }),
    );
    // Unknown route, and a wrong method on a real one.
    responses.push(yield* fetchOnce(server, { method: "GET", path: "nope" }));
    responses.push(yield* fetchOnce(server, { method: "POST", path: "config.json" }));
    // Foreign Host.
    responses.push(
      yield* scoped(function* () {
        const connection = yield* useConnection(port);
        connection.write(requestText({ method: "GET", path: prefix, host: `localhost:${port}` }));
        return yield* connection.response();
      }),
    );

    // Compared on status, empty body, and the headers this server sets — not on
    // Date or connection bookkeeping, which the runtime writes and varies.
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toBe("");
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name.toLowerCase())).toBe(value);
      }
    }
  });
});

describe("form server: fixed headers", () => {
  it("sets every security header on success and on error, and no CORS", function* () {
    const server = yield* useFormServer(formInput());
    const { origin } = addressOf(server.url);

    const responses = [
      yield* fetchOnce(server, { method: "GET", path: "" }),
      yield* fetchOnce(server, { method: "GET", path: "missing" }),
      yield* fetchOnce(server, {
        method: "POST",
        path: "submit",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      yield* fetchOnce(server, {
        method: "POST",
        path: "submit",
        headers: { Origin: origin, "Content-Type": "text/plain" },
        body: "{}",
      }),
    ];

    for (const response of responses) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name.toLowerCase())).toBe(value);
      }
      for (const header of response.headers.keys()) {
        expect(header.startsWith("access-control-")).toBe(false);
      }
    }
  });
});

describe("form server: Origin", () => {
  it("accepts the exact loopback origin and refuses anything else", function* () {
    const server = yield* useFormServer(formInput());
    const { origin } = addressOf(server.url);
    const state = yield* watchSubmission(server);

    for (const foreign of [undefined, "http://evil.test", "null", `${origin}.evil.test`]) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (foreign !== undefined) {
        headers.Origin = foreign;
      }
      const response = yield* fetchOnce(server, {
        method: "POST",
        path: "submit",
        headers,
        body: JSON.stringify({ decision: "approve" }),
      });

      expect({ foreign, status: response.status }).toEqual({ foreign, status: 403 });
      expect(response.body).toBe("");
    }
    expect(state().kind).toBe("pending");

    expect((yield* submit(server, JSON.stringify({ decision: "approve" }))).status).toBe(204);
  });

  it("does not require an Origin on the asset routes", function* () {
    const server = yield* useFormServer(formInput());

    for (const path of ["", "client.js", "theme.css", "validator.js", "config.json"]) {
      expect((yield* fetchOnce(server, { method: "GET", path })).status).toBe(200);
    }
  });
});

describe("form server: the submission body", () => {
  it("refuses a non-JSON media type", function* () {
    const server = yield* useFormServer(formInput());
    const { origin } = addressOf(server.url);
    const state = yield* watchSubmission(server);

    for (const media of ["text/plain", "application/x-www-form-urlencoded", "application/json5"]) {
      const response = yield* fetchOnce(server, {
        method: "POST",
        path: "submit",
        headers: { Origin: origin, "Content-Type": media },
        body: JSON.stringify({ decision: "approve" }),
      });

      expect({ media, status: response.status }).toEqual({ media, status: 415 });
    }
    expect(state().kind).toBe("pending");
  });

  it("accepts a body of exactly the limit", function* () {
    const server = yield* useFormServer(formInput(NOTE_SCHEMA));
    const body = noteBodyOfBytes(LIMIT);

    expect(new TextEncoder().encode(body).byteLength).toBe(LIMIT);
    expect((yield* submit(server, body)).status).toBe(204);
  });

  /**
   * The body's UTF-8 length is over the limit while its JavaScript string length
   * is well under, so a server measuring `text.length` would accept it.
   */
  it("counts bytes, not JavaScript string length", function* () {
    const server = yield* useFormServer(formInput(NOTE_SCHEMA));
    const body = noteBodyOfBytes(LIMIT + 1, "é");
    const state = yield* watchSubmission(server);

    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(LIMIT);
    expect(body.length).toBeLessThan(LIMIT);

    expect((yield* submit(server, body)).status).toBe(413);
    expect(state().kind).toBe("pending");
  });

  it("leaves the form open after every refusal, then accepts a valid submission", function* () {
    const server = yield* useFormServer(formInput());
    const { origin } = addressOf(server.url);
    const state = yield* watchSubmission(server);

    const refusals: Array<[string, string, number]> = [
      ["malformed JSON", "{ not json", 422],
      ["not an object", '"text"', 422],
      ["schema-invalid", JSON.stringify({ decision: "maybe" }), 422],
      ["unexpected property", JSON.stringify({ decision: "approve", extra: 1 }), 422],
    ];

    for (const [label, body, status] of refusals) {
      const response = yield* fetchOnce(server, {
        method: "POST",
        path: "submit",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body,
      });

      expect({ label, status: response.status }).toEqual({ label, status });
      expect(state().kind).toBe("pending");
    }

    const accepted = yield* submit(server, JSON.stringify({ decision: "approve", note: "ok" }));
    expect(accepted.status).toBe(204);

    const settled = state();
    expect(settled.kind).toBe("resolved");
    if (settled.kind === "resolved") {
      expect(settled.value).toEqual({ decision: "approve", note: "ok" });
    }
  });

  it("reports schema failures as normalized issues", function* () {
    const server = yield* useFormServer(formInput());
    const response = yield* submit(server, JSON.stringify({ decision: "maybe" }));

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const payload = JSON.parse(response.body);
    expect(Array.isArray(payload.issues)).toBe(true);
    expect(payload.issues.length).toBeGreaterThan(0);
    for (const issue of payload.issues) {
      expect(Object.keys(issue).sort()).toEqual([
        "instancePath",
        "keyword",
        "message",
        "schemaPath",
      ]);
    }
  });
});

describe("form server: the streaming limit", () => {
  /**
   * The discriminating one. The request is chunked, so it carries no length to
   * check up front, and it is never terminated — no zero-length chunk, no end.
   * A server that buffered the request and measured it afterwards would still be
   * waiting; this one answers while the client is still sending.
   */
  it("refuses mid-send, closes that connection, and keeps serving", function* () {
    const server = yield* useFormServer(formInput(NOTE_SCHEMA));
    const { port, origin, prefix } = addressOf(server.url);
    const state = yield* watchSubmission(server);

    const refusal = yield* scoped(function* () {
      const connection = yield* useConnection(port);
      connection.write(
        chunkedHead({
          method: "POST",
          path: `${prefix}submit`,
          host: `127.0.0.1:${port}`,
          headers: { Origin: origin, "Content-Type": "application/json" },
        }),
      );

      // Past the ceiling by one byte, in pieces, and never terminated.
      yield* spawn(function* () {
        const piece = "x".repeat(64 * 1024);
        let sent = 0;
        while (sent < LIMIT + 1) {
          const remaining = LIMIT + 1 - sent;
          const payload = remaining < piece.length ? piece.slice(0, remaining) : piece;
          connection.write(chunk(payload));
          sent += payload.length;
        }
      });

      const response = yield* connection.response();
      // The peer hangs up on this connection, which is the point: the refusal
      // is not a polite end-of-request, it is a stop.
      const ending = yield* connection.ended;
      return { response, ending };
    });

    expect(refusal.response.status).toBe(413);
    expect(refusal.ending.length).toBeGreaterThan(0);
    expect(state().kind).toBe("pending");

    // The listener survived: a fresh connection still gets the one submission.
    const accepted = yield* submit(server, noteBodyOfBytes(64));
    expect(accepted.status).toBe(204);
    expect(state().kind).toBe("resolved");
  });
});

describe("form server: bytes that are not text", () => {
  /**
   * A body that is not valid UTF-8 has no string form, so it is sent as octets.
   * `0xff` cannot begin a UTF-8 sequence, which is what makes this decodable only
   * by a decoder that does not care — and the server's is `fatal`, so it does.
   */
  it("refuses malformed UTF-8, names the encoding, and stays open", function* () {
    const server = yield* useFormServer(formInput());
    const { port, origin, prefix } = addressOf(server.url);
    const state = yield* watchSubmission(server);

    const body = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(body)).toThrow();

    const response = yield* scoped(function* () {
      const connection = yield* useConnection(port);
      connection.writeBytes(
        requestBytes({
          method: "POST",
          path: `${prefix}submit`,
          host: `127.0.0.1:${port}`,
          headers: { Origin: origin, "Content-Type": "application/json" },
          body,
        }),
      );
      return yield* connection.response();
    });

    expect(response.status).toBe(422);
    const payload = JSON.parse(response.body);
    expect(payload.issues.map((issue: { keyword: string }) => issue.keyword)).toContain("encoding");
    expect(JSON.stringify(payload.issues)).toContain("UTF-8");
    expect(state().kind).toBe("pending");

    // Still the sole result afterwards.
    expect((yield* submit(server, JSON.stringify({ decision: "approve" }))).status).toBe(204);
    expect(state().kind).toBe("resolved");
  });
});

describe("form server: the token", () => {
  /**
   * 32 bytes of randomness, base64url, unpadded — 43 characters. The encoding is
   * asserted rather than the length alone, because a shorter alphabet or a
   * padded encoding would still be 43-ish and far less unguessable.
   */
  it("is 32 random bytes as unpadded base64url, and differs per server", function* () {
    const first = yield* useFormServer(formInput());
    const second = yield* useFormServer(formInput());

    const tokens = [first, second].map((server) => tokenOf(server.url));

    for (const token of tokens) {
      expect(token.length).toBe(43);
      expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
      expect(token.includes("=")).toBe(false);
      // 43 unpadded base64url characters decode to exactly 32 bytes.
      expect(decodeBase64Url(token).byteLength).toBe(32);
    }
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("is not accepted by another server", function* () {
    const first = yield* useFormServer(formInput());
    const second = yield* useFormServer(formInput());

    const foreign = addressOf(second.url).prefix;
    const { port } = addressOf(first.url);

    const response = yield* scoped(function* () {
      const connection = yield* useConnection(port);
      connection.write(requestText({ method: "GET", path: foreign, host: `127.0.0.1:${port}` }));
      return yield* connection.response();
    });

    expect(response.status).toBe(404);
    expect(response.body).toBe("");
  });
});

describe("form server: where it listens", () => {
  /**
   * Read from the listener rather than from the constant the server was given or
   * the URL it produced: those would agree with each other even if the socket
   * were bound somewhere else entirely.
   */
  it("binds the loopback address, as the listener reports it", function* () {
    let bound: string | undefined;

    yield* scoped(function* () {
      yield* useFormServer(formInput(), {
        // deno-lint-ignore require-yield
        *afterListen(address) {
          bound = address.host;
        },
      });
    });

    expect(bound).toBe("127.0.0.1");
  });
});

describe("form server: one submission only", () => {
  it("gives exactly one winner when two valid submissions race", function* () {
    const server = yield* useFormServer(formInput());
    const { port, origin, prefix } = addressOf(server.url);
    const state = yield* watchSubmission(server);

    const responses = yield* scoped(function* (): Operation<HttpResponse[]> {
      const first = yield* useConnection(port);
      const second = yield* useConnection(port);

      const submissions: [HttpConnection, string][] = [
        [first, "approve"],
        [second, "reject"],
      ];
      for (const [connection, decision] of submissions) {
        connection.write(
          requestText({
            method: "POST",
            path: `${prefix}submit`,
            host: `127.0.0.1:${port}`,
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ decision }),
          }),
        );
      }
      return [yield* first.response(), yield* second.response()];
    });

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([204, 409]);

    const settled = state();
    expect(settled.kind).toBe("resolved");
    if (settled.kind === "resolved") {
      // Exactly one value, and it is one of the two that were sent.
      expect([{ decision: "approve" }, { decision: "reject" }]).toContainEqual(settled.value);
    }
  });

  /**
   * Reservation is checked before the media type, so a later submission is
   * refused without the server inspecting its headers or reading its body. A
   * server that checked the media type first would answer 415 here.
   */
  it("refuses a later submission before looking at its content type", function* () {
    const server = yield* useFormServer(formInput());
    const { origin } = addressOf(server.url);

    expect((yield* submit(server, JSON.stringify({ decision: "approve" }))).status).toBe(204);

    const later = yield* fetchOnce(server, {
      method: "POST",
      path: "submit",
      headers: { Origin: origin, "Content-Type": "text/plain" },
      body: "not even json",
    });

    expect(later.status).toBe(409);
    expect(later.body).toBe("");
  });

  it("still refuses a foreign origin after reservation", function* () {
    const server = yield* useFormServer(formInput());

    expect((yield* submit(server, JSON.stringify({ decision: "approve" }))).status).toBe(204);

    const later = yield* fetchOnce(server, {
      method: "POST",
      path: "submit",
      headers: { Origin: "http://evil.test", "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });

    expect(later.status).toBe(403);
  });
});
