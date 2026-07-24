/**
 * ACP-on-stdio serving for `xmd test-agent` (specs/test-agent-spec.md
 * §Controller and worker). stdout carries only JSON-RPC lines; all
 * logging goes to stderr. The worker is stateless but advertises and
 * serves session/load: all state loads from the controller, so a load
 * simply reuses the prior session id over the rehydrated document.
 */

import { until, useScope } from "effection";
import type { Operation } from "effection";
import { randomUUID } from "node:crypto";
import process from "node:process";
import * as acp from "@agentclientprotocol/sdk";
import type { PromptResponse } from "@agentclientprotocol/sdk";

export type TurnResult = { cancelled: true } | { cancelled: false; text: string };

export interface WorkerAgent {
  /** Resolves once the behavior document reached its first matcher. */
  ready(): Operation<void>;
  runTurn(text: string): Operation<TurnResult>;
  cancel(): void;
}

function extractText(prompt: Array<{ type: string; text?: string }>): string {
  return prompt
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function* serveAcp(worker: WorkerAgent): Operation<void> {
  const scope = yield* useScope();

  // scope.run propagates a failed task into the whole worker scope, so
  // handler errors are transported through the promise instead — the
  // SDK turns the rejection into the JSON-RPC error for that request.
  function contain<T>(op: () => Operation<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      scope.run(function* () {
        try {
          resolve(yield* op());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      process.stdout.write(chunk);
    },
  });
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.once("end", () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  const stream = acp.ndJsonStream(input, output);

  acp
    .agent({ name: "xmd-test-agent" })
    .onRequest("initialize", () =>
      Promise.resolve({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }),
    )
    .onRequest("session/new", () =>
      contain(function* () {
        yield* worker.ready();
        return { sessionId: randomUUID() };
      }),
    )
    .onRequest("session/load", () =>
      contain(function* () {
        yield* worker.ready();
        return {};
      }),
    )
    .onRequest("session/prompt", (ctx) =>
      contain(function* (): Operation<PromptResponse> {
        const text = extractText(ctx.params.prompt);
        const result = yield* worker.runTurn(text);
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
    .connect(stream);

  yield* until(
    new Promise<void>((resolve) => {
      process.stdin.once("end", () => resolve());
      process.stdin.once("close", () => resolve());
    }),
  );
}
