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
import {
  type OwnerSocket,
  OwnerLinkError,
  type SocketListener,
  MAX_MESSAGE_BYTES,
  useOwnerConnection,
} from "../src/remote/client.ts";

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

/**
 * What the connection refused with, having proved it refused at all.
 *
 * A caught value is `unknown`, and asserting it into `OwnerLinkError` would let
 * an unrelated failure read as the transport category a test expected.
 */
function refusalOf(error: unknown): string {
  if (!(error instanceof OwnerLinkError)) {
    throw new Error(`expected an OwnerLinkError, got ${String(error)}`);
  }
  return error.refusal;
}

/**
 * A socket a test drives by hand, and can ask what happened to it.
 *
 * It counts closes and tracks the listeners still installed, because the claims
 * under test are about teardown: that the connection closes its socket exactly
 * once and stops listening. A fake that merely retained its callbacks would let
 * a test assert cleanup that never happened — which is how the previous version
 * of this suite passed while the connection leaked both.
 */
function fakeSocket(options: { failSend?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, Set<SocketListener>>();
  let closes = 0;

  const deliver = (type: string, event: { data?: unknown }) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };

  const socket: OwnerSocket = {
    send(data: string): void {
      if (options.failSend === true) {
        throw new Error("the socket refused the write");
      }
      sent.push(JSON.parse(data));
    },
    close(): void {
      closes += 1;
    },
    addEventListener(type, listener): void {
      const existing = listeners.get(type) ?? new Set<SocketListener>();
      existing.add(listener);
      listeners.set(type, existing);
    },
    removeEventListener(type, listener): void {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    socket,
    sent,
    get closes(): number {
      return closes;
    },
    /** How many listeners are still installed, of any type. */
    get listening(): number {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
    answer(value: unknown): void {
      deliver("message", {
        data: typeof value === "string" ? value : JSON.stringify(value),
      });
    },
    end(): void {
      deliver("close", {});
    },
    error(): void {
      deliver("error", {});
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
      yield* sleep(0);
      // Both requests are on the wire before either is answered.
      expect(wire.sent.map((request) => request.id)).toEqual(["a1", "a2"]);

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
      yield* sleep(0);
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
    expect(refusalOf(raised)).toBe("closed");
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
    expect(refusalOf(raised)).toBe("closed");
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
    expect(refusalOf(raised)).toBe("duplicate-answer");
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
      expect(refusalOf(error)).toBe("malformed-answer");
    }
    expect(wire.closes).toBe(1);
    expect(wire.listening).toBe(0);
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
    expect(refusalOf(raised)).toBe("unknown-answer");
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
      expect(refusalOf(error)).toBe("malformed-answer");
    }
    expect(wire.closes).toBe(1);
    expect(wire.listening).toBe(0);
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
    expect(refusalOf(raised)).toBe("malformed-answer");
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
    expect(refusalOf(raised)).toBe("malformed-answer");
  });

  it("closes the socket once and stops listening when its scope ends", function* () {
    const wire = fakeSocket();
    let answered = false;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      expect(wire.listening).toBeGreaterThan(0);
      yield* spawn(function* () {
        yield* owner.ask("a1", { command: "frontier" }, readString);
        answered = true;
      });
      yield* sleep(0);
      // Leaving with a request in flight. The connection is the acquisition, so
      // the owner only learns this runner is gone when the socket closes.
    });

    expect(wire.closes).toBe(1);
    expect(wire.listening).toBe(0);
    expect(answered).toBe(false);

    // A late message and a late close reach nothing and raise nothing.
    wire.answer({ id: "a1", outcome: "performed", value: "too late" });
    wire.end();
    expect(answered).toBe(false);
    expect(wire.closes).toBe(1);
  });

  it("ends the same way however the connection is lost", function* () {
    // Each of these is one teardown with one owner: the waiters learn why, the
    // listeners go, and the socket closes exactly once.
    const cases: [string, (wire: ReturnType<typeof fakeSocket>) => void][] = [
      ["closed", (wire) => wire.end()],
      ["socket-error", (wire) => wire.error()],
      ["malformed-answer", (wire) => wire.answer("not json at all")],
      ["unknown-answer", (wire) => wire.answer({ id: "nobody", outcome: "performed", value: 1 })],
    ];

    for (const [expected, provoke] of cases) {
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
        provoke(wire);
        yield* asking;
      });
      expect(refusalOf(raised)).toBe(expected);
      expect(wire.closes).toBe(1);
      expect(wire.listening).toBe(0);
    }
  });

  it("keeps the failure that caused teardown when a close follows it", function* () {
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
      wire.answer("not json at all");
      // The remote end closes right after. The caller should still learn what
      // actually went wrong rather than a generic `closed`.
      wire.end();
      yield* asking;
    });
    expect(refusalOf(raised)).toBe("malformed-answer");
    expect(wire.closes).toBe(1);
  });

  it("tears down when the socket refuses the write, and sends nothing", function* () {
    const wire = fakeSocket({ failSend: true });
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      try {
        yield* owner.ask("a1", { command: "frontier" }, readString);
      } catch (error) {
        raised = error;
      }
    });
    expect(refusalOf(raised)).toBe("send-failed");
    expect(wire.sent).toEqual([]);
    expect(wire.closes).toBe(1);
    expect(wire.listening).toBe(0);
  });

  it("refuses a request larger than one message, before it is outstanding", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    let reused: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      try {
        // Under the bound on its own; over it once the correlation id and the
        // framing around it are counted. Measuring one member instead would
        // let exactly this request through.
        yield* owner.ask(
          "over",
          { command: "retrieval", metadata: "m".repeat(MAX_MESSAGE_BYTES - 40) },
          readString,
        );
      } catch (error) {
        raised = error;
      }
      // The id never became outstanding, so it is still usable. A request that
      // was registered and then refused would fail here as a duplicate.
      try {
        yield* spawn(function* () {
          yield* owner.ask("over", { command: "frontier" }, readString);
        });
        yield* sleep(0);
      } catch (error) {
        reused = error;
      }
    });
    expect(refusalOf(raised)).toBe("too-large");
    expect(reused).toBe(undefined);
    // Exactly one message left: the small one.
    expect(wire.sent).toEqual([{ id: "over", command: "frontier" }]);
  });

  it("refuses to send a correlation id it would refuse to read", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      try {
        yield* owner.ask("", { command: "frontier" }, readString);
      } catch (error) {
        raised = error;
      }
      expect(refusalOf(raised)).toBe("malformed-request");
      try {
        yield* owner.ask("x".repeat(200), { command: "frontier" }, readString);
      } catch (error) {
        raised = error;
      }
    });
    expect(refusalOf(raised)).toBe("malformed-request");
    // Nothing left, so nothing to correlate an answer to.
    expect(wire.sent).toEqual([]);
  });

  it("refuses an answer whose branch carries a member it does not declare", function* () {
    const cases: unknown[] = [
      { id: "a1", outcome: "performed", value: 1, refusal: "acquisition:stale" },
      { id: "a1", outcome: "refused", refusal: "acquisition:stale", value: 1 },
      { id: "a1", outcome: "performed" },
      { id: "a1", outcome: "refused" },
      { id: "a1", outcome: "performed", value: 1, extra: true },
    ];
    for (const answer of cases) {
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
        wire.answer(answer);
        yield* asking;
      });
      expect(refusalOf(raised)).toBe("malformed-answer");
    }
  });

  it("releases the socket when the scope holding it is cancelled", function* () {
    const wire = fakeSocket();
    let raised: unknown;
    yield* scoped(function* () {
      const holding = yield* spawn(function* () {
        const owner = yield* useOwnerConnection(wire.socket);
        yield* sleep(0);
        try {
          yield* owner.ask("a1", { command: "frontier" }, readString);
        } catch (error) {
          raised = error;
        }
      });
      yield* sleep(0);
      expect(wire.listening).toBeGreaterThan(0);
      // Cancellation, rather than the scope reaching its end. The connection is
      // the acquisition either way, so the socket must still close.
      yield* holding.halt();
    });
    expect(wire.closes).toBe(1);
    expect(wire.listening).toBe(0);
    // Halting the caller means it is never told anything; the socket closing is
    // what the owner observes.
    expect(raised).toBe(undefined);
  });

  it("carries a refusal category this build has never heard of", function* () {
    const wire = fakeSocket();
    let answered: unknown;
    yield* scoped(function* () {
      const owner = yield* useOwnerConnection(wire.socket);
      yield* sleep(0);
      const asking = yield* spawn(() => owner.ask("a1", { command: "commit" }, readString));
      yield* sleep(0);
      // Well-spelled and not a category this layer knows. Deciding which
      // categories exist belongs to the adapter that declares the union, so the
      // connection hands it through rather than guessing on the adapter's
      // behalf and failing a run over a word.
      wire.answer({ id: "a1", outcome: "refused", refusal: "workspace:root-unknown-here" });
      answered = yield* asking;
    });
    expect(answered).toEqual({ outcome: "refused", refusal: "workspace:root-unknown-here" });
    expect(wire.closes).toBe(1);
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
    expect(refusalOf(refused)).toBe("duplicate-answer");
    expect(wire.closes).toBe(1);
    expect(wire.listening).toBe(0);
  });
});
