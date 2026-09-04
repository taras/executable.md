/** Values whose `on`, `once` and `addEventListener` are somebody else's. */
import { action as act, ensure as guard } from "effection";
import type { Operation } from "effection";
import { EventEmitter as NodeEmitter } from "node:events";
import { connect } from "./event-registration-not-net.ts";

const handle = () => {};

/** A router of this application's own, not an event source. */
const routes = {
  on(_path: string, _handler: () => void) {},
  once(_path: string, _handler: () => void) {},
};

export function* anApplicationRouter(): Operation<void> {
  routes.on("/health", handle);
  routes.once("/ready", handle);
}

export function* aBindingFromAnotherModule(): Operation<void> {
  const client = connect("postgres://localhost");
  client.on("notice", handle);
  client.once("end", handle);
}

/** Declared with `on` alone, which pairs with nothing. */
interface Unsubscribable {
  on(event: string, listener: () => void): unknown;
}

export function* anUnpairedInterface(stream: Unsubscribable): Operation<void> {
  stream.on("data", handle);
}

/** A class of the same name as the Node export, extending nothing. */
class EventEmitter {
  on(_event: string, _handler: () => void) {}
  once(_event: string, _handler: () => void) {}
}

export function* aShadowedConstructor(): Operation<void> {
  const emitter = new EventEmitter();
  emitter.on("ready", handle);
  emitter.once("ready", handle);
}

export function* aShadowedProcess(): Operation<void> {
  const process = { on: (_event: string, _handler: () => void) => {} };
  process.on("SIGINT", handle);
}

export function* aShadowedDomGlobal(): Operation<void> {
  const document = { addEventListener: (_event: string, _handler: () => void) => {} };
  document.addEventListener("click", handle);
}

export function* aParameterWithNoType(source: unknown): Operation<void> {
  (source as { on(event: string, handler: () => void): void }).on("data", handle);
}

export function* aReassignedBinding(): Operation<void> {
  let socket;
  socket = routes;
  socket.on("data", handle);
}

/**
 * `ensure` and `action` are resolved through their import, not their spelling,
 * so a renamed one still establishes the owner and its cleanup.
 */
export function* anAliasedEnsurePairs(): Operation<void> {
  const emitter = new NodeEmitter();
  let onReady: (() => void) | undefined;

  yield* guard(() => {
    if (onReady) {
      emitter.off("ready", onReady);
    }
  });

  onReady = () => {};
  emitter.on("ready", onReady);
}

export function nextReadyUnderAnAliasedAction(emitter: NodeEmitter): Operation<void> {
  return act<void>((resolve) => {
    const onReady = (): void => resolve();

    emitter.on("ready", onReady);
    return () => emitter.off("ready", onReady);
  });
}
