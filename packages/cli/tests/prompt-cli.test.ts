/**
 * Tier PR — the `xmd prompt` command lifecycle
 * (specs/prompt-command-spec.md).
 *
 * Rows P2, P4 and P13–P16: what the command does to the filesystem, the
 * journal, the process status and the document it ends in. The approved
 * document runs through the production executor, so what these prove about
 * execution is what `xmd run` does with a supplied root.
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
import { Ok, scoped, spawn } from "effection";
import type { Operation, Result } from "effection";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { until } from "effection";

import { promptExecutor } from "../src/cli.ts";
import { runPrompt } from "../src/prompt.ts";
import type { PromptCommand, PromptExecution } from "../src/prompt.ts";
import { scanPromptArgs } from "../src/prompt-args.ts";
import {
  AGENT,
  createPromptHarness,
  useEnvironment,
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

function command(dir: string, args: string[], save?: string): PromptCommand {
  const argv = ["prompt", ...args];
  return {
    argv,
    scan: scanPromptArgs(argv),
    include: [dir],
    ...(save === undefined ? {} : { save }),
    agent: {
      agentProvider: "acpx",
      defaultAgent: AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: true,
    },
  };
}

/** The production executor, configured the way the dispatch configures it. */
function executor(
  dir: string,
  journal?: string,
): (approved: PromptExecution) => Operation<Result<void>> {
  return promptExecutor(
    {
      include: [dir],
      verbose: false,
      journal,
      raw: true,
      secretDetection: true,
      agentProvider: "acpx",
      defaultAgent: AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: true,
    },
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
    it("P2: a misplaced individual option refuses before any phase begins", function* () {
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

      // The agent configuration is settled before the catalog is built, so an
      // incompatible pair of permission flags costs no inspection at all.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        const request = command(dir, [REQUEST], "out.md");
        const code = yield* runPrompt(
          { ...request, agent: { ...request.agent, approveAll: true, denyAll: true } },
          harness.deps,
        );

        expect(code).toBe(1);
        expect(untouched(harness)).toEqual(NOTHING);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });
    });

    it("P2: help needs no request and touches nothing", function* () {
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
        expect(stderr).not.toContain("unavailable");
        // No catalog was rendered, and neither file the options named was made.
        expect(stdout).not.toContain("## Built-in components");
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* exists(join(dir, "trace.jsonl"))).toBe(false);
      });

      const program = yield* runCli(["--help"]).expect();
      expect(program.stdout).toMatch(/^\s+prompt\s/m);
    });

    it("P4: individual, aggregate and environment sources resolve and reach the run", function* () {
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

    it("P13: every refusal is nonzero and leaves no save, journal or run", function* () {
      const journalName = "trace.jsonl";

      // Abort at review.
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

      // A generation failure.
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

    it("P14: the approved bytes are created exclusively, before the run", function* () {
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

    it("P15: the approved source runs as an ordinary document under <prompt>", function* () {
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

    it("P16: the deadline encloses every phase, and teardown gates what follows", function* () {
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

      // A generator teardown failure prevents the save and the run.
      yield* useWorkingDirectory(function* (dir) {
        const harness = createPromptHarness();
        harness.deps.execute = executor(dir);
        harness.fake.closeFailure = new Error("the generator would not close");
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "approve" });

        const code = yield* runPrompt(command(dir, [REQUEST], "out.md"), harness.deps);

        expect(code).toBe(1);
        expect(harness.executions).toHaveLength(0);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });

      // Nothing bounds a generation turn: the exec and fetch defaults belong to
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

    it("P16: the deadline is the whole prompt command's, as it is a run's", function* () {
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
