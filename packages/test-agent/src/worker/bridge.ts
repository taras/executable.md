/**
 * The worker bridge (specs/test-agent-spec.md §Behavior documents): one
 * ordered channel carries output chunks, matcher suspensions, EOF, and
 * document failure, so the final output chunk of a turn always precedes
 * the suspension/EOF signal that ends it. Prompt offers flow the other
 * way, one at a time, to whichever matcher is suspended.
 */

import { createChannel, withResolvers } from "effection";
import type { Channel, Operation, Subscription } from "effection";
import type { TemplateMatchResult } from "../template.ts";

export type BridgeEvent =
  | { kind: "output"; text: string }
  | { kind: "suspended"; stage: string }
  | { kind: "eof" }
  | { kind: "failed"; error: string };

export interface PromptOffer {
  text: string;
  respond(outcome: TemplateMatchResult): void;
}

export interface TurnBridge {
  events: Channel<BridgeEvent, never>;
  offer(text: string): Operation<TemplateMatchResult>;
  nextOffer(): Operation<PromptOffer>;
}

export function createTurnBridge(): TurnBridge {
  const events = createChannel<BridgeEvent, never>();
  const offers: PromptOffer[] = [];
  const waiters: Array<(offer: PromptOffer) => void> = [];

  function drop<T>(queue: T[], entry: T): void {
    const index = queue.indexOf(entry);
    if (index !== -1) {
      queue.splice(index, 1);
    }
  }

  return {
    events,
    *offer(text) {
      const outcome = withResolvers<TemplateMatchResult>();
      const offer: PromptOffer = { text, respond: outcome.resolve };
      const waiter = waiters.shift();
      if (waiter) {
        waiter(offer);
      } else {
        offers.push(offer);
      }
      try {
        return yield* outcome.operation;
      } finally {
        // A halted offer must not linger in the queue for a later
        // nextOffer() to deliver as if it were live.
        drop(offers, offer);
      }
    },
    *nextOffer() {
      const queued = offers.shift();
      if (queued) {
        return queued;
      }
      const arrival = withResolvers<PromptOffer>();
      waiters.push(arrival.resolve);
      try {
        return yield* arrival.operation;
      } finally {
        // A halted waiter must not be handed a later offer, which would
        // deliver the prompt to a dead operation and hang the offerer.
        drop(waiters, arrival.resolve);
      }
    },
  };
}

/**
 * Read bridge events until the current turn ends, concatenating output.
 * Returns the terminal signal so callers distinguish the next matcher,
 * EOF, and document failure.
 */
export function* collectTurn(subscription: Subscription<BridgeEvent, never>): Operation<{
  text: string;
  end: "suspended" | "eof" | "failed";
  stage?: string;
  error?: string;
}> {
  let text = "";
  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      return { text, end: "eof" };
    }
    const event = next.value;
    if (event.kind === "output") {
      text += event.text;
    } else if (event.kind === "suspended") {
      return { text, end: "suspended", stage: event.stage };
    } else if (event.kind === "failed") {
      return { text, end: "failed", error: event.error };
    } else {
      return { text, end: "eof" };
    }
  }
}
