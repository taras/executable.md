import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, suspend, until as untilResolved, withResolvers } from "effection";
import type { Operation } from "effection";
import { useTempFileCompiler } from "@executablemd/core";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { InMemoryStream } from "@executablemd/durable-streams";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import { ReplHost } from "../src/repl/host.ts";
import { rootReads, sidekickRequests } from "../src/repl/sidekick/requests.ts";
import { API, cwd, useHostFiles } from "@executablemd/runtime";
import { appendFile, mkdtemp, open, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";

import { decodeLocation } from "../src/repl/route.ts";
import type { ReplRoute } from "../src/repl/route.ts";
import { installReplHost } from "../src/repl-assembly.ts";
import { ReplTerminal } from "../src/repl/terminal.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { ReplClock } from "../src/repl/frame.ts";
import { runReplProgram } from "../src/repl/program.ts";
import { assembleReplProfile } from "../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import { NO_PLUGINS } from "../src/plugin-host.ts";
import { resolveAgentStack } from "../src/agent-stack.ts";
import { createFakeAcp, makeRegistry, makeStore, tripwireAcp } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { ADAPTERS, AGENT } from "./support/plan-harness.ts";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { z } from "zod";
import {
  awaited,
  awaitedFact,
  mountedExecution,
  recordingTerminal,
} from "./support/mounted-repl.ts";
import type { MountedHost, Terminal } from "./support/mounted-repl.ts";
import { useReplPage } from "./support/repl-page.ts";
import type { ScreenReading, ReplPage } from "./support/repl-page.ts";
import {
  COMPOSER,
  DRAFT as DRAFT_HEADING,
  DRAFT_VALUE,
  closeDrawer,
  drawerLines,
  drawerOpen,
  draftText,
  entrySettles,
  pasteDraft,
  railMark,
  selectPane,
} from "./support/screen-journeys.ts";

import { ENTRIES_FILE, PAIRED_DIRECTORY } from "../src/repl/sidekick/history.ts";
import { projectRepl } from "../src/repl/model.ts";
import { REPL_DIRECTORY } from "../src/repl/storage.ts";
import { pairedReplRepository } from "../src/repl/sidekick/repository.ts";

const STORY = [
  '<Evaluate allow={["write"]}>',
  "  <Plan>",
  "    Create an XMD program that asks me for a project name and a one-sentence",
  "    description. Preview the README it will create and ask for confirmation.",
  "    If I approve, write README.md and report that it was created. If I",
  "    decline, stop without writing anything.",
  "  </Plan>",
  "</Evaluate>",
].join("\n");

const DETAILS_SCHEMA =
  '{ type: "object", properties: { project: { type: "string", title: "Project name", ' +
  'minLength: 1 }, summary: { type: "string", title: "One-sentence description", ' +
  'minLength: 1 } }, required: ["project", "summary"], additionalProperties: false }';

const CONFIRM_SCHEMA =
  '{ type: "object", properties: { decision: { type: "string", enum: ["Approve", "Decline"] } }, ' +
  'required: ["decision"], additionalProperties: false }';

const README = ["# The project", "", "<Json value={answers} />", ""].join("\n");

const DRAFT = ["# A first draft", "", "Ask for a name. Write a file.", ""].join("\n");

const REVISED = [
  "# Create a README from a project name and description",
  "",
  `<Elicit schema={${DETAILS_SCHEMA}} as="answers">Name the project and describe it in one ` +
    "sentence.</Elicit>",
  "",
  "Proposed README.md:",
  "",
  README,
  `<Elicit schema={${CONFIRM_SCHEMA}} as="confirmation">Write this README?`,
  "",
  README,
  "</Elicit>",
  "",
  '<Json value={confirmation} as="decided" />',
  '<Json value={{ decision: "Approve" }} as="approval" />',
  "",
  "<Switch value={decided}>",
  "<Case value={approval}>",
  '<File path="README.md">' + README,
  "</File>",
  "",
  "Created README.md.",
  "</Case>",
  "<Case default>",
  "",
  "Stopped without writing anything.",
  "</Case>",
  "</Switch>",
  "",
].join("\n");

const WRITTEN = [
  "# The project",
  "",
  "{",
  '  "project": "Ledger",',
  '  "summary": "A tiny ledger."',
  "}",
  "",
  "",
].join("\n");

const FEEDBACK = "Ask for the description too, and confirm before writing.";

const CREATED = "Created README.md.";
const STOPPED = "Stopped without writing anything.";

const AUTHORSHIP = "Create one complete XMD Plan";

const PARTIAL = "half a thought";

const REPLY = "The plan reads well.\n";

const PLAN_IT = "plan it";
const REVIEW_IT = "review it";
const BUILD_IT = "build it";

const ANSWERED = "the answer stands";

const THREE = [
  "<All>",
  `<Spawn><Session name="planner"><Prompt text="${PLAN_IT}" /></Session></Spawn>`,
  `<Spawn><Session name="reviewer"><Prompt text="${REVIEW_IT}" /></Session></Spawn>`,
  `<Spawn><Session name="implementer"><Prompt text="${BUILD_IT}" /></Session></Spawn>`,
  "</All>",
].join("\n");

const ASKING = ['<Session name="planner">', '<Prompt text="ok?" />', "</Session>"].join("\n");

const REVISION_TITLE = "Create a README from a project name";

const WIDE: ReplTerminalSize = { columns: 200, rows: 140 };
const TALL: ReplTerminalSize = { columns: 200, rows: 60 };

describe("J1 — the Story, from one entry to one README", () => {
  beforeAll(() => useTempFileCompiler());

  it("J1: the packaged Plan is reviewed in the drawer, and its program asks, previews and writes", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: DRAFT });
    fake.script({ reply: REVISED });
    const held = holds([AUTHORSHIP]);

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot, workspace } = yield* beginJourney({ fake, held, size: WIDE });

      yield* submitted(page, STORY, 1);

      yield* page.until("the authorship turn queued", (frame) => frame.shows("· queued"));
      expect(page.screen().shows("· streaming")).toBe(false);
      held.start(AUTHORSHIP);
      yield* page.until("the authorship turn streaming", (frame) => frame.shows("· streaming"));
      held.deltas(AUTHORSHIP);
      yield* page.until("the turn's stop reason", (frame) => frame.shows("stopped: end_turn"));
      yield* page.until("the turn recorded", (frame) => frame.shows("completed, recorded"));
      yield* awaitedFact("the turn was never retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length > 0
        );
      });

      yield* openQuestion(page);
      yield* page.until("the review offering changes", (frame) =>
        entryDrawerShows(frame, "Request changes"),
      );
      expect(page.screen().shows("A first draft")).toBe(true);

      yield* chooseOption(page, "decision", "Request changes");
      yield* page.until("the review refusing the missing feedback", (frame) =>
        entryDrawerShows(frame, "required property"),
      );
      expect(entryDrawerShows(page.screen(), "Request changes")).toBe(true);
      expect(fake.prompts).toHaveLength(1);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "elicit")).toEqual([]);

      yield* answerField(page, "feedback", FEEDBACK);
      yield* page.press("[submit]");
      yield* awaited("the revision was never asked for", () => fake.prompts.length >= 2);
      expect(fake.prompts[1]).toContain(FEEDBACK);
      expect(new Set(fake.turns.map((turn) => turn.handle.sessionKey)).size).toBe(1);

      yield* openQuestion(page);
      yield* page.until("the revised review", (frame) => entryDrawerShows(frame, REVISION_TITLE));
      yield* chooseOption(page, "decision", "Approve");

      yield* openQuestion(page);
      yield* page.until("the program's first question", (frame) =>
        entryDrawerShows(frame, "Name the project"),
      );
      const admitted = admission(yield* journal(hostRoot));
      expect(admitted.source).toBe(`\n  ${REVISED}\n`);
      expect(admitted.named).toEqual([
        { name: "Elicit", form: "paired" },
        { name: "Json", form: "self-closing" },
        { name: "Elicit", form: "paired" },
        { name: "Json", form: "self-closing" },
        { name: "Json", form: "self-closing" },
        { name: "Json", form: "self-closing" },
        { name: "File", form: "paired" },
        { name: "Json", form: "self-closing" },
      ]);

      yield* answerField(page, "project", "Ledger");
      yield* answerField(page, "summary", "A tiny ledger.");
      yield* page.press("[submit]");

      yield* openQuestion(page);
      yield* page.until("the confirmation", (frame) =>
        entryDrawerShows(frame, "Write this README?"),
      );
      for (const line of ["# The project", '"project": "Ledger"', '"summary": "A tiny ledger."']) {
        expect([line, page.screen().shows(line)]).toEqual([line, true]);
      }
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);
      expect(page.screen().occurrences(CREATED)).toBe(0);

      yield* chooseOption(page, "decision", "Approve");
      yield* page.until(
        "the report following the write",
        (frame) => frame.occurrences(CREATED) > 1,
      );
      expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);
      expect(yield* untilResolved(readFile(join(workspace, "README.md"), "utf8"))).toBe(WRITTEN);
      expect(page.screen().occurrences(STOPPED)).toBe(1);

      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);

      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt")).toEqual([
        "agent_prompt",
        "agent_prompt",
      ]);
      expect(page.screen().occurrences("completed, recorded")).toBe(2);
      yield* openCatalog(page);
      expect(page.screen().shows("component Plan")).toBe(true);
      expect(page.screen().shows("generated generated")).toBe(true);
      expect(yield* answeredUnder(page, "component Plan", "answered @executablemd/cli/Plan")).toBe(
        2,
      );

      expect(fake.prompts).toHaveLength(2);
      yield* leave(page);
    });
  });

  it("J1: declining reaches the same preview and writes nothing", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: DRAFT });
    fake.script({ reply: REVISED });

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot, workspace } = yield* beginJourney({ fake, size: WIDE });

      yield* submitted(page, STORY, 1);

      yield* openQuestion(page);
      yield* page.until("the review offering changes", (frame) =>
        entryDrawerShows(frame, "Request changes"),
      );
      yield* chooseOption(page, "decision", "Request changes");
      yield* page.until("the review refusing the missing feedback", (frame) =>
        entryDrawerShows(frame, "required property"),
      );
      yield* answerField(page, "feedback", FEEDBACK);
      yield* page.press("[submit]");
      yield* awaited("the revision was never asked for", () => fake.prompts.length >= 2);
      yield* openQuestion(page);
      yield* page.until("the revised review", (frame) => entryDrawerShows(frame, REVISION_TITLE));
      yield* chooseOption(page, "decision", "Approve");

      yield* openQuestion(page);
      yield* page.until("the program's first question", (frame) =>
        entryDrawerShows(frame, "Name the project"),
      );
      yield* answerField(page, "project", "Ledger");
      yield* answerField(page, "summary", "A tiny ledger.");
      yield* page.press("[submit]");

      yield* openQuestion(page);
      yield* page.until("the confirmation", (frame) =>
        entryDrawerShows(frame, "Write this README?"),
      );
      expect(page.screen().shows('"project": "Ledger"')).toBe(true);
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);

      yield* chooseOption(page, "decision", "Decline");
      yield* page.until("the decline reported", (frame) => frame.occurrences(STOPPED) > 1);
      expect(page.screen().occurrences(CREATED)).toBe(1);
      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "elicit")).toHaveLength(
        4,
      );
      yield* leave(page);
    });
  });
});

