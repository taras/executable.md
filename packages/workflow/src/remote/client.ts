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

/** What the owner answered, as the client reads it. */
export type OwnerAnswer =
  | { readonly outcome: "performed"; readonly value: unknown }
  | { readonly outcome: "refused"; readonly refusal: string };

/** The socket shape this client needs, so a test can supply one. */
export interface OwnerSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

/** One live connection to a run's owner. */
export interface OwnerConnection {
  /** Send one command and wait for the answer that names it. */
  ask(id: string, command: Record<string, unknown>): Operation<OwnerAnswer>;
}

/** The most bytes one answer may carry. */
const MAX_ANSWER = 8 * 1024 * 1024;

function readAnswer(raw: unknown): { id: string; answer: OwnerAnswer } {
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
  const members = decoded as Record<string, unknown>;
  const id = members["id"];
  const outcome = members["outcome"];
  if (typeof id !== "string") {
    throw new OwnerLinkError("malformed-answer");
  }
  if (outcome === "performed") {
    return { id, answer: { outcome, value: members["value"] } };
  }
  if (outcome === "refused") {
    const refusal = members["refusal"];
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
    const waiting = new Map<string, ReturnType<typeof withResolvers<OwnerAnswer>>>();
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
        pending.reject(new OwnerLinkError(refusal));
      }
      waiting.clear();
      socket.close();
    };

    yield* spawn(function* () {
      for (const raw of yield* each(messages)) {
        let read: { id: string; answer: OwnerAnswer } | undefined;
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
        pending.resolve(read.answer);
        yield* each.next();
      }
      closed = true;
      for (const pending of waiting.values()) {
        pending.reject(new OwnerLinkError("closed"));
      }
      waiting.clear();
    });

    yield* provide({
      *ask(id: string, command: Record<string, unknown>): Operation<OwnerAnswer> {
        if (closed) {
          throw new OwnerLinkError("closed");
        }
        if (waiting.has(id) || settled.has(id)) {
          throw new OwnerLinkError("duplicate-answer");
        }
        const pending = withResolvers<OwnerAnswer>();
        waiting.set(id, pending);
        socket.send(JSON.stringify({ ...command, id }));
        return yield* pending.operation;
      },
    });
  });
}
