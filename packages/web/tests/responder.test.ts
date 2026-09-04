import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";

import { createServer } from "node:http";
import type { ClientRequest } from "node:http";
import { FormResponder, respond, submitForm } from "../src/responder.ts";
import type { FormResponse } from "../src/responder.ts";
import { useFormServer } from "../src/server.ts";
import type { Json } from "../src/json.ts";
import { parseJson } from "../src/json.ts";
import { formInput, NOTE_SCHEMA, noteBodyOfBytes, watchSubmission } from "./server-support.ts";

/**
 * A responder holding its answer.
 *
 * The shape the seam exists for: the data lives in whatever installed the
 * middleware and never travels through the operation, so the component in PR 5
 * will call `respond(url)` knowing nothing about what comes back.
 */
function responderAnswering(data: Json): Operation<void> {
  return FormResponder.around({
    *respond([url]) {
      yield* submitForm(url, data);
    },
  });
}

function readJson(value: unknown): Json {
  return parseJson(JSON.parse(JSON.stringify(value)));
}

describe("responder seam: what it is handed", () => {
  /**
   * The URL and nothing else. A second parameter — an answer, a fixture, anything
   * — fails this, because that is the moment predetermined data starts needing a
   * caller to carry it.
   */
  it("receives only the form URL", function* () {
    const received: unknown[][] = [];

    yield* scoped(function* () {
      yield* FormResponder.around({
        // deno-lint-ignore require-yield
        *respond(args) {
          received.push([...args]);
        },
      });

      const server = yield* useFormServer(formInput());
      yield* respond(server.url);

      expect(received.length).toBe(1);
      expect(received[0].length).toBe(1);
      expect(received[0][0]).toBe(server.url);
    });
  });

  /** A default that quietly submitted would look identical until you asked. */
  it("submits nothing by default and leaves the form pending", function* () {
    const server = yield* useFormServer(formInput());
    const state = yield* watchSubmission(server);

    yield* respond(server.url);

    expect(state().kind).toBe("pending");

    expect((yield* submitForm(server.url, { decision: "approve" })).status).toBe(204);
    expect(state().kind).toBe("resolved");
  });
});

describe("responder seam: an installed answer", () => {
  it("reaches the real server and becomes the recorded result", function* () {
    yield* responderAnswering({ decision: "approve", note: "installed" });

    const server = yield* useFormServer(formInput());
    const state = yield* watchSubmission(server);

    yield* respond(server.url);

    const settled = state();
    expect(settled.kind).toBe("resolved");
    if (settled.kind === "resolved") {
      expect(settled.value).toEqual({ decision: "approve", note: "installed" });
    }
  });

  /** Middleware is scope-local; a leak would let one fixture decide another result. */
  it("keeps sibling scopes' answers apart", function* () {
    const results: Json[] = [];

    for (const decision of ["approve", "reject"]) {
      yield* scoped(function* () {
        yield* responderAnswering({ decision });

        const server = yield* useFormServer(formInput());
        const state = yield* watchSubmission(server);
        yield* respond(server.url);

        const settled = state();
        if (settled.kind === "resolved") {
          results.push(settled.value);
        }
      });
    }

    expect(results).toEqual([{ decision: "approve" }, { decision: "reject" }]);
  });

  it("keeps concurrent scopes' answers apart", function* () {
    const first = withResolvers<Json>();
    const second = withResolvers<Json>();

    for (const [decision, settled] of [
      ["approve", first],
      ["reject", second],
    ] as const) {
      yield* spawn(function* () {
        yield* scoped(function* () {
          yield* responderAnswering({ decision });
          const server = yield* useFormServer(formInput());
          const state = yield* watchSubmission(server);
          yield* respond(server.url);
          const result = state();
          settled.resolve(result.kind === "resolved" ? result.value : null);
        });
      });
    }

    expect(yield* first.operation).toEqual({ decision: "approve" });
    expect(yield* second.operation).toEqual({ decision: "reject" });
  });

  it("halts a responder still running when its scope goes away", function* () {
    const started = withResolvers<void>();
    const cleaned = withResolvers<void>();

    yield* scoped(function* () {
      yield* FormResponder.around({
        *respond() {
          started.resolve();
          try {
            yield* suspend();
          } finally {
            cleaned.resolve();
          }
        },
      });

      const server = yield* useFormServer(formInput());
      yield* spawn(function* () {
        yield* respond(server.url);
      });
      yield* started.operation;
    });

    yield* cleaned.operation;
  });
});

