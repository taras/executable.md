/**
 * Tier PR — the `xmd plan` command lifecycle
 * (specs/plan-command-spec.md).
 *
 * The command's grammar, filesystem, journal, lifetime and execution rows: what
 * `xmd plan` does to the disk, to the process status and to the document it
 * ends in. The approved document runs through the production executor, so what
 * these prove about execution is what `xmd run` does with a supplied root.
 *
 * The grammar rows shell out, because exit status and help text are what an
 * operator sees. Everything with a phase to observe runs in process, where a
 * refusal is proven by the tripwires that stayed at zero.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { stat } from "@executablemd/runtime";
import { ensure, Ok, scoped, spawn, until } from "effection";
import type { Operation, Result } from "effection";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import process from "node:process";

import { planExecutor } from "../src/cli.ts";
import { resolveAgentStack } from "../src/agent-stack.ts";
import type { AgentStack } from "../src/agent-stack.ts";
import { runPlan } from "../src/plan.ts";
import type { PlanCommand, PlanExecution } from "../src/plan.ts";
import {
  namesPlan,
  namesRetiredCommand,
  RETIRED_COMMAND_REFUSAL as RETIRED_REFUSAL,
  scanPlanArgs,
} from "../src/plan-args.ts";
import {
  ADAPTERS,
  AGENT,
  createPlanHarness,
  timesRead,
  useEnvironment,
  useRecordedEnvironment,
  useWorkingDirectory,
} from "./support/plan-harness.ts";
import type { PlanHarness } from "./support/plan-harness.ts";

const REQUEST = "write a greeting";

/** A document that declares props and writes what it resolved. */
const GREETER = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "    loud: { type: boolean, default: false }",
  "    count: { type: number }",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  '<File path="greeting.txt">name={props.name} loud={props.loud} count={props.count}</File>',
  "",
].join("\n");

/** An approved Plan proving that `--run --verbose` receives the run-profile default. */
const VERBOSE_PLAN = [
  "ordinary before",
  "",
  "<Verbose>",
  "plan verbose body executed",
  "</Verbose>",
  "",
  "ordinary after",
  "",
].join("\n");

/**
 * A document that validates and then fails at run time.
 *
 * Validation runs no command, so nothing before execution can know this one
 * exits nonzero — which is the point: a runtime failure is not a candidate
 * defect and never returns the command to generation or review.
 */
const FAILS_AT_RUN = ["```bash exec", "exit 3", "```", ""].join("\n");

const PLAIN = "Nothing but prose.\n";

const PROBE_HEADING = "Retired token probe";
const PROBE_SENTINEL = "the document ran";

/**
 * A document whose filename is the retired command spelling.
 *
 * It writes a file, because whether the default `run` grammar reached it is a
 * fact on disk. A case that only watched stdout would pass against a command
 * that executed the document and printed nothing.
 */
const NAMED_LIKE_THE_RETIRED_TOKEN = [
  `# ${PROBE_HEADING}`,
  "",
  `<File path="sentinel.txt">${PROBE_SENTINEL}</File>`,
  "",
].join("\n");

/**
 * A document that validates, runs, and fails its own tests.
 *
 * A `<Testing>` boundary is what makes an assertion decide the outcome of an
 * ordinary run, so this is the approved document that ends in the one failure
 * `xmd run` reports differently from every other: with a heading of its own.
 */
const FAILING_TEST = [
  "<Testing>",
  '<Test name="the approved document disagrees with itself">',
  "<AssertEquals actual={1} expected={2} />",
  "</Test>",
  "</Testing>",
  "",
].join("\n");

/** The Agent configuration a dispatch settles once and hands to both consumers. */
const STACK: AgentStack = {
  provider: "acpx",
  defaultAgent: AGENT,
  permissionMode: "deny-all",
  adapters: ADAPTERS,
};

/**
 * One invocation, asking for the approved Plan to be run.
 *
 * `--run` is the default here because these cases are about the run: what the
 * journal holds, what the document writes, how a runtime failure reports. The
 * modes that write the Plan instead are exercised by their own cases below,
 * which pass `run: false` and say which destination they mean.
 */
