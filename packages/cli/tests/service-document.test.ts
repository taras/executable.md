import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { when } from "@effectionx/converge";
import { once } from "@effectionx/node/events";
import { timebox } from "@effectionx/timebox";
import { race, resource, scoped, sleep, type Operation } from "effection";
import { createServer } from "node:http";
import process from "node:process";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, execute, InvocationTeardownError, useTempFileCompiler } from "@executablemd/core";
import { SERVICE_HOSTNAME, ServiceUnexpectedExitError } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { inheritedEnvironment, installHostService } from "../src/service-host.ts";

const fixture = new URL("./fixtures/attached-service.mjs", import.meta.url).pathname;

function command(mode: string, nonce: string): string {
  return `node ${JSON.stringify(fixture)} ${mode} ${nonce}`;
}

const SAMPLE = `---
meta:
  componentName: Sample
props:
  type: object
  properties: {}
  additionalProperties: false
---

\`\`\`js persist eval
const result = yield* Sample.operations.sample({ content: "", componentName: "Sample" });
return result;
\`\`\`
`;

const PROVIDER = `---
meta:
  componentName: Provider
---

\`\`\`bash service=server exec
${command("normal", "document")}
\`\`\`

\`\`\`js persist ephemeral eval
const endpoint = server;
yield* Sample.around({
  *sample() {
    const response = yield* fetch(\`http://\${endpoint.hostname}:\${endpoint.port}\`).expect();
    return \`\${yield* response.text()}:\${endpoint.port}\`;
  },
});
\`\`\`

<Content />
`;

function* runDocument(stream: InMemoryStream): Operation<string> {
  return String(
    yield* scoped(function* () {
      return yield* collect(
        yield* execute({
          path: "doc.md",
          stream,
          includes: ["components", "."],
        }),
      );
    }),
  );
}

function responsePort(output: string): number {
  const match = /service:document:(\d+)/.exec(output);
  if (!match) {
    throw new Error(`service response missing from output: ${output}`);
  }
  return Number(match[1]);
}

function occupy(port: number): Operation<void> {
  return resource(function* (provide) {
    const server = createServer((_request, response) => response.end("foreign"));
    const listening = once(server, "listening");
    const failed = once<[Error]>(server, "error");
    server.listen(port, SERVICE_HOSTNAME);
    yield* race([
      listening,
      (function* () {
        const [error] = yield* failed;
        throw error;
      })(),
    ]);
    try {
      yield* provide();
    } finally {
      server.close();
    }
  });
}

function fixturePids(stderr: string[]): number[] {
  return [...stderr.join("").matchAll(/service pid:(\d+)/g)].map((match) => Number(match[1]));
}

function fixtureEndpoints(stderr: string[]): Array<{
  nonce: string;
  hostname: string;
  port: number;
}> {
  return [...stderr.join("").matchAll(/service endpoint:([^:\n]+):([^:\n]+):(\d+)/g)].map(
    (match) => {
      const [, nonce, hostname, port] = match;
      if (nonce === undefined || hostname === undefined || port === undefined) {
        throw new Error("malformed attached-service endpoint log");
      }
      return { nonce, hostname, port: Number(port) };
    },
  );
}

function endpointAt(
  endpoints: Array<{ nonce: string; hostname: string; port: number }>,
  index: number,
): { nonce: string; hostname: string; port: number } {
  const endpoint = endpoints[index];
  if (endpoint === undefined) {
    throw new Error(`missing attached-service endpoint at index ${index}`);
  }
  return endpoint;
}

function containsEndpoint(value: unknown, endpoint: { hostname: string; port: number }): boolean {
  if (typeof value === "string") {
    return value.includes(`${endpoint.hostname}:${endpoint.port}`);
  }
  if (Array.isArray(value)) {
    return value.some((member) => containsEndpoint(member, endpoint));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    "hostname" in value &&
    "port" in value &&
    value.hostname === endpoint.hostname &&
    value.port === endpoint.port
  ) {
    return true;
  }
  return Object.values(value).some((member) => containsEndpoint(member, endpoint));
}

