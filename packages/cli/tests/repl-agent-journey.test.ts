/**
 * The journeys a person takes through `xmd repl` with an Agent.
 *
 * Every row here drives the public program: `runReplProgram()` over a real
 * Journal, a real Freedom tree, the real renderer and a terminal this suite
 * writes bytes to. What is substituted is what a test is allowed to decide —
 * which bytes the terminal produces, what the Agent says, where the Plan writer
 * keeps its conversations, and when time passes. The document, the route, the
 * application model, the Journal and the packaged `<Plan>` are the product's
 * own.
 *
 * ## J1 is the published Story
 *
 * The source in `STORY` is the one the Story publishes, exactly. The revised
 * program in `REVISED` is what a deterministic Agent returns for it, and it is
 * fixture data rather than a prediction of what a model would write: what it has
 * to be is *legal* — a generated fragment under the ordinary ceiling, which may
 * write JSON literals, its own bindings, arrays and objects and may not compute
 * anything. That is why it compares two `<Json />` renderings instead of
 * reading a member of its own answer: `confirmation.decision === "Approve"` is
 * a computed expression, and the grammar refuses one (specs §5.3.3).
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, until as untilResolved, withResolvers } from "effection";
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
import {
  awaited,
  awaitedFact,
  mountedExecution,
  recordingTerminal,
} from "./support/mounted-repl.ts";
import type { MountedHost, Terminal } from "./support/mounted-repl.ts";
import { useReplPage } from "./support/mounted-page.ts";
import type { PageFrame, ReplPage } from "./support/mounted-page.ts";
import {
  answerField,
  chooseCatalogRow,
  chooseConversation,
  chooseEveryConversation,
  chooseMarker,
  chooseOption,
  closeCatalog,
  closeDrawer,
  closeSelector,
  conversationFilter,
  draft,
  drawerShows,
  entryMarked,
  entrySettles,
  form,
  historyMarkers,
  occurrences,
  offeredConversations,
  openCatalog,
  openHistory,
  openQuestion,
  openSelector,
  paste,
  railMark,
  readingRetained,
  selectPane,
  sessionTurns,
  shownPane,
  shows,
} from "./support/repl-page-adapters.ts";

import { ENTRIES_FILE, PAIRED_DIRECTORY } from "../src/repl/sidekick/history.ts";
import { projectRepl } from "../src/repl/model.ts";
import { REPL_DIRECTORY } from "../src/repl/storage.ts";
import { pairedReplRepository } from "../src/repl/sidekick/repository.ts";

/** The exact source the Story publishes. */
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

/** The two-field form the generated program asks first. */
const DETAILS_SCHEMA =
  '{ type: "object", properties: { project: { type: "string", title: "Project name", ' +
  'minLength: 1 }, summary: { type: "string", title: "One-sentence description", ' +
  'minLength: 1 } }, required: ["project", "summary"], additionalProperties: false }';

/** The approve-or-decline confirmation it asks second. */
const CONFIRM_SCHEMA =
  '{ type: "object", properties: { decision: { type: "string", enum: ["Approve", "Decline"] } }, ' +
  'required: ["decision"], additionalProperties: false }';

/**
 * The README the program proposes, previews and writes.
 *
 * One composition, written three times: once as the preview in the document,
 * once inside the confirmation's own request, and once as what `<File>` writes.
 * Three renderings of one deterministic composition are byte-identical, which is
 * what makes "the preview is the file" something a row can compare rather than
 * something the fixture asserts about itself.
 */
const README = ["# The project", "", "<Json value={answers} />", ""].join("\n");

/** What the first turn returns: structurally valid, and not what was asked for. */
const DRAFT = ["# A first draft", "", "Ask for a name. Write a file.", ""].join("\n");

/** What the second turn returns once the feedback has been given. */
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

/** The bytes the write leaves on disk, with the answers the person typed. */
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

/** What each branch of the generated program reports. */
const CREATED = "Created README.md.";
const STOPPED = "Stopped without writing anything.";

/** What the packaged Plan's own authorship prompt begins with. */
const AUTHORSHIP = "Create one complete XMD Plan";

/** What a turn says before its provider reports it failed or cancelled. */
const PARTIAL = "half a thought";

/** What the Agent says when a row only needs it to have said something. */
const REPLY = "The plan reads well.\n";

/** What each child of the `<All>` asks, and what its provider answers. */
const PLAN_IT = "plan it";
const REVIEW_IT = "review it";
const BUILD_IT = "build it";
/**
 * What every child's provider answers.
 *
 * One text for all three, because the fake answers turns in the order it is
 * asked and three children started at once are asked in whatever order their
 * coroutines were scheduled. What tells the turns apart here is what each asked,
 * which is the document's own text.
 */
const ANSWERED = "the answer stands";

/** One entry running three conversations at once, as a person writes it. */
const THREE = [
  "<All>",
  `<Spawn><Session name="planner"><Prompt text="${PLAN_IT}" /></Session></Spawn>`,
  `<Spawn><Session name="reviewer"><Prompt text="${REVIEW_IT}" /></Session></Spawn>`,
  `<Spawn><Session name="implementer"><Prompt text="${BUILD_IT}" /></Session></Spawn>`,
  "</All>",
].join("\n");

/** One entry that asks one question of one Agent. */
const ASKING = ['<Session name="planner">', '<Prompt text="ok?" />', "</Session>"].join("\n");

/** What the revised review draws as the draft it asks about. */
const REVISION_TITLE = "Create a README from a project name";

/** Tall enough that a whole entry's reading is in the window rather than below it. */
const WIDE: ReplTerminalSize = { columns: 200, rows: 140 };
const TALL: ReplTerminalSize = { columns: 200, rows: 60 };

