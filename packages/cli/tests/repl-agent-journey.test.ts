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
 * fixture data rather than a claim about what a model would write: what it has
 * to be is *legal* — a generated fragment under the ordinary ceiling, which may
 * write JSON literals, its own bindings, arrays and objects and may not compute
 * anything. That is why it compares two `<Json />` renderings instead of
 * reading a member of its own answer: `confirmation.decision === "Approve"` is
 * a computed expression, and the grammar refuses one (specs §5.3.3).
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, until as untilResolved } from "effection";
import type { Operation, Task } from "effection";
import { useTempFileCompiler } from "@executablemd/core";
import { API, useHostFiles } from "@executablemd/runtime";
import { appendFile, mkdtemp, open, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { decodeLocation, encodeLocation } from "../src/repl/route.ts";
import { installReplHost } from "../src/repl-assembly.ts";
import { installReplTerminal } from "../src/repl/terminal-host.ts";
import type { ReplTerminalCapabilities } from "../src/repl/terminal-host.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { ReplClock } from "../src/repl/frame.ts";
import { surfaceWidth } from "../src/repl/layout.ts";
import { runReplProgram } from "../src/repl/program.ts";
import { assembleReplProfile } from "../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import { NO_PLUGINS } from "../src/plugin-host.ts";
import { resolveAgentStack } from "../src/agent-stack.ts";
import { createFakeAcp, makeRegistry, makeStore, tripwireAcp } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { ADAPTERS, AGENT } from "./support/plan-harness.ts";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { projectRepl } from "../src/repl/model.ts";

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
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 140 });

    yield* scoped(function* (): Operation<void> {
      const workspace = yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      const hostRoot = yield* useTemporaryHost();
      const running = yield* spawn(() => start(fake, held, workspace));
      yield* untilDrawn(terminal);

      terminal.bytes(BYTES.encode(STORY));
      yield* settled(20);
      terminal.feed("\r");

      // Queued: the Prompt is scheduled and the provider has not taken it.
      yield* showing(terminal, "· queued");
      expect(shows(terminal, "· streaming")).toBe(false);
      // Taken, and streaming: the turn is active before it has said anything.
      held.start(AUTHORSHIP);
      yield* showing(terminal, "· streaming");
      // Ended, with the fact its provider reported, and then retained: the row a
      // person was watching becomes its own record, under the scope the packaged
      // Plan was admitted as.
      held.deltas(AUTHORSHIP);
      yield* showing(terminal, "stopped: end_turn");
      yield* showing(terminal, "completed, recorded");
      yield* awaiting("the turn was never retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length > 0
        );
      });

      // The review is the REPL's own drawer, over the draft the Agent returned.
      yield* showing(terminal, "Request changes");
      expect(shows(terminal, "A first draft")).toBe(true);

      // Request changes with no feedback. Choosing an option submits the form,
      // and this one is refused: the schema requires the feedback that option
      // asks for, so the review stays open, nothing is answered and no turn
      // begins.
      yield* click(terminal, "( ) Request changes");
      yield* settled(40);
      expect(shows(terminal, "Request changes")).toBe(true);
      expect(fake.prompts).toHaveLength(1);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "elicit")).toEqual([]);

      // With feedback, the same conversation continues into the next turn.
      yield* click(terminal, "feedback:");
      terminal.bytes(BYTES.encode(FEEDBACK));
      yield* settled(20);
      yield* click(terminal, "[submit]");
      yield* until(() => fake.prompts.length >= 2, "the revision was never asked for");
      expect(fake.prompts[1]).toContain(FEEDBACK);
      expect(new Set(fake.turns.map((turn) => turn.handle.sessionKey)).size).toBe(1);

      // Approved: the revision is what `<Evaluate>` admits.
      yield* showing(terminal, "Approve");
      yield* click(terminal, "( ) Approve");

      // The first question the generated program asks.
      yield* showing(terminal, "Name the project");
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

      yield* answer(terminal, "Project name", "Ledger");
      yield* answer(terminal, "One-sentence description", "A tiny ledger.");
      yield* submit(terminal);

      // The preview: the complete proposed file, in the confirmation's own
      // request, before anything has been written.
      yield* showing(terminal, "Write this README?");
      for (const line of ["# The project", '"project": "Ledger"', '"summary": "A tiny ledger."']) {
        expect([line, shows(terminal, line)]).toEqual([line, true]);
      }
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);
      // The report is on the screen only as the source it was admitted from —
      // one row, the program's own text — and nothing has rendered it.
      expect(occurrences(terminal, CREATED)).toBe(1);

      // Approved. The report follows the write: at the first frame that shows
      // it, the file is already there, with the bytes the preview showed.
      yield* click(terminal, "( ) Approve");
      yield* awaiting("the report never followed the write", function* () {
        yield* settled(10);
        return occurrences(terminal, CREATED) > 1;
      });
      expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);
      expect(yield* untilResolved(readFile(join(workspace, "README.md"), "utf8"))).toBe(WRITTEN);
      // And the branch that was not taken rendered nothing: its line is on the
      // screen once, as source.
      expect(occurrences(terminal, STOPPED)).toBe(1);

      // One write, and the entry settled on it.
      yield* awaiting("the entry never settled", function* () {
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
      expect(occurrences(terminal, "completed, recorded")).toBe(2);
      expect(shows(terminal, "component Plan")).toBe(true);
      expect(shows(terminal, "generated generated")).toBe(true);
      // And both Plan reviews are retained where they were asked, which is
      // inside that scope rather than in the entry.
      expect(occurrences(terminal, "answered @executablemd/cli/Plan.md")).toBe(2);

      // Two turns in one conversation, and nothing else was asked.
      expect(fake.prompts).toHaveLength(2);
      terminal.end();
      yield* running;
    });
  });

  it("J1: declining reaches the same preview and writes nothing", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: DRAFT });
    fake.script({ reply: REVISED });
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 140 });

    yield* scoped(function* (): Operation<void> {
      const workspace = yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      const hostRoot = yield* useTemporaryHost();
      const running = yield* spawn(() => start(fake, holds([]), workspace));
      yield* untilDrawn(terminal);

      terminal.bytes(BYTES.encode(STORY));
      yield* settled(20);
      terminal.feed("\r");

      // The same review, the same feedback, the same approved program.
      yield* showing(terminal, "Request changes");
      yield* click(terminal, "( ) Request changes");
      yield* settled(40);
      yield* click(terminal, "feedback:");
      terminal.bytes(BYTES.encode(FEEDBACK));
      yield* settled(20);
      yield* click(terminal, "[submit]");
      yield* until(() => fake.prompts.length >= 2, "the revision was never asked for");
      yield* showing(terminal, "Approve");
      yield* click(terminal, "( ) Approve");

      yield* showing(terminal, "Name the project");
      yield* answer(terminal, "Project name", "Ledger");
      yield* answer(terminal, "One-sentence description", "A tiny ledger.");
      yield* submit(terminal);

      // The same preview, reached the same way.
      yield* showing(terminal, "Write this README?");
      expect(shows(terminal, '"project": "Ledger"')).toBe(true);
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);

      // Declined. The two outcomes are observably different: one reports a
      // file it wrote, and this one reports that it wrote nothing.
      yield* click(terminal, "( ) Decline");
      yield* awaiting("the decline was never reported", function* () {
        yield* settled(10);
        return occurrences(terminal, STOPPED) > 1;
      });
      // And the write branch rendered nothing: its report is on the screen once,
      // as the source it was admitted from.
      expect(occurrences(terminal, CREATED)).toBe(1);
      yield* awaiting("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      // Nothing was written, and the question that decided it is in the
      // history exactly as the approving one is.
      expect(yield* untilResolved(readdir(workspace))).toEqual([]);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "elicit")).toHaveLength(
        4,
      );
      terminal.end();
      yield* running;
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
      return yield* assembleReplProfile(stack.value, NO_PLUGINS, {
        acp: { createRuntime: tripwireAcp((what) => reached.push(what)) },
        planWriterRoot: yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-c1-"))),
      });
    });

    expect(reached).toEqual([]);
    // Approve-reads is what an unstated line means, and it is the mode the
    // profile carries.
    expect(settled.permissionMode).toBe("approve-reads");
    // Fixed includes: this command takes no include option, because an entry is
    // typed rather than named.
    expect(settled.includes).toEqual(["components", "."]);
    // One installation of this command's own, holding the packaged `<Plan>` and
    // the ceiling a generated fragment runs under — and the ordinary write
    // table, questions included.
    expect(settled.installations).toHaveLength(1);
    const own = settled.installations[0]!;
    expect((own.declarations ?? []).map((declaration) => declaration.name)).toEqual(["Plan"]);
    expect((own.evaluation?.write ?? []).map((entry) => entry.name)).toEqual([
      "File",
      "File.Delete",
      "Elicit",
    ]);
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
    const reached: string[] = [];
    const { terminal, install } = recordingTerminal();

    yield* scoped(function* (): Operation<void> {
      yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      const hostRoot = yield* useTemporaryHost();
      const running = yield* spawn(function* (): Operation<void> {
        const stack = yield* resolveAgentStack(
          {
            agentProvider: "acpx",
            defaultAgent: AGENT,
            approveAll: false,
            approveReads: false,
            denyAll: false,
          },
          undefined,
        );
        if (!stack.ok) {
          throw stack.error;
        }
        const profile = yield* assembleReplProfile(stack.value, NO_PLUGINS, {
          acp: { createRuntime: tripwireAcp((what) => reached.push(what)) },
          planWriterRoot: yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-c1-"))),
        });
        const ran = yield* runReplProgram({ profile });
        if (!ran.ok) {
          throw ran.error;
        }
      });
      yield* untilDrawn(terminal);
      terminal.bytes(BYTES.encode("# A document that asks nobody anything"));
      yield* settled(20);
      terminal.feed("\r");
      yield* showing(terminal, "A document that asks nobody anything");
      yield* awaiting("the entry never settled", function* () {
        return (yield* journal(hostRoot)).some((event) => event.type === "close");
      });
      // Nothing about the provider was reached: no runtime, no registry, no
      // adapter on disk.
      expect(reached).toEqual([]);
      terminal.end();
      yield* running;
    });
  });

  it("C1: `<Session.Launch>` is unavailable and the REPL keeps the terminal", function* () {
    const fake = createFakeAcp();
    const { terminal, install } = recordingTerminal();

    yield* scoped(function* (): Operation<void> {
      yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      const hostRoot = yield* useTemporaryHost();
      const running = yield* spawn(() => start(fake, holds([]), ""));
      yield* untilDrawn(terminal);
      const modes = terminal.raw.length;

      terminal.bytes(BYTES.encode("<Session.Launch>\ndo the work\n</Session.Launch>"));
      yield* settled(20);
      terminal.feed("\r");

      // The established refusal, from the Api's own default: this command
      // installs no foreground launcher, so nothing was started and the entry
      // failed on the reservation rather than on anything it launched.
      yield* awaiting("the entry never settled", function* () {
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
      terminal.end();
      yield* running;
    });
  });
});

