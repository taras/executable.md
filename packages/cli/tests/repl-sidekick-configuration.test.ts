/**
 * Tier R7 — what a Sidekick runs under, and who decides it (#883, J9).
 *
 * Three decisions, and they are made in three different places. Which *agent*
 * answers is a conversation's own, settled when it is opened and never changed
 * in place — so changing it starts another conversation and keeps the chat a
 * person has read. Which *model and effort* it runs under is a request this
 * history holds and the next turn puts into effect, because an agent can only
 * be asked for a configuration on a turn. And what a person may choose between
 * is the agent's own answer, read by asking it and nothing else: no list in
 * this repository says what a model is called.
 *
 * So these rows drive the owner the way the Configure drawer will, and the
 * drawer itself is section 5's — as are the `--sidekick-agent` spelling, the
 * bounded form the choices are presented in, and the busy change that stops
 * first. What is here is the half that holds: an inspection that costs no turn,
 * a configuration that is applied and verified where it can be, a refusal that
 * leaves a person where they were, and an agent change that replaces an
 * association rather than a conversation's agent.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, scoped, sleep, spawn } from "effection";
import type { Operation, Result, Task } from "effection";

import { DEFAULT_AGENT_NAME } from "@executablemd/acp";
import { API } from "@executablemd/runtime";

import { resolveAgentStack } from "../src/agent-stack.ts";
import { assembleReplProfile } from "../src/repl-profile.ts";
import type { ReplExecutionProfile } from "../src/repl-profile.ts";
import { NO_PLUGINS } from "../src/plugin-host.ts";

import { rootReads } from "../src/repl/sidekick/requests.ts";
import { useSidekickOwner } from "../src/repl/sidekick/owner.ts";
import type { SidekickOwner, SidekickTurn } from "../src/repl/sidekick/owner.ts";
import type { SubmitReceipt } from "../src/repl/sidekick/controls.ts";
import type { PairedChatStorage } from "../src/repl/sidekick/repository.ts";
import { createFakeAcp, makeRegistry, makeStore } from "./support/fake-acp.ts";
import {
  appendGate,
  awaited,
  awaitedFact,
  MOUNTED_AGENT,
  OTHER_MOUNTED_AGENT,
} from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";
import type { MountedRepl } from "./support/mounted-repl.ts";
import { useReplPage } from "./support/repl-page.ts";
import type { ReplPage, ScreenReading } from "./support/repl-page.ts";
import {
  applyConfigure,
  agentName,
  chooseOffered,
  clearAgentField,
  retypeAgent,
  chosen,
  composerHolds,
  COMPOSER,
  draftHolds,
  closeConfigure,
  drawerGone,
  besideDrawer,
  drawerLines,
  drawerShows,
  draftText,
  entrySettles,
  intoComposer,
  offered,
  offeredChoice,
  openConfigure,
  pasteDraft,
  replaceAgent,
  saidByPerson,
  saidBySidekick,
  scrollDrawerTo,
  selectPane,
  sendMessage,
  SIDEKICK_CONTROLS,
  sidekickIdle,
  stopSidekick,
  tab,
  typed,
} from "./support/screen-journeys.ts";

/** The names the provider advertises for the ids these rows choose by. */
const NAMED: Readonly<Record<string, string>> = Object.freeze({
  balanced: "Balanced",
  fast: "Fast",
  medium: "Medium",
  high: "High",
  low: "Low",
});
import {
  PAIRED_DIRECTORY,
  readSidekickRecords,
  SIDEKICK_FILE,
} from "../src/repl/sidekick/history.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "effection";

/**
 * Choose the offer these rows name by its id, through the label it is drawn as.
 *
 * The screen offers a provider's own names; the ids below are what the records
 * and the provider's own configuration call them, so this is the one place
 * that turns one into the other.
 */
function chooseNamed(page: ReplPage, id: string): Operation<void> {
  return chooseOffered(page, NAMED[id] ?? id);
}

/** The preference this execution's chat last holds, or none. */
function* savedPreference(repl: MountedRepl): Operation<Record<string, unknown> | undefined> {
  const [execution] = yield* published(repl.root);
  if (execution === undefined) {
    return undefined;
  }
  const records = yield* readSidekickRecords(
    join(repl.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE),
  );
  let held: Record<string, unknown> | undefined;
  for (const record of records) {
    if (record.kind === "preferences") {
      held = { model: record.model, effort: record.effort };
    }
  }
  return held;
}

/** Every record kind this execution's chat holds, in order. */
function* chatKinds(repl: MountedRepl): Operation<string[]> {
  const [execution] = yield* published(repl.root);
  if (execution === undefined) {
    return [];
  }
  const records = yield* readSidekickRecords(
    join(repl.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE),
  );
  return records.map((record) => record.kind);
}

