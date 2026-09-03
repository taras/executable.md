/**
 * The runner's side of the connection to its owner.
 *
 * One connection, one acquisition, and one request in flight at a time per
 * command id. Requests and answers are correlated explicitly rather than by
 * arrival order, because a socket delivers what the owner sent whenever it
 * sent it, and a client that assumed order would attribute one command's
 * refusal to another.
 *
 * Nothing here decides anything about the run. It carries a question to the
 * owner and hands back what the owner said — including a refusal, which is an
 * answer rather than a transport failure. What the owner does with a command is
 * the owner's, and a client that interpreted a refusal would be a second place
 * deciding what a run may do.
 *
 * What it will not do is carry on after the two sides disagree about which
 * command completed. An answer it cannot read, an answer naming a request
 * nobody made, and a second answer to a request already settled are each
 * evidence that correlation has broken — and a commit may have landed on the
 * owner while the caller waits for a reply that will never be attributed. So
 * the channel fails closed: it stops, and every waiter learns, rather than
 * dropping the answer and leaving somebody blocked forever.
 */

import { ensure, type Operation, resource, withResolvers } from "effection";

/** Why the connection itself could not carry a request. */
export type LinkRefusal =
  | "closed"
  | "malformed-answer"
  | "unknown-answer"
  | "duplicate-answer"
  | "too-large"
  | "malformed-request"
  | "send-failed"
  | "socket-error";

export class OwnerLinkError extends Error {
  override name = "OwnerLinkError";

  constructor(readonly refusal: LinkRefusal) {
    super(`the connection to this run's owner cannot carry the request (${refusal})`);
  }
}

/**
 * What the owner answered, once the caller's own parser has read the value.
 *
 * `T` is what the request asked for. A performed answer carries a parsed value
 * and never an `unknown`: the JSON boundary is inside this module, and letting
 * it out would make every consumer responsible for remembering to parse — which
 * is the kind of thing that is remembered until it is not.
 */
export type OwnerAnswer<T> =
  | { readonly outcome: "performed"; readonly value: T }
  | { readonly outcome: "refused"; readonly refusal: string };

/**
 * How a request reads its own success value.
 *
 * Supplied with the request, because what a performed answer means is the
 * command's business rather than the connection's. Raising is how it says the
 * owner sent something this build cannot read.
 */
export type AnswerParser<T> = (value: unknown) => T;

/** One listener, kept so teardown can remove the exact callback it installed. */
export type SocketListener = (event: { data?: unknown }) => void;

/** The socket shape this client needs, so a test can supply one. */
export interface OwnerSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message" | "close" | "error", listener: SocketListener): void;
  removeEventListener(type: "message" | "close" | "error", listener: SocketListener): void;
}

/** One live connection to a run's owner. */
export interface OwnerConnection {
  /**
   * Send one command and wait for the answer that names it.
   *
   * `parse` reads the success value. If it raises, the channel fails closed
   * like any other disagreement about what completed — a value neither side
   * agrees on is not something to hand a caller and carry on from.
   */
  ask<T>(
    id: string,
    command: Record<string, unknown>,
    parse: AnswerParser<T>,
  ): Operation<OwnerAnswer<T>>;
}

/** The most bytes one answer may carry. */
const MAX_ANSWER = 8 * 1024 * 1024;

/** The longest correlation id, in either direction. */
const MAX_ID = 128;

/**
 * The longest refusal this reads.
 *
 * Small and its own bound: a refusal is a category, and the eight-megabyte
 * envelope bound is for a command's payload rather than for a word.
 */
const MAX_REFUSAL = 200;

/** Whether a correlation id is one this client will send or accept. */
function usableId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_ID;
}

/**
 * The shape a refusal category has.
 *
 * The owner answers with a category and an optional detail. This proves
 * *spelling* and nothing more — a syntactically valid category this build has
 * never heard of still passes here. Narrowing a refusal to the exact declared
 * union is the Cloudflare adapter's job, where the union is known; what this
 * bound is for is stopping an arbitrary remote sentence from travelling as
 * though it were a category at all.
 */
const REFUSAL = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;

/** The envelope, before the caller's parser reads the value inside it. */
type RawAnswer =
  | { readonly outcome: "performed"; readonly value: unknown }
  | { readonly outcome: "refused"; readonly refusal: string };

