/**
 * Tier PR — the `xmd plan` command lifecycle
 * (specs/plan-command-spec.md).
 *
 * Rows PS2–PS10. `xmd plan` maps one request to one reviewed XMD source
 * artifact and starts no program, so every row here is about what the command
 * delivers and what it refuses to do on the way: the grammar an operator meets,
 * the two sinks the approved bytes may reach, and the endings that reach
 * neither.
 *
 * The grammar rows shell out, because exit status and help text are what an
 * operator sees, and because a subprocess is where a removed option meets the
 * real parser rather than only the scanner. Every one of them carries an
 * impossible dependency — an agent name nothing resolves, an isolated `HOME`
 * with no session directory in it — so a refusal is proven by the phases that
 * left no trace rather than by output nobody produced.
 *
 * Everything with a phase to observe runs in process, where the approved
 * program's own effects are the negative control: a document that writes a file
 * and then fails proves it was never interpreted.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { stat } from "@executablemd/runtime";
import { Elicitation } from "@executablemd/core";
import { ensure, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

import * as cliModule from "../src/cli.ts";
import { runPlan } from "../src/plan.ts";
import type { PlanCommand } from "../src/plan.ts";
import type { AuthorshipStack } from "../src/agent-stack.ts";
import { planComponentDescription, structuralValidation } from "../src/plan-component.ts";
import {
  namesPlan,
  namesRetiredCommand,
  removedOptionRefusal,
  RETIRED_COMMAND_REFUSAL as RETIRED_REFUSAL,
  RUN_REMOVAL_REFUSAL,
} from "../src/plan-args.ts";
import {
  ADAPTERS,
  AGENT,
  createPlanHarness,
  useAuthorshipRoot,
  useWorkingDirectory,
} from "./support/plan-harness.ts";
import type { PlanHarness } from "./support/plan-harness.ts";
import { makeStore } from "./support/fake-acp.ts";

const REQUEST = "write a greeting";

const PLAIN = "Nothing but prose.\n";

/**
 * The negative control for non-execution.
 *
 * It writes a file and then fails, so interpreting it is observable twice over:
 * the file would be on disk, and the command would exit nonzero. A successful
 * command that produced the exact bytes and neither observation is a command
 * that never ran what it wrote.
 */
const EFFECT_AND_FAILURE = [
  "# A program nobody asked to run",
  "",
  '<File path="ran.txt">the approved program ran</File>',
  "",
  "```bash exec",
  "exit 3",
  "```",
  "",
].join("\n");

/**
 * A structurally valid Plan whose root declares a required property.
 *
 * `xmd plan` has no property source to resolve it with — the values belong to
 * the later `xmd run` — so producing this successfully is what tells the
 * command's structural gate apart from a full root-props validation.
 */
const REQUIRES_NAME = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: string }",
  "  required: [name]",
  "  additionalProperties: false",
  "---",
  "",
  "# Greet somebody",
  "",
  '<File path="greeting.txt">Hello, {props.name}!</File>',
  "",
].join("\n");

/** A draft that resolves no such component, for the endings that never approve. */
const UNRESOLVED = "<NoSuchComponent />\n";

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

/** Who writes the Plan, as a dispatch settles it: no permission mode to settle. */
const STACK: AuthorshipStack = {
  provider: "acpx",
  defaultAgent: AGENT,
  adapters: ADAPTERS,
};

/** One invocation, writing its approved source to stdout or to a file. */
function planning(dir: string, output?: string, session?: string): PlanCommand {
  return {
    request: REQUEST,
    include: [dir],
    ...(output === undefined ? {} : { output }),
    ...(session === undefined ? {} : { session }),
    stack: STACK,
  };
}

function* exists(path: string): Operation<boolean> {
  return (yield* stat(path)).exists;
}

/**
 * What a subprocess complained about, without the runtime's own chatter.
 *
 * A cold module cache prints its downloads to the same stream, and a case that
 * compared the whole of stderr would be asserting on whether this machine had
 * run the CLI before.
 */
function complaints(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !/Download\b.*https?:\/\//.test(line))
    .join("\n")
    .trim();
}

/** Every phase after a refusal, at zero. */
function untouched(harness: PlanHarness): Record<string, number | boolean> {
  return {
    catalogs: harness.catalogCalls.length,
    runtimes: harness.fake.created.length,
    started: harness.fake.started,
    turns: harness.fake.prompts.length,
    reviews: harness.reviews.length,
  };
}