/** The executions that have a published pair, or none at all. */
function* published(root: string): Operation<string[]> {
  try {
    return (yield* until(readdir(join(root, PAIRED_DIRECTORY)))).sort();
  } catch {
    return [];
  }
}
import type { ScriptedConfiguration } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { createRepositoryRoot, runPhase } from "./fixtures/repl/issue-883/host.ts";
import { AGENT, useHarness, useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";

/** A second agent, named explicitly rather than defaulted to. */
const OTHER = "other-sidekick";

/**
 * What the scripted agent advertises.
 *
 * Grouped, described and named unevenly on purpose: a choice the agent filed
 * under a heading, one it offered directly, and one it said nothing more about
 * are three different things a drawer has to be able to show, and flattening
 * them is what reading the provider's own vocabulary is supposed to prevent.
 */
const OFFERED: ScriptedConfiguration = {
  model: {
    selected: "balanced",
    choices: [
      { id: "balanced", name: "Balanced", description: "Even-handed." },
      { id: "fast", name: "Fast", group: { id: "speed", name: "Speed" } },
      { id: "thorough", name: "Thorough", group: { id: "speed", name: "Speed" } },
    ],
  },
  // Each model's own levels, which is the whole reason effort travels with a
  // model: the two lists have nothing in common.
  effort: {
    balanced: {
      selected: "medium",
      choices: [
        { id: "medium", name: "Medium" },
        { id: "deep", name: "Deep" },
      ],
    },
    fast: {
      selected: "low",
      choices: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    },
    thorough: { selected: "deep", choices: [{ id: "deep", name: "Deep" }] },
  },
};

/** One message, sent in a task of its own so a case can act while it runs. */
function sending(held: Harness, text: string): Operation<Task<Result<SidekickTurn>>> {
  return spawn(() => held.owner.message(text));
}

/**
 * The sessions this agent was asked to establish for an inspection.
 *
 * Told apart by the provider's own key, which is how it keeps an inspection out
 * of a conversation: a session a document could also have produced would make
 * reading what an agent offers the session a conversation is holding.
 */
function inspections(fake: FakeAcp): readonly string[] {
  return fake.ensured.map((one) => one.sessionKey).filter((key) => key.startsWith("xmd:inspect:"));
}

/** The sessions established for a conversation's own turns. */
function conversations(fake: FakeAcp): readonly string[] {
  return fake.ensured.map((one) => one.sessionKey).filter((key) => !key.startsWith("xmd:inspect:"));
}

/** Every configuration a turn actually wrote, reads left out. */
function applied(fake: FakeAcp): readonly string[] {
  return fake.configCalls.filter((call) => call.startsWith("set "));
}

/** This history as it stands, raised rather than answered when it cannot be read. */
function reading(owner: SidekickOwner) {
  const held = owner.reading;
  if (!held.ok) {
    throw held.error;
  }
  return held.value;
}

/**
 * The same execution, reopened by a process that chose a different agent.
 *
 * Which is the case that matters: a command line has its own default, and a
 * conversation already has an agent. One of them is a selection a person made.
 */
function* reopen(held: Harness, agent: string): Operation<SidekickOwner> {
  const cold = yield* held.repository.open(held.execution.id);
  const chat = cold.chat as PairedChatStorage;
  return yield* useSidekickOwner({
    // The production assembly, with this process's own agent selection: what
    // the row is about is which agent a reopening continues under, so only the
    // selection differs between the two processes.
    assembly: { ...held.profile.sidekickAssembly, agent },
    chat,
    // deno-lint-ignore require-yield
    *establish(): Operation<Result<PairedChatStorage>> {
      return Ok(chat);
    },
    root: {
      ...rootReads(held.session, held.profile),
      // deno-lint-ignore require-yield
      *fill(): Operation<Result<void>> {
        throw new Error("these rows fill no draft");
      },
    },
    // deno-lint-ignore require-yield
    *submit(): Operation<Result<SubmitReceipt>> {
      throw new Error("these rows submit nothing");
    },
    revision: () => 0,
    // deno-lint-ignore require-yield
    *acknowledge(): Operation<void> {
      // These rows hold their own state directly rather than through the
      // screen's loop, so a saved message needs nothing applied for it.
    },
    draft: () => "",
  });
}

/**
 * One command's profile, assembled the way the command assembles it.
 *
 * The production resolution and the production assembly, in one call, over a
 * contextual environment this row states: what is under test is which name a
 * command ends up carrying, so a helper that answered it separately from the
 * assembly would be answering a question the command does not ask.
 */
function* assembled(options: {
  readonly entry?: string;
  readonly sidekick?: string;
  readonly context?: string;
}): Operation<{ readonly profile: ReplExecutionProfile; readonly asked: readonly string[] }> {
  const fake = createFakeAcp();
  return yield* scoped(function* () {
    yield* API.Env.around({
      *env([name], next) {
        // The contextual environment this row states, and the real one for
        // everything else: a name nothing here sets is still the host's.
        if (name === "DEFAULT_AGENT_NAME") {
          return options.context;
        }
        return yield* next(name);
      },
    });
    const stack = yield* resolveAgentStack(
      {
        agentProvider: "acpx",
        defaultAgent: options.entry,
        approveAll: false,
        approveReads: false,
        denyAll: false,
      },
      undefined,
    );
    if (!stack.ok) {
      throw stack.error;
    }
    const profile = yield* (yield* assembleReplProfile(stack.value, NO_PLUGINS, {
      ...(options.sidekick === undefined ? {} : { sidekickAgent: options.sidekick }),
      acp: {
        createRuntime: fake.create,
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({}),
      },
      planWriterRoot: yield* useTemporary("xmd-sidekick-selection-"),
    })).finalize();
    return { profile, asked: fake.ensured.map((one) => one.agent) };
  });
}

describe("Tier R7 — the configuration a Sidekick conversation runs under", () => {
  it("R7: the Sidekick's agent is this command's own selection, settled with the profile", function* () {
    // The flag, against an entry default that is something else entirely. Both
    // selections are made on one line and neither is the other's fallback.
    const explicit = yield* assembled({
      entry: "entry-default",
      sidekick: OTHER,
      context: "context-agent",
    });
    expect(explicit.profile.sidekickAgent).toBe(OTHER);
    expect(explicit.profile.includes).toEqual([
      join(explicit.profile.projectCwd!, "components"),
      explicit.profile.projectCwd,
    ]);

    // Without the flag the context wins — and `--default-agent` still does not,
    // which is the whole point of the two being independent: a person who chose
    // an agent for the Sessions their entries open has not chosen who they talk
    // to about them.
    const contextual = yield* assembled({ entry: "entry-default", context: "context-agent" });
    expect(contextual.profile.sidekickAgent).toBe("context-agent");

    // With neither, this build's own default, read from the package rather than
    // from a name written down here.
    const defaulted = yield* assembled({ entry: "entry-default" });
    expect(defaulted.profile.sidekickAgent).toBe(DEFAULT_AGENT_NAME);

    // And none of the three asked an agent anything. Assembling a profile
    // settles a name; whether anybody answers to it is the first explicit
    // message's question, asked where there is somebody to answer it.
    expect([explicit.asked, contextual.asked, defaulted.asked]).toEqual([[], [], []]);
  });

  it("R7: reading what an agent offers costs no turn and keeps the provider's own words", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);

    const read = yield* held.owner.options();
    if (!read.ok) {
      throw read.error;
    }

    expect(read.value.agent).toBe(AGENT);
    // Exactly what the agent said, in the order it said it: the ids a
    // configuration names, the labels it calls them, the description it
    // supplied for one of them, and the heading it filed two of them under.
    expect(read.value.model).toEqual({
      selected: "balanced",
      options: [
        { id: "balanced", name: "Balanced", description: "Even-handed.", group: null },
        { id: "fast", name: "Fast", description: null, group: { id: "speed", name: "Speed" } },
        {
          id: "thorough",
          name: "Thorough",
          description: null,
          group: { id: "speed", name: "Speed" },
        },
      ],
    });
    // The selected model's levels, not every level this agent has.
    expect(read.value.effort).toEqual({
      selected: "medium",
      options: [
        { id: "medium", name: "Medium", description: null, group: null },
        { id: "deep", name: "Deep", description: null, group: null },
      ],
    });

    // No prompt, and no turn: the agent was asked what it offers and nothing
    // else. A conversation that had been prompted would hold a canonical turn
    // and a person's message, and this one holds neither.
    expect(held.fake.prompts).toHaveLength(0);
    expect(reading(held.owner).chat).toEqual([]);
    expect(reading(held.owner).conversations[0]?.attempted).toEqual([]);

    // Through a session of its own, which the provider gives up again. The
    // conversation this Sidekick would talk in has never been established.
    expect(inspections(held.fake)).toHaveLength(1);
    expect(conversations(held.fake)).toEqual([]);
  });

  it("R7: a setting an agent does not offer is nothing, which is not an empty list", function* () {
    const held = yield* useHarness();
    // A model choice and no levels at all, which some agents are.
    held.fake.configuration({
      model: { selected: "only", choices: [{ id: "only", name: "The only one" }] },
    });

    const partial = yield* held.owner.options();
    if (!partial.ok) {
      throw partial.error;
    }
    expect(partial.value.model?.selected).toBe("only");
    // Not `{selected: "", options: []}`: "this agent offers you no levels" and
    // "these are your levels, and there are none" are different answers, and a
    // drawer that showed an empty list would be stating the second.
    expect(partial.value.effort).toBeNull();

    // And an agent that advertises nothing at all.
    held.fake.configuration(undefined);
    const silent = yield* held.owner.options();
    if (!silent.ok) {
      throw silent.error;
    }
    expect(silent.value.model).toBeNull();
    expect(silent.value.effort).toBeNull();
  });

  it("R7: effort choices follow the model being chosen, and choosing one moves nothing", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);

    const current = yield* held.owner.options();
    if (!current.ok) {
      throw current.error;
    }
    expect(current.value.effort?.options.map((one) => one.id)).toEqual(["medium", "deep"]);

    // The levels of a model a person is *considering*, which is the only way a
    // drawer can offer them together: asked for after the next turn they would
    // be the levels of a model the person had already committed to.
    const considering = yield* held.owner.options({ model: "fast" });
    if (!considering.ok) {
      throw considering.error;
    }
    expect(considering.value.model?.selected).toBe("fast");
    expect(considering.value.effort?.options.map((one) => one.id)).toEqual(["low", "high"]);

    // And it left nothing behind. Reading what a model offers is not choosing
    // it, so the agent is still on what it was on.
    const again = yield* held.owner.options();
    if (!again.ok) {
      throw again.error;
    }
    expect(again.value.model?.selected).toBe("balanced");
    expect(again.value.effort?.selected).toBe("medium");

    // Three reads, three sessions of the provider's own, and the conversation
    // still never established — so the model written while considering `fast`
    // was written somewhere nothing will talk in.
    expect(inspections(held.fake)).toHaveLength(3);
    expect(conversations(held.fake)).toEqual([]);
  });

  it("R7: a desired model and effort are applied and verified at the next turn", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);
    held.fake.script({ reply: "<Output>Noted.</Output>\n" });
    held.fake.script({ reply: "<Output>Again.</Output>\n" });

    const asked = yield* held.owner.configure({ model: "fast", effort: "high" });
    if (!asked.ok) {
      throw asked.error;
    }
    // Nothing yet. There is no turn to ask on, and a conversation configured
    // for a turn that never comes is a conversation left somewhere nobody asked
    // for it to be.
    expect(held.fake.configCalls).toEqual([]);
    expect(held.fake.prompts).toHaveLength(0);

    const sent = yield* held.owner.message("go");
    if (!sent.ok) {
      throw sent.error;
    }
    expect(sent.value.output).toContain("Noted.");

    // Model first, then the levels that model offers, then the read that
    // verified it — which is what makes this a fact about the turn rather than
    // a request nobody confirmed.
    expect(held.fake.configCalls).toEqual([
      "status",
      "set model=fast",
      "status",
      "set effort=high",
      "status",
    ]);
    // On the conversation's own session, not an inspection's.
    const [conversation] = conversations(held.fake);
    expect(conversation).toBeDefined();
    expect(held.fake.running(conversation!)).toEqual({ model: "fast", effort: "high" });

    // Read back out of the history, which is where a drawer reads what was
    // asked for — not out of anything this process remembered.
    expect(reading(held.owner).preferences).toEqual({
      conversation: sent.value.conversation,
      model: "fast",
      effort: "high",
    });

    // And it is a standing fact about this conversation rather than one turn's
    // request: the next turn is still under it, and asks for nothing it is
    // already on.
    const again = yield* held.owner.message("once more");
    if (!again.ok) {
      throw again.error;
    }
    expect(again.value.output).toContain("Again.");
    expect(applied(held.fake)).toEqual(["set model=fast", "set effort=high"]);
    expect(held.fake.running(conversation!)).toEqual({ model: "fast", effort: "high" });
  });

  it("R7: a configuration the agent refuses starts no turn and is not quietly dropped", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);
    // Nothing is scripted. A turn that reached this agent would fail the run
    // for want of a reply, so the rows below prove no turn reached it.

    const asked = yield* held.owner.configure({ model: "nonesuch" });
    // Recording is not asking, so this is taken: what refuses is the agent, at
    // the one point it can be asked.
    if (!asked.ok) {
      throw asked.error;
    }

    const sent = yield* held.owner.message("go");
    if (!sent.ok) {
      throw sent.error;
    }
    expect(held.fake.prompts).toHaveLength(0);
    // In the agent's own words, including what it does offer — which is the
    // only thing that tells a person what to pick instead.
    expect(sent.value.failure).toContain('Unknown model "nonesuch"');
    expect(sent.value.failure).toContain("balanced, fast, thorough");
    // And the person reads it where they are reading the conversation.
    expect(reading(held.owner).chat.at(-1)).toMatchObject({
      kind: "incomplete",
      turn: 1,
    });

    // No fallback. The next message is refused the same way rather than
    // running under something the person did not ask for — a Sidekick that
    // dropped the request would answer as a model nobody chose.
    const retried = yield* held.owner.message("try again");
    if (!retried.ok) {
      throw retried.error;
    }
    expect(retried.value.failure).toContain('Unknown model "nonesuch"');
    expect(held.fake.prompts).toHaveLength(0);
    expect(reading(held.owner).preferences?.model).toBe("nonesuch");
  });

  it("R7: changing agent starts another conversation and keeps the chat already read", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);
    held.fake.script({ reply: "<Output>First.</Output>\n" });
    held.fake.script({ reply: "<Output>Second.</Output>\n" });

    const first = yield* held.owner.message("hello");
    if (!first.ok) {
      throw first.error;
    }

    const switched = yield* held.owner.select(OTHER);
    if (!switched.ok) {
      throw switched.error;
    }
    expect(held.owner.agent).toBe(OTHER);

    const after = reading(held.owner);
    // The chat is a person's, not a conversation's: what they have already read
    // is still in front of them.
    expect(after.chat.map((item) => (item.kind === "saved" ? item.status : item.text))).toEqual([
      "hello",
      "First.",
    ]);
    // A different conversation, and one that says which association it replaced
    // — so the predecessor is retained rather than overwritten.
    expect(after.active).not.toBe(first.value.conversation);
    expect(after.conversations.find((one) => one.id === after.active)).toMatchObject({
      agent: OTHER,
      phase: "activated",
      previous: first.value.conversation,
    });
    // And nothing was sent to make the change. What reached the new agent is
    // the inspection that asked it to answer for itself, by name — the session
    // for the first turn, and this one, and nothing else.
    expect(held.fake.prompts).toHaveLength(1);
    expect(held.fake.ensured.map((one) => one.agent)).toEqual([AGENT, OTHER]);

    // Now the message, through the real provider: the new conversation's first
    // turn, answered by the new agent.
    const second = yield* held.owner.message("again");
    if (!second.ok) {
      throw second.error;
    }
    expect(second.value.conversation).toBe(after.active);
    expect(second.value.turn).toBe(1);
    expect(second.value.output).toContain("Second.");

    // Observed at the provider rather than on the owner. The session side is
    // the establishment below: this turn's session was created for OTHER. The
    // prompt side is the reply itself — ACPX compares the agent a turn names
    // against the agent its session was established for and refuses the turn
    // when they differ, so a turn that answered is a turn whose two halves
    // agreed. The conversation session the first turn established is still the
    // one it had.
    const sessions = held.fake.ensured.filter((one) => !one.sessionKey.startsWith("xmd:inspect:"));
    expect(sessions.map((one) => one.agent)).toEqual([AGENT, OTHER]);
    expect(held.fake.turns.map((one) => one.handle.sessionKey)).toEqual([
      sessions[0]?.sessionKey,
      sessions[1]?.sessionKey,
    ]);
    // And the predecessor keeps its own association: two conversations, each
    // under the agent it was opened with, neither reattached to the other's.
    expect(after.conversations.map((one) => one.agent)).toEqual([AGENT, OTHER]);
    expect(
      reading(held.owner).conversations.find((one) => one.id === first.value.conversation),
    ).toMatchObject({ agent: AGENT, phase: "activated" });
  });

  it("R7: a change to an agent that cannot be reached leaves the conversation a person is in", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);
    held.fake.script({ reply: "<Output>First.</Output>\n" });
    held.fake.script({ reply: "<Output>Still here.</Output>\n" });

    const first = yield* held.owner.message("hello");
    if (!first.ok) {
      throw first.error;
    }
    held.fake.unavailable(OTHER, new Error("the other agent could not be started"));

    const switched = yield* held.owner.select(OTHER);
    expect(switched.ok).toBe(false);
    // The agent's own reason, with nothing substituted for it.
    expect(switched.ok ? "" : switched.error.message).toContain("could not be started");

    const after = reading(held.owner);
    // The association that preceded the attempt is exactly where it was, and
    // the selection with it.
    expect(after.active).toBe(first.value.conversation);
    expect(held.owner.agent).toBe(AGENT);
    expect(after.chat.map((item) => (item.kind === "saved" ? item.status : item.text))).toEqual([
      "hello",
      "First.",
    ]);
    // The attempt is retained as the attempt it was — a conversation prepared
    // for that agent that never activated, and why.
    const refused = after.conversations.find((one) => one.agent === OTHER);
    expect(refused).toMatchObject({ phase: "failed", previous: first.value.conversation });
    expect(refused?.failure).toContain("could not be started");

    // And a person goes on talking where they already were: the same
    // conversation, its next turn, under the agent it was opened with.
    const again = yield* held.owner.message("still there?");
    if (!again.ok) {
      throw again.error;
    }
    expect(again.value.conversation).toBe(first.value.conversation);
    expect(again.value.turn).toBe(2);
    expect(again.value.output).toContain("Still here.");
  });

  it("R7: while a turn runs, inspection and replacement refuse and a save succeeds", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);
    // A turn that never settles, which is how work in flight is held open.
    held.fake.script({ reply: "", manual: true });
    held.fake.script({ reply: "<Output>After the save.</Output>\n" });

    const sent = yield* sending(held, "think about this");
    yield* held.fake.startedTurns(1);
    const asking = held.fake.configCalls.length;

    // Inspection and replacement are things the conversation does, and it does
    // one thing at a time.
    const read = yield* held.owner.options();
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.error.message).toContain("one thing at a time");
    const switched = yield* held.owner.select(OTHER);
    expect(switched.ok).toBe(false);
    expect(switched.ok ? "" : switched.error.message).toContain("Stop it before changing agent");

    // Saving a preference is neither. It is a record in this history for the
    // conversation that is already active, so it is taken while the turn runs.
    const asked = yield* held.owner.configure({ model: "fast" });
    if (!asked.ok) {
      throw asked.error;
    }
    expect(reading(held.owner).preferences).toMatchObject({ model: "fast" });
    // And it did no configuration work: nothing was asked of the agent, no
    // second conversation was prepared, and the turn in flight was not
    // reconfigured under it.
    expect(held.fake.configCalls).toHaveLength(asking);
    expect(reading(held.owner).conversations).toHaveLength(1);

    yield* held.owner.stop();
    const answered = yield* sent;
    expect(answered.ok).toBe(false);

    // Stop joined the cycle and left the saved preference standing: it was
    // never part of what was stopped.
    expect(reading(held.owner).preferences).toMatchObject({ model: "fast" });

    // And the next explicit turn runs under it without being asked again. The
    // model is applied and read back before the prompt, which is where a
    // rejected request would have refused instead.
    const again = yield* held.owner.message("now go on");
    if (!again.ok) {
      throw again.error;
    }
    // Read, applied and read back again, in that order, before the prompt —
    // which is where a rejected request would have refused instead.
    expect(held.fake.configCalls.slice(asking, asking + 3)).toEqual([
      "status",
      "set model=fast",
      "status",
    ]);
    // And no effort was chosen for them: the save asked for none.
    expect(held.fake.configCalls.some((one) => one.startsWith("set effort="))).toBe(false);
    // The same conversation throughout, which is what the preference was bound
    // to when it was saved.
    expect(again.value.conversation).toBe(reading(held.owner).preferences?.conversation);
    // On the conversation's own session, not an inspection's.
    const [conversation] = conversations(held.fake);
    expect(conversation).toBeDefined();
    expect(held.fake.running(conversation!)?.model).toBe("fast");
  });

  it("R7: a reopened Sidekick keeps the agent its conversation was opened with", function* () {
    const held = yield* useHarness();
    held.fake.configuration(OFFERED);
    held.fake.script({ reply: "<Output>First.</Output>\n" });
    held.fake.script({ reply: "<Output>Reopened.</Output>\n" });

    const first = yield* held.owner.message("hello");
    if (!first.ok) {
      throw first.error;
    }
    const switched = yield* held.owner.select(OTHER);
    if (!switched.ok) {
      throw switched.error;
    }
    const active = reading(held.owner).active;

    // A process that chose a third agent entirely, which is what a command line
    // with its own default is.
    const cold = yield* reopen(held, "a-third-agent");
    // What a person chose outlives the process that ran when they chose it, and
    // it is read off the conversation rather than remembered: the reopened
    // owner was handed a third agent entirely and reports this one.
    expect(cold.agent).toBe(OTHER);
    expect(reading(cold).active).toBe(active);
    // And reopening asked no agent anything, which is what keeps restoring a
    // chat free of provider work.
    expect(held.fake.ensured.map((one) => one.agent)).toEqual([AGENT, OTHER]);

    // Then the message, which is what makes the saved selection more than a
    // label: the turn is served by OTHER even though this process was started
    // with a third agent.
    const sent = yield* cold.message("again");
    if (!sent.ok) {
      throw sent.error;
    }
    expect(sent.value.conversation).toBe(active);
    expect(sent.value.output).toContain("Reopened.");

    // Observed at the provider. The session this turn ran in was established
    // for OTHER, and the reply proves the prompt named OTHER too: ACPX refuses
    // a turn whose agent and session disagree. Not "a-third-agent", which is
    // what the reopened owner's own assembly says — no session was ever asked
    // for under it.
    const conversationSessions = held.fake.ensured.filter(
      (one) => !one.sessionKey.startsWith("xmd:inspect:"),
    );
    expect(conversationSessions.map((one) => one.agent)).toEqual([AGENT, OTHER]);
    const served = held.fake.turns.at(-1);
    expect(served?.handle.sessionKey).toBe(conversationSessions.at(-1)?.sessionKey);
    expect(held.fake.ensured.map((one) => one.agent)).not.toContain("a-third-agent");
  });
});

