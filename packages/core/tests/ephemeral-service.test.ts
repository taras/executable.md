import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { resource, scoped, type Operation } from "effection";
import {
  InMemoryStream,
  parseDurableEvent,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import { API, SERVICE_HOSTNAME } from "@executablemd/runtime";
import type { ServiceEndpoint } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
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

describe("ephemeral eval and service bindings", () => {
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

  it("publishes the exact frozen service endpoint only to ephemeral eval", function* () {
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
cooperative-server
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

  it("completed replay starts neither services nor ephemeral eval", function* () {
    const endpoint = Object.freeze({ hostname: SERVICE_HOSTNAME, port: 41_001 });
    const lifecycle = { starts: 0, stops: 0 };
    const stream = new InMemoryStream();
    const files = {
      "doc.md": `\`\`\`bash service=server exec
cooperative-server
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

  it("validates service binding collisions before spawning", function* () {
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

  it("rejects a durable eval export that collides with an existing live binding", function* () {
    const lifecycle = { starts: 0, stops: 0 };
    const stream = new InMemoryStream();
    yield* useServiceStub(Object.freeze({ hostname: SERVICE_HOSTNAME, port: 40_100 }), lifecycle);
    yield* useStubFs({
      "doc.md": `<Output>

\`\`\`bash service=server exec
cooperative-server
\`\`\`

\`\`\`js eval
const partial = "must-not-commit";
const server = "must-not-execute";
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

    expect(String(failure)).toContain("collides with a live binding");
    expect(
      stream
        .snapshot()
        .some((event) => event.type === "yield" && event.description.type === "eval"),
    ).toBe(false);
    expect(lifecycle).toEqual({ starts: 1, stops: 1 });
  });

  it("rejects a colliding durable export before partial replay restoration", function* () {
    const endpoint = Object.freeze({ hostname: SERVICE_HOSTNAME, port: 40_101 });
    const lifecycle = { starts: 0, stops: 0 };
    const legacy = new InMemoryStream();
    yield* useServiceStub(endpoint, lifecycle);
    yield* useStubFs({
      "doc.md": `<Output>

\`\`\`bash service=other exec
cooperative-server
\`\`\`

\`\`\`js eval
const server = "legacy-durable-value";
\`\`\`

tail

</Output>
`,
    });
    yield* scoped(function* () {
      yield* collect(yield* execute({ path: "doc.md", stream: legacy }));
    });

    const events = legacy.snapshot().map((event) => {
      const parsed = parseDurableEvent(
        serializeDurableEvent(event).replaceAll("service=other", "service=server"),
      );
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    });
    const evalYield = events.findIndex(
      (event) => event.type === "yield" && event.description.type === "eval",
    );
    expect(evalYield).toBeGreaterThan(-1);
    const partial = new InMemoryStream(events.slice(0, evalYield + 1));
    const beforeEvalEvents = partial
      .snapshot()
      .filter((event) => event.type === "yield" && event.description.type === "eval").length;
    yield* useStubFs({
      "doc.md": `<Output>

\`\`\`bash service=server exec
cooperative-server
\`\`\`

\`\`\`js eval
const server = "legacy-durable-value";
\`\`\`

tail

</Output>
`,
    });

    let failure: unknown;
    try {
      yield* scoped(function* () {
        yield* collect(yield* execute({ path: "doc.md", stream: partial }));
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toContain("collides with a live binding");
    expect(
      partial
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "eval").length,
    ).toBe(beforeEvalEvents);
    expect(lifecycle).toEqual({ starts: 2, stops: 2 });
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
