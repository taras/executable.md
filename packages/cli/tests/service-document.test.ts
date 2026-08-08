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

const fixture = new URL("./fixtures/cooperative-service.mjs", import.meta.url).pathname;

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
          componentDirs: ["components", "."],
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

describe("cooperative service document integration", () => {
  beforeAll(() => useTempFileCompiler());

  it("reconstructs a real service on partial replay and skips completed replay", function* () {
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

  it("supervises a ready service that exits during projected content without restarting it", function* () {
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

  it("fails projected content promptly, tears down retained services, and does not restart", function* () {
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

  it("tears down nested provider services from inner lifetime to outer lifetime", function* () {
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