/**
 * Tier CFG — Configure, reached from the screen it is drawn on (#883).
 *
 * The rows above drive the owner directly, because what a saved preference is
 * worth is the same whether or not anything is drawing it. These add the half
 * only the mounted command has: the drawer is opened from the Sidekick's own
 * header, the choices it shows are the ones the provider really advertised, and
 * Apply is the control a person presses. Only the terminal and the agent
 * transport are replaced.
 */

/** A reply that prepares an entry, submits it, and waits for its outcome. */
const SUBMITS = [
  '<Let as="code" select="code">',
  "````xmd",
  "```js eval",
  'const held = "the entry ran";',
  "```",
  "",
  "<Output>{held}</Output>",
  "````",
  "</Let>",
  "<REPL.EntryInput>{code}</REPL.EntryInput>",
  "<REPL.Submit />",
  "",
].join("\n");

/**
 * A window for an assertion that nothing happened.
 *
 * Nothing is drawn and no event is published when the thing being asserted
 * does not occur, so there is nothing to wait for: the assertion is given a
 * window in which to be wrong.
 */
function* lingering(): Operation<void> {
  yield* sleep(100);
}

/** One message, its reply drawn, and the Sidekick at rest again. */
function* conversed(page: ReplPage, text: string, reply: string): Operation<void> {
  yield* sendMessage(page, text);
  yield* page.until(`the reply ${JSON.stringify(reply)}`, (one) => one.shows(reply));
  yield* page.until("the Sidekick at rest", sidekickIdle);
}

/** Whether the drawer's own Apply control wears this label. */
function applyReads(reading: ScreenReading, label: string): boolean {
  return drawerShows(reading, label);
}

/** Whether the pane's header names this agent, which it does once the drawer has gone. */
function headerNames(reading: ScreenReading, agent: string): boolean {
  return reading.shows(`[configure ${agent}]`);
}

/** Whether this screen offers to ask the failed request again. */
function retryOffered(reading: ScreenReading): boolean {
  return reading.shows("[retry]");
}

/**
 * Read the current chat explicitly, by its own Sessions row.
 *
 * Through the mounted control, so what is selected is what a person
 * selected: the row carries the chat and the turn, and nothing here reaches
 * the owner or the route.
 */
function* readOwnChat(page: ReplPage, title: string): Operation<void> {
  // The sidebar's own row for this chat: it carries the turn's state after the
  // title, which the pane's copy of the same words does not.
  const own = `${title} \u00b7`;
  yield* page.until(`a Sessions row showing ${title}`, (one) => one.shows(own));
  yield* page.press(title, { onRow: own });
  yield* page.until("the chat selector standing", (one) => one.shows("[Back to current chat]"));
  // The current chat keeps its usual controls even when it is the chat
  // somebody explicitly selected: it *is* the active association.
  expect(page.screen().shows(COMPOSER)).toBe(true);
}

