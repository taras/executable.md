/** One-event APIs whose cleanup depends on the event arriving. */
import { action, ensure } from "effection";
import type { Operation } from "effection";
import { EventEmitter } from "node:events";
import { connect } from "node:net";

export function* waitForClose(): Operation<void> {
  const socket = connect(1234, "localhost");

  yield* action<void>((resolve) => {
    socket.once("close", () => resolve());
    return () => {};
  });
}

export function* waitForReady(): Operation<void> {
  const emitter = new EventEmitter();

  emitter.once("ready", handle);

  function handle() {}

  yield* ensure(() => {
    emitter.off("ready", handle);
  });
}

export function* watchTheDocument(): Operation<void> {
  const target = new EventTarget();

  target.addEventListener("ready", handle, { once: true });

  function handle() {}

  yield* ensure(() => {
    target.removeEventListener("ready", handle);
  });
}

export function* alsoOnceThroughAnAlias(): Operation<void> {
  const socket = connect(1234, "localhost");
  const alias = socket;

  alias.once("error", () => {});
}