function readAnswer(raw: unknown): { id: string; answer: RawAnswer } {
  if (typeof raw !== "string") {
    throw new OwnerLinkError("malformed-answer");
  }
  if (raw.length > MAX_ANSWER) {
    throw new OwnerLinkError("too-large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new OwnerLinkError("malformed-answer");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new OwnerLinkError("malformed-answer");
  }
  const members: Map<string, unknown> = new Map(Object.entries(decoded));
  const id = members.get("id");
  const outcome = members.get("outcome");
  if (!usableId(id)) {
    throw new OwnerLinkError("malformed-answer");
  }

  // Each branch declares its whole key set. A performed answer carrying a
  // `refusal`, or a refused one carrying a `value`, is an answer the two sides
  // disagree about the shape of — which is the thing this channel refuses to
  // carry on past.
  const declared =
    outcome === "performed" ? ["id", "outcome", "value"] : ["id", "outcome", "refusal"];
  if (members.size !== declared.length) {
    throw new OwnerLinkError("malformed-answer");
  }
  for (const key of members.keys()) {
    if (!declared.includes(key)) {
      throw new OwnerLinkError("malformed-answer");
    }
  }

  if (outcome === "performed") {
    return { id, answer: { outcome, value: members.get("value") } };
  }
  if (outcome === "refused") {
    const refusal = members.get("refusal");
    if (typeof refusal !== "string" || refusal.length > MAX_REFUSAL || !REFUSAL.test(refusal)) {
      throw new OwnerLinkError("malformed-answer");
    }
    return { id, answer: { outcome, refusal } };
  }
  throw new OwnerLinkError("malformed-answer");
}

/**
 * Hold one connection open for the calling scope.
 *
 * The connection *is* the executor acquisition, so the scope that owns it owns
 * ending it: there is no lease to expire and no heartbeat to miss, and an owner
 * that still sees a healthy socket still considers this runner the executor. A
 * scope that walked away without closing would leave the run unadvanceable by
 * anybody, forever.
 *
 * So teardown is one operation with one owner. Scope exit, cancellation, a
 * remote close, a socket error, a protocol failure and a failed send all reach
 * it, it runs once, and it removes the exact listeners it installed and closes
 * the socket. The failure that caused it is what the waiters are told — a close
 * arriving afterwards must not rewrite `malformed-answer` into `closed`.
 */
export function useOwnerConnection(socket: OwnerSocket): Operation<OwnerConnection> {
  return resource(function* (provide) {
    /**
     * One waiting request, as the reader sees it.
     *
     * The command's own type stays inside the closure `ask()` built, so the
     * reader settles an answer without naming it and nothing here has to assert
     * what a value is. `deliver` answers whether the value could be read.
     */
    interface Waiter {
      deliver(answer: RawAnswer): boolean;
      fail(error: OwnerLinkError): void;
    }
    const waiting = new Map<string, Waiter>();
    /** Requests already answered, so a second answer is recognized as one. */
    const settled = new Set<string>();
    let closed = false;
    let torn = false;

    /**
     * Read one incoming answer and settle the request it names.
     *
     * Synchronous, and deliberately so. If this queued the message and read it
     * later, a close arriving in the same turn would reach teardown first and
     * the caller would be told `closed` for an answer that was actually
     * unreadable. What went wrong is decided where it is observed.
     */
    const onMessage: SocketListener = (event) => {
      if (torn) {
        return;
      }
      let read: { id: string; answer: RawAnswer };
      try {
        read = readAnswer(event.data);
      } catch (error) {
        // The owner said something this build cannot read. Whether it was meant
        // for a waiter is exactly what cannot be established.
        teardown(error instanceof OwnerLinkError ? error.refusal : "malformed-answer");
        return;
      }
      const pending = waiting.get(read.id);
      if (pending === undefined) {
        // Either a request nobody made, or a second answer to one already
        // settled. Both mean the two sides disagree about what completed.
        teardown(settled.has(read.id) ? "duplicate-answer" : "unknown-answer");
        return;
      }
      waiting.delete(read.id);
      settled.add(read.id);
      if (!pending.deliver(read.answer)) {
        // The owner performed the command and described the result in a way
        // this build cannot read. Handing the caller an unparsed value is the
        // one outcome that must not happen.
        waiting.set(read.id, pending);
        teardown("malformed-answer");
      }
    };
    const onClose: SocketListener = () => teardown("closed");
    const onError: SocketListener = () => teardown("socket-error");

    /**
     * End the connection, once.
     *
     * `refusal` is what the waiters are told. The first caller decides it: a
     * remote close after a malformed answer is the same teardown, and the
     * caller waiting on that answer should learn what actually went wrong.
     */
    function teardown(refusal: LinkRefusal): void {
      if (torn) {
        return;
      }
      torn = true;
      closed = true;
      for (const pending of waiting.values()) {
        pending.fail(new OwnerLinkError(refusal));
      }
      waiting.clear();
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      try {
        socket.close();
      } catch {
        // Already closed, or closing threw on the way out. Either way this
        // connection is over and there is nothing left to tell anybody.
      }
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    // Registered before anything can suspend, so a cancellation between here
    // and `provide()` still closes the socket it just started listening to.
    yield* ensure(() => {
      teardown("closed");
    });

    yield* provide({
      *ask<T>(
        id: string,
        command: Record<string, unknown>,
        parse: AnswerParser<T>,
      ): Operation<OwnerAnswer<T>> {
        if (closed) {
          throw new OwnerLinkError("closed");
        }
        // The same contract an incoming answer is held to. An id this client
        // would refuse to read must never be one it sends.
        if (!usableId(id)) {
          throw new OwnerLinkError("malformed-request");
        }
        if (waiting.has(id) || settled.has(id)) {
          throw new OwnerLinkError("duplicate-answer");
        }
        const settle = withResolvers<OwnerAnswer<T>>();
        waiting.set(id, {
          deliver(answer: RawAnswer): boolean {
            if (answer.outcome === "refused") {
              // A refusal is an answer. Nothing is parsed and nothing fails.
              settle.resolve(answer);
              return true;
            }
            let value: T;
            try {
              value = parse(answer.value);
            } catch {
              return false;
            }
            settle.resolve({ outcome: "performed", value });
            return true;
          },
          fail(error: OwnerLinkError): void {
            settle.reject(error);
          },
        });
        try {
          socket.send(JSON.stringify({ ...command, id }));
        } catch {
          // The socket refused the write. This request never left, and the
          // connection cannot be trusted to carry the next one either.
          teardown("send-failed");
          throw new OwnerLinkError("send-failed");
        }
        return yield* settle.operation;
      },
    });
  });
}