/** What the command wrote to stderr while it ran. */
function* reported<T>(body: () => Operation<T>): Operation<{ value: T; lines: string[] }> {
  const written = console.error;
  const lines: string[] = [];
  const value = yield* scoped(function* (): Operation<T> {
    yield* ensure(() => {
      console.error = written;
    });
    console.error = (...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "));
    };
    return yield* body();
  });
  return { value, lines };
}

/** What the command wrote to stdout, exactly, chunk by chunk. */
function* delivered<T>(body: () => Operation<T>): Operation<{ value: T; chunks: string[] }> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  const value = yield* scoped(function* (): Operation<T> {
    yield* ensure(() => {
      process.stdout.write = original;
    });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
    return yield* body();
  });
  return { value, chunks };
}

/**
 * The complete approved `xmd plan --help` output.
 *
 * Pinned whole rather than by phrase, because what this row is about is
 * everything help no longer says: an option that came back, or a sentence that
 * still promised to run the program, would pass every `toContain` written about
 * the parts that stayed.
 */
const PLAN_HELP = [
  "Usage: xmd plan [OPTIONS] [request]",
  "",
  "Arguments:",
  "   [request]                 the request the coding agent should turn into an XMD Plan",
  "",
  "Options:",
  "   --output [OUTPUT]         write the approved source here instead of to stdout (path must not exist)",
  "   --session [SESSION]       logical name for the assistant session (default: unique to this invocation)",
  "   --include <INCLUDE>...    component search directory [default: components,.]",
  "   --agent-provider <AGENTPROVIDER> agent provider for Plan authorship [default: acpx]",
  "   --default-agent [DEFAULTAGENT] default agent name (overrides DEFAULT_AGENT_NAME)",
  "   --timeout [TIMEOUT]       deadline for the whole planning invocation, as a duration (500ms, 30s, 5min)",
  "   -h, --help                show help",
  "",
  "Exactly one request is required. It describes the program you want the coding",
  "agent to create, rather than a path. Quote it so the shell passes it as one",
  "argument:",
  '  xmd plan "Prepare the release program."',
  "",
  "A first-party command document turns the request into an XMD Plan. xmd checks",
  "each draft, and you approve, request changes, or stop before source leaves the",
  "command.",
  "",
  "The approved Plan is the only result. Without --output, stdout contains its",
  "exact source bytes and nothing else. With --output, the path is created",
  "exclusively after approval; an existing path is left unchanged.",
  "",
  "Planning never runs the approved program. Compose planning and execution",
  "explicitly through standard input:",
  '  xmd plan "Prepare the release program." | xmd run -',
  "",
  "Or preserve the artifact and run it later:",
  '  xmd plan "Prepare the release program." --output release.md && xmd run release.md',
  "",
  "A named --session continues the planning conversation. Without it, this",
  "invocation uses a unique session.",
].join("\n");

/** Every option `xmd plan` removed, as help and a refusal spell them. */
const REMOVED_SPELLINGS = [
  "--run",
  "--props",
  "--no-props",
  "--raw",
  "--verbose",
  "-V",
  "--journal",
  "-j",
  "--timeout-exec",
  "--timeout-fetch",
  "--approve-all",
  "--approve-reads",
  "--deny-all",
  "--secret-detection",
];

/**
 * An invocation that cannot get past authorship.
 *
 * The agent name resolves to nothing and `HOME` is a directory this case made,
 * so an invocation that reached the catalog, the provider or a session leaves
 * one of three traces: the rendered catalog, an `unavailable` agent, or a
 * `.xmd` tree under that home. A grammar refusal leaves none of them.
 */
function* refusedEarly(args: string[], expected: string): Operation<{ stderr: string }> {
  return yield* useWorkingDirectory(function* (dir) {
    const home = join(dir, "home");
    yield* ensureDir(home);
    const result = yield* runCli(
      ["plan", ...args, "--default-agent", "xmd-nonexistent-agent", "--session", "probe"],
      { cwd: dir, env: { HOME: home } },
    ).join();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expected);
    // Nothing downstream of the refusal happened: no catalog reached a stream,
    // no provider was built to report an agent unavailable, no session
    // directory was placed, and no approved source escaped.
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("## Built-in components");
    expect(result.stderr).not.toContain("unavailable");
    expect(yield* exists(join(home, ".xmd"))).toBe(false);
    // And nothing was written beside it: the home this case made is the only
    // entry in the working directory.
    expect(yield* until(readdir(dir))).toEqual(["home"]);
    return { stderr: result.stderr };
  });
}

