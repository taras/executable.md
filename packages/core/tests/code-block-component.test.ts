/**
 * Tier CB — `<CodeBlock>` (spec §6.19).
 *
 * The contract is bytes, so the assertions are bytes. Every exactness case
 * compares a complete string taken at one of two boundaries — what the
 * component rendered at the invocation site, or what `as` bound — because both
 * sit before the `DocumentOutput` middleware, and normalization downstream of
 * them could make a wrong fence or a rewritten value read as correct. Nothing
 * here installs that middleware.
 *
 * The cases drive core's registered component through `execute()`, because the
 * form this component accepts is decided by canonical dispatch against the
 * invocation the engine issued (§5.6): expanding segments directly would refuse
 * every invocation for want of that authority, and prove nothing about the
 * component.
 *
 * Three fixtures travel with each document. `<Value>` puts an arbitrary string
 * in scope without an eval block — a document cannot write a lone carriage
 * return or a seven-backtick run as a prop literal. `<Probe>` reads a binding
 * back out at the ordinary prop boundary, which is the boundary a repository
 * override receives. `<Tripwire>` is written inside paired content, so a
 * refused form that expanded its children anyway is counted rather than
 * inferred.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { useStubFs } from "@executablemd/runtime/test";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { Json } from "../src/types.ts";

interface Run {
  /** Everything the document emitted, before any output middleware. */
  output: string;
  /** The run's own outcome: a failure nothing printed settles here. */
  failure: string;
  /** Every `value` a `<Probe>` was handed, in invocation order. */
  probed: string[];
  /** How many times the paired-content tripwire expanded. */
  tripped: number;
}

/** Everything a run reported, printed or settled. */
function reported(result: Run): string {
  return `${result.output}\n${result.failure}`;
}

/** Run `source` as the document, with `values` reachable through `<Value>`. */
function run(source: string, values: Record<string, string> = {}): Operation<Run> {
  return scoped(function* () {
    const probed: string[] = [];
    let tripped = 0;

    yield* useStubFs({ "doc.md": source });
    yield* registerComponents([
      {
        name: "Value",
        origin: "tier-cb",
        props: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
        // deno-lint-ignore require-yield
        *fn(props: Record<string, Json>): Operation<unknown> {
          return values[String(props.key)];
        },
      },
      {
        name: "Probe",
        origin: "tier-cb",
        props: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        // deno-lint-ignore require-yield
        *fn(props: Record<string, Json>): Operation<string> {
          probed.push(String(props.value));
          return "";
        },
      },
      {
        name: "Tripwire",
        origin: "tier-cb",
        props: { type: "object", properties: {}, additionalProperties: false },
        // deno-lint-ignore require-yield
        *fn(): Operation<string> {
          tripped += 1;
          return "TRIPPED";
        },
      },
    ]);

    const execution = yield* execute({ path: "doc.md", stream: new InMemoryStream() });
    const output = yield* forEach(function* () {}, execution.output);
    const outcome = yield* execution;
    return {
      output,
      failure: outcome.ok ? "" : outcome.error.message,
      probed,
      tripped,
    };
  });
}

/** The one line a `<CodeBlock>` invocation renders, with nothing around it. */
function* directly(value: string, attributes = ""): Operation<Run> {
  return yield* run(`<Value key="v" as="v" /><CodeBlock value={v}${attributes} />`, { v: value });
}

/** The exact string `as` bound, at the capture boundary. */
function* captured(value: string, attributes = ""): Operation<string> {
  const result = yield* run(
    `<Value key="v" as="v" /><CodeBlock value={v}${attributes} as="block" /><Probe value={block} />`,
    { v: value },
  );
  expect(reported(result)).not.toContain("error");
  expect(result.probed.length).toBe(1);
  return result.probed[0] ?? "";
}

describe("Tier CB — the envelope", () => {
  it("CB1: an empty value is three backticks, two line feeds and nothing else", function* () {
    const result = yield* directly("");

    expect(result.failure).toBe("");
    expect(result.output).toBe("```\n\n```");
    expect(yield* captured("")).toBe("```\n\n```");
  });

  it("CB1: ordinary Markdown keeps its own lines, and gains no final line feed", function* () {
    const value = "# Title\n\n- one\n- two";
    const result = yield* directly(value);

    expect(result.output).toBe("```\n# Title\n\n- one\n- two\n```");
    expect(yield* captured(value)).toBe("```\n# Title\n\n- one\n- two\n```");
  });

  it("CB1: the block lands where the element was written", function* () {
    const result = yield* run(
      '<Value key="v" as="v" />before\n\n<CodeBlock value={v} />\n\nafter\n',
      { v: "shown" },
    );

    expect(result.failure).toBe("");
    expect(result.output).toContain("before");
    expect(result.output).toContain("```\nshown\n```");
    expect(result.output).toContain("after");
  });
});

