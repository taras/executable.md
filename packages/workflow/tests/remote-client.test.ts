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

/** These tests are about correlation, so most of them read any value. */
function readString(value: unknown): unknown {
  return value;
}

/** A parser that refuses anything but a string, so a bad value fails the link. */
function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected a string");
  }
  return value;
}

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
      const asking = yield* spawn(() => owner.ask("a1", { command: "frontier" }, readString));
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
      const first = yield* spawn(() => owner.ask("a1", { command: "frontier" }, readString));
      const second = yield* spawn(() => owner.ask("a2", { command: "settle" }, readString));

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
      const asking = yield* spawn(() => owner.ask("a1", { command: "commit" }, readString));
      wire.answer({ id: "a1", outcome: "refused", refusal: "acquisition:already-running" });
      expect(yield* asking).toEqual({
        outcome: "refused",
        refusal: "acquisition:already-running",
      });
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
          yield* owner.ask("a1", { command: "frontier" }, readString);
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
        yield* owner.ask("a1", { command: "frontier" }, readString);
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
      yield* spawn(() => owner.ask("a1", { command: "frontier" }, readString));
      yield* sleep(0);
      try {
        yield* owner.ask("a1", { command: "settle" }, readString);
      } catch (error) {
        raised = error;
      }
      wire.answer({ id: "a1", outcome: "performed", value: null });
    });
    expect((raised as OwnerLinkError).refusal).toBe("duplicate-answer");
  });

  it("fails every waiter when it cannot read an answer", function* () {
    const wire = fakeSocket();
    const raised: unknown[] = [];
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const first = yield* spawn(function* () {
        try {
          yield* owner.ask("a1", { command: "frontier" }, readString);
        } catch (error) {
          raised.push(error);
        }
      });
      const second = yield* spawn(function* () {
        try {
          yield* owner.ask("a2", { command: "settle" }, readString);
        } catch (error) {
          raised.push(error);
        }
      });
      yield* sleep(0);
      // A commit may already have landed on the owner. Dropping this and
      // leaving both callers waiting is the failure mode being refused.
      wire.answer("not json at all");
      yield* first;
      yield* second;
    });
    expect(raised).toHaveLength(2);
    for (const error of raised) {
      expect((error as OwnerLinkError).refusal).toBe("malformed-answer");
    }
  });

  it("fails closed on an answer naming a request nobody made", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(function* () {
        try {
          yield* owner.ask("a1", { command: "frontier" }, readString);
        } catch (error) {
          raised = error;
        }
      });
      yield* sleep(0);
      wire.answer({ id: "somebody-else", outcome: "performed", value: 1 });
      yield* asking;
    });
    expect((raised as OwnerLinkError).refusal).toBe("unknown-answer");
  });

  it("fails every waiter when a success value cannot be parsed", function* () {
    const wire = fakeSocket();
    const raised: unknown[] = [];
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const first = yield* spawn(function* () {
        try {
          yield* owner.ask("a1", { command: "frontier" }, requireString);
        } catch (error) {
          raised.push(error);
        }
      });
      const second = yield* spawn(function* () {
        try {
          yield* owner.ask("a2", { command: "settle" }, requireString);
        } catch (error) {
          raised.push(error);
        }
      });
      yield* sleep(0);
      // Performed, and the value is not what the command's parser reads. The
      // caller must not receive it, and the other waiter must not be left.
      wire.answer({ id: "a1", outcome: "performed", value: { not: "a string" } });
      yield* first;
      yield* second;
    });
    expect(raised).toHaveLength(2);
    for (const error of raised) {
      expect((error as OwnerLinkError).refusal).toBe("malformed-answer");
    }
  });

  it("still delivers a refusal without consulting the success parser", function* () {
    const wire = fakeSocket();
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(() =>
        owner.ask("a1", { command: "commit" }, () => {
          throw new Error("a refusal must not reach this");
        }),
      );
      yield* sleep(0);
      wire.answer({ id: "a1", outcome: "refused", refusal: "acquisition:already-running" });
      expect(yield* asking).toEqual({
        outcome: "refused",
        refusal: "acquisition:already-running",
      });
    });
  });

  it("refuses a refusal that is not a category this side can branch on", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(function* () {
        try {
          yield* owner.ask("a1", { command: "frontier" }, readString);
        } catch (error) {
          raised = error;
        }
      });
      yield* sleep(0);
      // An arbitrary remote sentence must not become this side's public failure
      // identity, so it is read as an answer this build cannot understand.
      wire.answer({ id: "a1", outcome: "refused", refusal: "something went wrong!" });
      yield* asking;
    });
    expect((raised as OwnerLinkError).refusal).toBe("malformed-answer");
  });

  it("refuses an answer whose correlation id is not one", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(function* () {
        try {
          yield* owner.ask("a1", { command: "frontier" }, readString);
        } catch (error) {
          raised = error;
        }
      });
      yield* sleep(0);
      wire.answer({ id: "x".repeat(200), outcome: "performed", value: 1 });
      yield* asking;
    });
    expect((raised as OwnerLinkError).refusal).toBe("malformed-answer");
  });

  it("leaves no waiter or listener behind when its scope ends", function* () {
    const wire = fakeSocket();
    let answered = false;
    // The connection's scope ends with a request still in flight. Cancellation
    // halts the asking task rather than raising into it, so what is observable
    // is that the scope completes at all — a waiter nothing settled would hang
    // teardown — and that nothing is left listening afterwards.
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      yield* spawn(function* () {
        yield* owner.ask("a1", { command: "frontier" }, readString);
        answered = true;
      });
      yield* sleep(0);
    });

    expect(answered).toBe(false);
    // A late answer reaches nothing: the listener went with the scope, and
    // delivering it must not raise out of the socket either.
    wire.answer({ id: "a1", outcome: "performed", value: "too late" });
    expect(answered).toBe(false);
  });

  it("fails closed on a second answer to a request already settled", function* () {
    const wire = fakeSocket();
    let answered: unknown;
    let refused: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const first = yield* spawn(() => owner.ask("a1", { command: "frontier" }, readString));
      yield* sleep(0);
      wire.answer({ id: "a1", outcome: "performed", value: "once" });
      answered = yield* first;

      const second = yield* spawn(function* () {
        try {
          yield* owner.ask("a2", { command: "settle" }, readString);
        } catch (error) {
          refused = error;
        }
      });
      yield* sleep(0);
      // The owner answers `a1` again. Correlation has broken.
      wire.answer({ id: "a1", outcome: "performed", value: "twice" });
      yield* second;
    });
    expect(answered).toEqual({ outcome: "performed", value: "once" });
    expect((refused as OwnerLinkError).refusal).toBe("duplicate-answer");
  });
});