function expectPingPongJournal(
  stream: InMemoryStream,
  tokens: string[],
  endpoints: Array<{ nonce: string; hostname: string; port: number }>,
): void {
  const journal = JSON.stringify(stream.snapshot());
  expect(journal).toContain("ping→pong→ping");
  for (const forbidden of [
    "XMD_SERVICE_READY",
    "service pid:",
    "service endpoint:",
    "service request:",
    "service stdout",
    "service stderr",
    "service stopping:",
  ]) {
    expect(journal).not.toContain(forbidden);
  }
  for (const token of tokens) {
    expect(journal).not.toContain(token);
  }
  for (const endpoint of endpoints) {
    expect(containsEndpoint(stream.snapshot(), endpoint)).toBe(false);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function* expectGone(pids: number[]): Operation<void> {
  const result = yield* timebox(2_000, () =>
    when(function* () {
      if (pids.some(isAlive)) {
        throw new Error("service child has not exited yet");
      }
    }),
  );
  expect(result.timeout).toBe(false);
}

function hasUnexpectedExit(error: unknown): boolean {
  if (error instanceof ServiceUnexpectedExitError) {
    return true;
  }
  if (error instanceof AggregateError) {
    return error.errors.some(hasUnexpectedExit);
  }
  if (error instanceof InvocationTeardownError) {
    return error.causes.some(hasUnexpectedExit);
  }
  return error instanceof Error && error.cause !== undefined && hasUnexpectedExit(error.cause);
}

describe("attached service document integration", () => {
  beforeAll(() => useTempFileCompiler());

  it("reconstructs a real attached service on partial replay and skips completed replay", function* () {
    const full = new InMemoryStream();
    let tokenCalls = 0;

    yield* scoped(function* () {
      yield* installHostService({
        token() {
          tokenCalls += 1;
          return tokenCalls.toString(16).padStart(64, "0");
        },
        environment: () => inheritedEnvironment(process.env),
        stdout() {},
        stderr() {},
      });
      yield* useStubFs({
        "doc.md": "<Provider><Sample /></Provider>\n",
        "components/Provider.md": PROVIDER,
        "components/Sample.md": SAMPLE,
      });

      const first = yield* runDocument(full);
      const firstPort = responsePort(first);
      expect(tokenCalls).toBe(1);
      const journal = JSON.stringify(full.snapshot());
      expect(journal).not.toContain("service stdout");
      expect(journal).not.toContain("service stderr");
      expect(journal).not.toContain("XMD_SERVICE_READY");
      expect(journal).not.toContain(
        "0000000000000000000000000000000000000000000000000000000000000001",
      );

      yield* occupy(firstPort);
      const events = full.snapshot();
      const firstYield = events.findIndex((event) => event.type === "yield");
      const partial = new InMemoryStream(events.slice(0, firstYield + 1));
      const resumed = yield* runDocument(partial);

      expect(responsePort(resumed)).not.toBe(firstPort);
      expect(resumed).not.toContain("foreign");
      expect(tokenCalls).toBe(2);

      const completed = yield* runDocument(full);
      expect(completed).toBe(first);
      expect(tokenCalls).toBe(2);
    });
  });

  it("keeps a two-attachment ping-pong chain live across partial replay", function* () {
    const full = new InMemoryStream();
    const stderr: string[] = [];
    const tokens: string[] = [];

    yield* scoped(function* () {
      yield* installHostService({
        token() {
          const token = (tokens.length + 1).toString(16).padStart(64, "0");
          tokens.push(token);
          return token;
        },
        environment: () => inheritedEnvironment(process.env),
        stdout() {},
        stderr(bytes) {
          stderr.push(new TextDecoder().decode(bytes));
        },
      });
      yield* useStubFs({
        "doc.md": "<Provider><Sample /></Provider>\n",
        "components/Provider.md": `---
meta:
  componentName: Provider
---

\`\`\`bash service=ping exec
${command("ping-pong", "ping")}
\`\`\`

\`\`\`bash service=pong exec
${command("ping-pong", "pong")}
\`\`\`

\`\`\`js persist ephemeral eval
const pingEndpoint = ping;
const pongEndpoint = pong;
if (
  pingEndpoint.hostname === pongEndpoint.hostname &&
  pingEndpoint.port === pongEndpoint.port
) {
  throw new Error("ping and pong must have distinct endpoints");
}
yield* Sample.around({
  *sample() {
    const peerHostname = encodeURIComponent(pongEndpoint.hostname);
    const peerPort = encodeURIComponent(String(pongEndpoint.port));
    const response = yield* fetch(
      \`http://\${pingEndpoint.hostname}:\${pingEndpoint.port}/?peerHostname=\${peerHostname}&peerPort=\${peerPort}&origin=ping\`,
    ).expect();
    return yield* response.text();
  },
});
\`\`\`

<Content />
`,
        "components/Sample.md": SAMPLE,
      });

      const first = yield* runDocument(full);
      expect(first).toContain("ping→pong→ping");
      expect(tokens).toHaveLength(2);
      const firstEndpoints = fixtureEndpoints(stderr);
      expect(firstEndpoints).toHaveLength(2);
      expect(firstEndpoints.map(({ nonce }) => nonce)).toEqual(["ping", "pong"]);
      const firstPing = endpointAt(firstEndpoints, 0);
      const firstPong = endpointAt(firstEndpoints, 1);
      expect(firstPing.port).not.toBe(firstPong.port);
      expect(stderr.join("")).toContain("service request:ping");
      expect(stderr.join("")).toContain("service request:pong");
      yield* expectGone(fixturePids(stderr));

      expectPingPongJournal(full, tokens, firstEndpoints);

      yield* occupy(firstPing.port);
      yield* occupy(firstPong.port);
      const events = full.snapshot();
      const firstYield = events.findIndex((event) => event.type === "yield");
      const partial = new InMemoryStream(events.slice(0, firstYield + 1));
      const resumed = yield* runDocument(partial);

      expect(resumed).toBe(first);
      expect(tokens).toHaveLength(4);
      const allEndpoints = fixtureEndpoints(stderr);
      expect(allEndpoints).toHaveLength(4);
      const resumedEndpoints = allEndpoints.slice(2);
      expect(resumedEndpoints.map(({ nonce }) => nonce)).toEqual(["ping", "pong"]);
      const resumedPing = endpointAt(resumedEndpoints, 0);
      const resumedPong = endpointAt(resumedEndpoints, 1);
      expect(resumedPing.port).not.toBe(resumedPong.port);
      expect(resumedEndpoints.map(({ port }) => port)).not.toContain(firstPing.port);
      expect(resumedEndpoints.map(({ port }) => port)).not.toContain(firstPong.port);
      expect(stderr.join("").match(/service request:ping/g)).toHaveLength(2);
      expect(stderr.join("").match(/service request:pong/g)).toHaveLength(2);
      yield* expectGone(fixturePids(stderr));

      expectPingPongJournal(partial, tokens, allEndpoints);

      const completed = yield* runDocument(full);
      expect(completed).toBe(first);
      expect(tokens).toHaveLength(4);
      expect(fixtureEndpoints(stderr)).toHaveLength(4);
      expect(fixturePids(stderr)).toHaveLength(4);
    });
  });

  it("supervises an attached service that exits during projected content without restarting it", function* () {
    const stderr: string[] = [];
    let tokenCalls = 0;
    yield* scoped(function* () {
      yield* installHostService({
        token() {
          tokenCalls += 1;
          return tokenCalls.toString(16).padStart(64, "0");
        },
        environment: () => inheritedEnvironment(process.env),
        stdout() {},
        stderr(bytes) {
          stderr.push(new TextDecoder().decode(bytes));
        },
      });
      yield* useStubFs({
        "doc.md": "<Provider><Sample /></Provider>\n",
        "components/Provider.md": `---
meta:
  componentName: Provider
---

\`\`\`bash service=server exec
${command("exit-on-request", "projected-exit")}
\`\`\`

\`\`\`js persist ephemeral eval
const endpoint = server;
yield* Sample.around({
  *sample() {
    const response = yield* fetch(\`http://\${endpoint.hostname}:\${endpoint.port}\`).expect();
    const text = yield* response.text();
    yield* sleep(100);
    return text;
  },
});
\`\`\`

<Content />
`,
        "components/Sample.md": SAMPLE,
      });

      let failure: unknown;
      try {
        yield* runDocument(new InMemoryStream());
      } catch (error) {
        failure = error;
      }

      expect(stderr.join("")).toContain("service request:projected-exit");
      expect(hasUnexpectedExit(failure)).toBe(true);
      expect(tokenCalls).toBe(1);
    });
    yield* expectGone(fixturePids(stderr));
  });

  it("fails projected content promptly, tears down retained service attachments, and does not restart", function* () {
    const stderr: string[] = [];
    let tokenCalls = 0;
    yield* scoped(function* () {
      yield* installHostService({
        token() {
          tokenCalls += 1;
          return tokenCalls.toString(16).padStart(64, "0");
        },
        environment: () => inheritedEnvironment(process.env),
        stdout() {},
        stderr(bytes) {
          stderr.push(new TextDecoder().decode(bytes));
        },
      });
      yield* useStubFs({
        "doc.md": "<Output><Provider><Broken /></Provider></Output>\n",
        "components/Provider.md": `---
meta:
  componentName: Provider
---

\`\`\`bash service=firstServer exec
${command("normal", "first-retained")}
\`\`\`

\`\`\`bash service=secondServer exec
${command("normal", "second-retained")}
\`\`\`

<Content />
`,
        "components/Broken.md": `---
meta:
  componentName: Broken
---

\`\`\`js eval
throw new Error("projected content failure");
\`\`\`
`,
      });

      const outcome = yield* timebox(2_000, function* () {
        try {
          yield* runDocument(new InMemoryStream());
        } catch (error) {
          return error;
        }
        return undefined;
      });
      expect(outcome.timeout).toBe(false);
      if (outcome.timeout) {
        throw new Error("document failure did not complete promptly");
      }
      expect(String(outcome.value)).toContain("projected content failure");
      expect(tokenCalls).toBe(2);
      yield* sleep(50);
      expect(tokenCalls).toBe(2);
    });

    const pids = fixturePids(stderr);
    expect(pids).toHaveLength(2);
    expect(stderr.join("")).toContain("service stopping:first-retained");
    expect(stderr.join("")).toContain("service stopping:second-retained");
    yield* expectGone(pids);
  });

  it("tears down nested service attachments from inner lifetime to outer lifetime", function* () {
    const stderr: string[] = [];
    let tokenCalls = 0;
    yield* scoped(function* () {
      yield* installHostService({
        token() {
          tokenCalls += 1;
          return tokenCalls.toString(16).padStart(64, "0");
        },
        environment: () => inheritedEnvironment(process.env),
        stdout() {},
        stderr(bytes) {
          stderr.push(new TextDecoder().decode(bytes));
        },
      });
      yield* useStubFs({
        "doc.md": "<Outer><Inner>nested content</Inner></Outer>\n",
        "components/Outer.md": `---
meta:
  componentName: Outer
---

\`\`\`bash service=outerServer exec
${command("normal", "outer")}
\`\`\`

<Content />
`,
        "components/Inner.md": `---
meta:
  componentName: Inner
---

\`\`\`bash service=innerServer exec
${command("normal", "inner")}
\`\`\`

<Content />
`,
      });

      const output = yield* runDocument(new InMemoryStream());
      expect(output).toContain("nested content");
      expect(tokenCalls).toBe(2);
    });

    const log = stderr.join("");
    expect(log.indexOf("service stopping:inner")).toBeGreaterThan(-1);
    expect(log.indexOf("service stopping:outer")).toBeGreaterThan(
      log.indexOf("service stopping:inner"),
    );
    yield* expectGone(fixturePids(stderr));
  });
});