describe("C1 — the command line this REPL runs under", () => {
  beforeAll(() => useTempFileCompiler());

  it("C1: the five options settle into one immutable profile", function* () {
    const reached: string[] = [];
    const settled = yield* scoped(function* () {
      const flags = {
        agentProvider: "acpx",
        defaultAgent: AGENT,
        approveAll: false,
        approveReads: false,
        denyAll: false,
      };
      const stack = yield* resolveAgentStack(flags, undefined);
      if (!stack.ok) {
        throw stack.error;
      }
      return yield* (yield* assembleReplProfile(stack.value, NO_PLUGINS, {
        acp: { createRuntime: tripwireAcp((what) => reached.push(what)) },
        planWriterRoot: yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-c1-"))),
      })).finalize();
    });

    expect(reached).toEqual([]);
    expect(settled.permissionMode).toBe("approve-reads");
    expect(settled.includes).toEqual([join(settled.projectCwd!, "components"), settled.projectCwd]);
    expect(settled.installations).toHaveLength(1);
    const own = settled.installations[0]!;
    expect((own.declarations ?? []).map((declaration) => declaration.name)).toEqual(["Plan"]);
    expect(settled.generated).toEqual({
      File: ["self-closing", "paired"],
      "File.Delete": ["self-closing"],
      Glob: ["self-closing"],
      Syntax: ["self-closing"],
      Elicit: ["paired"],
    });
    expect(Object.isFrozen(settled)).toBe(true);
    expect(Object.isFrozen(settled.installations)).toBe(true);
  });

  it("C1: each permission switch is the mode the profile carries", function* () {
    const modes: string[] = [];
    yield* scoped(function* () {
      for (const flags of [
        { approveAll: true, approveReads: false, denyAll: false },
        { approveAll: false, approveReads: true, denyAll: false },
        { approveAll: false, approveReads: false, denyAll: true },
      ]) {
        const stack = yield* resolveAgentStack(
          { agentProvider: "acpx", defaultAgent: AGENT, ...flags },
          undefined,
        );
        if (!stack.ok) {
          throw stack.error;
        }
        modes.push(stack.value.permissionMode);
      }
    });

    expect(modes).toEqual(["approve-all", "approve-reads", "deny-all"]);
  });

  it("C1: an entry that asks for no Agent materializes no adapter", function* () {
    const fake = createFakeAcp();

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot } = yield* beginJourney({ fake });

      yield* submitted(page, "# A document that asks nobody anything", 1);
      yield* page.until("the entry shown", (frame) =>
        frame.shows("A document that asks nobody anything"),
      );
      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      expect(fake.created).toEqual([]);
      expect(fake.ensured).toEqual([]);
      expect(fake.prompts).toEqual([]);
      expect(fake.started).toBe(false);
      yield* leave(page);
    });
  });

  it("C1: `<Session.Launch>` is unavailable and the REPL keeps the terminal", function* () {
    const fake = createFakeAcp();

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot } = yield* beginJourney({ fake });
      const { terminal } = page.repl;
      const modes = terminal.raw.length;

      yield* submitted(page, "<Session.Launch>\ndo the work\n</Session.Launch>", 1);

      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      const closed = (yield* journal(hostRoot)).find((event) => event.type === "close");
      const failure = z
        .object({ error: z.object({ name: z.string(), message: z.string() }) })
        .parse(closed?.result).error;
      expect(failure?.name).toBe("NativeLauncherUnavailableError");
      expect(failure?.message).toContain("no native launcher is installed");
      expect(fake.started).toBe(false);

      expect(terminal.raw.length).toBe(modes);
      expect(terminal.resets).toBe(0);
      yield* leave(page);
    });
  });
});

function greetingSource(which: "First" | "Second"): string {
  const prop = `from${which}`;
  return [
    "---",
    `description: ${which} greeting contract.`,
    "props:",
    "  type: object",
    "  properties:",
    `    ${prop}: { type: string }`,
    `  required: [${prop}]`,
    "  additionalProperties: false",
    "---",
    "",
    `${which} greeting rendered.`,
    "",
  ].join("\n");
}

function* includeWorkspace(): Operation<{
  workspace: string;
  session: string;
  first: string;
  second: string;
  root: string;
}> {
  const root = yield* useTempDirectory("xmd-includes-");
  const workspace = join(root, "workspace");
  const session = join(root, "session");
  const first = join(root, "first");
  const second = join(root, "second");
  for (const directory of [join(workspace, "components"), join(first, "File"), second]) {
    yield* ensureDir(directory);
  }
  yield* writeTextFile(join(first, "Greeting.md"), greetingSource("First"));
  yield* writeTextFile(join(second, "Greeting.md"), greetingSource("Second"));
  yield* writeTextFile(join(workspace, "components", "Local.md"), "local-only output\n");
  yield* writeTextFile(join(workspace, "RootLocal.md"), "root-only output\n");
  for (const candidate of ["Syntax", "Evaluate", "File", "File/Delete", "Dir"]) {
    yield* writeTextFile(join(first, `${candidate}.md`), "POISON protected candidate\n");
  }
  yield* ensureDir(join(session, "components"));
  yield* writeTextFile(join(session, "components", "Greeting.md"), "Session collision.");
  yield* writeTextFile(join(session, "components", "SessionOnly.md"), "Session only.");
  yield* useHostFiles();
  return { root, workspace, session, first, second };
}

