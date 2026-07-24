/**
 * ACP-on-stdio serving for `xmd test-agent` (specs/test-agent-spec.md
 * §Controller and worker). stdout carries only JSON-RPC lines; all
 * logging goes to stderr. The worker is stateless but advertises and
 * serves session/load: all state loads from the controller, so a load
 * simply reuses the prior session id over the rehydrated document.
 */

import { ensure, resource, until, useScope } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import process from "node:process";
import * as acp from "@agentclientprotocol/sdk";
import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";

export type TurnResult = { cancelled: true } | { cancelled: false; text: string };

export interface WorkerAgent {
  /** Resolves once the behavior document reached its first matcher. */
  ready(): Operation<void>;
  runTurn(text: string): Operation<TurnResult>;
  cancel(): void;
}

/** The byte transport the ACP connection is served over. */
export interface AcpByteStreams {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };

function extractText(prompt: ContentBlock[]): string {
  let text = "";
  for (const block of prompt) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

export function* serveAcp(worker: WorkerAgent, streams: AcpByteStreams): Operation<void> {
  const scope = yield* useScope();

  // The SDK awaits the handler's return. A scope.run task that throws raises
  // into the worker scope, so failures are trapped to a Result (task outcome
  // stays Ok — the worker survives) and re-surfaced as a rejection, which the
  // SDK maps to the JSON-RPC error. On halt the task's own future rejects, so
  // the returned promise always settles — no stranded handler.
  function handle<T>(op: () => Operation<T>): Promise<T> {
    return scope
      .run(function* (): Operation<Result<T>> {
        try {
          return { ok: true, value: yield* op() };
        } catch (error) {
          return { ok: false, error };
        }
      })
      .then((result) => {
        if (result.ok) {
          return result.value;
        }
        throw result.error;
      });
  }

  const connection = yield* useAcpConnection(worker, handle, streams);
  // Settles on EOF/error (which close the input stream, closing the
  // connection), explicit connection closure, and worker cancellation (this
  // scope halts, tearing the connection down).
  yield* until(connection.closed);
}

function useAcpConnection(
  worker: WorkerAgent,
  handle: <T>(op: () => Operation<T>) => Promise<T>,
  streams: AcpByteStreams,
): Operation<acp.AgentConnection> {
  return resource(function* (provide) {
    const connection = acp
      .agent({ name: "xmd-test-agent" })
      .onRequest("initialize", () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest("session/new", () =>
        handle(function* () {
          yield* worker.ready();
          return { sessionId: randomUUID() };
        }),
      )
      .onRequest("session/load", () =>
        handle(function* () {
          yield* worker.ready();
          return {};
        }),
      )
      .onRequest("session/prompt", (ctx) =>
        handle(function* (): Operation<PromptResponse> {
          const result = yield* worker.runTurn(extractText(ctx.params.prompt));
          if (result.cancelled) {
            return { stopReason: "cancelled" };
          }
          yield* until(
            ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: result.text },
              },
            }),
          );
          return { stopReason: "end_turn" };
        }),
      )
      .onNotification("session/cancel", () => {
        worker.cancel();
      })
      .connect(acp.ndJsonStream(streams.output, streams.input));

    yield* ensure(() => connection.close());
    yield* provide(connection);
  });
}

// The only process-coupled piece. Named handlers with explicit ownership:
// end/close close the input stream idempotently; error errors the input
// stream, which closes the SDK connection; teardown removes every owned
// listener. connection.closed resolves regardless of the close reason, so
// serveAcp completes normally on a transport error.
export function useProcessStdio(): Operation<AcpByteStreams> {
  return resource(function* (provide) {
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        process.stdout.write(chunk);
      },
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const onData = (chunk: Uint8Array) => controller?.enqueue(new Uint8Array(chunk));
    const closeInput = () => {
      try {
        controller?.close();
      } catch {
        // already closed — end and close may both fire
      }
    };
    const onEnd = () => closeInput();
    const onClose = () => closeInput();
    const onError = (error: Error) => {
      try {
        controller?.error(error);
      } catch {
        // already settled
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("close", onClose);
    process.stdin.on("error", onError);
    yield* ensure(() => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onClose);
      process.stdin.off("error", onError);
    });

    yield* provide({ input, output });
  });
}
