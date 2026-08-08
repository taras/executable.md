import type { Operation } from "effection";
import type { DurableContext } from "./context.ts";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  DurablePersistenceError,
  StaleInputError,
  TerminalDivergenceError,
} from "./errors.ts";
import { isDurableEventRejection, unwrapDurableEventRejection } from "./guard.ts";
import type { DurableEvent } from "./types.ts";

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
  ctx.durability ??= {};
  ctx.durability.failure ??= error;
  return ctx.durability.failure;
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
  try {
    yield* ctx.stream.append(event);
  } catch (error) {
    if (isDurableEventRejection(error)) {
      const rejection = unwrapDurableEventRejection(error);
      const failure = findDurabilityFailure(rejection);
      if (failure) {
        rememberDurabilityFailure(ctx, failure);
      }
      throw rejection;
    }
    const failure = new DurablePersistenceError(event.type, error);
    rememberDurabilityFailure(ctx, failure);
    throw failure;
  }
}