describe("J1 — the Story, from one entry to one README", () => {
  beforeAll(() => useTempFileCompiler());

  it("J1: the packaged Plan is reviewed in the drawer, and its program asks, previews and writes", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: DRAFT });
    fake.script({ reply: REVISED });
    // The authorship turn is held twice: before it starts, so a reader sees it
    // queued, and before it streams, so a reader sees it active with nothing
    // said yet.
    const held = holds([AUTHORSHIP]);

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot, workspace } = yield* beginJourney({ fake, held, size: WIDE });

      yield* submitted(page, STORY, 1);

      // Queued: the Prompt is scheduled and the provider has not taken it.
      yield* page.until("the authorship turn queued", (frame) => shows(frame, "· queued"));
      expect(shows(page.frame(), "· streaming")).toBe(false);
      // Taken, and streaming: the turn is active before it has said anything.
      held.start(AUTHORSHIP);
      yield* page.until("the authorship turn streaming", (frame) => shows(frame, "· streaming"));
      // Ended, with the fact its provider reported, and then retained: the row a
      // person was watching becomes its own record, under the scope the packaged
      // Plan was admitted as.
      held.deltas(AUTHORSHIP);
      yield* page.until("the turn's stop reason", (frame) => shows(frame, "stopped: end_turn"));
      yield* page.until("the turn recorded", (frame) => shows(frame, "completed, recorded"));
      yield* awaitedFact("the turn was never retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length > 0
        );
      });

      // The review is the REPL's own drawer, over the draft the Agent returned.
      // It announces itself first; activating that announcement opens it.
      yield* openQuestion(page);
      yield* page.until("the review offering changes", (frame) =>
        drawerShows(frame, "Request changes"),
      );
      expect(shows(page.frame(), "A first draft")).toBe(true);

      // Request changes with no feedback. Choosing an option submits the form,
      // and this one is refused: the schema requires the feedback that option
      // asks for, so the review stays open, nothing is answered and no turn
      // begins.
      yield* chooseOption(page, "decision", "Request changes");
      yield* page.until("the review refusing the missing feedback", (frame) =>
        drawerShows(frame, "required property"),
      );
      expect(drawerShows(page.frame(), "Request changes")).toBe(true);
      expect(fake.prompts).toHaveLength(1);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "elicit")).toEqual([]);

      // With feedback, the same conversation continues into the next turn.
      yield* answerField(page, "feedback", FEEDBACK);
      yield* form(page).submit();
      yield* awaited("the revision was never asked for", () => fake.prompts.length >= 2);
      expect(fake.prompts[1]).toContain(FEEDBACK);
      expect(new Set(fake.turns.map((turn) => turn.handle.sessionKey)).size).toBe(1);

      // Approved: the revision is what `<Evaluate>` admits. The revised review is
      // a new question, so it announces itself and is opened again.
      yield* openQuestion(page);
      yield* page.until("the revised review", (frame) => drawerShows(frame, REVISION_TITLE));
      yield* chooseOption(page, "decision", "Approve");

      // The first question the generated program asks.
      yield* openQuestion(page);
      yield* page.until("the program's first question", (frame) =>
        drawerShows(frame, "Name the project"),
      );
      const admitted = admission(yield* journal(hostRoot));
      // The approved text, byte for byte, inside the document's own whitespace:
      // `<Evaluate>`'s content is the newline and the two columns the `<Plan>`
      // element was written at, and then exactly what the provider returned.
      expect(admitted.source).toBe(`\n  ${REVISED}\n`);
      // Every element the fragment named, in the order preflight met them: the
      // two questions, the values they compose, and the one write.
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
      yield* form(page).submit();

      // The preview: the complete proposed file, in the confirmation's own
      // request, before anything has been written.
      yield* openQuestion(page);
      yield* page.until("the confirmation", (frame) => drawerShows(frame, "Write this README?"));
      for (const line of ["# The project", '"project": "Ledger"', '"summary": "A tiny ledger."']) {
        expect([line, shows(page.frame(), line)]).toEqual([line, true]);
      }
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);
      // Nothing has rendered the report, and while this drawer is open nothing
      // behind it is on the screen either.
      //
      // It used to be visible here: the row holding the program's own source sat
      // in the transcript column and showed through the modal, because a drawer
      // that painted only its own text left the cells around that text as they
      // were. A drawer now obscures its whole rectangle (#875), so the one place
      // this report can be read before it is written is nowhere — which is what
      // a modal is for. That it has not been written is a durable fact, asserted
      // above, rather than something read off the screen.
      expect(occurrences(page.frame(), CREATED)).toBe(0);

      // Approved. The report follows the write: at the first frame that shows
      // it, the file is already there, with the bytes the preview showed.
      yield* chooseOption(page, "decision", "Approve");
      yield* page.until(
        "the report following the write",
        (frame) => occurrences(frame, CREATED) > 1,
      );
      expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);
      expect(yield* untilResolved(readFile(join(workspace, "README.md"), "utf8"))).toBe(WRITTEN);
      // And the branch that was not taken rendered nothing: its line is on the
      // screen once, as source.
      expect(occurrences(page.frame(), STOPPED)).toBe(1);

      // One write, and the entry settled on it.
      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);

      // Both authorship turns are retained, under the scope the packaged Plan
      // was admitted as: the entry holds a `Plan` component scope, the program
      // it produced hangs under it, and both rows are recorded ones rather than
      // this process's live readings.
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt")).toEqual([
        "agent_prompt",
        "agent_prompt",
      ]);
      expect(occurrences(page.frame(), "completed, recorded")).toBe(2);
      // Read inside the catalog, which is where an entry's scopes are listed
      // now. The rows above are read before it is opened, because the drawer is
      // over the reading they are in.
      yield* openCatalog(page);
      expect(shows(page.frame(), "component Plan")).toBe(true);
      expect(shows(page.frame(), "generated generated")).toBe(true);
      // And both Plan reviews are retained where they were asked, which is
      // inside that scope rather than in the entry.
      expect(yield* answeredUnder(page, "component Plan", "answered @executablemd/cli/Plan")).toBe(
        2,
      );

      // Two turns in one conversation, and nothing else was asked.
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

      // The same review, the same feedback, the same approved program.
      yield* openQuestion(page);
      yield* page.until("the review offering changes", (frame) =>
        drawerShows(frame, "Request changes"),
      );
      yield* chooseOption(page, "decision", "Request changes");
      yield* page.until("the review refusing the missing feedback", (frame) =>
        drawerShows(frame, "required property"),
      );
      yield* answerField(page, "feedback", FEEDBACK);
      yield* form(page).submit();
      yield* awaited("the revision was never asked for", () => fake.prompts.length >= 2);
      yield* openQuestion(page);
      yield* page.until("the revised review", (frame) => drawerShows(frame, REVISION_TITLE));
      yield* chooseOption(page, "decision", "Approve");

      yield* openQuestion(page);
      yield* page.until("the program's first question", (frame) =>
        drawerShows(frame, "Name the project"),
      );
      yield* answerField(page, "project", "Ledger");
      yield* answerField(page, "summary", "A tiny ledger.");
      yield* form(page).submit();

      // The same preview, reached the same way.
      yield* openQuestion(page);
      yield* page.until("the confirmation", (frame) => drawerShows(frame, "Write this README?"));
      expect(shows(page.frame(), '"project": "Ledger"')).toBe(true);
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);

      // Declined. The two outcomes are observably different: one reports a
      // file it wrote, and this one reports that it wrote nothing.
      yield* chooseOption(page, "decision", "Decline");
      yield* page.until("the decline reported", (frame) => occurrences(frame, STOPPED) > 1);
      // And the write branch rendered nothing: its report is on the screen once,
      // as the source it was admitted from.
      expect(occurrences(page.frame(), CREATED)).toBe(1);
      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      // Nothing was written, and the question that decided it is in the
      // history exactly as the approving one is.
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
      // Assembling a profile reaches no provider: the adapter behind an option
      // is materialized when a turn asks for one, not when the line is read.
      return yield* (yield* assembleReplProfile(stack.value, NO_PLUGINS, {
        acp: { createRuntime: tripwireAcp((what) => reached.push(what)) },
        planWriterRoot: yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-c1-"))),
      })).finalize();
    });

    expect(reached).toEqual([]);
    // Approve-reads is what an unstated line means, and it is the mode the
    // profile carries.
    expect(settled.permissionMode).toBe("approve-reads");
    // Omission preserves both default directories.
    expect(settled.includes).toEqual([join(settled.projectCwd!, "components"), settled.projectCwd]);
    // One installation of this command's own, holding the packaged `<Plan>`.
    expect(settled.installations).toHaveLength(1);
    const own = settled.installations[0]!;
    expect((own.declarations ?? []).map((declaration) => declaration.name)).toEqual(["Plan"]);
    // And the selection a generated fragment runs under, carried as data on the
    // profile rather than as an installation: the session offers it in each
    // entry's own execution scope, because that is the scope core reads it in.
    expect(settled.generated).toEqual({
      File: ["self-closing", "paired"],
      "File.Delete": ["self-closing"],
      Glob: ["self-closing"],
      Syntax: ["self-closing"],
      Elicit: ["paired"],
    });
    // Read once and never changed: a profile a later entry could edit would be
    // two sets of rules in one session.
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
        shows(frame, "A document that asks nobody anything"),
      );
      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      // Nothing about the provider was reached: no runtime, no registry, no
      // adapter on disk.
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

      // The established refusal, from the Api's own default: this command
      // installs no foreground launcher, so nothing was started and the entry
      // failed on the reservation rather than on anything it launched.
      yield* awaitedFact("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      const closed = (yield* journal(hostRoot)).find((event) => event.type === "close");
      const failure = (closed?.result as { error?: { message?: string; name?: string } }).error;
      expect(failure?.name).toBe("NativeLauncherUnavailableError");
      expect(failure?.message).toContain("no native launcher is installed");
      expect(fake.started).toBe(false);

      // And the terminal is still this REPL's: no mode was handed over and
      // nothing was restored while the entry ran.
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
      yield* page.until("the review offering approval", (frame) => drawerShows(frame, "Approve"));
      yield* chooseOption(page, "decision", "Approve");
      yield* page.until("the approved draft shown", (frame) => shows(frame, "Included draft"));
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
      // The exact Story, through the real packaged Plan, exactly as J1 walks it.
      yield* takeTheJourney(page, live, hostRoot, workspace);
      // The History positions this run reached, read from the drawer that
      // offers them.
      yield* openHistory(page);
      markers = historyMarkers(page.frame());
      expect(markers.length).toBeGreaterThan(3);
      yield* closeDrawer(page);
      location = yield* leave(page);
    });

    // What the live process printed, and what the history holds now.
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

      // The whole journey, from the Journal: the packaged Plan's own scope, the
      // program it produced, both retained turns and their conversation, the
      // forms that were answered, the preview the program rendered and the
      // write it reported.
      for (const line of [
        "# A first draft",
        "Proposed README.md:",
        '"project": "Ledger"',
        '"summary": "A tiny ledger."',
        CREATED,
      ]) {
        yield* page.until(`${line} shown`, (frame) => shows(frame, line));
      }
      // Both turns are recorded rows rather than a live process's readings.
      // Counted before the catalog is opened, because the drawer is over the
      // reading these rows are in.
      expect(occurrences(page.frame(), "completed, recorded")).toBe(2);
      // The packaged Plan's own scope and the program it produced, read where
      // an entry's scopes are listed: inside its catalog.
      yield* openCatalog(page);
      for (const line of ["component Plan", "generated generated"]) {
        yield* page.until(`${line} listed`, (frame) => shows(frame, line));
      }
      // And both Plan reviews are retained where they were asked.
      expect(yield* answeredUnder(page, "component Plan", "answered @executablemd/cli/Plan")).toBe(
        2,
      );
      // The program's own two questions are retained with the answers they
      // took. Their positions carry no path — generated source is not a file —
      // so they are shown under the fragment that produced them.
      yield* openCatalog(page);
      yield* chooseCatalogRow(page, "generated generated");
      // The answers themselves are read from the reading above, which shows
      // them in full; what this counts is that each question is retained under
      // the fragment that asked it, at the position it was written.
      const fragment = yield* page.until(
        "the fragment's retained questions",
        (frame) =>
          occurrences(frame, "answered 4:1") > 0 && occurrences(frame, "answered 12:1") > 0,
      );
      expect(occurrences(fragment, "answered 4:1")).toBe(1);
      expect(occurrences(fragment, "answered 12:1")).toBe(1);
      // And the branch that was not taken is on the screen once, as source.
      expect(occurrences(fragment, STOPPED)).toBe(1);

      // The same History positions, from the same drawer.
      yield* openHistory(page);
      expect(historyMarkers(page.frame())).toEqual(markers);
      yield* closeDrawer(page);

      // Nothing was asked of anybody: no provider, no adapter, and no question
      // or permission offered to answer a second time.
      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(page.frame().has("drawer:form:submit")).toBe(false);
      expect(shows(page.frame(), "[submit]")).toBe(false);
      expect(shows(page.frame(), "( ) Approve")).toBe(false);
      // And nothing was written: the file the entry wrote is in the first
      // process's working directory, and this one has its own.
      expect(yield* untilResolved(readdir(elsewhere))).toEqual([]);
      yield* leave(page);
    });

    // Byte for byte the history it opened: reading a run is not appending to it.
    expect(yield* entryHistory(hostRoot)).toBe(before);
  });

  it("EC1: two entries of retained Agent work reopen cold, asking nobody", function* () {
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const live = createFakeAcp();
    live.script({ reply: "ONE-DONE" });
    live.script({ reply: "TWO-DONE" });
    let location = "";
    let turnRows: string[] = [];

    // Two entries, each holding one Prompt, through one command. One Prompt per
    // execution means each entry records sequence `0` — the collision a global
    // chronology would have to resolve, and the one a cold reader has to
    // resolve the same way.
    yield* scoped(function* (): Operation<void> {
      const { page } = yield* beginJourney({ fake: live, hostRoot, size: WIDE });

      yield* submitted(page, promptEntry("ask-one"), 1);
      yield* entrySettles(page, 1, "ok");
      yield* submitted(page, promptEntry("ask-two"), 2);
      yield* entrySettles(page, 2, "ok");

      // Both turns are on the Sessions reading, in one conversation, before
      // anything is read back: this is the reading a cold process has to
      // reproduce, and it is captured as it is *drawn* so the comparison below
      // is of two screens rather than of two descriptions.
      yield* page.until(
        "both replies",
        (frame) => shows(frame, "ONE-DONE") && shows(frame, "TWO-DONE"),
      );
      // The conversation control exists, which is what says the Sessions
      // surface is offering a conversation to filter by at all. Which key it
      // is, is a fact about the record and is asserted of the record below —
      // a provider session key is longer than this column and is drawn cut.
      expect(shows(page.frame(), "All sessions")).toBe(true);
      turnRows = sessionTurns(page.frame());
      expect(turnRows).toHaveLength(2);
      expect(turnRows.some((row) => shownPrompt(row, "ask-one"))).toBe(true);
      expect(turnRows.some((row) => shownPrompt(row, "ask-two"))).toBe(true);

      location = yield* leave(page);
    });

    expect(live.prompts).toEqual(["ask-one", "ask-two"]);
    const before = yield* entryHistory(hostRoot);

    // What the file says the two turns are, so the cold reading below is held
    // to the record rather than to itself.
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
    // Each entry's own Prompt really did take sequence `0`, and each turn is
    // owned by the entry that ran it.
    expect(projected.value.turns.map((turn) => [turn.entry, turn.sequence])).toEqual([
      ["entry-1", 0],
      ["entry-2", 0],
    ]);
    // One conversation, execution-wide, holding both.
    expect(projected.value.sessions).toHaveLength(1);
    expect(projected.value.sessions[0]?.turns.map((turn) => turn.entry)).toEqual([
      "entry-1",
      "entry-2",
    ]);
    // Recorded, read from the record: the sidebar is narrower than
    // "completed, recorded", so what the screen can say about this is which
    // turns are on it, and what the file says is how they ended.
    expect(projected.value.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(projected.value.turns.every((turn) => turn.marker.length > 0)).toBe(true);
    const selected = projected.value.entries[1];
    if (selected === undefined) {
      throw new Error("the journal holds a second entry");
    }

    // A cold process at a location naming the second entry, with a provider
    // that refuses every call it is given: reaching one is the defect, so the
    // stand-in makes reaching one a failure rather than a silent success.
    const cold = createFakeAcp();
    yield* scoped(function* (): Operation<void> {
      const at = `${location.split("?")[0]}/${selected.key}`;
      const { page } = yield* beginJourney({ fake: cold, hostRoot, size: WIDE, location: at });

      // The catalog the file holds, in admission order with its outcomes.
      yield* entrySettles(page, 1, "ok");
      yield* entrySettles(page, 2, "ok");
      // Which entry this location selected, read from the catalog that marks
      // it. The catalog is a drawer over the reading now, so it is opened to be
      // read and put away again before the rows below read what is underneath.
      yield* openCatalog(page);
      expect(entryMarked(page.frame(), selected.key)).toBe(true);
      yield* closeCatalog(page);

      // The global Sessions chronology, row for row and conversation for
      // conversation, is the one the live process showed — both entries' turns
      // under the one conversation, with the selection narrowing none of it.
      yield* page.until(
        "both replies",
        (frame) => shows(frame, "ONE-DONE") && shows(frame, "TWO-DONE"),
      );
      expect(shows(page.frame(), "All sessions")).toBe(true);
      expect(sessionTurns(page.frame())).toEqual(turnRows);

      // The selected entry's own transcript, read off the transcript column
      // rather than compared projection to projection — two projections of one
      // file agree by construction, and what this row is about is the screen.
      const transcript = (page.frame().area("box:transcript")?.rows() ?? []).join("\n");
      expect(transcript).toContain("TWO-DONE");
      expect(transcript).not.toContain("ONE-DONE");
      // The first entry's turn is still on the Sessions reading beside it,
      // which is what makes the absence above a locus and not a lost record.
      expect(sessionTurns(page.frame()).some((row) => shownPrompt(row, "ask-one"))).toBe(true);

      // Nobody was asked anything to do it.
      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(cold.created).toEqual([]);
      expect(cold.ensured).toEqual([]);

      yield* leave(page);
    });

    // Byte for byte the history it opened: reading a run is not appending to it.
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
        // The partial text, and how the turn ended, on the live surface.
        yield* page.until(`${PARTIAL} shown`, (frame) => shows(frame, PARTIAL));
        yield* page.until(`the turn ${what}`, (frame) => shows(frame, `· ${status}`));
        location = yield* leave(page);
      });

      // The record holds both facts, and holds them once.
      const prompts = (yield* journal(hostRoot)).filter(
        (event) => (event.description as { type?: string } | undefined)?.type === "agent_prompt",
      );
      expect([what, prompts.length]).toEqual([what, 1]);
      const record = (prompts[0]?.result as { value?: Record<string, unknown> }).value;
      expect([what, record?.status]).toEqual([what, what]);
      expect([what, record?.text]).toEqual([what, PARTIAL]);

      // A cold process shows the same terminal facts: the text it streamed and
      // the status it ended with, never a turn that is still going.
      const cold = createFakeAcp();
      yield* scoped(function* (): Operation<void> {
        const { page } = yield* beginJourney({ fake: cold, hostRoot, size: TALL, location });
        yield* page.until(`${PARTIAL} shown`, (frame) => shows(frame, PARTIAL));
        yield* page.until(`the turn ${what}`, (frame) => shows(frame, `· ${status}`));
        if (stopped !== undefined) {
          yield* page.until(`${stopped} shown`, (frame) => shows(frame, stopped));
        }
        // Never presented as work in progress, and nobody was asked again.
        expect([what, shows(page.frame(), "· queued")]).toEqual([what, false]);
        expect([what, shows(page.frame(), "· streaming")]).toEqual([what, false]);
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
      yield* page.until("the reply", (frame) => shows(frame, REPLY.trim()));
      yield* entrySettles(page, 1, "ok");

      // Three real markers, in the order the run reached them: the entry's own
      // admission, the turn's publication, and the root settling.
      yield* openHistory(page);
      // The categories a retained position reads as. Re-anchored for #881
      // PR 3: a drawer row was the checkpoint's own label and is now its place
      // in the recorded order and what kind of position it is — identical
      // wording live and historical, so neither route invents a richer one.
      for (const marker of ["Entry 1 admitted", "Agent turn recorded", "Entry outcome recorded"]) {
        expect([marker, historyMarkers(page.frame()).some((row) => row.includes(marker))]).toEqual([
          marker,
          true,
        ]);
      }

      // The prefix before the turn was published holds no turn: the entry is
      // admitted and nothing has been said.
      //
      // Read with the drawer closed, and that matters in both directions. This
      // layer covers the columns of the sidebar from an eighth of the screen
      // in, and the accepted body gutter moved the Sessions rows two cells
      // right — so the longest of them now ends under the drawer's own left
      // edge at this size. Behind a modal, "the screen does not show this" is
      // true of a prefix that holds the turn and one that does not, which is
      // the one thing these two assertions must tell apart. Closing keeps the
      // position: the drawer moved the reading to it, and the reading stays.
      yield* chooseMarker(page, "Entry 1 admitted");
      yield* closeDrawer(page);
      const admitted = yield* page.until(
        "the first position being read",
        (frame) => readingRetained(frame) && frame.area("box:drawer:layer") === undefined,
      );
      expect(shows(admitted, REPLY.trim())).toBe(false);
      expect(shows(admitted, "ok? ·")).toBe(false);
      yield* openHistory(page);

      // The drawer stays open on the position it moved to, and offers the
      // whole recorded order from there.
      //
      // Re-anchored for #881 PR 3. This asserted the opposite — that an
      // earlier prefix offers only its own share of the positions — and that
      // is the premise this slice reverses: the positions *after* the one
      // being read are where a reader can go next, so navigation is taken at
      // the whole file while content stays at the prefix. The separation is
      // still the pair below: the later position is offered, and nothing it
      // holds is on the screen.
      expect(readingRetained(page.frame())).toBe(true);
      expect(historyMarkers(page.frame()).some((row) => row.includes("Agent turn recorded"))).toBe(
        true,
      );
      // The two content assertions with the layer out of the way, for the
      // reason above; the drawer row above is the drawer's own and is read in it.
      yield* closeDrawer(page);
      expect(shows(page.frame(), REPLY.trim())).toBe(false);
      expect(shows(page.frame(), "completed, recorded")).toBe(false);
      yield* openHistory(page);

      // Back at the head: the drawer is modal, so it is closed first and then
      // the live control is reachable.
      yield* closeDrawer(page);
      yield* page.press("footer:live");
      yield* page.until(
        "the head showing the reply",
        (frame) => !readingRetained(frame) && shows(frame, REPLY.trim()),
      );

      // The prefix that holds the record holds the turn, with the facts the
      // record carries and nothing live.
      yield* openHistory(page);
      yield* chooseMarker(page, "Agent turn recorded");
      // And the positive side of the same pair, also out from under the layer.
      yield* closeDrawer(page);
      yield* page.until(
        "the recorded turn being read",
        (frame) =>
          readingRetained(frame) &&
          frame.area("box:drawer:layer") === undefined &&
          shows(frame, REPLY.trim()) &&
          shows(frame, "completed, recorded"),
      );

      // Reading a marker asked nobody anything.
      expect(live.prompts).toHaveLength(1);
      ended = yield* leave(page);
    });

    // Which prefix it came to rest on, taken where the route is still published.
    // `[live]` above says a prefix is being read; this says which one — the exact
    // checkpoint the last marker encoded, read only, on the surface and the locus
    // it was chosen from.
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

      // Malformed: not this grammar at all, so it is refused before a terminal
      // is taken, a history file is opened or a provider is named.
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

      // Well formed, and naming an execution this host does not hold. That is a
      // readable request about a history that is not here, so the surface says
      // so rather than replaying something.
      const page = yield* useReplPage({
        host,
        location: "xmd://repl/0123456789abcdef/entries",
      });
      yield* page.until("the refusal", (frame) =>
        shows(frame, "this execution has no history here."),
      );

      // Neither reached a provider, and neither replayed anything: no history
      // file was made for a run that never had one.
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
    // One reply per child, each naming itself so a row can say which turn it
    // means on a screen holding three.
    for (let turn = 0; turn < 3; turn += 1) {
      fake.script({ reply: ANSWERED });
    }
    const held = holds([PLAN_IT, REVIEW_IT, BUILD_IT]);

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot } = yield* beginJourney({ fake, held, size: WIDE });
      yield* submitted(page, THREE, 1);

      // All three turns are scheduled at once, and each is held where its state
      // is decided. Deliberately not in the order the document wrote them: the
      // reviewer is observed first, the implementer second, and the planner has
      // not been taken at all — so the order these conversations appear in is
      // the order they were seen, and cannot be the authored `<Spawn>` order.
      yield* page.until("a turn queued", (frame) => shows(frame, "· queued"));
      held.start(REVIEW_IT);
      held.deltas(REVIEW_IT);
      yield* page.until(`${REVIEW_IT} completed`, (frame) =>
        sessionTurns(frame).some((row) => saying(row, REVIEW_IT, "completed")),
      );
      held.start(BUILD_IT);

      // One frame holding all three states, each named by what its own child
      // asked. Read together rather than in three waits: what this row is about
      // is a screen, not a sequence.
      yield* page.until("the three states standing together", (frame) =>
        (
          [
            [REVIEW_IT, "completed"],
            [BUILD_IT, "streaming"],
            [PLAN_IT, "queued"],
          ] as const
        ).every(([asked, state]) => sessionTurns(frame).some((row) => saying(row, asked, state))),
      );
      expect(shows(page.frame(), "All sessions")).toBe(true);

      // With the implementer's turn recorded too, a conversation control is
      // there to filter by while the planner has still not been taken.
      held.deltas(BUILD_IT);
      // The conversations are behind the Transcript's own selector now: one
      // list, and the choices that filter it are shown when the control saying
      // so is activated. Opening it is how a person reaches them.
      yield* openSelector(page);
      yield* page.until(
        "a conversation offered",
        (frame) => offeredConversations(frame).length > 0,
      );
      expect(sessionTurns(page.frame()).some((row) => saying(row, PLAN_IT, "queued"))).toBe(true);

      // Selecting one is the route's own business: it carries that
      // conversation's exact provider session key, and the entry column beside
      // it is untouched.
      const keys = [PLAN_IT, REVIEW_IT, BUILD_IT].map(
        (asked) => fake.turns.find((turn) => turn.text.includes(asked))?.handle.sessionKey ?? "",
      );
      const unfiltered = conversationFilter(page.frame());
      const offered = offeredConversations(page.frame());
      const first = offered[0] ?? "";
      // The control is the key the provider really issued, whole.
      expect(keys).toContain(first);
      yield* chooseConversation(page, first);
      yield* page.until(
        "the reading narrowed to one conversation",
        (frame) => childrenShown(frame).length === 1,
      );
      // The row names the conversation the provider really issued. A sidebar is
      // narrow and a session key is not, so the selector carries as much of it
      // as the column holds and says so — and what is compared is that prefix
      // against the keys this run's own fixture recorded.
      const marked = conversationFilter(page.frame()) ?? "";
      expect(keys.some((key) => key.startsWith(marked.replace(/…$/, "")))).toBe(true);
      // One conversation's turns, and only its own.
      expect(childrenShown(page.frame())).toHaveLength(1);
      // The reading gained the filter and nothing else: nothing was filtered
      // before, exactly one conversation is marked now, and the control the
      // person was standing on is the control they are standing on.
      expect(unfiltered).toBeUndefined();
      expect(conversationFilter(page.frame())).toBeDefined();
      const standing = conversationFilter(page.frame());
      const focused = page.frame().focused;
      if (focused === undefined) {
        throw new Error(`no control holds focus. ${page.describe()}`);
      }
      // Its row, whatever it has settled to: what this asserts is that the
      // catalog holds the entry, not what became of it. The catalog is a drawer
      // over the reading now, so it is opened for that fact and put away by its
      // own control — and then the focus the person had is walked back to
      // through the ordinary ring, because opening a drawer is a real move and
      // the rows below compare where somebody is standing.
      yield* openCatalog(page);
      expect(shows(page.frame(), "] entry-1")).toBe(true);
      yield* closeCatalog(page);
      yield* page.focus(focused);
      expect(page.frame().focused).toBe(focused);

      // Background work in another conversation: the planner's turn is taken,
      // streams and is recorded, while the route, the history position and the
      // focused control stay exactly where the person left them.
      held.start(PLAN_IT);
      held.deltas(PLAN_IT);
      yield* awaitedFact("the third turn was never retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });
      expect(conversationFilter(page.frame())).toBe(standing);
      expect(page.frame().focused).toBe(focused);
      // And the filter still holds: the others are retained and not shown,
      // because this screen is showing one.
      expect(childrenShown(page.frame())).toHaveLength(1);

      // Cleared back to All, the whole chronology is there again — all three
      // children, each with the state its own turn ended in, and one more
      // conversation to filter by than before.
      // Cleared through the selector, which is what the filter is chosen in:
      // the control carries the name of whichever conversation was chosen, so
      // the unfiltered reading is a row inside it.
      yield* openSelector(page);
      yield* chooseEveryConversation(page);
      const everyone = yield* page.until("all three turns completed", (frame) =>
        [PLAN_IT, REVIEW_IT, BUILD_IT].every((asked) =>
          sessionTurns(frame).some((row) => saying(row, asked, "completed")),
        ),
      );
      expect(conversationFilter(everyone)).toBeUndefined();
      expect(childrenShown(everyone)).toEqual([PLAN_IT, REVIEW_IT, BUILD_IT]);
      // And one more conversation to filter by than there was, because the
      // third one has now been seen.
      yield* openSelector(page);
      expect(offeredConversations(page.frame()).length).toBeGreaterThan(offered.length);
      yield* closeSelector(page);

      // Three turns, three records, one per conversation.
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

  /** The draft this reading carries across every size, with a space in it. */
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
    /** The full provider session key the conversation row named. */
    let chosen: string | undefined;

    yield* scoped(function* (): Operation<void> {
      // The same wide terminal the other conversation rows use, so the whole
      // reading is in the window rather than below it: what this row is about is a
      // resize, not what a short window admits.
      const { page } = yield* beginJourney({ fake: live, held, hostRoot, size: WIDE });
      yield* submitted(page, THREE, 1);

      // Every child to its record, so there is more than one conversation to
      // filter by and a settled entry to reopen over.
      yield* page.until("a turn queued", (frame) => shows(frame, "· queued"));
      for (const asked of [PLAN_IT, REVIEW_IT, BUILD_IT]) {
        held.start(asked);
        held.deltas(asked);
      }
      yield* awaitedFact("the three turns were never all retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });

      // 1. A conversation filter, chosen by pointing at the row it is drawn in.
      // The conversations are behind the Transcript's own selector now: one
      // list, and the choices that filter it are shown when the control saying
      // so is activated. Opening it is how a person reaches them.
      yield* openSelector(page);
      yield* page.until(
        "a conversation offered",
        (frame) => offeredConversations(frame).length > 0,
      );
      // Which conversation this is about, as a full provider key: the control's
      // own key, checked against what this run's fixture says the provider issued.
      chosen = offeredConversations(page.frame())[0];
      expect(chosen).toBeDefined();
      expect(live.turns.map((turn) => turn.handle.sessionKey)).toContain(chosen);

      yield* chooseConversation(page, chosen ?? "");
      yield* page.until(
        "the reading narrowed to one conversation",
        (frame) => childrenShown(frame).length === 1,
      );
      filtered = conversationFilter(page.frame());
      expect(filtered).toBeDefined();

      // 2. A non-empty draft, typed into the field Tab reaches.
      yield* draft(page).type(TYPED);
      expect(conversationFilter(page.frame())).toBe(filtered);
      expect(draft(page).text()).toBe(TYPED);
      expect(childrenShown(page.frame())).toHaveLength(1);

      // 3. Narrow. What is read here is the draft row and the reading itself.
      const narrow = yield* page.resize({ columns: 72, rows: 20 });
      expect(narrow.rows.length).toBe(20);
      expect(draft(page).text()).toBe(TYPED);
      expect(narrow.rows.filter((line) => line.trimEnd().length > 72)).toEqual([]);
      // A narrow frame draws one routed surface, and choosing a conversation
      // chooses a filter rather than a surface — so the Sessions reading is not
      // on this screen at all. What a narrow frame still has to keep is the
      // draft, which is on it, and the route, which is read back below at the
      // width that draws all of it.
      expect(narrow.has("entries:heading")).toBe(true);

      // 4. Wide again, and the reading is the same string it was: the filter,
      //    the route and the draft are all in it.
      const back = yield* page.resize(WIDE);
      expect(back.rows.length).toBe(140);
      expect(conversationFilter(back)).toBe(filtered);
      expect(draft(page).text()).toBe(TYPED);
      expect(childrenShown(back)).toHaveLength(1);

      location = yield* leave(page);
    });

    // The whole reading, in the one string the command publishes on its way out,
    // compared field by field against what this run's fixture says each should
    // be: the conversation it was filtered to by its full key, the draft byte for
    // byte, the surface and locus it was standing on, and the live head.
    const standing = location;
    expect(standing).toBeDefined();
    const standingRoute = routeOf(standing);
    expect(standingRoute.session).toBe(chosen);
    expect(standingRoute.draft).toBe(TYPED);
    expect(standingRoute.surface).toBe("entries");
    expect(standingRoute.scopes).toEqual([]);
    expect(standingRoute.at).toBeUndefined();
    expect(standingRoute.inspect).toBe(false);
    expect(live.prompts).toHaveLength(3);
    const before = yield* entryHistory(hostRoot);

    // A cold process over that exact location: the same filter and the same
    // draft, with no provider reached at all.
    const cold = createFakeAcp();
    yield* scoped(function* (): Operation<void> {
      const { page } = yield* beginJourney({ fake: cold, hostRoot, size: WIDE, location });

      yield* page.until(
        "the cold process restoring the reading",
        (frame) => conversationFilter(frame) === filtered && draft(page).text() === TYPED,
      );
      expect(childrenShown(page.frame())).toHaveLength(1);

      // Nobody was asked, nothing was started, created or ensured.
      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(cold.created).toEqual([]);
      expect(cold.ensured).toEqual([]);

      const reopened = yield* leave(page);
      // What went in came back out: the cold process returns the same canonical
      // reading it was given, which is the whole of what reopening means.
      expect(reopened).toBe(standing);
      expect(routeOf(reopened).session).toBe(chosen);
      expect(routeOf(reopened).draft).toBe(TYPED);
    });

    // And the Journal is byte-identical: a cold process reads, it does not write.
    expect(yield* entryHistory(hostRoot)).toBe(before);
  });
});

