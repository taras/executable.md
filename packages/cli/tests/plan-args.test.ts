/**
 * Tier PR — `xmd plan` fixed grammar (specs/plan-command-spec.md).
 *
 * Rows PS1–PS3. `scanPlanArgs` is a pure function over argv, so what the
 * command line means — and every refusal it earns — is asserted directly rather
 * than inferred from a process that printed nothing.
 *
 * The grammar is complete here, because the command produces source rather than
 * running it: no generated document adds an option later, so nothing about this
 * command line waits on a candidate schema. What a refusal *reaches* is
 * `plan-cli.test.ts`, where the phases that stayed at zero are observable.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import {
  namesPlan,
  namesRetiredCommand,
  removedOptionRefusal,
  removedPlanOption,
  RETIRED_COMMAND_REFUSAL,
  RUN_REMOVAL_REFUSAL,
  scanPlanArgs,
} from "../src/plan-args.ts";

const REQUEST = "ask me for my age and write the result to a file";

/** Every option the command still defines, with a value where it takes one. */
const RETAINED: readonly string[][] = [
  ["--include", "lib"],
  ["--agent-provider", "acpx"],
  ["--default-agent", "codex"],
  ["--session", "ada"],
  ["--timeout", "5s"],
  ["--output", "plan.md"],
];

/**
 * One representative of every removed option class.
 *
 * Both short aliases are named, because a table of long names alone would leave
 * `-V` and `-j` accepted and dropped by the parser; both secret-detection
 * spellings are named for the same reason.
 */
const REMOVED: readonly string[][] = [
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
  ["--props", '{"name":"Ada"}'],
  ["--props-name", "Ada"],
  ["--props-loud"],
  ["--no-props-loud"],
];

