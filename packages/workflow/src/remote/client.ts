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

import { createSignal, each, type Operation, resource, spawn, withResolvers } from "effection";

/** Why the connection itself could not carry a request. */
export type LinkRefusal =
  | "closed"
  | "malformed-answer"
  | "unknown-answer"
  | "duplicate-answer"
  | "too-large";

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

/** The socket shape this client needs, so a test can supply one. */
export interface OwnerSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
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
  if (typeof id !== "string") {
    throw new OwnerLinkError("malformed-answer");
  }
  if (outcome === "performed") {
    return { id, answer: { outcome, value: members.get("value") } };
  }
  if (outcome === "refused") {
    const refusal = members.get("refusal");
    if (typeof refusal !== "string") {
      throw new OwnerLinkError("malformed-answer");
    }
    return { id, answer: { outcome, refusal } };
  }
  throw new OwnerLinkError("malformed-answer");
}

/**
 * Hold one connection open for the calling scope.
 *
 * Teardown resolves every request still waiting with a closed refusal rather
 * than leaving it pending: a caller blocked on an answer that can never arrive
 * would outlive the connection it was asking through.
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
    const messages = createSignal<unknown, void>();
    let closed = false;

    socket.addEventListener("message", (event) => messages.send(event.data));
    socket.addEventListener("close", () => {
      closed = true;
      messages.close();
    });

    /** Stop the channel and tell everyone waiting why. */
    const fail = (refusal: LinkRefusal) => {
      closed = true;
      for (const pending of waiting.values()) {
        pending.fail(new OwnerLinkError(refusal));
      }
      waiting.clear();
      socket.close();
    };

    yield* spawn(function* () {
      for (const raw of yield* each(messages)) {
        let read: { id: string; answer: RawAnswer } | undefined;
        try {
          read = readAnswer(raw);
        } catch {
          // The owner said something this build cannot read. Whether it was
          // meant for a waiter is exactly what cannot be established.
          fail("malformed-answer");
          break;
        }
        const pending = waiting.get(read.id);
        if (pending === undefined) {
          // Either a request nobody made, or a second answer to one already
          // settled. Both mean the two sides disagree about what completed.
          fail(settled.has(read.id) ? "duplicate-answer" : "unknown-answer");
          break;
        }
        waiting.delete(read.id);
        settled.add(read.id);
        if (!pending.deliver(read.answer)) {
          // The owner performed the command and described the result in a way
          // this build cannot read. Handing the caller an unparsed value is the
          // one outcome that must not happen.
          waiting.set(read.id, pending);
          fail("malformed-answer");
          break;
        }
        yield* each.next();
      }
      closed = true;
      for (const pending of waiting.values()) {
        pending.fail(new OwnerLinkError("closed"));
      }
      waiting.clear();
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
        socket.send(JSON.stringify({ ...command, id }));
        return yield* settle.operation;
      },
    });
  });
}