describe("Tier CB — the fence the value cannot close", () => {
  it("CB2: the fence is the longest backtick run plus one, never fewer than three", function* () {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["no backticks at all", 3],
      ["one ` here", 3],
      ["two `` here", 3],
      ["three ``` here", 4],
      ["`` then ` then ``` then ``", 4],
      ["```` four ````", 5],
      ["a run of ``````` seven", 8],
      ["```\nnested\n```", 4],
      ["`", 3],
      ["``````````", 11],
    ];

    for (const [value, length] of cases) {
      const block = yield* captured(value);
      const fence = "`".repeat(length);

      expect(block).toBe(`${fence}\n${value}\n${fence}`);
      // Stated twice on purpose: the complete string pins the layout, and this
      // pins the count the layout was built from.
      expect(block.split("\n")[0]?.length).toBe(length);
    }
  });

  it("CB2: a run broken by any other character is two runs, not one", function* () {
    // Counting backticks without resetting would read five here and open a
    // six-backtick fence.
    expect(yield* captured("```\n``")).toBe("````\n```\n``\n````");
    expect(yield* captured("``x``x``")).toBe("```\n``x``x``\n```");
  });
});

describe("Tier CB — the value is not read for anything else", () => {
  it("CB3: removing the envelope recovers the source code units exactly", function* () {
    const value = [
      "   leading spaces",
      "\ttab indented",
      "",
      "",
      "carriage\r\nreturn line",
      "`` two `````` six",
      "trailing spaces   ",
    ].join("\n");
    const block = yield* captured(value);

    // The value's longest run is six backticks, so the fence is seven.
    const fence = "`".repeat(7);
    expect(block.startsWith(`${fence}\n`)).toBe(true);
    expect(block.endsWith(`\n${fence}`)).toBe(true);

    const recovered = block.slice(fence.length + 1, block.length - fence.length - 1);
    expect(recovered.length).toBe(value.length);
    for (let index = 0; index < value.length; index += 1) {
      expect(recovered.charCodeAt(index)).toBe(value.charCodeAt(index));
    }
  });
});

describe("Tier CB — the language token", () => {
  it("CB4: an omitted language leaves the opening fence bare", function* () {
    expect((yield* captured("plain")).split("\n")[0]).toBe("```");
  });

  it("CB4: every accepted token renders on the opening fence, unchanged", function* () {
    const accepted = ["markdown", "md", "json", "shell-session", "c++", "c#", "F", "x1._+#-"];

    for (const language of accepted) {
      const result = yield* directly("body", ` language="${language}"`);

      expect(result.failure).toBe("");
      expect(result.output).toBe("```" + language + "\nbody\n```");
    }
  });

  it("CB4: a refused token fails validation and renders no fence", function* () {
    const refused = [
      "",
      " ",
      "\t",
      "shell session",
      "md ",
      " md",
      "a`b",
      "`",
      "-md",
      ".md",
      "+md",
      "#md",
      "js/ts",
      "js:ts",
      "js,ts",
      "js;ts",
      "js\\ts",
      "js$ts",
      "js%ts",
      "js*ts",
      "js\nts",
    ];

    for (const language of refused) {
      const result = yield* run(
        '<Value key="v" as="v" /><Value key="lang" as="lang" /><CodeBlock value={v} language={lang} />',
        { v: "body", lang: language },
      );

      expect(reported(result)).toContain("Prop validation failed for <CodeBlock />");
      expect(reported(result)).toContain("language");
      expect(result.output).not.toContain("```");
      expect(result.output).not.toContain("body");
    }
  });
});