describe("responder: subject to the protocol, not exempt from it", () => {
  it("is refused exactly as a browser would be, and leaves the form open", function* () {
    const server = yield* useFormServer(formInput());
    const state = yield* watchSubmission(server);

    const refusals: [string, unknown, number][] = [
      ["a value outside the enum", { decision: "maybe" }, 422],
      ["a missing required property", {}, 422],
      ["an unexpected property", { decision: "approve", extra: 1 }, 422],
      ["a non-object body", "text", 422],
    ];

    for (const [label, data, status] of refusals) {
      const response = yield* submitForm(server.url, readJson(data));

      expect({ label, status: response.status }).toEqual({ label, status });
      expect(state().kind).toBe("pending");
    }

    const invalid = yield* submitForm(server.url, { decision: "maybe" });
    const payload = JSON.parse(invalid.body);
    expect(Object.keys(payload.issues[0]).sort()).toEqual([
      "instancePath",
      "keyword",
      "message",
      "schemaPath",
    ]);

    expect((yield* submitForm(server.url, { decision: "reject" })).status).toBe(204);
    expect(state().kind).toBe("resolved");
  });

  it("cannot exceed the size ceiling any more than a browser can", function* () {
    const server = yield* useFormServer(formInput(NOTE_SCHEMA));
    const state = yield* watchSubmission(server);

    const oversized = readJson(JSON.parse(noteBodyOfBytes(1024 * 1024 + 1, "é")));
    expect((yield* submitForm(server.url, oversized)).status).toBe(413);
    expect(state().kind).toBe("pending");

    const small = readJson(JSON.parse(noteBodyOfBytes(64)));
    expect((yield* submitForm(server.url, small)).status).toBe(204);
  });

  it("is refused when it carries another form's token", function* () {
    const first = yield* useFormServer(formInput());
    const second = yield* useFormServer(formInput());
    const state = yield* watchSubmission(first);

    // The first server's address with the second server's token path — the shape
    // a leaked or stale URL would have.
    const crossed = `${new URL(first.url).origin}${new URL(second.url).pathname}`;

    const response = yield* submitForm(crossed, { decision: "approve" });

    expect(response.status).toBe(404);
    expect(response.body).toBe("");
    expect(state().kind).toBe("pending");

    expect((yield* submitForm(first.url, { decision: "reject" })).status).toBe(204);
    expect(state().kind).toBe("resolved");
  });

  it("gives exactly one winner when two submissions race", function* () {
    const server = yield* useFormServer(formInput());
    const state = yield* watchSubmission(server);

    const first = withResolvers<FormResponse>();
    const second = withResolvers<FormResponse>();

    yield* spawn(function* () {
      first.resolve(yield* submitForm(server.url, { decision: "approve" }));
    });
    yield* spawn(function* () {
      second.resolve(yield* submitForm(server.url, { decision: "reject" }));
    });

    const statuses = [yield* first.operation, yield* second.operation]
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([204, 409]);

    const settled = state();
    expect(settled.kind).toBe("resolved");
    if (settled.kind === "resolved") {
      expect([{ decision: "approve" }, { decision: "reject" }]).toContainEqual(settled.value);
    }
  });

  it("409s a later submission once the form is spoken for", function* () {
    const server = yield* useFormServer(formInput());

    expect((yield* submitForm(server.url, { decision: "approve" })).status).toBe(204);

    const later = yield* submitForm(server.url, { decision: "reject" });
    expect(later.status).toBe(409);
    expect(later.body).toBe("");
  });
});

describe("responder: the request it opens is its own", () => {
  /**
   * A submission cancelled before its response arrives is the case the events
   * never come for. The server here accepts and answers nothing, so the halt
   * lands while the request is live: the counts are read before the halt, again
   * after it and before the event is replayed, and the replay must reach
   * neither the abandoned operation nor anything still accumulating.
   */
  it("releases the outgoing request's handlers when the submission is cancelled", function* () {
    const server = createServer(() => {});
    const listening = withResolvers<void>();
    const onError = (error: Error): void => listening.reject(error);

    yield* ensure(() => {
      server.off("error", onError);
    });
    server.on("error", onError);

    server.listen(0, "127.0.0.1", () => listening.resolve());
    yield* listening.operation;
    yield* ensure(() => {
      server.closeAllConnections();
      server.close();
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the silent server did not listen on a TCP port");
    }

    let outgoing: ClientRequest | undefined;
    let before = 0;
    let settled = false;

    const owner = yield* spawn(function* () {
      yield* submitForm(
        `http://127.0.0.1:${address.port}/f/x/`,
        { decision: "approve" },
        (request) => {
          outgoing = request;
          before = request.listenerCount("error");
        },
      );
      settled = true;
    });

    // A turn after the executor ran, so its handler is attached and its
    // cleanup — the one `action()` returns — is the executor's own return
    // value rather than something still being registered.
    yield* sleep(0);
    if (!outgoing) {
      throw new Error("the responder opened no request");
    }

    // At least one more, not exactly one: a runtime may hold handlers of its
    // own on this source, so the release below is measured against what was
    // live rather than against the baseline.
    const live = outgoing.listenerCount("error");
    expect(live).toBeGreaterThanOrEqual(before + 1);
    expect(settled).toBe(false);

    yield* owner.halt();

    expect(outgoing.listenerCount("error")).toBe(live - 1);

    let seen = 0;
    const sentinel = (): void => {
      seen += 1;
    };

    outgoing.on("error", sentinel);
    try {
      outgoing.emit("error", new Error("after the submission was cancelled"));
    } finally {
      outgoing.off("error", sentinel);
    }

    expect(seen).toBe(1);
    expect(outgoing.listenerCount("error")).toBe(live - 1);
    expect(settled).toBe(false);
  });

  /**
   * `postJson` observes its outgoing request and the response it brings back
   * for exactly as long as the `action` runs. The count is read after the
   * submission has settled and before the event is replayed, because a handler
   * removed by its own event would leave the same count behind as one the
   * action released.
   */
  it("releases the outgoing request's error handler when the submission settles", function* () {
    const server = yield* useFormServer(formInput());
    let outgoing: ClientRequest | undefined;
    let before = 0;

    const response = yield* submitForm(server.url, { decision: "approve" }, (request) => {
      outgoing = request;
      before = request.listenerCount("error");
    });

    expect(response.status).toBe(204);
    if (!outgoing) {
      throw new Error("the responder opened no request");
    }

    // The case above reads the count while it is live; this one is the
    // completion path, where what matters is that settling released it.
    expect(outgoing.listenerCount("error")).toBe(before);

    let seen = 0;
    const sentinel = (): void => {
      seen += 1;
    };

    outgoing.on("error", sentinel);
    try {
      outgoing.emit("error", new Error("after the submission settled"));
    } finally {
      outgoing.off("error", sentinel);
    }

    expect(seen).toBe(1);
    expect(outgoing.listenerCount("error")).toBe(before);
  });
});
