/**
 * Tier PR — `xmd prompt` writing a Plan, as the host and the packaged prompt
 * command document perform it together (specs/prompt-command-spec.md).
 *
 * The policy under test is `src/documents/prompt-command.md`, reached the way
 * the command reaches it: `runPrompt` builds the prompt profile, the packaged
 * document runs inside it, and every observation here is of that document's
 * behaviour rather than of a TypeScript loop standing in for it.
 *
 * The seams are deterministic. The ACPX runtime is the scriptable fake, the
 * review provider is a scripted `Elicitation` handler, the executor records what
 * it was handed, and the contextual working directory is a temporary one.
 * Nothing here starts an agent, opens a browser or reaches a network.
 *
 * Every refusal is proven by the phases that stayed at zero — turns not sent,
 * reviews not asked, executions not handed anything — rather than by output
 * nobody produced.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { API, stat } from "@executablemd/runtime";
import { Elicitation } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";

import { runPrompt } from "../src/prompt.ts";
import type { PromptCommand } from "../src/prompt.ts";
import {
  DEFAULT_PROFILE_ROOT,
  profileDirectoryFor,
  PROMPT_INSTRUCTIONS,
} from "../src/prompt-profile.ts";
import { scanPromptArgs } from "../src/prompt-args.ts";
import type { AgentStack } from "../src/agent-stack.ts";
import {
  AGENT,
  createPromptHarness,
  useProfileRoot,
  useWorkingDirectory,
} from "./support/prompt-harness.ts";
import { makeStore } from "./support/fake-acp.ts";
import type { PromptHarness } from "./support/prompt-harness.ts";

const REQUEST = "write a greeting";

/** A document that validates and runs. */
const VALID = "Hello from the agent.\n";

/** A document that resolves no such component. */
const UNRESOLVED = "<NoSuchComponent />\n";

/** A root whose own source cannot be read: the frontmatter never closes. */
const BROKEN_SOURCE = ["---", "props: [", "---", "", "hi", ""].join("\n");

/** A root whose two declared properties generate one option. */
const COLLIDING = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    firstName: { type: string }",
  "    first_name: { type: string }",
  "---",
  "",
  "hi",
  "",
].join("\n");

/** A root that declares one required scalar property. */
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
  "Hello, {props.name}!",
  "",
].join("\n");

/** The same document with `name` declared a switch instead. */
const NAME_IS_BOOLEAN = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    name: { type: boolean }",
  "  additionalProperties: false",
  "---",
  "",
  "Hello, {props.name}!",
  "",
].join("\n");

/** One document under two schemas that bind `--props-count` the same way. */
function counting(type: "number" | "string"): string {
  return [
    "---",
    "props:",
    "  type: object",
    "  properties:",
    `    count: { type: ${type} }`,
    "  additionalProperties: false",
    "---",
    "",
    "Counting to {props.count}.",
    "",
  ].join("\n");
}

/** A Plan whose effect is visible on the filesystem if anything runs it. */
const WRITES_A_FILE = ['<File path="drafted.txt">the draft ran</File>', ""].join("\n");

/** The Agent configuration a dispatch settles once and hands to both consumers. */
const STACK: AgentStack = {
  provider: "acpx",
  defaultAgent: AGENT,
  permissionMode: "deny-all",
};

/**
 * One invocation, asking for the approved Plan to be run.
 *
 * `--run` is the default here because these cases are about what reaches the
 * execution: the modes that write the Plan instead have their own cases, and
 * name the mode they mean.
 */
function command(dir: string, args: string[], stack: AgentStack = STACK): PromptCommand {
  const argv = ["prompt", ...args, "--run"];
  return { argv, scan: scanPromptArgs(argv), include: [dir], run: true, stack };
}

/**
 * What every turn that asks for a Plan has to say, on its own.
 *
 * Pinned as one block rather than as sentences found anywhere in the document: a
 * repair or a revision that quietly dropped a clause would still satisfy a
 * search for the words somewhere, and a replacement Plan is only complete if the
 * message asking for it said so.
 */
const PLAN_REQUIREMENTS = [
  "Every Plan is complete on its own:",
  "",
  "- optional frontmatter, and then one descriptive level-one Markdown heading as",
  "  the first body content;",
  "- the Prompt's complete sequence, written as readable steps;",
  "- every outcome the Prompt asked for;",
  "- those steps in an order that makes sense; and",
  "- each XMD component beside the prose describing the action it performs.",
].join("\n");

/** Every session key the fake was asked to establish, deduplicated in order. */
function sessions(harness: PromptHarness): string[] {
  return [...new Set(harness.fake.ensured.map((input) => input.sessionKey))];
}

/** The decisions one review request offered. */
function decisions(request: ElicitationRequest): unknown {
  const properties = request.schema.properties;
  if (typeof properties !== "object" || properties === null) {
    return undefined;
  }
  const decision = (properties as Record<string, unknown>).decision;
  if (typeof decision !== "object" || decision === null) {
    return undefined;
  }
  return (decision as Record<string, unknown>).enum;
}

/**
 * A review provider that looks at the profile directory before it answers.
 *
 * Installed in place of the harness's own, so the observation happens inside the
 * profile's scope — the only moment the directory exists.
 */
function watching(
  harness: PromptHarness,
  observe: (workdir: string) => Operation<void>,
): () => Operation<void> {
  return function* () {
    yield* Elicitation.around(
      {
        *elicit([request], _next) {
          harness.reviews.push(request);
          yield* observe(String(harness.fake.created[0]?.cwd));
          return { decision: "Approve" };
        },
      },
      { at: "min" },
    );
  };
}