function command(dir: string, args: string[], output?: string): PlanCommand {
  const argv = ["plan", ...args, "--run"];
  return {
    argv,
    scan: scanPlanArgs(argv),
    include: [dir],
    ...(output === undefined ? {} : { output }),
    run: true,
    stack: STACK,
  };
}

/** The same invocation, writing the Plan rather than running it. */
function writing(dir: string, args: string[], output?: string): PlanCommand {
  const argv = ["plan", ...args];
  return {
    argv,
    scan: scanPlanArgs(argv),
    include: [dir],
    ...(output === undefined ? {} : { output }),
    run: false,
    stack: STACK,
  };
}

/** The production executor, configured the way the dispatch configures it. */
function executor(
  dir: string,
  journal?: string,
  stack?: AgentStack,
  verbose = false,
): (approved: PlanExecution) => Operation<Result<void>> {
  return planExecutor(
    {
      include: [dir],
      verbose,
      journal,
      raw: true,
      secretDetection: true,
    },
    stack ?? STACK,
    undefined,
    function* () {},
  );
}

function* exists(path: string): Operation<boolean> {
  return (yield* stat(path)).exists;
}

/** Every phase after the refusal, at zero. */
function untouched(harness: PlanHarness): Record<string, number | boolean> {
  return {
    catalogs: harness.catalogCalls.length,
    runtimes: harness.fake.created.length,
    started: harness.fake.started,
    turns: harness.fake.prompts.length,
    reviews: harness.reviews.length,
    executions: harness.executions.length,
  };
}

const NOTHING = {
  catalogs: 0,
  runtimes: 0,
  started: false,
  turns: 0,
  reviews: 0,
  executions: 0,
};

