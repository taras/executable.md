import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { once } from "@effectionx/node/events";
import { race, resource, scoped, type Operation } from "effection";
import { createServer } from "node:http";
import process from "node:process";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, execute, useTempFileCompiler } from "@executablemd/core";
import { SERVICE_HOSTNAME } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { inheritedEnvironment, installHostService } from "../src/service-host.ts";

const fixture = new URL("./fixtures/cooperative-service.mjs", import.meta.url).pathname;
const command = `node ${JSON.stringify(fixture)} normal document`;

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
${command}
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
});
