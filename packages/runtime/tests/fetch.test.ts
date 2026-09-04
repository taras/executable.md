/**
 * Tier FR — the runtime Fetch adapter (spec §Runtime Context APIs).
 *
 * The adapter is what turns a live host response into something a caller can
 * keep. Two claims are under test and they pull against each other: the
 * response must be *detached*, so nothing a caller holds depends on a socket
 * that has since closed, and the seams callers already use — `headers.get()`
 * and `text()` — must keep meaning exactly what they meant.
 *
 * Everything here runs against a loopback server rather than a hand-built
 * `Headers`, because what is under test is what a real host reports: a platform
 * combines repeated header names before the adapter sees them, and a test that
 * invented its own header collection would prove nothing about that.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { when } from "@effectionx/converge";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { API, fetch } from "../apis.ts";
import type { RuntimeFetchResponse } from "../apis.ts";
import { Config } from "../config.ts";

interface Loopback {
  /** Where the server is listening. */
  readonly origin: string;
  /** The listener itself, so a case can say what it is still observing. */
  readonly server: Server;
  /** One entry per request the server accepted, in order. */
  readonly requests: Array<{ method: string; path: string; headers: Record<string, string> }>;
}

/** A server on a port the host chose, torn down with the calling scope. */
function useLoopback(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Operation<Loopback> {
  return resource(function* (provide) {
    const requests: Loopback["requests"] = [];

    const server = createServer((request, response) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
      }
      requests.push({ method: request.method ?? "", path: request.url ?? "", headers });
      handle(request, response);
    });

    const listening = withResolvers<void>();
    // Removed with the resource rather than after the first error: a listening
    // server outlives its bind, and a handler left behind would still be
    // holding a rejected resolver when the next test binds its own.
    //
    // Established before the handler exists, because `yield* ensure(...)` is
    // itself a suspension: an owner halted while it registers unwinds with no
    // cleanup at all, so nothing may be attached until it has completed.
    let onError: ((error: Error) => void) | undefined;

    yield* ensure(() => {
      if (onError) {
        server.off("error", onError);
      }
    });

    onError = (error: Error) => listening.reject(error);
    server.on("error", onError);
    server.listen(0, "127.0.0.1", () => listening.resolve());
    yield* listening.operation;

    yield* ensure(function* () {
      const closed = withResolvers<void>();
      // A test that left a request unanswered is holding a socket open, and
      // `close()` alone waits for it.
      server.closeAllConnections();
      server.close(() => closed.resolve());
      yield* closed.operation;
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the loopback server reported no TCP address");
    }

    yield* provide({ origin: `http://127.0.0.1:${address.port}`, requests, server });
  });
}

/** Answer with the given headers and body. */
function respond(
  headers: Array<[string, string]>,
  body: string,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (_request, response) => {
    for (const [name, value] of headers) {
      response.appendHeader(name, value);
    }
    response.writeHead(200);
    response.end(body);
  };
}

/** Accept the request and never answer it. */
function silence(): void {}

/** Send a status and part of a body it promised, then stop. */
function halfAnswer(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-length": "10" });
  response.write("part");
}