/** Whether a path is there at all. */
function* exists(path: string): Operation<boolean> {
  return (yield* stat(path)).exists;
}

/** What one message's `json` fence holds, parsed back. */
interface FencedDiagnostics {
  validation?: {
    version?: number;
    outcome?: string;
    diagnostics?: { code?: string }[];
  };
}

/**
 * The complete JSON a message carried, read out of its fence.
 *
 * Parsed rather than string-matched: what matters is that `<Json>`'s serialized
 * text reached `<CodeBlock>` whole, and a structure that parses back to the same
 * shape is what says so.
 */
function fencedJson(message: string): FencedDiagnostics {
  const fence = /```json\n([\s\S]*?)\n```/.exec(message);
  if (fence === null) {
    throw new Error(`no json fence in: ${message}`);
  }
  return JSON.parse(fence[1]);
}

/** How many times one exact string appears. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

describe(
  "Tier PR — xmd prompt writing a Plan",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("C2, C3, C14: the packaged program's own words ask for the document", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        // A repository TypeScript component, so the catalog has to state the one
        // thing it honestly cannot know without importing the module.
        yield* writeTextFile(join(dir, "Widget.ts"), "export default function Widget() {}\n");

        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);

        // Exactly one catalog, built with the invocation's own includes.
        expect(harness.catalogCalls).toEqual([[dir]]);

        // The turn is the shipped Markdown's, word for word: the sentences below
        // exist nowhere in TypeScript, so a host that chose its own policy could
        // not produce them.
        const turn = harness.fake.prompts[0];
        expect(turn).toContain("Create one complete XMD Plan from this Prompt");
        // C14: the complete Plan requirement, stated in this turn rather than
        // referred to from somewhere else in the document.
        expect(turn).toContain(PLAN_REQUIREMENTS);
        // The worked example travels with it, unparsed, and is a titled Plan —
        // the shape being asked for is the shape being shown.
        expect(turn).toContain('<File path="age.txt">{answer.age}</File>');
        expect(turn).toContain("# Ask for and save your age");
        expect(turn).toContain("keep every outcome it asked for");
        // The request travels inside it, byte for byte.
        expect(turn).toContain(REQUEST);
        // So does the host's catalog, including the renderer's honest statement
        // about a component nobody imported.
        expect(turn).toContain("## Built-in components");
        expect(turn).toContain("### `<Agent>`");
        expect(turn).toContain("### `<Widget>`");
        expect(turn).toContain("This component is a repository TypeScript module.");

        // The host owns the instruction layer, and owns only the shape of an
        // answer: the catalog and the request are the program's to send.
        expect(harness.fake.ensured[0]?.sessionOptions?.systemPrompt).toBe(PROMPT_INSTRUCTIONS);
        expect(PROMPT_INSTRUCTIONS).not.toContain("Built-in components");

        // C3: one <Prompt> is one turn. Nothing repaired, nothing retried.
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.fake.turns).toHaveLength(1);
        expect(harness.reviews).toHaveLength(1);
      });
    });

    it("C3, C14: every turn that asks for a Plan states the whole requirement", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        // A draft that fails its check, then one that passes, then a revision.
        // Three turns, one of each kind that produces a Plan.
        harness.fake.script({ reply: UNRESOLVED });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Request changes", feedback: "say it differently" });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);

        const [initial, repair, revision] = harness.fake.prompts;
        expect(harness.fake.prompts).toHaveLength(3);
        expect(initial).toContain("Create one complete XMD Plan from this Prompt");
        expect(repair).toContain("Send one complete replacement Plan that resolves every problem");
        expect(revision).toContain("say it differently");

        // Each of them carries the requirement itself. A turn that only said
        // "keep what the last draft had" would leave a missing or wrong title
        // missing or wrong, and none of these do.
        for (const turn of [initial, repair, revision]) {
          expect(turn).toContain(PLAN_REQUIREMENTS);
        }

        // And a replacement is told to write the title the Plan needs rather
        // than to carry the previous one forward.
        for (const turn of [repair, revision]) {
          expect(turn).toContain(
            "Write the title the Plan needs rather than the one the last draft had",
          );
          expect(turn).toContain("add it if\nit was missing");
          expect(turn).not.toContain("Keep its\nlevel-one title");
        }
      });
    });

    it("C4: one Session carries every turn, and --session names it", function* () {
      // Initial, repair and revision turns all land in one conversation, and a
      // second invocation places a different one in a directory of its own.
      const keys: string[] = [];
      const directories: string[] = [];
      for (const _invocation of [0, 1]) {
        yield* useWorkingDirectory(function* (dir, profileRoot) {
          const harness = createPromptHarness({ profileRoot });
          harness.fake.script({ reply: UNRESOLVED });
          harness.fake.script({ reply: UNRESOLVED });
          harness.fake.script({ reply: UNRESOLVED });
          harness.fake.script({ reply: UNRESOLVED });
          harness.script({ decision: "Request changes", feedback: "try plain text" });
          harness.fake.script({ reply: VALID });
          harness.script({ decision: "Approve" });

          const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
          expect(code).toBe(0);
          // A draft, three repairs, a revision: five turns, one session.
          expect(harness.fake.prompts).toHaveLength(5);
          expect(sessions(harness)).toHaveLength(1);
          keys.push(sessions(harness)[0]);
          const workdir = String(harness.fake.created[0]?.cwd);
          directories.push(workdir);
          // This suite reaches no directory this host would use for real.
          expect(workdir.startsWith(`${profileRoot}${sep}`)).toBe(true);
          expect(workdir.startsWith(DEFAULT_PROFILE_ROOT)).toBe(false);
        });
      }
      expect(keys[0]).not.toBe(keys[1]);
      // Different conversations, so different directories: a generated name
      // reaches a location nothing else does.
      expect(directories[0]).not.toBe(directories[1]);

      // `--session` replaces the generated name, so two invocations name one
      // conversation in one directory — and one ACPX store is what turns that
      // from equal keys into an actually continued session. The root is shared
      // deliberately, and by this case alone.
      yield* useProfileRoot(function* (profileRoot) {
        const store = makeStore();
        const named: string[] = [];
        const namedDirectories: string[] = [];
        const materializations: (string | undefined)[] = [];
        const survived: boolean[] = [];
        for (const _invocation of [0, 1]) {
          yield* useWorkingDirectory(function* (dir) {
            const harness = createPromptHarness({ profileRoot, store });
            harness.fake.script({ reply: VALID });
            harness.script({ decision: "Approve" });

            const code = yield* runPrompt(
              { ...command(dir, [REQUEST]), session: "ada" },
              harness.deps,
            );
            expect(code).toBe(0);
            named.push(sessions(harness)[0]);
            namedDirectories.push(String(harness.fake.created[0]?.cwd));
            materializations.push(harness.fake.ensured[0]?.materialization);
            // A named conversation's directory outlives the invocation, because
            // its identity is what the next `--session ada` derives.
            survived.push(yield* exists(profileDirectoryFor(profileRoot, "ada")));
          });
        }
        expect(named[0]).toBe(named[1]);
        expect(namedDirectories[0]).toBe(namedDirectories[1]);
        expect(survived).toEqual([true, true]);
        // The name never reaches the path, and the digest is what the host
        // derived from it.
        expect(namedDirectories[0]).toBe(profileDirectoryFor(profileRoot, "ada"));
        expect(namedDirectories[0]).not.toContain("ada");

        // The second invocation continued the record the first established
        // rather than placing a second one: the store holds one, and only the
        // first ensure asked for a session to be materialized by its first turn.
        expect([...store.records.keys()]).toEqual([named[0]]);
        expect(materializations).toEqual(["first-turn-acceptance", undefined]);
      });
    });

    it("C4, C13: a default session's directory belongs to its invocation", function* () {
      // It exists and is empty while the turn runs, and it is gone once the
      // profile has torn down — before anything the host does with what was
      // approved.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });
        const seen: { workdir?: string; entries?: string[] } = {};
        harness.deps.installElicitation = watching(harness, function* (workdir) {
          seen.workdir = workdir;
          seen.entries = yield* until(readdir(workdir));
        });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(0);
        expect(seen.entries).toEqual([]);
        expect(seen.workdir?.startsWith(`${profileRoot}${sep}`)).toBe(true);
        // Handed back non-recursively when the conversation ended, and the root
        // it lived under is still there for the next one.
        expect(yield* exists(String(seen.workdir))).toBe(false);
        expect(yield* exists(profileRoot)).toBe(true);
        // The approved Plan still ran: cleanup is not a failure.
        expect(harness.executions).toHaveLength(1);
      });

      // Abort, a turn that failed, and a cancelled command each hand the
      // directory back the same way a success does.
      for (const ending of [
        { name: "stop", drive: (harness: PromptHarness) => harness.script({ decision: "Stop" }) },
        {
          name: "a failed turn",
          drive: (harness: PromptHarness) => {
            harness.fake.script({ reply: VALID, stopReason: "refusal" });
          },
        },
      ]) {
        yield* useWorkingDirectory(function* (dir, profileRoot) {
          const harness = createPromptHarness({ profileRoot });
          if (ending.name === "stop") {
            harness.fake.script({ reply: VALID });
          }
          ending.drive(harness);

          const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

          expect(code).toBe(1);
          expect(harness.executions).toHaveLength(0);
          // That exact leaf, and the root it lived under, both answer the
          // question: the directory this ending made is gone, and nothing else
          // was made in its place.
          expect(yield* exists(String(harness.fake.created[0]?.cwd))).toBe(false);
          expect(yield* until(readdir(profileRoot))).toEqual([]);
        });
      }

      // Cancellation: the turn in flight is interrupted, and the ensure that
      // hands the directory back runs on the way out like every other one.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID, manual: true });

        yield* scoped(function* () {
          const running = yield* spawn(() => runPrompt(command(dir, [REQUEST]), harness.deps));
          yield* harness.fake.startedTurns(1);
          yield* running.halt();
        });

        expect(yield* exists(String(harness.fake.created[0]?.cwd))).toBe(false);
        expect(yield* until(readdir(profileRoot))).toEqual([]);
      });

      // A failure between making the leaf and using it still hands it back. The
      // claim is taken before the `mkdir`, so there is no window in which a
      // directory exists that nothing is responsible for.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });
        // deno-lint-ignore require-yield
        harness.deps.installElicitation = function* () {
          throw new Error("this host could not install a review provider");
        };

        const { value, lines } = yield* reported(() =>
          runPrompt(command(dir, [REQUEST]), harness.deps),
        );

        expect(value).toBe(1);
        expect(lines.join("\n")).toContain("could not install a review provider");
        // Nothing was built after it, and no empty leaf was left behind.
        expect(harness.fake.created).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
        expect(yield* until(readdir(profileRoot))).toEqual([]);
      });

      // Establishment failing for a reason of its own leaves nothing behind and
      // says what it found. The claim is already taken here, so the release runs
      // and finds no directory it was ever given — which is the one case where
      // an absent directory is the ordinary answer rather than interference.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const blocked = join(profileRoot, "not-a-directory");
        yield* writeTextFile(blocked, "in the way\n");

        const harness = createPromptHarness({ profileRoot: blocked });
        harness.fake.script({ reply: VALID });

        const { value, lines } = yield* reported(() =>
          runPrompt(command(dir, [REQUEST]), harness.deps),
        );

        expect(value).toBe(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("could not establish");
        // What was in the way is untouched, and no phase after it began.
        expect(yield* readTextFile(blocked)).toBe("in the way\n");
        expect(harness.fake.created).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });

      // A leaf that disappears under a live conversation is interference, not a
      // tidy exit. The command fails terminally rather than shrugging at an
      // absent directory, and nothing it would have done next happens.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });
        harness.deps.installElicitation = watching(harness, function* (workdir) {
          yield* rm(workdir, { recursive: true, force: true });
        });

        const { value, lines } = yield* reported(() =>
          runPrompt({ ...command(dir, [REQUEST]), output: "out.md" }, harness.deps),
        );

        expect(value).toBe(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("was made for this conversation and is already gone");
        expect(lines[0]).not.toContain("does not validate");
        // The Plan was approved and still reached nothing: no admission that
        // could have saved it, no save, no execution and so no journal.
        expect(harness.reviews).toHaveLength(1);
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* until(readdir(dir))).toEqual([]);
        expect(harness.executions).toHaveLength(0);
      });

      // The other outcome of the one attempt. A directory this invocation was
      // given empty and did not leave empty is preserved and the command fails:
      // something wrote there while the conversation ran, and this host
      // authorized nothing to. The draft was approved first, so what is being
      // observed is a Plan that would otherwise have been saved and run.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });
        let workdir: string | undefined;
        let planted: string | undefined;
        harness.deps.installElicitation = watching(harness, function* (directory) {
          workdir = directory;
          planted = join(directory, "stowaway.txt");
          yield* writeTextFile(planted, "not this command's doing\n");
        });

        const { value, lines } = yield* reported(() =>
          runPrompt({ ...command(dir, [REQUEST]), output: "out.md" }, harness.deps),
        );

        // Terminal, and said once: the attempt happens once and either settles
        // the directory or ends the command.
        expect(value).toBe(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("was empty when this conversation started");
        expect(lines[0]).toContain("its contents were left alone");
        // The one line is the directory's, not admission's: the attempt settles
        // before the host looks at what was approved, so a run that had reached
        // admission would have reported that instead.
        expect(lines[0]).not.toContain("does not validate");

        // Preserved whole — the directory and what appeared in it. A recursive
        // removal would have taken both.
        expect(harness.reviews).toHaveLength(1);
        expect(yield* exists(String(workdir))).toBe(true);
        expect(yield* readTextFile(String(planted))).toBe("not this command's doing\n");

        // And nothing after the failure began: no save, and no execution — so no
        // journal, which only an execution creates.
        expect(yield* exists(join(dir, "out.md"))).toBe(false);
        expect(yield* until(readdir(dir))).toEqual([]);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("C13: a default directory is handed back before final admission", function* () {
      // The same veto C10 proves, watched from the other side: by the time the
      // host reports what it decided about the approved bytes, the conversation
      // and its directory are both already gone.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const widget = join(dir, "Widget.md");
        yield* writeTextFile(widget, "A widget.\n");
        const draft = ["# Uses a widget", "", "<Widget />", ""].join("\n");

        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: draft });
        let workdir: string | undefined;
        harness.deps.installElicitation = watching(harness, function* (directory) {
          workdir = directory;
          yield* rm(widget, { force: true });
        });

        const events: string[] = [];
        const written = console.error;
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            console.error = written;
          });
          console.error = () => {
            events.push("reported");
          };
          return yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        });

        expect(code).toBe(1);
        // Admission ran, and it ran after the directory was handed back: the
        // observation below is taken at the moment the host reported its
        // decision.
        expect(events).toEqual(["reported"]);
        expect(yield* exists(String(workdir))).toBe(false);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("C5: the prompt profile's ceiling is the host's, and no flag widens it", function* () {
      // This session's own directory, empty, no MCP servers and no native tools
      // — observed while the command document is still running, because that is
      // the only moment the claim is about.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        yield* writeTextFile(join(dir, "secret.txt"), "the caller's tree\n");

        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });
        const seen: { cwd?: string; entries?: string[]; refusals: string[] } = { refusals: [] };
        harness.deps.installElicitation = function* () {
          yield* Elicitation.around(
            {
              *elicit([request], _next) {
                harness.reviews.push(request);
                const cwd = harness.fake.created[0]?.cwd;
                seen.cwd = cwd;
                seen.entries = cwd === undefined ? undefined : yield* until(readdir(cwd));
                // The command document's own capabilities, asked for from inside
                // its scope. It decides what to write; it writes nothing.
                for (const [name, ask] of [
                  ["a directory", () => API.Files.operations.temporaryDirectory()],
                  ["a command", () => API.Process.operations.exec({ command: ["true"] })],
                  ["the network", () => API.Fetch.operations.fetch("http://localhost")],
                ] as const) {
                  try {
                    yield* ask();
                    seen.refusals.push(`${name} was granted`);
                  } catch (error) {
                    seen.refusals.push(error instanceof Error ? error.message : String(error));
                  }
                }
                return { decision: "Approve" };
              },
            },
            { at: "min" },
          );
        };

        const code = yield* runPrompt(
          { ...command(dir, [REQUEST]), session: "ceiling" },
          harness.deps,
        );
        expect(code).toBe(0);

        // Not the caller's working directory: this session's, and empty while
        // the conversation ran.
        expect(seen.cwd).not.toBe(dir);
        expect(seen.cwd).toBe(profileDirectoryFor(profileRoot, "ceiling"));
        expect(seen.entries).toEqual([]);
        // Stated rather than omitted: this host configures no MCP server and
        // allows no native tool on a fresh session.
        expect(harness.fake.created[0]?.mcpServers).toEqual([]);
        expect(harness.fake.ensured[0]?.sessionOptions?.allowedTools).toEqual([]);
        // And the command document is given nothing to act with.
        expect(seen.refusals).toEqual([
          "xmd prompt asked for a directory, which the prompt profile grants to nothing",
          "xmd prompt asked for a command, which the prompt profile grants to nothing",
          "xmd prompt asked for the network, which the prompt profile grants to nothing",
        ]);
      });

      // Something already in a named session's directory is a refusal, not a
      // cleanup. It happens before the provider exists, so no session is placed
      // and no turn is started — and what was there is still there afterwards.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const occupied = profileDirectoryFor(profileRoot, "occupied");
        yield* ensureDir(occupied);
        yield* writeTextFile(join(occupied, "someone-elses.txt"), "not mine to delete\n");

        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });

        const { value, lines } = yield* reported(() =>
          runPrompt({ ...command(dir, [REQUEST]), session: "occupied" }, harness.deps),
        );

        expect(value).toBe(1);
        expect(lines.join("\n")).toContain("is not empty");
        expect(lines.join("\n")).toContain("name a different --session");
        expect(lines.join("\n")).toContain(occupied);
        // Nothing downstream of the refusal happened.
        expect(harness.fake.created).toHaveLength(0);
        expect(harness.fake.ensured).toHaveLength(0);
        expect(harness.fake.started).toBe(false);
        expect(harness.fake.prompts).toHaveLength(0);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
        // The contents were left exactly as they were found.
        expect(yield* readTextFile(join(occupied, "someone-elses.txt"))).toBe(
          "not mine to delete\n",
        );
      });

      // `--approve-all` configures the approved document. A native permission
      // request while the Plan is being written is still denied, privately, and
      // the turn it belongs to fails.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID, requestsTool: "Bash" });

        const code = yield* runPrompt(
          command(dir, [REQUEST], { ...STACK, permissionMode: "approve-all" }),
          harness.deps,
        );

        expect(code).toBe(1);
        expect(harness.fake.decisions).toEqual(["reject_once"]);
        // The denial ended the command: nobody was asked and nothing ran.
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("C5: two cases' profile roots cannot see or remove one another", function* () {
      // Roots are made per scope and named by a UUID, so one case's cleanup
      // cannot reach another's directory even while both are live.
      yield* useProfileRoot(function* (mine) {
        const marker = join(mine, "mine.txt");
        yield* writeTextFile(marker, "still here\n");

        yield* useWorkingDirectory(function* (dir, profileRoot) {
          expect(profileRoot).not.toBe(mine);
          expect(profileRoot.startsWith(`${mine}${sep}`)).toBe(false);
          expect(mine.startsWith(`${profileRoot}${sep}`)).toBe(false);

          const harness = createPromptHarness({ profileRoot });
          harness.fake.script({ reply: VALID });
          harness.script({ decision: "Approve" });

          const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
          expect(code).toBe(0);
          // The other root is untouched, and this one holds nothing afterwards.
          expect(yield* readTextFile(marker)).toBe("still here\n");
          expect(yield* until(readdir(profileRoot))).toEqual([]);
        });

        expect(yield* readTextFile(marker)).toBe("still here\n");
      });
    });

    it("C6: a candidate is inert until the approved document runs", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: WRITES_A_FILE });
        harness.script({ decision: "Stop" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(1);
        // Validated, presented, and never run: the document's own write is the
        // effect that would have happened if anything had executed it.
        expect(harness.reviews).toHaveLength(1);
        expect((yield* until(readdir(dir))).includes("drafted.txt")).toBe(false);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("C7: candidate defects earn a repair turn; caller defects escape", function* () {
      // A defect the agent authored: the root's own frontmatter.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: BROKEN_SOURCE });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(0);
        expect(harness.fake.prompts).toHaveLength(2);
        expect(harness.fake.prompts[1]).toContain("That Plan has problems");
        // `<Json as>` captured the whole serialized value, and the fence it went
        // into holds every byte of it: the wrapper's removal changed where the
        // text is bound, not what it says. Parsed back rather than matched, so
        // what is proven is that the complete structure survived the trip.
        const repaired = fencedJson(harness.fake.prompts[1]);
        expect(repaired.validation?.version).toBe(1);
        expect(repaired.validation?.outcome).toBe("invalid");
        expect(
          repaired.validation?.diagnostics?.some((entry) => entry.code === "source-invalid"),
        ).toBe(true);
        expect(harness.fake.prompts[1]).toContain("source-invalid");
        // The whole versioned value, as data the program serialized.
        expect(harness.fake.prompts[1]).toContain('"version": 1');
        expect(harness.executions).toHaveLength(1);
      });

      // A defect the agent authored: two properties generating one option.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: COLLIDING });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(0);
        expect(harness.fake.prompts).toHaveLength(2);
        expect(harness.fake.prompts[1]).toContain("generated-binding-collision");
        expect(harness.fake.prompts[1]).toContain("--props-first-name");
        // Carried as this command's own finding, not as a core diagnostic code.
        expect(harness.fake.prompts[1]).not.toContain("DocumentValidationCode");
      });

      // A defect the caller wrote: an option the candidate never declares. It
      // raises out of the validator, so the program never sees it as feedback.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });

        const code = yield* runPrompt(
          command(dir, [REQUEST, "--props-nothing", "here"]),
          harness.deps,
        );

        expect(code).toBe(1);
        // One turn, no repair: the agent cannot fix a command line.
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });

      // A defect the caller wrote: aggregate JSON that is not JSON.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });

        const code = yield* runPrompt(command(dir, [REQUEST, "--props", "{oops"]), harness.deps);

        expect(code).toBe(1);
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });

      // A defect the caller wrote: a value this candidate's schema rejects.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: NAME_IS_BOOLEAN });

        const code = yield* runPrompt(
          command(dir, [REQUEST, "--props-name=not-a-boolean"]),
          harness.deps,
        );

        expect(code).toBe(1);
        expect(harness.fake.prompts).toHaveLength(1);
        expect(harness.reviews).toHaveLength(0);
        expect(harness.executions).toHaveLength(0);
      });

      // A revision that changes what the command line means is the caller's
      // failure too, and it is caught before the candidate is presented.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: REQUIRES_NAME });
        harness.script({ decision: "Request changes", feedback: "make it shout" });
        harness.fake.script({ reply: NAME_IS_BOOLEAN });

        const code = yield* runPrompt(command(dir, [REQUEST, "--props-name", "Ada"]), harness.deps);

        expect(code).toBe(1);
        expect(harness.reviews).toHaveLength(1);
        expect(harness.executions).toHaveLength(0);
        expect(harness.fake.prompts).toHaveLength(2);
      });
    });

    it("C8: one base draft, three repairs, and ten presentations", function* () {
      // Three repairs are available, and the fourth draft is what a person sees.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: UNRESOLVED });
        harness.fake.script({ reply: UNRESOLVED });
        harness.fake.script({ reply: UNRESOLVED });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(0);
        expect(harness.fake.prompts).toHaveLength(4);
        expect(harness.reviews).toHaveLength(1);
        expect(decisions(harness.reviews[0])).toEqual(["Approve", "Request changes", "Stop"]);
      });

      // A fourth invalid candidate is repair-exhausted: it reaches review with
      // its diagnostics, and there is no value that would approve it.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        for (const _draft of [0, 1, 2, 3]) {
          harness.fake.script({ reply: UNRESOLVED });
        }
        harness.script({ decision: "Stop" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(1);
        expect(harness.fake.prompts).toHaveLength(4);
        expect(harness.reviews).toHaveLength(1);
        expect(decisions(harness.reviews[0])).toEqual(["Request changes", "Stop"]);
        expect(harness.reviews[0].message).toContain(
          "The coding agent used all three repair attempts",
        );
        // The presentation carries the same complete captured JSON the repair
        // turns did, through the same `<Json as>` binding.
        const shown = fencedJson(harness.reviews[0].message);
        expect(shown.validation?.version).toBe(1);
        expect(
          shown.validation?.diagnostics?.some((entry) => entry.code === "component-unresolved"),
        ).toBe(true);
        expect(harness.executions).toHaveLength(0);
      });

      // Ten presentations: nine revisions, and a tenth round with nothing left
      // to revise into. Each revision starts its own repair budget.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        for (const round of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          harness.fake.script({ reply: VALID });
          if (round < 10) {
            harness.script({ decision: "Request changes", feedback: `round ${round}` });
          }
        }
        harness.script({ decision: "Stop" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);

        expect(code).toBe(1);
        expect(harness.reviews).toHaveLength(10);
        // Every draft validated first time, so each round cost exactly one turn.
        expect(harness.fake.prompts).toHaveLength(10);
        expect(harness.fake.prompts[1]).toContain("round 1");
        for (const round of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
          expect(decisions(harness.reviews[round])).toEqual(["Approve", "Request changes", "Stop"]);
        }
        // The last presentation offers no revision, because there is no eleventh
        // round to revise into.
        expect(decisions(harness.reviews[9])).toEqual(["Approve", "Stop"]);
        // One conversation held all ten.
        expect(sessions(harness)).toHaveLength(1);
      });
    });

    it("C9: arbitrary source cannot close the presentation, and abort is authored", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        // A document that holds a fence of its own, and a run of five backticks.
        const fenced = [
          "Here is a block:",
          "",
          "```bash",
          "echo hi",
          "```",
          "",
          "and `````five````` backticks.",
          "",
        ].join("\n");

        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: fenced });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);

        const message = harness.reviews[0].message;
        // The fence is longer than every run inside the candidate, so nothing in
        // the source can close it.
        expect(message).toContain("``````markdown\n");
        expect(message).toContain(`\n${fenced}\n\`\`\`\`\`\``);
      });

      // Abort reaches the command document's own `<Fail>`, with the message the
      // shipped Markdown wrote. Nothing about it is host policy.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Stop" });

        const { value, lines } = yield* reported(() =>
          runPrompt(command(dir, [REQUEST]), harness.deps),
        );

        expect(value).toBe(1);
        expect(lines.join("\n")).toContain(
          "xmd prompt stopped at your request. Nothing was output or run.",
        );
        expect(harness.executions).toHaveLength(0);
      });

      // Exhaustion is reachable, and it is a different ending. Ten presentations
      // that never validated, the last offering nothing but `abort`, and the
      // sentence says there was never a Plan to approve rather than that
      // somebody decided to stop.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        for (const round of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          // A base draft and its three repairs, none of which validates.
          for (const _draft of [0, 1, 2, 3]) {
            harness.fake.script({ reply: UNRESOLVED });
          }
          harness.script(
            round < 10
              ? { decision: "Request changes", feedback: `round ${round}` }
              : { decision: "Stop" },
          );
        }

        const { value, lines } = yield* reported(() =>
          runPrompt(command(dir, [REQUEST], STACK), harness.deps),
        );

        expect(value).toBe(1);
        expect(harness.reviews).toHaveLength(10);
        // Rounds one to nine could be sent back; the tenth had one choice, and
        // taking it is what reaches the exhaustion ending.
        expect(decisions(harness.reviews[8])).toEqual(["Request changes", "Stop"]);
        expect(decisions(harness.reviews[9])).toEqual(["Explain what went wrong", "Stop"]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toBe(
          "xmd prompt reviewed ten drafts without an approved Plan. Nothing was output or run.",
        );
        // Stopping asks the coding agent nothing: forty drafting turns and no
        // forty-first.
        expect(harness.fake.prompts).toHaveLength(40);
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("C3, C9: the last invalid draft can be explained rather than only stopped", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        for (const round of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
          for (const _draft of [0, 1, 2, 3]) {
            harness.fake.script({ reply: UNRESOLVED });
          }
          harness.script(
            round < 10
              ? { decision: "Request changes", feedback: `round ${round}` }
              : { decision: "Explain what went wrong" },
          );
        }
        // The explanation the coding agent gives is prose, and stays prose.
        const explanation = [
          "Every draft used <NoSuchComponent />, which this profile does not offer.",
          "",
          "Say which of the available components should do the work, or describe the",
          "outcome without naming a component: <Return value={1} />",
        ].join("\n");
        harness.fake.script({ reply: explanation });

        const { value, lines } = yield* reported(() =>
          runPrompt(command(dir, [REQUEST]), harness.deps),
        );

        expect(value).toBe(1);
        // Exactly one turn more than the forty drafting turns, in the same
        // conversation. It is not another draft: no eleventh review, and the
        // ten-draft limit is not reopened.
        expect(harness.fake.prompts).toHaveLength(41);
        expect(harness.reviews).toHaveLength(10);
        expect(sessions(harness)).toHaveLength(1);

        // It carries the final problems, which were produced after the agent's
        // last draft and have not appeared in the conversation — and nothing
        // else. The Session already holds the Prompt, the catalog and every
        // draft, so none of them is resent.
        const asked = harness.fake.prompts[40];
        expect(
          fencedJson(asked).validation?.diagnostics?.some(
            (entry) => entry.code === "component-unresolved",
          ),
        ).toBe(true);
        expect(asked).toContain("Do not create another Plan");
        expect(asked).not.toContain(REQUEST);
        expect(asked).not.toContain("## Built-in components");
        expect(asked).not.toContain(UNRESOLVED.trim());

        // What it said is reported as the coding agent's words, and the command
        // ends. Nothing about the explanation is treated as a Plan.
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("reviewed ten drafts without an approved Plan");
        expect(lines[0]).toContain(explanation);
        expect(lines[0]).toContain("Nothing was output or run.");
        expect(harness.executions).toHaveLength(0);
      });
    });

    it("C10, C11: the approved bytes are what runs, and props are theirs", function* () {
      // The command line is unchanged across a revision, and the schema that
      // resolves it is the approved document's rather than the first draft's.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: counting("number") });
        harness.script({ decision: "Request changes", feedback: "count in words" });
        harness.fake.script({ reply: counting("string") });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST, "--props-count", "7"]), harness.deps);

        expect(code).toBe(0);
        // Resolved under the approved bytes: a props object kept from the first
        // candidate would carry the number 7.
        expect(harness.executions[0]?.props).toEqual({ count: "7" });
        expect(harness.executions[0]?.root.source).toBe(counting("string"));
        expect(harness.executions[0]?.root.path).toBe("<prompt>");
      });

      // Nothing is stripped. A reply wrapped in a fence is not a document, so it
      // earns repairs and a review — and what is shown is exactly what arrived.
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const wrapped = ["```md", "Hello.", "```", ""].join("\n");
        const harness = createPromptHarness({ profileRoot });
        for (const _draft of [0, 1, 2, 3]) {
          harness.fake.script({ reply: wrapped });
        }
        harness.script({ decision: "Stop" });

        yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(harness.reviews[0].message).toContain(wrapped);
      });
    });

    it("C10: final admission vetoes after the profile has torn down", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        // A repository component the draft uses. It exists while the command
        // document runs, so the same production validator that answers
        // <CheckDraft> finds the draft sound.
        const widget = join(dir, "Widget.md");
        yield* writeTextFile(widget, "A widget.\n");
        const draft = ["# Uses a widget", "", "<Widget />", ""].join("\n");

        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: draft });
        const events: string[] = [];
        harness.deps.installElicitation = function* () {
          // Registered inside the profile's scope, so it runs while that scope
          // is being torn down — after the provider is gone and before the host
          // looks at what was approved.
          yield* ensure(function* () {
            events.push("teardown");
            yield* rm(widget, { force: true });
          });
          yield* Elicitation.around(
            {
              // deno-lint-ignore require-yield
              *elicit([request], _next) {
                harness.reviews.push(request);
                return { decision: "Approve" };
              },
            },
            { at: "min" },
          );
        };

        const written = console.error;
        const lines: string[] = [];
        const code = yield* scoped(function* (): Operation<number> {
          yield* ensure(() => {
            console.error = written;
          });
          console.error = (...parts: unknown[]) => {
            events.push("reported");
            lines.push(parts.map((part) => String(part)).join(" "));
          };
          return yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        });

        // The draft was sound enough to approve, and the approved bytes are
        // unchanged — only the tree they resolve against moved.
        expect(harness.reviews).toHaveLength(1);
        expect(harness.reviews[0].message).toContain("<Widget />");

        // The gate is effective on its own: the same bytes now fail, because the
        // host validates them again rather than trusting what the document
        // concluded while its own scope was still standing.
        expect(code).toBe(1);
        expect(lines.join("\n")).toContain("the approved document does not validate");
        expect(lines.join("\n")).toContain("component-unresolved");
        expect(lines.join("\n")).toContain("Widget");

        // And it is ordered: teardown finished first, which is the only reason
        // the component was missing when the second validation ran.
        expect(events).toEqual(["teardown", "reported"]);

        // Nothing after the veto happened.
        expect(harness.executions).toHaveLength(0);
        expect((yield* until(readdir(dir))).sort()).toEqual([]);
      });
    });

    it("C14: an interleaved Plan survives approval and execution byte for byte", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        // What the shipped instruction asks for: the request restated in prose a
        // reader was written for, with each component beside the sentences that
        // describe what it does.
        const plan = [
          "# Your age",
          "",
          "You asked to be asked for your age and to have it written down, so this",
          "document does exactly that, in that order.",
          "",
          "First, the question.",
          "",
          '<Elicit as="answer" schema={{ type: "object", properties: { age: { type: "number" } } }} />',
          "",
          "Then the answer goes to a file beside this document.",
          "",
          '<File path="age.txt">{answer.age}</File>',
          "",
        ].join("\n");

        const harness = createPromptHarness({ profileRoot });
        harness.fake.script({ reply: plan });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(
          command(dir, ["ask me for my age and write it to a file"]),
          harness.deps,
        );

        expect(code).toBe(0);
        // The prose reached the person who approved it, inside the presentation
        // fence and unaltered.
        expect(harness.reviews[0].message).toContain(plan);
        // And the exact bytes are what runs: nothing trimmed, re-fenced or
        // reflowed between approval and execution.
        expect(harness.executions[0]?.root.source).toBe(plan);
      });
    });

    it("C3, C9: what you read says each thing once, however many rounds it took", function* () {
      yield* useWorkingDirectory(function* (dir, profileRoot) {
        const harness = createPromptHarness({ profileRoot });
        // Round one: a draft that cannot be repaired, presented with its problems.
        for (const _draft of [0, 1, 2, 3]) {
          harness.fake.script({ reply: UNRESOLVED });
        }
        harness.script({ decision: "Request changes", feedback: "use plain text" });
        // Round two: a draft that passes, and is approved.
        harness.fake.script({ reply: VALID });
        harness.script({ decision: "Approve" });

        const code = yield* runPrompt(command(dir, [REQUEST]), harness.deps);
        expect(code).toBe(0);

        const [exhausted, approvable] = harness.reviews.map((review) => review.message);
        // The heading each presentation carries appears once in it, and the
        // second presentation carries neither the first draft nor its problems:
        // a loop that accumulated its explanation would show both.
        for (const message of [exhausted, approvable]) {
          expect(occurrences(message, "### Original Prompt")).toBe(1);
          expect(occurrences(message, "### Draft Plan")).toBe(1);
        }
        expect(occurrences(exhausted, "### Problems that remain")).toBe(1);
        expect(approvable).not.toContain("Problems that remain");
        expect(approvable).not.toContain("NoSuchComponent");
        expect(exhausted).not.toContain(VALID.trim());

        // The repair turns say what they need once each, and carry only the
        // problems of the draft they are repairing.
        for (const repair of harness.fake.prompts.slice(1, 4)) {
          expect(occurrences(repair, "That Plan has problems")).toBe(1);
          expect(occurrences(repair, "Send one complete replacement Plan")).toBe(1);
        }
        // The revision turn says what changed, once, and asks for a whole
        // document rather than repeating the original brief.
        const revision = harness.fake.prompts[4];
        expect(occurrences(revision, "use plain text")).toBe(1);
        expect(revision).not.toContain("Create one complete XMD Plan from this Prompt");
      });

      // Stopping prints one sentence, once, whether it happened on the first
      // presentation or the tenth: an approvable Plan existed and you chose to
      // stop, and ten rounds of it do not accumulate into a different sentence.
      for (const rounds of [1, 10]) {
        yield* useWorkingDirectory(function* (dir, profileRoot) {
          const harness = createPromptHarness({ profileRoot });
          for (const round of Array.from({ length: rounds }, (_, i) => i + 1)) {
            harness.fake.script({ reply: VALID });
            if (round < rounds) {
              harness.script({ decision: "Request changes", feedback: `round ${round}` });
            }
          }
          harness.script({ decision: "Stop" });

          const { value, lines } = yield* reported(() =>
            runPrompt(command(dir, [REQUEST]), harness.deps),
          );

          expect(value).toBe(1);
          // One line, from the document's own <Fail>, and no accumulated
          // repetition of it however many rounds preceded it.
          expect(lines).toHaveLength(1);
          expect(occurrences(lines[0], "xmd prompt ")).toBe(1);
          expect(lines[0]).toContain("stopped at your request");
        });
      }
    });
  },
);