describe(
  "Tier PR — the xmd plan command lifecycle",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("PS4: plan help states the retained grammar and both compositions", function* () {
      yield* useWorkingDirectory(function* (dir) {
        // Every retained option beside `--help`: help is still help, and none
        // of them turns it into a refusal.
        const { code, stdout, stderr } = yield* runCli(
          [
            "plan",
            "--help",
            "--output",
            "out.md",
            "--session",
            "ada",
            "--include",
            "lib",
            "--timeout",
            "5s",
            "--agent-provider",
            "acpx",
            "--default-agent",
            "xmd-nonexistent-agent",
          ],
          { cwd: dir },
        ).join();

        expect(code).toBe(0);
        // Every word, option, order, example and paragraph, exactly.
        expect(stdout.trimEnd()).toBe(PLAN_HELP);
        // Which is also the whole of it: no removed option is described,
        // mentioned as refused, or listed among the ones this command takes.
        for (const spelling of REMOVED_SPELLINGS) {
          expect(stdout).not.toContain(spelling);
        }
        expect(stdout).not.toContain("XMD_PROPS");
        // Help reads no catalog and creates nothing.
        expect(stdout).not.toContain("## Built-in components");
        expect(stderr).not.toContain("unavailable");
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
      });

      // The program summary names the result rather than a choice between two.
      const program = yield* runCli(["--help"]).expect();
      expect(program.stdout).toMatch(/^\s+plan\s/m);
      expect(program.stdout).toContain(
        "Turn a request into an XMD Plan, review it, and write the approved source.",
      );
      // And the spelling this command replaced is listed nowhere.
      expect(program.stdout).not.toMatch(/^\s+prompt\s/m);
    });

    it("PS5: xmd run --help still exposes every option it configures", function* () {
      const run = yield* runCli(["run", "--help"]).expect();

      // Splitting the Plan grammar out took nothing away from the command that
      // executes a document: every class `xmd plan` dropped is still here.
      for (const option of [
        "--journal",
        "-j",
        "--raw",
        "--verbose",
        "-V",
        "--timeout",
        "--timeout-exec",
        "--timeout-fetch",
        "--approve-all",
        "--approve-reads",
        "--deny-all",
        "--secret-detection",
        "--include",
        "--agent-provider",
        "--default-agent",
        "--eval",
      ]) {
        expect(run.stdout).toContain(option);
      }

      // Including the root properties a run binds for the document it names,
      // which is where the generated options `xmd plan` dropped still live.
      yield* useWorkingDirectory(function* (dir) {
        yield* writeTextFile(join(dir, "greeter.md"), REQUIRES_NAME);
        const props = yield* runCli(["run", "greeter.md", "--help"], { cwd: dir }).expect();
        expect(props.stdout).toContain("--props-name <string>");
        expect(props.stdout).toContain("Environment: XMD_PROPS_NAME");
        expect(props.stdout).toContain("--props <json>");
      });
    });

    it("PS2: every --run spelling reports the migration and reaches nothing", function* () {
      for (const spelling of [
        ["--run"],
        ["--run=true"],
        ["--run=false"],
        ["--run="],
        ["--run", "--run"],
      ]) {
        const { stderr } = yield* refusedEarly([REQUEST, ...spelling], RUN_REMOVAL_REFUSAL);
        // The whole migration, and only it: no second complaint about the
        // options it used to gate, and no hint that a compatibility spelling
        // still exists.
        expect(complaints(stderr)).toBe(RUN_REMOVAL_REFUSAL);
      }

      // Placement decides nothing: before the request, and swallowed by an
      // option that takes a value, are the two places a hidden switch survives.
      yield* refusedEarly(["--run", REQUEST], RUN_REMOVAL_REFUSAL);
      yield* refusedEarly([REQUEST, "--include", "--run"], RUN_REMOVAL_REFUSAL);

      // Including beside `--help`, in either order. `--help` is lifted out of
      // argv before any command's own grammar runs, so this is the one place a
      // removed option could be answered with a page describing a command that
      // would refuse it.
      for (const argv of [
        ["--help", "--run"],
        ["--run", "--help"],
      ]) {
        const { stderr } = yield* refusedEarly(argv, RUN_REMOVAL_REFUSAL);
        expect(complaints(stderr)).toBe(RUN_REMOVAL_REFUSAL);
      }
    });

    it("PS3: every other removed option refuses before authorship", function* () {
      for (const option of [
        ["--journal", "trace.jsonl"],
        ["-j", "trace.jsonl"],
        ["--raw"],
        ["--verbose"],
        ["-V"],
        ["--timeout-exec", "5s"],
        ["--timeout-fetch", "5s"],
        ["--approve-all"],
        ["--deny-all"],
        ["--no-secret-detection"],
        ["--props", '{"name":"Ada"}'],
        ["--props-name", "Ada"],
        ["--no-props-loud"],
      ]) {
        const { stderr } = yield* refusedEarly(
          [REQUEST, ...option],
          removedOptionRefusal(option[0]),
        );
        expect(complaints(stderr)).toBe(removedOptionRefusal(option[0]));
      }

      // A duration nobody can parse is still answered as a removed option
      // rather than as a malformed value: the grammar this command owns runs
      // before the shared timeout reader.
      yield* refusedEarly([REQUEST, "--timeout-exec=abc"], removedOptionRefusal("--timeout-exec"));
      // And so does a secret-detection spelling the shared grammar check would
      // otherwise complain about first.
      yield* refusedEarly(
        [REQUEST, "--secret-detection=yes"],
        removedOptionRefusal("--secret-detection"),
      );

      // Beside `--help`, in either order, exactly as `--run` is.
      for (const argv of [
        ["--help", "--journal", "trace.jsonl"],
        ["--journal", "trace.jsonl", "--help"],
      ]) {
        const { stderr } = yield* refusedEarly(argv, removedOptionRefusal("--journal"));
        expect(complaints(stderr)).toBe(removedOptionRefusal("--journal"));
      }

      // A name that merely begins like a property option is an option this
      // command does not define, and is answered as one.
      for (const name of ["--propspective", "--no-propspective", "--no-props"]) {
        yield* refusedEarly([REQUEST, name], `unrecognized option for xmd plan: ${name}`);
      }
    });

    it("PS1: exactly one request, and an unknown option is refused not dropped", function* () {
      yield* refusedEarly(
        [REQUEST, "second"],
        "unrecognized argument for xmd plan: second — the command takes exactly one request",
      );
      yield* refusedEarly([REQUEST, "--not-a-thing", "value"], "unrecognized option for xmd plan");
      yield* refusedEarly(
        [REQUEST, "--save", "out.md"],
        "unrecognized option for xmd plan: --save",
      );
      yield* refusedEarly([REQUEST, "--session", ""], "--session needs a name");
    });

    it("PS1: inline source is refused before any phase begins", function* () {
      // `-e` belongs to `xmd run`. `xmd plan` is the command that *writes* a
      // document, so a second one supplied on the command line is a
      // contradiction — and one the parser used to drop in silence, leaving the
      // caller watching a different document get generated.
      for (const flag of ["-e", "--eval"]) {
        yield* refusedEarly(
          [REQUEST, flag, "# supplied"],
          "unrecognized option for xmd plan: --eval — inline documents are exclusive to xmd run",
        );
      }
    });

    it("PS1: the retired spelling names no command and reaches no authorship", function* () {
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
        expect(stderr).not.toContain("Nothing was output");
        expect(stderr).not.toContain("Request changes");
        // And neither namespace exists under the isolated home: the new one was
        // never opened, and the old one is not read, migrated or created.
        expect(yield* exists(join(home, ".xmd", "plan"))).toBe(false);
        expect(yield* exists(join(home, ".xmd", "prompt"))).toBe(false);
        // No output file: the only entry is the home this case made for the
        // subprocess.
        expect(yield* until(readdir(dir))).toEqual(["home"]);
      });
    });

    it("PS1: the retired token is refused before it can be read as a document path", function* () {
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
        expect(refused.stderr).not.toContain("## Built-in components");
        expect(refused.stderr).not.toContain("unavailable");
        expect(yield* exists(join(home, ".xmd"))).toBe(false);
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

    it("PS6: approval writes the exact source once to stdout, and runs none of it", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: EFFECT_AND_FAILURE });
        harness.script({ decision: "Approve" });

        const { value, chunks } = yield* delivered(() => runPlan(planning(dir), harness.deps));

        // The approved program writes a file and then exits 3. Success is
        // therefore the first half of the proof: nothing interpreted it.
        expect(value).toBe(0);
        // Byte for byte, in one write, with no fence, heading, label or newline
        // this command added.
        expect(chunks).toEqual([EFFECT_AND_FAILURE]);
        // And the second half: neither observation the program would have left.
        expect(yield* until(readdir(dir))).toEqual([]);
      });
    });

    it("PS7: --output creates the artifact after teardown, and never replaces one", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const out = join(dir, "release.md");
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: EFFECT_AND_FAILURE });

        // Observed from inside the authorship frame's own teardown, which is
        // the last thing that happens before the host validates and delivers.
        // A command that opened the file early — to stream into it, or to
        // truncate it — would already have created it here.
        const events: string[] = [];
        let duringTeardown = true;
        harness.deps.installElicitation = function* () {
          yield* ensure(function* () {
            events.push("teardown");
            duringTeardown = yield* exists(out);
          });
          yield* Elicitation.around(
            {
              // deno-lint-ignore require-yield
              *elicit([request], _next) {
                harness.reviews.push(request);
                events.push("review");
                return { decision: "Approve" };
              },
            },
            { at: "min" },
          );
        };

        const { value, chunks } = yield* delivered(() => runPlan(planning(dir, out), harness.deps));

        expect(value).toBe(0);
        expect(events).toEqual(["review", "teardown"]);
        expect(duringTeardown).toBe(false);
        // The same exact bytes the default sink would have written, and stdout
        // stays empty: a caller who named a file does not also get a copy.
        expect(yield* readTextFile(out)).toBe(EFFECT_AND_FAILURE);
        expect(chunks).toEqual([]);
        // Still nothing ran, so the file the program writes is not beside it.
        expect((yield* until(readdir(dir))).sort()).toEqual(["release.md"]);
      });

      // An existing path is left exactly as it is, and the command stops.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const out = join(dir, "release.md");
        yield* writeTextFile(out, "keep me\n");
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const { value, lines } = yield* reported(() => runPlan(planning(dir, out), harness.deps));

        expect(value).toBe(1);
        expect(lines.join("\n")).toBe(
          `${out} already exists — choose another --output path; the approved Plan was not written`,
        );
        expect(yield* readTextFile(out)).toBe("keep me\n");
      });
    });

    it("PS8: a Plan declaring a required root property is produced with no value", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: REQUIRES_NAME });
        harness.script({ decision: "Approve" });

        const { value, chunks } = yield* delivered(() => runPlan(planning(dir), harness.deps));

        // The command has no property source to resolve `name` from — the value
        // belongs to whoever runs the program later — so a gate that validated
        // root props here would refuse a Plan for not having been given an
        // argument nobody has offered it yet.
        expect(value).toBe(0);
        expect(chunks.join("")).toBe(REQUIRES_NAME);
        // The draft check inside the workflow answered the same way: it was
        // never sent back for repair.
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(1);
      });
    });

    it("PS9: every ending but approval delivers nothing at all", function* () {
      /** One ending, and what it leaves behind. */
      function* ends(
        name: string,
        arrange: (harness: PlanHarness, dir: string) => Operation<void>,
      ): Operation<void> {
        yield* useWorkingDirectory(function* (dir, authorshipRoot) {
          const out = join(dir, "release.md");
          const harness = createPlanHarness({ authorshipRoot });
          yield* arrange(harness, dir);

          const { value, chunks } = yield* delivered(() =>
            reported(() => runPlan(planning(dir, out), harness.deps)),
          );

          expect(`${name}: ${value.value}`).toBe(`${name}: 1`);
          // No approved source on stdout, no artifact on disk, and no effect
          // from the program that was never admitted.
          expect(`${name}: ${chunks.join("")}`).toBe(`${name}: `);
          expect(`${name}: ${(yield* until(readdir(dir))).join()}`).toBe(`${name}: `);
        });
      }

      // The person stopped.
      yield* ends("stop", function* (harness) {
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Stop" });
      });

      // A turn produced text and then failed.
      yield* ends("failed turn", function* (harness) {
        harness.fake.script({ reply: PLAIN, stopReason: "refusal" });
      });

      // Ten drafts, none approvable, ending in the automatic explanation.
      yield* ends("ten attempts", function* (harness) {
        for (const round of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          for (const _draft of [0, 1, 2, 3]) {
            harness.fake.script({ reply: UNRESOLVED });
          }
          if (round < 10) {
            harness.script({ decision: "Request changes", feedback: `round ${round}` });
          }
        }
        harness.fake.script({ reply: "Every draft named a component nothing offers." });
      });

      // The profile provider would not close.
      yield* ends("teardown failure", function* (harness) {
        harness.fake.closeFailure = new Error("the profile provider would not close");
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });
      });

      // The host's own gate, after the command document has settled. The draft
      // check and `<AdmitPlan>` both really validate and both succeed; the
      // component the draft names is removed immediately after that successful
      // admission, so the only thing left to catch it is the check this command
      // keeps for itself.
      yield* ends("host structural refusal", function* (harness, dir) {
        const widget = join(dir, "Widget.md");
        yield* writeTextFile(widget, "A widget.\n");
        harness.fake.script({ reply: ["# Uses a widget", "", "<Widget />", ""].join("\n") });
        harness.script({ decision: "Approve" });

        const canonical = structuralValidation([dir], [yield* planComponentDescription()]);
        const outcomes: string[] = [];
        harness.deps.validate = function* (candidate) {
          const validation = yield* canonical(candidate);
          outcomes.push(validation.outcome);
          if (outcomes.length === 2) {
            yield* rm(widget, { force: true });
          }
          return validation;
        };
        yield* ensure(() => {
          // Two sound answers inside the Component, and a third that refuses.
          expect(outcomes).toEqual(["valid", "valid", "invalid"]);
        });
      });

      // A host whose settled provider supplies no Agent context for `<Plan>`.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        const { value, lines } = yield* reported(() =>
          runPlan(
            { ...planning(dir, join(dir, "release.md")), stack: { ...STACK, provider: "other" } },
            harness.deps,
          ),
        );

        expect(value).toBe(1);
        expect(lines.join("\n")).toBe(
          "The other provider did not provide an Agent context for <Plan>. " +
            "No Plan was returned. Nothing was output.",
        );
        // Refused before a directory, a provider, a turn or a review existed.
        expect(untouched(harness)).toEqual({
          catalogs: 1,
          runtimes: 0,
          started: false,
          turns: 0,
          reviews: 0,
        });
        expect(yield* until(readdir(dir))).toEqual([]);
      });

      // Cancellation while a turn is in flight.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: PLAIN, manual: true });

        yield* scoped(function* () {
          const running = yield* spawn(() =>
            runPlan(planning(dir, join(dir, "release.md")), harness.deps),
          );
          yield* harness.fake.startedTurns(1);
          yield* running.halt();
        });

        expect(harness.fake.cancels).toBeGreaterThanOrEqual(1);
        expect(harness.reviews).toHaveLength(0);
        expect(yield* until(readdir(dir))).toEqual([]);
      });
    });

    it("PS10: a named session continues the conversation and still starts no program", function* () {
      // One ACPX store and one authorship root shared by two invocations is the
      // only way to observe whether a named session is continued or placed a
      // second time — and whether continuing one ever runs what it produced.
      yield* useAuthorshipRoot(function* (authorshipRoot) {
        const store = makeStore();
        const materializations: (string | undefined)[] = [];

        for (const invocation of [1, 2]) {
          yield* useWorkingDirectory(function* (dir) {
            const harness = createPlanHarness({ authorshipRoot, store });
            harness.fake.script({ reply: EFFECT_AND_FAILURE });
            harness.script({ decision: "Approve" });

            const { value, chunks } = yield* delivered(() =>
              runPlan(planning(dir, undefined, "release-notes"), harness.deps),
            );

            expect(`${invocation}: ${value}`).toBe(`${invocation}: 0`);
            expect(chunks.join("")).toBe(EFFECT_AND_FAILURE);
            materializations.push(harness.fake.ensured[0]?.materialization);
            // Neither invocation ran the program it produced: the file that
            // program writes is nowhere, and the failure it ends in never
            // happened. The retained Plan artifact is not an execution record.
            expect(`${invocation}: ${(yield* until(readdir(dir))).join()}`).toBe(`${invocation}: `);
          });
        }

        // The second invocation continued the record the first established
        // rather than placing a second one.
        expect([...store.records.keys()]).toHaveLength(1);
        expect(materializations).toEqual(["first-turn-acceptance", undefined]);
      });

      // Structurally, too: this command has no execution capability to reach.
      // A branch left unselected would still be a branch, and these are the
      // names it would have had.
      expect("execute" in createPlanHarness({ authorshipRoot: "/nowhere" }).deps).toBe(false);
      expect("planExecutor" in cliModule).toBe(false);
      expect("PlanExecutionConfig" in cliModule).toBe(false);
    });

    it("PS11: an agent whose sessions end with the invocation writes no Plan", function* () {
      // Both spellings, because the point is that naming the conversation
      // changes nothing: a name asks for a conversation to return to, and this
      // agent has none to return to.
      for (const session of [undefined, "release"]) {
        yield* useWorkingDirectory(function* (dir, authorshipRoot) {
          const harness = createPlanHarness({ authorshipRoot });

          const { value: code, lines } = yield* reported(() =>
            runPlan(
              {
                ...planning(dir, "out.md", session),
                stack: { ...STACK, defaultAgent: "devin" },
              },
              harness.deps,
            ),
          );

          expect(code).toBe(1);
          expect(lines.join("\n")).toContain("did not provide an Agent context");
          // Settled before the profile exists, so every phase the provider owns
          // is at zero and no artifact reached either sink. The catalog is not
          // one of them: `runPlan` renders it before it asks for an Agent
          // context, so it is built and then thrown away with the invocation.
          expect({
            runtimes: harness.fake.created.length,
            started: harness.fake.started,
            turns: harness.fake.prompts.length,
            reviews: harness.reviews.length,
          }).toEqual({ runtimes: 0, started: false, turns: 0, reviews: 0 });
          expect(yield* exists(join(dir, "out.md"))).toBe(false);
          expect(yield* until(readdir(authorshipRoot))).toEqual([]);
        });
      }
    });

    it("PS12: the shipped documentation states what each command does", function* () {
      // The defect this catches is prose, and prose is what a person reads
      // before they type anything: a page still promising `xmd plan --run`
      // describes a command that would refuse them.
      const root = fileURLToPath(new URL("../../../", import.meta.url));
      const pages = [
        "README.md",
        "architecture.md",
        "specs/plan-command-spec.md",
        "specs/executable-mdx-spec.md",
        "specs/root-document-props-spec.md",
        "specs/acp-client-spec.md",
        "site/routes/index.tsx",
      ];

      for (const page of pages) {
        let text = yield* readTextFile(join(root, page));
        if (page === "specs/plan-command-spec.md") {
          // Spelling out what the command removed is that one section's whole
          // job, so it is the one place the switch is written plainly.
          const start = text.indexOf("### What the command removed");
          expect(start).toBeGreaterThan(0);
          text = text.slice(0, start) + text.slice(text.indexOf("\n### ", start + 1));
        }
        // Everywhere else a page may name the switch only to say it is gone: a
        // line that names it and says neither is a page still offering it.
        const offered = text
          .split("\n")
          .filter((line) => /--run\b/.test(line) && !/remov|refus/.test(line))
          .map((line) => line.slice(0, 120));
        expect(`${page}: ${offered.join(" | ")}`).toBe(`${page}: `);
      }

      // And the relationship is stated where somebody arrives: the README, the
      // homepage, the architecture glossary and the command's own contract.
      for (const [page, phrase] of [
        ["README.md", "Composition decides whether and when a planned program runs."],
        ["architecture.md", "composition decides whether and when a planned program runs"],
        ["specs/plan-command-spec.md", "Run executes a program from the host/CLI."],
        ["site/routes/index.tsx", "Composition decides whether and when a planned program runs."],
      ] as const) {
        const text = yield* readTextFile(join(root, page));
        expect(`${page}: ${text.includes(phrase)}`).toBe(`${page}: true`);
      }
    });

    it("PS9: --timeout bounds the whole invocation, and it is the only deadline", function* () {
      // Read exactly as a run reads it: a value that is not a duration fails
      // the invocation before it prepares anything.
      const malformed = yield* runCli(["plan", REQUEST, "--timeout=abc"]).join();
      expect(malformed.code).toBe(1);
      expect(malformed.stderr).toContain("--timeout");

      // And it bounds the command rather than only a document: the deadline
      // expires while the catalog is still being built.
      const expired = yield* runCli(["plan", REQUEST, "--timeout=1ms"]).join();
      expect(expired.code).toBe(1);
      expect(expired.stderr).toContain("exceeded its --timeout of 1ms and was cancelled");
    });
  },
);
