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
 */

import { createSignal, each, type Operation, resource, spawn, withResolvers } from "effection";

/** Why the connection itself could not carry a request. */
export type LinkRefusal = "closed" | "malformed-answer" | "duplicate-answer";

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

function readAnswer(raw: unknown): { id: string; answer: OwnerAnswer } {
  if (typeof raw !== "string") {
    throw new OwnerLinkError("malformed-answer");
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
    const messages = createSignal<unknown, void>();
    let closed = false;

    socket.addEventListener("message", (event) => messages.send(event.data));
    socket.addEventListener("close", () => {
      closed = true;
      messages.close();
    });

    yield* spawn(function* () {
      for (const raw of yield* each(messages)) {
        // A malformed answer fails the request it names when it names one, and
        // is otherwise dropped: it cannot be attributed to a caller.
        try {
          const { id, answer } = readAnswer(raw);
          const pending = waiting.get(id);
          if (pending !== undefined) {
            waiting.delete(id);
            pending.resolve(answer);
          }
        } catch {
          // Nothing to attribute it to.
        }
        yield* each.next();
      }
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
        if (waiting.has(id)) {
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
