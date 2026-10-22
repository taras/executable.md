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
import { ensure, Ok, scoped, spawn } from "effection";
import type { Operation, Result, Task } from "effection";

import { DEFAULT_AGENT_NAME } from "@executablemd/acp";
import { API } from "@executablemd/runtime";

import { resolveAgentStack } from "../src/agent-stack.ts";
import { SCROLL_DOWN } from "../src/repl/application.ts";
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
  activate,
  appendGate,
  awaited,
  awaiting,
  click,
  clickAt,
  coordinateOf,
  draftText,
  focusDraft,
  focusedField,
  focusedOn,
  focusMessage,
  focusOn,
  MESSAGE_PROMPT,
  messageText,
  MOUNTED_AGENT,
  mountedReading,
  OTHER_MOUNTED_AGENT,
  replay,
  resizeTo,
  panePresented,
  screenOf,
  sendMessage,
  settled,
  shows,
  typing,
  useMountedRepl,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import type { MountedRepl } from "./fixtures/repl/issue-883/mounted-program.ts";
import {
  PAIRED_DIRECTORY,
  readSidekickRecords,
  SIDEKICK_FILE,
} from "../src/repl/sidekick/history.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "effection";

/**
 * The outer envelope of the pane that owns the Sidekick's drawers, by width.
 *
 * Stated from the accepted table rather than asked of the product: the space
 * after the sidebar is shared equally and the spare cell of an odd remainder
 * goes to the Transcript, so the right column begins at 96 of 160 and 74 of
 * 120. A helper that read `inspectionWidth` would agree with the product
 * however it drifted.
 */