/** The text with every space taken out, so wrapped prose compares as it was written. */
function bare(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Whether this notice's whole text is recoverable from the drawer's rows. */
function saysWhole(reading: ScreenReading, text: string): boolean {
  const rows = drawerLines(reading);
  const wanted = bare(text);
  return rows.some((_, at) => bare(rows.slice(at, at + 8).join("")).includes(wanted));
}

/** Wait until the replacement notice this name produces has been drawn. */
function* noticed(page: ReplPage, text: string): Operation<void> {
  yield* page.until("the replacement notice", (one) => saysWhole(one, text));
}

/** The rows beside the open drawer, which is the part of the screen it leaves. */
function outside(page: ReplPage): string[] {
  return besideDrawer(page.screen());
}

describe("Tier CFG — Configure in the Sidekick's pane", () => {
  /** What this agent offers, and what each of its models offers for effort. */
  const ADVERTISED = {
    model: {
      selected: "balanced",
      choices: [
        { id: "balanced", name: "Balanced", description: "Even-handed." },
        { id: "fast", name: "Fast", group: { id: "speed", name: "Speed" } },
      ],
    },
    effort: {
      balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] },
      fast: {
        selected: "low",
        choices: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
      },
    },
  } as const;

  it("CFG1: Configure shows what the agent really offers, and nothing asks before it", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);

    // Their own text in both composers first, which none of this may touch.
    yield* draftText(page, "mine");
    yield* intoComposer(page);
    yield* page.type("later");
    yield* page.until("the composer holding its unsent text", (one) => composerHolds(one, "later"));

    // Before opening it: nothing inspected, nothing established, nothing
    // written. Looking at the pane, changing tabs and resizing all cost
    // nothing.
    expect(repl.fake.configCalls).toEqual([]);
    expect(repl.fake.ensured).toEqual([]);
    // A fresh execution publishes its pair when it is created, so what "no
    // writes" means here is no *chat*: the two publication records and nothing
    // else. A preference or a message would be a third.
    expect((yield* chatKinds(repl)).length).toBe(2);
    yield* selectPane(page, "bindings");
    yield* page.resize({ columns: 120, rows: 30 });
    yield* page.resize({ columns: 160, rows: 36 });
    yield* selectPane(page, "sidekick");
    expect(repl.fake.configCalls).toEqual([]);
    expect(repl.fake.ensured).toEqual([]);

    // Opening it is the explicit act that reads, and it reads through the
    // provider rather than from anything remembered.
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    // The provider's own words: its names, its descriptions and the heading it
    // filed a choice under.
    expect(drawerShows(page.screen(), "Even-handed.")).toBe(true);
    expect(drawerShows(page.screen(), "Speed · Fast")).toBe(true);
    // And no turn: an inspection takes a session of its own and sends nothing.
    expect(repl.fake.prompts).toEqual([]);
    // Nothing has been asked for yet, and nothing has been verified.
    expect(drawerShows(page.screen(), "Requested: none")).toBe(true);
    expect(drawerShows(page.screen(), "Verified: none")).toBe(true);

    // Both composers still hold exactly what was typed into them.
    yield* closeConfigure(page);
    expect(draftHolds(page.screen(), "mine")).toBe(true);
    expect(composerHolds(page.screen(), "later")).toBe(true);
  });

  it("CFG2: a chosen model brings its own effort levels, and Apply saves them", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Under the new settings.</Output>\n" });

    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    // Nothing is selected and nothing is requested, so there is no effort
    // section at all: effort belongs to a model, and none has been chosen.
    expect(drawerShows(page.screen(), "Effort")).toBe(false);

    // One model, chosen through its own control.
    yield* chooseNamed(page, "fast");
    // Its levels have not been read, and nothing is invented from the model
    // before it: this says so rather than offering another model's list.
    expect(drawerShows(page.screen(), "Effort for fast")).toBe(true);
    expect(drawerShows(page.screen(), "Medium")).toBe(false);

    // Read explicitly, for the model selected now.
    yield* page.press("[refresh]");
    yield* page.until(
      "this model's own levels",
      (one) => drawerShows(one, "( ) High") || drawerShows(one, "(x) High"),
    );
    // `fast`'s levels, which `balanced` does not have.
    expect(drawerShows(page.screen(), "Low")).toBe(true);
    expect(drawerShows(page.screen(), "Medium")).toBe(false);
    yield* chooseNamed(page, "high");

    // Closed without applying: nothing was saved, so reopening starts from the
    // saved preference again rather than from what was chosen and abandoned.
    yield* closeConfigure(page);
    expect((yield* chatKinds(repl)).includes("preferences")).toBe(false);
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["fast"]);
    // Nothing of what was chosen and abandoned: no model marked, and still no
    // request saved.
    expect(chosen(page.screen(), NAMED["fast"])).toBe(false);
    expect(drawerShows(page.screen(), "Requested: none")).toBe(true);

    // Chosen again and applied, which saves and closes.
    yield* chooseNamed(page, "fast");
    yield* page.press("[refresh]");
    yield* page.until(
      "this model's own levels",
      (one) => drawerShows(one, "( ) High") || drawerShows(one, "(x) High"),
    );
    yield* chooseNamed(page, "high");
    const askingBefore = repl.fake.configCalls.length;
    yield* applyConfigure(page);
    // Apply closes Configure on success, which is what says the preference was
    // acknowledged: a drawer still open would be one whose save had not landed.
    yield* drawerGone(page);

    // Saved, and nothing else: a preference is a record, so Apply asked the
    // agent for nothing and sent no turn.
    expect((yield* chatKinds(repl)).filter((kind) => kind === "preferences")).toHaveLength(1);
    expect(repl.fake.configCalls).toHaveLength(askingBefore);
    expect(repl.fake.prompts).toEqual([]);

    // Reopening shows what was saved, and says it is a request rather than
    // something an agent has run under.
    yield* openConfigure(page);
    // The label and the model, which is what the pane's width holds: the
    // assertion below reads the whole of what was saved out of the history,
    // where nothing clips it.
    yield* page.until("the saved request", () =>
      drawerShows(page.screen(), "Requested: model=fast"),
    );
    // And the whole of what was saved, read out of the history rather than off
    // a row the pane's width may clip.
    expect(yield* savedPreference(repl)).toMatchObject({ model: "fast", effort: "high" });
    yield* closeConfigure(page);

    // And the next real message is what applies it: the model first, read back,
    // then the effort, read back, all before the prompt. Counted from here,
    // because reopening the drawer above read the agent's choices again and
    // that read is not part of applying anything.
    const sending = repl.fake.configCalls.length;
    yield* conversed(page, "go", "Under the new settings.");
    expect(repl.fake.configCalls.slice(sending)).toEqual([
      "status",
      "set model=fast",
      "status",
      "set effort=high",
      "status",
    ]);

    // What was verified now says the same thing the request did — and it says
    // it because Core saved it against a turn that started, not because this
    // screen remembered asking.
    yield* openConfigure(page);
    yield* page.until("the verified settings", () =>
      drawerShows(page.screen(), "Verified: model=fast"),
    );
  });

  it("CFG2: a stale inspection cannot replace a newer selection", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);

    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    yield* chooseNamed(page, "fast");

    // One inspection held open, for `fast`.
    const holding = repl.fake.holdStatus();
    yield* page.press("[refresh]");
    yield* holding.reached;
    yield* page.until("the read in flight", () =>
      drawerShows(page.screen(), "Reading what this agent"),
    );

    // The selection moves underneath it, to a model whose levels this read is
    // not about.
    yield* chooseNamed(page, "balanced");

    holding.release();
    // Waited for the held read to be *applied*, not for a row that was already
    // there: the reading notice is drawn while it is in flight, so its going
    // away is the moment this result reached the drawer. A predicate about the
    // selection would have been true before the release and would prove
    // nothing about what the answer did.
    yield* page.until(
      "the stale read being applied",
      () =>
        drawerShows(page.screen(), "Effort for balanced") &&
        !drawerShows(page.screen(), "Reading what this agent"),
    );
    // It changed nothing it should not: it is an answer about `fast`, and
    // `fast` is not what is selected any more. No level from it is offered
    // under the model that is, and the drawer is where the person left it.
    expect(drawerShows(page.screen(), "High")).toBe(false);
    expect(drawerShows(page.screen(), "( ) Low")).toBe(false);
    expect(chosen(page.screen(), NAMED["balanced"])).toBe(true);
  });

  it("CFG2: control — a read of the selected model offers that model's own levels", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);

    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    yield* chooseNamed(page, "fast");

    // The same held read, released with the selection left where it was. This
    // is the discriminating half: the levels do arrive, so the row above is
    // about ownership rather than about reads never being applied at all.
    const holding = repl.fake.holdStatus();
    yield* page.press("[refresh]");
    yield* holding.reached;
    holding.release();
    // Once the levels are known the heading is just "Effort": the "Effort for
    // <model>: not read yet." sentence is what stands in for a list nobody has.
    yield* page.until(
      "the read being applied",
      (one) => offered(one, "High") && !drawerShows(page.screen(), "Reading what this agent"),
    );
    expect(drawerShows(page.screen(), "( ) Low")).toBe(true);
    expect(drawerShows(page.screen(), "not read yet")).toBe(false);
  });

  it("CFG2: an inspection in flight refuses a new message instead of retaining one", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Should never be asked.</Output>\n" });

    // One explicit inspection admitted and held open, with the drawer closed
    // again behind it: what stands in the way is the job, not the drawer.
    const holding = repl.fake.holdStatus();
    try {
      yield* openConfigure(page);
      yield* holding.reached;
      yield* closeConfigure(page);

      // Send, while that job is still the one thing the Sidekick is doing. The
      // drawer took the keystrokes, so the composer's own route is walked.
      yield* intoComposer(page);
      yield* typed(page, "during");
      yield* page.until(
        "the Sidekick offering its own Send",
        (one) => one.found("[send]", SIDEKICK_CONTROLS) === 1,
      );
      yield* page.press("[send]", SIDEKICK_CONTROLS);
      yield* page.until("the refusal Send is given", (one) =>
        one.shows("already doing something you asked for"),
      );

      // Refused before anything was retained: no person message in the
      // history, nothing asked of the agent, and the text still in the box for
      // them to send when the inspection is done.
      const read = yield* settledReading(repl);
      expect(read.chat.filter((record) => record.kind === "message")).toHaveLength(0);
      expect(repl.fake.prompts).toEqual([]);
      expect(composerHolds(page.screen(), "during")).toBe(true);
    } finally {
      holding.release();
    }
  });

  it("CFG2: control — with no job admitted, the same Send is taken", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Asked and answered.</Output>\n" });

    // The same opening and closing of Configure, with its read allowed to
    // finish. This is what makes the row above about the admitted job rather
    // than about Configure having been opened at all.
    yield* openConfigure(page);
    yield* page.until(
      "the read finishing",
      (one) => offered(one, "Balanced") && !drawerShows(one, "Reading what this agent"),
    );
    yield* closeConfigure(page);

    yield* conversed(page, "during", "Asked and answered.");
    const read = yield* settledReading(repl);
    expect(read.chat.filter((record) => record.kind === "message")).toHaveLength(1);
    expect(repl.fake.prompts).toHaveLength(1);
  });

  it("CFG2: while a turn runs, effort cannot be refreshed but a model can be saved", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Hello back.</Output>\n" });
    // Generation held open, so the conversation is doing something throughout.
    repl.fake.script({ held: true, reply: "<Output>Done.</Output>\n" });

    // A conversation first, because choices belong to one: read before there is
    // a conversation and they are not this conversation's to keep.
    yield* conversed(page, "hello", "Hello back.");

    // Then one read, so there are advertised choices in hand for this exact
    // conversation when it goes busy.
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    yield* closeConfigure(page);

    yield* sendMessage(page, "think");
    yield* repl.fake.holdingTurns(1);
    const asking = repl.fake.configCalls.length;

    // Opened while busy. The models already advertised for this conversation
    // stay usable, so one of them can still be chosen.
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["fast"]);
    yield* chooseNamed(page, "fast");

    // Its effort levels have not been read, and they cannot be: an inspection
    // is something this conversation does one at a time, and the root refuses
    // it before the agent is reached. Said rather than filled in from another
    // model's list.
    expect(drawerShows(page.screen(), "Effort for fast")).toBe(true);
    expect(drawerShows(page.screen(), "Low")).toBe(false);
    yield* page.press("[refresh]");
    yield* page.until("the refusal a busy refresh gives", () =>
      // Said in the drawer that was pressed, and the beginning of the reason is
      // what this pane's width holds.
      drawerShows(page.screen(), "the Sidekick is already working"),
    );
    // Nothing was asked of the agent by trying.
    expect(repl.fake.configCalls).toHaveLength(asking);

    // A model-only preference saves while the turn runs, with no effort
    // requested and no silent choice made for it.
    yield* applyConfigure(page);
    yield* drawerGone(page);
    expect(yield* savedPreference(repl)).toMatchObject({ model: "fast", effort: null });
    // And the turn in flight was not reconfigured under it.
    expect(repl.fake.configCalls).toHaveLength(asking);

    repl.fake.releaseTurn();
    yield* page.until("the held turn finishing", (one) => one.shows("Done."));
  });

  /**
   * One message whose reply submits an entry, with that entry held open, and a
   * preference optionally applied while it waits.
   *
   * `changing` is the whole distinction: the automatic turn that follows the
   * entry reads the preference as it stands when that turn hands its request
   * over, so a save acknowledged while the entry was held belongs to it.
   */
  function* heldEntry(changing: boolean): Operation<readonly string[]> {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Ready.</Output>\n" });
    repl.fake.script({ reply: SUBMITS });
    repl.fake.script({ reply: "<Output>Both done.</Output>\n" });

    // A conversation, and one read of what it offers, so the drawer has
    // advertised choices for this conversation while it is busy.
    yield* conversed(page, "hello", "Ready.");
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    yield* closeConfigure(page);

    // The entry's own closing record, held open: the entry has run and has not
    // settled, so the reply's Submit is still waiting for its outcome.
    const closing = gate.holdNext(
      (path, record) => path.endsWith("entries.jsonl") && record.includes('"type":"close"'),
    );
    yield* sendMessage(page, "run it");
    yield* closing.started();
    yield* page.until("the entry's output", (one) => one.shows("the entry ran"));
    const asking = repl.fake.configCalls.length;

    if (changing) {
      // Applied while the entry is held. A preference is a record, so this asks
      // the agent for nothing and stops nothing.
      yield* openConfigure(page);
      yield* offeredChoice(page, NAMED["fast"]);
      yield* chooseNamed(page, "fast");
      yield* applyConfigure(page);
      yield* drawerGone(page);
      expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
      // Nothing of the agent's was touched by saving, and the entry is still
      // held: the save coexists with the work rather than interrupting it.
      expect(repl.fake.configCalls).toHaveLength(asking);
      expect(closing.released).toBe(false);
    }

    // Released: the entry settles, the Submit it was waiting for answers, and
    // the automatic turn that reports it runs.
    closing.release();
    yield* page.until("the turn that follows the entry", (one) => one.shows("Both done."));
    return repl.fake.configCalls.slice(asking);
  }

  it("CFG3: a preference saved while an entry is held is used by the turn after it", function* () {
    const applied = yield* heldEntry(true);

    // The automatic feedback turn applied exactly what was saved while it was
    // waiting, and only that.
    expect(applied.filter((one) => one.startsWith("set "))).toEqual(["set model=fast"]);
    // Read, written, read back, in that order: the readback is where a refusal
    // would have left the turn unsent rather than sent under something else.
    const at = applied.indexOf("set model=fast");
    expect(applied[at - 1]).toBe("status");
    expect(applied[at + 1]).toBe("status");
  });

  it("CFG3: control — with nothing changed, that turn uses the old settings", function* () {
    const applied = yield* heldEntry(false);

    // Read and found already right: no setting was written, because none was
    // asked for.
    expect(applied.filter((one) => one.startsWith("set "))).toEqual([]);
  });

  it("CFG1: control — an agent that offers no model choice says so", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    // `null` from the provider: no model selector at all, which is a different
    // answer from a selector with nothing in it.
    repl.fake.configuration(undefined);

    yield* openConfigure(page);
    // Said in the pane's own width, which clips a longer sentence: what the row
    // asserts is the sentence this screen actually shows.
    yield* page.until("Configure saying there is no choice", () =>
      drawerShows(page.screen(), "offers no model"),
    );
    // Nothing fabricated: no empty list of models, and no effort section for a
    // model nobody selected.
    expect(drawerShows(page.screen(), "( )")).toBe(false);
    expect(drawerShows(page.screen(), "Effort")).toBe(false);
    expect(repl.fake.prompts).toEqual([]);
  });

  /**
   * CX1 — the two ways out of Configure, and they mean the same thing.
   *
   * Escape and the visible Close control are two ways to ask for one act, so
   * each arm closes a drawer holding an unapplied choice and both are owed the
   * same outcome: nothing saved, nobody asked, both composers untouched, focus
   * back on the opener, and the choice discarded rather than remembered.
   */
  function* exiting(by: "escape" | "close"): Operation<void> {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);

    // Their own text in both fields, which closing a drawer may not touch.
    yield* draftText(page, "mine");
    yield* intoComposer(page);
    yield* typed(page, "later");

    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    // A real choice, made and deliberately not applied: this is what the
    // discard rule below is about, and what a close that saved would save.
    yield* chooseNamed(page, "fast");
    const asked = repl.fake.configCalls.length;
    const ensured = repl.fake.ensured.length;
    const records = (yield* chatKinds(repl)).length;

    if (by === "escape") {
      // One Escape, through the real input path — no action dispatched here.
      yield* page.key("Escape");
    } else {
      // And the visible control, pressed where this screen draws it.
      yield* page.press("[close]");
    }
    yield* drawerGone(page);
    expect(page.screen().shows("[refresh]")).toBe(false);

    // Nothing was saved and nobody was asked: closing is not applying.
    expect((yield* chatKinds(repl)).length).toBe(records);
    expect((yield* chatKinds(repl)).includes("preferences")).toBe(false);
    expect(yield* savedPreference(repl)).toBe(undefined);
    expect(repl.fake.configCalls).toHaveLength(asked);
    expect(repl.fake.ensured).toHaveLength(ensured);
    expect(repl.fake.prompts).toEqual([]);
    // Both composers hold exactly what was typed into them.
    expect(draftHolds(page.screen(), "mine")).toBe(true);
    expect(composerHolds(page.screen(), "later")).toBe(true);
    // And the control this drawer is about is on the screen again, with the
    // pane's own header naming the agent it holds.
    expect(headerNames(page.screen(), MOUNTED_AGENT)).toBe(true);

    // The choice went with the drawer: reopening starts from the saved
    // preference, which is the only thing a next turn would use.
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    expect(chosen(page.screen(), NAMED["fast"])).toBe(false);
    expect(drawerShows(page.screen(), "Requested: none")).toBe(true);
  }

  it("CX1: one Escape closes Configure, saving nothing and asking nobody", function* () {
    yield* exiting("escape");
  });

  it("CX1: the visible Close control, reached by Tab, closes it the same way", function* () {
    yield* exiting("close");
  });

  /**
   * CX2 — Close cannot scroll away, and closing is not stopping.
   *
   * The settings window moves and `[close]` does not: it lives outside that
   * window, so a list long enough to fill the drawer at the medium profile
   * still leaves a way out. And a drawer closed while the Sidekick is working
   * closes the drawer only — the message in flight is not something a modal's
   * dismissal may end.
   */
  it("CX2: Close stays reachable past an off-window choice, and while a turn runs", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const repl = page.repl;
    // More models than this drawer draws at once, which is what puts choices
    // and Apply below the window.
    const many = Array.from({ length: 24 }, (_, at) => ({
      id: `model-${at + 1}`,
      name: `Model ${at + 1}`,
    }));
    repl.fake.configuration({ model: { selected: "model-1", choices: many }, effort: {} });
    repl.fake.script({ held: true, reply: "<Output>Done at last.</Output>\n" });

    // Opened without asserting its controls: with a list this long they are
    // below the window too, which is the state this row is about.
    yield* openConfigure(page);
    yield* offeredChoice(page, "Model 1");
    const last = `Model ${many.length}`;
    // Genuinely below the window before it is scrolled to.
    expect(offered(page.screen(), last)).toBe(false);
    yield* scrollDrawerTo(page, last);
    yield* chooseNamed(page, last);
    // Apply is below the window too, which is the state this is about: the
    // window has been moved a long way, and the way out is still on the screen.
    yield* scrollDrawerTo(page, "[apply]");
    expect(page.screen().shows("[close]")).toBe(true);

    // Reached by real traversal from wherever that scrolling left focus.
    const closing = function* (): Operation<void> {
      yield* page.press("[close]");
      yield* page.key("Enter");
      yield* drawerGone(page);
    };
    yield* closing();
    expect(page.screen().shows("[apply]")).toBe(false);
    expect((yield* chatKinds(repl)).includes("preferences")).toBe(false);

    // Again, with a real message held in flight. Both composers hold their own
    // text across it, and the turn that is running is not what was dismissed.
    yield* draftText(page, "kept draft");
    yield* sendMessage(page, "work on it");
    yield* repl.fake.holdingTurns(1);
    yield* page.until(
      "the Sidekick working",
      (one) => one.found("[stop]", SIDEKICK_CONTROLS) === 1,
    );
    // Opened over a working Sidekick, which refuses to inspect while a turn is
    // running — so what is waited for is the drawer, not its choices. That
    // refusal is the established behaviour and is not what this row is about:
    // the question here is whether the way out is still reachable.
    yield* openConfigure(page);
    yield* page.until("the drawer over a working Sidekick", (one) => one.shows("[apply]"));
    // Read across the drawer's rows: it is the Sidekick's own pane, 30 cells of
    // interior at this size, and a sentence that long is wrapped prose there
    // rather than one row.
    yield* page.until("the drawer saying the Sidekick is working", () =>
      drawerLines(page.screen()).join(" ").replace(/\s+/g, " ").includes("already working"),
    );
    yield* closing();
    // The drawer is gone, the turn is not: nothing stopped it, and it finishes
    // on its own when the provider is released.
    expect(page.screen().shows("[apply]")).toBe(false);
    expect(repl.outcome()).toBe(undefined);
    repl.fake.releaseTurn();
    yield* page.until("the reply that was never stopped", (one) => one.shows("Done at last."));
    expect(draftHolds(page.screen(), "kept draft")).toBe(true);
  });
});

