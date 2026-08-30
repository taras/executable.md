/**
 * Tier PR — `xmd prompt` fixed grammar (specs/prompt-command-spec.md).
 *
 * Rows P1–P6, in the half that is decidable without a document. `scanPromptArgs`
 * is a pure function over argv, so what the command line means — and every
 * refusal it earns — is asserted directly rather than inferred from a process
 * that printed nothing.
 *
 * The rest of P5 and P6 live in `prompt.test.ts`, where a candidate schema
 * exists to bind against.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import {
  isReservedOption,
  namesPrompt,
  scanPromptArgs,
  signatureFailure,
  signatureOf,
  strayPropertyValue,
} from "../src/prompt-args.ts";
import type { OptionSignature } from "../src/prompt-args.ts";
import { buildBindings, extractPropsArgs, PropsError } from "../src/props.ts";
import type { Binding } from "../src/props.ts";

const REQUEST = "ask me for my age and write the result to a file";

function bindingsFor(properties: Record<string, unknown>): Binding[] {
  return buildBindings({ type: "object", properties, additionalProperties: false });
}

function frozen(entries: Record<string, OptionSignature>): Map<string, OptionSignature> {
  return new Map(Object.entries(entries));
}

describe("Tier PR — xmd prompt fixed grammar", () => {
  it("P1: exactly one request, kept byte for byte", function* () {
    expect(namesPrompt(["prompt", REQUEST])).toBe(true);
    expect(namesPrompt(["run", "doc.md"])).toBe(false);

    const one = scanPromptArgs(["prompt", REQUEST]);
    expect(one.error).toBe(undefined);
    expect(one.request).toBe(REQUEST);

    // Preserved, not trimmed: trimming is only how emptiness is tested.
    const padded = scanPromptArgs(["prompt", `  ${REQUEST}\n`]);
    expect(padded.error).toBe(undefined);
    expect(padded.request).toBe(`  ${REQUEST}\n`);

    expect(scanPromptArgs(["prompt"]).error).toContain("requires one request");
    expect(scanPromptArgs(["prompt", "", "--raw"]).error).toContain("non-whitespace");
    expect(scanPromptArgs(["prompt", " \t\n "]).error).toContain("non-whitespace");
    expect(scanPromptArgs(["prompt", REQUEST, "second"]).error).toContain(
      "unrecognized argument for xmd prompt: second",
    );

    // A request that begins with a dash is written after the separator, and is
    // still exactly one request.
    const separated = scanPromptArgs(["prompt", "--", "--not-an-option"]);
    expect(separated.error).toBe(undefined);
    expect(separated.request).toBe("--not-an-option");
    // And it is kept out of the parser's argv, so nothing reads it as an option.
    expect(separated.fixed).toEqual(["prompt"]);
  });

  it("P2: individual options follow the request, aggregate props may precede it", function* () {
    const early = scanPromptArgs(["prompt", "--props-name", "Ada", REQUEST]);
    expect(early.error).toContain("unrecognized option: --props-name");
    expect(early.error).toContain("follow the request");
    // Refused before anything is classified: no request was adopted from the
    // tokens that followed, and no occurrence was recorded.
    expect(early.request).toBe(undefined);
    expect(early.occurrences).toEqual([]);

    const aggregate = scanPromptArgs(["prompt", "--props", '{"name":"Ada"}', REQUEST, "--raw"]);
    expect(aggregate.error).toBe(undefined);
    expect(aggregate.request).toBe(REQUEST);
    // The aggregate never reaches the parser: it coerces a separated value
    // through Number() before any schema could judge it.
    expect(aggregate.fixed).toEqual(["prompt", REQUEST, "--raw"]);

    const inline = scanPromptArgs(["prompt", '--props={"name":"Ada"}', REQUEST]);
    expect(inline.error).toBe(undefined);
    expect(inline.fixed).toEqual(["prompt", REQUEST]);
  });

  it("P3: built-in options after generated props stay with the invocation", function* () {
    const scan = scanPromptArgs([
      "prompt",
      REQUEST,
      "--props-name",
      "Ada",
      "--raw",
      "--include",
      "lib",
      "--props-loud",
      "--journal",
      "trace.jsonl",
      "--save",
      "out.md",
    ]);
    expect(scan.error).toBe(undefined);
    expect(scan.request).toBe(REQUEST);
    expect(scan.fixed).toEqual([
      "prompt",
      REQUEST,
      "--raw",
      "--include",
      "lib",
      "--journal",
      "trace.jsonl",
      "--save",
      "out.md",
    ]);
    // `--props-loud` did not swallow `--journal`: a known option is never read
    // as a generated property's value.
    expect(scan.occurrences).toEqual([
      { option: "--props-name", provisional: "Ada" },
      { option: "--props-loud" },
    ]);

    // Nor at extraction, once a candidate declares `loud` a value option.
    const bindings = bindingsFor({ loud: { type: "string" } });
    let failure: unknown;
    try {
      extractPropsArgs(["prompt", REQUEST, "--props-loud", "--raw"], bindings, {
        reserved: isReservedOption,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PropsError);
    expect(String(failure)).toContain("--props-loud requires a value");
    expect(String(failure)).toContain("--props-loud=--raw");

    // `xmd run` supplies no reserved list, so its behavior is unchanged.
    const asRun = extractPropsArgs(["--props-loud", "--raw"], bindings);
    expect(asRun.individual).toEqual([{ binding: bindings[0], value: "--raw" }]);

    expect(isReservedOption("--raw")).toBe(true);
    expect(isReservedOption("--include=lib")).toBe(true);
    expect(isReservedOption("--props-other")).toBe(true);
    expect(isReservedOption("Ada")).toBe(false);
    expect(isReservedOption("-5")).toBe(false);
  });

  it("P4: scalar, boolean and aggregate sources are all recorded", function* () {
    const scan = scanPromptArgs([
      "prompt",
      REQUEST,
      "--props-name",
      "Ada",
      "--props-loud",
      "--props-tag=alpha",
      "--props-tag=beta",
      "--props",
      '{"count":2}',
    ]);
    expect(scan.error).toBe(undefined);
    expect(scan.occurrences).toEqual([
      { option: "--props-name", provisional: "Ada" },
      { option: "--props-loud" },
      { option: "--props-tag", inline: "alpha" },
      { option: "--props-tag", inline: "beta" },
    ]);

    const bindings = bindingsFor({
      name: { type: "string" },
      loud: { type: "boolean" },
      tag: { type: "array", items: { type: "string" } },
      count: { type: "number" },
    });
    const extraction = extractPropsArgs(
      [
        "prompt",
        REQUEST,
        "--props-name",
        "Ada",
        "--props-loud",
        "--props-tag=alpha",
        "--props-tag=beta",
        "--props",
        '{"count":2}',
      ],
      bindings,
      { reserved: isReservedOption },
    );
    expect(extraction.aggregate).toBe('{"count":2}');
    expect(extraction.individual.map((entry) => [entry.binding.option, entry.value])).toEqual([
      ["--props-name", "Ada"],
      ["--props-loud", "true"],
      ["--props-tag", ["alpha", "beta"]],
    ]);
  });

  it("P5: a boolean binding turns its provisional value into a second request", function* () {
    const scan = scanPromptArgs(["prompt", REQUEST, "--props-loud", "true"]);
    expect(scan.error).toBe(undefined);
    expect(scan.occurrences).toEqual([{ option: "--props-loud", provisional: "true" }]);

    // A candidate that declares `loud` a value option accepts it.
    expect(strayPropertyValue(scan.occurrences, bindingsFor({ loud: { type: "string" } }))).toBe(
      undefined,
    );

    // One that declares it a switch does not: `true` is then a positional.
    const stray = strayPropertyValue(scan.occurrences, bindingsFor({ loud: { type: "boolean" } }));
    expect(stray).toContain("unrecognized argument for xmd prompt: true");
    expect(stray).toContain("--props-loud=true");
  });

  it("P6: a frozen option's shape is what a later candidate may not change", function* () {
    const scalar = bindingsFor({ name: { type: "string" } });
    const boolean = bindingsFor({ name: { type: "boolean" } });
    const array = bindingsFor({ name: { type: "array", items: { type: "string" } } });
    const absent = bindingsFor({ other: { type: "string" } });

    expect(signatureOf(scalar[0])).toEqual({ boolean: false, array: false });
    const stable = frozen({ "--props-name": signatureOf(scalar[0]) });

    // Unchanged: nothing is refused, so the same sources resolve again.
    expect(signatureFailure(stable, scalar)).toBe(undefined);

    expect(signatureFailure(stable, absent)).toContain("declares no such property");
    expect(signatureFailure(stable, boolean)).toContain("single-value option");
    expect(signatureFailure(stable, boolean)).toContain("bare switch");
    expect(signatureFailure(stable, array)).toContain("repeated value option");

    // An option nobody supplied is never frozen, so a candidate may add,
    // remove or reshape it freely.
    expect(signatureFailure(new Map(), absent)).toBe(undefined);
  });
});