function paneEnvelope(columns: number): number {
  if (columns >= 160) {
    return 96;
  }
  return columns >= 120 ? 74 : 0;
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
/**
 * Wait for something only the files can answer, within a bound.
 *
 * The screen's own `awaited` takes a predicate it can call; what these rows are
 * waiting for is a record on disk, which is read with an operation.
 */
function* landed(what: string, check: () => Operation<boolean>): Operation<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (yield* check()) {
      return;
    }
    yield* settled(20);
  }
  throw new Error(`${what} never happened`);
}

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

  /**
   * Open Configure from the pane's own header.
   *
   * Waited for in the frames drawn *since* the click rather than anywhere on
   * the screen: this renderer writes diffs, so a replayed buffer still holds
   * the cells an earlier opening drew, and a wait on those would be satisfied
   * before the drawer had reopened at all.
   */
  function* configure(repl: MountedRepl): Operation<void> {
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    // Settled rather than awaited on a cell. Opening the drawer is pure state —
    // the frame that follows the click draws it — and the inspection it asks
    // for is separate work that does not gate it. A wait on a drawn cell cannot
    // tell this opening from the one before it: the renderer writes diffs, so a
    // row that is already in the right place is not written again.
    yield* settled(60);
    expect(shows(repl.terminal, "[refresh]")).toBe(true);
  }

  /** Close whichever of the Sidekick's drawers is open, and wait for its pane. */
  function* closeDrawer(repl: MountedRepl): Operation<void> {
    const from = repl.terminal.presented.length;
    yield* click(repl.terminal, "[close]", paneEnvelope(repl.terminal.size.columns));
    yield* awaited("the drawer closing", () =>
      replay(repl.terminal.presented.slice(from)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
      ),
    );
  }

  it("CFG1: Configure shows what the agent really offers, and nothing asks before it", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    // Their own text in both composers first, which none of this may touch.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "later");

    // Before opening it: nothing inspected, nothing established, nothing
    // written. Looking at the pane, changing tabs and resizing all cost
    // nothing.
    expect(repl.fake.configCalls).toEqual([]);
    expect(repl.fake.ensured).toEqual([]);
    // A fresh execution publishes its pair when it is created, so what "no
    // writes" means here is no *chat*: the two publication records and nothing
    // else. A preference or a message would be a third.
    expect((yield* chatKinds(repl)).length).toBe(2);
    yield* activate(repl.terminal, "Bindings");
    yield* awaiting(
      repl.terminal,
      "Bindings being selected",
      (one) => panePresented(one) === "bindings",
    );
    yield* resizeTo(repl.terminal, { columns: 120, rows: 30 });
    yield* resizeTo(repl.terminal, { columns: 160, rows: 36 });
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the Sidekick back", (one) => shows(one, "[send]"));
    expect(repl.fake.configCalls).toEqual([]);
    expect(repl.fake.ensured).toEqual([]);

    // Opening it is the explicit act that reads, and it reads through the
    // provider rather than from anything remembered.
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the models this agent advertised", (one) =>
      shows(one, "Balanced"),
    );
    // The provider's own words: its names, its descriptions and the heading it
    // filed a choice under.
    expect(shows(repl.terminal, "Even-handed.")).toBe(true);
    expect(shows(repl.terminal, "Speed · Fast")).toBe(true);
    // And no turn: an inspection takes a session of its own and sends nothing.
    expect(repl.fake.prompts).toEqual([]);
    // Nothing has been asked for yet, and nothing has been verified.
    expect(shows(repl.terminal, "Requested: none")).toBe(true);
    expect(shows(repl.terminal, "Verified: none")).toBe(true);

    // Both composers still hold exactly what was typed into them.
    yield* closeDrawer(repl);
    expect(draftText(repl.terminal)).toBe("mine");
    expect(messageText(repl.terminal).includes("later")).toBe(true);
  });

  it("CFG2: a chosen model brings its own effort levels, and Apply saves them", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Under the new settings.</Output>\n" });

    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    // Nothing is selected and nothing is requested, so there is no effort
    // section at all: effort belongs to a model, and none has been chosen.
    expect(shows(repl.terminal, "Effort")).toBe(false);

    // One model, chosen through its own control.
    yield* click(repl.terminal, "( ) Speed", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being selected", (one) => shows(one, "(x) Speed"));
    // Its levels have not been read, and nothing is invented from the model
    // before it: this says so rather than offering another model's list.
    expect(shows(repl.terminal, "Effort for fast")).toBe(true);
    expect(shows(repl.terminal, "Medium")).toBe(false);

    // Read explicitly, for the model selected now.
    yield* click(repl.terminal, "[refresh]", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "this model's own levels", (one) => shows(one, "High"));
    // `fast`'s levels, which `balanced` does not have.
    expect(shows(repl.terminal, "Low")).toBe(true);
    expect(shows(repl.terminal, "Medium")).toBe(false);
    yield* click(repl.terminal, "( ) High", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the level being selected", (one) => shows(one, "(x) High"));

    // Closed without applying: nothing was saved, so reopening starts from the
    // saved preference again rather than from what was chosen and abandoned.
    yield* closeDrawer(repl);
    expect((yield* chatKinds(repl)).includes("preferences")).toBe(false);
    yield* configure(repl);
    // Nothing of what was chosen and abandoned: no model marked, and still no
    // request saved.
    expect(shows(repl.terminal, "(x) Speed")).toBe(false);
    expect(shows(repl.terminal, "Requested: none")).toBe(true);

    // Chosen again and applied, which saves and closes.
    yield* click(repl.terminal, "( ) Speed", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being selected", (one) => shows(one, "(x) Speed"));
    yield* click(repl.terminal, "[refresh]", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "this model's own levels", (one) => shows(one, "High"));
    yield* click(repl.terminal, "( ) High", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the level being selected", (one) => shows(one, "(x) High"));
    const askingBefore = repl.fake.configCalls.length;
    const applying = repl.terminal.presented.length;
    yield* click(repl.terminal, "[apply]", paneEnvelope(repl.terminal.size.columns));
    // Apply closes Configure on success, which is what says the preference was
    // acknowledged: a drawer still open would be one whose save had not landed.
    yield* awaited("Configure closing on success", () =>
      replay(repl.terminal.presented.slice(applying)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
      ),
    );

    // Saved, and nothing else: a preference is a record, so Apply asked the
    // agent for nothing and sent no turn.
    expect((yield* chatKinds(repl)).filter((kind) => kind === "preferences")).toHaveLength(1);
    expect(repl.fake.configCalls).toHaveLength(askingBefore);
    expect(repl.fake.prompts).toEqual([]);

    // Reopening shows what was saved, and says it is a request rather than
    // something an agent has run under.
    yield* configure(repl);
    // The label and the model, which is what the pane's width holds: the
    // assertion below reads the whole of what was saved out of the history,
    // where nothing clips it.
    yield* awaiting(repl.terminal, "the saved request", (one) =>
      shows(one, "Requested: model=fast"),
    );
    // And the whole of what was saved, read out of the history rather than off
    // a row the pane's width may clip.
    expect(yield* savedPreference(repl)).toMatchObject({ model: "fast", effort: "high" });
    yield* closeDrawer(repl);

    // And the next real message is what applies it: the model first, read back,
    // then the effort, read back, all before the prompt. Counted from here,
    // because reopening the drawer above read the agent's choices again and
    // that read is not part of applying anything.
    const sending = repl.fake.configCalls.length;
    yield* sendMessage(repl, "go");
    yield* awaiting(repl.terminal, "the reply under the new settings", (one) =>
      shows(one, "Under the new settings."),
    );
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
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the verified settings", (one) =>
      shows(one, "Verified: model=fast"),
    );
  });

  it("CFG2: a stale inspection cannot replace a newer selection", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* click(repl.terminal, "( ) Speed", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being selected", (one) => shows(one, "(x) Speed"));

    // One inspection held open, for `fast`.
    const holding = repl.fake.holdStatus();
    yield* click(repl.terminal, "[refresh]", paneEnvelope(repl.terminal.size.columns));
    yield* holding.reached;

    // The selection moves underneath it, to a model whose levels this read is
    // not about.
    yield* click(repl.terminal, "( ) Balanced", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the other model being selected", (one) =>
      shows(one, "(x) Balanced"),
    );

    holding.release();
    // Waited for the held read to be *applied*, not for a row that was already
    // there: the reading notice is drawn while it is in flight, so its going
    // away is the moment this result reached the drawer. A predicate about the
    // selection would have been true before the release and would prove
    // nothing about what the answer did.
    yield* awaiting(
      repl.terminal,
      "the stale read being applied",
      (one) => shows(one, "Effort for balanced") && !shows(one, "Reading what this agent"),
    );
    // It changed nothing it should not: it is an answer about `fast`, and
    // `fast` is not what is selected any more. No level from it is offered
    // under the model that is, and the drawer is where the person left it.
    expect(shows(repl.terminal, "High")).toBe(false);
    expect(shows(repl.terminal, "( ) Low")).toBe(false);
    expect(shows(repl.terminal, "(x) Balanced")).toBe(true);
  });

  it("CFG2: control — a read of the selected model offers that model's own levels", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* click(repl.terminal, "( ) Speed", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being selected", (one) => shows(one, "(x) Speed"));

    // The same held read, released with the selection left where it was. This
    // is the discriminating half: the levels do arrive, so the row above is
    // about ownership rather than about reads never being applied at all.
    const holding = repl.fake.holdStatus();
    yield* click(repl.terminal, "[refresh]", paneEnvelope(repl.terminal.size.columns));
    yield* holding.reached;
    holding.release();
    // Once the levels are known the heading is just "Effort": the "Effort for
    // <model>: not read yet." sentence is what stands in for a list nobody has.
    yield* awaiting(
      repl.terminal,
      "the read being applied",
      (one) => shows(one, "( ) High") && !shows(one, "Reading what this agent"),
    );
    expect(shows(repl.terminal, "( ) Low")).toBe(true);
    expect(shows(repl.terminal, "not read yet")).toBe(false);
  });

  it("CFG2: an inspection in flight refuses a new message instead of retaining one", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Should never be asked.</Output>\n" });

    // One explicit inspection admitted and held open, with the drawer closed
    // again behind it: what stands in the way is the job, not the drawer.
    const holding = repl.fake.holdStatus();
    try {
      yield* configure(repl);
      yield* holding.reached;
      yield* closeDrawer(repl);

      // Send, while that job is still the one thing the Sidekick is doing.
      yield* focusMessage(repl.terminal);
      yield* typing(repl.terminal, "during");
      yield* click(repl.terminal, "[send]", paneEnvelope(repl.terminal.size.columns));
      yield* awaiting(repl.terminal, "the refusal Send is given", (one) =>
        shows(one, "already doing something you asked for"),
      );

      // Refused before anything was retained: no person message in the
      // history, nothing asked of the agent, and the text still in the box for
      // them to send when the inspection is done.
      const read = yield* mountedReading(repl);
      expect(read.chat.filter((record) => record.kind === "message")).toHaveLength(0);
      expect(repl.fake.prompts).toEqual([]);
      expect(messageText(repl.terminal).includes("during")).toBe(true);
    } finally {
      holding.release();
    }
  });

  it("CFG2: control — with no job admitted, the same Send is taken", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Asked and answered.</Output>\n" });

    // The same opening and closing of Configure, with its read allowed to
    // finish. This is what makes the row above about the admitted job rather
    // than about Configure having been opened at all.
    yield* configure(repl);
    yield* awaiting(
      repl.terminal,
      "the read finishing",
      (one) => shows(one, "Balanced") && !shows(one, "Reading what this agent"),
    );
    yield* closeDrawer(repl);

    yield* sendMessage(repl, "during");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Asked and answered."));
    const read = yield* mountedReading(repl);
    expect(read.chat.filter((record) => record.kind === "message")).toHaveLength(1);
    expect(repl.fake.prompts).toHaveLength(1);
  });

  it("CFG2: while a turn runs, effort cannot be refreshed but a model can be saved", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Hello back.</Output>\n" });
    // Generation held open, so the conversation is doing something throughout.
    repl.fake.script({ held: true, reply: "<Output>Done.</Output>\n" });

    // A conversation first, because choices belong to one: read before there is
    // a conversation and they are not this conversation's to keep.
    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "Hello back."));

    // Then one read, so there are advertised choices in hand for this exact
    // conversation when it goes busy.
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* closeDrawer(repl);

    yield* sendMessage(repl, "think");
    yield* repl.fake.holdingTurns(1);
    const asking = repl.fake.configCalls.length;

    // Opened while busy. The models already advertised for this conversation
    // stay usable, so one of them can still be chosen.
    yield* configure(repl);
    yield* click(repl.terminal, "( ) Speed", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being selected while busy", (one) =>
      shows(one, "(x) Speed"),
    );

    // Its effort levels have not been read, and they cannot be: an inspection
    // is something this conversation does one at a time, and the root refuses
    // it before the agent is reached. Said rather than filled in from another
    // model's list.
    expect(shows(repl.terminal, "Effort for fast")).toBe(true);
    expect(shows(repl.terminal, "Low")).toBe(false);
    yield* click(repl.terminal, "[refresh]", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(
      repl.terminal,
      "the refusal a busy refresh gives",
      // Said in the drawer that was pressed, and the beginning of the reason is
      // what this pane's width holds.
      (one) => shows(one, "the Sidekick is already working"),
    );
    // Nothing was asked of the agent by trying.
    expect(repl.fake.configCalls).toHaveLength(asking);

    // A model-only preference saves while the turn runs, with no effort
    // requested and no silent choice made for it.
    const applying = repl.terminal.presented.length;
    yield* click(repl.terminal, "[apply]", paneEnvelope(repl.terminal.size.columns));
    yield* awaited("the preference landing and Configure closing", () =>
      replay(repl.terminal.presented.slice(applying)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[stop]"),
      ),
    );
    expect(yield* savedPreference(repl)).toMatchObject({ model: "fast", effort: null });
    // And the turn in flight was not reconfigured under it.
    expect(repl.fake.configCalls).toHaveLength(asking);

    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the held turn finishing", (one) => shows(one, "Done."));
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
    const repl = yield* useMountedRepl({ gate });
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Ready.</Output>\n" });
    repl.fake.script({ reply: SUBMITS });
    repl.fake.script({ reply: "<Output>Both done.</Output>\n" });

    // A conversation, and one read of what it offers, so the drawer has
    // advertised choices for this conversation while it is busy.
    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "Ready."));
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* closeDrawer(repl);

    // The entry's own closing record, held open: the entry has run and has not
    // settled, so the reply's Submit is still waiting for its outcome.
    const closing = gate.holdNext(
      (path, record) => path.endsWith("entries.jsonl") && record.includes('"type":"close"'),
    );
    yield* sendMessage(repl, "run it");
    yield* closing.started();
    yield* awaiting(repl.terminal, "the entry's output", (one) => shows(one, "the entry ran"));
    const asking = repl.fake.configCalls.length;

    if (changing) {
      // Applied while the entry is held. A preference is a record, so this asks
      // the agent for nothing and stops nothing.
      yield* configure(repl);
      yield* click(repl.terminal, "( ) Speed", paneEnvelope(repl.terminal.size.columns));
      yield* awaiting(repl.terminal, "the model being chosen while the entry waits", (one) =>
        shows(one, "(x) Speed"),
      );
      const applying = repl.terminal.presented.length;
      yield* click(repl.terminal, "[apply]", paneEnvelope(repl.terminal.size.columns));
      yield* awaited("the preference landing", () =>
        replay(repl.terminal.presented.slice(applying)).some(
          (line) => line.includes(MESSAGE_PROMPT) || line.includes("[stop]"),
        ),
      );
      expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
      // Nothing of the agent's was touched by saving, and the entry is still
      // held: the save coexists with the work rather than interrupting it.
      expect(repl.fake.configCalls).toHaveLength(asking);
      expect(closing.released).toBe(false);
    }

    // Released: the entry settles, the Submit it was waiting for answers, and
    // the automatic turn that reports it runs.
    closing.release();
    yield* awaiting(repl.terminal, "the turn that follows the entry", (one) =>
      shows(one, "Both done."),
    );
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
    const repl = yield* useMountedRepl();
    // `null` from the provider: no model selector at all, which is a different
    // answer from a selector with nothing in it.
    repl.fake.configuration(undefined);

    yield* configure(repl);
    // Said in the pane's own width, which clips a longer sentence: what the row
    // asserts is the sentence this screen actually shows.
    yield* awaiting(repl.terminal, "Configure saying there is no choice", (one) =>
      shows(one, "offers no model"),
    );
    // Nothing fabricated: no empty list of models, and no effort section for a
    // model nobody selected.
    expect(shows(repl.terminal, "( )")).toBe(false);
    expect(shows(repl.terminal, "Effort")).toBe(false);
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
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    // Their own text in both composers, which closing a drawer may not touch.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");
    yield* activate(repl.terminal, "Sidekick");
    yield* awaiting(repl.terminal, "the message box taking focus", (one) =>
      focusedField(one, MESSAGE_PROMPT),
    );
    yield* typing(repl.terminal, "later");

    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    // A real choice, made and deliberately not applied: this is what the
    // discard rule below is about, and what a close that saved would save.
    yield* click(repl.terminal, "( ) Speed", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being selected", (one) => shows(one, "(x) Speed"));
    const asked = repl.fake.configCalls.length;
    const ensured = repl.fake.ensured.length;
    const records = (yield* chatKinds(repl)).length;

    const from = repl.terminal.presented.length;
    if (by === "escape") {
      // One Escape, through the real input path — no action dispatched here.
      repl.terminal.feed("\x1b");
    } else {
      // And the visible control, reached by real traversal and activated with
      // Enter. Read from the focus marker this screen committed rather than
      // from a count of presses: what owns Enter is what the frame says holds
      // focus.
      let reached = focusedOn(repl.terminal, "[close]");
      for (let press = 0; press < 48 && !reached; press += 1) {
        repl.terminal.feed("\t");
        yield* settled(20);
        reached = focusedOn(repl.terminal, "[close]");
      }
      expect(reached).toBe(true);
      repl.terminal.feed("\r");
    }
    yield* awaited("the drawer closing", () =>
      replay(repl.terminal.presented.slice(from)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
      ),
    );
    expect(shows(repl.terminal, "[refresh]")).toBe(false);

    // Nothing was saved and nobody was asked: closing is not applying.
    expect((yield* chatKinds(repl)).length).toBe(records);
    expect((yield* chatKinds(repl)).includes("preferences")).toBe(false);
    expect(yield* savedPreference(repl)).toBe(undefined);
    expect(repl.fake.configCalls).toHaveLength(asked);
    expect(repl.fake.ensured).toHaveLength(ensured);
    expect(repl.fake.prompts).toEqual([]);
    // Both composers hold exactly what was typed into them.
    expect(draftText(repl.terminal)).toBe("mine");
    expect(messageText(repl.terminal).includes("later")).toBe(true);
    // And focus is back on the one control this drawer is about, which is where
    // somebody who closed it is standing.
    expect(focusedOn(repl.terminal, `[configure ${MOUNTED_AGENT}]`)).toBe(true);

    // The choice went with the drawer: reopening starts from the saved
    // preference, which is the only thing a next turn would use.
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models again", (one) => shows(one, "Balanced"));
    expect(shows(repl.terminal, "(x) Speed")).toBe(false);
    expect(shows(repl.terminal, "Requested: none")).toBe(true);
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
    const repl = yield* useMountedRepl({ size: { columns: 120, rows: 30 } });
    // More models than this drawer draws at once, which is what puts choices
    // and Apply below the window.
    const many = Array.from({ length: 24 }, (_, at) => ({
      id: `model-${at + 1}`,
      name: `Model ${at + 1}`,
    }));
    repl.fake.configuration({ model: { selected: "model-1", choices: many }, effort: {} });
    repl.fake.script({ held: true, reply: "<Output>Done at last.</Output>\n" });

    const envelope = paneEnvelope(repl.terminal.size.columns);
    const scrollTo = function* (label: string): Operation<void> {
      for (
        let press = 0;
        press < 60 && coordinateOf(repl.terminal, label, envelope) === undefined;
        press += 1
      ) {
        yield* click(repl.terminal, SCROLL_DOWN, envelope);
        yield* settled(20);
      }
      expect(coordinateOf(repl.terminal, label, envelope)).toBeDefined();
    };

    // Opened without asserting its controls: with a list this long they are
    // below the window too, which is the state this row is about.
    const opening = function* (): Operation<void> {
      yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
      yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Model 1"));
    };
    yield* opening();
    const last = `( ) Model ${many.length}`;
    // Genuinely below the window before it is scrolled to.
    expect(coordinateOf(repl.terminal, last, envelope)).toBe(undefined);
    yield* scrollTo(last);
    yield* click(repl.terminal, last, envelope);
    yield* awaiting(repl.terminal, "the off-window model being selected", (one) =>
      shows(one, `(x) Model ${many.length}`),
    );
    // Apply is below the window too, which is the state this is about: the
    // window has been moved a long way, and the way out is still on the screen.
    yield* scrollTo("[apply]");
    expect(shows(repl.terminal, "[close]")).toBe(true);

    // Reached by real traversal from wherever that scrolling left focus.
    const closing = function* (): Operation<void> {
      const from = repl.terminal.presented.length;
      let reached = focusedOn(repl.terminal, "[close]");
      for (let press = 0; press < 64 && !reached; press += 1) {
        repl.terminal.feed("\t");
        yield* settled(20);
        reached = focusedOn(repl.terminal, "[close]");
      }
      expect(reached).toBe(true);
      repl.terminal.feed("\r");
      yield* awaited("the drawer closing", () =>
        replay(repl.terminal.presented.slice(from)).some(
          (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
        ),
      );
    };
    yield* closing();
    expect(shows(repl.terminal, "[apply]")).toBe(false);
    expect((yield* chatKinds(repl)).includes("preferences")).toBe(false);

    // Again, with a real message held in flight. Both composers hold their own
    // text across it, and the turn that is running is not what was dismissed.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "kept draft");
    yield* sendMessage(repl, "work on it");
    yield* repl.fake.holdingTurns(1);
    yield* awaiting(repl.terminal, "the Sidekick working", (one) => shows(one, "[stop]"));
    // Opened over a working Sidekick, which refuses to inspect while a turn is
    // running — so what is waited for is the drawer, not its choices. That
    // refusal is the established behaviour and is not what this row is about:
    // the question here is whether the way out is still reachable.
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* awaiting(repl.terminal, "the drawer over a working Sidekick", (one) =>
      shows(one, "[apply]"),
    );
    expect(shows(repl.terminal, "already working")).toBe(true);
    yield* closing();
    // The drawer is gone, the turn is not: nothing stopped it, and it finishes
    // on its own when the provider is released.
    expect(shows(repl.terminal, "[apply]")).toBe(false);
    expect(repl.outcome()).toBe(undefined);
    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the reply that was never stopped", (one) =>
      shows(one, "Done at last."),
    );
    expect(draftText(repl.terminal)).toBe("kept draft");
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

  function* configure(repl: MountedRepl): Operation<void> {
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    expect(shows(repl.terminal, "[refresh]")).toBe(true);
  }

  /** Type a different agent's name into the drawer's own field. */
  /** Close whichever of the Sidekick's drawers is open, and wait for its pane. */
  function* closeDrawer(repl: MountedRepl): Operation<void> {
    const from = repl.terminal.presented.length;
    yield* click(repl.terminal, "[close]", 96);
    yield* awaited("the drawer closing", () =>
      replay(repl.terminal.presented.slice(from)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
      ),
    );
  }

  function* name(repl: MountedRepl, agent: string): Operation<void> {
    yield* focusOn(repl.terminal, `> Agent: `);
    // Everything that is there now, removed a character at a time: this is the
    // field a person edits, and clearing it is how they replace a name.
    for (let press = 0; press < MOUNTED_AGENT.length; press += 1) {
      repl.terminal.feed("\x7f");
      yield* settled(8);
    }
    yield* typing(repl.terminal, agent);
  }

  it("CFG4: an idle replacement keeps the old chat and runs the next message under the new agent", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "First agent."));
    const before = repl.fake.prompts.length;

    yield* configure(repl);
    yield* name(repl, OTHER_MOUNTED_AGENT);
    // The control says what it will do, because a different agent is a
    // different conversation and somebody has to know that before pressing it.
    yield* awaiting(repl.terminal, "the control saying it starts a new conversation", (one) =>
      shows(one, "[start new conversation]"),
    );

    const applying = repl.terminal.presented.length;
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaited("Configure closing on a successful setup", () =>
      replay(repl.terminal.presented.slice(applying)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
      ),
    );

    // Switching sent no turn: a replacement opens a conversation, it does not
    // say anything in it.
    expect(repl.fake.prompts).toHaveLength(before);
    // The old chat is still in the history, and the new conversation starts
    // empty of it: what a person reads is the conversation they are in, and
    // nothing of the old one is replayed into its successor.
    expect(yield* chatKinds(repl)).toContain("message");
    yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
      shows(one, "No messages yet."),
    );

    // And the next explicit message really runs under the new agent.
    yield* sendMessage(repl, "and you?");
    yield* awaiting(repl.terminal, "the new agent's reply", (one) => shows(one, "Second agent."));
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
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    if (saving) {
      yield* click(repl.terminal, "( ) Fast", 96);
      yield* awaiting(repl.terminal, "the model being chosen", (one) => shows(one, "(x) Fast"));
      yield* click(repl.terminal, "[apply]", 96);
      yield* awaiting(repl.terminal, "the save closing Configure", (one) => shows(one, "[send]"));
      expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
      // Reopened deliberately, on the preference that was just saved.
      yield* configure(repl);
      yield* awaiting(repl.terminal, "the saved model in the reopened drawer", (one) =>
        shows(one, "(x) Fast"),
      );
    }

    yield* name(repl, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the control saying it starts a new conversation", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);

    // The new conversation was really activated — read from the history rather
    // than inferred from the screen.
    yield* landed("the new conversation being activated", function* (): Operation<boolean> {
      const read = yield* mountedReading(repl);
      return read.chat.some(
        (record) =>
          record.kind === "conversation" &&
          record.agent === OTHER_MOUNTED_AGENT &&
          record.phase === "activated",
      );
    });
    // And its success closed the drawer that asked for it, whatever the old
    // conversation's preference happened to be.
    yield* awaiting(repl.terminal, "Configure closing on the replacement", (one) =>
      shows(one, `[configure ${OTHER_MOUNTED_AGENT}]`),
    );
    expect(shows(repl.terminal, "[refresh]")).toBe(false);
  }

  it("CFG4: a replacement closes Configure although the old conversation had a preference", function* () {
    yield* replacing(true);
  });

  it("CFG4: control — the same replacement with no preference saved closes the same way", function* () {
    yield* replacing(false);
  });

  it("CFG4: a save still in flight cannot close a drawer whose agent was edited", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.configuration(ADVERTISED);

    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* click(repl.terminal, "( ) Fast", 96);
    yield* awaiting(repl.terminal, "the model being chosen", (one) => shows(one, "(x) Fast"));

    // The record this save writes, held open inside the host, so the answer
    // arrives after the drawer has moved on.
    const writing = gate.holdNext((_path, record) => record.includes('"kind":"preferences"'));
    try {
      yield* click(repl.terminal, "[apply]", 96);
      yield* writing.started();

      // Another agent typed into the field while it is in flight. The model and
      // the effort are untouched, so this is a drawer whose *values* still
      // match the Apply that is running.
      yield* name(repl, OTHER_MOUNTED_AGENT);
      yield* awaiting(repl.terminal, "the replacement being chosen", (one) =>
        shows(one, `Agent: ${OTHER_MOUNTED_AGENT}`),
      );

      writing.release();
      yield* landed("the preference landing", function* (): Operation<boolean> {
        return (yield* savedPreference(repl)) !== undefined;
      });
      yield* settled(60);

      // The save stands — this is not a rollback — and the drawer a person is
      // in the middle of is still theirs: still open, still naming the agent
      // they typed, and nothing of it applied by somebody else's answer.
      expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
      expect(shows(repl.terminal, "[refresh]")).toBe(true);
      expect(shows(repl.terminal, `Agent: ${OTHER_MOUNTED_AGENT}`)).toBe(true);
      // And no replacement happened: that is still something to press.
      expect(repl.fake.ensured.map((one) => one.agent)).not.toContain(OTHER_MOUNTED_AGENT);
      expect(shows(repl.terminal, "[start new conversation]")).toBe(true);
    } finally {
      writing.release();
    }
  });

  it("CFG4: a busy replacement stops the turn and joins it before the new agent", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    // Generation genuinely in flight, and the cancellation it will be sent held
    // open: this is what makes the join observable rather than inferred.
    repl.fake.script({ held: true, reply: "<Output>Never seen.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    yield* sendMessage(repl, "held message");
    yield* repl.fake.holdingTurns(1);
    const cancelling = repl.fake.holdCancellation();
    try {
      yield* configure(repl);
      // Stop is drawn inside the drawer that covers the pane. The pane's own
      // control is behind a modal, and a way to stop that somebody cannot
      // reach is not one.
      expect(shows(repl.terminal, "[stop]")).toBe(true);

      yield* name(repl, OTHER_MOUNTED_AGENT);
      // The choices read from the agent this conversation is with are not
      // offered for another one, and the drawer says why rather than leaving
      // controls that could do nothing.
      yield* awaiting(repl.terminal, "the other agent's own settings being said", (one) =>
        shows(one, "has its own settings"),
      );
      expect(shows(repl.terminal, "( ) Balanced")).toBe(false);
      expect(shows(repl.terminal, "Effort for")).toBe(false);
      yield* awaiting(repl.terminal, "the control saying it stops first", (one) =>
        shows(one, "[stop and start new conversation"),
      );

      const before = repl.fake.ensured.length;
      yield* click(repl.terminal, "[stop and start new conversation", 96);
      // It really asked the agent to stop, and it is waiting for that: nothing
      // of the replacement has been started while the cancellation is held.
      yield* cancelling.reached;
      expect(repl.fake.ensured.map((one) => one.agent)).not.toContain(OTHER_MOUNTED_AGENT);
      // A second activation of the same control while it waits starts no
      // second replacement: one explicit job at a time, reserved before the
      // first one was spawned.
      yield* click(repl.terminal, "[stop and start new conversation", 96);
      yield* settled(40);
      expect(repl.fake.ensured).toHaveLength(before);

      cancelling.release();
      // Joined, and only then set up: the new agent appears in the pane's own
      // header, and the conversation it opened is empty of the old one.
      yield* awaiting(repl.terminal, "the new agent after the join", (one) =>
        shows(one, `[configure ${OTHER_MOUNTED_AGENT}]`),
      );
      expect(repl.fake.ensured.map((one) => one.agent)).toContain(OTHER_MOUNTED_AGENT);
      yield* sendMessage(repl, "and you?");
      yield* awaiting(repl.terminal, "the new agent answering", (one) =>
        shows(one, "Second agent."),
      );
    } finally {
      cancelling.release();
    }
  });

  it("CFG4: a replacement leaves the entry the old conversation admitted running", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
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
    yield* sendMessage(repl, "run it");
    yield* closing.started();
    yield* awaiting(repl.terminal, "the entry's output", (one) => shows(one, "the entry ran"));

    yield* configure(repl);
    yield* name(repl, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the control saying it stops first", (one) =>
      shows(one, "[stop and start new conversation"),
    );
    yield* click(repl.terminal, "[stop and start new conversation", 96);
    yield* awaiting(repl.terminal, "the new agent after the join", (one) =>
      shows(one, `[configure ${OTHER_MOUNTED_AGENT}]`),
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
    yield* settled(40);
    expect(shows(repl.terminal, "the entry ran")).toBe(true);
    // And the new conversation is the one a message now goes to.
    yield* sendMessage(repl, "and you?");
    yield* awaiting(repl.terminal, "the new agent answering", (one) => shows(one, "Second agent."));
  });

  it("CFG4: an unreachable agent keeps the old association and says why", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Still the first.</Output>\n" });
    // The replacement cannot be started at all, which is what an unavailable
    // agent is.
    repl.fake.unavailable(OTHER_MOUNTED_AGENT, new Error("that agent will not start here"));

    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "First agent."));

    yield* configure(repl);
    yield* name(repl, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the control saying it starts a new conversation", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);

    // The drawer stays open with the reason: a failed setup is something to
    // correct rather than something to be dropped out of.
    yield* awaiting(repl.terminal, "the reason in the drawer", (one) =>
      shows(one, "will not start"),
    );
    expect(shows(repl.terminal, "[refresh]")).toBe(true);

    // And the old conversation is still the active one: it takes a real message.
    yield* closeDrawer(repl);
    yield* sendMessage(repl, "still there?");
    yield* awaiting(repl.terminal, "the old agent answering", (one) =>
      shows(one, "Still the first."),
    );
  });

  /**
   * Read the current chat explicitly, by its own Sessions row.
   *
   * Through the mounted control, so what is selected is what a person
   * selected: the row carries the chat and the turn, and nothing here reaches
   * the owner or the route.
   */
  function* readOwnChat(repl: MountedRepl, title: string): Operation<void> {
    const rows = screenOf(repl.terminal).map((line) => line.slice(0, 32));
    const row = rows.findIndex((line) => line.includes(title));
    if (row === -1) {
      throw new Error(`no Sessions row shows ${title}. rows=${JSON.stringify(rows)}`);
    }
    yield* clickAt(repl.terminal, { column: rows[row]?.indexOf(title) ?? 0, row });
    yield* awaiting(repl.terminal, "the chat selector standing", (one) =>
      shows(one, "[Back to current chat]"),
    );
    // The current chat keeps its usual controls even when it is the chat
    // somebody explicitly selected: it *is* the active association.
    expect(shows(repl.terminal, MESSAGE_PROMPT)).toBe(true);
  }

  it("SS4: a successful replacement returns to the new current chat", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "First agent."));
    yield* readOwnChat(repl, "hello");

    yield* configure(repl);
    yield* name(repl, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the replacement control", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaiting(repl.terminal, "the new conversation starting empty", (one) =>
      shows(one, "No messages yet."),
    );

    // The selector is cleared, so the reading is the new current chat — which
    // is the conversation the next message would go to anyway.
    expect(shows(repl.terminal, "[Back to current chat]")).toBe(false);
    yield* sendMessage(repl, "and you?");
    yield* awaiting(repl.terminal, "the new agent's reply", (one) => shows(one, "Second agent."));
  });

  it("SS4: a failed replacement preserves the reading and the association", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ reply: "<Output>Still the first.</Output>\n" });
    repl.fake.unavailable(OTHER_MOUNTED_AGENT, new Error("that agent will not start here"));

    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "First agent."));
    yield* readOwnChat(repl, "hello");

    yield* configure(repl);
    yield* name(repl, OTHER_MOUNTED_AGENT);
    yield* awaiting(repl.terminal, "the replacement control", (one) =>
      shows(one, "[start new conversation]"),
    );
    yield* click(repl.terminal, "[start new conversation]", 96);
    yield* awaiting(repl.terminal, "the reason in the drawer", (one) =>
      shows(one, "will not start"),
    );
    yield* closeDrawer(repl);

    // The reading is exactly where it was, and so is the association: this
    // conversation still takes a real message under the agent it was opened
    // with.
    expect(shows(repl.terminal, "[Back to current chat]")).toBe(true);
    expect(shows(repl.terminal, `[configure ${MOUNTED_AGENT}]`)).toBe(true);
    yield* sendMessage(repl, "still there?");
    yield* awaiting(repl.terminal, "the old agent answering", (one) =>
      shows(one, "Still the first."),
    );
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

  function* configure(repl: MountedRepl): Operation<void> {
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    expect(shows(repl.terminal, "[refresh]")).toBe(true);
  }

  /**
   * Type a name into the drawer's own field, whatever was in it.
   *
   * Cleared with more presses than any of these names is long, because this is
   * used twice in one row: the second time the field holds the *other* agent's
   * name, and clearing one name's worth of it would leave a prefix behind.
   */
  function* name(repl: MountedRepl, agent: string): Operation<void> {
    yield* focusOn(repl.terminal, `> Agent: `);
    for (let press = 0; press < 24; press += 1) {
      repl.terminal.feed("\x7f");
      yield* settled(4);
    }
    yield* typing(repl.terminal, agent);
  }

  function* closeDrawer(repl: MountedRepl): Operation<void> {
    const from = repl.terminal.presented.length;
    yield* click(repl.terminal, "[close]", paneEnvelope(repl.terminal.size.columns));
    yield* awaited("the drawer closing", () =>
      replay(repl.terminal.presented.slice(from)).some(
        (line) => line.includes(MESSAGE_PROMPT) || line.includes("[send]"),
      ),
    );
  }

  it("CFG8: a save queues behind the reply being written, and both land in order", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Written down.</Output>\n" });

    // One read first, so the drawer has this conversation's choices while the
    // reply below is being written.
    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Written down."));
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Balanced"));
    yield* closeDrawer(repl);

    // The record the next reply is written as, held open inside the host: the
    // writer is genuinely occupied by somebody else's append.
    const writing = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"response"'),
    );
    repl.fake.script({ reply: "<Output>And this one.</Output>\n" });
    yield* sendMessage(repl, "again");
    yield* writing.started();

    // A preference applied while that write is in flight. It is admitted —
    // a save is a record of this history rather than work the conversation
    // does — and it waits for the writer rather than overtaking it.
    yield* configure(repl);
    yield* click(repl.terminal, "( ) Fast", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being chosen", (one) => shows(one, "(x) Fast"));
    yield* click(repl.terminal, "[apply]", paneEnvelope(repl.terminal.size.columns));
    yield* settled(60);
    // Nothing of it reached the file while the other append was inside the
    // host, and the held write is still held.
    expect(yield* savedPreference(repl)).toBe(undefined);
    expect(writing.released).toBe(false);

    writing.release();
    yield* awaiting(repl.terminal, "the reply that was being written", (one) =>
      shows(one, "And this one."),
    );
    yield* landed("the preference landing", function* (): Operation<boolean> {
      return (yield* savedPreference(repl)) !== undefined;
    });

    // One order, on disk: the response that was being written, and then the
    // preference that waited for it. Read back through the projection, so this
    // is the history as everything else reads it.
    const read = yield* mountedReading(repl);
    const kinds = read.chat.map((record) => record.kind);
    expect(kinds.indexOf("preferences")).toBeGreaterThan(kinds.lastIndexOf("response"));
    expect(yield* savedPreference(repl)).toMatchObject({ model: "fast" });
    expect(read.chat.filter((record) => record.kind === "response")).toHaveLength(2);
  });

  it("CFG8: a replacement owns the drawer while it runs, and rebinds what Apply saves", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>First agent.</Output>\n" });
    repl.fake.script({ held: true, reply: "<Output>Never seen.</Output>\n" });
    repl.fake.script({ reply: "<Output>Second agent.</Output>\n" });

    // One conversation with a preference of its own, saved while it is idle —
    // and read while it is idle, because inspection is something a working
    // conversation cannot do.
    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the first reply", (one) => shows(one, "First agent."));
    yield* configure(repl);
    yield* click(repl.terminal, "( ) Fast", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "the model being chosen", (one) => shows(one, "(x) Fast"));
    yield* click(repl.terminal, "[apply]", paneEnvelope(repl.terminal.size.columns));
    yield* landed("the first conversation's preference", function* (): Operation<boolean> {
      return (yield* savedPreference(repl)) !== undefined;
    });
    const first = yield* mountedReading(repl);
    const before = first.chat.filter((record) => record.kind === "preferences");
    expect(before).toHaveLength(1);
    const owning = before[0]?.kind === "preferences" ? before[0].conversation : undefined;
    expect(owning).toBeDefined();

    // Then a turn in flight, so the replacement below really has something to
    // stop.
    yield* sendMessage(repl, "again");
    yield* repl.fake.holdingTurns(1);

    // A replacement started and held inside its own Stop: this job owns the
    // drawer while it runs.
    const cancelling = repl.fake.holdCancellation();
    try {
      yield* configure(repl);
      yield* name(repl, OTHER_MOUNTED_AGENT);
      yield* awaiting(repl.terminal, "the control saying it stops first", (one) =>
        shows(one, "[stop and start new conversation"),
      );
      yield* click(repl.terminal, "[stop and start new conversation", 96);
      yield* cancelling.reached;

      // The name typed back, so the drawer offers a save again — and that save
      // is refused, in the drawer, because the replacement is the one explicit
      // thing this Sidekick is doing.
      yield* name(repl, MOUNTED_AGENT);
      yield* awaiting(repl.terminal, "Apply being offered again", (one) => shows(one, "[apply]"));
      yield* click(repl.terminal, "[apply]", 96);
      yield* awaiting(repl.terminal, "the refusal the drawer gives", (one) =>
        // The beginning of it, which is what this pane's width holds.
        shows(one, "the Sidekick is already doing"),
      );
      const during = yield* mountedReading(repl);
      expect(during.chat.filter((record) => record.kind === "preferences")).toHaveLength(1);

      cancelling.release();
      // The replacement finishes, and leaves this drawer open: the name in its
      // field is not the agent that was set up any more, so the outcome is not
      // the one this drawer asked for and it does not close on it.
      yield* awaiting(repl.terminal, "the new conversation in the drawer", (one) =>
        shows(one, "Requested: none"),
      );
      yield* closeDrawer(repl);
      yield* awaiting(repl.terminal, "the new agent in the pane", (one) =>
        shows(one, `[configure ${OTHER_MOUNTED_AGENT}]`),
      );
    } finally {
      cancelling.release();
    }

    // The new conversation starts with nothing requested — the old agent's
    // preference is not its — and a save made now belongs to it.
    yield* click(repl.terminal, `[configure ${OTHER_MOUNTED_AGENT}]`);
    yield* settled(60);
    expect(shows(repl.terminal, "Requested: none")).toBe(true);
    yield* click(repl.terminal, "( ) Balanced", paneEnvelope(repl.terminal.size.columns));
    yield* awaiting(repl.terminal, "a model for the new conversation", (one) =>
      shows(one, "(x) Balanced"),
    );
    yield* click(repl.terminal, "[apply]", paneEnvelope(repl.terminal.size.columns));
    yield* landed("the second conversation's preference", function* (): Operation<boolean> {
      const read = yield* mountedReading(repl);
      return read.chat.filter((record) => record.kind === "preferences").length === 2;
    });

    const after = yield* mountedReading(repl);
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
    const repl = yield* useMountedRepl();
    // A turn the backend takes and then reports as failed: the request was
    // accepted, so the history knows which turn it became and that it failed.
    repl.fake.script({ reply: "", stopReason: "refusal" });
    repl.fake.script({ reply: "<Output>Second time lucky.</Output>\n" });

    yield* sendMessage(repl, "inspect it");
    yield* awaiting(repl.terminal, "the failed attempt and its retry", (one) =>
      shows(one, "[retry]"),
    );

    // Unrelated newer text in the box, and a newer draft edit: neither is what
    // Retry sends, and neither is consumed by it.
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "something else");
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");

    // Two activations in one burst: the same one cycle a Send reserves, so the
    // second finds it held rather than starting a second turn.
    const at = coordinateOf(repl.terminal, "[retry]");
    expect(at).toBeDefined();
    repl.terminal.feed(`\x1b[<0;${at!.column + 1};${at!.row + 1}M`);
    repl.terminal.feed(`\x1b[<0;${at!.column + 1};${at!.row + 1}M`);
    yield* awaiting(repl.terminal, "the retried request being answered", (one) =>
      shows(one, "Second time lucky."),
    );

    // One new message, carrying the old request's own literal text.
    const read = yield* mountedReading(repl);
    const asked = read.chat.filter((record) => record.kind === "message");
    expect(asked).toHaveLength(2);
    expect(asked.map((record) => (record.kind === "message" ? record.text : ""))).toEqual([
      "inspect it",
      "inspect it",
    ]);
    // In the same conversation, so it is the same agent being asked again.
    const conversations = new Set(
      asked.map((record) => (record.kind === "message" ? record.conversation : "")),
    );
    expect(conversations.size).toBe(1);
    // Two turns and no more: the second activation asked for nothing.
    expect(repl.fake.prompts).toHaveLength(2);
    expect(repl.fake.prompts[1]).toContain("inspect it");
    expect(repl.fake.prompts[1]).not.toContain("something else");

    // And the texts a person had typed are still theirs: Retry sent neither and
    // cleared neither.
    expect(messageText(repl.terminal).includes("something else")).toBe(true);
    expect(draftText(repl.terminal)).toBe("mine");
  });

  it("CFG5: a message that worked retires the retry an older failure left", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: "", stopReason: "refusal" });
    repl.fake.script({ reply: "<Output>This one worked.</Output>\n" });

    yield* sendMessage(repl, "inspect it");
    // Offered first, which is what makes the rest of this row a transition
    // rather than a control that was never there.
    yield* awaiting(repl.terminal, "the failed attempt and its retry", (one) =>
      shows(one, "[retry]"),
    );

    // Something else asked, and answered. The failure is still in the history
    // and still readable, but it is behind a reply now: resending it would put
    // it out of order with what the agent has already been told.
    yield* sendMessage(repl, "try this");
    yield* awaiting(repl.terminal, "the later reply", (one) => shows(one, "This one worked."));
    yield* settled(40);
    expect(shows(repl.terminal, "[retry]")).toBe(false);
    // The attempt itself was kept: this is about what is offered, not about
    // rewriting what happened.
    const read = yield* mountedReading(repl);
    expect(read.chat.filter((record) => record.kind === "message")).toHaveLength(2);
    expect(shows(repl.terminal, "(unfinished)")).toBe(true);
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
      const repl = yield* useMountedRepl({
        dataRoot: root.data,
        location: "xmd://repl/chat/entries",
      });

      // The request is in the chat, and the attempt nobody finished is said as
      // one — but there is no control to ask it again, because this history
      // cannot say whether the agent already has it. A control that refused
      // when it was pressed would be offering a decision nothing can make.
      yield* awaiting(repl.terminal, "the chat this history holds", (one) =>
        shows(one, "inspect it"),
      );
      expect(shows(repl.terminal, "[retry]")).toBe(false);

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
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: "<Output>That worked.</Output>\n" });

    yield* sendMessage(repl, "inspect it");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "That worked."));

    // A request that was answered has nothing to ask again, so there is no
    // control for it at all.
    expect(shows(repl.terminal, "[retry]")).toBe(false);
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
    const repl = yield* useMountedRepl({
      defaultAgent: MOUNTED_AGENT,
      sidekickAgent: OTHER_MOUNTED_AGENT,
    });

    // Acquiring the screen asks nobody anything. A selection that opened a
    // conversation to prove itself would have sent a prompt no one asked for.
    expect(repl.fake.ensured).toHaveLength(0);
    expect(repl.fake.turns).toHaveLength(0);

    // One ordinary entry asking one Agent, with no agent named in it: the
    // default is what is under test, and naming it here would bypass it.
    repl.fake.script({ reply: `${ANSWERED}\n` });
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(ASKING));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the entry's own Agent answering", (one) =>
      shows(one, ANSWERED),
    );

    // Then a Sidekick message, which is the other selection's own turn.
    repl.fake.script({ reply: "<Output>Sidekick here.</Output>\n" });
    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the Sidekick replying", (one) => shows(one, "Sidekick here."));

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
    const read = yield* mountedReading(repl);
    expect(read.model.entries).toHaveLength(1);
    expect(read.model.entries[0]?.terminal?.output).toContain(ANSWERED);
    expect(shows(repl.terminal, `${OTHER_MOUNTED_AGENT}: Sidekick here.`)).toBe(true);
  });
});