/**
 * The rows the Sessions reading itself is drawn in.
 *
 * The sidebar band from the top of the screen, cut at the reading's own
 * `sessions:later` control: below that sit the Entries heading and the
 * catalog, which a conversation filter does not touch, and beside it are
 * columns holding a journal that grows.
 */
const listBand = (frame: PageFrame): string[] => {
  const viewport = frame.area("box:sessions:viewport");
  const later = frame.control("sessions:later");
  if (viewport === undefined || later === undefined) {
    return [];
  }
  return frame
    .within({
      x: viewport.bounds.x,
      y: 0,
      width: viewport.bounds.width,
      height: later.bounds.y,
    })
    .rows();
};

/** The last row of that band with anything written in it. */
const lastWritten = (band: readonly string[]): number =>
  band.reduce((last, line, at) => (line.trim().length > 0 ? at : last), -1);

describe("J2 — what filtering Sessions leaves on the screen (#875 R1)", () => {
  beforeAll(() => useTempFileCompiler());

  it("TL5: filtering to one conversation blanks the cells the vacated rows were drawn in", function* () {
    const fake = createFakeAcp();
    for (let turn = 0; turn < 3; turn += 1) {
      fake.script({ reply: ANSWERED });
    }
    const held = holds([PLAN_IT, REVIEW_IT, BUILD_IT]);

    yield* scoped(function* (): Operation<void> {
      const { page, hostRoot } = yield* beginJourney({ fake, held, size: WIDE });
      yield* submitted(page, THREE, 1);

      // Every child runs to its record, so the unfiltered reading holds all
      // three conversations and every fact each turn carries.
      yield* page.until("a turn queued", (frame) => shows(frame, "· queued"));
      for (const asked of [PLAN_IT, REVIEW_IT, BUILD_IT]) {
        held.start(asked);
        held.deltas(asked);
      }
      yield* awaitedFact("the three turns were never all retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });
      yield* page.until(
        "all three children standing together",
        (frame) => childrenShown(frame).length === 3,
      );

      // The conversations are behind the Transcript's own selector now: one
      // list, and the choices that filter it are shown when the control saying
      // so is activated. Opening it is how a person reaches them.
      yield* openSelector(page);
      yield* page.until(
        "a conversation offered",
        (frame) => offeredConversations(frame).length > 0,
      );

      // What the long reading draws, before anything is filtered.
      const before = listBand(page.frame());
      const lastBefore = lastWritten(before);
      // Pre-assert: the reading really is windowed, so there is a reading to
      // shrink and a `sessions:later` to bound it by.
      expect(before.length).toBeGreaterThan(0);
      expect(lastBefore).toBeGreaterThan(0);

      // Filtered to one real conversation, which is a shorter reading.
      yield* chooseConversation(page, offeredConversations(page.frame())[0] ?? "");
      yield* page.until("the reading shrinking", (frame) => childrenShown(frame).length === 1);
      expect(conversationFilter(page.frame())).toBeDefined();

      const after = listBand(page.frame());
      const lastAfter = lastWritten(after);
      // The reading really is shorter, which is what makes the rows below it
      // vacated rather than merely redrawn.
      expect(lastAfter).toBeLessThan(lastBefore);

      // Pre-assert: those rows had conversation text written in them. Without
      // this the assertion below would pass on an area that was always empty.
      const vacated: number[] = [];
      for (let row = lastAfter + 1; row <= lastBefore; row += 1) {
        if ((before[row] ?? "").trim().length > 0) {
          vacated.push(row);
        }
      }
      expect(vacated.length).toBeGreaterThan(0);
      expect(vacated.map((row) => before[row].trim()).filter((text) => text === "")).toEqual([]);

      // And every cell of them is blank now — a cell, not a description. A
      // renderer whose committed diff was computed against a frame nobody saw
      // leaves this text exactly where it was.
      const left = vacated.flatMap((row) =>
        [...(after[row] ?? "")]
          .map((cell, column) => ({ cell, column, row }))
          .filter((one) => one.cell !== " ")
          .map((one) => `${one.column},${one.row}=${one.cell}`),
      );
      expect(left).toEqual([]);

      yield* leave(page);
    });
  });
});

/** Wait for the command to return, and hand its failure on where it ended with one. */
function* ending(page: ReplPage): Operation<void> {
  yield* awaited("the command never ended", () => page.repl.outcome() !== undefined);
  const outcome = page.repl.outcome();
  if (outcome !== undefined && !outcome.ok) {
    throw outcome.error;
  }
}

/** What a scope that ends in failure threw, or none where it returned. */
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

  /**
   * One run with a turn the provider has taken and never finishes, so every
   * ending below is induced while there is real work to join.
   */
  function* inFlight(fake: FakeAcp, hostRoot: string, waitingFor: string): Operation<ReplPage> {
    const { page } = yield* beginJourney({ fake, hostRoot, size: TALL });
    yield* submitted(page, ASKING, 1);
    // Taken by the backend and streaming nothing: the turn is in flight, and
    // the only way out of it is the ending this row induces.
    yield* page.until(`${waitingFor} shown`, (frame) => shows(frame, waitingFor));
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
      // Read after the owner has joined: what a run appends late is exactly what
      // this cannot show while it is still going.
      const after = recorded(yield* journal(hostRoot));

      // The turn was cancelled rather than finished, and it appended nothing: a
      // record for work that was interrupted would be a record of something
      // that did not happen.
      expect(fake.cancels).toBeGreaterThan(0);
      expect(after).toEqual(before);
      expect(after.filter((kind) => kind === "agent_prompt")).toEqual([]);
      // The modes this command took, given back exactly once.
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
      // The screen is gone. A frame cannot be presented, which is not a reason
      // to keep running and not a reason to append anything.
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
    // A turn that asks for a tool this policy does not approve by itself, so a
    // request is waiting on a person when the command is cancelled.
    fake.script({ reply: PARTIAL, requestsTool: "rm -rf /", manual: true });
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));

    yield* scoped(function* (): Operation<void> {
      const mounted = withResolvers<ReplPage>();
      // The command lives in a task of its own, so that cancelling the process
      // is cancelling that task.
      const command = yield* spawn(function* (): Operation<void> {
        // A person is being asked. Nothing has answered it.
        mounted.resolve(yield* inFlight(fake, hostRoot, "rm -rf /"));
        yield* suspend();
      });
      const page = yield* mounted.operation;
      const before = recorded(yield* journal(hostRoot));

      // The command scope is cancelled — the process is going away. This is not
      // a denial: nobody decided anything, and a teardown that answered on the
      // person's behalf would be recording a decision they never made.
      yield* command.halt();

      expect(fake.decisions).toEqual([]);
      expect(recorded(yield* journal(hostRoot))).toEqual(before);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt")).toEqual(
        [],
      );
      // And the terminal is given back, once.
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

      // Left from the control on the screen, rather than by cancelling the scope
      // from outside it. The decision a person did not make is still not made: a
      // command that denied a request on the way out would be recording one.
      yield* page.press("footer:exit");
      yield* ending(page);

      expect(fake.decisions).toEqual([]);
      expect(recorded(yield* journal(hostRoot))).toEqual(before);
      expect(page.repl.terminal.raw).toEqual([true, false]);
      expect(page.repl.terminal.resets).toBe(1);
      // The location it ended at carries no drawer only this process could mount.
      const outcome = page.repl.outcome();
      const location = outcome?.ok === true ? outcome.value.location : undefined;
      expect(location).toBeDefined();
      expect(location).not.toContain("+permission");
      expect(location).not.toContain("+elicit");
    });
  });
});

