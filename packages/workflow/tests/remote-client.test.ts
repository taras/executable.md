/**
 * Tier WRH — carrying a request to a run's owner.
 *
 * Correlation and teardown are what this is about. A socket delivers what the
 * owner sent whenever it sent it, so answers are matched by the id they name
 * rather than by arrival order; and a connection that ends must fail the
 * requests still waiting rather than leave a caller blocked on an answer that
 * can never come.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn } from "effection";
import { type OwnerSocket, OwnerLinkError, useOwnerConnection } from "../src/remote/client.ts";

/** A socket a test drives by hand. */
function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  let onClose: (() => void) | undefined;
  const socket: OwnerSocket = {
    send(data: string): void {
      sent.push(JSON.parse(data));
    },
    close(): void {
      onClose?.();
    },
    addEventListener(type: "message" | "close", listener: never): void {
      if (type === "message") {
        onMessage = listener;
      } else {
        onClose = listener;
      }
    },
  };
  return {
    socket,
    sent,
    answer(value: unknown): void {
      onMessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
    },
    end(): void {
      onClose?.();
    },
  };
}

describe("a connection to a run's owner", () => {
  it("sends the command with its id and answers the caller that asked", function* () {
    const wire = fakeSocket();
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(() => owner.ask("a1", { command: "frontier" }));
      yield* sleep(0);
      // The request is on the wire before any answer exists.
      expect(wire.sent).toEqual([{ command: "frontier", id: "a1" }]);
      wire.answer({ id: "a1", outcome: "performed", value: { root: "root-a" } });
      expect(yield* asking).toEqual({ outcome: "performed", value: { root: "root-a" } });
    });
    yield* sleep(0);
  });

  it("matches answers by the id they name, not by arrival order", function* () {
    const wire = fakeSocket();
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const first = yield* spawn(() => owner.ask("a1", { command: "frontier" }));
      const second = yield* spawn(() => owner.ask("a2", { command: "settle" }));

      // Answered in the opposite order to the asking.
      wire.answer({ id: "a2", outcome: "performed", value: "second" });
      wire.answer({ id: "a1", outcome: "performed", value: "first" });

      expect(yield* first).toEqual({ outcome: "performed", value: "first" });
      expect(yield* second).toEqual({ outcome: "performed", value: "second" });
    });
    yield* sleep(0);
  });

  it("hands back a refusal as an answer rather than a transport failure", function* () {
    const wire = fakeSocket();
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(() => owner.ask("a1", { command: "commit" }));
      wire.answer({ id: "a1", outcome: "refused", refusal: "acquisition:already-running" });
      expect(yield* asking).toEqual({
        outcome: "refused",
        refusal: "acquisition:already-running",
      });
    });
    yield* sleep(0);
  });

  it("drops an answer it cannot attribute, and still answers the caller", function* () {
    const wire = fakeSocket();
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(() => owner.ask("a1", { command: "frontier" }));
      wire.answer("not json at all");
      wire.answer({ id: "somebody-else", outcome: "performed", value: 1 });
      wire.answer({ id: "a1", outcome: "performed", value: "mine" });
      expect(yield* asking).toEqual({ outcome: "performed", value: "mine" });
    });
    yield* sleep(0);
  });

  it("fails a request still waiting when the connection ends", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(function* () {
        try {
          yield* owner.ask("a1", { command: "frontier" });
        } catch (error) {
          raised = error;
        }
      });
      wire.end();
      yield* asking;
    });
    yield* sleep(0);
    expect(raised).toBeInstanceOf(OwnerLinkError);
    expect((raised as OwnerLinkError).refusal).toBe("closed");
  });

  it("refuses to ask through a connection that already ended", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      wire.end();
      try {
        yield* owner.ask("a1", { command: "frontier" });
      } catch (error) {
        raised = error;
      }
    });
    expect((raised as OwnerLinkError).refusal).toBe("closed");
  });

  it("refuses a second request under an id already in flight", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      yield* spawn(() => owner.ask("a1", { command: "frontier" }));
      yield* sleep(0);
      try {
        yield* owner.ask("a1", { command: "settle" });
      } catch (error) {
        raised = error;
      }
      wire.answer({ id: "a1", outcome: "performed", value: null });
    });
    expect((raised as OwnerLinkError).refusal).toBe("duplicate-answer");
  });
});
