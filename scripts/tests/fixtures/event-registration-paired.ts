/** The four teardown shapes that release a listener with its owner. */
import { action, ensure, resource, withResolvers } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node/events";
import { spawn as spawnChild } from "node:child_process";
import { createServer } from "node:net";
import type { Socket } from "node:net";

export function* finallyAroundTheSubscription(child = spawnChild("cat", [])): Operation<string> {
  const chunks: string[] = [];
  const onData = (chunk: string) => chunks.push(chunk);

  try {
    child.stdout.on("data", onData);
    yield* action<void>((resolve) => {
      const onExit = () => resolve();
      child.on("exit", onExit);
      return () => child.off("exit", onExit);
    });
  } finally {
    child.stdout.off("data", onData);
  }

  return chunks.join("");
}

export function* ensureEstablishedBeforeTheSubscription(): Operation<void> {
  const server = createServer();
  const accepted: Socket[] = [];
  let onConnection: ((socket: Socket) => void) | undefined;

  yield* ensure(() => {
    if (onConnection) {
      server.off("connection", onConnection);
    }
  });

  onConnection = (socket: Socket) => accepted.push(socket);
  server.on("connection", onConnection);

  yield* once(server, "listening");
}

export function* listenerDependentTeardown(): Operation<void> {
  const server = createServer();

  // The wait needs a listener, so the cleanup attaches its own rather than
  // depending on one the body established: registering it here and pairing it
  // in this same frame's `finally` is what makes the whole thing atomic.
  yield* ensure(function* () {
    const closed = withResolvers<void>();
    const onClose = () => closed.resolve();

    server.on("close", onClose);
    try {
      server.close();
      yield* closed.operation;
    } finally {
      server.off("close", onClose);
    }
  });

  yield* once(server, "listening");
}

export function useSocketErrors(socket: Socket): Operation<Error[]> {
  return resource(function* (provide) {
    const errors: Error[] = [];
    let onError: ((error: Error) => void) | undefined;

    yield* ensure(() => {
      if (onError) {
        socket.off("error", onError);
      }
    });

    onError = (error: Error) => errors.push(error);
    socket.on("error", onError);

    yield* provide(errors);
  });
}

export function nextMessage(port: MessagePort): Operation<unknown> {
  return action<unknown>((resolve) => {
    const onMessage = (event: MessageEvent) => resolve(event.data);

    port.addEventListener("message", onMessage);
    return () => port.removeEventListener("message", onMessage);
  });
}

export function nextCapturedClick(target: EventTarget): Operation<void> {
  return action<void>((resolve) => {
    const onClick = () => resolve();

    target.addEventListener("click", onClick, true);
    return () => target.removeEventListener("click", onClick, true);
  });
}

export function* theTryCoversASubscriptionJustBeforeIt(socket: Socket): Operation<void> {
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);

  socket.on("error", onError);
  try {
    yield* once(socket, "close");
  } finally {
    socket.off("error", onError);
  }
}

export function* aCollectionIsThePairingForOnePerConnection(): Operation<void> {
  const server = createServer();
  const closers = new Map<Socket, () => void>();

  let onConnection: ((accepted: Socket) => void) | undefined;

  yield* ensure(function* () {
    if (onConnection) {
      server.off("connection", onConnection);
    }
    for (const [socket, onClose] of closers) {
      socket.off("close", onClose);
    }
    closers.clear();
    yield* once(server, "close");
  });

  onConnection = (accepted: Socket): void => {
    const onClose = (): void => closers.delete(accepted);
    closers.set(accepted, onClose);
    accepted.on("close", onClose);
  };
  server.on("connection", onConnection);

  yield* once(server, "listening");
}

export function* theCorrectedHelperIsTheOneEventWait(socket: Socket): Operation<void> {
  yield* once(socket, "close");
}
