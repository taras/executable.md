/**
 * Tier PR — the `xmd prompt` command lifecycle
 * (specs/prompt-command-spec.md).
 *
 * The command's grammar, filesystem, journal, lifetime and execution rows: what
 * `xmd prompt` does to the disk, to the process status and to the document it
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
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { stat } from "@executablemd/runtime";
import { ensure, Ok, scoped, spawn } from "effection";
import type { Operation, Result } from "effection";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { until } from "effection";

import { promptExecutor } from "../src/cli.ts";
import { resolveAgentStack } from "../src/agent-stack.ts";
import type { AgentStack } from "../src/agent-stack.ts";
import { runPrompt } from "../src/prompt.ts";
import type { PromptCommand, PromptExecution } from "../src/prompt.ts";
import { scanPromptArgs } from "../src/prompt-args.ts";
import {
  AGENT,
  createPromptHarness,
  timesRead,
  useEnvironment,
  useRecordedEnvironment,
  useWorkingDirectory,
} from "./support/prompt-harness.ts";
import type { PromptHarness } from "./support/prompt-harness.ts";

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

/**
 * A document that validates and then fails at run time.
 *
 * Validation runs no command, so nothing before execution can know this one
 * exits nonzero — which is the point: a runtime failure is not a candidate
 * defect and never returns the command to generation or review.
 */
const FAILS_AT_RUN = ["```bash exec", "exit 3", "```", ""].join("\n");

const PLAIN = "Nothing but prose.\n";

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
};

function command(dir: string, args: string[], save?: string): PromptCommand {
  const argv = ["prompt", ...args];
  return {
    argv,
    scan: scanPromptArgs(argv),
    include: [dir],
    ...(save === undefined ? {} : { save }),
    stack: STACK,
  };
}

