/** Subscriptions whose cleanup does not release what they attached. */
import { ensure, resource, sleep } from "effection";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

export function* anonymousHandler(): Operation<void> {
  const server = createServer();

  server.on("connection", () => {});
}

export function* noCleanupAtAll(): Operation<void> {
  const server = createServer();
  const onConnection = () => {};

  server.on("connection", onConnection);
}

export function* differentEvent(): Operation<void> {
  const server = createServer();
  const onConnection = () => {};

  server.on("connection", onConnection);

  yield* ensure(() => {
    server.off("close", onConnection);
  });
}

export function* differentHandler(): Operation<void> {
  const server = createServer();
  const onConnection = () => {};
  const onClose = () => {};

  server.on("connection", onConnection);

  yield* ensure(() => {
    server.off("connection", onClose);
  });
}

export function* differentReceiver(): Operation<void> {
  const server = createServer();
  const other = createServer();
  const onConnection = () => {};

  server.on("connection", onConnection);

  yield* ensure(() => {
    other.off("connection", onConnection);
  });
}

export function* armedTooLate(): Operation<void> {
  const child = spawnChild("cat", []);
  const onExit = () => {};

  child.on("exit", onExit);

  yield* sleep(1);

  yield* ensure(() => {
    child.off("exit", onExit);
  });
}

export function* removesItselfOnly(): Operation<void> {
  const child = spawnChild("cat", []);
  const onExit = () => {
    child.off("exit", onExit);
  };

  child.on("exit", onExit);
}

export function* removesAfterASuspension(): Operation<void> {
  const child = spawnChild("cat", []);
  const onExit = () => {};

  child.on("exit", onExit);

  yield* ensure(function* () {
    yield* sleep(1);
    child.off("exit", onExit);
  });
}

export function* removesWithRemoveListener(): Operation<void> {
  const child = spawnChild("cat", []);
  const onExit = () => {};

  child.on("exit", onExit);

  yield* ensure(() => {
    child.removeListener("exit", onExit);
  });
}

export function* dynamicEventName(event: string): Operation<void> {
  const server = createServer();
  const onEvent = () => {};

  server.on(event, onEvent);

  yield* ensure(() => {
    server.off(event, onEvent);
  });
}

export function* aTryOpenedAfterASuspension(socket: Socket): Operation<void> {
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);

  socket.on("error", onError);

  yield* sleep(1);

  try {
    yield* sleep(1);
  } finally {
    socket.off("error", onError);
  }
}

export function* recordedButNeverDetached(): Operation<void> {
  const server = createServer();
  const closers = new Map<Socket, () => void>();

  const onConnection = (accepted: Socket): void => {
    const onClose = (): void => closers.delete(accepted);
    closers.set(accepted, onClose);
    accepted.on("close", onClose);
  };

  server.on("connection", onConnection);
  yield* ensure(() => {
    server.off("connection", onConnection);
    closers.clear();
  });
}

export function* detachedFromAnotherCollection(): Operation<void> {
  const server = createServer();
  const closers = new Map<Socket, () => void>();
  const others = new Map<Socket, () => void>();

  const onConnection = (accepted: Socket): void => {
    const onClose = (): void => closers.delete(accepted);
    closers.set(accepted, onClose);
    accepted.on("close", onClose);
  };

  server.on("connection", onConnection);
  yield* ensure(() => {
    server.off("connection", onConnection);
    for (const [socket, onClose] of others) {
      socket.off("close", onClose);
    }
  });
}

export function* mismatchedCapture(): Operation<void> {
  const target = new EventTarget();
  const onReady = () => {};

  target.addEventListener("ready", onReady, true);

  yield* ensure(() => {
    target.removeEventListener("ready", onReady);
  });
}

export function* cleanupBehindACondition(flag: boolean): Operation<void> {
  const server = createServer();
  const onConnection = () => {};

  server.on("connection", onConnection);

  if (flag) {
    yield* ensure(() => {
      server.off("connection", onConnection);
    });
  }
}

export function* cleanupInAnOuterOwner(): Operation<void> {
  const server = createServer();
  const onConnection = () => {};

  const subscribe = function* (): Operation<void> {
    server.on("connection", onConnection);
  };

  yield* subscribe();
  yield* ensure(() => {
    server.off("connection", onConnection);
  });
}

export function* recordedAfterASuspension(): Operation<void> {
  const closers = new Map<Socket, () => void>();
  const accepted = connect(1234, "localhost");
  const onClose = (): void => closers.delete(accepted);

  accepted.on("close", onClose);

  yield* sleep(1);

  closers.set(accepted, onClose);
  yield* ensure(() => {
    for (const [socket, handler] of closers) {
      socket.off("close", handler);
    }
  });
}

export function* recordedInAShadowedCollection(): Operation<void> {
  const server = createServer();
  const onConnection = (accepted: Socket): void => {
    const closers = new Map<Socket, () => void>();
    const onClose = (): void => closers.delete(accepted);
    accepted.on("close", onClose);
    closers.set(accepted, onClose);
  };
  const closers = new Map<Socket, () => void>();

  server.on("connection", onConnection);
  yield* ensure(() => {
    server.off("connection", onConnection);
    for (const [socket, onClose] of closers) {
      socket.off("close", onClose);
    }
  });
}

const ALWAYS = true;

export function* onceSpelledAsAString(): Operation<void> {
  const target = new EventTarget();
  const onReady = () => {};

  target.addEventListener("ready", onReady, { "once": true });

  yield* ensure(() => {
    target.removeEventListener("ready", onReady);
  });
}

export function* onceBoundToAConstant(): Operation<void> {
  const target = new EventTarget();
  const onReady = () => {};

  target.addEventListener("ready", onReady, { once: ALWAYS });

  yield* ensure(() => {
    target.removeEventListener("ready", onReady);
  });
}

export function useSocketObservers(): Operation<{ watch(port: number): Operation<void> }> {
  const observers = new Map<Socket, () => void>();

  return resource(function* (provide) {
    yield* ensure(() => {
      for (const [socket, onError] of observers) {
        socket.off("error", onError);
      }
      observers.clear();
    });

    yield* provide({
      *watch(port: number): Operation<void> {
        const socket = connect(port, "localhost");
        const onError = (): void => {};

        socket.on("error", onError);
        observers.set(socket, onError);
        yield* sleep(1);
      },
    });
  });
}

export function* ensureYieldedAfterTheSubscription(): Operation<void> {
  const server = createServer();
  const onConnection = () => {};

  server.on("connection", onConnection);
  yield* ensure(() => {
    server.off("connection", onConnection);
  });
}