describe("J3 — durable truth, and a cold process over it", () => {
  beforeAll(() => useTempFileCompiler());

  it("J3: a fresh command scope reconstructs the whole Story from the Journal alone", function* () {
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const live = createFakeAcp();
    live.script({ reply: DRAFT });
    live.script({ reply: REVISED });
    const first = recordingTerminal({ columns: 200, rows: 140 });
    let location = "";
    let markers: string[] = [];

    yield* scoped(function* (): Operation<void> {
      const workspace = yield* useWorkspace();
      yield* first.install();
      yield* immediateClock();
      yield* useTemporaryHost(hostRoot);
      const running = yield* spawn(() => start(live, holds([]), workspace));
      yield* untilDrawn(first.terminal);
      // The exact Story, through the real packaged Plan, exactly as J1 walks it.
      yield* takeTheJourney(first.terminal, live, hostRoot, workspace);
      // The History positions this run reached, read from the drawer that
      // offers them.
      yield* click(first.terminal, "[history]");
      yield* settled(40);
      markers = historyMarkers(first.terminal);
      expect(markers.length).toBeGreaterThan(3);
      yield* click(first.terminal, "[close]");
      yield* settled(20);
      first.terminal.end();
      location = yield* running;
    });

    // What the live process printed, and what the history holds now.
    expect(location).toContain("xmd://repl/");
    const before = yield* history(hostRoot);
    expect(live.prompts).toHaveLength(2);

    const cold = createFakeAcp();
    const second = recordingTerminal({ columns: 200, rows: 140 });
    yield* scoped(function* (): Operation<void> {
      const elsewhere = yield* useWorkspace();
      yield* second.install();
      yield* immediateClock();
      yield* useTemporaryHost(hostRoot);
      const running = yield* spawn(() => start(cold, holds([]), elsewhere, location));
      yield* untilDrawn(second.terminal);

      // The whole journey, from the Journal: the packaged Plan's own scope, the
      // program it produced, both retained turns and their conversation, the
      // forms that were answered, the preview the program rendered and the
      // write it reported.
      for (const line of [
        "component Plan",
        "generated generated",
        "# A first draft",
        "Proposed README.md:",
        '"project": "Ledger"',
        '"summary": "A tiny ledger."',
        CREATED,
      ]) {
        yield* showing(second.terminal, line);
      }
      // Both turns are recorded rows rather than a live process's readings, and
      // both Plan reviews are retained where they were asked.
      expect(occurrences(second.terminal, "completed, recorded")).toBe(2);
      expect(occurrences(second.terminal, "answered @executablemd/cli/Plan.md")).toBe(2);
      // The program's own two questions are retained with the answers they
      // took. Their positions carry no path — generated source is not a file —
      // so they are shown under the fragment that produced them.
      expect(occurrences(second.terminal, 'answered 4:1 {"project":"Ledger"')).toBe(1);
      expect(occurrences(second.terminal, 'answered 12:1 {"decision":"Approv')).toBe(1);
      // And the branch that was not taken is on the screen once, as source.
      expect(occurrences(second.terminal, STOPPED)).toBe(1);

      // The same History positions, from the same drawer.
      yield* click(second.terminal, "[history]");
      yield* settled(40);
      expect(historyMarkers(second.terminal)).toEqual(markers);
      yield* click(second.terminal, "[close]");
      yield* settled(20);

      // Nothing was asked of anybody: no provider, no adapter, and no question
      // or permission offered to answer a second time.
      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(shows(second.terminal, "[submit]")).toBe(false);
      expect(shows(second.terminal, "( ) Approve")).toBe(false);
      // And nothing was written: the file the entry wrote is in the first
      // process's working directory, and this one has its own.
      expect(yield* untilResolved(readdir(elsewhere))).toEqual([]);
      second.terminal.end();
      yield* running;
    });

    // Byte for byte the history it opened: reading a run is not appending to it.
    expect(yield* history(hostRoot)).toBe(before);
  });

  it("EC1: two entries of retained Agent work reopen cold, asking nobody", function* () {
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const live = createFakeAcp();
    live.script({ reply: "ONE-DONE" });
    live.script({ reply: "TWO-DONE" });
    const first = recordingTerminal({ columns: 200, rows: 140 });
    let location = "";
    let turnRows: string[] = [];

    // Two entries, each holding one Prompt, through one command. One Prompt per
    // execution means each entry records sequence `0` — the collision a global
    // chronology would have to resolve, and the one a cold reader has to
    // resolve the same way.
    yield* scoped(function* (): Operation<void> {
      const workspace = yield* useWorkspace();
      yield* first.install();
      yield* immediateClock();
      yield* useTemporaryHost(hostRoot);
      const running = yield* spawn(() => start(live, holds([]), workspace));
      yield* untilDrawn(first.terminal);

      yield* typed(first.terminal, promptEntry("ask-one"));
      yield* showing(first.terminal, "1. [ok] entry-1");
      yield* focusDraft(first.terminal);
      yield* typed(first.terminal, promptEntry("ask-two"));
      yield* showing(first.terminal, "2. [ok] entry-2");

      // Both turns are on the Sessions reading, in one conversation, before
      // anything is read back: this is the reading a cold process has to
      // reproduce, and it is captured as it is *drawn* so the comparison below
      // is of two screens rather than of two descriptions.
      yield* showing(first.terminal, "ONE-DONE");
      yield* showing(first.terminal, "TWO-DONE");
      // The conversation control exists, which is what says the Sessions
      // surface is offering a conversation to filter by at all. Which key it
      // is, is a fact about the record and is asserted of the record below —
      // a provider session key is longer than this column and is drawn cut.
      expect(shows(first.terminal, "All conversations")).toBe(true);
      turnRows = promptRows(first.terminal);
      expect(turnRows).toHaveLength(2);
      expect(turnRows.some((row) => row.includes("ask-one"))).toBe(true);
      expect(turnRows.some((row) => row.includes("ask-two"))).toBe(true);

      first.terminal.end();
      location = yield* running;
    });

    expect(live.prompts).toEqual(["ask-one", "ask-two"]);
    const before = yield* history(hostRoot);

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
    const second = recordingTerminal({ columns: 200, rows: 140 });
    yield* scoped(function* (): Operation<void> {
      const elsewhere = yield* useWorkspace();
      yield* second.install();
      yield* immediateClock();
      yield* useTemporaryHost(hostRoot);
      const at = `${location.split("?")[0]}/${selected.key}`;
      const running = yield* spawn(() => start(cold, holds([]), elsewhere, at));
      yield* untilDrawn(second.terminal);

      // The catalog the file holds, in admission order with its outcomes.
      yield* showing(second.terminal, "1. [ok] entry-1");
      yield* showing(second.terminal, "2. [ok] entry-2");
      expect(locationRow(second.terminal) ?? "").toContain(`/${selected.key}`);

      // The global Sessions chronology, row for row and conversation for
      // conversation, is the one the live process showed — both entries' turns
      // under the one conversation, with the selection narrowing none of it.
      yield* showing(second.terminal, "ONE-DONE");
      yield* showing(second.terminal, "TWO-DONE");
      expect(shows(second.terminal, "All conversations")).toBe(true);
      expect(promptRows(second.terminal)).toEqual(turnRows);

      // The selected entry's own transcript, read off the transcript column
      // rather than compared projection to projection — two projections of one
      // file agree by construction, and what this row is about is the screen.
      const transcript = column(second.terminal, SIDEBAR).join("\n");
      expect(transcript).toContain("TWO-DONE");
      expect(transcript).not.toContain("ONE-DONE");
      // The first entry's turn is still on the Sessions reading beside it,
      // which is what makes the absence above a locus and not a lost record.
      expect(promptRows(second.terminal).some((row) => row.includes("ask-one"))).toBe(true);

      // Nobody was asked anything to do it.
      expect(cold.prompts).toEqual([]);
      expect(cold.started).toBe(false);
      expect(cold.created).toEqual([]);
      expect(cold.ensured).toEqual([]);

      second.terminal.end();
      yield* running;
    });

    // Byte for byte the history it opened: reading a run is not appending to it.
    expect(yield* history(hostRoot)).toBe(before);
  });

  it("J3: a failed and a cancelled turn restore terminally, with the text they had", function* () {
    for (const [what, scripted, status, stopped] of [
      ["failed", { reply: PARTIAL, stopReason: "refusal" }, "failed, recorded", "stopped: refusal"],
      ["cancelled", { reply: PARTIAL, cancelled: true }, "cancelled, recorded", undefined],
    ] as const) {
      const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
      const live = createFakeAcp();
      live.script(scripted);
      const first = recordingTerminal({ columns: 200, rows: 60 });
      let location = "";

      yield* scoped(function* (): Operation<void> {
        const workspace = yield* useWorkspace();
        yield* first.install();
        yield* immediateClock();
        yield* useTemporaryHost(hostRoot);
        const running = yield* spawn(() => start(live, holds([]), workspace));
        yield* untilDrawn(first.terminal);
        yield* typed(first.terminal, ASKING);
        // The partial text, and how the turn ended, on the live surface.
        yield* showing(first.terminal, PARTIAL);
        yield* showing(first.terminal, `· ${status}`);
        first.terminal.end();
        location = yield* running;
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
      const second = recordingTerminal({ columns: 200, rows: 60 });
      yield* scoped(function* (): Operation<void> {
        const elsewhere = yield* useWorkspace();
        yield* second.install();
        yield* immediateClock();
        yield* useTemporaryHost(hostRoot);
        const running = yield* spawn(() => start(cold, holds([]), elsewhere, location));
        yield* untilDrawn(second.terminal);
        yield* showing(second.terminal, PARTIAL);
        yield* showing(second.terminal, `· ${status}`);
        if (stopped !== undefined) {
          yield* showing(second.terminal, stopped);
        }
        // Never presented as work in progress, and nobody was asked again.
        expect([what, shows(second.terminal, "· queued")]).toEqual([what, false]);
        expect([what, shows(second.terminal, "· streaming")]).toEqual([what, false]);
        expect([what, cold.prompts]).toEqual([what, []]);
        expect([what, cold.started]).toEqual([what, false]);
        second.terminal.end();
        yield* running;
      });
    }
  });

  it("J3: each marker shows only what its own prefix retains", function* () {
    const hostRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-")));
    const live = createFakeAcp();
    live.script({ reply: REPLY });
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 60 });

    yield* scoped(function* (): Operation<void> {
      const workspace = yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      yield* useTemporaryHost(hostRoot);
      const running = yield* spawn(() => start(live, holds([]), workspace));
      yield* untilDrawn(terminal);
      yield* typed(terminal, ASKING);
      yield* showing(terminal, REPLY.trim());

      // Three real markers, in the order the run reached them: the entry's own
      // admission, the turn's publication, and the root settling.
      yield* click(terminal, "[history]");
      yield* settled(40);
      for (const marker of ["Entry 1 admitted", "Agent prompt completed", "Settled"]) {
        expect([marker, shows(terminal, marker)]).toEqual([marker, true]);
      }

      // The prefix before the turn was published holds no turn: the entry is
      // admitted and nothing has been said.
      yield* click(terminal, "Entry 1 admitted");
      yield* settled(40);
      expect(shows(terminal, REPLY.trim())).toBe(false);
      expect(shows(terminal, "ok? ·")).toBe(false);

      // The drawer stays open on the position it moved to, and now offers only
      // that prefix's markers: at `yield:root:0` the turn had not happened, so
      // there is nothing about it to select.
      expect(maybeLocation(terminal)).toContain("at=yield:root:0");
      expect(shows(terminal, "Agent prompt completed")).toBe(false);

      // Back at the head: the drawer is modal, so it is closed first and then
      // the live control is reachable.
      yield* click(terminal, "[close]");
      yield* settled(20);
      yield* click(terminal, "[live]");
      yield* showing(terminal, REPLY.trim());

      // The prefix that holds the record holds the turn, with the facts the
      // record carries and nothing live.
      yield* click(terminal, "[history]");
      yield* settled(40);
      yield* click(terminal, "Agent prompt completed");
      yield* settled(40);
      yield* showing(terminal, REPLY.trim());
      yield* showing(terminal, "completed, recorded");
      expect(maybeLocation(terminal)).toContain("at=yield:root:3");

      // Reading a marker asked nobody anything.
      expect(live.prompts).toHaveLength(1);
      terminal.end();
      yield* running;
    });
  });

  it("J3: a location this host cannot read refuses before any replay", function* () {
    const cold = createFakeAcp();
    const { terminal, install } = recordingTerminal();

    yield* scoped(function* (): Operation<void> {
      yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      const hostRoot = yield* useTemporaryHost();
      const profile = yield* settledProfile(cold);

      // Malformed: not this grammar at all, so it is refused before a terminal
      // is taken, a history file is opened or a provider is named.
      const malformed = yield* runReplProgram({ profile, location: "xmd://nope" });
      expect(malformed.ok).toBe(false);
      expect(malformed.ok === false && malformed.error.message).toContain(
        "a REPL location begins with xmd://repl/",
      );
      expect(terminal.presented).toEqual([]);

      // Well formed, and naming an execution this host does not hold. That is a
      // readable request about a history that is not here, so the surface says
      // so rather than replaying something.
      const running = yield* spawn(function* (): Operation<void> {
        yield* runReplProgram({ profile, location: "xmd://repl/0123456789abcdef/repl" });
      });
      yield* showing(terminal, "this execution has no history here.");

      // Neither reached a provider, and neither replayed anything: no history
      // file was made for a run that never had one.
      expect(cold.started).toBe(false);
      expect(cold.prompts).toEqual([]);
      expect(yield* absentHistory(hostRoot)).toBe(true);
      terminal.end();
      yield* running;
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
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 140 });

    yield* scoped(function* (): Operation<void> {
      const workspace = yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      const hostRoot = yield* useTemporaryHost();
      const running = yield* spawn(() => start(fake, held, workspace));
      yield* untilDrawn(terminal);
      yield* typed(terminal, THREE);

      // All three turns are scheduled at once, and each is held where its state
      // is decided. Deliberately not in the order the document wrote them: the
      // reviewer is observed first, the implementer second, and the planner has
      // not been taken at all — so the order these conversations appear in is
      // the order they were seen, and cannot be the authored `<Spawn>` order.
      yield* showing(terminal, "· queued");
      held.start(REVIEW_IT);
      held.deltas(REVIEW_IT);
      yield* showing(terminal, `${REVIEW_IT} · completed`);
      held.start(BUILD_IT);

      // One frame holding all three states, each named by what its own child
      // asked. Read together rather than in three waits: what this row is about
      // is a screen, not a sequence.
      yield* awaiting("the three states never stood together", function* () {
        yield* settled(10);
        const rows = screenOf(terminal);
        return [`${REVIEW_IT} · completed`, `${BUILD_IT} · streaming`, `${PLAN_IT} · queued`].every(
          (state) => rows.some((line) => line.includes(state)),
        );
      });
      yield* showing(terminal, "All conversations");

      // With the implementer's turn recorded too, a conversation control is
      // there to filter by while the planner has still not been taken.
      held.deltas(BUILD_IT);
      // The digest every session key of this run carries, which is how a row is
      // recognized as a conversation control on a sidebar too narrow for a key.
      const digest = (fake.turns[0]?.handle.sessionKey ?? "").split(":")[2] ?? "";
      expect(digest).not.toBe("");
      yield* awaiting("no conversation was ever offered", function* () {
        yield* settled(10);
        return conversationRows(terminal, digest).length > 0;
      });
      expect(shows(terminal, `${PLAN_IT} · queued`)).toBe(true);

      // Selecting one is the route's own business: it carries that
      // conversation's exact provider session key, and the entry column beside
      // it is untouched.
      const keys = [PLAN_IT, REVIEW_IT, BUILD_IT].map(
        (asked) => fake.turns.find((turn) => turn.text.includes(asked))?.handle.sessionKey ?? "",
      );
      const unfiltered = locationRow(terminal);
      const offered = conversationRows(terminal, digest).length;
      yield* click(terminal, conversationRows(terminal, digest)[0] ?? "");
      yield* settled(40);
      expect(keys).toContain(sessionOf(terminal));
      // One conversation's turns, and only its own.
      expect(childrenShown(terminal)).toHaveLength(1);
      // The route gained the session and nothing else: the surface, the entry
      // and the history position it was standing on are the same terms.
      expect(locationRow(terminal)).toBe(`${unfiltered}?session=${sessionOf(terminal)}`);
      // Its row, whatever it has settled to: what this asserts is that the
      // catalog holds the entry, not what became of it.
      expect(shows(terminal, "] entry-1")).toBe(true);
      const standing = locationRow(terminal);
      // Where the person is standing now: on the control they just chose.
      const focused = focusedRow(terminal);

      // Background work in another conversation: the planner's turn is taken,
      // streams and is recorded, while the route, the history position and the
      // focused control stay exactly where the person left them.
      held.start(PLAN_IT);
      held.deltas(PLAN_IT);
      yield* awaiting("the third turn was never retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });
      expect(locationRow(terminal)).toBe(standing);
      expect(focusedRow(terminal)).toBe(focused);
      // And the filter still holds: the others are retained and not shown,
      // because this screen is showing one.
      expect(childrenShown(terminal)).toHaveLength(1);

      // Cleared back to All, the whole chronology is there again — all three
      // children, each with the state its own turn ended in, and one more
      // conversation to filter by than before.
      yield* click(terminal, "All conversations");
      yield* settled(40);
      expect(locationRow(terminal)).not.toContain("session=");
      expect(childrenShown(terminal)).toEqual([PLAN_IT, REVIEW_IT, BUILD_IT]);
      for (const asked of [PLAN_IT, REVIEW_IT, BUILD_IT]) {
        expect([asked, shows(terminal, `${asked} · completed`)]).toEqual([asked, true]);
      }
      // And one more conversation to filter by than there was, because the
      // third one has now been seen.
      expect(conversationRows(terminal, digest).length).toBeGreaterThan(offered);

      // Three turns, three records, one per conversation.
      yield* awaiting("the three turns were never all retained", function* () {
        return (
          recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt").length === 3
        );
      });
      terminal.end();
      yield* running;
    });
  });
});

describe("X1 — how this command ends, with work still in flight", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * One run with a turn the provider has taken and never finishes, so every
   * ending below is induced while there is real work to join.
   */
  function* inFlight(
    terminal: Terminal,
    install: () => Operation<void>,
    fake: FakeAcp,
  ): Operation<{ readonly hostRoot: string; readonly ending: Ending }> {
    const workspace = yield* useWorkspace();
    yield* install();
    yield* immediateClock();
    const hostRoot = yield* useTemporaryHost();
    const ending = yield* commanding(fake, workspace);
    yield* untilDrawn(terminal);
    yield* typed(terminal, ASKING);
    // Taken by the backend and streaming nothing: the turn is in flight, and
    // the only way out of it is the ending this row induces.
    yield* showing(terminal, "· streaming");
    return { hostRoot, ending };
  }

  /** What one ending left behind. */
  function* ended(
    terminal: Terminal,
    hostRoot: string,
    ending: Ending,
  ): Operation<{ readonly before: string[]; readonly after: string[] }> {
    void terminal;
    const before = recorded(yield* journal(hostRoot));
    yield* until(() => ending.over, "the command never ended");
    // Read after the owner has joined: what a run appends late is exactly what
    // this cannot show while it is still going.
    yield* settled(40);
    return { before, after: recorded(yield* journal(hostRoot)) };
  }

  it("X1: EOF ends the command, joins the turn and appends nothing late", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: PARTIAL, manual: true });
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 60 });

    yield* scoped(function* (): Operation<void> {
      const { hostRoot, ending } = yield* inFlight(terminal, install, fake);
      terminal.end();
      const { before, after } = yield* ended(terminal, hostRoot, ending);

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
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 60 });

    yield* scoped(function* (): Operation<void> {
      const { hostRoot, ending } = yield* inFlight(terminal, install, fake);
      // The screen is gone. A frame cannot be presented, which is not a reason
      // to keep running and not a reason to append anything.
      terminal.failWrites(new Error("the screen is gone"));
      terminal.feed("\t");
      const { before, after } = yield* ended(terminal, hostRoot, ending);

      expect(after).toEqual(before);
      expect(after.filter((kind) => kind === "agent_prompt")).toEqual([]);
      expect(terminal.raw).toEqual([true, false]);
      expect(terminal.resets).toBe(1);
    });
  });

  it("X1: a terminal that fails mid-read ends the command the same way", function* () {
    const fake = createFakeAcp();
    fake.script({ reply: PARTIAL, manual: true });
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 60 });

    yield* scoped(function* (): Operation<void> {
      const { hostRoot, ending } = yield* inFlight(terminal, install, fake);
      terminal.failInput(new Error("the terminal is gone"));
      const { before, after } = yield* ended(terminal, hostRoot, ending);

      expect(after).toEqual(before);
      expect(terminal.raw).toEqual([true, false]);
      expect(terminal.resets).toBe(1);
    });
  });

  it("X1: cancelling the command joins the pending request without answering it", function* () {
    const fake = createFakeAcp();
    // A turn that asks for a tool this policy does not approve by itself, so a
    // request is waiting on a person when the command is cancelled.
    fake.script({ reply: PARTIAL, requestsTool: "rm -rf /", manual: true });
    const { terminal, install } = recordingTerminal({ columns: 200, rows: 60 });

    yield* scoped(function* (): Operation<void> {
      const workspace = yield* useWorkspace();
      yield* install();
      yield* immediateClock();
      const hostRoot = yield* useTemporaryHost();
      const ending = yield* commanding(fake, workspace);
      yield* untilDrawn(terminal);
      yield* typed(terminal, ASKING);
      // A person is being asked. Nothing has answered it.
      yield* showing(terminal, "rm -rf /");
      const before = recorded(yield* journal(hostRoot));

      // The command scope is cancelled — the process is going away. This is not
      // a denial: nobody decided anything, and a teardown that answered on the
      // person's behalf would be recording a decision they never made.
      yield* ending.task.halt();
      yield* until(() => ending.over, "the command never ended");
      yield* settled(40);

      expect(fake.decisions).toEqual([]);
      expect(recorded(yield* journal(hostRoot))).toEqual(before);
      expect(recorded(yield* journal(hostRoot)).filter((kind) => kind === "agent_prompt")).toEqual(
        [],
      );
      // And the terminal is given back, once.
      expect(terminal.raw).toEqual([true, false]);
      expect(terminal.resets).toBe(1);
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
  terminal: Terminal,
  fake: FakeAcp,
  hostRoot: string,
  workspace: string,
): Operation<void> {
  terminal.bytes(BYTES.encode(STORY));
  yield* settled(20);
  terminal.feed("\r");
  yield* showing(terminal, "Request changes");
  yield* click(terminal, "( ) Request changes");
  yield* settled(40);
  yield* click(terminal, "feedback:");
  terminal.bytes(BYTES.encode(FEEDBACK));
  yield* settled(20);
  yield* click(terminal, "[submit]");
  yield* until(() => fake.prompts.length >= 2, "the revision was never asked for");
  yield* showing(terminal, "Approve");
  yield* click(terminal, "( ) Approve");
  yield* showing(terminal, "Name the project");
  yield* answer(terminal, "Project name", "Ledger");
  yield* answer(terminal, "One-sentence description", "A tiny ledger.");
  yield* submit(terminal);
  yield* showing(terminal, "Write this README?");
  yield* click(terminal, "( ) Approve");
  yield* showing(terminal, "Created README.md.");
  yield* awaiting("the entry never settled", function* () {
    return (yield* journal(hostRoot)).some((event) => event.type === "close");
  });
  expect(yield* untilResolved(readdir(workspace))).toEqual(["README.md"]);
}

/** The profile this command would assemble, over a provider nothing scripts. */
function* settledProfile(fake: FakeAcp): Operation<ReplExecutionProfile> {
  const stack = yield* resolveAgentStack(
    {
      agentProvider: "acpx",
      defaultAgent: AGENT,
      approveAll: false,
      approveReads: false,
      denyAll: false,
    },
    undefined,
  );
  if (!stack.ok) {
    throw stack.error;
  }
  return yield* assembleReplProfile(stack.value, NO_PLUGINS, {
    acp: {
      createRuntime: fake.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
    },
    planWriterRoot: yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-plan-"))),
  });
}

/** Whether this host holds no REPL history at all. */
function* absentHistory(hostRoot: string): Operation<boolean> {
  const found = yield* untilResolved(
    readdir(join(hostRoot, "xmd", "repl")).catch(() => [] as string[]),
  );
  return found.length === 0;
}

/** The one history file this host holds, as text. */
function* history(hostRoot: string): Operation<string> {
  const directory = join(hostRoot, "xmd", "repl");
  const files = yield* untilResolved(readdir(directory));
  return yield* untilResolved(readFile(join(directory, files[0] ?? ""), "utf8"));
}

/**
 * One running command, and whether it is over.
 *
 * A flag rather than the task's own state, because what every ending row asks is
 * the same question — has the owner joined? — and a task that ended by failing
 * answers it as much as one that returned.
 */
interface Ending {
  readonly task: Task<void>;
  readonly over: boolean;
}

function* commanding(fake: FakeAcp, workspace: string): Operation<Ending> {
  const ending = { task: undefined as unknown as Task<void>, over: false };
  const task = yield* spawn(function* (): Operation<void> {
    try {
      yield* start(fake, holds([]), workspace);
    } catch {
      // The ending is what the row is about; how it was reported is the row's
      // own business and not this helper's.
    } finally {
      ending.over = true;
    }
  });
  ending.task = task;
  return ending;
}

/** Start the program the way the command does, with the profile it assembles. */
function* start(
  fake: FakeAcp,
  held: Holds,
  workspace: string,
  location?: string,
): Operation<string> {
  const writerRoot = yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-plan-")));
  const profile = yield* assembleReplProfile(
    {
      provider: "acpx",
      defaultAgent: AGENT,
      adapters: ADAPTERS,
      permissionMode: "approve-reads",
    },
    NO_PLUGINS,
    {
      acp: {
        createRuntime: held.create(fake),
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({ [AGENT]: `${AGENT}-cmd` }),
      },
      planWriterRoot: writerRoot,
    },
  );
  const ran = yield* runReplProgram({
    profile,
    ...(location === undefined ? {} : { location }),
  });
  if (!ran.ok) {
    throw ran.error;
  }
  void workspace;
  return ran.value.location;
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
                let first = true;
                return {
                  next() {
                    if (!first) {
                      return events.next();
                    }
                    first = false;
                    return hold.deltas.opened.then(() => events.next());
                  },
                  return: () =>
                    events.return?.() ?? Promise.resolve({ done: true as const, value: undefined }),
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
  const directory = join(hostRoot, "xmd", "repl");
  const files = yield* untilResolved(readdir(directory));
  const text = yield* untilResolved(readFile(join(directory, files[0] ?? ""), "utf8"));
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
    named: named.map(({ name, form }) => ({ name, form })),
  };
}

const BYTES = new TextEncoder();
const DEADLOCK_MS = 30_000;
const TEXT = new TextDecoder();

/** Let every task that is ready take its turn. */
function* settled(turns = 8): Operation<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    yield* sleep(0);
  }
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

/** Wait for something this run will do that only an operation can read. */
function* awaiting(what: string, reached: () => Operation<boolean>): Operation<void> {
  const deadline = Date.now() + DEADLOCK_MS;
  while (!(yield* reached())) {
    if (Date.now() > deadline) {
      throw new Error(what);
    }
    yield* sleep(5);
    yield* settled(10);
  }
}

/** Wait for something this run will do, or say what never happened. */
function* until(holds: () => boolean, what: string): Operation<void> {
  const deadline = Date.now() + DEADLOCK_MS;
  while (!holds()) {
    if (Date.now() > deadline) {
      throw new Error(what);
    }
    yield* sleep(5);
    yield* settled(10);
  }
}

/** A terminal the test drives completely. */
interface Terminal {
  /** Everything ever presented, in order. */
  readonly presented: Uint8Array[];
  /**
   * When set, the next presentation blocks here until it is released.
   *
   * The seam the frame-order control needs: while a frame is being written, the
   * stream must not have been told that frame was applied.
   */
  holdPresent: { release(): void } | undefined;
  size: ReplTerminalSize;
  readonly raw: boolean[];
  resets: number;
  listeners: number;
  readers: number;
  feed(text: string): void;
  bytes(raw: Uint8Array): void;
  /** Make the next presentation block, so a test can look at the frame stream. */
  holdNextPresent(): void;
  /** Make every later presentation fail, which is how a renderer is lost. */
  failWrites(error: Error): void;
  /** Make the byte source fail, which is how a terminal is lost. */
  failInput(error: Error): void;
  resized(size: ReplTerminalSize): void;
  end(): void;
}

function recordingTerminal(
  size: ReplTerminalSize = { columns: 160, rows: 36 },
  interactive = true,
): {
  terminal: Terminal;
  install(): Operation<void>;
} {
  const queue: Uint8Array[] = [];
  const watchers = new Set<() => void>();
  let waiting: ((result: IteratorResult<Uint8Array, undefined>) => void) | undefined;
  let ended = false;

  let holding = false;
  let writeFailure: Error | undefined;
  let inputFailure: Error | undefined;
  const terminal: Terminal = {
    presented: [],
    holdPresent: undefined,
    size,
    raw: [],
    resets: 0,
    listeners: 0,
    readers: 0,
    feed(text: string): void {
      terminal.bytes(BYTES.encode(text));
    },
    failWrites(error: Error): void {
      writeFailure = error;
    },
    failInput(error: Error): void {
      inputFailure = error;
      const resolve = waiting;
      waiting = undefined;
      resolve?.({ done: true, value: undefined });
    },
    holdNextPresent(): void {
      holding = true;
    },
    bytes(raw: Uint8Array): void {
      const resolve = waiting;
      if (resolve === undefined) {
        queue.push(raw);
        return;
      }
      waiting = undefined;
      resolve({ done: false, value: raw });
    },
    resized(next: ReplTerminalSize): void {
      terminal.size = next;
      for (const watcher of watchers) {
        watcher();
      }
    },
    end(): void {
      ended = true;
      const resolve = waiting;
      if (resolve !== undefined) {
        waiting = undefined;
        resolve({ done: true, value: undefined });
      }
    },
  };

  const host: ReplTerminalCapabilities = {
    interactive: () => interactive,
    size: () => terminal.size,
    write(bytes: Uint8Array): Promise<void> {
      if (writeFailure !== undefined) {
        return Promise.reject(writeFailure);
      }
      terminal.presented.push(new Uint8Array(bytes));
      if (!holding) {
        return Promise.resolve();
      }
      holding = false;
      return new Promise<void>((resolve) => {
        terminal.holdPresent = { release: resolve };
      });
    },
    writeNow(): void {
      terminal.resets += 1;
    },
    setRaw(raw: boolean): void {
      terminal.raw.push(raw);
    },
    bytes(): AsyncIterable<Uint8Array> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array, undefined> {
          terminal.readers += 1;
          return {
            next(): Promise<IteratorResult<Uint8Array, undefined>> {
              if (inputFailure !== undefined) {
                return Promise.reject(inputFailure);
              }
              const head = queue.shift();
              if (head !== undefined) {
                return Promise.resolve({ done: false, value: head });
              }
              if (ended) {
                return Promise.resolve({ done: true, value: undefined });
              }
              return new Promise((resolve) => {
                waiting = resolve;
              });
            },
            return(): Promise<IteratorResult<Uint8Array, undefined>> {
              terminal.readers -= 1;
              const resolve = waiting;
              waiting = undefined;
              resolve?.({ done: true, value: undefined });
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
    },
    onResize(listener: () => void): () => void {
      watchers.add(listener);
      terminal.listeners += 1;
      return () => {
        watchers.delete(listener);
        terminal.listeners -= 1;
      };
    },
  };

  return { terminal, install: () => installReplTerminal(host) };
}

/**
 * A REPL host over a temporary directory nothing else uses.
 *
 * The root can be handed back in, which is what a cold row needs: a second
 * command scope over the same history file is the only way to prove a screen
 * was reconstructed from the Journal rather than from anything this process
 * still held.
 */
function* useTemporaryHost(existing?: string): Operation<string> {
  const root = existing ?? (yield* untilResolved(mkdtemp(join(tmpdir(), "xmd-repl-journey-"))));
  yield* installReplHost({
    dataRoot: () => root,
    identify: () => randomBytes(8).toString("hex"),
    createExclusive: (path) => open(path, "wx").then((handle) => handle.close()),
    appendRecord: (path, record) => appendFile(path, record),
  });
  return root;
}

/**
 * What the screen says, by replaying what was written to it.
 *
 * A real buffer rather than the bytes with escapes stripped, because this
 * renderer writes *diffs*: it moves the cursor to what changed and writes only
 * that. Concatenating the diffs gives characters in the order they were written
 * rather than the order they appear, and a character the previous frame already
 * had is not written again at all.
 */
function screenOf(terminal: Terminal): string[] {
  const rows: string[][] = [];
  let row = 0;
  let column = 0;

  const put = (character: string): void => {
    while (rows.length <= row) {
      rows.push([]);
    }
    const line = rows[row]!;
    while (line.length < column) {
      line.push(" ");
    }
    line[column] = character;
    column += 1;
  };

  const written = terminal.presented.map((bytes) => TEXT.decode(bytes)).join("");
  for (let index = 0; index < written.length; index += 1) {
    const character = written[index];
    if (character !== "\u001B") {
      if (character === "\n") {
        row += 1;
        column = 0;
      } else if (character === "\r") {
        column = 0;
      } else if (character !== undefined) {
        put(character);
      }
      continue;
    }
    const csi = /^\u001B\[([0-9;]*)([@-~])/.exec(written.slice(index));
    if (csi !== null) {
      const parameters = (csi[1] ?? "").split(";").map((one) => (one === "" ? 0 : Number(one)));
      if (csi[2] === "H") {
        row = Math.max(0, (parameters[0] ?? 1) - 1);
        column = Math.max(0, (parameters[1] ?? 1) - 1);
      } else if (csi[2] === "J") {
        rows.length = 0;
        row = 0;
        column = 0;
      }
      index += csi[0].length - 1;
      continue;
    }
    const osc = /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/.exec(written.slice(index));
    if (osc !== null) {
      index += osc[0].length - 1;
      continue;
    }
    index += 1;
  }
  return rows.map((line) => line.join(""));
}

/** The canonical location the screen is showing, if it has drawn one yet. */
function maybeLocation(terminal: Terminal): string | undefined {
  const rows = screenOf(terminal);
  const first = rows.findIndex((line) => line.includes("xmd://repl/"));
  if (first === -1) {
    return undefined;
  }
  const at = (rows[first] ?? "").indexOf("xmd://repl/");
  const parts: string[] = [];
  for (let row = first; row < rows.length && row < first + 24; row += 1) {
    const part = (rows[row] ?? "").slice(at, at + surfaceWidth(terminal.size));
    if (part.trim().length === 0) {
      break;
    }
    parts.push(part.trimEnd());
    // Every row of a location is padded to the full surface width, so a row
    // with space left on its end is the last of them. Without this the row
    // drawn underneath joins on, and the round-trip below cannot always tell:
    // a location ending in `/entry-2` followed by a transcript row beginning
    // `entry ...` re-encodes as `/entry-2entry` exactly as written.
    if (part.trimEnd().length < part.length) {
      break;
    }
  }

  const joined = parts.join("");
  for (let length = joined.length; length > "xmd://repl/".length; length -= 1) {
    const candidate = joined.slice(0, length);
    const decoded = decodeLocation(candidate);
    if (decoded.ok && encodeLocation(decoded.value) === candidate) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * How many columns the Sessions sidebar owns.
 *
 * Read here so a row comparing "the entry column did not move" compares the
 * band beside the sidebar rather than a number somebody guessed.
 */
const SIDEBAR = 30;

/** The conversation this screen is filtered by, as the route states it. */
function sessionOf(terminal: Terminal): string | undefined {
  return /session=([^&\s]+)/.exec(locationRow(terminal) ?? "")?.[1];
}

/**
 * The one row the location is drawn on.
 *
 * Read as a row rather than reassembled across rows, because the surface column
 * has other columns beside it: a location short enough to fit on one line is
 * exactly that line, and joining the line below it would append whatever the
 * next column happened to hold there.
 */
function locationRow(terminal: Terminal): string | undefined {
  const row = screenOf(terminal).find((line) => line.includes("xmd://repl/"));
  return row === undefined ? undefined : row.slice(row.indexOf("xmd://repl/")).trimEnd();
}

/**
 * The conversation rows the Sessions surface offers to filter by, in order.
 *
 * Found by a digest every one of this run's session keys carries, because the
 * row is the key and the sidebar is narrower than one: the selected row also has
 * the focus marker written over its first character, so matching the spelling of
 * the key's own prefix would find every row except the one a person chose.
 */
function conversationRows(terminal: Terminal, digest: string): string[] {
  return screenOf(terminal)
    .map((line) => line.slice(0, SIDEBAR).trimEnd())
    .filter((line) => line.includes(digest))
    .map((line) => line.trim());
}

/** The positions the open History drawer offers, in order. */
function historyMarkers(terminal: Terminal): string[] {
  const rows = screenOf(terminal).map((line) => line.trimEnd());
  const at = rows.findIndex((line) => line.trim().endsWith("History"));
  if (at === -1) {
    return [];
  }
  const found: string[] = [];
  for (let row = at + 1; row < rows.length; row += 1) {
    const label = (rows[row] ?? "").trim().replace(/^>\s*/, "");
    if (label.length === 0 || label.startsWith("[")) {
      break;
    }
    found.push(label);
  }
  return found;
}

/** Which of the three children's turns this screen is showing, in source order. */
function childrenShown(terminal: Terminal): string[] {
  return [PLAN_IT, REVIEW_IT, BUILD_IT].filter((asked) => shows(terminal, `${asked} ·`));
}

/**
 * How many rows of the screen hold this text.
 *
 * A count rather than a yes-or-no, because the admitted program's own source is
 * on this screen too: the Plan's scope retains it, so a line the program will
 * render later is already visible as the source it came from. What says the
 * program *ran* that line is a second row holding it.
 */
function occurrences(terminal: Terminal, text: string): number {
  return screenOf(terminal).filter((line) => line.includes(text)).length;
}

/** Every row of the screen holding this text, trimmed, in order. */
function shown(terminal: Terminal, text: string): string[] {
  return screenOf(terminal)
    .map((line) => line.trimEnd())
    .filter((line) => line.includes(text))
    .map((line) => line.trim());
}

/** One column band of the screen, which is how a row says "this did not move". */
function column(terminal: Terminal, from: number): string[] {
  return screenOf(terminal).map((line) => line.slice(from).trimEnd());
}

/**
 * The row the focus marker is on, in the sidebar band alone.
 *
 * The band, because the columns beside it hold a journal that grows: a row read
 * across the whole screen would differ between two frames for a reason that has
 * nothing to do with where the focus is.
 */
function focusedRow(terminal: Terminal): string | undefined {
  return screenOf(terminal)
    .map((line) => line.slice(0, SIDEBAR).trimEnd())
    .find((line) => line.trimStart().startsWith(">"));
}

/** Whether any row of the screen contains this text. */
function shows(terminal: Terminal, expected: string): boolean {
  return screenOf(terminal).some((line) => line.includes(expected));
}

/** Wait until the first frame has been drawn. */
function* untilDrawn(terminal: Terminal): Operation<void> {
  yield* until(
    () => maybeLocation(terminal) !== undefined,
    "the screen never drew its first frame",
  );
}

/** Wait until the screen shows this text, or say it never did. */
function* showing(terminal: Terminal, expected: string): Operation<void> {
  yield* until(() => shows(terminal, expected), `the screen never showed ${expected}`);
}

/** Where on the screen one label is, if it is there. */
function coordinateOf(
  terminal: Terminal,
  label: string,
): { readonly column: number; readonly row: number } | undefined {
  for (const [row, line] of screenOf(terminal).entries()) {
    const column = line.indexOf(label);
    if (column !== -1) {
      return { column, row };
    }
  }
  return undefined;
}

/**
 * Click one control, by finding it on the screen and pressing there.
 *
 * The way a person reaches a control without traversing to it: activating by
 * pointer needs no focus, so it can reach a control while an execution is still
 * moving. The protocol counts from one and the screen counts from zero.
 */
function* click(terminal: Terminal, label: string): Operation<void> {
  const at = coordinateOf(terminal, label);
  if (at === undefined) {
    throw new Error(`no control labelled ${label} is on the screen`);
  }
  terminal.feed(`\x1b[<0;${at.column + 1};${at.row + 1}M`);
  yield* settled(30);
}

/**
 * Type one whole entry and submit it.
 *
 * The draft is waited for rather than counted: a page-long entry arrives as many
 * decoded keys, and Enter means "submit this draft" only once the draft is all
 * of it. What says it has settled is the route, which carries the draft.
 */
function* typed(terminal: Terminal, text: string): Operation<void> {
  terminal.bytes(BYTES.encode(text));
  const deadline = Date.now() + DEADLOCK_MS;
  let last = "";
  let still = 0;
  while (still < 3) {
    const now = maybeLocation(terminal) ?? "";
    if (now === last && now.includes("draft=")) {
      still += 1;
    } else {
      still = 0;
      last = now;
    }
    if (Date.now() > deadline) {
      throw new Error("the draft never settled");
    }
    yield* sleep(20);
    yield* settled(10);
  }
  terminal.feed("\r");
  yield* sleep(200);
  yield* settled(20);
  // The draft leaving the location is what says the entry exists. It used to be
  // the footer notice that replaced the draft once one did; a draft is now
  // execution-wide and survives admission as the *next* entry's text (#827
  // Slice C), so what clears is the one this helper just typed — and it clears
  // only when it has become an entry.
  yield* until(
    () => !(maybeLocation(terminal) ?? "draft=").includes("draft="),
    "the draft never became an entry",
  );
}

/**
 * The Sessions rows this run's two Prompts are drawn on, as the sidebar draws
 * them.
 *
 * Sliced to the sidebar's own width, because that is what a reader sees: the
 * column is narrower than a turn's whole line, so what is on the screen is the
 * prefix of it that fits. Compared rather than interpreted — two readings of
 * one journal have to draw the same rows.
 */
function promptRows(terminal: Terminal): string[] {
  return screenOf(terminal)
    .map((line) => line.slice(0, SIDEBAR).trimEnd())
    .filter((line) => line.includes("ask-"));
}

/** One entry holding one Prompt, so every entry records sequence `0`. */
function promptEntry(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}

/**
 * Put focus on the entry draft.
 *
 * There is no label to aim at: the draft is empty once its text has become an
 * entry, and what it draws is its own prompt. So the marker and the prompt
 * together are what name it — a focused field renders its marker immediately
 * before its prompt, and the draft's prompt is the only one that is itself a
 * marker.
 */
function* focusDraft(terminal: Terminal): Operation<void> {
  for (let press = 0; press <= 240; press += 1) {
    if (screenOf(terminal).some((line) => line.includes(">> "))) {
      return;
    }
    terminal.feed("\t");
    yield* settled(12);
  }
  throw new Error("focus never reached the entry draft in 240 presses");
}

/** Type a value into the field this label names. */
function* answer(terminal: Terminal, label: string, value: string): Operation<void> {
  yield* click(terminal, label);
  terminal.bytes(BYTES.encode(value));
  yield* settled(20);
}

/** Submit the open form. */
function* submit(terminal: Terminal): Operation<void> {
  yield* click(terminal, "[submit]");
  yield* settled(40);
}
