/**
 * `xmd test-agent` worker runtime (specs/test-agent-spec.md §Controller
 * and worker). The worker attaches to its controller, rehydrates the
 * behavior document and journal, and serves ACP on stdio.
 *
 * A stage's buffered durable-event suffix — everything through the next
 * suspension point or the final root Close — is forwarded and
 * acknowledged before the ACP result is returned; a crash inside that
 * final delivery window is outside the supported recovery guarantee.
 *
 * Cancellation is transactional from the controller journal's
 * perspective: a cancelled turn commits nothing — the scenario runtime
 * is halted and rebuilt from the last acknowledged journal before
 * another turn is accepted, so the next prompt re-enters the same
 * stage deterministically.
 */

import {
  createSignal,
  each,
  ensure,
  race,
  scoped,
  spawn,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Scope, Subscription, Task } from "effection";
import { connect } from "node:net";
import { RequestError } from "@agentclientprotocol/sdk";
import { Component, DocumentOutput, execute } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  createLineSplitter,
  encodeMessage,
  parseControllerMessage,
  parseRoute,
  PROBE_INSTANCE,
} from "../protocol.ts";
import type { ControllerMessage, WorkerMessage } from "../protocol.ts";
import { createTurnBridge, collectTurn } from "./bridge.ts";
import type { TemplateMatchResult } from "../template.ts";
import type { BridgeEvent } from "./bridge.ts";
import { installWhenPromptVocabulary } from "./when-prompt.ts";
import { installWorkerProfile } from "./profile.ts";
import { serveAcp } from "./acp-server.ts";
import type { TurnResult } from "./acp-server.ts";

interface ControllerClient {
  send(message: WorkerMessage): void;
  next(): Operation<ControllerMessage>;
}

interface Waiter {
  resolve(message: ControllerMessage): void;
  reject(error: Error): void;
}

/**
 * Controller-connection failure is terminal: a socket close or error,
 * or a malformed inbound line, rejects every pending and future next()
 * so nothing above ever hangs on a dead controller.
 */
function* useControllerClient(host: string, port: number): Operation<ControllerClient> {
  const socket = connect(port, host);
  const messages = createSignal<ControllerMessage, undefined>();
  const splitter = createLineSplitter();
  const queue: ControllerMessage[] = [];
  const waiters: Waiter[] = [];
  let failure: Error | undefined;

  const fail = (error: Error) => {
    if (!failure) {
      failure = error;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
      messages.close(undefined);
      socket.destroy();
    }
  };

  socket.on("data", (chunk: Buffer) => {
    for (const line of splitter.feed(chunk.toString("utf8"))) {
      const parsed = parseControllerMessage(line);
      if (parsed.ok) {
        messages.send(parsed.message);
      } else {
        fail(new Error(parsed.error));
      }
    }
  });
  socket.on("close", () => fail(new Error("controller connection closed")));
  socket.on("error", (error: Error) => fail(error));
  yield* ensure(() => {
    socket.destroy();
  });
  yield* until(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    }),
  );
  yield* spawn(function* () {
    for (const message of yield* each(messages)) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(message);
      } else {
        queue.push(message);
      }
      yield* each.next();
    }
  });
  return {
    send(message) {
      socket.write(encodeMessage(message));
    },
    *next() {
      const queued = queue.shift();
      if (queued) {
        return queued;
      }
      if (failure) {
        throw failure;
      }
      return yield* until(
        new Promise<ControllerMessage>((resolve, reject) => {
          waiters.push({ resolve, reject });
        }),
      );
    },
  };
}

interface ScenarioRuntime {
  task: Task<void>;
  turnEvents: Subscription<BridgeEvent, never>;
  ready: Operation<void>;
  offer(text: string): Operation<TemplateMatchResult>;
  flush(): Operation<void>;
  isExhausted(): boolean;
  markExhausted(): void;
}