describe("Tier PR — xmd plan fixed grammar", () => {
  it("PS1: exactly one request, kept byte for byte", function* () {
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
    expect(scanPlanArgs(["plan", ""]).error).toContain("non-whitespace");
    expect(scanPlanArgs(["plan", " \t\n "]).error).toContain("non-whitespace");
    // The approved sentence, exactly: it names the token and says what the
    // command takes, and nothing about property ordering — there are no
    // generated properties left to order.
    expect(scanPlanArgs(["plan", REQUEST, "second"]).error).toBe(
      "unrecognized argument for xmd plan: second — the command takes exactly one request",
    );

    // A request that begins with a dash is written after the separator, and is
    // still exactly one request.
    const separated = scanPlanArgs(["plan", "--", "--not-an-option"]);
    expect(separated.error).toBe(undefined);
    expect(separated.request).toBe("--not-an-option");
    // And it is kept out of the parser's argv, so nothing reads it as an option.
    expect(separated.fixed).toEqual(["plan"]);
  });

  it("PS1: every retained option is accepted, before and after the request", function* () {
    for (const option of RETAINED) {
      expect(scanPlanArgs(["plan", REQUEST, ...option]).error).toBe(undefined);
      expect(scanPlanArgs(["plan", ...option, REQUEST]).error).toBe(undefined);
    }

    // All of them at once, and every token reaches the parser in the order it
    // was written: the invocation keeps its own options rather than losing one
    // to a neighbour.
    const scan = scanPlanArgs(["plan", REQUEST, ...RETAINED.flat()]);
    expect(scan.error).toBe(undefined);
    expect(scan.request).toBe(REQUEST);
    expect(scan.fixed).toEqual(["plan", REQUEST, ...RETAINED.flat()]);

    // `--session` still needs a name. An option the parser reads as absent
    // falls back to the generated session, so a caller who asked for a named
    // one and named none would silently get a different conversation.
    expect(scanPlanArgs(["plan", REQUEST, "--session"]).error).toContain("--session needs a name");
    expect(scanPlanArgs(["plan", REQUEST, "--session="]).error).toContain("--session needs a name");
  });

  it("PS2: every --run spelling reports the migration, and establishes nothing", function* () {
    expect(RUN_REMOVAL_REFUSAL).toBe(
      [
        "xmd plan --run was removed because xmd plan only produces approved source.",
        "Run the program explicitly:",
        '  xmd plan "..." | xmd run -',
        '  xmd plan "..." --output release.md && xmd run release.md',
      ].join("\n"),
    );

    const spellings = [
      ["plan", REQUEST, "--run"],
      ["plan", REQUEST, "--run=true"],
      ["plan", REQUEST, "--run=false"],
      ["plan", REQUEST, "--run="],
      ["plan", REQUEST, "--run", "--run"],
      ["plan", "--run", REQUEST],
      ["plan", "--run=false", REQUEST],
      // Written where a retained option would otherwise swallow it: a value
      // nobody names a directory is how a removed spelling survives.
      ["plan", REQUEST, "--include", "--run"],
      ["plan", REQUEST, "--output", "--run"],
      // And after the options a caller does keep, so placement decides nothing.
      ["plan", REQUEST, "--session", "ada", "--run"],
    ];
    for (const argv of spellings) {
      const scan = scanPlanArgs(argv);
      expect(scan.error).toBe(RUN_REMOVAL_REFUSAL);
      // No hidden field survives it: the token reached neither the parser's
      // argv nor anything this scan established beyond the request itself.
      expect(scan.fixed).not.toContain("--run");
      expect(Object.keys(scan).toSorted()).toEqual(
        scan.request === undefined ? ["error", "fixed"] : ["error", "fixed", "request"],
      );
    }

    // There is no alias, and no compatibility spelling that means the same
    // thing: `--execute` is simply an option this command does not define.
    expect(scanPlanArgs(["plan", REQUEST, "--execute"]).error).toBe(
      "unrecognized option for xmd plan: --execute",
    );
  });

  it("PS3: every other removed option reports the one generic refusal", function* () {
    expect(removedOptionRefusal("--journal")).toBe(
      "unrecognized option for xmd plan: --journal — configure the program when you run " +
        "the approved source with xmd run",
    );

    for (const option of REMOVED) {
      const [name] = option;
      const after = scanPlanArgs(["plan", REQUEST, ...option]);
      expect(after.error).toBe(removedOptionRefusal(name));
      // It did not consume the token written after it, and it did not become a
      // second positional first: the refusal is the option's own.
      expect(after.fixed).toEqual(["plan", REQUEST]);

      // The same answer before the request, where a generated property option
      // used to be told about ordering instead.
      expect(scanPlanArgs(["plan", ...option, REQUEST]).error).toBe(removedOptionRefusal(name));

      // And in the inline form, whose name is read up to the first `=`.
      expect(scanPlanArgs(["plan", REQUEST, `${name}=value`]).error).toBe(
        removedOptionRefusal(name),
      );
    }
  });

  it("PS2/PS3: the removal is decidable beside --help, in either order", function* () {
    // `--help` is lifted out of argv before any command's own grammar runs, so
    // the classification has to be askable on its own — otherwise the page a
    // caller gets describes a command that would have refused them.
    expect(removedPlanOption(["plan", "--help", "--run"])).toBe(RUN_REMOVAL_REFUSAL);
    expect(removedPlanOption(["plan", "--run", "--help"])).toBe(RUN_REMOVAL_REFUSAL);
    expect(removedPlanOption(["plan", "--help", "--journal", "trace.jsonl"])).toBe(
      removedOptionRefusal("--journal"),
    );
    expect(removedPlanOption(["plan", "--journal", "trace.jsonl", "--help"])).toBe(
      removedOptionRefusal("--journal"),
    );

    // And it is the same classification the scan makes, so a spelling cannot be
    // removed to one and unknown to the other.
    for (const option of REMOVED) {
      expect(removedPlanOption(["plan", REQUEST, ...option])).toBe(
        scanPlanArgs(["plan", REQUEST, ...option]).error,
      );
    }

    // A command line naming none of them has nothing to say here, whatever else
    // it holds — including the retained options and `--help` itself.
    expect(removedPlanOption(["plan", "--help"])).toBe(undefined);
    expect(removedPlanOption(["plan", REQUEST, ...RETAINED.flat()])).toBe(undefined);
    // A token after the separator is the request, not an option.
    expect(removedPlanOption(["plan", "--", "--run"])).toBe(undefined);
  });

  it("PS3: a name that merely begins like a property option is an unknown one", function* () {
    // Exactly the aggregate and the two generated prefixes are property
    // options. Telling a caller who wrote something else to configure their
    // program with `xmd run` would answer a question they did not ask.
    for (const name of ["--propspective", "--no-propspective", "--no-props", "--propsy"]) {
      expect(scanPlanArgs(["plan", REQUEST, name]).error).toBe(
        `unrecognized option for xmd plan: ${name}`,
      );
      expect(removedPlanOption(["plan", REQUEST, name])).toBe(undefined);
    }

    // While the real spellings are still the removed options they are.
    for (const name of ["--props", "--props-name", "--no-props-loud"]) {
      expect(scanPlanArgs(["plan", REQUEST, name]).error).toBe(removedOptionRefusal(name));
    }
  });

  it("PS3: an option this command does not define is refused, not dropped", function* () {
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
    expect(retired.fixed).toEqual(["plan", REQUEST]);
  });
});
