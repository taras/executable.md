/**
 * Tier PR — `xmd plan` fixed grammar (specs/plan-command-spec.md).
 *
 * Rows P1–P6, in the half that is decidable without a document. `scanPlanArgs`
 * is a pure function over argv, so what the command line means — and every
 * refusal it earns — is asserted directly rather than inferred from a process
 * that printed nothing.
 *
 * The rest of P5 and P6 live in `plan.test.ts`, where a candidate schema
 * exists to bind against.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import {
  isReservedOption,
  namesPlan,
  namesRetiredCommand,
  RETIRED_COMMAND_REFUSAL,
  scanPlanArgs,
  signatureFailure,
  signatureOf,
  strayPropertyValue,
} from "../src/plan-args.ts";
import type { OptionSignature } from "../src/plan-args.ts";
import { buildBindings, extractPropsArgs, PropsError } from "../src/props.ts";
import type { Binding } from "../src/props.ts";

const REQUEST = "ask me for my age and write the result to a file";

function bindingsFor(properties: Record<string, unknown>): Binding[] {
  return buildBindings({ type: "object", properties, additionalProperties: false });
}

function frozen(entries: Record<string, OptionSignature>): Map<string, OptionSignature> {
  return new Map(Object.entries(entries));
}

describe("Tier PR — xmd plan fixed grammar", () => {
  it("C1: exactly one request, kept byte for byte", function* () {
    expect(namesPlan(["plan", REQUEST])).toBe(true);
    expect(namesPlan(["run", "doc.md"])).toBe(false);
    // The command is named `plan` and nothing else names it: the retired
    // spelling selects no command, so it never reaches this grammar at all.
    expect(namesPlan(["prompt", REQUEST])).toBe(false);

    // It is refused instead of being left to the default `run` grammar, which
    // would read a token naming no command as a document reference. Recognized
    // by the exact first token and nothing else, so `prompt` written as an
    // argument — including a document that really is called that — is untouched.
    expect(namesRetiredCommand(["prompt"])).toBe(true);
    expect(namesRetiredCommand(["prompt", REQUEST])).toBe(true);
    expect(namesRetiredCommand(["plan", REQUEST])).toBe(false);
    expect(namesRetiredCommand(["run", "prompt"])).toBe(false);
    expect(namesRetiredCommand(["run", "./prompt"])).toBe(false);
    expect(namesRetiredCommand(["./prompt"])).toBe(false);
    expect(namesRetiredCommand(["prompt.md"])).toBe(false);
    expect(namesRetiredCommand([])).toBe(false);

    // Both readings are answered: the command somebody meant, and the document
    // they may actually have.
    expect(RETIRED_COMMAND_REFUSAL).toBe(
      'xmd prompt is not a command — use `xmd plan "<Prompt>"` to create a Plan, or ' +
        "`xmd run ./prompt` to run a document named `prompt`",
    );

    const one = scanPlanArgs(["plan", REQUEST]);
    expect(one.error).toBe(undefined);
    expect(one.request).toBe(REQUEST);

    // Preserved, not trimmed: trimming is only how emptiness is tested.
    const padded = scanPlanArgs(["plan", `  ${REQUEST}\n`]);
    expect(padded.error).toBe(undefined);
    expect(padded.request).toBe(`  ${REQUEST}\n`);

    expect(scanPlanArgs(["plan"]).error).toContain("requires one request");
    expect(scanPlanArgs(["plan", "", "--raw"]).error).toContain("non-whitespace");
    expect(scanPlanArgs(["plan", " \t\n "]).error).toContain("non-whitespace");
    expect(scanPlanArgs(["plan", REQUEST, "second"]).error).toContain(
      "unrecognized argument for xmd plan: second",
    );

    // A request that begins with a dash is written after the separator, and is
    // still exactly one request.
    const separated = scanPlanArgs(["plan", "--", "--not-an-option"]);
    expect(separated.error).toBe(undefined);
    expect(separated.request).toBe("--not-an-option");
    // And it is kept out of the parser's argv, so nothing reads it as an option.
    expect(separated.fixed).toEqual(["plan"]);
  });

  it("C1: individual options follow the request, aggregate props may precede it", function* () {
    const early = scanPlanArgs(["plan", "--props-name", "Ada", REQUEST]);
    expect(early.error).toContain("unrecognized option: --props-name");
    expect(early.error).toContain("follow the request");
    // Refused before anything is classified: no request was adopted from the
    // tokens that followed, and no occurrence was recorded.
    expect(early.request).toBe(undefined);
    expect(early.occurrences).toEqual([]);

    const aggregate = scanPlanArgs([
      "plan",
      "--props",
      '{"name":"Ada"}',
      REQUEST,
      "--raw",
      "--run",
    ]);
    expect(aggregate.error).toBe(undefined);
    expect(aggregate.request).toBe(REQUEST);
    // The aggregate never reaches the parser: it coerces a separated value
    // through Number() before any schema could judge it.
    expect(aggregate.fixed).toEqual(["plan", REQUEST, "--raw", "--run"]);

    const inline = scanPlanArgs(["plan", '--props={"name":"Ada"}', REQUEST]);
    expect(inline.error).toBe(undefined);
    expect(inline.fixed).toEqual(["plan", REQUEST]);
  });

  it("C1: built-in options after generated props stay with the invocation", function* () {
    const scan = scanPlanArgs([
      "plan",
      REQUEST,
      "--props-name",
      "Ada",
      "--raw",
      "--include",
      "lib",
      "--props-loud",
      "--journal",
      "trace.jsonl",
      "--output",
      "out.md",
      "--session",
      "ada",
      "--run",
    ]);
    expect(scan.error).toBe(undefined);
    expect(scan.request).toBe(REQUEST);
    expect(scan.fixed).toEqual([
      "plan",
      REQUEST,
      "--raw",
      "--include",
      "lib",
      "--journal",
      "trace.jsonl",
      "--output",
      "out.md",
      "--session",
      "ada",
      "--run",
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
      extractPropsArgs(["plan", REQUEST, "--props-loud", "--raw"], bindings, {
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

  it("C1: scalar, boolean and aggregate sources are all recorded", function* () {
    const scan = scanPlanArgs([
      "plan",
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
        "plan",
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

  it("C1: a boolean binding turns its provisional value into a second request", function* () {
    const scan = scanPlanArgs(["plan", REQUEST, "--props-loud", "true"]);
    expect(scan.error).toBe(undefined);
    expect(scan.occurrences).toEqual([{ option: "--props-loud", provisional: "true" }]);

    // A candidate that declares `loud` a value option accepts it.
    expect(strayPropertyValue(scan.occurrences, bindingsFor({ loud: { type: "string" } }))).toBe(
      undefined,
    );

    // One that declares it a switch does not: `true` is then a positional.
    const stray = strayPropertyValue(scan.occurrences, bindingsFor({ loud: { type: "boolean" } }));
    expect(stray).toContain("unrecognized argument for xmd plan: true");
    expect(stray).toContain("--props-loud=true");
  });

  it("C1: options that only configure a run need --run to mean anything", function* () {
    // Each of them describes work that a command writing a Plan never does. A
    // caller who asked for a journal, a permission mode or an exec deadline and
    // got a command that creates none of them was not answered.
    // Every spelling, including the short forms and both secret-detection
    // switches: a table that covered only the long names would leave `-V` and
    // `--secret-detection` accepted and ignored.
    for (const flag of [
      ["--journal", "trace.jsonl"],
      ["-j", "trace.jsonl"],
      ["--raw"],
      ["--verbose"],
      ["-V"],
      ["--timeout-exec", "5s"],
      ["--timeout-fetch", "5s"],
      ["--approve-all"],
      ["--approve-reads"],
      ["--deny-all"],
      ["--secret-detection"],
      ["--no-secret-detection"],
    ]) {
      const refused = scanPlanArgs(["plan", REQUEST, ...flag]);
      expect(refused.error).toContain(`${flag[0]} configures running the Plan`);
      expect(refused.error).toContain("add --run");

      // With `--run` the same command line is ordinary, wherever the two are
      // written relative to each other.
      expect(scanPlanArgs(["plan", REQUEST, ...flag, "--run"]).error).toBe(undefined);
      expect(scanPlanArgs(["plan", REQUEST, "--run", ...flag]).error).toBe(undefined);
    }

    // The options the command always uses are never refused: they build the
    // catalog, settle the agent, name the session, bound the command and say
    // where the Plan goes.
    for (const flag of [
      ["--include", "lib"],
      ["--agent-provider", "acpx"],
      ["--default-agent", "codex"],
      ["--session", "ada"],
      ["--timeout", "5s"],
      ["--output", "plan.md"],
    ]) {
      expect(scanPlanArgs(["plan", REQUEST, ...flag]).error).toBe(undefined);
    }
  });

  it("C1: --run is a switch, and every valued spelling of it is refused", function* () {
    // An option name is read up to its first `=`, so `--run=false` arrives under
    // the name of the switch. Taken as the switch it would establish the
    // opposite of what was written, and satisfy the run-only gate on the way.
    const REFUSAL =
      "--run does not take a value — write --run to execute the Plan " +
      "or leave it out to write the Plan";

    for (const spelling of ["--run=false", "--run=true", "--run="]) {
      const scan = scanPlanArgs(["plan", REQUEST, spelling]);
      expect(scan.error).toBe(REFUSAL);
      // It established nothing: the token reached neither the parser's argv nor
      // the record of what this invocation asked for.
      expect(scan.fixed).toEqual(["plan", REQUEST]);

      // And it does not answer for `--run` where a run is what makes an option
      // meaningful. Without the fix this command line is accepted, and then
      // nothing runs — so the journal the caller asked for is never created.
      const gated = scanPlanArgs(["plan", REQUEST, spelling, "--journal", "trace.jsonl"]);
      expect(gated.error).toBe(REFUSAL);
      expect(gated.fixed).toEqual(["plan", REQUEST]);
    }

    // The switch itself is unaffected, wherever it is written.
    expect(scanPlanArgs(["plan", REQUEST, "--run"]).error).toBe(undefined);
    expect(scanPlanArgs(["plan", REQUEST, "--run", "--journal", "t.jsonl"]).error).toBe(undefined);
  });

  it("C1: an option this command does not define is refused, not dropped", function* () {
    // The parser stops at the first option it does not define and drops the
    // rest, so silence here would mean accepting a command line nobody honoured.
    const unknown = scanPlanArgs(["plan", REQUEST, "--not-a-thing", "value"]);
    expect(unknown.error).toBe("unrecognized option for xmd plan: --not-a-thing");

    // `--save` was replaced before release, so there is no alias — and the
    // refusal says where the Plan goes now rather than only that the option is
    // unknown.
    const retired = scanPlanArgs(["plan", REQUEST, "--save", "out.md"]);
    expect(retired.error).toContain("unrecognized option for xmd plan: --save");
    expect(retired.error).toContain("goes to stdout");
    expect(retired.error).toContain("--output writes it to a file");
    // It is not quietly read as the option that replaced it.
    expect(retired.occurrences).toEqual([]);
  });

  it("C7: a frozen option's shape is what a later candidate may not change", function* () {
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