/**
 * Tier CFG — changing agent is starting a new conversation (#883, CFG4).
 *
 * An established conversation never changes agent in place, so the drawer's
 * Apply says what it will really do. The old chat and its association stay
 * where they are, a failed setup leaves them active, and nothing of the old
 * agent's choices goes with the replacement.
 */
describe("Tier CFG — replacing the Sidekick's agent", () => {
  const ADVERTISED = {
    model: {
      selected: "balanced",
      choices: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
      ],
    },
    effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
  } as const;

  it("CFG4: an idle replacement keeps the old chat and runs the next message under the new agent", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    yield* conversed(page, "hello", "First agent.");
    const before = repl.fake.prompts.length;

    yield* openConfigure(page);
    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    // The control says what it will do, because a different agent is a
    // different conversation and somebody has to know that before pressing it.
    yield* page.until("the control saying it starts a new conversation", (one) =>
      applyReads(one, "[start new conversation]"),
    );

    yield* applyConfigure(page);
    yield* drawerGone(page);

    // Switching sent no turn: a replacement opens a conversation, it does not
    // say anything in it.
    expect(repl.fake.prompts).toHaveLength(before);
    // The old chat is still in the history, and the new conversation starts
    // empty of it: what a person reads is the conversation they are in, and
    // nothing of the old one is replayed into its successor.
    expect(yield* chatKinds(repl)).toContain("message");
    yield* page.until("the new conversation starting empty", (one) =>
      one.shows("No messages yet."),
    );

    // And the next explicit message really runs under the new agent.
    yield* conversed(page, "and you?", "Second agent.");
    const opened = repl.fake.ensured.map((one) => one.agent);
    expect(opened).toContain(MOUNTED_AGENT);
    expect(opened).toContain(OTHER_MOUNTED_AGENT);
  });

  /**
   * One replacement, with the old conversation optionally holding a preference.
   *
   * `saving` is the whole distinction. A drawer reopened after a save is
   * initialized from that saved preference, so it holds exactly the model the
   * last Apply asked with — and an answer correlated by its values could not
   * tell the two apart. What the replacement's success closes has to be the
   * selection that asked for it.
   */
  function* replacing(saving: boolean): Operation<void> {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);

    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    if (saving) {
      yield* chooseNamed(page, "fast");
      yield* applyConfigure(page);
      yield* drawerGone(page);
      expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
      // Reopened deliberately, on the preference that was just saved.
      yield* openConfigure(page);
      yield* page.until("the saved model in the reopened drawer", () =>
        chosen(page.screen(), NAMED["fast"]),
      );
    }

    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    yield* page.until("the control saying it starts a new conversation", (one) =>
      applyReads(one, "[start new conversation]"),
    );
    yield* applyConfigure(page);

    // The new conversation was really activated — read from the history rather
    // than inferred from the screen.
    yield* awaitedFact("the new conversation being activated", function* (): Operation<boolean> {
      const read = yield* settledReading(repl);
      return read.chat.some(
        (record) =>
          record.kind === "conversation" &&
          record.agent === OTHER_MOUNTED_AGENT &&
          record.phase === "activated",
      );
    });
    // And its success closed the drawer that asked for it, whatever the old
    // conversation's preference happened to be.
    yield* page.until("Configure closing on the replacement", (one) =>
      headerNames(one, OTHER_MOUNTED_AGENT),
    );
    expect(page.screen().shows("[refresh]")).toBe(false);
  }

  it("CFG4: a replacement closes Configure although the old conversation had a preference", function* () {
    yield* replacing(true);
  });

  it("CFG4: control — the same replacement with no preference saved closes the same way", function* () {
    yield* replacing(false);
  });

  it("CFG4: a save still in flight cannot close a drawer whose agent was edited", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);

    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    yield* chooseNamed(page, "fast");

    // The record this save writes, held open inside the host, so the answer
    // arrives after the drawer has moved on.
    const writing = gate.holdNext((_path, record) => record.includes('"kind":"preferences"'));
    try {
      yield* applyConfigure(page);
      yield* writing.started();

      // Another agent typed into the field while it is in flight. The model and
      // the effort are untouched, so this is a drawer whose *values* still
      // match the Apply that is running.
      yield* replaceAgent(page, OTHER_MOUNTED_AGENT);

      writing.release();
      yield* awaitedFact("the preference landing", function* (): Operation<boolean> {
        return (yield* savedPreference(repl)) !== undefined;
      });
      yield* lingering();

      // The save stands — this is not a rollback — and the drawer a person is
      // in the middle of is still theirs: still open, still naming the agent
      // they typed, and nothing of it applied by somebody else's answer.
      expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
      expect(page.screen().shows("[refresh]")).toBe(true);
      expect(agentName(page.screen())).toBe(OTHER_MOUNTED_AGENT);
      // And no replacement happened: that is still something to press.
      expect(repl.fake.ensured.map((one) => one.agent)).not.toContain(OTHER_MOUNTED_AGENT);
      expect(applyReads(page.screen(), "[start new conversation]")).toBe(true);
    } finally {
      writing.release();
    }
  });

  it("CFG4: a busy replacement stops the turn and joins it before the new agent", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    // Generation genuinely in flight, and the cancellation it will be sent held
    // open: this is what makes the join observable rather than inferred.
    repl.fake.script({ held: true, reply: "<Output>Never seen.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    yield* sendMessage(page, "held message");
    yield* repl.fake.holdingTurns(1);
    const cancelling = repl.fake.holdCancellation();
    try {
      yield* openConfigure(page);
      // Stop is drawn inside the drawer that covers the pane. The pane's own
      // control is behind a modal, and a way to stop that somebody cannot
      // reach is not one.
      yield* page.until("Stop drawn inside the drawer", (one) => drawerShows(one, "[stop]"));

      yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
      // The choices read from the agent this conversation is with are not
      // offered for another one, and the drawer says why rather than leaving
      // controls that could do nothing.
      yield* page.until("the other agent's own settings being said", () =>
        drawerShows(page.screen(), "has its own settings"),
      );
      expect(drawerShows(page.screen(), "( ) Balanced")).toBe(false);
      expect(drawerShows(page.screen(), "Effort for")).toBe(false);
      yield* page.until("the control saying it stops first", (one) =>
        applyReads(one, "[stop and start new conversation"),
      );

      const before = repl.fake.ensured.length;
      yield* applyConfigure(page);
      // It really asked the agent to stop, and it is waiting for that: nothing
      // of the replacement has been started while the cancellation is held.
      yield* cancelling.reached;
      expect(repl.fake.ensured.map((one) => one.agent)).not.toContain(OTHER_MOUNTED_AGENT);
      // A second activation of the same control while it waits starts no
      // second replacement: one explicit job at a time, reserved before the
      // first one was spawned.
      yield* applyConfigure(page);
      yield* lingering();
      expect(repl.fake.ensured).toHaveLength(before);

      cancelling.release();
      // Joined, and only then set up: the new agent appears in the pane's own
      // header, and the conversation it opened is empty of the old one.
      yield* page.until("the new agent after the join", (one) =>
        headerNames(one, OTHER_MOUNTED_AGENT),
      );
      expect(repl.fake.ensured.map((one) => one.agent)).toContain(OTHER_MOUNTED_AGENT);
      yield* page.until("the Sidekick at rest", sidekickIdle);
      yield* conversed(page, "and you?", "Second agent.");
    } finally {
      cancelling.release();
    }
  });

  it("CFG4: a replacement leaves the entry the old conversation admitted running", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: SUBMITS });
    // Two scripted replies and no third: the follow-up turn the old
    // conversation would have run never happens, because the conversation that
    // was waiting for this entry is the one the replacement stopped.
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    // An entry this conversation's reply submitted, held open before it closes:
    // the Sidekick is waiting for its outcome, and the entry itself is running.
    const closing = gate.holdNext(
      (path, record) => path.endsWith("entries.jsonl") && record.includes('"type":"close"'),
    );
    yield* sendMessage(page, "run it");
    yield* closing.started();
    yield* page.until("the entry's output", (one) => one.shows("the entry ran"));

    yield* openConfigure(page);
    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    yield* page.until("the control saying it stops first", (one) =>
      applyReads(one, "[stop and start new conversation"),
    );
    yield* applyConfigure(page);
    yield* page.until("the new agent after the join", (one) =>
      headerNames(one, OTHER_MOUNTED_AGENT),
    );
    // The entry was not cancelled with the conversation that asked for it: it
    // is the document's work, and it is still waiting to close.
    expect(closing.released).toBe(false);

    closing.release();
    // It finishes on its own, and its record is in this execution's entries.
    // The gate records the whole path it let through, so this asks whether an
    // entries file was written rather than naming one.
    yield* awaited("the entry closing", () =>
      gate.reached.some((one) => one.endsWith("entries.jsonl")),
    );
    yield* entrySettles(page, 1, "ok");
    expect(page.screen().shows("the entry ran")).toBe(true);
    // And the new conversation is the one a message now goes to.
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* conversed(page, "and you?", "Second agent.");
  });

  it("CFG4: an unreachable agent keeps the old association and says why", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Still the first.</Output>\n" });
    // The replacement cannot be started at all, which is what an unavailable
    // agent is.
    repl.fake.unavailable(OTHER_MOUNTED_AGENT, new Error("that agent will not start here"));

    yield* conversed(page, "hello", "First agent.");

    yield* openConfigure(page);
    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    yield* page.until("the control saying it starts a new conversation", (one) =>
      applyReads(one, "[start new conversation]"),
    );
    yield* applyConfigure(page);

    // The drawer stays open with the reason: a failed setup is something to
    // correct rather than something to be dropped out of.
    yield* page.until("the reason in the drawer", () =>
      drawerShows(page.screen(), "will not start"),
    );
    expect(page.screen().shows("[refresh]")).toBe(true);

    // And the old conversation is still the active one: it takes a real message.
    yield* closeConfigure(page);
    yield* conversed(page, "still there?", "Still the first.");
  });

  it("SS4: a successful replacement returns to the new current chat", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    yield* conversed(page, "hello", "First agent.");
    yield* readOwnChat(page, "hello");

    yield* openConfigure(page);
    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    yield* page.until("the replacement control", (one) =>
      applyReads(one, "[start new conversation]"),
    );
    yield* applyConfigure(page);
    yield* drawerGone(page);
    yield* page.until("the new conversation starting empty", (one) =>
      one.shows("No messages yet."),
    );

    // The selector is cleared, so the reading is the new current chat — which
    // is the conversation the next message would go to anyway.
    expect(page.screen().shows("[Back to current chat]")).toBe(false);
    yield* conversed(page, "and you?", "Second agent.");
  });

  it("SS4: a failed replacement preserves the reading and the association", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Still the first.</Output>\n" });
    repl.fake.unavailable(OTHER_MOUNTED_AGENT, new Error("that agent will not start here"));

    yield* conversed(page, "hello", "First agent.");
    yield* readOwnChat(page, "hello");

    yield* openConfigure(page);
    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    yield* page.until("the replacement control", (one) =>
      applyReads(one, "[start new conversation]"),
    );
    yield* applyConfigure(page);
    yield* page.until("the reason in the drawer", () =>
      drawerShows(page.screen(), "will not start"),
    );
    yield* closeConfigure(page);

    // The reading is exactly where it was, and so is the association: this
    // conversation still takes a real message under the agent it was opened
    // with.
    expect(page.screen().shows("[Back to current chat]")).toBe(true);
    expect(headerNames(page.screen(), MOUNTED_AGENT)).toBe(true);
    yield* conversed(page, "still there?", "Still the first.");
  });
});