function* selectedProfile(
  includes: readonly string[],
  root: string,
  fake: FakeAcp,
  workspace?: string,
): Operation<ReplExecutionProfile> {
  return yield* (yield* assembleReplProfile(
    { provider: "acpx", defaultAgent: AGENT, adapters: ADAPTERS, permissionMode: "deny-all" },
    NO_PLUGINS,
    {
      includes,
      planWriterRoot: join(root, "plans"),
      acp: {
        createRuntime: fake.create,
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
      },
    },
  )).finalize(workspace);
}

describe("A2–A5 — the selected REPL component environment", () => {
  beforeAll(() => useTempFileCompiler());

  it("A2/A5: one detached ordered selection describes vocabulary, protected names and environment", function* () {
    const fixture = yield* includeWorkspace();
    const relativeFirst = relative(yield* cwd(), fixture.first);
    const input = [relativeFirst, fixture.second, relativeFirst];
    const reached: string[] = [];
    const facts = {
      includes: input,
      planWriterRoot: join(fixture.root, "plans"),
      acp: { createRuntime: tripwireAcp((what) => reached.push(what)) },
    };
    const profile = yield* (yield* assembleReplProfile(
      { provider: "acpx", defaultAgent: AGENT, adapters: ADAPTERS, permissionMode: "deny-all" },
      NO_PLUGINS,
      facts,
    )).finalize(fixture.session);
    input.reverse();
    input.splice(0, input.length, "components", ".");
    facts.includes = ["elsewhere"];
    expect(profile.includes).toEqual([
      fixture.first,
      fixture.second,
      fixture.first,
      join(fixture.session, "components"),
    ]);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.includes)).toBe(true);
    const symbols = yield* profile.vocabulary.symbols();
    const documentation = yield* profile.vocabulary.documentation(["Greeting"]);
    for (const text of [symbols, documentation]) {
      expect(text).toContain(`${fixture.first}/Greeting.md`);
      expect(text).toContain("First greeting contract.");
      expect(text).not.toContain("Second greeting contract.");
      expect(text).not.toContain("<Local>");
      expect(text).not.toContain("<RootLocal>");
      expect(text).not.toContain("POISON");
    }
    const protectedNames = ["Syntax", "Evaluate", "File", "File.Delete", "Dir"];
    const protectedDocs = yield* profile.vocabulary.documentation(protectedNames);
    for (const name of protectedNames) {
      expect(symbols.split(`### \`<${name}>\``)).toHaveLength(2);
      expect(protectedDocs.split(`### \`<${name}>\``)).toHaveLength(2);
    }
    expect(protectedDocs.match(/\(protected component\)/g)).toHaveLength(5);
    expect(protectedDocs).not.toContain(fixture.first);
    const sessionResult = yield* openReplSession({
      execution: { id: "include-profile", stream: new InMemoryStream() },
      includes: profile.includes,
      installations: profile.installations,
      generated: profile.generated,
    });
    if (!sessionResult.ok) {
      throw sessionResult.error;
    }
    const root = {
      ...rootReads(sessionResult.value, profile),
      *fill(): Operation<never> {
        throw new Error("environment filled a draft");
      },
    };
    yield* ReplHost.around(
      {
        *environment() {
          return [];
        },
      },
      { at: "min" },
    );
    const environment = yield* sidekickRequests(root, function* (): Operation<never> {
      throw new Error("environment submitted work");
    }).environment();
    if (!environment.ok) {
      throw environment.error;
    }
    expect(environment.value).toContain(
      `- component includes: ${fixture.first}, ${fixture.second}, ${fixture.first}, ${join(fixture.session, "components")}`,
    );
    expect(reached).toEqual([]);
  });

  it("A3: preflight and execution select the same collision in either directory order", function* () {
    const fixture = yield* includeWorkspace();
    for (const which of ["First", "Second"] satisfies readonly ("First" | "Second")[]) {
      yield* scoped(function* () {
        const relativeFirst = relative(yield* cwd(), fixture.first);
        const includes =
          which === "First" ? [relativeFirst, fixture.second] : [fixture.second, relativeFirst];
        const fake = createFakeAcp();
        const profile = yield* selectedProfile(includes, fixture.root, fake);
        const stream = new InMemoryStream();
        const options = {
          execution: { id: `include-${which}`, stream },
          includes: profile.includes,
          installations: profile.installations,
          generated: profile.generated,
        };
        const wrong = which === "First" ? "Second" : "First";
        const refused = yield* submitReplEntry({
          ...options,
          source: `<Greeting from${wrong}="ok" />`,
        });
        expect(refused.ok).toBe(false);
        expect(yield* stream.readAll()).toEqual([]);
        const accepted = yield* submitReplEntry({
          ...options,
          source: `<Greeting from${which}="ok" />`,
        });
        if (!accepted.ok) {
          throw accepted.error;
        }
        const session = accepted.value;
        const result = yield* session.join();
        expect(result.ok).toBe(true);
        expect(session.model.terminal?.output).toContain(`${which} greeting rendered.`);
        const selectedPath = join(
          which === "First" ? fixture.first : fixture.second,
          "Greeting.md",
        );
        expect(JSON.stringify(yield* stream.readAll())).toContain(selectedPath);
        expect(yield* profile.vocabulary.documentation(["Greeting"])).toContain(selectedPath);
        expect(fake.prompts).toEqual([]);
      });
    }
  });

  it("A5: packaged Plan repairs against the selected environment and returns the approved source", function* () {
    const fixture = yield* includeWorkspace();
    const fake = createFakeAcp();
    fake.script({ reply: "# Unavailable draft\n\n<Local />\n" });
    const approved = '# Included draft\n\n<Greeting fromFirst="ok" />\n<SessionOnly />\n';
    fake.script({ reply: approved });
    const hostRoot = yield* useTempDirectory("xmd-include-history-");
    const ran = yield* scoped(function* (): Operation<string> {
      const { page, host } = yield* beginJourney({
        fake,
        hostRoot,
        size: WIDE,
        includes: [relative(yield* cwd(), fixture.first), fixture.second],
        planWriterRoot: join(fixture.root, "plans"),
        permissionMode: "deny-all",
        workspace: false,
      });
      const execution = yield* mountedExecution(page.repl);
      const sessionComponents = join(host.root, PAIRED_DIRECTORY, execution, "components");
      yield* writeTextFile(join(sessionComponents, "Greeting.md"), "Session collision.");
      yield* writeTextFile(join(sessionComponents, "SessionOnly.md"), "Session only.");
      yield* submitted(page, '<Plan as="draft">Write an included greeting.</Plan>\n\n{draft}', 1);
      yield* awaited(
        "Plan never repaired the unavailable component",
        () => fake.prompts.length === 2,
      );
      expect(fake.prompts[1]).toContain("Local");
      expect(fake.prompts[0]).toContain("First greeting contract.");
      expect(fake.prompts[0]).toContain(`${fixture.first}/Greeting.md`);
      expect(fake.prompts[0]).not.toContain("Second greeting contract.");
      expect(fake.prompts[0]).toContain(join(sessionComponents, "SessionOnly.md"));
      expect(fake.prompts[0]).not.toContain("<RootLocal>");
      expect(fake.prompts[0]).not.toContain("<Local>");
      yield* openQuestion(page);
      yield* page.until("the review offering approval", (frame) =>
        entryDrawerShows(frame, "Approve"),
      );
      yield* chooseOption(page, "decision", "Approve");
      yield* page.until("the approved draft shown", (frame) => frame.shows("Included draft"));
      yield* awaitedFact("approved Plan entry never closed", function* () {
        return (yield* journal(hostRoot)).some(
          (event) => event.type === "close" && event.coroutineId === "root",
        );
      });
      return yield* leave(page);
    });
    expect(ran).toContain("xmd://repl/");
    const model = projectRepl(
      (yield* journal(hostRoot)).map((event) => {
        const parsed = parseDurableEvent(JSON.stringify(event));
        if (!parsed.ok) {
          throw parsed.error;
        }
        return parsed.value;
      }),
    );
    if (!model.ok) {
      throw model.error;
    }
    expect(
      model.value.entries[0]?.bindings.find((binding) => binding.name === "draft")?.value,
    ).toBe(approved);
    expect(model.value.terminal?.output).toBe(`\n\n${approved}`);
    expect(model.value.terminal?.output).not.toContain("First greeting rendered.");
    expect(fake.prompts).toHaveLength(2);
  });
});

