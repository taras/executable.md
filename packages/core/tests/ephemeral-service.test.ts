import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { resource, scoped, type Operation } from "effection";
import {
  DivergenceError,
  InMemoryStream,
  serializeDurableEvent,
  TerminalDivergenceError,
} from "@executablemd/durable-streams";
import { API, SERVICE_HOSTNAME } from "@executablemd/runtime";
import type { ServiceEndpoint } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { applyModifiers } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { ComponentRegistration } from "../src/components/registration.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { LiveBindingCollisionError } from "../src/live-env.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";

const SAMPLE = `---
meta:
  componentName: Sample
props:
  type: object
  properties: {}
  additionalProperties: false
---

\`\`\`js persist eval
const sampleResult = yield* Sample.operations.sample({ content: "", componentName: "Sample" });
return sampleResult;
\`\`\`
`;

function* useServiceStub(
  endpoint: ServiceEndpoint,
  lifecycle: { starts: number; stops: number },
): Operation<void> {
  yield* API.Service.around(
    {
      *start() {
        return yield* resource(function* (provide) {
          lifecycle.starts += 1;
          try {
            yield* provide({ endpoint });
          } finally {
            lifecycle.stops += 1;
          }
        });
      },
    },
    { at: "min" },
  );
}

function* useTrackedExec(executions: string[]): Operation<void> {
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec([options]) {
      const script = (options.command[2] ?? "").trim();
      executions.push(script);
      return {
        exitCode: 0,
        stdout: script.startsWith("echo ") ? `${script.slice(5)}\n` : "",
        stderr: "",
      };
    },
  });
}

function changingProvider(attachService: boolean): ComponentRegistration {
  return {
    name: "ChangingProvider",
    origin: "ephemeral-service.test",
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn() {
      if (attachService) {
        yield* applyModifiers([{ name: "service", params: "server" }, { name: "exec" }], {
          language: "bash",
          content: "handshake-compatible-server",
          blockId: "changing-service",
          componentName: "ChangingProvider",
        });
      }
      yield* applyModifiers([{ name: "eval" }], {
        language: "js",
        content: 'const server = "durable";',
        blockId: "changing-eval",
        componentName: "ChangingProvider",
      });
      return "";
    },
  };
}

function withoutClose(stream: InMemoryStream): InMemoryStream {
  const events = stream.snapshot();
  if (events.at(-1)?.type !== "close") {
    throw new Error("expected completed history");
  }
  return new InMemoryStream(events.slice(0, -1));
}

function serialized(stream: InMemoryStream): string {
  return stream.snapshot().map(serializeDurableEvent).join("");
}