/**
 * Tier CFG — asking a failed request again (#883, CFG5).
 *
 * Retry resends the failed person's own request as a new message in the same
 * conversation. The old attempt stays exactly where it is, the new one gets its
 * own message id and its own turn association through the ordinary path, and
 * nothing of the current composer goes with it.
 */
/**
 * Tier CFG — one order for everything one conversation writes (#883, CFG8).
 *
 * Replies, their records and a preference somebody saves all reach the same
 * file through the same writer. What these rows add to the writer's own order
 * is the root's side of it: which conversation a save belongs to, and what one
 * explicit job does to another.
 */
describe("Tier CFG — one order for everything this conversation writes", () => {
  const ADVERTISED = {
    model: {
      selected: "balanced",
      choices: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
      ],
    },
    effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
  } as const;

  it("CFG8: a save queues behind the reply being written, and both land in order", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Written down.</Output>\n" });

    // One read first, so the drawer has this conversation's choices while the
    // reply below is being written.
    yield* conversed(page, "hello", "Written down.");
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["balanced"]);
    yield* closeConfigure(page);

    // The record the next reply is written as, held open inside the host: the
    // writer is genuinely occupied by somebody else's append.
    const writing = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"response"'),
    );
    repl.fake.script({ reply: "<Output>And this one.</Output>\n" });
    yield* sendMessage(page, "again");
    yield* writing.started();

    // A preference applied while that write is in flight. It is admitted —
    // a save is a record of this history rather than work the conversation
    // does — and it waits for the writer rather than overtaking it.
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["fast"]);
    yield* chooseNamed(page, "fast");
    yield* applyConfigure(page);
    yield* lingering();
    // Nothing of it reached the file while the other append was inside the
    // host, and the held write is still held.
    expect(yield* savedPreference(repl)).toBe(undefined);
    expect(writing.released).toBe(false);

    writing.release();
    yield* page.until("the reply that was being written", (one) => one.shows("And this one."));
    yield* awaitedFact("the preference landing", function* (): Operation<boolean> {
      return (yield* savedPreference(repl)) !== undefined;
    });

    // One order, on disk: the response that was being written, and then the
    // preference that waited for it. Read back through the projection, so this
    // is the history as everything else reads it.
    const read = yield* settledReading(repl);
    const kinds = read.chat.map((record) => record.kind);
    expect(kinds.indexOf("preferences")).toBeGreaterThan(kinds.lastIndexOf("response"));
    expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
    expect(read.chat.filter((record) => record.kind === "response")).toHaveLength(2);
  });

  it("CFG8: a replacement owns the drawer while it runs, and rebinds what Apply saves", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ held: true, reply: "<Output>Never seen.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    // One conversation with a preference of its own, saved while it is idle —
    // and read while it is idle, because inspection is something a working
    // conversation cannot do.
    yield* conversed(page, "hello", "First agent.");
    yield* openConfigure(page);
    yield* offeredChoice(page, NAMED["fast"]);
    yield* chooseNamed(page, "fast");
    yield* applyConfigure(page);
    yield* awaitedFact("the first conversation's preference", function* (): Operation<boolean> {
      return (yield* savedPreference(repl)) !== undefined;
    });
    yield* drawerGone(page);
    const first = yield* settledReading(repl);
    const before = first.chat.filter((record) => record.kind === "preferences");
    expect(before).toHaveLength(1);
    const owning = before[0]?.kind === "preferences" ? before[0].conversation : undefined;
    expect(owning).toBeDefined();

    // Then a turn in flight, so the replacement below really has something to
    // stop.
    yield* sendMessage(page, "again");
    yield* repl.fake.holdingTurns(1);

    // A replacement started and held inside its own Stop: this job owns the
    // drawer while it runs.
    const cancelling = repl.fake.holdCancellation();
    try {
      yield* openConfigure(page);
      yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
      yield* page.until("the control saying it stops first", (one) =>
        applyReads(one, "[stop and start new conversation"),
      );
      yield* applyConfigure(page);
      yield* cancelling.reached;

      // The name typed back, so the drawer offers a save again — and that save
      // is refused, in the drawer, because the replacement is the one explicit
      // thing this Sidekick is doing. The field still has the keystrokes from
      // the replacement above, so this types over what it holds.
      yield* retypeAgent(page, MOUNTED_AGENT);
      yield* page.until("Apply being offered again", (one) => applyReads(one, "[apply]"));
      yield* applyConfigure(page);
      yield* page.until("the refusal the drawer gives", () =>
        // The beginning of it, which is what this pane's width holds.
        drawerShows(page.screen(), "the Sidekick is already doing"),
      );
      const during = yield* settledReading(repl);
      expect(during.chat.filter((record) => record.kind === "preferences")).toHaveLength(1);

      cancelling.release();
      // The replacement finishes, and leaves this drawer open: the name in its
      // field is not the agent that was set up any more, so the outcome is not
      // the one this drawer asked for and it does not close on it.
      yield* page.until("the new conversation in the drawer", () =>
        drawerShows(page.screen(), "Requested: none"),
      );
      yield* closeConfigure(page);
      yield* page.until("the new agent in the pane", (one) =>
        headerNames(one, OTHER_MOUNTED_AGENT),
      );
    } finally {
      cancelling.release();
    }

    // The new conversation starts with nothing requested — the old agent's
    // preference is not its — and a save made now belongs to it.
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* openConfigure(page);
    yield* page.until("nothing requested", () => drawerShows(page.screen(), "Requested: none"));
    yield* offeredChoice(page, NAMED["balanced"]);
    yield* chooseNamed(page, "balanced");
    yield* applyConfigure(page);
    yield* awaitedFact("the second conversation's preference", function* (): Operation<boolean> {
      const read = yield* settledReading(repl);
      return read.chat.filter((record) => record.kind === "preferences").length === 2;
    });

    const after = yield* settledReading(repl);
    const saved = after.chat.flatMap((record) =>
      record.kind === "preferences"
        ? [{ conversation: record.conversation, model: record.model }]
        : [],
    );
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ conversation: owning, model: "fast" });
    // Its own conversation, and its own model: one history, two conversations,
    // and a preference belongs to exactly one of them.
    expect(saved[1]?.model).toBe("balanced");
    expect(saved[1]?.conversation).not.toBe(owning);
  });
});