/**
 * The journey J1 proves, walked without its assertions.
 *
 * A row that is about what the Journal holds afterwards still has to get there
 * the way a person does, so this is the same terminal driving rather than a
 * shortcut past it.
 */
function* takeTheJourney(
  page: ReplPage,
  fake: FakeAcp,
  hostRoot: string,
  workspace: string,
): Operation<void> {
  yield* submitted(page, STORY, 1);
  // Each question announces itself and opens nothing, so every one of them is
  // reached by activating that announcement first.
  yield* openQuestion(page);
  yield* page.until("the review offering changes", (frame) =>
    drawerShows(frame, "Request changes"),
  );
  yield* chooseOption(page, "decision", "Request changes");
  yield* page.until("the review refusing the missing feedback", (frame) =>
    drawerShows(frame, "required property"),
  );
  yield* answerField(page, "feedback", FEEDBACK);
  yield* form(page).submit();
  yield* awaited("the revision was never asked for", () => fake.prompts.length >= 2);
  yield* openQuestion(page);
  yield* page.until("the revised review", (frame) => drawerShows(frame, REVISION_TITLE));
  yield* chooseOption(page, "decision", "Approve");
  yield* openQuestion(page);
  yield* page.until("the program's first question", (frame) =>
    drawerShows(frame, "Name the project"),
  );
  yield* answerField(page, "project", "Ledger");
  yield* answerField(page, "summary", "A tiny ledger.");
  yield* form(page).submit();
  yield* openQuestion(page);
  yield* page.until("the confirmation", (frame) => drawerShows(frame, "Write this README?"));
  yield* chooseOption(page, "decision", "Approve");
  yield* page.until("the report following the write", (frame) => occurrences(frame, CREATED) > 1);
  yield* awaitedFact("the entry never settled", function* () {
    return (yield* journal(hostRoot)).some((event) => event.type === "close");
  });
  expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);
  yield* entrySettles(page, 1, "ok");
}