describe("J3 — durable truth, and a cold process over it", () => {
  beforeAll(() => useTempFileCompiler());

  it("J3: a fresh command scope reconstructs the whole Story from the Journal alone", function* () {
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const live = createFakeAcp();
    live.script({ reply: DRAFT });
    live.script({ reply: REVISED });
    let location = "";
    let markers: string[] = [];

    yield* scoped(function* (): Operation<void> {
      const { page, workspace } = yield* beginJourney({ fake: live, hostRoot, size: WIDE });
      yield* takeTheJourney(page, live, hostRoot, workspace);
      yield* openHistory(page);
      markers = historyMarkers(page.screen());
      expect(markers.length).toBeGreaterThan(3);
      yield* closeDrawer(page);
      location = yield* leave(page);
    });

    expect(location).toContain("xmd://repl/");
    const before = yield* entryHistory(hostRoot);
    expect(live.prompts).toHaveLength(2);

    const cold = createFakeAcp();
    yield* scoped(function* (): Operation<void> {
      const { page, workspace: elsewhere } = yield* beginJourney({
        fake: cold,
        hostRoot,
        size: WIDE,
        location,
      });

      for (const line of [
        "# A first draft",
        "Proposed README.md:",
        '"project": "Ledger"',
        '"summary": "A tiny ledger."',
        CREATED,
      ]) {
        yield* page.until(`${line} shown`, (frame) => frame.shows(line));
      }
      expect(page.screen().occurrences("completed, recorded")).toBe(2);
      yield* openCatalog(page);
      for (const line of ["component Plan", "generated generated"]) {
        yield* page.until(`${line} listed`, (frame) => frame.shows(line));
      }
      expect(yield* answeredUnder(page, "component Plan", "answered @executablemd/cli/Plan")).toBe(
        2,
      );
      yield* openCatalog(page);
      yield* chooseCatalogRow(page, "generated generated");
      const fragment = yield* page.until(
        "the fragment's retained questions",
        (frame) => frame.occurrences("answered 4:1") > 0 && frame.occurrences("answered 12:1") > 0,
      );
      expect(fragment.occurrences("answered 4:1")).toBe(1);
      expect(fragment.occurrences("answered 12:1")).toBe(1);
      expect(fragment.occurrences(STOPPED)).toBe(1);

      yield* openHistory(page);
      expect(historyMarkers(page.screen())).toEqual(markers);
      yield* closeDrawer(page);

      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(page.screen().shows("[submit]")).toBe(false);
      expect(page.screen().shows("[submit]")).toBe(false);
      expect(page.screen().shows("( ) Approve")).toBe(false);
      expect(yield* untilResolved(readdir(elsewhere))).toEqual([]);
      yield* leave(page);
    });

    expect(yield* entryHistory(hostRoot)).toBe(before);
  });

  it("EC1: two entries of retained Agent work reopen cold, asking nobody", function* () {
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const live = createFakeAcp();
    live.script({ reply: "ONE-DONE" });
    live.script({ reply: "TWO-DONE" });
    let location = "";
    let turnRows: string[] = [];

    yield* scoped(function* (): Operation<void> {
      const { page } = yield* beginJourney({ fake: live, hostRoot, size: WIDE });

      yield* submitted(page, promptEntry("ask-one"), 1);
      yield* entrySettles(page, 1, "ok");
      yield* submitted(page, promptEntry("ask-two"), 2);
      yield* entrySettles(page, 2, "ok");

      yield* page.until(
        "both replies",
        (frame) => frame.shows("ONE-DONE") && frame.shows("TWO-DONE"),
      );
      expect(page.screen().shows("All sessions")).toBe(true);
      turnRows = sessionTurns(page.screen());
      expect(turnRows).toHaveLength(2);
      expect(turnRows.some((row) => shownPrompt(row, "ask-one"))).toBe(true);
      expect(turnRows.some((row) => shownPrompt(row, "ask-two"))).toBe(true);

      location = yield* leave(page);
    });

    expect(live.prompts).toEqual(["ask-one", "ask-two"]);
    const before = yield* entryHistory(hostRoot);

    const events = yield* journal(hostRoot);
    const projected = projectRepl(
      events.map((event) => {
        const parsed = parseDurableEvent(JSON.stringify(event));
        if (!parsed.ok) {
          throw parsed.error;
        }
        return parsed.value;
      }),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
    expect(projected.value.turns.map((turn) => [turn.entry, turn.sequence])).toEqual([
      ["entry-1", 0],
      ["entry-2", 0],
    ]);
    expect(projected.value.sessions).toHaveLength(1);
    expect(projected.value.sessions[0]?.turns.map((turn) => turn.entry)).toEqual([
      "entry-1",
      "entry-2",
    ]);
    expect(projected.value.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(projected.value.turns.every((turn) => turn.marker.length > 0)).toBe(true);
    const selected = projected.value.entries[1];
    if (selected === undefined) {
      throw new Error("the journal holds a second entry");
    }

    const cold = createFakeAcp();
    yield* scoped(function* (): Operation<void> {
      const at = `${location.split("?")[0]}/${selected.key}`;
      const { page } = yield* beginJourney({ fake: cold, hostRoot, size: WIDE, location: at });

      yield* entrySettles(page, 1, "ok");
      yield* entrySettles(page, 2, "ok");
      yield* openCatalog(page);
      expect(entryMarked(page.screen(), selected.key)).toBe(true);
      yield* closeCatalog(page);

      yield* page.until(
        "both replies",
        (frame) => frame.shows("ONE-DONE") && frame.shows("TWO-DONE"),
      );
      expect(page.screen().shows("All sessions")).toBe(true);
      expect(sessionTurns(page.screen())).toEqual(turnRows);

      const transcript = page
        .screen()
        .rows.map((row) => row.slice(page.screen().locate(DRAFT_HEADING).column))
        .join("\n");
      expect(transcript).toContain("TWO-DONE");
      expect(transcript).not.toContain("ONE-DONE");
      expect(sessionTurns(page.screen()).some((row) => shownPrompt(row, "ask-one"))).toBe(true);

      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(cold.created).toEqual([]);
      expect(cold.ensured).toEqual([]);

      yield* leave(page);
    });

    expect(yield* entryHistory(hostRoot)).toBe(before);
  });

  it("J3: a failed and a cancelled turn restore terminally, with the text they had", function* () {
    for (const [what, scripted, status, stopped] of [
      ["failed", { reply: PARTIAL, stopReason: "refusal" }, "failed, recorded", "stopped: refusal"],
      ["cancelled", { reply: PARTIAL, cancelled: true }, "cancelled, recorded", undefined],
    ] as const) {
      const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
      const live = createFakeAcp();
      live.script(scripted);
      let location = "";

      yield* scoped(function* (): Operation<void> {
        const { page } = yield* beginJourney({ fake: live, hostRoot, size: TALL });
        yield* submitted(page, ASKING, 1);
        yield* page.until(`${PARTIAL} shown`, (frame) => frame.shows(PARTIAL));
        yield* page.until(`the turn ${what}`, (frame) => frame.shows(`· ${status}`));
        location = yield* leave(page);
      });

      const prompts = (yield* journal(hostRoot)).filter(
        (event) => event.type === "yield" && event.description.type === "agent_prompt",
      );
      expect([what, prompts.length]).toEqual([what, 1]);
      const record = z
        .object({ value: z.object({ status: z.string(), text: z.string() }) })
        .parse(prompts[0]?.result).value;
      expect([what, record?.status]).toEqual([what, what]);
      expect([what, record?.text]).toEqual([what, PARTIAL]);

      const cold = createFakeAcp();
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* beginJourney({ fake: cold, hostRoot, size: TALL, location });
        yield* page.until(`${PARTIAL} shown`, (frame) => frame.shows(PARTIAL));
        yield* page.until(`the turn ${what}`, (frame) => frame.shows(`· ${status}`));
        if (stopped !== undefined) {
          yield* page.until(`${stopped} shown`, (frame) => frame.shows(stopped));
        }
        expect([what, page.screen().shows("· queued")]).toEqual([what, false]);
        expect([what, page.screen().shows("· streaming")]).toEqual([what, false]);
        expect([what, cold.prompts]).toEqual([what, []]);
        expect([what, cold.started]).toEqual([what, false]);
        yield* leave(page);
      });
    }
  });

  it("J3: each marker shows only what its own prefix retains", function* () {
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const live = createFakeAcp();
    live.script({ reply: REPLY });
    let ended: string | undefined;

    yield* scoped(function* (): Operation<void> {
      const { page } = yield* beginJourney({ fake: live, hostRoot, size: TALL });
      yield* submitted(page, ASKING, 1);
      yield* page.until("the reply", (frame) => frame.shows(REPLY.trim()));
      yield* entrySettles(page, 1, "ok");

      yield* openHistory(page);
      for (const marker of ["Entry 1 admitted", "Agent turn recorded", "Entry outcome recorded"]) {
        expect([marker, historyMarkers(page.screen()).some((row) => row.includes(marker))]).toEqual(
          [marker, true],
        );
      }

      yield* chooseMarker(page, "Entry 1 admitted");
      yield* closeDrawer(page);
      const admitted = yield* page.until(
        "the first position being read",
        (frame) => readingRetained(frame) && !drawerOpen(frame),
      );
      expect(admitted.shows(REPLY.trim())).toBe(false);
      expect(admitted.shows("ok? ·")).toBe(false);
      yield* openHistory(page);

      expect(readingRetained(page.screen())).toBe(true);
      expect(historyMarkers(page.screen()).some((row) => row.includes("Agent turn recorded"))).toBe(
        true,
      );
      yield* closeDrawer(page);
      expect(page.screen().shows(REPLY.trim())).toBe(false);
      expect(page.screen().shows("completed, recorded")).toBe(false);
      yield* openHistory(page);

      yield* closeDrawer(page);
      yield* page.press("[live]");
      yield* page.until(
        "the head showing the reply",
        (frame) => !readingRetained(frame) && frame.shows(REPLY.trim()),
      );

      yield* openHistory(page);
      yield* chooseMarker(page, "Agent turn recorded");
      yield* closeDrawer(page);
      yield* page.until(
        "the recorded turn being read",
        (frame) =>
          readingRetained(frame) &&
          !drawerOpen(frame) &&
          frame.shows(REPLY.trim()) &&
          frame.shows("completed, recorded"),
      );

      expect(live.prompts).toHaveLength(1);
      ended = yield* leave(page);
    });

    const route = routeOf(ended);
    expect(route.at).toBe("yield:root:3");
    expect(route.inspect).toBe(true);
    expect(route.surface).toBe("entries");
    expect(route.scopes).toEqual([]);
  });

  it("J3: a location this host cannot read refuses before any replay", function* () {
    const cold = createFakeAcp();

    yield* scoped(function* (): Operation<void> {
      yield* useWorkspace();
      yield* immediateClock();
      const host = yield* useJourneyHost({ fake: cold });

      yield* scoped(function* (): Operation<void> {
        const { terminal, install } = recordingTerminal();
        yield* install();
        const malformed = yield* runReplProgram({ profile: host.profile, location: "xmd://nope" });
        expect(malformed.ok).toBe(false);
        expect(malformed.ok === false && malformed.error.message).toContain(
          "a REPL location begins with xmd://repl/",
        );
        expect(terminal.presented).toEqual([]);
      });

      const page = yield* useReplPage({
        host,
        location: "xmd://repl/0123456789abcdef/entries",
      });
      yield* page.until("the refusal", (frame) =>
        frame.shows("this execution has no history here."),
      );

      expect(cold.started).toBe(false);
      expect(cold.prompts).toEqual([]);
      expect(yield* absentHistory(host.dataRoot)).toBe(true);
      page.repl.terminal.end();
      yield* awaited("the command never returned", () => page.repl.outcome() !== undefined);
      const refusal = page.repl.outcome();
      expect(refusal?.ok).toBe(false);
      expect(refusal?.ok === false && refusal.error.message).toBe(
        "this execution has no history here.",
      );
    });
  });
});