describe("Tier CFG — Retry for a request whose turn failed", () => {
  it("CFG5: Retry sends the saved request again, not whatever is in the box", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    // A turn the backend takes and then reports as failed: the request was
    // accepted, so the history knows which turn it became and that it failed.
    repl.fake.script({ reply: "", stopReason: "refusal" });
    repl.fake.script({ reply: "<Output>Second time lucky.</Output>\n", held: true });
    repl.fake.script({ reply: "<Output>Queued Retry finished.</Output>" });

    yield* sendMessage(page, "inspect it");
    const failed = yield* page.until("the failed attempt and its retry", (one) =>
      retryOffered(one),
    );
    expect(retryOffered(failed)).toBe(true);
    yield* page.until("failure queue hold", (one) => one.shows("[Resume queue]"));
    yield* page.press("[Resume queue]");
    yield* page.until("explicit failure release", (one) => !one.shows("[Resume queue]"));

    // Unrelated newer text in the box, and a newer draft edit: neither is what
    // Retry sends, and neither is consumed by it.
    // The send left the keystrokes in the composer, so this needs no route.
    yield* typed(page, "something else");
    yield* draftText(page, "mine", ["Tab", "Tab", "Tab", "Tab"]);

    // A second explicit Retry waits behind the first; it consumes no newer text.
    yield* page.press("[retry]");
    yield* repl.fake.holdingTurns(1);
    yield* page.until("active Retry", (one) => one.shows("[stop]"));
    yield* page.press("[retry]");
    yield* page.until("Retry accepted while busy", (one) => one.shows("QUEUE 1/16"));
    expect(repl.fake.prompts).toHaveLength(2);
    repl.fake.releaseTurn();
    yield* page.until("the queued Retry being answered", (one) =>
      one.shows("Queued Retry finished."),
    );

    // Both explicit retries carry the saved literal text.
    const read = yield* settledReading(repl);
    const asked = read.chat.filter((record) => record.kind === "message");
    expect(asked).toHaveLength(3);
    expect(asked.map((record) => (record.kind === "message" ? record.text : ""))).toEqual([
      "inspect it",
      "inspect it",
      "inspect it",
    ]);
    // In the same conversation, so it is the same agent being asked again.
    const conversations = new Set(
      asked.map((record) => (record.kind === "message" ? record.conversation : "")),
    );
    expect(conversations.size).toBe(1);
    // Each explicit accepted Retry starts exactly once.
    expect(repl.fake.prompts).toHaveLength(3);
    expect(repl.fake.prompts[1]).toContain("inspect it");
    expect(repl.fake.prompts[1]).not.toContain("something else");

    // And the texts a person had typed are still theirs: Retry sent neither and
    // cleared neither.
    expect(composerHolds(page.screen(), "something else")).toBe(true);
    expect(draftHolds(page.screen(), "mine")).toBe(true);
  });

  it("CFG5: a message that worked retires the retry an older failure left", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.script({ reply: "", stopReason: "refusal" });
    repl.fake.script({ reply: "<Output>This one worked.</Output>\n" });

    yield* sendMessage(page, "inspect it");
    // Offered first, which is what makes the rest of this row a transition
    // rather than a control that was never there.
    yield* page.until("the failed attempt and its retry", (one) => retryOffered(one));

    yield* page.until("failure queue hold", (one) => one.shows("[Resume queue]"));
    yield* page.press("[Resume queue]");
    yield* page.until("explicit failure release", (one) => !one.shows("[Resume queue]"));

    // Something else asked, and answered. The failure is still in the history
    // and still readable, but it is behind a reply now: resending it would put
    // it out of order with what the agent has already been told.
    yield* sendMessage(page, "try this");
    yield* page.until(
      "the later reply, with the older retry retired",
      (one) => one.shows("This one worked.") && sidekickIdle(one) && !retryOffered(one),
    );
    expect(page.screen().shows("[retry]")).toBe(false);
    // The attempt itself was kept: this is about what is offered, not about
    // rewriting what happened.
    const read = yield* settledReading(repl);
    expect(read.chat.filter((record) => record.kind === "message")).toHaveLength(2);
    expect(page.screen().shows("(unfinished)")).toBe(true);
    expect(repl.fake.prompts).toHaveLength(2);
  });

  it("CFG5: a request whose acceptance cannot be established is not offered again", function* () {
    // The history a *process* left behind, produced by the recovery phases
    // rather than written by hand: a message that landed, and the canonical
    // record of the turn it became that never did. The provider may well have
    // taken that turn, and nothing here may decide that it did not.
    const root = yield* createRepositoryRoot();
    // Registered before the work it guards, so the root is removed even where
    // this row is halted: a `finally` that suspends is not guaranteed to run
    // to completion once the operation it sits in has been cancelled.
    yield* ensure(() => root.discard());
    {
      yield* runPhase("chat-open", root, "chat");
      const stopped = yield* runPhase(
        "chat-say",
        root,
        "chat",
        JSON.stringify({
          replies: ["<Output>Never recorded.</Output>\n"],
          stop: "turn",
          say: "inspect it",
        }),
      );
      // The turn really was accepted by that provider before the process died.
      expect(stopped.accepted).toBe(1);

      const before = yield* until(
        readFile(join(root.repository, PAIRED_DIRECTORY, "chat", SIDEKICK_FILE), "utf8"),
      );
      const page = yield* useReplPage({
        dataRoot: root.data,
        location: "xmd://repl/chat/entries",
      });
      const repl = page.repl;

      // The request is in the chat, and the attempt nobody finished is said as
      // one — but there is no control to ask it again, because this history
      // cannot say whether the agent already has it. A control that refused
      // when it was pressed would be offering a decision nothing can make.
      yield* page.until("the chat this history holds", (one) => one.shows("inspect it"));
      expect(page.screen().shows("[retry]")).toBe(false);
      expect(retryOffered(page.screen())).toBe(false);

      // And reading it cost nothing: no turn, no session, and not one byte
      // added to the file it was read from.
      expect(repl.fake.prompts).toEqual([]);
      expect(repl.fake.ensured).toEqual([]);
      expect(
        yield* until(
          readFile(join(root.repository, PAIRED_DIRECTORY, "chat", SIDEKICK_FILE), "utf8"),
        ),
      ).toBe(before);
    }
  });

  it("CFG5: control — with no failed request, nothing offers a retry", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.script({ reply: "<Output>That worked.</Output>\n" });

    yield* conversed(page, "inspect it", "That worked.");

    // A request that was answered has nothing to ask again, so there is no
    // control for it at all.
    expect(page.screen().shows("[retry]")).toBe(false);
    expect(retryOffered(page.screen())).toBe(false);
    expect(repl.fake.prompts).toHaveLength(1);
  });
});

