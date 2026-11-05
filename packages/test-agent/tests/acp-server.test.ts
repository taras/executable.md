/**
 * Tier WA — ACP server lifecycle (packages/test-agent/src/worker/acp-server.ts):
 * the byte transport is injectable, so this drives serveAcp with an in-memory
 * transport it fully controls. Closing the input stream while a prompt handler
 * is in flight must complete the serving operation and settle the pending
 * handler — the connection closes on input EOF and its scope teardown halts the
 * in-flight op, so nothing is stranded.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { serveAcp } from "../src/worker/acp-server.ts";
import type { TurnResult, WorkerAgent } from "../src/worker/acp-server.ts";

interface RpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An in-memory ACP client: one request at a time, answered in order. */
function* useServedWorker(
  worker: WorkerAgent,
): Operation<(method: string, params: unknown) => Operation<RpcResponse>> {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let buffered = "";
  let waiting: ((response: RpcResponse) => void) | undefined;
  const decoder = new TextDecoder();
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      buffered += decoder.decode(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message: unknown = JSON.parse(line);
        if (isRecord(message) && typeof message.id === "number" && waiting) {
          const response: RpcResponse = { id: message.id };
          if (isRecord(message.result)) {
            response.result = message.result;
          }
          const error = message.error;
          if (isRecord(error) && typeof error.code === "number") {
            response.error = { code: error.code, message: String(error.message) };
          }
          const resolve = waiting;
          waiting = undefined;
          resolve(response);
        }
      }
    },
  });
  yield* spawn(() => serveAcp(worker, { input, output }));
  yield* ensure(() => {
    try {
      controller?.close();
    } catch {
      // already closed
    }
  });
  const encoder = new TextEncoder();
  let nextId = 1;
  return function* request(method: string, params: unknown): Operation<RpcResponse> {
    const reply = withResolvers<RpcResponse>();
    waiting = reply.resolve;
    controller?.enqueue(
      encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) + "\n"),
    );
    return yield* reply.operation;
  };
}

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
      identity() {
        return { acpSessionId: "acp-server-test", nativeSessionId: "native-acp-server-test" };
      },
      // deno-lint-ignore require-yield
      *startSession(): Operation<void> {},
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

  it("WA2: session/load accepts only this conversation's names and reports its native identity", function* () {
    const established: Array<string | undefined> = [];
    let configured = 0;
    const worker: WorkerAgent = {
      // deno-lint-ignore require-yield
      *ready() {},
      identity() {
        return { acpSessionId: "acp-1", nativeSessionId: "native-1" };
      },
      // deno-lint-ignore require-yield
      *startSession(instructions): Operation<void> {
        established.push(instructions);
      },
      // deno-lint-ignore require-yield
      *configuration() {
        configured++;
        return undefined;
      },
      // deno-lint-ignore require-yield
      *runTurn(): Operation<TurnResult> {
        throw new Error("no turn is taken here");
      },
      cancel() {},
    };
    const request = yield* useServedWorker(worker);
    yield* request("initialize", { protocolVersion: 1, clientCapabilities: {} });

    const created = yield* request("session/new", { cwd: "/", mcpServers: [] });
    expect(created.result).toEqual({ sessionId: "acp-1", _meta: { agentSessionId: "native-1" } });

    for (const target of ["acp-1", "native-1"]) {
      const loaded = yield* request("session/load", {
        sessionId: target,
        cwd: "/",
        mcpServers: [],
      });
      expect(loaded.result).toEqual({ _meta: { agentSessionId: "native-1" } });
    }
    expect(established.length).toBe(3);
    expect(configured).toBe(3);

    for (const target of ["acp-2", "native-2", ""]) {
      const refused = yield* request("session/load", {
        sessionId: target,
        cwd: "/",
        mcpServers: [],
        _meta: { systemPrompt: "refused layer" },
      });
      expect(refused.result).toBe(undefined);
      expect(refused.error?.code).toBe(-32602);
    }
    const malformed = yield* request("session/load", { cwd: "/", mcpServers: [] });
    expect(malformed.result).toBe(undefined);
    expect(malformed.error).toBeDefined();
    // Nothing was established, reported or read for a refused target.
    expect(established.length).toBe(3);
    expect(configured).toBe(3);

    const reloaded = yield* request("session/load", {
      sessionId: "acp-1",
      cwd: "/",
      mcpServers: [],
    });
    expect(reloaded.result).toEqual({ _meta: { agentSessionId: "native-1" } });
  });
});
