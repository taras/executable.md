/**
 * Tier U — callLlamafile() unit tests (spec §7, Tier U).
 *
 * Uses a real Node HTTP server (as an Effection resource) that mocks
 * the OpenAI-compatible /v1/chat/completions endpoint.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import * as http from "node:http";
import { resource, race } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node";
import { findFreePort } from "../src/find-free-port.ts";
import {
  callLlamafile,
  buildDefaultMessages,
} from "../src/sample/llamafile.ts";
import type { SampleContext } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Mock server resource
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface MockServer {
  port: number;
  baseUrl: string;
  lastRequest(): CapturedRequest | null;
}

/**
 * Effection resource that starts a mock /v1/chat/completions server.
 * The server is torn down when the enclosing scope exits.
 */
function useMockServer(
  responseBody: unknown = { choices: [{ message: { content: "mock-response" } }] },
  statusCode = 200,
): Operation<MockServer> {
  return resource<MockServer>(function* (provide) {
    const port = yield* findFreePort();
    let captured: CapturedRequest | null = null;

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        captured = {
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body,
        };
        res.writeHead(statusCode, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(responseBody));
      });
    });

    const listening = once(server, "listening");
    const error = once<[Error]>(server, "error");

    server.listen(port, "127.0.0.1");

    const rethrowError: Operation<never> = {
      *[Symbol.iterator]() {
        const [err] = yield* error;
        throw err;
      },
    } as Operation<never>;

    yield* race([listening, rethrowError]);

    try {
      yield* provide({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        lastRequest: () => captured,
      });
    } finally {
      server.close();
    }
  });
}

function makeSampleContext(
  overrides: Partial<SampleContext> = {},
): SampleContext {
  return {
    stdout: "test output",
    stderr: "",
    exitCode: 0,
    command: "echo hello",
    language: "bash",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tier U — callLlamafile()", () => {
  // U1: Request sent to correct URL
  it("U1: request sent to correct URL", function* () {
    const mock = yield* useMockServer();
    yield* callLlamafile(mock.baseUrl, "test-model", makeSampleContext());

    const req = mock.lastRequest();
    expect(req).not.toBeNull();
    expect(req!.method).toBe("POST");
    expect(req!.url).toBe("/v1/chat/completions");
  });

  // U2: model in request body
  it("U2: model in request body", function* () {
    const mock = yield* useMockServer();
    yield* callLlamafile(mock.baseUrl, "phi3-mini", makeSampleContext());

    const reqBody = JSON.parse(mock.lastRequest()!.body);
    expect(reqBody.model).toBe("phi3-mini");
  });

  // U3: temperature and maxTokens in request body
  it("U3: temperature and maxTokens in request body", function* () {
    const mock = yield* useMockServer();
    yield* callLlamafile(mock.baseUrl, "test-model", makeSampleContext(), {
      temperature: 0.5,
      maxTokens: 512,
    });

    const reqBody = JSON.parse(mock.lastRequest()!.body);
    expect(reqBody.temperature).toBe(0.5);
    expect(reqBody.max_tokens).toBe(512);
  });

  // U4: Default temperature is 0
  it("U4: default temperature is 0", function* () {
    const mock = yield* useMockServer();
    yield* callLlamafile(mock.baseUrl, "test-model", makeSampleContext());

    const reqBody = JSON.parse(mock.lastRequest()!.body);
    expect(reqBody.temperature).toBe(0);
    expect(reqBody.max_tokens).toBe(2048);
  });

  // U5: Custom buildMessages used
  it("U5: custom buildMessages used", function* () {
    const mock = yield* useMockServer();
    yield* callLlamafile(mock.baseUrl, "test-model", makeSampleContext(), {
      buildMessages: () => [
        { role: "system", content: "custom-system" },
        { role: "user", content: "custom-user" },
      ],
    });

    const reqBody = JSON.parse(mock.lastRequest()!.body);
    expect(reqBody.messages).toEqual([
      { role: "system", content: "custom-system" },
      { role: "user", content: "custom-user" },
    ]);
  });

  // U6: Non-ok response throws via expect()
  it("U6: non-ok response throws via expect()", function* () {
    const mock = yield* useMockServer(
      { error: "Internal Server Error" },
      500,
    );

    let threw = false;
    try {
      yield* callLlamafile(mock.baseUrl, "test-model", makeSampleContext());
    } catch (error) {
      threw = true;
      expect((error as Error).message).toMatch(/500/);
    }
    expect(threw).toBe(true);
  });

  // U7: Unexpected response shape throws
  it("U7: unexpected response shape throws", function* () {
    const mock = yield* useMockServer({ result: "no choices array" });

    let threw = false;
    try {
      yield* callLlamafile(mock.baseUrl, "test-model", makeSampleContext());
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("unexpected response shape");
    }
    expect(threw).toBe(true);
  });

  // U8: Response content returned as string
  it("U8: response content returned as string", function* () {
    const mock = yield* useMockServer({
      choices: [{ message: { content: "the answer is 42" } }],
    });

    const result = yield* callLlamafile(
      mock.baseUrl,
      "test-model",
      makeSampleContext(),
    );

    expect(result).toBe("the answer is 42");
  });
});

// ---------------------------------------------------------------------------
// buildDefaultMessages unit tests (U9-U12)
// ---------------------------------------------------------------------------

describe("Tier U — buildDefaultMessages()", () => {
  // U9: buildDefaultMessages includes command
  it("U9: includes command in user message", function* () {
    const messages = buildDefaultMessages(makeSampleContext());
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("echo hello");
  });

  // U10: buildDefaultMessages includes stderr
  it("U10: includes stderr in user message when non-empty", function* () {
    const messages = buildDefaultMessages(
      makeSampleContext({ stderr: "warning: something" }),
    );
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("warning: something");
    expect(userMsg!.content).toContain("Stderr:");
  });

  // U11: buildDefaultMessages includes params
  it("U11: includes params as Instruction in system prompt", function* () {
    const messages = buildDefaultMessages(
      makeSampleContext({ params: "summarize briefly" }),
    );
    const sysMsg = messages.find((m) => m.role === "system");
    expect(sysMsg!.content).toContain("Instruction: summarize briefly");
  });

  // U12: buildDefaultMessages includes componentName
  it("U12: includes componentName in system prompt", function* () {
    const messages = buildDefaultMessages(
      makeSampleContext({ componentName: "TestAnalyzer" }),
    );
    const sysMsg = messages.find((m) => m.role === "system");
    expect(sysMsg!.content).toContain("TestAnalyzer");
  });
});