/**
 * Select one scope by its catalog row, and count what it says was answered.
 *
 * #881 PR 2 gave the Transcript the selected entry's reading, so the records of
 * every scope no longer appear there at once; the answers a nested scope
 * retained are read by selecting that scope, which is where the product says
 * they were asked. Selection is the behavior being tested: a row counted under
 * the wrong scope would be an answer attributed to somewhere it never happened.
 *
 * The scope first, because it is a row of the entry's catalog and the catalog
 * is a drawer over the reading: choosing a row closes it again, which is what
 * leaves the reading showing what that scope retains. Then the inspector,
 * because selecting a scope is a reading and the right column defaults to the
 * Sidekick.
 */
function* answeredUnder(page: ReplPage, scope: string, text: string): Operation<number> {
  yield* openCatalog(page);
  yield* chooseCatalogRow(page, scope);
  if (shownPane(page.frame()) === "sidekick") {
    yield* selectPane(page, "bindings");
  }
  const reading = yield* page.until(
    `a row saying ${text} after selecting ${scope}`,
    (frame) => occurrences(frame, text) > 0,
  );
  return occurrences(reading, text);
}

/** Whether this host holds no REPL history at all. */
function* absentHistory(hostRoot: string): Operation<boolean> {
  const found = yield* untilResolved(
    readdir(join(hostRoot, "xmd", "repl")).catch(() => [] as string[]),
  );
  return found.length === 0;
}

