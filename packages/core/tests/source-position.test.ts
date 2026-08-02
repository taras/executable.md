import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { scanSegments } from "../src/scanner.ts";
import { invocation } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import type { ComponentElement, SourcePosition } from "../src/types.ts";

function componentsOf(segments: ReturnType<typeof scanSegments>): ComponentElement[] {
  const found: ComponentElement[] = [];
  for (const segment of segments) {
    if (segment.type === "component") {
      found.push(segment);
      found.push(...componentsOf(segment.children));
    }
  }
  return found;
}

describe("source positions", () => {
  it("attaches local positions without an origin", function* () {
    const [greeting] = componentsOf(scanSegments("line one\n<Greeting />\n"));
    expect(greeting?.position).toEqual({ path: undefined, offset: 9, line: 2, column: 1 });
  });

  it("attaches positions to nested children at original offsets", function* () {
    const text = "<Outer>\n  text\n  <Inner />\n</Outer>\n";
    const [outer, inner] = componentsOf(scanSegments(text));
    expect(outer?.position).toEqual({ path: undefined, offset: 0, line: 1, column: 1 });
    expect(inner?.position).toEqual({
      path: undefined,
      offset: text.indexOf("<Inner"),
      line: 3,
      column: 3,
    });
  });

  it("translates positions through an origin", function* () {
    const [greeting] = componentsOf(
      scanSegments("\n<Greeting />", { path: "Doc.md", baseOffset: 40, baseLine: 5 }),
    );
    expect(greeting?.position).toEqual({
      path: "Doc.md",
      offset: 41,
      line: 6,
      column: 1,
    });
  });

  it("computes original-file positions past frontmatter, immune to repeated body text", function* () {
    // The frontmatter contains a copy of the body's first line: a content
    // search for the body would false-match inside the frontmatter, so only
    // the suffix computation yields the correct base.
    const doc = [
      "---",
      'title: "<Probe />"',
      "note: intro line",
      "---",
      "intro line",
      "<Probe />",
      "",
    ].join("\n");

    const positions: SourcePosition[] = [];
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": doc });
    // Registered rather than a repository file, so the probe can record what
    // the engine tells a component about its own call site. That is the public
    // guarantee now — `invocation()` — rather than what a claim was offered.
    yield* registerComponents([
      {
        name: "Probe",
        origin: "test",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          const position = (yield* invocation()).position;
          if (position) {
            positions.push(position);
          }
          return "probed";
        },
      },
    ]);

    const output = yield* collect(yield* execute({ path: "README.md", stream }));
    expect(output).toContain("probed");

    const probeLine = doc.split("\n").indexOf("<Probe />") + 1;
    expect(positions).toEqual([
      {
        path: "README.md",
        offset: doc.indexOf("\n<Probe />") + 1,
        line: probeLine,
        column: 1,
      },
    ]);
  });

  it("positions imported-component invocations in the component's own file", function* () {
    const readme = "<Wrapper />\n";
    const wrapper = ["---", "title: Wrapper", "---", "before", "<Probe />", ""].join("\n");

    const positions: Array<{ name: string; position?: SourcePosition }> = [];
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": readme,
      "components/Wrapper.md": wrapper,
    });
    yield* registerComponents([
      {
        name: "Probe",
        origin: "test",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          const metadata = yield* invocation();
          positions.push({
            name: metadata.name,
            ...(metadata.position ? { position: metadata.position } : {}),
          });
          return "probed";
        },
      },
    ]);

    const output = yield* collect(yield* execute({ path: "README.md", stream }));
    expect(output).toContain("probed");

    const probe = positions.find((p) => p.name === "Probe");
    expect(probe?.position).toEqual({
      path: "components/Wrapper.md",
      offset: wrapper.indexOf("<Probe />"),
      line: 5,
      column: 1,
    });
  });
});