/** Run `body` and report the error it threw, if any. */
function* thrown(body: () => Operation<unknown>): Operation<Error | undefined> {
  try {
    yield* body();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Wait until the server has accepted at least `count` requests. */
function accepted(server: Loopback, count: number): Operation<unknown> {
  return when(function* () {
    if (server.requests.length < count) {
      throw new Error(`the server has accepted ${server.requests.length} of ${count} requests`);
    }
  });
}

describe("Tier FR — the response the adapter hands back", () => {
  it("FR1: enumerates every header, detached from the live response", function* () {
    const server = yield* useLoopback(
      respond(
        [
          ["Content-Type", "text/plain; charset=utf-8"],
          ["X-Upper", "one"],
        ],
        "hello",
      ),
    );

    const kept = yield* scoped(function* () {
      const response = yield* fetch(`${server.origin}/detached`);
      const entries = response.headers.entries;
      if (entries === undefined) {
        throw new Error("the default adapter reported no enumerable headers");
      }
      return { snapshot: [...entries.call(response.headers)], body: yield* response.text() };
    });

    // Read after the scope that owned the live response is gone.
    const named = new Map(kept.snapshot.map(([name, value]) => [name.toLowerCase(), value]));
    expect(named.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(named.get("x-upper")).toBe("one");
    expect(kept.body).toBe("hello");
  });

  it("FR2: keeps headers.get() and text() exactly as callers had them", function* () {
    const server = yield* useLoopback(respond([["X-Case", "kept"]], "body text"));

    const response = yield* fetch(`${server.origin}/seams`);
    expect(response.status).toBe(200);
    // Case-insensitive, as `Headers.get` is.
    expect(response.headers.get("x-case")).toBe("kept");
    expect(response.headers.get("X-CASE")).toBe("kept");
    expect(response.headers.get("absent")).toBe(null);
    expect(yield* response.text()).toBe("body text");
  });

  it("FR3: reports one value for a name the host repeated", function* () {
    const server = yield* useLoopback(
      respond(
        [
          ["X-Trace", "first"],
          ["X-Trace", "second"],
        ],
        "",
      ),
    );

    const response = yield* fetch(`${server.origin}/repeated`);
    const entries = response.headers.entries;
    if (entries === undefined) {
      throw new Error("the default adapter reported no enumerable headers");
    }
    const traces = [...entries.call(response.headers)].filter(
      ([name]) => name.toLowerCase() === "x-trace",
    );

    // The platform combines repeated names before the adapter reads them, so
    // one name is one entry and `get()` agrees with enumeration.
    expect(traces).toHaveLength(1);
    expect(traces[0]?.[1]).toBe("first, second");
    expect(response.headers.get("x-trace")).toBe("first, second");
  });

  it("FR4: hands back a snapshot a later reader cannot change", function* () {
    const server = yield* useLoopback(respond([["X-Mutable", "original"]], ""));

    const response = yield* fetch(`${server.origin}/snapshot`);
    const entries = response.headers.entries;
    if (entries === undefined) {
      throw new Error("the default adapter reported no enumerable headers");
    }
    const first = [...entries.call(response.headers)];
    first.length = 0;
    first.push(["x-mutable", "tampered"]);

    const again = [...entries.call(response.headers)];
    expect(again.find(([name]) => name.toLowerCase() === "x-mutable")?.[1]).toBe("original");
    expect(again.length).toBeGreaterThan(0);
  });
});

describe("Tier FR — what a request does when it is cut short", () => {
  it("FR5: aborts an unanswered request when its scope is halted", function* () {
    const server = yield* useLoopback(silence);

    let settled = false;
    let torndown = false;
    yield* scoped(function* () {
      yield* spawn(function* () {
        yield* ensure(() => {
          torndown = true;
        });
        yield* fetch(`${server.origin}/hangs`);
        settled = true;
      });
      yield* accepted(server, 1);
    });

    // Halting the owner ended the request rather than leaving it running: the
    // scope's teardown completed, nothing settled, and nothing settles later.
    // The socket itself is the host's — a cancelled request may return a pooled
    // connection instead of closing it, and that says nothing about ownership.
    expect(torndown).toBe(true);
    expect(settled).toBe(false);
    yield* sleep(100);
    expect(settled).toBe(false);
  });

  it("FR6: aborts a body read when its scope is halted", function* () {
    const server = yield* useLoopback(halfAnswer);

    let read: string | undefined;
    let torndown = false;
    yield* scoped(function* () {
      yield* spawn(function* () {
        const response = yield* fetch(`${server.origin}/partial`);
        yield* ensure(() => {
          torndown = true;
        });
        read = yield* response.text();
      });
      yield* accepted(server, 1);
      // Long enough for the status line to arrive, so what is halted is the
      // body read rather than the request that preceded it.
      yield* sleep(50);
    });

    // Halting the owner ended the read rather than leaving it running: the
    // teardown ran, nothing was bound, and nothing arrives late. The socket
    // itself is the host's — a cancelled body read may return a pooled
    // connection instead of closing it, which says nothing about ownership.
    expect(torndown).toBe(true);
    expect(read).toBe(undefined);
    yield* sleep(100);
    expect(read).toBe(undefined);
  });

  it("FR7: a timed-out request fails and leaves nothing running", function* () {
    const server = yield* useLoopback(silence);

    const failure = yield* thrown(function* () {
      yield* fetch(`${server.origin}/slow`, { timeout: 60 });
    });

    expect(failure?.message).toContain("timed out after 60ms");
    // The bound settled it, and settled it once: nothing is still running to
    // answer later.
    expect(server.requests).toHaveLength(1);
  });

  it("FR8: a timed-out body read fails after the response arrived", function* () {
    const server = yield* useLoopback(halfAnswer);

    const failure = yield* thrown(function* () {
      const response = yield* fetch(`${server.origin}/slow-body`, { timeout: 80 });
      yield* response.text();
    });

    expect(failure?.message).toContain(".text() timed out after 80ms");
  });
});

describe("Tier FR — the chainable calling shape", () => {
  it("FR9: yields the settled response, and reads text and JSON from it", function* () {
    const server = yield* useLoopback(
      respond([["content-type", "application/json"]], '{"ok":true}'),
    );

    expect(yield* fetch(`${server.origin}/chain`).text()).toBe('{"ok":true}');
    expect(yield* fetch(`${server.origin}/chain`).json()).toEqual({ ok: true });
    expect((yield* fetch(`${server.origin}/chain`)).status).toBe(200);
  });

  it("FR10: expect() fails on a non-2xx status and passes a 2xx through", function* () {
    const server = yield* useLoopback((request, response) => {
      response.writeHead(request.url === "/missing" ? 404 : 200);
      response.end("body");
    });

    const failure = yield* thrown(function* () {
      yield* fetch(`${server.origin}/missing`).expect();
    });
    // The transport's own refusal, which is what authored code already caught.
    expect(failure?.name).toBe("HttpError");
    expect(failure?.message).toContain("404");

    const response = yield* fetch(`${server.origin}/present`).expect();
    expect(yield* response.text()).toBe("body");
  });

  it("FR10b: expect() travels as part of the request, where middleware sees it", function* () {
    const asked: Array<boolean | undefined> = [];
    yield* API.Fetch.around({
      *fetch([url, init], next): Operation<RuntimeFetchResponse> {
        asked.push(init?.expect);
        return yield* next(url, init);
      },
    });

    const server = yield* useLoopback(respond([], "body"));
    yield* fetch(`${server.origin}/plain`);
    yield* fetch(`${server.origin}/checked`).expect();
    yield* fetch(`${server.origin}/checked`).expect().text();

    // A provider that authenticates, routes or refuses a request is entitled to
    // know the caller treats a non-2xx as a failure; checking the status after
    // the operation returned would hide it from every handler.
    expect(asked).toEqual([undefined, true, true]);
  });

  it("FR11: every call crosses API.Fetch, so a host refusal covers the chain", function* () {
    yield* API.Fetch.around({
      // deno-lint-ignore require-yield
      *fetch() {
        throw new Error("network access is denied");
      },
    });

    for (const attempt of [
      function* (): Operation<unknown> {
        return yield* fetch("http://127.0.0.1:1/denied");
      },
      function* (): Operation<unknown> {
        return yield* fetch("http://127.0.0.1:1/denied").text();
      },
      function* (): Operation<unknown> {
        return yield* fetch("http://127.0.0.1:1/denied").expect().json();
      },
    ]) {
      expect((yield* thrown(attempt))?.message).toBe("network access is denied");
    }
  });

  it("FR12: resolves the contextual Fetch default when the call supplies none", function* () {
    const server = yield* useLoopback(silence);

    yield* Config.around({ timeoutFetch: () => 60 }, { at: "min" });
    const failure = yield* thrown(function* () {
      yield* fetch(`${server.origin}/default-bound`);
    });

    expect(failure?.message).toContain("timed out after 60ms");
  });
  /**
   * The listener's error observer belongs to the loopback resource, not to the
   * first error it sees. The count is read after the resource has been torn
   * down and before the event is replayed, because an observer removed by its
   * own event would leave the same count behind as one that was released.
   */
  it("releases the loopback's error observer with the resource", function* () {
    let observed: Server | undefined;
    let live = 0;
    let baseline = 0;

    yield* scoped(function* () {
      const loopback = yield* useLoopback((_request, response) => response.end("{}"));
      observed = loopback.server;
      baseline = 0;
      live = loopback.server.listenerCount("error");
    });

    if (!observed) {
      throw new Error("the loopback never came up");
    }

    expect(live).toBeGreaterThanOrEqual(baseline + 1);
    expect(observed.listenerCount("error")).toBe(live - 1);

    // Delivered through a sentinel of this case's own, because an `error` an
    // emitter has no listener for is thrown rather than dropped — so the
    // replay needs one observer, and exactly one is what it must find.
    let seen = 0;
    const sentinel = (): void => {
      seen += 1;
    };

    observed.on("error", sentinel);
    try {
      observed.emit("error", new Error("after the loopback was torn down"));
    } finally {
      observed.off("error", sentinel);
    }

    expect(seen).toBe(1);
    expect(observed.listenerCount("error")).toBe(live - 1);
  });
});