describe("J2 — three conversations at once, through the terminal", () => {
  beforeAll(() => useTempFileCompiler());

  it("J2: complete, streaming and queued are one frame, and filtering changes only Sessions", function* () {
    const fake = createFakeAcp();
    for (let turn = 0; turn < 3; turn += 1) {
      fake.script({ reply: ANSWERED });
    }
    const held = holds([PLAN_IT, REVIEW_IT, BUILD_IT]);

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot } = yield* beginJourney({ fake, held, size: WIDE });
      yield* submitted(page, THREE, 1);

      yield* page.until("a turn queued", (frame) => frame.shows("· queued"));
      held.start(REVIEW_IT);
      held.deltas(REVIEW_IT);
      yield* page.until(`${REVIEW_IT} completed`, (frame) =>
        sessionTurns(frame).some((row) => saying(row, REVIEW_IT, "completed")),
      );
      held.start(BUILD_IT);

      yield* page.until("the three states standing together", (frame) =>
        (
          [
            [REVIEW_IT, "completed"],
            [BUILD_IT, "streaming"],
            [PLAN_IT, "queued"],
          ] as const
        ).every(([asked, state]) => sessionTurns(frame).some((row) => saying(row, asked, state))),
      );
      expect(page.screen().shows("All sessions")).toBe(true);

      held.deltas(BUILD_IT);
      yield* openSelector(page);
      yield* page.until(
        "a conversation offered",
        (frame) => offeredConversations(frame).length > 0,
      );
      expect(sessionTurns(page.screen()).some((row) => saying(row, PLAN_IT, "queued"))).toBe(true);

      const keys = [PLAN_IT, REVIEW_IT, BUILD_IT].map(
        (asked) => fake.turns.find((turn) => turn.text.includes(asked))?.handle.sessionKey ?? "",
      );
      const unfiltered = conversationFilter(page.screen());
      const offered = offeredConversations(page.screen());
      const first = offered[0] ?? "";
      expect(keys.some((key) => key.startsWith(first.replace(/…$/, "")))).toBe(true);
      yield* chooseConversation(page, first);
      yield* page.until(
        "the reading narrowed to one conversation",
        (frame) => childrenShown(frame).length === 1,
      );
      const marked = conversationFilter(page.screen()) ?? "";
      expect(keys.some((key) => key.startsWith(marked.replace(/…$/, "")))).toBe(true);
      expect(childrenShown(page.screen())).toHaveLength(1);
      expect(unfiltered).toBeUndefined();
      expect(conversationFilter(page.screen())).toBeDefined();
      const standing = conversationFilter(page.screen());

      yield* openCatalog(page);
      expect(page.screen().shows("] entry-1")).toBe(true);
      yield* closeCatalog(page);

      held.start(PLAN_IT);
      held.deltas(PLAN_IT);
      yield* awaitedFact("the third turn was never retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });
      expect(conversationFilter(page.screen())).toBe(standing);
      expect(childrenShown(page.screen())).toHaveLength(1);

      yield* openSelector(page);
      yield* chooseEveryConversation(page);
      const everyone = yield* page.until("all three turns completed", (frame) =>
        [PLAN_IT, REVIEW_IT, BUILD_IT].every((asked) =>
          sessionTurns(frame).some((row) => saying(row, asked, "completed")),
        ),
      );
      expect(conversationFilter(everyone)).toBeUndefined();
      expect(childrenShown(everyone)).toEqual([PLAN_IT, REVIEW_IT, BUILD_IT]);
      yield* openSelector(page);
      expect(offeredConversations(page.screen()).length).toBeGreaterThan(offered.length);
      yield* closeSelector(page);

      yield* awaitedFact("the three turns were never all retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });
      yield* leave(page);
    });
  });
});