describe("ephemeral eval and attached-service bindings", () => {
  beforeAll(() => useTempFileCompiler());

  it("reconstructs live bindings without exposing them to durable consumers", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "doc.md": `<Provider><Sample /></Provider>\n`,
      "components/Provider.md": `---
meta:
  componentName: Provider
---

\`\`\`js ephemeral eval
const live = 5;
\`\`\`

\`\`\`js eval
output(typeof live);
\`\`\`

literal:{live}

\`\`\`js persist ephemeral eval
yield* Sample.around({
  *sample() { return String(live); },
});
\`\`\`

<Content />
`,
      "components/Sample.md": SAMPLE,
    });

    const output = String(
      yield* collect(
        yield* execute({
          path: "doc.md",
          stream,
          componentDirs: ["components", "."],
        }),
      ),
    );

    expect(output).toContain("undefined");
    expect(output).toContain("literal:{live}");
    expect(output).toContain("5");

    const evalEvents = stream
      .snapshot()
      .filter((event) => event.type === "yield" && event.description.type === "eval");
    expect(evalEvents).toHaveLength(2);
  });

  it("publishes the exact frozen attached-service endpoint only to ephemeral eval", function* () {
    const endpoint = Object.freeze({ hostname: SERVICE_HOSTNAME, port: 43_210 });
    const lifecycle = { starts: 0, stops: 0 };
    const stream = new InMemoryStream();
    yield* useServiceStub(endpoint, lifecycle);
    yield* useStubFs({
      "doc.md": `<Provider>

\`\`\`js eval
output(typeof server);
\`\`\`

projected:{server}

<Sample />
</Provider>\n`,
      "components/Provider.md": `---
meta:
  componentName: Provider
---

\`\`\`bash service=server exec
handshake-compatible-server
\`\`\`

endpoint:{server.port}

\`\`\`js persist ephemeral eval
const captured = server;
yield* Sample.around({
  *sample() { return captured === server && Object.isFrozen(server) ? String(server.port) : "bad"; },
});
\`\`\`

<Content />
`,
      "components/Sample.md": SAMPLE,
    });

    const output = String(
      yield* collect(
        yield* execute({
          path: "doc.md",
          stream,
          componentDirs: ["components", "."],
        }),
      ),
    );

    expect(output).toContain("endpoint:{server.port}");
    expect(output).toContain("undefined");
    expect(output).toContain("projected:{server}");
    expect(output).toContain("43210");
    expect(lifecycle.starts).toBe(1);
    expect(lifecycle.stops).toBe(1);
    expect(
      stream
        .snapshot()
        .some((event) => event.type === "yield" && event.description.type === "service"),
    ).toBe(false);
  });

  it("completed replay starts neither attached services nor ephemeral eval", function* () {
    const endpoint = Object.freeze({ hostname: SERVICE_HOSTNAME, port: 41_001 });
    const lifecycle = { starts: 0, stops: 0 };
    const stream = new InMemoryStream();
    const files = {
      "doc.md": `\`\`\`bash service=server exec
handshake-compatible-server
\`\`\`

\`\`\`js ephemeral eval
const reconstructed = server;
\`\`\`

done
`,
    };
    yield* useServiceStub(endpoint, lifecycle);
    yield* useStubFs(files);

    expect(
      String(
        yield* scoped(function* () {
          return yield* collect(yield* execute({ path: "doc.md", stream }));
        }),
      ),
    ).toContain("done");
    expect(lifecycle).toEqual({ starts: 1, stops: 1 });

    expect(
      String(
        yield* scoped(function* () {
          return yield* collect(yield* execute({ path: "doc.md", stream }));
        }),
      ),
    ).toContain("done");
    expect(lifecycle).toEqual({ starts: 1, stops: 1 });
  });

  it("rejects forbidden output and return values before live exports commit", function* () {
    const cases = [
      `const leaked = 1; output("secret-value");`,
      `const leaked = 1; return "secret-value";`,
    ];

    for (const source of cases) {
      const stream = new InMemoryStream();
      yield* useStubFs({
        "doc.md": `<Output>\n\n\`\`\`js ephemeral eval\n${source}\n\`\`\`\n\n</Output>\n`,
      });
      let failure: unknown;
      try {
        yield* collect(yield* execute({ path: "doc.md", stream }));
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("ephemeral eval cannot");
      expect(String(failure)).not.toContain("secret-value");
      expect(
        stream
          .snapshot()
          .some((event) => event.type === "yield" && event.description.type === "eval"),
      ).toBe(false);
    }
  });

  it("validates attached-service binding collisions before spawning", function* () {
    const cases: Array<[string, string, number]> = [
      ["service", "requires a binding name", 0],
      ["service=bad-name", "must be a valid JavaScript identifier", 0],
      ["service=taken", "collides with a durable binding", 0],
      ["service=server", "collides with a live binding", 1],
    ];

    for (const [modifier, expectedMessage, expectedStarts] of cases) {
      const lifecycle = { starts: 0, stops: 0 };
      const failure = yield* scoped(function* () {
        yield* useServiceStub(
          Object.freeze({ hostname: SERVICE_HOSTNAME, port: 40_001 + expectedStarts }),
          lifecycle,
        );
        const prefix =
          modifier === "service=taken"
            ? "```js eval\nconst taken = 1;\n```\n\n"
            : modifier === "service=server"
              ? "```bash service=server exec\none\n```\n\n"
              : "";
        yield* useStubFs({
          "doc.md": `<Output>\n\n${prefix}\`\`\`bash ${modifier} exec\ntwo\n\`\`\`\n\n</Output>\n`,
        });

        try {
          yield* collect(yield* execute({ path: "doc.md", stream: new InMemoryStream() }));
        } catch (error) {
          return error;
        }
        return undefined;
      });
      expect(String(failure)).toContain(expectedMessage);
      expect(lifecycle.starts).toBe(expectedStarts);
      expect(lifecycle.stops).toBe(expectedStarts);
    }
  });

  it("prints a live durable-export collision, skips its Yield, and continues durably", function* () {
    const lifecycle = { starts: 0, stops: 0 };
    const stream = new InMemoryStream();
    const executions: string[] = [];
    yield* useServiceStub(Object.freeze({ hostname: SERVICE_HOSTNAME, port: 40_100 }), lifecycle);
    yield* useTrackedExec(executions);
    yield* useStubFs({
      "doc.md": `

\`\`\`bash service=server exec
handshake-compatible-server
\`\`\`

\`\`\`js eval
const partial = "must-not-commit";
const server = "must-not-execute";
\`\`\`

\`\`\`bash exec
echo after-collision
\`\`\`
`,
    });

    const output = String(
      yield* scoped(function* () {
        return yield* collect(yield* execute({ path: "doc.md", stream }));
      }),
    );

    expect(output).toContain("collides with a live binding");
    expect(output).toContain("after-collision");
    expect(executions).toEqual(["echo after-collision"]);
    expect(
      stream
        .snapshot()
        .some((event) => event.type === "yield" && event.description.type === "eval"),
    ).toBe(false);
    expect(lifecycle).toEqual({ starts: 1, stops: 1 });
  });

  it("prints the same collision on valid partial replay and restores the later effect", function* () {
    const endpoint = Object.freeze({ hostname: SERVICE_HOSTNAME, port: 40_101 });
    const lifecycle = { starts: 0, stops: 0 };
    const executions: string[] = [];
    const live = new InMemoryStream();
    yield* useServiceStub(endpoint, lifecycle);
    yield* useTrackedExec(executions);
    yield* useStubFs({
      "doc.md": `

\`\`\`bash service=server exec
handshake-compatible-server
\`\`\`

\`\`\`js eval
const partial = "must-not-commit";
const server = "must-not-execute";
\`\`\`

\`\`\`bash exec
echo after-collision
\`\`\`
`,
    });
    const liveOutput = String(
      yield* scoped(function* () {
        return yield* collect(yield* execute({ path: "doc.md", stream: live }));
      }),
    );
    expect(liveOutput).toContain("collides with a live binding");
    expect(executions).toEqual(["echo after-collision"]);

    const partial = withoutClose(live);
    const before = partial.snapshot();
    const replayOutput = String(
      yield* scoped(function* () {
        return yield* collect(yield* execute({ path: "doc.md", stream: partial }));
      }),
    );

    expect(replayOutput).toContain("collides with a live binding");
    expect(replayOutput).toContain("after-collision");
    expect(executions).toEqual(["echo after-collision"]);
    expect(
      partial
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "eval").length,
    ).toBe(0);
    expect(partial.snapshot().slice(0, before.length)).toEqual(before);
    expect(lifecycle).toEqual({ starts: 2, stops: 2 });
  });

  it("rejects incompatible retained component history through divergence", function* () {
    const lifecycle = { starts: 0, stops: 0 };
    const executions: string[] = [];
    const history = new InMemoryStream();
    yield* useServiceStub(Object.freeze({ hostname: SERVICE_HOSTNAME, port: 40_102 }), lifecycle);
    yield* useTrackedExec(executions);
    yield* useStubFs({
      "doc.md": `<PrintErrors><ChangingProvider /></PrintErrors>

\`\`\`bash exec
echo after-provider
\`\`\`
`,
    });
    yield* registerComponents([changingProvider(false)]);
    expect(String(yield* collect(yield* execute({ path: "doc.md", stream: history })))).toContain(
      "after-provider",
    );
    expect(executions).toEqual(["echo after-provider"]);

    const retained = withoutClose(history);
    const before = retained.snapshot();
    const beforeBytes = serialized(retained);
    const replayExecutions: string[] = [];
    let failure: unknown;
    yield* scoped(function* () {
      yield* useTrackedExec(replayExecutions);
      yield* registerComponents([changingProvider(true)]);
      try {
        yield* collect(yield* execute({ path: "doc.md", stream: retained }));
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(DivergenceError);
    expect(String(failure)).not.toContain("collides with a live binding");
    expect(replayExecutions).toEqual([]);
    expect(retained.snapshot()).toEqual(before);
    expect(serialized(retained)).toBe(beforeBytes);
    expect(lifecycle).toEqual({ starts: 1, stops: 1 });
  });

  it("rejects incompatible retained history when collision validation terminates the root", function* () {
    const lifecycle = { starts: 0, stops: 0 };
    const history = new InMemoryStream();
    yield* useServiceStub(Object.freeze({ hostname: SERVICE_HOSTNAME, port: 40_103 }), lifecycle);
    yield* useStubFs({
      "doc.md": `<Output><ChangingProvider /></Output>`,
    });
    yield* registerComponents([changingProvider(false)]);
    yield* collect(yield* execute({ path: "doc.md", stream: history }));

    const retained = withoutClose(history);
    const before = retained.snapshot();
    const beforeBytes = serialized(retained);
    let failure: unknown;
    yield* scoped(function* () {
      yield* registerComponents([changingProvider(true)]);
      try {
        yield* collect(yield* execute({ path: "doc.md", stream: retained }));
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(TerminalDivergenceError);
    if (!(failure instanceof TerminalDivergenceError)) {
      throw new Error("expected terminal divergence");
    }
    expect(failure.cause).toBeInstanceOf(LiveBindingCollisionError);
    expect(String(failure)).not.toContain("collides with a live binding");
    expect(retained.snapshot()).toEqual(before);
    expect(serialized(retained)).toBe(beforeBytes);
    expect(lifecycle).toEqual({ starts: 1, stops: 1 });

    yield* collect(yield* execute({ path: "doc.md", stream: retained }));
    expect(retained.snapshot().slice(0, before.length)).toEqual(before);
    expect(
      retained
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "eval"),
    ).toHaveLength(1);
    expect(retained.snapshot().at(-1)?.type).toBe("close");
  });

  it("rejects ephemeral exports that collide with durable names before execution", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "doc.md": `<Output>

\`\`\`js eval
const shared = "durable";
\`\`\`

\`\`\`js ephemeral eval
const partial = "must-not-commit";
const shared = "must-not-execute";
\`\`\`

</Output>
`,
    });

    let failure: unknown;
    try {
      yield* scoped(function* () {
        yield* collect(yield* execute({ path: "doc.md", stream }));
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("collides with a durable binding");
    expect(
      stream
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "eval"),
    ).toHaveLength(1);
  });

  it("allows a later ephemeral eval to update an existing live binding", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "doc.md": `<Provider><Sample /></Provider>\n`,
      "components/Provider.md": `---
meta:
  componentName: Provider
---

\`\`\`js ephemeral eval
const live = "first";
\`\`\`

\`\`\`js ephemeral eval
const live = "second";
\`\`\`

\`\`\`js persist ephemeral eval
const captured = live;
yield* Sample.around({
  *sample() { return captured; },
});
\`\`\`

<Content />
`,
      "components/Sample.md": SAMPLE,
    });

    const output = String(
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

    expect(output).toContain("second");
  });
});
