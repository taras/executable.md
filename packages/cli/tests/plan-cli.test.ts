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
import type { DocumentValidation } from "@executablemd/core";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { ensure, Ok, scoped, spawn, until } from "effection";
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
import type { StructuralValidation } from "../src/plan-component.ts";
import { FileStream } from "../src/file-stream.ts";
import { createPlanJournal, planJournalStream } from "../src/plan-journal.ts";
import {
  JOURNAL_PATH_REFUSAL,
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
function planning(
  dir: string,
  output?: string,
  session?: string,
  observability: { verbose?: boolean; journal?: string } = {},
): PlanCommand {
  return {
    request: REQUEST,
    include: [dir],
    ...(output === undefined ? {} : { output }),
    ...(session === undefined ? {} : { session }),
    verbose: observability.verbose === true,
    ...(observability.journal === undefined ? {} : { journal: observability.journal }),
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
  "   --verbose                 show generated drafts and XMD check diagnostics on stderr [default: false]",
  "   --journal [JOURNAL]       record the planning process as diagnostic JSONL (path must not exist)",
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
  "",
  "Secret detection checks journal entries before they are recorded, but it may not",
  "catch every sensitive detail. The journal can contain prompts, drafts, and review",
  "answers.",
].join("\n");

/**
 * Every option `xmd plan` removed, as help and a refusal spell them.
 *
 * The two short aliases are here and their long spellings are not: `--verbose`
 * and `--journal` describe writing a Plan and are part of this grammar, while
 * `-V` and `-j` are `xmd run`'s aliases for options about a program's run.
 */
const REMOVED_SPELLINGS = [
  "--run",
  "--props",
  "--no-props",
  "--raw",
  "-V",
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
        // Matched as whole tokens, because `-j` is a substring of the
        // `--journal` this command does define.
        for (const spelling of REMOVED_SPELLINGS) {
          expect(`${spelling}: ${new RegExp(`(^|\\s)${spelling}\\b`, "m").test(stdout)}`).toBe(
            `${spelling}: false`,
          );
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
        ["--raw"],
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
        ["--help", "--raw"],
        ["--raw", "--help"],
      ]) {
        const { stderr } = yield* refusedEarly(argv, removedOptionRefusal("--raw"));
        expect(complaints(stderr)).toBe(removedOptionRefusal("--raw"));
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
        // Refused before the catalog, a directory, a provider, a turn or a
        // review existed. The catalog is built by `<PlanInputs>` now, and this
        // refusal happens before the command document starts at all.
        expect(untouched(harness)).toEqual({
          catalogs: 0,
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

/** The escape a terminal renderer introduces and a pipe never sees. */
const ANSI = "\u001b[";

/**
 * A synthetic GitHub token, format-realistic and assembled at run time.
 *
 * Built rather than written, so no usable-looking literal enters the repository
 * and this file does not trip the scanning it is about.
 */
function canary(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return ["ghp", "_", alphabet.slice(0, 36)].join("");
}

/** The same shape, with nothing in it a scanner objects to. */
const SAFE_VALUE = "not-a-credential-at-all";

/** A draft holding the canary, so the turn that produced it is refused. */
function canaryDraft(): string {
  return ["# Uses a token", "", `The value is ${canary()}.`, ""].join("\n");
}

/** The same draft, clean: the control that shows the verbose branch does run. */
const CLEAN_DRAFT = ["# Uses a token", "", `The value is ${SAFE_VALUE}.`, ""].join("\n");

/** The phase headings an operator read, in order. */
function phasesOf(transcript: string): string[] {
  return transcript
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

/** One journal file, read back as the NDJSON sequence it is. */
function* journalEvents(path: string): Operation<DurableEvent[]> {
  const text = yield* readTextFile(path);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * The records a journal file has certainly committed.
 *
 * Only the newline-terminated ones. An append this command made and the
 * filesystem then failed is not a transaction — `appendFile` can write some of
 * a record and stop — so what a case about a *failed* append may claim is the
 * sequence that committed before it, and anything after the last terminator is
 * not part of that sequence. A case about an ending where no append failed
 * reads the whole file instead, and compares its bytes.
 */
function* committedJournal(path: string): Operation<DurableEvent[]> {
  const text = yield* readTextFile(path);
  const terminated = text.slice(0, text.lastIndexOf("\n") + 1);
  return terminated
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Tier PO — observable `xmd plan` authorship
 * (specs/plan-command-spec.md).
 *
 * Rows PO6-PO15, the half of the tier that is about channels rather than
 * phases: which stream each thing lands on, what a `--journal` file holds, what
 * the secret boundary keeps out of both, and what happens when a destination
 * stops accepting. The authored phases and their counters are proven against
 * the packaged document itself, in `plan-command-document.test.ts`.
 *
 * Progress is observed through the host dependency the CLI supplies, so a case
 * reads the same chunks `process.stderr` would have been handed, in the same
 * order, without a real terminal or a real pipe in the evidence.
 */
describe(
  "Tier PO — observable xmd plan authorship",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("PO6: progress is stderr's and the approved bytes are stdout's", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const piped = createPlanHarness({ authorshipRoot });
        piped.fake.script({ reply: EFFECT_AND_FAILURE });
        piped.script({ decision: "Approve" });

        const { value, chunks } = yield* delivered(() => runPlan(planning(dir), piped.deps));

        expect(value).toBe(0);
        // Stdout carries the approved source and nothing else — no phase, no
        // heading, no newline this command added.
        expect(chunks).toEqual([EFFECT_AND_FAILURE]);
        // A stated pipe receives normalized Markdown with no terminal
        // formatting in it at all.
        const transcript = piped.progress.join("");
        expect(transcript).toContain("## Preparing the Plan");
        expect(transcript).not.toContain(ANSI);
        // And the progress channel never carried the source.
        expect(transcript).not.toContain(EFFECT_AND_FAILURE.trim());
      });

      // A host that states its stderr is a terminal gets terminal formatting on
      // that stream, and the artifact stays byte-identical. The observable is
      // the verbose draft block: rendered for a terminal, a fenced block
      // becomes indented text, while a pipe receives the fence itself. Colour
      // is not asserted — chalk decides that from the stream it is writing to,
      // and in a test process it decides against it.
      const rendered: Record<string, string> = {};
      for (const terminal of [false, true]) {
        yield* useWorkingDirectory(function* (dir, authorshipRoot) {
          const out = join(dir, "release.md");
          const harness = createPlanHarness({ authorshipRoot, terminal });
          harness.fake.script({ reply: EFFECT_AND_FAILURE });
          harness.script({ decision: "Approve" });

          const { value, chunks } = yield* delivered(() =>
            runPlan(planning(dir, out, undefined, { verbose: true }), harness.deps),
          );

          expect(`${terminal}: ${value}`).toBe(`${terminal}: 0`);
          rendered[String(terminal)] = harness.progress.join("");
          // Whichever stderr this is, the artifact holds the exact approved
          // bytes and stdout holds nothing.
          expect(yield* readTextFile(out)).toBe(EFFECT_AND_FAILURE);
          expect(chunks).toEqual([]);
        });
      }

      // The pipe received the Markdown as written; the terminal received it
      // rendered, with the fence turned into indentation.
      expect(rendered.false).toContain("```markdown");
      expect(rendered.false).toContain("\n## Generated draft");
      expect(rendered.true).not.toContain("```markdown");
      expect(rendered.true).toContain("    # A program nobody asked to run");
      expect(rendered.true).toContain("Generated draft");
    });

    it("PO7: both authorship options work either side of the request; the aliases do not", function* () {
      // Accepted before and after the request, together, through the real
      // parser — and with an impossible agent, so what is proven is that the
      // grammar let the invocation reach authorship rather than that the
      // invocation succeeded.
      yield* useWorkingDirectory(function* (dir) {
        const home = join(dir, "home");
        yield* ensureDir(home);
        for (const args of [
          [REQUEST, "--verbose", "--journal", "before.jsonl"],
          ["--verbose", "--journal", "after.jsonl", REQUEST],
        ]) {
          const result = yield* runCli(
            ["plan", ...args, "--default-agent", "xmd-nonexistent-agent"],
            { cwd: dir, env: { HOME: home } },
          ).join();

          // Neither spelling was refused by fixed grammar: the invocation got
          // as far as the agent it cannot start.
          expect(`${args.join(" ")}: ${result.stderr.includes("unrecognized option")}`).toBe(
            `${args.join(" ")}: false`,
          );
          expect(`${args.join(" ")}: ${result.stdout}`).toBe(`${args.join(" ")}: `);
        }
      });

      // The short aliases are answered with the long spelling, and reach no
      // catalog, session, provider or file.
      for (const [alias, spelling] of [
        ["-V", "--verbose"],
        ["-j", "--journal <path>"],
      ] as const) {
        const refusal = `unrecognized option for xmd plan: ${alias} — write \`${spelling}\``;
        const { stderr } = yield* refusedEarly([REQUEST, alias], refusal);
        expect(complaints(stderr)).toBe(refusal);
      }
      // And `--trace` is nobody's option here.
      yield* refusedEarly([REQUEST, "--trace"], "unrecognized option for xmd plan: --trace");
    });

    it("PO7: a retained option written where the journal path goes refuses before any phase", function* () {
      // `refusedEarly` carries an agent name nothing resolves and an isolated
      // `HOME`, so reaching the catalog, the provider or a session placement
      // would each leave a trace. None of them does — and neither does the
      // filesystem: the switch that was about to become a filename is not one.
      //
      // Every retained spelling that reaches this command's own grammar. Help
      // is not among them and is the case after next: it is lifted out of the
      // command line before any command's grammar runs.
      for (const swallowed of [
        ["--verbose"],
        ["--output", "out.md"],
        ["--session", "ada"],
        ["--include", "lib"],
        ["--timeout", "5s"],
        ["--version"],
      ]) {
        const { stderr } = yield* refusedEarly(
          [REQUEST, "--journal", ...swallowed],
          JOURNAL_PATH_REFUSAL,
        );
        expect(`${swallowed.join(" ")}: ${complaints(stderr)}`).toBe(
          `${swallowed.join(" ")}: ${JOURNAL_PATH_REFUSAL}`,
        );
      }

      yield* useWorkingDirectory(function* (dir) {
        const home = join(dir, "home");
        yield* ensureDir(home);
        const result = yield* runCli(
          ["plan", REQUEST, "--journal", "--verbose", "--output", "release.md"],
          { cwd: dir, env: { HOME: home } },
        ).join();

        expect(result.code).toBe(1);
        expect(complaints(result.stderr)).toBe(JOURNAL_PATH_REFUSAL);
        // Named exactly: the option was never exclusively created as a journal,
        // no journal exists under any name, and the artifact sink was never
        // reached either.
        expect(yield* exists(join(dir, "--verbose"))).toBe(false);
        expect(yield* exists(join(dir, "release.md"))).toBe(false);
        expect((yield* until(readdir(dir))).sort()).toEqual(["home"]);
        // And no catalog, provider or session placement happened on the way.
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("## Built-in components");
        expect(result.stderr).not.toContain("unavailable");
        expect(yield* exists(join(home, ".xmd"))).toBe(false);
      });

      // Help is not one of them. `--help` and `-h` are removed from the command
      // line before any command's own grammar runs, and this missing-value
      // check is deliberately not moved ahead of that: ordinary help stays
      // ordinary help, and pre-help refusal is reserved for the options this
      // command removed. So help wins, exits successfully, and still creates no
      // journal and begins no authorship.
      for (const argv of [
        [REQUEST, "--journal", "--help"],
        [REQUEST, "--journal", "-h"],
        [REQUEST, "--help", "--journal"],
      ]) {
        yield* useWorkingDirectory(function* (dir) {
          const home = join(dir, "home");
          yield* ensureDir(home);
          const result = yield* runCli(
            ["plan", ...argv, "--default-agent", "xmd-nonexistent-agent"],
            { cwd: dir, env: { HOME: home } },
          ).join();

          const written = argv.join(" ");
          expect(`${written}: ${result.code}`).toBe(`${written}: 0`);
          expect(result.stdout).toContain("Usage: xmd plan [OPTIONS] [request]");
          expect(result.stdout).toContain("--journal [JOURNAL]");
          // The scan's refusal is never reported: help answered instead.
          expect(`${written}: ${result.stderr.includes(JOURNAL_PATH_REFUSAL)}`).toBe(
            `${written}: false`,
          );
          // And help created nothing and reached nothing, exactly as it does
          // beside every other option: no journal under any name, no catalog,
          // no provider and no session directory.
          expect((yield* until(readdir(dir))).sort()).toEqual(["home"]);
          expect(result.stdout).not.toContain("## Built-in components");
          expect(result.stderr).not.toContain("unavailable");
          expect(yield* exists(join(home, ".xmd"))).toBe(false);
        });
      }

      // The valid orderings still reach authorship rather than the grammar.
      yield* useWorkingDirectory(function* (dir) {
        const home = join(dir, "home");
        yield* ensureDir(home);
        for (const args of [
          [REQUEST, "--journal", "kept.jsonl", "--verbose"],
          ["--verbose", "--journal", "kept.jsonl", REQUEST],
        ]) {
          const result = yield* runCli(
            ["plan", ...args, "--default-agent", "xmd-nonexistent-agent"],
            { cwd: dir, env: { HOME: home } },
          ).join();
          expect(`${args.join(" ")}: ${result.stderr.includes(JOURNAL_PATH_REFUSAL)}`).toBe(
            `${args.join(" ")}: false`,
          );
        }
      });
    });

    it("PO8: no journal writes no file, and one records authorship as ordinary JSONL", function* () {
      // Without `--journal`, nothing is created anywhere.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const { value } = yield* delivered(() => runPlan(planning(dir), harness.deps));

        expect(value).toBe(0);
        expect(yield* until(readdir(dir))).toEqual([]);
      });

      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "authorship.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        // A Plan that writes a file and then fails, so "no later program run"
        // is a fact about this journal rather than an absence nothing could
        // have produced.
        harness.fake.script({ reply: EFFECT_AND_FAILURE });
        // The file has to exist before the work it records, so this is read
        // from inside the review — with the turn already committed and the
        // approval not yet given.
        const answered = { existed: false, entries: 0 };
        harness.deps.installElicitation = function* () {
          yield* Elicitation.around(
            {
              *elicit([request], _next) {
                harness.reviews.push(request);
                answered.existed = yield* exists(journal);
                answered.entries = (yield* readTextFile(journal))
                  .split("\n")
                  .filter(Boolean).length;
                return { decision: "Approve" };
              },
            },
            { at: "min" },
          );
        };

        const { value, chunks } = yield* delivered(() =>
          runPlan(planning(dir, undefined, undefined, { journal }), harness.deps),
        );

        expect(value).toBe(0);
        expect(chunks.join("")).toBe(EFFECT_AND_FAILURE);
        // Created before the catalog, the session and the turn: by the review
        // it already holds the entries those phases committed.
        expect(answered.existed).toBe(true);
        expect(answered.entries).toBeGreaterThan(0);

        // The whole trace parses as the existing NDJSON sequence, in commit
        // order, and ends terminally.
        const events = yield* journalEvents(journal);
        expect(events.length).toBeGreaterThan(answered.entries);
        expect(events.at(-1)?.type).toBe("close");
        // It records authorship and no later program run. The approved source
        // is *in* the file, because a draft is retained content — what is not
        // there is any effect of running it: no execution event, and none of
        // the file the program writes.
        expect(yield* until(readdir(dir))).toEqual(["authorship.jsonl"]);
        const kinds = new Set(
          events
            .filter((event) => event.type === "yield")
            .map((event) => String(Reflect.get(Object(event.description), "type"))),
        );
        expect([...kinds].filter((kind) => /exec|process|command|write/.test(kind))).toEqual([]);
      });
    });

    it("PO9: an existing journal is refused untouched, before anything else happens", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "kept.jsonl");
        yield* writeTextFile(journal, "keep me\n");
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        const { value, lines } = yield* reported(() =>
          runPlan(planning(dir, join(dir, "release.md"), undefined, { journal }), harness.deps),
        );

        expect(value).toBe(1);
        expect(lines.join("\n")).toBe(
          `Journal file already exists: ${journal}. Choose a different --journal path.`,
        );
        // Byte-identical, and nothing downstream of the refusal happened: no
        // catalog, no provider, no session, no turn, no review and no artifact.
        expect(yield* readTextFile(journal)).toBe("keep me\n");
        expect(untouched(harness)).toEqual({
          catalogs: 0,
          runtimes: 0,
          started: false,
          turns: 0,
          reviews: 0,
        });
        expect(yield* until(readdir(dir))).toEqual(["kept.jsonl"]);
        expect(harness.progress).toEqual([]);
      });

      // A path this command cannot create at all gets the other refusal, whole.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "missing", "trace.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: PLAIN });

        const { value, lines } = yield* reported(() =>
          runPlan(planning(dir, undefined, undefined, { journal }), harness.deps),
        );

        expect(value).toBe(1);
        const paragraphs = lines.join("\n").split("\n\n");
        expect(paragraphs[0].startsWith(`Could not create journal file ${journal}: `)).toBe(true);
        expect(paragraphs.slice(1)).toEqual(["Choose a different --journal path and try again."]);
        expect(untouched(harness)).toEqual({
          catalogs: 0,
          runtimes: 0,
          started: false,
          turns: 0,
          reviews: 0,
        });
      });
    });

    it("PO10: a secret in a draft reaches neither the progress nor the journal", function* () {
      // The control first: the same shape without the canary is visible under
      // `--verbose`, so an absent draft below is the gate's doing rather than a
      // verbose branch that never ran.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "clean.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: CLEAN_DRAFT });
        harness.script({ decision: "Approve" });

        const { value } = yield* delivered(() =>
          runPlan(planning(dir, undefined, undefined, { journal, verbose: true }), harness.deps),
        );

        expect(value).toBe(0);
        expect(harness.progress.join("")).toContain(SAFE_VALUE);
        expect(yield* readTextFile(journal)).toContain(SAFE_VALUE);
      });

      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "tainted.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: canaryDraft() });

        const { value, chunks } = yield* delivered(() =>
          reported(() =>
            runPlan(
              planning(dir, join(dir, "release.md"), undefined, { journal, verbose: true }),
              harness.deps,
            ),
          ),
        );

        expect(value.value).toBe(1);
        // The gate is what ended it, rather than a scenario that stopped for
        // some other reason: the run reports the rejection, and reports it
        // without repeating what it found.
        expect(value.lines.join("\n")).toContain(
          "secret detection rejected content before it was persisted",
        );
        expect(value.lines.join("\n")).not.toContain(canary());
        // The supplying event never cleared the pre-append gate, so the draft
        // binding never existed and the verbose phase after it was unreachable.
        const transcript = harness.progress.join("");
        expect(transcript).not.toContain(canary());
        expect(phasesOf(transcript)).not.toContain("Generated draft");
        // Nor is it in the file — while the prefix committed before it is
        // still there and still parses.
        expect(yield* readTextFile(journal)).not.toContain(canary());
        expect((yield* journalEvents(journal)).length).toBeGreaterThan(0);
        // Teardown completed and nothing was delivered.
        expect(harness.fake.closes.length).toBeGreaterThan(0);
        expect(chunks).toEqual([]);
        expect((yield* until(readdir(dir))).sort()).toEqual(["tainted.jsonl"]);
      });
    });

    it("PO11: a secret in a failed check's diagnostics is kept out of both, too", function* () {
      /** A structural refusal whose message carries `secret`. */
      const refusing = (secret: string): StructuralValidation =>
        // deno-lint-ignore require-yield
        function* (): Operation<DocumentValidation> {
          return {
            version: 1,
            outcome: "invalid",
            diagnostics: [
              { code: "component-unresolved", message: `no component answers ${secret}` },
            ],
            invocations: [],
          };
        };

      // The control: a clean diagnostic is displayed and recorded.
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "clean.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.validate = refusing(SAFE_VALUE);
        for (const _draft of [0, 1, 2, 3]) {
          harness.fake.script({ reply: PLAIN });
        }
        harness.script({ decision: "Stop" });

        const { value } = yield* reported(() =>
          runPlan(planning(dir, undefined, undefined, { journal, verbose: true }), harness.deps),
        );

        expect(value).toBe(1);
        expect(harness.progress.join("")).toContain(SAFE_VALUE);
        expect(yield* readTextFile(journal)).toContain(SAFE_VALUE);
      });

      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "tainted.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        harness.deps.validate = refusing(canary());
        harness.fake.script({ reply: PLAIN });

        const { value, chunks } = yield* delivered(() =>
          reported(() =>
            runPlan(
              planning(dir, join(dir, "release.md"), undefined, { journal, verbose: true }),
              harness.deps,
            ),
          ),
        );

        expect(value.value).toBe(1);
        expect(value.lines.join("\n")).toContain(
          "secret detection rejected content before it was persisted",
        );
        expect(value.lines.join("\n")).not.toContain(canary());
        const transcript = harness.progress.join("");
        expect(transcript).not.toContain(canary());
        expect(phasesOf(transcript)).not.toContain("Problems found in the draft");
        expect(yield* readTextFile(journal)).not.toContain(canary());
        // The prefix committed before the refused check is readable.
        expect((yield* journalEvents(journal)).length).toBeGreaterThan(0);
        expect(chunks).toEqual([]);
        expect((yield* until(readdir(dir))).sort()).toEqual(["tainted.jsonl"]);
      });
    });

    it("PO12: an entry the journal will not take ends authorship and keeps the prefix", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "partial.jsonl");
        const harness: PlanHarness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        // The real exclusive creation, then a backing stream that writes the
        // same file until the first turn is under way and refuses everything
        // after it. Refusing by that point rather than by a count is what makes
        // the row about a journal that failed *during* authorship: a provider
        // exists to tear down, and a readable prefix is already on disk. The
        // diagnostic a case reads back is the command's own translation rather
        // than a message the case wrote.
        harness.deps.journal = function* (path) {
          const created = yield* createPlanJournal(path);
          if (!created.ok) {
            return created;
          }
          const file = new FileStream(path);
          return Ok(
            planJournalStream(path, {
              readAll: () => file.readAll(),
              *append(event) {
                if (harness.fake.prompts.length > 0) {
                  throw new Error("EACCES: permission denied, open 'partial.jsonl'");
                }
                yield* file.append(event);
              },
            }),
          );
        };

        const { value, chunks } = yield* delivered(() =>
          reported(() =>
            runPlan(planning(dir, join(dir, "release.md"), undefined, { journal }), harness.deps),
          ),
        );

        expect(value.value).toBe(1);
        expect(value.lines.join("\n")).toContain(
          `Could not write the next entry to journal file ${journal}: ` +
            "EACCES: permission denied, open 'partial.jsonl'",
        );
        expect(value.lines.join("\n")).toContain(
          "The journal still contains the entries recorded before this failure.",
        );
        // The entries that committed before the refusal are still there and
        // still parse — a preserved prefix. The last of them is the turn whose
        // result the file would not take.
        //
        // Read as terminated records rather than as the whole file: a failed
        // filesystem append is not atomic, so what this row is entitled to
        // claim is what committed before it, not that the refused append left
        // no bytes at all.
        const prefix = yield* committedJournal(journal);
        expect(prefix.length).toBeGreaterThan(0);
        expect(prefix.at(-1)?.type).toBe("yield");
        // Teardown completed and nothing was delivered.
        expect(harness.fake.closes.length).toBeGreaterThan(0);
        expect(chunks).toEqual([]);
        expect((yield* until(readdir(dir))).sort()).toEqual(["partial.jsonl"]);
      });
    });

    it("PO16: an ordinary failure leaves a whole, readable journal behind", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const journal = join(dir, "ordinary.jsonl");
        const harness = createPlanHarness({ authorshipRoot });
        // A turn that produced text and then failed. Nothing about this ending
        // is a secret rejection or a write failure: the file took every entry
        // it was offered, and authorship ended for a reason of its own.
        harness.fake.script({ reply: PLAIN, stopReason: "refusal" });

        const { value, chunks } = yield* delivered(() =>
          reported(() =>
            runPlan(planning(dir, join(dir, "release.md"), undefined, { journal }), harness.deps),
          ),
        );

        expect(value.value).toBe(1);
        // The ending is the turn's, and it is neither of the two failures that
        // have a journal diagnostic of their own.
        const said = value.lines.join("\n");
        expect(said).toContain("refusal");
        expect(said).not.toContain("secret detection rejected content");
        expect(said).not.toContain("Could not write the next entry to journal file");
        // No approved source on stdout, and no artifact.
        expect(chunks).toEqual([]);
        expect((yield* until(readdir(dir))).sort()).toEqual(["ordinary.jsonl"]);
        // Teardown completed before `runPlan` returned: the provider closed,
        // and the invocation's own session directory went back.
        expect(harness.fake.closes.length).toBeGreaterThan(0);
        expect(yield* until(readdir(authorshipRoot))).toEqual([]);

        // At least one event committed before the failure, and the whole file
        // parses: every line is a complete durable event, in commit order.
        const recorded = yield* readTextFile(journal);
        const events = yield* journalEvents(journal);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          expect(typeof event.type).toBe("string");
        }
        // And nothing partial is left at the end. Re-serializing what parsed
        // reproduces the file byte for byte, so there is no truncated record,
        // no half-written line and no missing terminator — which a `JSON.parse`
        // sweep alone would not catch, because it never sees dropped bytes.
        expect(recorded).toBe(events.map(serializeDurableEvent).join(""));
        expect(recorded.endsWith("\n")).toBe(true);
      });
    });

    it("PO13: a progress destination that fails cancels authorship and delivers nothing", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness: PlanHarness = createPlanHarness({
          authorshipRoot,
          // The first chunk lands; the second is held until the turn it
          // announced is actually in flight, and then refused. A destination
          // that refused everything would prove only that nothing was ever
          // written, and a synchronous refusal would race the producer.
          *refuseProgress(_chunk, index) {
            if (index !== 1) {
              return undefined;
            }
            yield* harness.fake.startedTurns(1);
            return new Error("EPIPE: broken pipe, write");
          },
        });
        // Never settles on its own: the only way out of this turn is the
        // cancellation the failed write causes.
        harness.fake.script({ reply: PLAIN, manual: true });

        const { value, chunks } = yield* delivered(() =>
          runPlan(planning(dir, join(dir, "release.md")), harness.deps),
        );

        expect(value).toBe(1);
        // The live turn was cancelled and every owned teardown finished before
        // `runPlan` returned: the turn was cancelled, the provider was closed,
        // and the invocation's own session directory was handed back.
        expect(harness.fake.cancels).toBeGreaterThanOrEqual(1);
        expect(harness.fake.closes.length).toBeGreaterThan(0);
        expect(yield* until(readdir(authorshipRoot))).toEqual([]);
        // The bytes the destination had already accepted are not rolled back,
        // and the exact diagnostic reached it once a later write succeeded.
        expect(harness.progress[0]).toContain("Preparing the Plan");
        expect(harness.progress.at(-1)).toBe(
          "Could not write planning progress to stderr: EPIPE: broken pipe, write\n\n" +
            "Planning was cancelled, and no Plan was output.\n",
        );
        // No stdout fallback, no artifact, and no review.
        expect(chunks).toEqual([]);
        expect(harness.reviews).toHaveLength(0);
        expect(yield* until(readdir(dir))).toEqual([]);
      });
    });

    it("PO14: every existing ending keeps its order, and progress claims no delivery", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const out = join(dir, "release.md");
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: EFFECT_AND_FAILURE });

        // The artifact is still created after the whole authorship frame has
        // torn down, and the last thing an operator was told is that the
        // session was closing — never that a file exists.
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
        expect(yield* readTextFile(out)).toBe(EFFECT_AND_FAILURE);
        expect(chunks).toEqual([]);

        // Finalizing is the last phase, and it says the session is closing
        // rather than that a Plan was produced, written or output.
        const transcript = harness.progress.join("");
        expect(phasesOf(transcript).at(-1)).toBe("Finalizing the Plan");
        for (const claim of ["Plan produced", "Wrote", "written to", "was output"]) {
          expect(`${claim}: ${transcript.includes(claim)}`).toBe(`${claim}: false`);
        }
      });

      // Cancellation mid-turn: the progress already delivered stands, and no
      // phase after it claims anything.
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
        expect(phasesOf(harness.progress.join(""))).not.toContain("Finalizing the Plan");
        expect(yield* until(readdir(dir))).toEqual([]);
      });
    });

    it("PO15: the catalog is built once, from inside the command document", function* () {
      yield* useWorkingDirectory(function* (dir, authorshipRoot) {
        const harness = createPlanHarness({ authorshipRoot });
        harness.fake.script({ reply: PLAIN });
        harness.script({ decision: "Approve" });

        // Recorded against the progress the drain had at the time, so what this
        // observes is that Preparing reached the operator before the catalog
        // was read rather than merely that both happened.
        const before: string[][] = [];
        const catalog = harness.deps.catalog;
        harness.deps.catalog = function* (includes) {
          before.push(phasesOf(harness.progress.join("")));
          return yield* catalog(includes);
        };

        const { value } = yield* delivered(() => runPlan(planning(dir), harness.deps));

        expect(value).toBe(0);
        expect(harness.catalogCalls).toEqual([[dir]]);
        expect(before).toEqual([["Preparing the Plan"]]);
      });
    });
  },
);