/**
 * The one entry history this host holds, as text.
 *
 * Resolved rather than named, because a published pair keeps its entries in
 * `v1/<execution>/entries.jsonl` while an older single-file execution is
 * `<execution>.jsonl`. What these rows are about is the records, not the
 * layout.
 */
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

/** A REPL host over a data root, and the profile and scripted agent a command runs under it. */
interface JourneyHost extends MountedHost {
  readonly dataRoot: string;
}

/**
 * Install one REPL host and assemble the profile a command runs under it.
 *
 * The data root can be handed back in, which is what a cold row needs: a second
 * command over the same history is the only way to prove a screen was
 * reconstructed from the Journal rather than from anything the first process
 * still held.
 */
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

/**
 * Start the program the way the command does, on a page, in the calling scope.
 *
 * Everything it installs — the working directory, the clock, the host, the
 * terminal and the command itself — lives as long as that scope does, so a row
 * that starts a second process over the same history starts it in a scope of
 * its own.
 */
function* beginJourney(options: {
  readonly fake: FakeAcp;
  readonly held?: Holds;
  readonly hostRoot?: string;
  readonly size?: ReplTerminalSize;
  readonly location?: string;
  readonly includes?: readonly string[];
  readonly planWriterRoot?: string;
  readonly permissionMode?: "approve-reads" | "deny-all";
  /** Whether to give the command a temporary working directory. Defaults to yes. */
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

/**
 * Type one whole entry and submit it.
 *
 * Pasted as one chunk: a page-long entry arrives as many decoded keys, and
 * Enter means "submit this draft" only once the draft is all of it. The entry
 * is admitted when the History rail marks it and the draft this helper just
 * typed has emptied. A draft is execution-wide and survives admission as the
 * *next* entry's text (#827 Slice C), so what clears is this one — and it
 * clears only when it has become an entry.
 */
function* submitted(page: ReplPage, text: string, order: number): Operation<void> {
  yield* paste(page, draft(page), text);
  yield* page.key("Enter");
  yield* page.until(
    `the draft becoming entry ${order}`,
    (frame) => railMark(frame, order) !== undefined && draft(page).text() === "",
  );
}

/** Close the terminal's input the way end of file does, and return where the command ended. */
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

/**
 * Make the terminal's byte source fail, which is how a terminal is lost.
 *
 * Installed over the terminal the page mounts, so the read the command has
 * outstanding ends and the next one raises the failure it was handed.
 */
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

/**
 * A temporary working directory every path in a fragment resolves against, with
 * the host filesystem this build's entrypoint installs.
 *
 * Both halves belong to the host rather than to the REPL: `deno.ts`, `node.ts`
 * and the compiled entrypoint each install the Files provider before a command
 * runs, and the working directory is the caller's own. A row that installed
 * neither would prove something about a process no entrypoint assembles.
 */
function* useWorkspace(): Operation<string> {
  const root = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-work-")));
  yield* useHostFiles();
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return root;
      },
    },
    // Beneath everything: the ordinary evaluation profile reads the working
    // directory when a fragment runs, and a row that let it read the real one
    // would write into the checkout.
    { at: "min" },
  );
  return root;
}