describe("Tier CB — the invocation is refused before the body", () => {
  it("CB5: a missing value is the engine's own required-prop refusal", function* () {
    const result = yield* run("<CodeBlock />");

    expect(reported(result)).toContain("Prop validation failed for <CodeBlock />");
    expect(reported(result)).toContain("value");
    expect(result.output).not.toContain("```");
  });

  it("CB5: a non-string value is refused rather than coerced", function* () {
    for (const value of ["42", "true", "null", "{ text: 'x' }", "['x']"]) {
      const result = yield* run(`<CodeBlock value={${value}} />`);

      expect(reported(result)).toContain("Prop validation failed for <CodeBlock />");
      expect(result.output).not.toContain("```");
    }
  });

  it("CB5: an unknown prop is refused, and nothing renders", function* () {
    const result = yield* directly("body", ' fence="~~~"');

    expect(reported(result)).toContain("Prop validation failed for <CodeBlock />");
    expect(reported(result)).toContain("fence");
    expect(result.output).not.toContain("body");
  });

  it("CB5: paired content is refused by form, and the content never expands", function* () {
    const result = yield* run(
      '<Value key="v" as="v" /><CodeBlock value={v}><Tripwire /></CodeBlock>',
      { v: "body" },
    );

    expect(reported(result)).toContain("<CodeBlock value={…} />");
    expect(result.tripped).toBe(0);
    expect(result.output).not.toContain("TRIPPED");
    expect(result.output).not.toContain("```");
  });

  it("CB5: empty paired content is still the paired form", function* () {
    const result = yield* run('<Value key="v" as="v" /><CodeBlock value={v}></CodeBlock>', {
      v: "body",
    });

    expect(reported(result)).toContain("<CodeBlock value={…} />");
    expect(result.output).not.toContain("```");
  });
});

/** Everything a document must not act on, in one string. */
const HOSTILE = [
  "```md",
  "<Tripwire />",
  "{v}",
  "<script>alert(1)</script>",
  "",
  "```bash",
  "echo executed",
  "```",
  "",
  "~~~",
  "</CodeBlock>",
].join("\n");

describe("Tier CB — inertness and capture", () => {
  it("CB6: candidate-like content is shown, not run, and not escaped", function* () {
    const result = yield* directly(HOSTILE);

    expect(result.failure).toBe("");
    expect(result.tripped).toBe(0);
    // The value's longest run is three, so the fence is four.
    expect(result.output).toBe("````\n" + HOSTILE + "\n````");
    // Present verbatim: nothing was escaped, rewritten or removed.
    expect(result.output).toContain("<Tripwire />");
    expect(result.output).toContain("{v}");
    expect(result.output).toContain("echo executed");
  });

  it("CB6: `as` binds that exact string and emits nothing where it was written", function* () {
    const direct = yield* directly(HOSTILE);
    const result = yield* run(
      '<Value key="v" as="v" />before<CodeBlock value={v} as="block" />after<Probe value={block} />',
      { v: HOSTILE },
    );

    expect(result.failure).toBe("");
    expect(result.probed).toEqual([direct.output]);
    // Captured instead of emitted: the invocation site contributed nothing.
    expect(result.output).toBe("beforeafter");
    expect(result.tripped).toBe(0);
  });
});

describe("Tier CB — durability", () => {
  /** A registered source for the string `<CodeBlock>` is handed. */
  function source(text: string) {
    return {
      name: "Source",
      origin: "tier-cb",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return text;
      },
    };
  }

  function runOn(stream: InMemoryStream, text: string): Operation<Json> {
    return scoped(function* () {
      yield* useStubFs({
        "doc.md": '<Source as="payload" />\n\n<CodeBlock value={payload} />\n',
      });
      yield* registerComponents([source(text)]);
      return yield* collect(yield* execute({ path: "doc.md", stream }));
    });
  }

  function* descriptions(stream: InMemoryStream): Operation<string[]> {
    const events = yield* stream.readAll();
    const types: string[] = [];
    for (const event of events) {
      if (event.type === "yield") {
        types.push(String(event.description.type));
      }
    }
    return types;
  }

  /** The journal without the root's close, so the next run continues live. */
  function* partial(stream: InMemoryStream): Operation<InMemoryStream> {
    const events = yield* stream.readAll();
    return new InMemoryStream(
      events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
    );
  }

  it("CB7: no code-block effect is journaled, partial replay re-renders, completed replay does not", function* () {
    const live = new InMemoryStream();
    const first = String(yield* runOn(live, "FIRST"));
    expect(first).toContain("```\nFIRST\n```");

    // Every durable record belongs to something that already existed:
    // resolving the component is the ordinary import every resolution produces.
    const types = yield* descriptions(live);
    expect(types).toContain("import_component");
    expect(types.filter((type) => /code.?block|fence/i.test(type))).toEqual([]);

    // A partial journal reaches the component again and fences the string this
    // execution reconstructed, which is the changed one.
    const resumed = yield* partial(live);
    const second = String(yield* runOn(resumed, "SECOND"));
    expect(second).toContain("```\nSECOND\n```");
    expect(second).not.toContain("FIRST");
    expect(yield* descriptions(resumed)).toEqual(types);

    // A completed root is reused whole: the live source is never consulted.
    const again = String(yield* runOn(live, "THIRD"));
    expect(again).toBe(first);
    expect(again).not.toContain("THIRD");
  });
});
