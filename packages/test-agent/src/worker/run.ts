/**
 * `xmd test-agent` worker runtime (specs/test-agent-spec.md §Controller
 * and worker). The worker attaches to its controller, rehydrates the
 * behavior document and journal, and serves ACP on stdio. A stage's
 * buffered durable-event suffix — everything through the next
 * suspension point or the final root Close — is forwarded and
 * acknowledged before the ACP result is returned; a crash inside that
 * final delivery window is outside the supported recovery guarantee.
 */

import { createSignal, each, ensure, race, scoped, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { connect } from "node:net";
import { DocumentOutput, execute } from "@executablemd/core";
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
import { installWhenPromptVocabulary } from "./when-prompt.ts";
import { installWorkerProfile } from "./profile.ts";
import { serveAcp } from "./acp-server.ts";
import type { TurnResult } from "./acp-server.ts";

interface ControllerClient {
  send(message: WorkerMessage): void;
  next(): Operation<ControllerMessage>;
}

function* useControllerClient(host: string, port: number): Operation<ControllerClient> {
  const socket = connect(port, host);
  const messages = createSignal<ControllerMessage, undefined>();
  const splitter = createLineSplitter();
  socket.on("data", (chunk: Buffer) => {
    for (const line of splitter.feed(chunk.toString("utf8"))) {
      const parsed = parseControllerMessage(line);
      if (parsed.ok) {
        messages.send(parsed.message);
      }
    }
  });
  socket.on("close", () => messages.close(undefined));
  yield* ensure(() => {
    socket.destroy();
  });
  yield* until(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    }),
  );
  const queue: ControllerMessage[] = [];
  const waiters: Array<(message: ControllerMessage) => void> = [];
  yield* spawn(function* () {
    for (const message of yield* each(messages)) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
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
      return yield* until(
        new Promise<ControllerMessage>((resolve) => {
          waiters.push(resolve);
        }),
      );
    },
  };
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

  if (instance === PROBE_INSTANCE || config.mode === "probe") {
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

  const stream = new InMemoryStream();
  for (const event of config.journal) {
    yield* stream.append(event);
  }
  const pending: DurableEvent[] = [];
  let forwarded = 0;
  stream.onAppend = (event: DurableEvent) => {
    pending.push(event);
  };

  function* flushJournal(): Operation<void> {
    while (pending.length > 0) {
      const event = pending.shift()!;
      const seq = forwarded;
      client.send({ t: "journal", seq, event });
      const reply = yield* client.next();
      if (reply.t !== "ack" || reply.seq !== seq) {
        throw new Error(`controller did not acknowledge journal event ${seq}`);
      }
      forwarded = seq + 1;
    }
  }

  const bridge = createTurnBridge();
  const turnEvents = yield* bridge.events;
  const readiness = withResolvers<void>();
  let exhausted = false;
  let cancelRequested: (() => void) | undefined;

  yield* scoped(function* () {
    yield* installWorkerProfile({
      *read(path) {
        client.send({ t: "read", path });
        const reply = yield* client.next();
        if (reply.t !== "read") {
          throw new Error(`unexpected controller reply "${reply.t}" to read`);
        }
        return reply.missing ? undefined : reply.source;
      },
      *stat(path) {
        client.send({ t: "stat", path });
        const reply = yield* client.next();
        if (reply.t !== "stat") {
          throw new Error(`unexpected controller reply "${reply.t}" to stat`);
        }
        return { exists: reply.exists, isFile: reply.isFile, isDirectory: false };
      },
    });
    yield* installWhenPromptVocabulary(bridge);
    yield* DocumentOutput.around({
      *output([text], next) {
        yield* bridge.events.send({ kind: "output", text });
        yield* next(text);
      },
    });

    const execution = yield* execute({ docPath: config.doc.path, stream });
    yield* spawn(function* () {
      const result = yield* execution;
      if (result.ok) {
        yield* bridge.events.send({ kind: "eof" });
      } else {
        yield* bridge.events.send({ kind: "failed", error: result.error.message });
      }
    });

    // Initialization: replay/expand to the first matcher, persist the
    // pre-matcher events, and only then report readiness.
    yield* spawn(function* () {
      const initial = yield* collectTurn(turnEvents);
      if (initial.end === "failed") {
        client.send({ t: "fatal", message: initial.error ?? "behavior document failed" });
        readiness.reject(new Error(initial.error ?? "behavior document failed"));
        return;
      }
      if (initial.text.trim().length > 0) {
        const message =
          "behavior documents must not render non-whitespace output before the first <WhenPrompt>";
        client.send({ t: "turn-failure", kind: "config", actual: initial.text });
        readiness.reject(new Error(message));
        return;
      }
      if (initial.end === "eof") {
        exhausted = true;
      }
      yield* flushJournal();
      readiness.resolve();
    });

    yield* serveAcp({
      *ready() {
        yield* readiness.operation;
      },
      *runTurn(text): Operation<TurnResult> {
        if (exhausted) {
          client.send({ t: "turn-failure", kind: "exhausted", actual: text });
          throw new Error(`scenario exhausted: no stage remains for prompt: ${text}`);
        }
        const cancellation = withResolvers<TurnResult>();
        cancelRequested = () => cancellation.resolve({ cancelled: true });
        try {
          const outcome = yield* race([
            cancellation.operation,
            (function* (): Operation<TurnResult> {
              const match = yield* bridge.offer(text);
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
                throw new Error(match.message);
              }
              const collected = yield* collectTurn(turnEvents);
              if (collected.end === "failed") {
                client.send({
                  t: "fatal",
                  message: collected.error ?? "behavior document failed",
                });
                throw new Error(collected.error ?? "behavior document failed");
              }
              if (collected.end === "eof") {
                exhausted = true;
              }
              yield* flushJournal();
              return { cancelled: false, text: collected.text };
            })(),
          ]);
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
  });
}