describe(
  "Tier PR — the xmd plan command lifecycle",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("C1: a misplaced individual option refuses before any phase begins", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        const code = yield* runPlan(
          command(dir, ["--props-name", "Ada", REQUEST], "out.md"),
          harness.deps,
        );

        expect(code).toBe(1);
        expect(untouched(harness)).toEqual(NOTHING);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });

      // The agent configuration is settled before the command begins, so an
      // incompatible pair of permission flags costs no inspection at all. Read
      // at the boundary an operator uses, because that is where the resolution
      // the whole invocation shares now happens.
      yield* useWorkingDirectory(function* (dir) {
        const { code, stderr } = yield* runCli(
          ["plan", REQUEST, "--approve-all", "--deny-all", "--run"],
          { cwd: dir },
        ).join();

        expect(code).toBe(1);
        expect(stderr).toContain(
          "--approve-all, --approve-reads, and --deny-all are mutually exclusive",
        );
        // No provider was built: reaching one is what reports an agent as
        // unavailable, and this command line never got that far.
        expect(stderr).not.toContain("unavailable");
      });
    });

    it("C1: --run=false reaches no authorship and no durable effect", function* () {
      // `--run=false` used to be read as the switch, which satisfied the gate
      // that only exists because a run is what makes `--journal` mean anything.
      // The command line was then accepted, nothing ran, and the journal the
      // caller asked for was never created — so the gate answered a request it
      // had not honoured. Nonzero alone would not catch that: the invocation
      // below would have failed anyway, on the agent it cannot reach.
      //
      // This case names the phases that stayed at zero, which a subprocess
      // cannot see. The one after it drives the real parser and dispatch, which
      // this one does not reach — the defect lived exactly between those two
      // layers, so both are needed to pin it.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "trace.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, journal);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const argv = ["plan", REQUEST, "--run=false", "--journal", journal];
        const written = console.error;
        const lines: string[] = [];
        const value = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            console.error = written;
          });
          console.error = (...parts: unknown[]) => {
            lines.push(parts.map((part) => String(part)).join(" "));
          };
          return yield* runPlan(
            { argv, scan: scanPlanArgs(argv), include: [dir], run: false, stack: STACK },
            harness.deps,
          );
        });

        expect(value).toBe(1);
        // The refusal is the one the fixed grammar owes this command line, not
        // an incidental failure further along.
        expect(lines).toEqual([
          "--run does not take a value — write --run to execute the Plan " +
            "or leave it out to write the Plan",
        ]);
        // Every phase after preflight stayed at zero: no catalog, no provider,
        // no turn, no review, no execution.
        expect(untouched(harness)).toEqual(NOTHING);
        // No authorship-profile session was opened either — neither established
        // with the provider nor given a directory to run in.
        expect(harness.fake.ensured).toEqual([]);
        expect(yield* until(readdir(authorshipRoot))).toEqual([]);
        // And nothing durable exists — neither the journal it named, nor an
        // output file, nor anything else.
        expect(yield* exists(journal)).toBe(false);
        expect(yield* until(readdir(dir))).toEqual([]);
      });
    });

    it("C1: a valued --run is refused by the real parser, not just the scanner", function* () {
      // The defect was a disagreement between the scanner and the parser: the
      // scanner read `--run=false` as the switch while the parser read it as
      // false. A case that hands `runPlan` an already-scanned command skips
      // the boundary the bug lived on, so this one goes through the command line
      // an operator actually types.
      const REFUSAL =
        "--run does not take a value — write --run to execute the Plan " +
        "or leave it out to write the Plan";

      for (const spelling of ["--run=false", "--run=true", "--run="]) {
        yield* useWorkingDirectory(function* (dir) {
          const { code, stdout, stderr } = yield* runCli(
            ["plan", REQUEST, spelling, "--journal", "trace.jsonl"],
            { cwd: dir },
          ).join();

          expect(code).toBe(1);
          expect(stderr).toContain(REFUSAL);
          // No approved Plan escaped: stdout is where one would have gone.
          expect(stdout).toBe("");
          // No provider was reached — reaching one is what reports an agent as
          // unavailable, and this command line never got that far.
          expect(stderr).not.toContain("unavailable");
          // And nothing was written: not the journal it named, not an output
          // file, not anything else.
          expect(yield* until(readdir(dir))).toEqual([]);
        });
      }
    });

    it("C1: --save is gone, and is refused as the unknown option it is", function* () {
      // Nothing was released under the old spelling, so there is no alias and
      // nothing to keep compatible with. Proven on a command line that is
      // otherwise entirely valid: a case that also carried a second, earlier
      // failure would pass whether or not `--save` still worked.
      yield* useWorkingDirectory(function* (dir) {
        const { code, stdout, stderr } = yield* runCli(["plan", REQUEST, "--save", "out.md"], {
          cwd: dir,
        }).join();

        expect(code).toBe(1);
        expect(stderr).toContain("--save");
        // Not accepted, not silently dropped, and not mistaken for `--output`.
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        // And nothing downstream of the refusal ran: no catalog was rendered, no
        // provider was reached, nobody was asked anything, no approved source
        // was printed, and no journal exists.
        expect(stdout).toBe("");
        expect(stderr).not.toContain("## Built-in components");
        expect(stderr).not.toContain("unavailable");
        expect(yield* until(readdir(dir))).toEqual([]);
      });
    });

    it("C1: the retired spelling names no command and reaches no authorship", function* () {
      // The command is `plan`. The spelling it replaced is not registered,
      // aliased or kept as a tombstone — and it is not left to the default
      // `run` grammar either, which would read it as a document reference. It
      // is refused in preflight, before any scanner, parse or path lookup.
      expect(namesPlan(["prompt", REQUEST])).toBe(false);
      expect(namesRetiredCommand(["prompt", REQUEST])).toBe(true);
      expect(namesRetiredCommand(["plan", REQUEST])).toBe(false);
      // Only as the first token. `prompt` written anywhere else is an ordinary
      // argument, and this refusal never reaches it.
      expect(namesRetiredCommand(["run", "prompt"])).toBe(false);
      expect(namesRetiredCommand(["plan", "prompt"])).toBe(false);

      yield* useWorkingDirectory(function* (dir) {
        const home = join(dir, "home");
        yield* ensureDir(home);
        const { code, stdout, stderr } = yield* runCli(["prompt", REQUEST], {
          cwd: dir,
          env: { HOME: home },
        }).join();

        expect(code).not.toBe(0);
        expect(stderr).toContain(RETIRED_REFUSAL);
        // Nothing this command owns was reached: no approved source on stdout,
        // no catalog, no provider to report an agent unavailable, no authored
        // refusal from the plan command document, and nobody asked to review.
        // The refusal names `xmd plan` as the spelling to use, so an authored
        // failure is told apart by its own words rather than by that name.
        expect(stdout).toBe("");
        expect(stderr).not.toContain("## Built-in components");
        expect(stderr).not.toContain("unavailable");
        expect(stderr).not.toContain("Nothing was output or run");
        expect(stderr).not.toContain("Request changes");
        // And neither namespace exists under the isolated home: the new one was
        // never opened, and the old one is not read, migrated or created.
        expect(yield* exists(join(home, ".xmd", "plan"))).toBe(false);
        expect(yield* exists(join(home, ".xmd", "prompt"))).toBe(false);
        // No output file and no journal: the only entry is the home this case
        // made for the subprocess.
        expect(yield* until(readdir(dir))).toEqual(["home"]);
      });
    });

    it("C1: the retired token is refused before it can be read as a document path", function* () {
      // The whole reason this is a preflight refusal rather than a fall-through.
      // A first token naming no command is a document reference to the default
      // `run` command, so a file called `prompt` in the working directory was
      // rendered and executed — exit 0, and a file written — by a caller who
      // wrote what they believed was a command. Proven on disk: the document
      // writes a sentinel, so whether it ran is a fact rather than an inference
      // from output nobody produced.
      yield* useWorkingDirectory(function* (dir) {
        const home = join(dir, "home");
        yield* ensureDir(home);
        yield* writeTextFile(join(dir, "prompt"), NAMED_LIKE_THE_RETIRED_TOKEN);
        const options = { cwd: dir, env: { HOME: home } };
        const sentinel = join(dir, "sentinel.txt");

        const refused = yield* runCli(["prompt"], options).join();

        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(RETIRED_REFUSAL);
        // Neither rendered nor executed: its heading reached no stream, and the
        // file it writes was never created.
        expect(refused.stdout).toBe("");
        expect(refused.stderr).not.toContain(PROBE_HEADING);
        expect(yield* exists(sentinel)).toBe(false);
        // No catalog was built, no provider was reached to report an agent
        // unavailable, and no authorship directory was placed — so no Agent and
        // no Session either. The isolated home has no `.xmd` at all.
        expect(refused.stderr).not.toContain("## Built-in components");
        expect(refused.stderr).not.toContain("unavailable");
        expect(yield* exists(join(home, ".xmd"))).toBe(false);
        // And nothing else was written: no output file and no journal. The
        // document and the home this case made are the only entries.
        expect((yield* until(readdir(dir))).sort()).toEqual(["home", "prompt"]);

        // The refusal costs nothing. A document that is legitimately called
        // `prompt` still runs, by the spelling the message itself names — a fix
        // that made this file unrunnable would trade one defect for another.
        const ran = yield* runCli(["run", "./prompt"], options).join();

        expect(ran.code).toBe(0);
        expect(ran.stdout).toContain(PROBE_HEADING);
        expect(yield* readTextFile(sentinel)).toContain(PROBE_SENTINEL);
      });
    });

    it("C1: inline source is refused before any phase begins", function* () {
      // `-e` belongs to `xmd run`. `xmd plan` is the command that *writes* a
      // document, so a second one supplied on the command line is a
      // contradiction — and one the parser used to drop in silence, leaving the
      // caller watching a different document get generated.
      for (const flag of ["-e", "--eval"]) {
        yield* useWorkingDirectory(function* (dir) {
          const { code, stdout, stderr } = yield* runCli(
            [
              "plan",
              REQUEST,
              flag,
              "# supplied",
              "--output",
              "out.md",
              "--run",
              "--journal",
              "trace.jsonl",
            ],
            { cwd: dir },
          ).join();

          expect(code).toBe(1);
          expect(stderr).toContain(
            "unrecognized option for xmd plan: --eval — inline documents are exclusive to xmd run",
          );
          // Every later phase, unreached: no catalog was rendered, no provider
          // was built, no review was asked, and neither named file was made.
          expect(stdout).not.toContain("## Built-in components");
          expect(stderr).not.toContain("unavailable");
          expect(stdout).toBe("");
          expect(yield* exists(join(dir, "out.md"))).toBe(false);
          expect(yield* exists(join(dir, "trace.jsonl"))).toBe(false);
        });
      }
    });

    it("C1: help needs no request and touches nothing", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const { code, stdout, stderr } = yield* runCli(
          [
            "plan",
            "--help",
            "--output",
            "out.md",
            "--journal",
            "trace.jsonl",
            "--default-agent",
            "xmd-nonexistent-agent",
          ],
          { cwd: dir },
        ).join();

        expect(code).toBe(0);
        expect(stdout).toContain("Usage: xmd plan [OPTIONS] [request]");
        expect(stdout).toContain("Exactly one Prompt is required");
        expect(stdout).toContain("--props <json>");
        expect(stdout).toContain("XMD_PROPS");
        // Where an approved Plan goes, and what changes that.
        expect(stdout).toContain("The approved Plan is the result. By default it is written to");
        expect(stdout).toContain("--output <path>");
        expect(stdout).toContain("Write the approved Plan there instead of to stdout");
        expect(stdout).toContain("--run");
        expect(stdout).toContain("Run the approved Plan instead of writing it");
        expect(stdout).toContain("--session <name>");
        // The run-only flags are named as such rather than left to be
        // discovered by a refusal.
        expect(stdout).toContain("are\nrefused without --run");
        // The permission flags are the approved Plan's, and help says so rather
        // than letting a caller believe they configure how the Plan is written.
        expect(stdout).toContain("Permission flags configure the approved Plan");
        expect(stderr).not.toContain("unavailable");
        // No catalog was rendered, and neither file the options named was made.
        expect(stdout).not.toContain("## Built-in components");
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, "trace.jsonl"))).toBe(false);
      });

      const program = yield* runCli(["--help"]).expect();
      expect(program.stdout).toMatch(/^\s+plan\s/m);
      // Named for its result where a person choosing a command reads, and the
      // spelling it replaced is listed nowhere.
      expect(program.stdout).toContain(
        "Create an executable Plan from a Prompt and review it before writing or running it.",
      );
      expect(program.stdout).not.toMatch(/^\s+prompt\s/m);

      // A session is named or it is not selected, and the refusal happens in
      // preflight, beside the request's own — a parser that read the empty value
      // as absent would have used the generated name instead.
      yield* useWorkingDirectory(function* (dir) {
        const empty = yield* runCli(["plan", REQUEST, "--session", ""], { cwd: dir }).join();
        expect(empty.code).toBe(1);
        expect(empty.stderr).toContain("--session needs a name");
        expect(empty.stdout).not.toContain("## Built-in components");

        // A flag that only configures running a Plan, without --run: refused
        // before authorship and before anything reaches the filesystem.
        for (const flag of [["--journal", "trace.jsonl"], ["--raw"], ["--deny-all"]]) {
          const stray = yield* runCli(["plan", REQUEST, ...flag], { cwd: dir }).join();
          expect(stray.code).toBe(1);
          expect(stray.stderr).toContain(`${flag[0]} configures running the Plan`);
          expect(stray.stderr).toContain("add --run");
          expect(stray.stdout).toBe("");
          expect(yield* exists(join(dir, "trace.jsonl"))).toBe(false);
        }
        // That the same flag is ordinary again once `--run` is present is fixed
        // grammar, and is proven there rather than by an invocation that would
        // have to reach a real agent to say so.
      });
    });

    it("C15: individual, aggregate and environment sources resolve and reach the run", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "Approve" });

        yield* useEnvironment({ XMD_PROPS: '{"name":"FromEnv","count":7}' });
        const code = yield* runPlan(
          command(dir, [REQUEST, "--props-name", "Ada", "--props-loud"]),
          harness.deps,
        );

        expect(code).toBe(0);
        // Individual CLI beats the aggregate environment; the switch is true; the
        // property only the aggregate supplied is still there.
        expect(yield* readTextFile(join(dir, "greeting.txt"))).toBe("name=Ada loud=true count=7");
      });
    });

    it("C12: every refusal is nonzero and leaves no output file, journal or run", function* () {
      const journalName = "trace.jsonl";

      // Stop at review, through the command document's authored failure.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, join(dir, journalName));
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Stop" });

        const code = yield* runPlan(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, journalName))).toBe(false);
      });

      // A turn that produced text and then failed.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, join(dir, journalName));
        harness.fake.script({ reply: PLAIN, stopReason: "refusal" });

        const code = yield* runPlan(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(harness.reviews).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, journalName))).toBe(false);
      });

      // A terminal property-source failure.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, join(dir, journalName));
        harness.fake.script({ reply: PLAIN });

        const code = yield* runPlan(
          command(dir, [REQUEST, "--props-absent", "x"], "out.md"),
          harness.deps,
        );

        expect(code).toBe(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, journalName))).toBe(false);
      });

      // An approved run's journal holds the document's events and no authorship.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, journalName);
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, journal);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);

        const trace = yield* readTextFile(journal);
        expect(trace).toContain("__root__");
        expect(trace).toContain(PLAIN.trim());
        // Nothing about generation is in it: not the request, not a turn, not a
        // review, not a repair.
        expect(trace).not.toContain(REQUEST);
        expect(trace).not.toContain("agent_prompt");
        expect(trace).not.toContain("elicit");
      });
    });

    it("C11: the approved Plan is the result, and where it goes is the caller's", function* () {
      // Default: the exact source on stdout, and nothing runs. Written with
      // `process.stdout.write`, so what a pipe receives is the bytes and not a
      // line the command added.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const written: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            process.stdout.write = original;
          });
          process.stdout.write = ((chunk: string | Uint8Array) => {
            written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
          }) as typeof process.stdout.write;
          return yield* runPlan(writing(dir, [REQUEST]), harness.deps);
        });

        expect(code).toBe(0);
        // Byte for byte, once, with nothing around it.
        expect(written.join("")).toBe(PLAIN);
        // And nothing ran: no execution, so no journal and no document effects.
        expect(harness.executions).toHaveLength(0);
        expect(yield* until(readdir(dir))).toEqual([]);
      });

      // `--output`: the same bytes in the file, a quiet stdout, and still no run.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "Approve" });

        const written: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            process.stdout.write = original;
          });
          process.stdout.write = ((chunk: string | Uint8Array) => {
            written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
          }) as typeof process.stdout.write;
          return yield* runPlan(
            {
              ...writing(dir, [REQUEST, "--props-name", "Ada"], "plan.md"),
              argv: ["plan", REQUEST, "--props-name", "Ada", "--output", "plan.md"],
            },
            harness.deps,
          );
        });

        expect(code).toBe(0);
        expect(written.join("")).toBe("");
        expect(yield* readTextFile(join(dir, "plan.md"))).toBe(GREETER);
        // The Plan was not run, so what it would have written is not there.
        expect(harness.executions).toHaveLength(0);
        expect((yield* until(readdir(dir))).sort()).toEqual(["plan.md"]);
      });

      // `--run`: the Plan runs, and stdout is the Plan's own to use.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "Approve" });

        const written: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            process.stdout.write = original;
          });
          process.stdout.write = ((chunk: string | Uint8Array) => {
            written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
          }) as typeof process.stdout.write;
          return yield* runPlan(command(dir, [REQUEST, "--props-name", "Ada"]), harness.deps);
        });

        expect(code).toBe(0);
        // The source itself was never printed.
        expect(written.join("")).not.toContain("props:");
        // The document ran, and did what it says.
        expect(yield* readTextFile(join(dir, "greeting.txt"))).toBe("name=Ada loud=false count=");
      });

      // `--run --verbose`: the approved Plan receives the production
      // run-profile `<Verbose>` component.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, undefined, undefined, true);
        harness.fake.script({ reply: VERBOSE_PLAN });
        harness.script({ decision: "Approve" });

        const written: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            process.stdout.write = original;
          });
          process.stdout.write = ((chunk: string | Uint8Array) => {
            written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
          }) as typeof process.stdout.write;
          return yield* runPlan(command(dir, [REQUEST, "--verbose"]), harness.deps);
        });

        expect(code).toBe(0);
        expect(written.join("")).toContain("ordinary before");
        expect(written.join("")).toContain("plan verbose body executed");
        expect(written.join("")).toContain("ordinary after");
      });
    });

    it("C11: the approved bytes are created exclusively, before the run", function* () {
      // Created before execution, and byte for byte.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        const run = executor(dir);
        const seen: boolean[] = [];
        harness.deps.execute = function* (approved) {
          seen.push(yield* exists(join(dir, "out.md")));
          return yield* run(approved);
        };
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(
          command(dir, [REQUEST, "--props-name", "Ada"], "out.md"),
          harness.deps,
        );

        expect(code).toBe(0);
        // The output file already existed when the document started.
        expect(seen).toEqual([true]);
        // Source only: no diagnostics, no decision, no wrapper.
        expect(yield* readTextFile(join(dir, "out.md"))).toBe(GREETER);
      });

      // An existing path is left exactly as it is, and stops the run.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        yield* writeTextFile(join(dir, "out.md"), "keep me\n");
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(yield* readTextFile(join(dir, "out.md"))).toBe("keep me\n");
        expect(harness.executions).toHaveLength(0);
      });

      // Without the option, no generated source file is created at all.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(command(dir, [REQUEST, "--props-name", "Ada"]), harness.deps);

        expect(code).toBe(0);
        // Only what the document itself wrote.
        expect((yield* until(readdir(dir))).sort()).toEqual(["greeting.txt"]);
      });
    });

    it("C15: the approved source runs as an ordinary document under <plan>", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "trace.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, journal);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(
          command(dir, [REQUEST, "--props-name", "Ada"], "out.md"),
          harness.deps,
        );
        expect(code).toBe(0);

        // The identity the run reports is the deliberate one, and the command
        // owns no other.
        const trace = yield* readTextFile(journal);
        expect(trace).toContain("<plan>");
        expect(trace).not.toContain("<prompt>");
        expect(trace).not.toContain("<plan-command>");
        // Relative filesystem operations resolved the contextual cwd, not the
        // identity, so the document's own write landed beside the output file.
        expect(yield* exists(join(dir, "greeting.txt"))).toBe(true);
        expect(yield* exists(join(dir, "out.md"))).toBe(true);
      });

      // A runtime failure is an ordinary run failure: nonzero, with the file the
      // caller asked for still on disk to hand-edit.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: FAILS_AT_RUN });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(yield* readTextFile(join(dir, "out.md"))).toBe(FAILS_AT_RUN);
        // The failure did not send the run back to generation or review.
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(1);
      });
    });

    it("C15: a failing test in the approved document reports as a run reports it", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: FAILING_TEST });
        harness.script({ decision: "Approve" });

        const written = console.error;
        const lines: string[] = [];
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            console.error = written;
          });
          console.error = (...parts: unknown[]) => {
            lines.push(parts.map((part) => String(part)).join(" "));
          };
          return yield* runPlan(command(dir, [REQUEST], "out.md"), harness.deps);
        });

        expect(code).toBe(1);
        // Byte for byte what `xmd run` prints for this failure: the heading and
        // the blank line above it are how a failed suite is told apart from an
        // ordinary error, and printing only the message would lose both.
        expect(lines.at(-1)).toBe("\ntests failed: 1 test(s) failed in <Testing>");

        // A runtime failure is not a candidate defect: the agent was asked once
        // and the person was asked once, and neither was asked again.
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(1);
        // The file was already written, and a failing run leaves it to hand-edit.
        expect(yield* readTextFile(join(dir, "out.md"))).toBe(FAILING_TEST);
      });
    });

    it("C15: one Agent resolution serves generation and the execution after it", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const reads: string[] = [];
        yield* useRecordedEnvironment(reads, { DEFAULT_AGENT_NAME: "settled-agent" });

        // What a dispatch settles, once, for the whole invocation.
        const settled = yield* resolveAgentStack(
          {
            agentProvider: "acpx",
            defaultAgent: undefined,
            approveAll: false,
            approveReads: false,
            denyAll: true,
          },
          undefined,
        );
        if (!settled.ok) {
          throw settled.error;
        }
        const stack = settled.value;
        expect(stack.defaultAgent).toBe("settled-agent");
        expect(timesRead(reads, "DEFAULT_AGENT_NAME")).toBe(1);

        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir, undefined, stack);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan({ ...command(dir, [REQUEST]), stack }, harness.deps);

        expect(code).toBe(0);
        // The command document resolved the settled agent rather than a name of
        // its own.
        expect(harness.fake.ensured.map((input) => input.agent)).toEqual(["settled-agent"]);
        // And nothing after it read the name again: authorship and the document
        // installation that followed were both configured from the one answer,
        // so they cannot disagree about which agent this invocation meant.
        expect(timesRead(reads, "DEFAULT_AGENT_NAME")).toBe(1);
      });
    });

    it("C13: the deadline encloses every phase, and teardown gates what follows", function* () {
      // Expiry is cancellation, so the proof is what cancelling the command does:
      // the turn in flight is cancelled, the provider is dismantled, and no later
      // phase begins. The barrier is what makes this a gate rather than a race —
      // the turn it interrupts is known to be running.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: PLAIN, manual: true });

        yield* scoped(function* () {
          const running = yield* spawn(() =>
            runPlan(command(dir, [REQUEST], "out.md"), harness.deps),
          );
          yield* harness.fake.startedTurns(1);
          yield* running.halt();
        });

        expect(harness.fake.cancels).toBeGreaterThanOrEqual(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });

      // A teardown failure prevents the final admission, the output file and the run,
      // whatever the command document selected.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.execute = executor(dir);
        harness.fake.closeFailure = new Error("the profile provider would not close");
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });

      // Nothing bounds an authoring turn: the exec and fetch defaults belong to
      // the document, and the run deadline is the enclosing timebox above.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        // deno-lint-ignore require-yield
        harness.deps.execute = function* () {
          return Ok(undefined);
        };
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const code = yield* runPlan(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);
        expect(harness.fake.turns[0]?.timeoutMs).toBe(undefined);
      });
    });

    it("C13: the deadline is the whole plan command's, as it is a run's", function* () {
      // Read for plan exactly as for run: a value that is not a duration fails
      // the invocation before it prepares anything.
      for (const flag of ["--timeout", "--timeout-exec", "--timeout-fetch"]) {
        const { code, stderr } = yield* runCli(["plan", REQUEST, `${flag}=abc`]).join();
        expect(code).toBe(1);
        expect(stderr).toContain(flag);
      }

      // And it bounds the command rather than only its final document: the
      // deadline expires while the catalog is still being built, long before any
      // document exists to bound.
      const expired = yield* runCli(["plan", REQUEST, "--timeout=1ms"]).join();
      expect(expired.code).toBe(1);
      expect(expired.stderr).toContain("exceeded its --timeout of 1ms and was cancelled");
    });
  },
);
