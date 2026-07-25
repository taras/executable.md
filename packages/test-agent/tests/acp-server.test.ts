/**
 * Tier WA — ACP server lifecycle (packages/test-agent/src/worker/acp-server.ts):
 * the byte transport is injectable, so this drives serveAcp with an in-memory
 * transport it fully controls. Closing the input stream while a prompt handler
 * is in flight must complete the serving operation and settle the pending
 * handler — the connection closes on input EOF and its scope teardown halts the
 * in-flight op, so nothing is stranded.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure, race, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { serveAcp } from "../src/worker/acp-server.ts";
import type { TurnResult, WorkerAgent } from "../src/worker/acp-server.ts";

describe("Tier WA — ACP server lifecycle", () => {
  it("WA1: closing the input stream settles an in-flight request", function* () {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const output = new WritableStream<Uint8Array>({
      write() {
        // responses are irrelevant to this test
      },
    });
    const encoder = new TextEncoder();
    const send = (message: unknown) => {
      controller?.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
    };

    const started = withResolvers<void>();
    let tornDown = false;
    const worker: WorkerAgent = {
      // deno-lint-ignore require-yield
      *ready() {},
      *runTurn(): Operation<TurnResult> {
        started.resolve();
        yield* ensure(() => {
          tornDown = true;
        });
        yield* suspend(); // block until the serving scope halts
        return { cancelled: false, text: "" };
      },
      cancel() {},
    };

    const serving = yield* spawn(() => serveAcp(worker, { input, output }));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "s", prompt: [{ type: "text", text: "go" }] },
    });
    yield* started.operation; // the prompt handler is in flight

    controller?.close(); // EOF on the input stream

    const outcome = yield* race([
      (function* (): Operation<string> {
        yield* serving;
        return "served-completed";
      })(),
      (function* (): Operation<string> {
        yield* sleep(2000);
        return "timeout";
      })(),
    ]);
    expect(outcome).toBe("served-completed");
    expect(tornDown).toBe(true);
  });
});