/** The production executor, configured the way the dispatch configures it. */
function executor(
  dir: string,
  journal?: string,
  stack?: AgentStack,
): (approved: PromptExecution) => Operation<Result<void>> {
  return promptExecutor(
    {
      include: [dir],
      verbose: false,
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
function untouched(harness: PromptHarness): Record<string, number | boolean> {
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
  "Tier PR — the xmd prompt command",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("C1: a misplaced individual option refuses before any phase begins", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        const code = yield* runPrompt(
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
          ["prompt", REQUEST, "--approve-all", "--deny-all", "--save", "out.md"],
          { cwd: dir },
        ).join();

        expect(code).toBe(1);
        expect(stderr).toContain(
          "--approve-all, --approve-reads, and --deny-all are mutually exclusive",
        );
        // No provider was built: reaching one is what reports an agent as
        // unavailable, and this command line never got that far.
        expect(stderr).not.toContain("unavailable");
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });
    });

    it("C1: inline source is refused before any phase begins", function* () {
      // `-e` belongs to `xmd run`. `xmd prompt` is the command that *writes* a
      // document, so a second one supplied on the command line is a
      // contradiction — and one the parser used to drop in silence, leaving the
      // caller watching a different document get generated.
      for (const flag of ["-e", "--eval"]) {
        yield* useWorkingDirectory(function* (dir) {
          const { code, stdout, stderr } = yield* runCli(
            ["prompt", REQUEST, flag, "# supplied", "--save", "out.md", "--journal", "trace.jsonl"],
            { cwd: dir },
          ).join();

          expect(code).toBe(1);
          expect(stderr).toContain(
            "unrecognized option for xmd prompt: --eval — inline documents are exclusive to xmd run",
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
            "prompt",
            "--help",
            "--save",
            "out.md",
            "--journal",
            "trace.jsonl",
            "--default-agent",
            "xmd-nonexistent-agent",
          ],
          { cwd: dir },
        ).join();

        expect(code).toBe(0);
        expect(stdout).toContain("Usage: xmd prompt [OPTIONS] [request]");
        expect(stdout).toContain("Exactly one request is required");
        expect(stdout).toContain("--props <json>");
        expect(stdout).toContain("XMD_PROPS");
        expect(stdout).toContain("--save <path>");
        expect(stdout).toContain("--session <name>");
        // The permission flags are the approved document's, and help says so
        // rather than letting a caller believe they configure how the Plan is
        // written.
        expect(stdout).toContain("Permission flags configure the approved document");
        expect(stderr).not.toContain("unavailable");
        // No catalog was rendered, and neither file the options named was made.
        expect(stdout).not.toContain("## Built-in components");
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, "trace.jsonl"))).toBe(false);
      });

      const program = yield* runCli(["--help"]).expect();
      expect(program.stdout).toMatch(/^\s+prompt\s/m);

      // A session is named or it is not selected, and the refusal happens in
      // preflight, beside the request's own — a parser that read the empty value
      // as absent would have used the generated name instead.
      yield* useWorkingDirectory(function* (dir) {
        const empty = yield* runCli(["prompt", REQUEST, "--session", ""], { cwd: dir }).join();
        expect(empty.code).toBe(1);
        expect(empty.stderr).toContain("--session needs a name");
        expect(empty.stdout).not.toContain("## Built-in components");
      });
    });

    it("C15: individual, aggregate and environment sources resolve and reach the run", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "approve" });

        yield* useEnvironment({ XMD_PROPS: '{"name":"FromEnv","count":7}' });
        const code = yield* runPrompt(
          command(dir, [REQUEST, "--props-name", "Ada", "--props-loud"]),
          harness.deps,
        );

        expect(code).toBe(0);
        // Individual CLI beats the aggregate environment; the switch is true; the
        // property only the aggregate supplied is still there.
        expect(yield* readTextFile(join(dir, "greeting.txt"))).toBe("name=Ada loud=true count=7");
      });
    });

    it("C12: every refusal is nonzero and leaves no save, journal or run", function* () {
      const journalName = "trace.jsonl";

      // Abort at review, through the command document's authored failure.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir, join(dir, journalName));
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "abort" });

        const code = yield* runPrompt(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, journalName))).toBe(false);
      });

      // A turn that produced text and then failed.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir, join(dir, journalName));
        harness.fake.script({ reply: PLAIN, stopReason: "refusal" });

        const code = yield* runPrompt(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(harness.reviews).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, journalName))).toBe(false);
      });

      // A terminal property-source failure.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir, join(dir, journalName));
        harness.fake.script({ reply: PLAIN });

        const code = yield* runPrompt(
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
      yield* useWorkingDirectory(function* (dir) {
        const journal = join(dir, journalName);
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir, journal);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
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

    it("C11: the approved bytes are created exclusively, before the run", function* () {
      // Created before execution, and byte for byte.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        const run = executor(dir);
        const seen: boolean[] = [];
        harness.deps.execute = function* (approved) {
          seen.push(yield* exists(join(dir, "out.md")));
          return yield* run(approved);
        };
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(
          command(dir, [REQUEST, "--props-name", "Ada"], "out.md"),
          harness.deps,
        );

        expect(code).toBe(0);
        // The saved file already existed when the document started.
        expect(seen).toEqual([true]);
        // Source only: no diagnostics, no decision, no wrapper.
        expect(yield* readTextFile(join(dir, "out.md"))).toBe(GREETER);
      });

      // An existing path is left exactly as it is, and stops the run.
      yield* useWorkingDirectory(function* (dir) {
        yield* writeTextFile(join(dir, "out.md"), "keep me\n");
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(yield* readTextFile(join(dir, "out.md"))).toBe("keep me\n");
        expect(harness.executions).toHaveLength(0);
      });

      // Without the option, no generated source file is created at all.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST, "--props-name", "Ada"]), harness.deps);

        expect(code).toBe(0);
        // Only what the document itself wrote.
        expect((yield* until(readdir(dir))).sort()).toEqual(["greeting.txt"]);
      });
    });

    it("C15: the approved source runs as an ordinary document under <prompt>", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const journal = join(dir, "trace.jsonl");
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir, journal);
        harness.fake.script({ reply: GREETER });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(
          command(dir, [REQUEST, "--props-name", "Ada"], "out.md"),
          harness.deps,
        );
        expect(code).toBe(0);

        // The identity the run reports is the deliberate one.
        expect(yield* readTextFile(journal)).toContain("<prompt>");
        // Relative filesystem operations resolved the contextual cwd, not the
        // identity, so the document's own write landed beside the save.
        expect(yield* exists(join(dir, "greeting.txt"))).toBe(true);
        expect(yield* exists(join(dir, "out.md"))).toBe(true);
      });

      // A runtime failure is an ordinary run failure: nonzero, with the save the
      // caller asked for still on disk to hand-edit.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: FAILS_AT_RUN });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(yield* readTextFile(join(dir, "out.md"))).toBe(FAILS_AT_RUN);
        // The failure did not send the run back to generation or review.
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(1);
      });
    });

    it("C15: a failing test in the approved document reports as a run reports it", function* () {
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: FAILING_TEST });
        harness.script({ decision: "approve" });

        const written = console.error;
        const lines: string[] = [];
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            console.error = written;
          });
          console.error = (...parts: unknown[]) => {
            lines.push(parts.map((part) => String(part)).join(" "));
          };
          return yield* runPrompt(command(dir, [REQUEST], "out.md"), harness.deps);
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
        // The save already happened, and a failing run leaves it to hand-edit.
        expect(yield* readTextFile(join(dir, "out.md"))).toBe(FAILING_TEST);
      });
    });

    it("C15: one Agent resolution serves generation and the execution after it", function* () {
      yield* useWorkingDirectory(function* (dir) {
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

        const harness = createPromptHarness();
        harness.deps.execute = executor(dir, undefined, stack);
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt({ ...command(dir, [REQUEST]), stack }, harness.deps);

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
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.script({ reply: PLAIN, manual: true });

        yield* scoped(function* () {
          const running = yield* spawn(() =>
            runPrompt(command(dir, [REQUEST], "out.md"), harness.deps),
          );
          yield* harness.fake.startedTurns(1);
          yield* running.halt();
        });

        expect(harness.fake.cancels).toBeGreaterThanOrEqual(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });

      // A teardown failure prevents the final validation, the save and the run,
      // whatever the command document selected.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.closeFailure = new Error("the profile provider would not close");
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });

      // Nothing bounds an authoring turn: the exec and fetch defaults belong to
      // the document, and the run deadline is the enclosing timebox above.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        // deno-lint-ignore require-yield
        harness.deps.execute = function* () {
          return Ok(undefined);
        };
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);
        expect(harness.fake.turns[0]?.timeoutMs).toBe(undefined);
      });
    });

    it("C13: the deadline is the whole prompt command's, as it is a run's", function* () {
      // Read for prompt exactly as for run: a value that is not a duration fails
      // the invocation before it prepares anything.
      for (const flag of ["--timeout", "--timeout-exec", "--timeout-fetch"]) {
        const { code, stderr } = yield* runCli(["prompt", REQUEST, `${flag}=abc`]).join();
        expect(code).toBe(1);
        expect(stderr).toContain(flag);
      }

      // And it bounds the command rather than only its final document: the
      // deadline expires while the catalog is still being built, long before any
      // document exists to bound.
      const expired = yield* runCli(["prompt", REQUEST, "--timeout=1ms"]).join();
      expect(expired.code).toBe(1);
      expect(expired.stderr).toContain("exceeded its --timeout of 1ms and was cancelled");
    });
  },
);
