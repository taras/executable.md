import { ensure, scoped, useScope } from "effection";
import type { Operation } from "effection";
import { DurableContext } from "./context.ts";
import { activeDurabilityFailure, appendDurableEvent } from "./durability.ts";
import { StaleInputError } from "./errors.ts";
import { consumable, observeEvent, retainEvents } from "./retained.ts";
import { createDurableOperation } from "./effect.ts";
import type { DurableEvent, EffectDescription, Json } from "./types.ts";

interface Owner {
  readonly context: DurableContext;
  readonly stream: DurableContext["stream"];
  readonly replayIndex: DurableContext["replayIndex"];
  readonly coroutineId: string;
  readonly durability: DurableContext["durability"];
  readonly stage?: Buffer;
  next: number;
  live: boolean;
}

interface Buffer {
  open: boolean;
  readonly events: DurableEvent[];
}

const owners = new WeakMap<DurableContext, Owner>();

export function registerStagingOwner(context: DurableContext, parent?: DurableContext): void {
  owners.set(context, {
    context,
    stream: context.stream,
    replayIndex: context.replayIndex,
    coroutineId: context.coroutineId,
    durability: context.durability,
    next: context.childCounter,
    live: true,
    stage: parent === undefined ? undefined : owners.get(parent)?.stage,
  });
}

export function allocateChildId(context: DurableContext): string {
  const owner = owners.get(context);
  if (owner !== undefined) {
    assertOwner(owner);
    owner.next += 1;
  }
  return `${context.coroutineId}.${context.childCounter++}`;
}

function assertOwner(owner: Owner): void {
  const context = owner.context;
  if (
    !owner.live ||
    context.stream !== owner.stream ||
    context.replayIndex !== owner.replayIndex ||
    context.coroutineId !== owner.coroutineId ||
    context.durability !== owner.durability ||
    context.childCounter !== owner.next
  ) {
    throw new StaleInputError("The durable child owner changed.");
  }
}

/** Provisional settlement is not a backend append or a durability acknowledgement. */
export function stageDurableEvent(context: DurableContext, event: DurableEvent): boolean {
  const owner = owners.get(context);
  if (owner?.stage === undefined) {
    return false;
  }
  assertOwner(owner);
  if (!owner.stage.open) {
    throw new StaleInputError("The durable stage has closed.");
  }
  owner.stage.events.push(...retainEvents([observeEvent(event)]));
  return true;
}

/** A one-use child owner. Only its run operation installs its replay position. */
export interface DurableStage {
  readonly retained: Json | undefined;
  readonly failure: unknown;
  readonly ready: boolean;
  open(): Operation<void>;
  readonly children: DurableStageFactory;
  bind(): Operation<void>;
  run<T>(body: () => Operation<T>): Operation<T>;
  finish(value: Json, publish: boolean): Operation<void>;
  close(): void;
}

/** Delivered directly by durableRun to its execution owner, never through context. */
export interface DurableStageFactory {
  create(description: EffectDescription): Operation<DurableStage>;
}

export function stagingFactory(context: DurableContext): DurableStageFactory {
  return Object.freeze({
    create: (description: EffectDescription) => stageChild(context, description),
  });
}

export function revokeStagingOwner(context: DurableContext): void {
  const owner = owners.get(context);
  if (owner !== undefined) {
    owner.live = false;
  }
}

/**
 * Allocate a staged child of the current durable execution. The caller owns
 * its lifetime; run may be transferred into another structured projection
 * scope without transferring a context, stream, cursor or coroutine ID.
 */
export function* createDurableStage(description?: EffectDescription): Operation<DurableStage> {
  const scope = yield* useScope();
  const parent = scope.expect(DurableContext);
  return yield* stageChild(parent, description);
}

function* stageChild(
  parent: DurableContext,
  description?: EffectDescription,
): Operation<DurableStage> {
  const owner = owners.get(parent);
  if (owner === undefined) {
    throw new StaleInputError("Staging requires an execution-owned durable parent.");
  }
  assertOwner(owner);
  const childId = allocateChildId(parent);
  const context: DurableContext = {
    stream: owner.stream,
    replayIndex: owner.replayIndex,
    coroutineId: childId,
    durability: owner.durability,
    childCounter: 0,
  };
  registerStagingOwner(context, parent);
  const buffer: Buffer = { open: true, events: [] };
  owners.set(context, { ...owners.get(context)!, stage: buffer });
  const index = owner.replayIndex;
  index.claim(childId);
  const close = index.getClose(childId);
  if (close !== undefined && close.result.status !== "ok") {
    throw new StaleInputError("A staged child has no accepted closed outcome.");
  }
  const retained = close === undefined ? undefined : consumable(close.result);
  let entered = false;
  let settled = false;
  let finished = false;
  let opened = description === undefined;
  let opening = false;
  let failure: unknown;

  const stage: DurableStage = Object.freeze({
    retained: retained?.status === "ok" ? retained.value : undefined,
    get failure(): unknown {
      return failure;
    },
    get ready(): boolean {
      return opened;
    },
    *open(): Operation<void> {
      if (description === undefined) {
        return;
      }
      if (!buffer.open || opened || opening) {
        throw new StaleInputError("The staged child receipt is not available.");
      }
      opening = true;
      const recorded: unknown = yield* scoped(function* () {
        const scope = yield* useScope();
        scope.set(DurableContext, parent);
        return yield createDurableOperation(description, function* () {
          return { child: childId };
        });
      });
      if (
        typeof recorded !== "object" ||
        recorded === null ||
        Object.keys(recorded).join(",") !== "child" ||
        Reflect.get(recorded, "child") !== childId
      ) {
        throw new StaleInputError("The staged child identity changed.");
      }
      opened = true;
    },
    children: stagingFactory(context),
    *bind(): Operation<void> {
      if (!buffer.open || !entered) {
        throw new StaleInputError("The staged projection is not active.");
      }
      const frame = yield* useScope();
      frame.set(DurableContext, context);
    },
    *run<T>(body: () => Operation<T>): Operation<T> {
      if (!buffer.open || !opened || entered || close !== undefined) {
        throw new StaleInputError("The staged child transfer is not available.");
      }
      entered = true;
      let clean = true;
      try {
        return yield* scoped(function* () {
          const projection = yield* useScope();
          projection.set(DurableContext, context);
          return yield* body();
        });
      } catch (error) {
        clean = false;
        failure = error;
        throw error;
      } finally {
        settled = clean;
      }
    },
    *finish(value: Json, publish: boolean): Operation<void> {
      if (!buffer.open || !opened || (entered && !settled) || finished || close !== undefined) {
        throw new StaleInputError("The staged child has not settled.");
      }
      finished = true;
      const failure = activeDurabilityFailure(context);
      if (failure !== undefined) {
        throw failure;
      }
      if (index.firstUnaligned(childId) !== undefined) {
        throw new StaleInputError("The staged child did not consume its retained history.");
      }
      // Publication uses the parent's real append path, preserving an enclosing
      // stage and its quota. A partially flushed child remains retained history.
      if (publish) {
        for (const event of buffer.events) {
          yield* scoped(() => appendDurableEvent(parent, event));
        }
      }
      yield* scoped(() =>
        appendDurableEvent(parent, {
          type: "close",
          coroutineId: childId,
          result: { status: "ok", value },
        }),
      );
      stage.close();
    },
    close(): void {
      buffer.open = false;
      buffer.events.length = 0;
      revokeStagingOwner(context);
    },
  });
  yield* ensure(stage.close);
  return stage;
}
