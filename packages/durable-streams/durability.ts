import { ensure, resource, withResolvers } from "effection";
import type { Operation, WithResolvers } from "effection";
import type { DurableAppendFence, DurableContext, DurabilityState } from "./context.ts";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  DurablePersistenceError,
  StaleInputError,
  TerminalDivergenceError,
} from "./errors.ts";
import { withDurableEventRejectionObserver } from "./guard.ts";
import type { DurableEvent } from "./types.ts";

interface AppendTurn {
  readonly gate: WithResolvers<void>;
  granted: boolean;
}

function createAppendFence(): DurableAppendFence {
  let held = false;
  const waiting: AppendTurn[] = [];

  function release(): void {
    const next = waiting.shift();
    if (next === undefined) {
      held = false;
      return;
    }
    next.granted = true;
    next.gate.resolve();
  }

  return {
    hold: () =>
      resource<void>(function* (provide) {
        const turn: AppendTurn = { gate: withResolvers<void>(), granted: false };

        yield* ensure(() => {
          if (turn.granted) {
            release();
            return;
          }
          const index = waiting.indexOf(turn);
          if (index >= 0) {
            waiting.splice(index, 1);
          }
        });

        if (held) {
          waiting.push(turn);
          yield* turn.gate.operation;
        } else {
          held = true;
          turn.granted = true;
        }

        yield* provide();
      }),
  };
}

function durabilityState(ctx: DurableContext): DurabilityState {
  ctx.durability ??= {};
  return ctx.durability;
}

function appendFence(ctx: DurableContext): DurableAppendFence {
  const state = durabilityState(ctx);
  state.appendFence ??= createAppendFence();
  return state.appendFence;
}

export function findDurabilityFailure(error: unknown): Error | undefined {
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];

  while (pending.length > 0) {
    const current = pending.shift();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (
      current instanceof DurablePersistenceError ||
      current instanceof StaleInputError ||
      current instanceof DivergenceError ||
      current instanceof TerminalDivergenceError ||
      current instanceof ContinuePastCloseDivergenceError
    ) {
      return current;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }

  return undefined;
}

export function rememberDurabilityFailure(ctx: DurableContext, error: Error): Error {
  const state = durabilityState(ctx);
  state.failure ??= error;
  return state.failure;
}

export function activeDurabilityFailure(ctx: DurableContext, error?: unknown): Error | undefined {
  if (ctx.durability?.failure) {
    return ctx.durability.failure;
  }
  const failure = findDurabilityFailure(error);
  if (failure) {
    return rememberDurabilityFailure(ctx, failure);
  }
  return undefined;
}

export function* appendDurableEvent(ctx: DurableContext, event: DurableEvent): Operation<void> {
  const existing = activeDurabilityFailure(ctx);
  if (existing) {
    throw existing;
  }

  yield* appendFence(ctx).hold();

  const admitted = activeDurabilityFailure(ctx);
  if (admitted) {
    throw admitted;
  }

  let policyRejection: unknown;
  let policyRejected = false;
  try {
    yield* withDurableEventRejectionObserver(
      (error) => {
        policyRejection = error;
        policyRejected = true;
      },
      () => ctx.stream.append(event),
    );
  } catch (error) {
    if (policyRejected && Object.is(error, policyRejection)) {
      const failure = activeDurabilityFailure(ctx);
      if (failure) {
        throw failure;
      }
      throw error;
    }
    const active = activeDurabilityFailure(ctx);
    if (active) {
      throw active;
    }
    throw rememberDurabilityFailure(ctx, new DurablePersistenceError(event.type, error));
  }
}