describe("J2 — a filter and a draft across a resize (#875 R1)", () => {
  beforeAll(() => useTempFileCompiler());

  const TYPED = "and then this one";

  it("TL10: a conversation filter and a draft survive the round trip, and a cold open restores them", function* () {
    const live = createFakeAcp();
    for (let turn = 0; turn < 3; turn += 1) {
      live.script({ reply: ANSWERED });
    }
    const held = holds([PLAN_IT, REVIEW_IT, BUILD_IT]);
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    let location: string | undefined;
    let filtered: string | undefined;

    let chosen: string | undefined;

    yield* scoped(function* (): Operation<void> {
      const { page } = yield* beginJourney({ fake: live, held, hostRoot, size: WIDE });
      yield* submitted(page, THREE, 1);

      yield* page.until("a turn queued", (frame) => frame.shows("· queued"));
      for (const asked of [PLAN_IT, REVIEW_IT, BUILD_IT]) {
        held.start(asked);
        held.deltas(asked);
      }
      yield* awaitedFact("the three turns were never all retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });

      yield* openSelector(page);
      yield* page.until(
        "a conversation offered",
        (frame) => offeredConversations(frame).length > 0,
      );
      chosen = offeredConversations(page.screen())[0];
      expect(chosen).toBeDefined();
      expect(
        live.turns.some((turn) =>
          turn.handle.sessionKey.startsWith((chosen ?? "").replace(/…$/, "")),
        ),
      ).toBe(true);

      yield* chooseConversation(page, chosen ?? "");
      yield* page.until(
        "the reading narrowed to one conversation",
        (frame) => childrenShown(frame).length === 1,
      );
      filtered = conversationFilter(page.screen());
      expect(filtered).toBeDefined();

      yield* draftText(page, TYPED);
      expect(conversationFilter(page.screen())).toBe(filtered);
      expect(page.screen().found(TYPED, { after: "DRAFT" })).toBe(1);
      expect(childrenShown(page.screen())).toHaveLength(1);

      const narrow = yield* page.resize({ columns: 72, rows: 20 });
      expect(narrow.rows.length).toBe(20);
      expect(page.screen().found(TYPED, { after: "DRAFT" })).toBe(1);
      expect(narrow.rows.filter((line) => line.trimEnd().length > 72)).toEqual([]);
      expect(narrow.shows("Entries")).toBe(true);

      const back = yield* page.resize(WIDE);
      expect(back.rows.length).toBe(140);
      expect(conversationFilter(back)).toBe(filtered);
      expect(page.screen().found(TYPED, { after: "DRAFT" })).toBe(1);
      expect(childrenShown(back)).toHaveLength(1);

      location = yield* leave(page);
    });

    const standing = location;
    expect(standing).toBeDefined();
    const standingRoute = routeOf(standing);
    expect(live.turns.map((turn) => turn.handle.sessionKey)).toContain(standingRoute.session);
    chosen = standingRoute.session;
    expect(standingRoute.draft).toBe(TYPED);
    expect(standingRoute.surface).toBe("entries");
    expect(standingRoute.scopes).toEqual([]);
    expect(standingRoute.at).toBeUndefined();
    expect(standingRoute.inspect).toBe(false);
    expect(live.prompts).toHaveLength(3);
    const before = yield* entryHistory(hostRoot);

    const cold = createFakeAcp();
    yield* scoped(function* (): Operation<void> {
      const { page } = yield* beginJourney({ fake: cold, hostRoot, size: WIDE, location });

      yield* page.until(
        "the cold process restoring the reading",
        (frame) => conversationFilter(frame) === filtered && frame.shows(TYPED),
      );
      expect(childrenShown(page.screen())).toHaveLength(1);

      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(cold.created).toEqual([]);
      expect(cold.ensured).toEqual([]);

      const reopened = yield* leave(page);
      expect(reopened).toBe(standing);
      expect(routeOf(reopened).session).toBe(chosen);
      expect(routeOf(reopened).draft).toBe(TYPED);
    });

    expect(yield* entryHistory(hostRoot)).toBe(before);
  });
});

function* ending(page: ReplPage): Operation<void> {
  yield* awaited("the command never ended", () => page.repl.outcome() !== undefined);
  const outcome = page.repl.outcome();
  if (outcome !== undefined && !outcome.ok) {
    throw outcome.error;
  }
}

function* failing(body: () => Operation<void>): Operation<unknown> {
  try {
    yield* scoped(body);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("X1 — how this command ends, with work still in flight", () => {
  beforeAll(() => useTempFileCompiler());

  function* inFlight(fake: FakeAcp, hostRoot: string, waitingFor: string): Operation<ReplPage> {
    const { page } = yield* beginJourney({ fake, hostRoot, size: TALL });
    yield* submitted(page, ASKING, 1);
    yield* page.until(`${waitingFor} shown`, (frame) => frame.shows(waitingFor));
    return page;
  }

  it("X1: EOF ends the command, joins the turn and appends nothing late", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: PARTIAL, manual: true });
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));

    yield* scoped(function* (): Operation<void> {
      const page = yield* inFlight(fake, hostRoot, "· streaming");
      const { terminal } = page.repl;
      const before = recorded(yield* journal(hostRoot));
      terminal.end();
      yield* ending(page);
      const after = recorded(yield* journal(hostRoot));

      expect(fake.cancels).toBeGreaterThan(0);
      expect(after).toEqual(before);
      expect(after.filter((kind) => kind === "agent_prompt")).toEqual([]);
      expect(terminal.raw).toEqual([true, false]);
      expect(terminal.resets).toBe(1);
    });
  });

  it("X1: a renderer that fails ends the command the same way", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: PARTIAL, manual: true });
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const failure = new Error("the screen is gone");
    let terminal: Terminal | undefined;
    let before: string[] = [];

    const caught = yield* failing(function* (): Operation<void> {
      const page = yield* inFlight(fake, hostRoot, "· streaming");
      terminal = page.repl.terminal;
      before = recorded(yield* journal(hostRoot));
      page.repl.terminal.failNextPresent(failure);
      yield* page.key("Tab");
      yield* ending(page);
    });

    expect(caught).toBe(failure);
    const after = recorded(yield* journal(hostRoot));
    expect(after).toEqual(before);
    expect(after.filter((kind) => kind === "agent_prompt")).toEqual([]);
    expect(terminal?.raw).toEqual([true, false]);
    expect(terminal?.resets).toBe(1);
  });

  it("X1: a terminal that fails mid-read ends the command the same way", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: PARTIAL, manual: true });
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const gone = new Error("the terminal is gone");
    let terminal: Terminal | undefined;
    let before: string[] = [];

    const caught = yield* failing(function* (): Operation<void> {
      const lose = yield* losingInput();
      const page = yield* inFlight(fake, hostRoot, "· streaming");
      terminal = page.repl.terminal;
      before = recorded(yield* journal(hostRoot));
      lose(gone);
      page.repl.terminal.end();
      yield* ending(page);
    });

    expect(caught).toBe(gone);
    const after = recorded(yield* journal(hostRoot));
    expect(after).toEqual(before);
    expect(terminal?.raw).toEqual([true, false]);
    expect(terminal?.resets).toBe(1);
  });

  it("X1: cancelling the command joins the pending request without answering it", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: PARTIAL, requestsTool: "rm -rf /", manual: true });
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));

    yield* scoped(function* (): Operation<void> {
      const mounted = withResolvers<ReplPage>();
      const command = yield* spawn(function* (): Operation<void> {
        mounted.resolve(yield* inFlight(fake, hostRoot, "rm -rf /"));
        yield* suspend();
      });
      const page = yield* mounted.operation;
      const before = recorded(yield* journal(hostRoot));

      yield* command.halt();

      expect(fake.decisions).toEqual([]);
      expect(recorded(yield* journal(hostRoot))).toEqual(before);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt")).toEqual(
        [],
      );
      expect(page.repl.terminal.raw).toEqual([true, false]);
      expect(page.repl.terminal.resets).toBe(1);
    });
  });

  it("UI2: [exit] while a request is waiting denies nothing and answers nothing", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: PARTIAL, requestsTool: "rm -rf /", manual: true });
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));

    yield* scoped(function* (): Operation<void> {
      const page = yield* inFlight(fake, hostRoot, "rm -rf /");
      const before = recorded(yield* journal(hostRoot));

      yield* page.press("[exit]");
      yield* ending(page);

      expect(fake.decisions).toEqual([]);
      expect(recorded(yield* journal(hostRoot))).toEqual(before);
      expect(page.repl.terminal.raw).toEqual([true, false]);
      expect(page.repl.terminal.resets).toBe(1);
      const outcome = page.repl.outcome();
      const location = outcome?.ok === true ? outcome.value.location : undefined;
      expect(location).toBeDefined();
      expect(location).not.toContain("+permission");
      expect(location).not.toContain("+elicit");
    });
  });
});

