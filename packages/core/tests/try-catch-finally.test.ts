import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, withResolvers } from "effection";
import { registerComponents } from "../src/components/registration.ts";
import { content } from "../src/component-api.ts";
import { fixture, run } from "./try-catch-finally-harness.ts";

const fail = '<Fail message="body failed" />';
const command = "```sh exec\nFAIL\n```";
const noProps = { type: "object", properties: {}, additionalProperties: false };

describe("authored Try/Catch/Finally", () => {
  it("A1: the actual fallback skips recovery on success and joins release before replacement", function* () {
    const source = yield* fixture("fallback");
    const example = yield* readTextFile(
      fileURLToPath(new URL("../../../examples/try-catch-finally.md", import.meta.url)),
    );
    expect(example.slice(example.indexOf("<Output>"))).toBe(source);
    const success: { trace: string[] } = { trace: [] };
    const first = yield* run(example, success);
    expect(first.result.ok).toBe(true);
    expect(success.trace.filter((entry) => entry.startsWith("prompt:"))).toEqual(["prompt:claude"]);
    expect(first.output).toContain("PASS");
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const provider = {
      fail: true,
      trace: new Array<string>(),
      release: release.operation,
      releasing: () => entered.resolve(),
    };
    const task = yield* spawn(() => run(source, provider));
    yield* entered.operation;
    expect(provider.trace).not.toContain("prompt:codex");
    release.resolve();
    const recovered = yield* task;
    expect(recovered.result.ok).toBe(true);
    expect(provider.trace.indexOf("released:claude")).toBeLessThan(
      provider.trace.indexOf("prompt:codex"),
    );
    expect(recovered.output).toMatch(
      /Primary review failed:[\s\S]*primary unavailable[\s\S]*PASS[\s\S]*Review attempt finished/,
    );
    expect(recovered.output.match(/Review attempt finished/g)).toHaveLength(1);
    expect(JSON.stringify(recovered.events)).toContain('"retryable":true');
    console.log(recovered.output);
  });

  it("A2: checked failure stops the body, capture stays private, and Catch bindings stay local", function* () {
    const result = yield* run(yield* fixture("local-recovery"));
    expect(result.result.ok).toBe(true);
    expect(result.output).not.toContain("Unreachable");
    expect(result.output).toContain("Recovered:");
    expect(result.output).toContain("outer: body: finally");
    expect(result.output.match(/Prefix\./g)).toHaveLength(1);
    const nested = yield* run(
      `<Try><PrintErrors>${fail}after printing</PrintErrors><Catch>WRONG</Catch><Finally>done</Finally></Try>`,
    );
    expect(nested.result.ok).toBe(true);
    expect(nested.output).toContain("after printing");
    expect(nested.output).not.toContain("WRONG");
    const escaped = yield* run(
      '<Try><Fail message="ordinary" /><Catch><Let as="local" value="inside" /></Catch></Try><Let as="escaped" value={local} />',
    );
    expect(escaped.result.ok).toBe(false);
  });

  it("A3: pending checked failure survives swallowed content and runs only Finally", function* () {
    yield* registerComponents([
      {
        name: "Swallow",
        origin: "try-test",
        props: noProps,
        *fn() {
          try {
            return yield* content();
          } catch {
            return "swallowed";
          }
        },
      },
    ]);
    const result = yield* run(
      `<Try><Swallow>\n${command}\n</Swallow><Finally>finished</Finally></Try>WRONG`,
    );
    expect(result.result.ok).toBe(false);
    expect(result.output).toContain("finished");
    expect(result.output).not.toContain("WRONG");
  });

  it("A3: Catch and Finally failures preserve phase order", function* () {
    const both = yield* run(
      `<Try>${fail}<Catch><Fail message="catch failed" /></Catch><Finally><Fail message="finally failed" /></Finally></Try>`,
    );
    expect(both.result.ok).toBe(false);
    if (!both.result.ok) {
      expect(both.result.error).toBeInstanceOf(AggregateError);
      expect(both.result.error.message).toContain("catch failed");
    }
    const unhandled = yield* run(
      `<Try>${fail}<Finally><Fail message="later failure" /></Finally></Try>`,
    );
    expect(unhandled.result.ok).toBe(false);
    if (!unhandled.result.ok) {
      expect(unhandled.result.error).toBeInstanceOf(AggregateError);
      expect(unhandled.result.error.message).toContain("body failed");
    }
    const controlled = yield* run(
      `<Loop max={1}><Try>${fail}<Finally>completion<Break />WRONG</Finally></Try>WRONG</Loop>`,
    );
    expect(controlled.result.ok).toBe(false);
    expect(controlled.output).toContain("completion");
    expect(controlled.output).not.toContain("WRONG");
    const handled = yield* run(
      `<Try>${fail}<Catch>recovered</Catch><Finally><Fail message="new failure" /></Finally></Try>`,
    );
    expect(handled.result.ok).toBe(false);
    if (!handled.result.ok) {
      expect(handled.result.error.message).toContain("new failure");
    }
  });

  it("A4: lexical and projected Break finalize once before the loop exits", function* () {
    for (const body of ["<Break />", "<Project><Break /></Project>"]) {
      const result = yield* scoped(function* () {
        yield* registerComponents([
          {
            name: "Project",
            origin: "try-test",
            props: noProps,
            *fn() {
              return yield* content();
            },
          },
        ]);
        return yield* run(
          `<Loop max={2}><Try>before${body}WRONG<Catch>WRONG</Catch><Finally>final one\nfinal two</Finally></Try>WRONG</Loop>`,
        );
      });
      expect(result.result.ok).toBe(true);
      expect(result.output).not.toContain("WRONG");
      expect(result.output.match(/final one/g)).toHaveLength(1);
      expect(result.output).toContain("final two");
    }
  });

  it("A4: value recovery selects after failure and Return never ends the attempted body", function* () {
    const value = yield* run(
      `---\nreturns:\n  type: string\n---\n<Try>${fail}<Catch><Return value="fallback" /></Catch><Finally>hidden</Finally></Try>`,
    );
    expect(value.result).toEqual({ ok: true, value: "fallback" });
    const duplicate = yield* run(
      `---\nreturns:\n  type: string\n---\n<Try><Return value="first" />${fail}<Catch><Return value="second" /></Catch><Finally>hidden</Finally></Try>`,
    );
    expect(duplicate.result.ok).toBe(false);
  });

  it("A6: component transformation retains ownership of recovered projected rendering", function* () {
    yield* registerComponents([
      {
        name: "Upper",
        origin: "try-test",
        props: noProps,
        *fn() {
          return (yield* content()).toUpperCase();
        },
      },
    ]);
    const result = yield* run(
      `<Upper><Try>prefix${fail}<Catch>fallback</Catch><Finally>done</Finally></Try></Upper>`,
    );
    expect(result.result.ok).toBe(true);
    expect(result.output).toBe("PREFIXFALLBACKDONE");
  });

  it("A5: malformed source refuses before attempted effects or prop expressions", function* () {
    let effects = 0;
    yield* registerComponents([
      {
        name: "Probe",
        origin: "try-test",
        props: noProps,
        *fn() {
          effects += 1;
          return "effect";
        },
      },
    ]);
    const invalid = [
      "<Try />",
      "<Try>empty</Try>",
      "<Try as={boom()}><Catch></Catch></Try>",
      "<Try><Catch as={boom()}></Catch></Try>",
      '<Try><Catch as="for"></Catch></Try>',
      "<Try><Finally></Finally><Catch></Catch></Try>",
      "<Try><Catch></Catch>tail</Try>",
      "<Try><Catch></Catch><Catch></Catch></Try>",
      "<Try><Wrapper><Catch></Catch></Wrapper></Try>",
      "<Catch></Catch>",
      "<Finally />",
    ];
    for (const source of invalid) {
      const result = yield* run(`<Probe />${source}`);
      expect(result.result.ok).toBe(false);
      expect(
        result.events.some((entry) => entry.type === "yield" && entry.description.type === "exec"),
      ).toBe(false);
    }
    expect(effects).toBe(0);
    expect((yield* run("<Try><Catch></Catch><Finally></Finally></Try>")).result.ok).toBe(true);
  });

  it("A6: source Output declarations select only entered regions", function* () {
    const result = yield* run(
      `<Try><Output>prefix</Output>${fail}<Catch><Output>fallback</Output></Catch><Finally><Output>completion</Output></Finally></Try>hidden`,
    );
    expect(result.result.ok).toBe(true);
    expect(result.output).toBe("prefixfallbackcompletion");
  });
});