/** One promise a test opens by hand. */
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

/**
 * The turns this suite holds, and where.
 *
 * Two holds per turn, because the states a reader sees are decided by two
 * different provider facts: a turn is queued until the backend has taken it, and
 * active until it has said what it has to say. Held by what the turn asked, not
 * by the order it was asked in — three turns started at once by one `<All>` reach
 * the provider in whatever order their coroutines were scheduled, and a row about
 * three states at once has to name which turn it means.
 */
interface Holds {
  create(fake: FakeAcp): FakeAcp["create"];
  /** Let the turn whose prompt holds this text be taken by the backend. */
  start(asked: string): void;
  /** Let that turn stream and settle. */
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
            // Held before the backend reports it took the turn, which is what
            // the "started" event carries.
            materialized: hold.start.opened.then(() => turn.materialized),
            events: {
              [Symbol.asyncIterator]() {
                const events = inner[Symbol.asyncIterator]();
                /** The one ending this wrapper may have to produce itself. */
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

/** Every durable record this run wrote, in order, as `type:status`. */
function* journal(hostRoot: string): Operation<Record<string, unknown>[]> {
  const text = yield* entryHistory(hostRoot);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The kinds of the yield records a history holds, in order. */
function recorded(events: readonly Record<string, unknown>[]): string[] {
  return events
    .filter((event) => event.type === "yield")
    .map((event) => String((event.description as { type?: string } | undefined)?.type));
}

/** The one generated-XMD admission this run recorded, as the record holds it. */
function admission(events: readonly Record<string, unknown>[]): {
  readonly source: string;
  readonly named: readonly { readonly name: string; readonly form: string }[];
} {
  const admissions = events.filter(
    (event) =>
      event.type === "yield" &&
      (event.description as { type?: string } | undefined)?.type === "generated_xmd",
  );
  expect(admissions).toHaveLength(1);
  const value = (admissions[0]?.result as { value?: Record<string, unknown> } | undefined)?.value;
  const named = (value?.named ?? []) as { name: string; form: string }[];
  return {
    source: String(value?.source),
    named: named.map((one) => ({ name: one.name, form: one.form })),
  };
}

/** A clock the test moves, so nothing in this suite waits on real time. */
function immediateClock(): Operation<void> {
  return ReplClock.around(
    {
      // deno-lint-ignore require-yield
      *now(): Operation<number> {
        return 0;
      },
      // deno-lint-ignore require-yield
      *wait(): Operation<void> {
        // Returns at once: this product draws when something changed, so the
        // frame interval is the only thing being skipped.
      },
    },
    { at: "min" },
  );
}

/**
 * The canonical route one returned location carries, decoded.
 *
 * The screen no longer draws a location, so what a scenario protects about its
 * route is asserted here — on the string the command publishes when it ends,
 * field by field, against what the fixture says those fields should be.
 */
function routeOf(location: string | undefined): ReplRoute {
  const decoded = decodeLocation(location ?? "");
  if (!decoded.ok) {
    throw decoded.error;
  }
  return decoded.value;
}

/** Which of the three children's turns this frame is showing, in source order. */
function childrenShown(frame: PageFrame): string[] {
  const rows = sessionTurns(frame);
  return [PLAN_IT, REVIEW_IT, BUILD_IT].filter((asked) =>
    rows.some((row) => saying(row, asked, "")),
  );
}

/**
 * Whether this line shows this prompt, whole or shortened to fit its row.
 *
 * A row is as wide as the region the frame measured for it, and a sidebar is
 * narrow: a prompt nobody bounded keeps the columns the row's own vocabulary
 * leaves it, marked where it was cut. So a question about which turn a row is
 * asks whether the row shows that prompt, not whether it holds every letter of
 * it.
 */
function shownPrompt(line: string, prompt: string): boolean {
  for (let kept = prompt.length; kept >= 1; kept -= 1) {
    if (line.includes(kept === prompt.length ? prompt : `${prompt.slice(0, kept)}…`)) {
      return true;
    }
  }
  return false;
}

/** Whether this line shows this prompt and this state, in that order. */
function saying(line: string, prompt: string, state: string): boolean {
  for (let kept = prompt.length; kept >= 1; kept -= 1) {
    const shown = kept === prompt.length ? prompt : `${prompt.slice(0, kept)}…`;
    if (line.includes(`${shown} · ${state}`)) {
      return true;
    }
  }
  return false;
}

/** One entry holding one Prompt, so every entry records sequence `0`. */
function promptEntry(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}