function* takeTheJourney(
  page: ReplPage,
  fake: FakeAcp,
  hostRoot: string,
  workspace: string,
): Operation<void> {
  yield* submitted(page, STORY, 1);
  yield* openQuestion(page);
  yield* page.until("the review offering changes", (frame) =>
    entryDrawerShows(frame, "Request changes"),
  );
  yield* chooseOption(page, "decision", "Request changes");
  yield* page.until("the review refusing the missing feedback", (frame) =>
    entryDrawerShows(frame, "required property"),
  );
  yield* answerField(page, "feedback", FEEDBACK);
  yield* page.press("[submit]");
  yield* awaited("the revision was never asked for", () => fake.prompts.length >= 2);
  yield* openQuestion(page);
  yield* page.until("the revised review", (frame) => entryDrawerShows(frame, REVISION_TITLE));
  yield* chooseOption(page, "decision", "Approve");
  yield* openQuestion(page);
  yield* page.until("the program's first question", (frame) =>
    entryDrawerShows(frame, "Name the project"),
  );
  yield* answerField(page, "project", "Ledger");
  yield* answerField(page, "summary", "A tiny ledger.");
  yield* page.press("[submit]");
  yield* openQuestion(page);
  yield* page.until("the confirmation", (frame) => entryDrawerShows(frame, "Write this README?"));
  yield* chooseOption(page, "decision", "Approve");
  yield* page.until("the report following the write", (frame) => frame.occurrences(CREATED) > 1);
  yield* awaitedFact("the entry never settled", function* () {
    return (yield* journal(hostRoot)).some((event) => event.type === "close");
  });
  expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);
  yield* entrySettles(page, 1, "ok");
}

function* answeredUnder(page: ReplPage, scope: string, text: string): Operation<number> {
  yield* openCatalog(page);
  yield* chooseCatalogRow(page, scope);
  if (page.screen().shows(COMPOSER)) {
    yield* selectPane(page, "bindings");
  }
  const reading = yield* page.until(
    `a row saying ${text} after selecting ${scope}`,
    (frame) => frame.occurrences(text) > 0,
  );
  return reading.occurrences(text);
}

function* absentHistory(hostRoot: string): Operation<boolean> {
  const found = yield* untilResolved(
    readdir(join(hostRoot, "xmd", "repl")).catch(() => [] as string[]),
  );
  return found.length === 0;
}

function* entryHistory(hostRoot: string): Operation<string> {
  const directory = join(hostRoot, "xmd", "repl");
  const held = (yield* untilResolved(readdir(directory)))[0] ?? "";
  const path =
    held === PAIRED_DIRECTORY
      ? join(
          directory,
          held,
          (yield* untilResolved(readdir(join(directory, held))))[0] ?? "",
          ENTRIES_FILE,
        )
      : join(directory, held);
  return yield* untilResolved(readFile(path, "utf8"));
}

interface JourneyHost extends MountedHost {
  readonly dataRoot: string;
}

function* useJourneyHost(options: {
  readonly fake: FakeAcp;
  readonly held?: Holds;
  readonly dataRoot?: string;
  readonly includes?: readonly string[];
  readonly planWriterRoot?: string;
  readonly permissionMode?: "approve-reads" | "deny-all";
}): Operation<JourneyHost> {
  const dataRoot =
    options.dataRoot ?? (yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-"))));
  yield* installReplHost({
    dataRoot: () => dataRoot,
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });
  const profile = yield* assembleReplProfile(
    {
      provider: "acpx",
      defaultAgent: AGENT,
      adapters: ADAPTERS,
      permissionMode: options.permissionMode ?? "approve-reads",
    },
    NO_PLUGINS,
    {
      ...(options.includes === undefined ? {} : { includes: options.includes }),
      acp: {
        createRuntime:
          options.held === undefined ? options.fake.create : options.held.create(options.fake),
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
      },
      planWriterRoot:
        options.planWriterRoot ?? (yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-plan-")))),
    },
  );
  const root = join(dataRoot, ...REPL_DIRECTORY);
  return {
    dataRoot,
    root,
    fake: options.fake,
    profile,
    repository: pairedReplRepository(root),
    gate: undefined,
    operations: undefined,
  };
}

function* beginJourney(options: {
  readonly fake: FakeAcp;
  readonly held?: Holds;
  readonly hostRoot?: string;
  readonly size?: ReplTerminalSize;
  readonly location?: string;
  readonly includes?: readonly string[];
  readonly planWriterRoot?: string;
  readonly permissionMode?: "approve-reads" | "deny-all";

  readonly workspace?: boolean;
}): Operation<{
  readonly page: ReplPage;
  readonly host: JourneyHost;
  readonly hostRoot: string;
  readonly workspace: string;
}> {
  const workspace = options.workspace === false ? "" : yield* useWorkspace();
  yield* immediateClock();
  const host = yield* useJourneyHost({
    fake: options.fake,
    ...(options.held === undefined ? {} : { held: options.held }),
    ...(options.hostRoot === undefined ? {} : { dataRoot: options.hostRoot }),
    ...(options.includes === undefined ? {} : { includes: options.includes }),
    ...(options.planWriterRoot === undefined ? {} : { planWriterRoot: options.planWriterRoot }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
  });
  const page = yield* useReplPage({
    host,
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.location === undefined ? {} : { location: options.location }),
  });
  return { page, host, hostRoot: host.dataRoot, workspace };
}

function* submitted(page: ReplPage, text: string, order: number): Operation<void> {
  yield* pasteDraft(page, text);
  yield* page.key("Enter");
  yield* page.until(
    `the draft becoming entry ${order}`,
    (frame) =>
      railMark(frame, order) !== undefined &&
      frame.found(text.trimEnd().split(/\s+/).at(-1) ?? text, DRAFT_VALUE) === 0,
  );
}

function* leave(page: ReplPage): Operation<string> {
  page.repl.terminal.end();
  yield* awaited("the command never returned", () => page.repl.outcome() !== undefined);
  const outcome = page.repl.outcome();
  if (outcome === undefined) {
    throw new Error("the command returned no outcome");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value.location;
}

function* losingInput(): Operation<(error: Error) => void> {
  const lost: { error: Error | undefined } = { error: undefined };
  yield* ReplTerminal.around(
    {
      input: (args, forward) => ({
        *[Symbol.iterator]() {
          const subscription = yield* forward(...args);
          return {
            *next() {
              const result = yield* subscription.next();
              if (lost.error !== undefined) {
                throw lost.error;
              }
              return result;
            },
          };
        },
      }),
    },
    { at: "max" },
  );
  return (error) => {
    lost.error = error;
  };
}

function* useWorkspace(): Operation<string> {
  const root = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-work-")));
  yield* useHostFiles();
  yield* API.Env.around(
    {
      *cwd(): Operation<string> {
        return root;
      },
    },
    { at: "min" },
  );
  return root;
}

interface Gate {
  open(): void;
  readonly opened: Promise<void>;
}

function gate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { open: () => release(), opened };
}

interface Holds {
  create(fake: FakeAcp): FakeAcp["create"];

  start(asked: string): void;

  deltas(asked: string): void;
}

function holds(asked: readonly string[]): Holds {
  const gates = new Map<string, { readonly start: Gate; readonly deltas: Gate }>(
    asked.map((text) => [text, { start: gate(), deltas: gate() }]),
  );
  const held = (text: string): { readonly start: Gate; readonly deltas: Gate } | undefined => {
    for (const [key, gates_] of gates) {
      if (text.includes(key)) {
        return gates_;
      }
    }
    return undefined;
  };
  return {
    start: (text) => gates.get(text)?.start.open(),
    deltas: (text) => gates.get(text)?.deltas.open(),
    create: (fake) => (options) => {
      const runtime = fake.create(options);
      return {
        ...runtime,
        startTurn(input) {
          const turn = runtime.startTurn(input);
          const hold = held(input.text);
          if (hold === undefined) {
            return turn;
          }
          const inner = turn.events;
          return {
            ...turn,
            materialized: hold.start.opened.then(() => turn.materialized),
            events: {
              [Symbol.asyncIterator]() {
                const events = inner[Symbol.asyncIterator]();

                const finished: IteratorResult<Awaited<ReturnType<typeof events.next>>["value"]> = {
                  done: true,
                  value: undefined,
                };
                let first = true;
                return {
                  next() {
                    if (!first) {
                      return events.next();
                    }
                    first = false;
                    return hold.deltas.opened.then(() => events.next());
                  },
                  return: () => events.return?.() ?? Promise.resolve(finished),
                };
              },
            },
          };
        },
      };
    },
  };
}

function* journal(hostRoot: string): Operation<DurableEvent[]> {
  const text = yield* entryHistory(hostRoot);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = parseDurableEvent(line);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    });
}