/**
 * Tier TE — both configured agents, actually running (#883, J9).
 *
 * The grammar rows above prove which name each flag settles, and C1/C2 prove
 * that a malformed one is refused before anything starts. What remained is the
 * runtime half: that an entry's own Agent work really goes to the entry
 * selection while the Sidekick's turn really goes to its own, in one command
 * holding both. Which agent a turn reached is read off the provider's records —
 * the session each turn names, and the agent that session was established for —
 * rather than off the flags that asked for it.
 *
 * This is layered evidence, and that is what it states: one subprocess
 * exercising every flag and the interactive screen at once is not this row.
 */
describe("Tier TE — the two configured agents each do their own work", () => {
  /** One entry asking one Agent, naming no agent: the default is the subject. */
  const ASKING = ['<Session name="planner">', '<Prompt text="ok?" />', "</Session>"].join("\n");

  /** What that Agent answers, short enough to read on the transcript's row. */
  const ANSWERED = "The planner answered.";

  it("TE3: the entry uses its unstated default and the Sidekick its own selection", function* () {
    // Two selections on one line, settled the way the flags settle them: the
    // entry default through `resolveAgentStack`, the Sidekick's through
    // `assembleReplProfile`.
    const page = yield* useReplPage({
      defaultAgent: MOUNTED_AGENT,
      sidekickAgent: OTHER_MOUNTED_AGENT,
    });
    const repl = page.repl;

    // Acquiring the screen asks nobody anything. A selection that opened a
    // conversation to prove itself would have sent a prompt no one asked for.
    expect(repl.fake.ensured).toHaveLength(0);
    expect(repl.fake.turns).toHaveLength(0);

    // One ordinary entry asking one Agent, with no agent named in it: the
    // default is what is under test, and naming it here would bypass it.
    repl.fake.script({ reply: `${ANSWERED}\n` });
    yield* pasteDraft(page, ASKING);
    yield* page.key("Enter");
    yield* page.until("the entry's own Agent answering", (one) => one.shows(ANSWERED));

    // Then a Sidekick message, which is the other selection's own turn.
    repl.fake.script({ reply: "<Output>Sidekick here.</Output>\n" });
    yield* conversed(page, "hello", "Sidekick here.");

    // Which agent each turn actually reached, in the order the turns happened.
    const agentOf = new Map(repl.fake.ensured.map((one) => [one.sessionKey, one.agent]));
    const reached = repl.fake.turns.map((turn) => agentOf.get(turn.handle.sessionKey));
    expect(reached).toEqual([MOUNTED_AGENT, OTHER_MOUNTED_AGENT]);

    // Two different sessions for two different agents, neither standing in for
    // the other.
    expect(repl.fake.ensured.map((one) => one.agent)).toEqual([MOUNTED_AGENT, OTHER_MOUNTED_AGENT]);
    const keys = new Set(repl.fake.ensured.map((one) => one.sessionKey));
    expect(keys.size).toBe(2);

    // And both results really came back: the entry rendered its Agent's answer,
    // and the Sidekick's chat holds its own reply.
    yield* awaitedFact("the entry's record", function* (): Operation<boolean> {
      const held = yield* settledReading(repl);
      return held.model.entries[0]?.terminal?.output?.includes(ANSWERED) === true;
    });
    const read = yield* settledReading(repl);
    expect(read.model.entries).toHaveLength(1);
    expect(read.model.entries[0]?.terminal?.output).toContain(ANSWERED);
    // Read by the attribution mark this pane spells its origins with: the
    // staged chat is one list of utterances, so who said a row is a mark in
    // front of it rather than a name prefix inside the words.
    expect(saidBySidekick(page.screen(), "Sidekick here.")).toBe(true);
  });
});

/**
 * Configure's notices, fitted to the drawer that has to hold them.
 *
 * A drawer row is one row, and a notice is a sentence somebody has to be able
 * to read. What decides how many rows it takes is the engine, at the interior
 * this frame measured and on the original graphemes — not a count of code
 * units in a builder that has never seen a cell. Measured before this root
 * existed: a seventy-character ASCII token inside a thirty-cell drawer was
 * drawn as nothing at all, and twelve spaced CJK words came back as one
 * forty-eight cell row in the same thirty.
 *
 * The notice a person can actually produce here is the one about replacing an
 * agent, because the name in it is theirs: it is typed into the drawer's own
 * field, so these rows drive the width of a notice the way a person does.
 */
describe("Configure notice fitting", () => {
  /** What the agent in these rows advertises, so the drawer has choices to draw. */
  const ADVERTISED = {
    model: {
      selected: "balanced",
      choices: [
        { id: "balanced", name: "Balanced", description: "Even-handed." },
        { id: "fast", name: "Fast", group: { id: "speed", name: "Speed" } },
      ],
    },
    effort: {
      balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] },
      fast: {
        selected: "low",
        choices: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
      },
    },
  } as const;

  it("the whole of a long unbroken token is drawn, inside the drawer's own rows", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    yield* page.until("the Sidekick at rest", sidekickIdle);
    yield* sendMessage(page, "hello");
    yield* page.until(
      "the first turn over",
      (one) => saidByPerson(one, "hello") && sidekickIdle(one),
    );
    yield* openConfigure(page);
    // The drawer as it stands before any of this: its own way out, the way to
    // apply a choice and the way to read the agent again.
    expect(page.screen().shows("[close]")).toBe(true);
    expect(page.screen().shows("[apply]")).toBe(true);
    expect(page.screen().shows("[refresh]")).toBe(true);

    // Seventy characters with nothing to break on, inside an interior of
    // thirty: the notice has to be paid out over rows, and every one of its
    // characters has to be on one of them.
    const LONG = "x".repeat(70);
    yield* clearAgentField(page);
    yield* page.type(LONG);
    yield* noticed(page, `${LONG} has its own settings.`);

    // And none of it is drawn outside the drawer. A row reaching past the
    // drawer's own width is a row written over the pane behind.
    const width = page.screen().size.columns - page.screen().locate("[close]").column;
    expect(width).toBeGreaterThan(0);
    for (const row of drawerLines(page.screen())) {
      expect(row.length).toBeLessThanOrEqual(width);
    }
    expect(outside(page).filter((row) => row.includes("x".repeat(8)))).toEqual([]);

    // The way out and the way to read again are where they were, and a name
    // this long has not moved them: fitting a sentence moves no control. Apply
    // is deliberately not among them while a replacement is what it would do —
    // that is this drawer's established semantics, not an effect of fitting.
    expect(page.screen().shows("[close]")).toBe(true);
    expect(page.screen().shows("[refresh]")).toBe(true);
    expect(applyReads(page.screen(), "[start new conversation]")).toBe(true);
  });

  it("wide, combining and joined graphemes survive, and a shorter notice erases the longer", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    // One message first, so this conversation has an agent of its own: the
    // notice these rows are about is the one that says a *replacement* would
    // start another conversation, and there is nothing to replace until then.
    yield* sendMessage(page, "hello");
    yield* page.until(
      "the first turn over",
      (one) => saidByPerson(one, "hello") && sidekickIdle(one),
    );
    yield* openConfigure(page);

    // Twelve spaced wide words, a doubly combined letter and a joined emoji.
    // Each is one grapheme that is not one cell, and none of them may be cut
    // apart, dropped, or left behind when the notice that carries them goes.
    const WIDE = `${"界界 ".repeat(12).trim()} é́ \u{1F469}‍\u{1F4BB}`;
    yield* clearAgentField(page);
    yield* page.type(WIDE);
    // Recovered as the grid can hold it: a cell carries a base character, and
    // the zero-width joiner and the combining marks are not cells of their own.
    // Every wide word is there, in order, and so is the whole of the sentence
    // the name is in — which is what the builder this replaced drew none of.
    const DRAWN = `${"界界 ".repeat(12).trim()} e \u{1F469}\u{1F4BB} has its own settings.`;
    yield* noticed(page, DRAWN);

    // Paid out over the drawer's own rows rather than clipped to one: the
    // builder this replaced gave a notice this long a single row.
    const wide = drawerLines(page.screen());
    expect(wide.filter((row) => row.includes("界")).length).toBeGreaterThan(1);
    for (const row of wide) {
      expect(row.length).toBeLessThanOrEqual(
        page.screen().size.columns - page.screen().locate("[close]").column,
      );
    }
    expect(outside(page).filter((row) => row.includes("界"))).toEqual([]);
    // Each cluster is whole where it is drawn, in the form the grid holds: the
    // base character occupies its cells and the zero-width joiner and the
    // combining marks occupy none of their own. `DRAWN` above is that form,
    // and recovering the whole of it is this assertion.

    // Replaced by a short name: every cell the long one occupied is blank or
    // the new notice's, rather than a tail of the old one left underneath.
    yield* retypeAgent(page, "ag");
    yield* noticed(page, "ag has its own settings.");
    const after = drawerLines(page.screen());
    expect(after.filter((row) => row.includes("界"))).toEqual([]);
    expect(after.filter((row) => row.includes("\u{1F469}"))).toEqual([]);

    // Closing still chooses nothing: no preference was written by any of this.
    yield* closeConfigure(page);
    expect(page.screen().shows("[apply]")).toBe(false);
    expect(yield* savedPreference(repl)).toBe(undefined);
  });

  it("Backspace removes one grapheme, not one code point", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const repl = page.repl;
    repl.fake.configuration(ADVERTISED);
    yield* openConfigure(page);
    yield* replaceAgent(page, "a");

    // A letter under two combining marks and a joined emoji are each one thing
    // on this screen and three code points underneath. One press takes one of
    // them away whole. A reduction counting code points took the laptop off
    // the woman and left her standing, and removed one accent from the letter
    // and left the letter — so the row below each press is what discriminates.
    //
    // Read as the recorded grid holds them: a cell carries the base character,
    // and the zero-width joiner and the combining marks are not cells of their
    // own. What is compared is therefore the cluster being there and then
    // being gone in one press, not the code points it is spelled with.

    yield* page.type("\u{1F469}‍\u{1F4BB}");
    yield* page.until(
      "the joined emoji typed",
      () => agentName(page.screen()) === "a\u{1F469}\u{1F4BB}",
    );
    expect(agentName(page.screen())).toBe("a\u{1F469}\u{1F4BB}");
    yield* page.key("Backspace");
    yield* page.until("the joined emoji gone in one press", () => agentName(page.screen()) === "a");
    expect(agentName(page.screen())).toBe("a");

    yield* page.type("é́");
    yield* page.until("the accented letter typed", () => agentName(page.screen()) === "ae");
    expect(agentName(page.screen())).toBe("ae");
    yield* page.key("Backspace");
    yield* page.until(
      "the accented letter gone in one press",
      () => agentName(page.screen()) === "a",
    );
    expect(agentName(page.screen())).toBe("a");
  });
});