export function* runTestAgentWorker(options: { connect: string }): Operation<void> {
  const route = parseRoute(options.connect);
  if (!route.ok) {
    throw new Error(route.error);
  }
  const { host, port, token, instance } = route.message;
  const client = yield* useControllerClient(host, port);
  client.send({ t: "attach", token, instance });
  const config = yield* client.next();
  if (config.t === "error") {
    throw new Error(`controller rejected this worker: ${config.message}`);
  }
  if (config.t !== "config") {
    throw new Error(`unexpected controller message "${config.t}" before config`);
  }

  if (instance === PROBE_INSTANCE || config.mode !== "scenario") {
    yield* serveAcp({
      // deno-lint-ignore require-yield
      *ready() {
        throw new Error("probe workers only initialize; they never start a behavior document");
      },
      // deno-lint-ignore require-yield
      *runTurn(): Operation<TurnResult> {
        throw new Error("probe workers do not serve prompts");
      },
      cancel() {},
    });
    return;
  }

  const scenario = config;
  // The worker-side mirror of the controller's journal: only events the
  // controller has acknowledged. Cancellation rebuilds from exactly
  // this list.
  const acked: DurableEvent[] = [...scenario.journal];
  const workerScope: Scope = yield* useScope();

  function* startRuntime(): Operation<ScenarioRuntime> {
    const snapshot = acked.slice();
    const bridge = createTurnBridge();
    // The subscription must live in the runtime task's scope — restart
    // is invoked from short-lived ACP request tasks, and a subscription
    // created there would die with its request and silently drop
    // events.
    const subscription = withResolvers<Subscription<BridgeEvent, never>>();
    const readiness = withResolvers<void>();
    const pending: DurableEvent[] = [];
    let exhausted = false;

    function* flush(): Operation<void> {
      while (pending.length > 0) {
        const event = pending.shift()!;
        const seq = acked.length;
        client.send({ t: "journal", seq, event });
        const reply = yield* client.next();
        if (reply.t !== "ack" || reply.seq !== seq) {
          throw new Error(`controller did not acknowledge journal event ${seq}`);
        }
        acked.push(event);
      }
    }

    const task = yield* workerScope.spawn(() =>
      scoped(function* () {
        const turnEvents = yield* bridge.events;
        subscription.resolve(turnEvents);
        const stream = new InMemoryStream();
        for (const event of snapshot) {
          yield* stream.append(event);
        }
        stream.onAppend = (event: DurableEvent) => {
          pending.push(event);
        };

        // The root behavior document executes from the source snapshot
        // captured at scenario declaration — changing or removing the
        // file afterwards never affects an already-declared scenario.
        // Markdown dependencies still resolve on demand through the
        // controller.
        yield* installWorkerProfile({
          *read(path) {
            if (path === scenario.doc.path) {
              return scenario.doc.source;
            }
            client.send({ t: "read", path });
            const reply = yield* client.next();
            if (reply.t !== "read") {
              throw new Error(`unexpected controller reply "${reply.t}" to read`);
            }
            return reply.missing ? undefined : reply.source;
          },
          *stat(path) {
            if (path === scenario.doc.path) {
              return { exists: true, isFile: true, isDirectory: false };
            }
            client.send({ t: "stat", path });
            const reply = yield* client.next();
            if (reply.t !== "stat") {
              throw new Error(`unexpected controller reply "${reply.t}" to stat`);
            }
            return { exists: reply.exists, isFile: reply.isFile, isDirectory: false };
          },
        });
        yield* installWhenPromptVocabulary(bridge);
        // Behavior-document errors — eval preflight rejections,
        // unsupported components, matcher configuration — must fail the
        // scenario, never render as comments and let the turn succeed.
        yield* Component.around({
          // deno-lint-ignore require-yield
          *raise([segment]) {
            throw new Error(segment.message);
          },
        });
        yield* DocumentOutput.around({
          *output([text], next) {
            yield* bridge.events.send({ kind: "output", text });
            yield* next(text);
          },
        });

        const execution = yield* execute({ docPath: scenario.doc.path, stream });
        yield* spawn(function* () {
          const result = yield* execution;
          if (result.ok) {
            yield* bridge.events.send({ kind: "eof" });
          } else {
            yield* bridge.events.send({ kind: "failed", error: result.error.message });
          }
        });

        // Initialization: replay/expand to the first live matcher,
        // persist the pre-matcher events, and only then report
        // readiness.
        yield* spawn(function* () {
          const initial = yield* collectTurn(turnEvents);
          if (initial.end === "failed") {
            client.send({ t: "fatal", message: initial.error ?? "behavior document failed" });
            readiness.reject(new RequestError(-32603, initial.error ?? "behavior document failed"));
            return;
          }
          // Rehydrated runtimes replay completed stages, so their
          // re-rendered output reaches the init collector; the fresh
          // run already validated the pre-matcher region.
          const rehydrated = snapshot.length > 0;
          if (!rehydrated && initial.text.trim().length > 0) {
            const message =
              "behavior documents must not render non-whitespace output before the first <WhenPrompt>";
            client.send({ t: "turn-failure", kind: "config", actual: initial.text });
            readiness.reject(new RequestError(-32603, message));
            return;
          }
          if (initial.end === "eof") {
            exhausted = true;
          }
          yield* flush();
          readiness.resolve();
        });

        yield* suspend();
      }),
    );

    const turnEvents = yield* subscription.operation;
    return {
      task,
      turnEvents,
      ready: readiness.operation,
      offer: (text) => bridge.offer(text),
      flush,
      isExhausted: () => exhausted,
      markExhausted: () => {
        exhausted = true;
      },
    };
  }

  let current = yield* startRuntime();
  let cancelRequested: (() => void) | undefined;

  function* restart(): Operation<void> {
    yield* current.task.halt();
    current = yield* startRuntime();
    yield* current.ready;
  }

  yield* serveAcp({
    *ready() {
      yield* current.ready;
    },
    *runTurn(text): Operation<TurnResult> {
      if (current.isExhausted()) {
        client.send({ t: "turn-failure", kind: "exhausted", actual: text });
        throw new RequestError(-32603, `scenario exhausted: no stage remains for prompt: ${text}`);
      }
      const runtime = current;
      const cancellation = withResolvers<TurnResult>();
      cancelRequested = () => cancellation.resolve({ cancelled: true });
      try {
        const outcome = yield* race([
          cancellation.operation,
          (function* (): Operation<TurnResult> {
            const match = yield* runtime.offer(text);
            if (!match.ok) {
              const failure: WorkerMessage = {
                t: "turn-failure",
                kind: match.kind === "config" ? "config" : "mismatch",
                actual: match.actual,
              };
              if (match.kind === "mismatch") {
                failure.expected = match.expected;
              }
              client.send(failure);
              throw new RequestError(-32603, match.message);
            }
            const collected = yield* collectTurn(runtime.turnEvents);
            if (collected.end === "failed") {
              client.send({
                t: "fatal",
                message: collected.error ?? "behavior document failed",
              });
              throw new RequestError(-32603, collected.error ?? "behavior document failed");
            }
            if (collected.end === "eof") {
              runtime.markExhausted();
            }
            yield* runtime.flush();
            return { cancelled: false, text: collected.text };
          })(),
        ]);
        if (outcome.cancelled) {
          yield* restart();
        }
        return outcome;
      } finally {
        cancelRequested = undefined;
      }
    },
    cancel() {
      if (cancelRequested) {
        cancelRequested();
      }
    },
  });
}