function recorded(events: readonly DurableEvent[]): string[] {
  return events.filter((event) => event.type === "yield").map((event) => event.description.type);
}

function admission(events: readonly DurableEvent[]): {
  readonly source: string;
  readonly named: readonly { readonly name: string; readonly form: string }[];
} {
  const admissions = events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
  expect(admissions).toHaveLength(1);
  return z
    .object({
      value: z.object({
        source: z.string(),
        named: z.array(z.object({ name: z.string(), form: z.string() })),
      }),
    })
    .parse(admissions[0]?.result).value;
}

function immediateClock(): Operation<void> {
  return ReplClock.around(
    {
      *now(): Operation<number> {
        return 0;
      },
      *wait(): Operation<void> {},
    },
    { at: "min" },
  );
}

function routeOf(location: string | undefined): ReplRoute {
  const decoded = decodeLocation(location ?? "");
  if (!decoded.ok) {
    throw decoded.error;
  }
  return decoded.value;
}

function childrenShown(frame: ScreenReading): string[] {
  const rows = sessionTurns(frame);
  return [PLAN_IT, REVIEW_IT, BUILD_IT].filter((asked) =>
    rows.some((row) => saying(row, asked, "")),
  );
}

function shownPrompt(line: string, prompt: string): boolean {
  for (let kept = prompt.length; kept >= 1; kept -= 1) {
    if (line.includes(kept === prompt.length ? prompt : `${prompt.slice(0, kept)}…`)) {
      return true;
    }
  }
  return false;
}

function saying(line: string, prompt: string, state: string): boolean {
  for (let kept = prompt.length; kept >= 1; kept -= 1) {
    const shown = kept === prompt.length ? prompt : `${prompt.slice(0, kept)}…`;
    if (line.includes(`${shown} · ${state}`)) {
      return true;
    }
  }
  return false;
}

function promptEntry(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}
function* openQuestion(page: ReplPage): Operation<void> {
  yield* page.until("the entry question", (one) => one.shows("[answer]") && !one.shows("[submit]"));
  yield* page.press("[answer]");
  yield* page.until("the entry form", (one) => one.shows("[submit]"));
}

function* answerField(page: ReplPage, name: string, value: string): Operation<void> {
  const label =
    name === "project"
      ? "Project name:"
      : name === "summary"
        ? "One-sentence description:"
        : "feedback:";
  if (name !== "project") {
    yield* page.key("Alt+ArrowDown");
    yield* sleep(30);
    yield* page.key("Alt+ArrowDown");
    yield* sleep(30);
  }
  yield* page.type(value);
  yield* page.until(`${name} taking the answer`, (one) => one.shows(`${label} ${value}`));
}

function chooseOption(page: ReplPage, _field: string, option: string): Operation<void> {
  return page.press("( ) " + option);
}

function* openCatalog(page: ReplPage): Operation<void> {
  if (page.screen().shows("[close]")) {
    yield* closeDrawer(page);
  }
  yield* page.press("Entries", { onRow: "Entries" });
  yield* page.until("the Entries catalog", drawerOpen);
}

function closeCatalog(page: ReplPage): Operation<void> {
  return closeDrawer(page);
}

function* chooseCatalogRow(page: ReplPage, name: string): Operation<void> {
  yield* page.press(name, { rightOf: "[close]" });
  yield* page.until("the catalog closing", (one) => !drawerOpen(one));
}

function historyMarkers(one: ScreenReading): string[] {
  return drawerLines(one)
    .filter((row) => /(?:admitted|recorded)/.test(row))
    .map((row) => row.trim());
}

function readingRetained(one: ScreenReading): boolean {
  return one.shows("[live]");
}

function* openHistory(page: ReplPage): Operation<void> {
  yield* page.press("[history]");
  yield* page.until("the History positions", (one) => historyMarkers(one).length > 0);
}

function* chooseMarker(page: ReplPage, name: string): Operation<void> {
  yield* page.press(name, { rightOf: "[close]" });
  yield* page.until("the retained position", readingRetained);
}

function entryMarked(one: ScreenReading, entry: string): boolean {
  return drawerLines(one).some((row) => row.includes("* ") && row.includes(entry));
}

function sessionTurns(one: ScreenReading): string[] {
  return one.rows.filter((row) => / · (?:queued|streaming|completed|cancelled|failed)/.test(row));
}

function conversationFilter(one: ScreenReading): string | undefined {
  const label = one.rows.find((row) => row.includes(" ▾")) ?? "";
  return label.includes("All sessions") ? undefined : label.match(/xmd:v1:[a-z0-9:]+…?/)?.[0];
}

function* openSelector(page: ReplPage): Operation<void> {
  yield* page.press(" ▾");
  yield* page.until("the conversation choices", (one) => one.shows("All conversations"));
}

function offeredConversations(one: ScreenReading): string[] {
  return one.rows
    .filter((row) => row.trimStart().startsWith("xmd:v1:"))
    .flatMap((row) => {
      const match = row.match(/xmd:v1:[a-z0-9:]+…?/);
      return match === null ? [] : [match[0]];
    });
}

function* chooseConversation(page: ReplPage, name: string): Operation<void> {
  const row = page.screen().rows.find((one) => one.trimStart().startsWith(name));
  if (row === undefined) {
    throw new Error(`no visible choice begins with ${name}`);
  }
  yield* page.press(name, { onRow: row });
  yield* page.until("the chosen conversation", (one) => !one.shows("All conversations"));
}

function* chooseEveryConversation(page: ReplPage): Operation<void> {
  yield* page.press("All conversations");
  yield* page.until("the whole chronology", (one) => !one.shows("All conversations"));
}

function* closeSelector(page: ReplPage): Operation<void> {
  yield* page.press(" ▾");
  yield* page.until("the choices closing", (one) => !one.shows("All conversations"));
}

function entryDrawerShows(one: ScreenReading, text: string): boolean {
  return one.shows("[close]") && one.found(text, { after: "Answer" }) > 0;
}
