import { SidekickOwnerError } from "../src/repl/sidekick/owner.ts";
/**
 * Tier R5 — a message, a turn, and the reply that runs (#883, J1/J4/J10).
 *
 * Everything below the terminal is real: a temporary repository on disk, the
 * paired history this CLI publishes, the profile this command assembles, a real
 * `ReplSession` owning the entry task, the canonical conversation Core opens
 * over this history's own sequence, and the response ceiling `profile.ts`
 * builds. What is scripted is the provider — one `FakeAcp` standing where the
 * agent process would be — because the thing under test is the plumbing a reply
 * crosses, not what a model would say.
 *
 * Two kinds of row live here. Some drive the Sidekick owner directly, with the
 * loop's own state beside it, because what they are about is the plumbing one
 * reply crosses. The rest drive the real mounted command — its terminal, its
 * Sidekick pane and the draft a person types in — because what they are about
 * is what somebody actually does and reads.
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { scoped } from "effection";
import { ensureDir } from "@effectionx/fs";
import { API, cwd, useHostFiles, Permissions } from "@executablemd/runtime";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { readGuideChapter } from "../src/repl/sidekick/guide.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import { encodeLocation } from "../src/repl/route.ts";
import { initialState } from "../src/repl/application.ts";

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, spawn, suspend, until, useScope, withResolvers } from "effection";
import type { Operation, Result } from "effection";

import { InMemoryStream } from "@executablemd/durable-streams";
import { Elicitation } from "@executablemd/core";
import { openReplSession } from "../src/repl/session.ts";
import { previewGeneratedXmdRoot } from "@executablemd/core/host";
import { projectSidekick } from "../src/repl/sidekick/model.ts";
import type { SidekickReading } from "../src/repl/sidekick/model.ts";
import { sidekickChatLines } from "../src/repl/application.ts";
import { sidekickChatRows, sidekickTurnRows } from "../src/repl/program.ts";
import { rootReads } from "../src/repl/sidekick/requests.ts";
import { useSidekickOwner } from "../src/repl/sidekick/owner.ts";
import type { SidekickOwner, SidekickTurn } from "../src/repl/sidekick/owner.ts";
import type { PairedChatStorage } from "../src/repl/sidekick/repository.ts";
import type { SidekickRecord } from "../src/repl/sidekick/history.ts";
import type { SubmitReceipt } from "../src/repl/sidekick/controls.ts";
import { AGENT, records, useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import {
  BALLOT_REPLY,
  BALLOT_REQUEST,
  FAILED_ENTRY,
  PROMPT_REPLIES,
  SETTLED_ENTRY,
  STOP_REASON,
} from "./fixtures/repl/issue-932/history.ts";
import {
  appendGate,
  awaitedFact,
  awaiting,
  awaited,
  draftText,
  focusDraft,
  focusMessage,
  MESSAGE_PROMPT,
  messageText,
  MOUNTED_AGENT,
  blockSays,
  mountedReading,
  saidByPerson,
  saidBySidekick,
  screenOf,
  rowsShow,
  sidekickColumn,
  sendMessage,
  settled,
  shows,
  typing,
  useMountedRepl,
  useMountedHost,
  mountedExecution,
  sidekickPaneIn,
  untilShown,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import type { MountedRepl } from "./fixtures/repl/issue-883/mounted-program.ts";
import { send } from "./support/repl-page.ts";

/**
 * The orientation an older build left on a conversation it completed a turn of.
 *
 * Text that turn's canonical input genuinely held — the bootstrap's own first
 * sentence, the index's own heading, the surface's own opening — so the record
 * is consistent with the turn it names and its delivery is established. Only
 * the index digest differs, which is what a newer build has to notice.
 */
function olderOrientation(
  conversation: string,
  versions: Readonly<Record<string, string>>,
): SidekickRecord {
  return {
    kind: "reference",
    conversation,
    turn: 1,
    bootstrap: "You are Sidekick for this shared REPL.",
    index: "Guides you can read (each returns its chapter to you as feedback):",
    surface: "Controls you may write in a reply",
    versions: { ...versions, index: "0".repeat(64) },
  };
}

describe("Tier R5 — one message becomes one turn, and its reply runs", () => {
  it("R5: the first turn of a conversation carries the orientation it needs", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>Ready when you are.</Output>\n" });

    const answered = yield* held.owner.message("help me write an entry");
    if (!answered.ok) {
      throw answered.error;
    }

    // One turn, and exactly one: the orientation travels with the message
    // rather than as a turn of its own.
    expect(held.fake.prompts).toHaveLength(1);
    const sent = held.fake.prompts[0] ?? "";
    // The bootstrap, as shipped. Its own first sentence, so a row cannot pass
    // on a paraphrase.
    expect(sent).toContain("You are Sidekick for this shared REPL.");
    // The derived guide index, with the exact invocation to ask with.
    expect(sent).toContain("<Guide.Entries />");
    // The compact surface, derived from the ceiling this response is admitted
    // under — so a reply is told about the controls it actually has.
    expect(sent).toContain("<REPL.Submit /> — write.");
    // The draft as it stands, and the person's request last.
    expect(sent).toContain("The shared entry draft is empty.");
    expect(sent).toContain("help me write an entry");

    // Only the root's Output reaches the person.
    expect(answered.value.hasOutput).toBe(true);
    expect(answered.value.output).toContain("Ready when you are.");

    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.chat.map((item) => item.kind)).toEqual(["person", "reply"]);
    expect(reading.value.active).toBe(answered.value.conversation);
    // The reply asked for nothing and failed at nothing, so there is nothing to
    // send back and no turn spent sending it: the next move is the person's.
    expect(
      (yield* records(held.execution)).filter(
        (record) => (record as { kind: string }).kind === "feedback",
      ),
    ).toHaveLength(0);
    // What that turn was given is retained as a fact about the turn, with a
    // digest of exactly the bytes delivered.
    const reference = (yield* records(held.execution)).find(
      (record) => (record as { kind: string }).kind === "reference",
    ) as { turn: number; bootstrap: string; versions: Record<string, string> } | undefined;
    expect(reference?.turn).toBe(1);
    expect(reference?.bootstrap).toContain("You are Sidekick for this shared REPL.");
    expect(Object.keys(reference?.versions ?? {}).sort()).toEqual([
      "bootstrap",
      "index",
      "surface",
    ]);
  });

  it("R5: the next turn of the same conversation is not oriented again", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>First.</Output>\n" });
    held.fake.script({ reply: "<Output>Second.</Output>\n" });

    const first = yield* held.owner.message("one");
    if (!first.ok) {
      throw first.error;
    }
    const second = yield* held.owner.message("two");
    if (!second.ok) {
      throw second.error;
    }

    expect(held.fake.prompts).toHaveLength(2);
    const sent = held.fake.prompts[1] ?? "";
    // The agent has been told once. Repeating it would spend the context window
    // restating what is already in it.
    expect(sent).not.toContain("You are Sidekick for this shared REPL.");
    expect(sent).not.toContain("<Guide.Entries />");
    // The draft still travels, because it is the piece that changes.
    expect(sent).toContain("The shared entry draft is empty.");
    expect(sent).toContain("The person says:\n\ntwo");

    // One conversation, two turns, one orientation.
    expect(second.value.conversation).toBe(first.value.conversation);
    expect(second.value.turn).toBe(2);
    expect(
      (yield* records(held.execution)).filter(
        (record) => (record as { kind: string }).kind === "reference",
      ),
    ).toHaveLength(1);
  });

  /**
   * A conversation an older build oriented, reopened by this one.
   *
   * The shape the refresh exists for: a real completed turn, a reference record
   * consistent with it whose index digest has moved, and a fresh owner over the
   * file as the repository reads it back.
   */
  function* reopenedAfterOlderBuild(held: Harness): Operation<{
    readonly owner: SidekickOwner;
    readonly chat: PairedChatStorage;
    readonly conversation: string;
    readonly versions: Readonly<Record<string, string>>;
  }> {
    held.fake.script({ reply: "<Output>First.</Output>\n" });
    const first = yield* held.owner.message("one");
    if (!first.ok) {
      throw first.error;
    }
    const delivered = (yield* records(held.execution)).find(
      (record) => (record as { kind: string }).kind === "reference",
    ) as { versions: Record<string, string> } | undefined;
    if (delivered === undefined) {
      throw new Error("the first turn recorded no orientation");
    }
    const chat = held.execution.chat as PairedChatStorage;
    yield* chat.writer.append(olderOrientation(first.value.conversation, delivered.versions));

    const cold = yield* held.repository.open(held.execution.id);
    const reopenedChat = cold.chat as PairedChatStorage;
    const owner = yield* useSidekickOwner({
      // The same production assembly the first process used. A reopening built
      // with a different one would be a different configuration, which is a
      // refusal rather than a continuation.
      assembly: held.profile.sidekickAssembly,
      chat: reopenedChat,
      // deno-lint-ignore require-yield
      *establish(): Operation<Result<PairedChatStorage>> {
        return Ok(reopenedChat);
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
    return {
      owner,
      chat: reopenedChat,
      conversation: first.value.conversation,
      versions: delivered.versions,
    };
  }

  /** Whether one turn's text carried this build's orientation. */
  function oriented(sent: string): boolean {
    return sent.includes("You are Sidekick for this shared REPL.");
  }

  it("R5: a refresh whose turn failed is owed again by the next message", function* () {
    const held = yield* useHarness();
    const reopened = yield* reopenedAfterOlderBuild(held);

    // The refresh turn does not finish. Its reference record is written — the
    // intent precedes the work, as every other intent does — and it establishes
    // nothing, because nothing carried it.
    held.fake.script({ reply: "<Output>Second.</Output>\n", stopReason: "max_tokens" });
    const failed = yield* reopened.owner.message("two");
    if (!failed.ok) {
      throw failed.error;
    }
    expect(failed.value.failure).toContain("max_tokens");
    expect(oriented(held.fake.prompts[1] ?? "")).toBe(true);

    // So the next explicit message still owes it. A record of this host's own
    // is not evidence the agent was told anything.
    held.fake.script({ reply: "<Output>Third.</Output>\n" });
    const retried = yield* reopened.owner.message("three");
    if (!retried.ok) {
      throw retried.error;
    }
    expect(oriented(held.fake.prompts[2] ?? "")).toBe(true);
    expect(retried.value.output).toContain("Third.");

    // That one completed and carried it, so it is established — and the message
    // after it carries none.
    held.fake.script({ reply: "<Output>Fourth.</Output>\n" });
    const after = yield* reopened.owner.message("four");
    if (!after.ok) {
      throw after.error;
    }
    expect(oriented(held.fake.prompts[3] ?? "")).toBe(false);
    // Three proposals, one per turn that was offered it; two of them delivered
    // nothing, and the history says which without being asked twice.
    const reading = reopened.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.conversations[0]?.oriented).toEqual(reopened.versions);
  });

  it("R5: control — a refresh whose turn completed is not offered again", function* () {
    const held = yield* useHarness();
    const reopened = yield* reopenedAfterOlderBuild(held);

    held.fake.script({ reply: "<Output>Second.</Output>\n" });
    const second = yield* reopened.owner.message("two");
    if (!second.ok) {
      throw second.error;
    }
    expect(oriented(held.fake.prompts[1] ?? "")).toBe(true);

    held.fake.script({ reply: "<Output>Third.</Output>\n" });
    const third = yield* reopened.owner.message("three");
    if (!third.ok) {
      throw third.error;
    }
    expect(oriented(held.fake.prompts[2] ?? "")).toBe(false);
    expect(third.value.output).toContain("Third.");
  });

  it("R5: a reference naming a turn that carried something else establishes nothing", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>First.</Output>\n" });
    const first = yield* held.owner.message("one");
    if (!first.ok) {
      throw first.error;
    }
    const delivered = (yield* records(held.execution)).find(
      (record) => (record as { kind: string }).kind === "reference",
    ) as { versions: Record<string, string> } | undefined;
    if (delivered === undefined) {
      throw new Error("the first turn recorded no orientation");
    }
    const chat = held.execution.chat as PairedChatStorage;
    // An older build's orientation, consistent with the turn that carried it,
    // whose index digest has since moved.
    yield* chat.writer.append(olderOrientation(first.value.conversation, delivered.versions));
    // And a record naming that same completed turn with *today's* versions and
    // text that turn never carried. An ordinal plus a completion is not
    // delivery: this one describes a turn that was sent something else, and
    // crediting it would establish an orientation nobody was ever given.
    yield* chat.writer.append({
      kind: "reference",
      conversation: first.value.conversation,
      turn: 1,
      bootstrap: "text no turn of this conversation was sent",
      index: "nor this",
      surface: "nor this either",
      versions: delivered.versions,
    });

    const cold = yield* held.repository.open(held.execution.id);
    const reopenedChat = cold.chat as PairedChatStorage;
    const reopened = yield* useSidekickOwner({
      assembly: held.profile.sidekickAssembly,
      chat: reopenedChat,
      // deno-lint-ignore require-yield
      *establish(): Operation<Result<PairedChatStorage>> {
        return Ok(reopenedChat);
      },
      root: {
        ...rootReads(held.session, held.profile),
        // deno-lint-ignore require-yield
        *fill(): Operation<Result<void>> {
          throw new Error("this row fills no draft");
        },
      },
      // deno-lint-ignore require-yield
      *submit(): Operation<Result<SubmitReceipt>> {
        throw new Error("this row submits nothing");
      },
      revision: () => 0,
      // deno-lint-ignore require-yield
      *acknowledge(): Operation<void> {
        // These rows hold their own state directly rather than through the
        // screen's loop, so a saved message needs nothing applied for it.
      },
      draft: () => "",
    });

    // So what stands is the older build's, and the orientation is still owed.
    const reading = reopened.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.conversations[0]?.oriented).not.toEqual(delivered.versions);
    held.fake.script({ reply: "<Output>Second.</Output>\n" });
    const second = yield* reopened.message("two");
    if (!second.ok) {
      throw second.error;
    }
    expect(oriented(held.fake.prompts[1] ?? "")).toBe(true);
  });

  it("R5: an orientation a newer build would give differently is refreshed once", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>First.</Output>\n" });

    const first = yield* held.owner.message("one");
    if (!first.ok) {
      throw first.error;
    }
    const delivered = (yield* records(held.execution)).find(
      (record) => (record as { kind: string }).kind === "reference",
    ) as { versions: Record<string, string> } | undefined;
    if (delivered === undefined) {
      throw new Error("the first turn recorded no orientation");
    }

    // What an *older* build left behind: the same conversation, oriented with an
    // index digest that no longer matches. Written directly because that is the
    // only way this history comes about — the assets and the admitted ceiling
    // are fixed for the life of one run, so nothing inside a single process can
    // move them, and the case only exists across a reopen by a newer build.
    //
    // Consistent with the turn it names, which is what makes it a record an
    // older build would have written rather than a shape nothing produces: its
    // text is text that turn's canonical input actually carried, so delivery is
    // established for it, and only the index *digest* has moved.
    const chat = held.execution.chat as PairedChatStorage;
    yield* chat.writer.append(olderOrientation(first.value.conversation, delivered.versions));

    // Reopened, as that newer build does.
    const cold = yield* held.repository.open(held.execution.id);
    const reopenedChat = cold.chat as PairedChatStorage;
    const reopened = yield* useSidekickOwner({
      assembly: held.profile.sidekickAssembly,
      chat: reopenedChat,
      // deno-lint-ignore require-yield
      *establish(): Operation<Result<PairedChatStorage>> {
        return Ok(reopenedChat);
      },
      root: {
        ...rootReads(held.session, held.profile),
        // deno-lint-ignore require-yield
        *fill(): Operation<Result<void>> {
          throw new Error("this row filled no draft");
        },
      },
      // deno-lint-ignore require-yield
      *submit(): Operation<Result<SubmitReceipt>> {
        throw new Error("this row submitted nothing");
      },
      revision: () => 0,
      // deno-lint-ignore require-yield
      *acknowledge(): Operation<void> {
        // These rows hold their own state directly rather than through the
        // screen's loop, so a saved message needs nothing applied for it.
      },
      draft: () => "",
    });

    held.fake.script({ reply: "<Output>Second.</Output>\n" });
    const second = yield* reopened.message("two");
    if (!second.ok) {
      throw second.error;
    }

    const sent = held.fake.prompts[1] ?? "";
    // Re-oriented in that same conversation, before its next explicit turn:
    // the bootstrap, the derived index and the compact surface, as this build
    // gives them.
    expect(sent).toContain("You are Sidekick for this shared REPL.");
    expect(sent).toContain("<Guide.Entries />");
    expect(sent).toContain("<REPL.Submit /> — write.");
    // Chapter bodies stay on demand: a refresh re-orients, it does not deliver
    // the teaching.
    expect(sent).not.toContain("## Applies to");
    // And what it carried is retained as that turn's own orientation, with the
    // versions this build actually gave. Read through the reopened writer,
    // because that is the one this process appends with — the first owner's
    // copy knows only what it wrote itself.
    const references = (yield* reopenedChat.writer.readAll()).filter(
      (record) => record.kind === "reference",
    );
    expect(references).toHaveLength(3);
    expect(references[2]).toMatchObject({ versions: delivered.versions });

    // Once, not on every turn after. The orientation matches now, so a third
    // message carries none of it again.
    held.fake.script({ reply: "<Output>Third.</Output>\n" });
    const third = yield* reopened.message("three");
    if (!third.ok) {
      throw third.error;
    }
    expect(held.fake.prompts[2] ?? "").not.toContain("You are Sidekick for this shared REPL.");
    expect(
      (yield* reopenedChat.writer.readAll()).filter((record) => record.kind === "reference"),
    ).toHaveLength(3);
  });

  it("R5: a reply that prepares and submits an entry does both, for real", function* () {
    const held = yield* useHarness();
    // The accepted passive-capture pattern, through the real ceiling.
    held.fake.script({
      reply: [
        '<Let as="code" select="code">',
        "````xmd",
        "```js eval",
        'const greeting = "Hello from the reply.";',
        "```",
        "",
        "<Output>{greeting}</Output>",
        "````",
        "</Let>",
        "<REPL.EntryInput>{code}</REPL.EntryInput>",
        "<REPL.Submit />",
        "<Output>Submitted it.</Output>",
        "",
      ].join("\n"),
    });
    // Both writes are designated, so this message takes a second turn: the
    // reply is told what its fill and its submission did.
    held.fake.script({ reply: "<Output>Thanks for the receipt.</Output>\n" });

    const answered = yield* held.owner.message("run a greeting");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.failure).toBe(undefined);
    expect(answered.value.output).toContain("Thanks for the receipt.");

    // The entry really ran, from exactly the captured source — literally, with
    // the executable fence intact rather than evaluated by the reply.
    const [entry] = held.session.model.entries;
    expect(entry?.key).toBe("entry-1");
    expect(entry?.source).toContain("```js eval");
    expect(entry?.source).toContain("Hello from the reply.");
    expect(entry?.terminal?.output).toContain("Hello from the reply.");
    // And the draft that became it is finished, which is what an admission
    // does to the revision it admitted.
    expect(held.state().draft).toBe("");

    // The controls are recorded in the order the reply admitted them, each with
    // its intent before its outcome.
    const held_records = yield* records(held.execution);
    const controls = held_records
      .filter((record) => (record as { kind: string }).kind === "control")
      .map((record) => (record as { component: string }).component);
    expect(controls).toEqual(["REPL.EntryInput", "REPL.Submit"]);
    expect(
      held_records.filter((record) => (record as { kind: string }).kind === "control-outcome"),
    ).toHaveLength(2);
    // Both writes are designated, so both answers go back — and in admission
    // order, with the acknowledgement for the fill and the receipt for the
    // submission. Neither repeats the entry's own source or its output.
    expect(held.fake.prompts).toHaveLength(2);
    const delivered = held.fake.prompts[1] ?? "";
    expect(delivered).toContain("## REPL.EntryInput");
    expect(delivered).toContain("Entry input updated.");
    expect(delivered).toContain("## REPL.Submit");
    expect(delivered).toContain("Entry entry-1 completed.");
    expect(delivered).toContain("Read what it printed with <REPL.Entry.Output entry={1} />.");
    expect(delivered.indexOf("## REPL.EntryInput")).toBeLessThan(
      delivered.indexOf("## REPL.Submit"),
    );
    // The receipt names the entry and the read to follow, and carries no body:
    // a reply that wants the output asks for it, with its own bounds.
    expect(delivered).not.toContain("Hello from the reply.");
    expect(delivered).not.toContain("```js eval");
    // And one entry ran, not two: being told about a submission is not
    // submitting again.
    expect(held.session.model.entries).toHaveLength(1);
  });

  it("R5: a turn the provider did not finish is an incomplete attempt, not a reply", function* () {
    const held = yield* useHarness();
    // A turn that streams a complete-looking response and then settles as
    // failed. Nothing in it may run: it is source nobody finished writing.
    held.fake.script({
      reply: "<REPL.EntryInput>never</REPL.EntryInput>\n",
      stopReason: "max_tokens",
    });
    held.fake.script({ reply: "<Output>Retried.</Output>\n" });

    const answered = yield* held.owner.message("do something");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.failure).not.toBe(undefined);
    expect(answered.value.hasOutput).toBe(false);
    // No control ran, so the draft is untouched.
    expect(held.state().draft).toBe("");
    const written = yield* records(held.execution);
    expect(
      written.filter((record) => (record as { kind: string }).kind === "control"),
    ).toHaveLength(0);
    // And nothing claims an admitted response. A `response` record is the
    // outcome of a completed turn, and this turn did not complete — one written
    // here would make the history unreadable, which is the strongest possible
    // reason not to write it.
    expect(
      written.filter((record) => (record as { kind: string }).kind === "response"),
    ).toHaveLength(0);

    // The history is still readable, and the attempt is in the chat as what it
    // is: the canonical record's own text and its own reason.
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.chat.map((item) => item.kind)).toEqual(["person", "incomplete"]);
    expect(reading.value.chat[1]).toMatchObject({
      kind: "incomplete",
      turn: 1,
      text: "<REPL.EntryInput>never</REPL.EntryInput>\n",
    });
    expect((reading.value.chat[1] as { failure: string }).failure).toContain("max_tokens");

    // Reopened cold, the same history reads the same way — so a failed turn
    // blocks nothing a later process wants to do.
    const cold = yield* held.repository.open(held.execution.id);
    const projected = projectSidekick(yield* (cold.chat as PairedChatStorage).writer.readAll());
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.chat.map((item) => item.kind)).toEqual(["person", "incomplete"]);

    // And the conversation continues at its next canonical ordinal: the failed
    // attempt took ordinal 1 and established no completed response.
    const retry = yield* held.owner.message("try again");
    if (!retry.ok) {
      throw retry.error;
    }
    expect(retry.value.turn).toBe(2);
    expect(retry.value.output).toContain("Retried.");
    expect(held.fake.prompts).toHaveLength(2);
  });

  it("R5: an ordinary root failure keeps what Core rendered and the fill before it", function* () {
    const held = yield* useHarness("fail-here");
    // One ordinary response whose second fill fails. Everything before the
    // failure happened; nothing after it runs.
    // Streamed in two pieces, the second held: what this response is saying is
    // on offer as a preview before anything of it has been evaluated, which is
    // what the retained reply below has to replace.
    held.fake.script({
      deltas: [
        "<Output>Before.</Output>\n",
        [
          "<REPL.EntryInput>kept</REPL.EntryInput>",
          "<REPL.EntryInput>fail-here</REPL.EntryInput>",
          "<Output>After.</Output>",
          "",
        ].join("\n"),
      ],
      holdAfter: 1,
    });

    held.fake.script({ reply: "failed follow-up", stopReason: "max_tokens" });

    const sent = withResolvers<Result<SidekickTurn>>();
    yield* spawn(function* (): Operation<void> {
      sent.resolve(yield* held.owner.message("prepare"));
    });
    yield* held.fake.streamingTurns(1);
    // The literal Output of the first piece, offered by the owner as a preview
    // of the response it is generating. Nothing has been evaluated: no fill has
    // happened, and there is no reply.
    yield* settled(20);
    expect(held.owner.previewing?.output).toBe("Before.");
    expect(held.owner.previewing?.incomplete).toBe(false);
    expect(held.state().draft).toBe("");

    held.fake.releaseDeltas();
    const answered = yield* sent.operation;
    expect(answered.ok).toBe(false);
    if (answered.ok || !(answered.error instanceof SidekickOwnerError)) {
      throw new Error("Failed follow-up must retain its partial result");
    }
    const partial = answered.error.partial;
    if (partial === undefined) {
      throw new Error("Earlier evaluated response was lost");
    }
    expect(partial.failure).not.toBe(undefined);
    // The candidate is no longer what is being shown: the evaluated reply below
    // is, and two accounts of one response would be two items for one thing.
    expect(held.owner.previewing).toBe(undefined);
    // The fill that happened before the failure happened, and stays.
    expect(held.state().draft).toBe("kept");
    // What Core had rendered when the failure reached it — not a blank, and not
    // the text after it, which never evaluated.
    expect(partial.output).toContain("Before.");
    expect(partial.output).not.toContain("After.");
    expect(partial.hasOutput).toBe(true);

    // The same facts in the retained reply, so a reopened chat shows the
    // partial rendering beside its failure rather than an empty reply.
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.chat[1]).toMatchObject({
      kind: "reply",
      hasOutput: true,
      text: "Before.",
    });
    expect((reading.value.chat[1] as { failure: string | undefined }).failure).not.toBe(undefined);
  });

  it("R5: an ordinary failure goes back as a correction, and the next reply answers", function* () {
    const held = yield* useHarness("fail-here");
    held.fake.script({
      reply: ["<Output>Before.</Output>", "<REPL.EntryInput>fail-here</REPL.EntryInput>", ""].join(
        "\n",
      ),
    });
    held.fake.script({ reply: "<Output>Fixed it.</Output>\n" });

    const answered = yield* held.owner.message("prepare");
    if (!answered.ok) {
      throw answered.error;
    }

    // Two turns for one message: the reply, then the correction it was given.
    expect(held.fake.prompts).toHaveLength(2);
    const correction = held.fake.prompts[1] ?? "";
    expect(correction).toContain("Your response did not finish");
    expect(correction).toContain("controlled ordinary fill failure");
    // And it is told that what already happened stands, so it continues rather
    // than repeating effects.
    expect(correction).toContain("Continue from there rather than repeating it.");

    // The answer is the corrected reply, and the partial one is still in the
    // chat beside it.
    expect(answered.value.turn).toBe(2);
    expect(answered.value.output).toContain("Fixed it.");
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.chat.map((item) => item.kind)).toEqual(["person", "reply", "reply"]);
    expect(reading.value.chat[1]).toMatchObject({ text: "Before.", hasOutput: true });
  });

  it("R5: a chapter a reply read comes back to it, and it answers from it", function* () {
    const held = yield* useHarness();
    // A response that only reads. It renders nothing for the person, which is
    // not a failure — it is a reply waiting for what it asked for.
    held.fake.script({ reply: "<Guide.Entries />\n" });
    held.fake.script({ reply: "<Output>Now I know how to prepare one.</Output>\n" });

    const answered = yield* held.owner.message("how do I write an entry?");
    if (!answered.ok) {
      throw answered.error;
    }

    expect(held.fake.prompts).toHaveLength(2);
    const delivered = held.fake.prompts[1] ?? "";
    // The chapter itself, literally, as the shipped file holds it — and with one
    // result there is no heading, because the reply asked one question.
    expect(delivered).toContain("# Entries");
    expect(delivered).not.toContain("## Guide.Entries");
    expect(delivered).not.toContain("Your response did not finish");

    expect(answered.value.turn).toBe(2);
    expect(answered.value.output).toContain("Now I know how to prepare one.");

    // The delivery is claimed before it is sent, claiming nothing, and then
    // established against the turn that carried it.
    const feedback = (yield* records(held.execution)).filter(
      (record) => (record as { kind: string }).kind === "feedback",
    ) as { turn: number | null; text: string }[];
    expect(feedback.map((record) => record.turn)).toEqual([null, 2]);
    expect(feedback[0]?.text).toBe(feedback[1]?.text);
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    // Established from the canonical turn, not from the marker alone.
    expect(reading.value.delivered).toEqual([
      { conversation: answered.value.conversation, turn: 2 },
    ]);
    expect(reading.value.unestablished).toEqual([]);
    // The first reply rendered nothing for the person and is still a reply.
    // It rendered the chapter into its own body, and that body is not chat: a
    // response without an explicit Output region shows the person nothing.
    expect(reading.value.chat[1]).toMatchObject({ kind: "reply", hasOutput: false, text: "" });
  });

  it("R5: Bindings comes back as the detached map itself", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<REPL.Bindings />\n" });
    held.fake.script({ reply: "<Output>Nothing published yet.</Output>\n" });

    const answered = yield* held.owner.message("what is published?");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(held.fake.prompts).toHaveLength(2);
    // One result, so it is the value with nothing round it — and it is the map,
    // parseable as such, with no provenance or status injected into it as
    // though those were published names.
    expect(JSON.parse(held.fake.prompts[1] ?? "")).toEqual({});
    expect(answered.value.output).toContain("Nothing published yet.");
  });

  it("R5: an entry that ran and failed is a failed entry, not a refused submission", function* () {
    const held = yield* useHarness();
    // A real entry that throws. It is admitted, it runs, and it settles badly —
    // which is a different thing from a submission that never happened, and the
    // reply has to act on it differently.
    held.fake.script({
      reply: [
        '<Let as="code" select="code">',
        "````xmd",
        "```js eval",
        'throw new Error("entry failed on purpose");',
        "```",
        "````",
        "</Let>",
        "<REPL.EntryInput>{code}</REPL.EntryInput>",
        "<REPL.Submit />",
        "",
      ].join("\n"),
    });
    held.fake.script({ reply: "<Output>I will correct it.</Output>\n" });

    const answered = yield* held.owner.message("run this");
    if (!answered.ok) {
      throw answered.error;
    }

    // The entry was admitted and reached its own outcome, and the draft that
    // became it is finished.
    const [entry] = held.session.model.entries;
    expect(entry?.key).toBe("entry-1");
    expect(entry?.terminal?.status).toBe("err");
    expect(held.state().draft).toBe("");

    const delivered = held.fake.prompts[1] ?? "";
    // The entry's own receipt: the entry, its reason, and where its evidence
    // is. An entry that failed may well have printed nothing, so the read it
    // is pointed at is the one that explains what ran.
    expect(delivered).toContain("Entry entry-1 failed");
    expect(delivered).toContain("entry failed on purpose");
    expect(delivered).toContain(
      "Inspect its saved evidence with <REPL.Entry.Journal entry={1} />.",
    );
    // And emphatically not a refusal. The submission happened; the entry is
    // what failed, and a reply told otherwise would try to submit again.
    expect(delivered).not.toContain("REPL.Submit refused");
    expect(answered.value.output).toContain("I will correct it.");
  });

  it("R5: a JSON value among other results is fenced long enough to hold it", function* () {
    const held = yield* useHarness();
    // A published value containing a fence of its own, which is the case the
    // fence length has to be measured for rather than assumed.
    const submitted = yield* held.session.submit(
      ["```js eval", 'const note = "a literal ``` run";', "```", ""].join("\n"),
    );
    if (!submitted.ok) {
      throw submitted.error;
    }
    const settled = yield* submitted.value.join();
    if (!settled.ok) {
      throw settled.error;
    }
    held.fake.script({ reply: "<REPL.Bindings />\n<REPL.Environment />\n" });
    held.fake.script({ reply: "<Output>Read both.</Output>\n" });

    const answered = yield* held.owner.message("read the map and the host");
    if (!answered.ok) {
      throw answered.error;
    }
    const delivered = held.fake.prompts[1] ?? "";
    const heading = "## REPL.Bindings\n\n";
    const start = delivered.indexOf(heading);
    const end = delivered.indexOf("## REPL.Environment", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    // The map is fenced, because it is sitting among other things now and a
    // reply has to know where the value ends — and the fence is longer than the
    // run inside it, so the value survives being quoted.
    const value = delivered.slice(start + heading.length, end).trim();
    const match = /^(`{4,})(?:json)?\n([\s\S]*)\n\1$/.exec(value);
    expect(match).not.toBe(null);
    expect(JSON.parse(match?.[2] ?? "")).toEqual({ note: "a literal ``` run" });
    // The environment text beside it keeps its own formatting: it was never
    // serialized, so it is not fenced.
    expect(delivered).toContain("- working directory:");
    expect(answered.value.output).toContain("Read both.");
  });

  it("R5: an output read comes back as its pinned window, not as a snapshot", function* () {
    const held = yield* useHarness();
    // A real entry, through the ordinary path, so the read has something of its
    // own to resolve against.
    const submitted = yield* held.session.submit("Printed by the entry.\n");
    if (!submitted.ok) {
      throw submitted.error;
    }
    const settled = yield* submitted.value.join();
    if (!settled.ok) {
      throw settled.error;
    }
    held.fake.script({ reply: "<REPL.Entry.Output entry={1} />\n" });
    held.fake.script({ reply: "<Output>I read it.</Output>\n" });

    const answered = yield* held.owner.message("what did it print?");
    if (!answered.ok) {
      throw answered.error;
    }
    const delivered = held.fake.prompts[1] ?? "";
    // The page the read resolved to, as the page it is: the entry it named,
    // what that entry printed, and the window it sat in.
    const page = JSON.parse(delivered);
    expect(page).toMatchObject({
      entry: 1,
      status: "completed",
      text: "Printed by the entry.\n",
      offset: 0,
      previous: null,
      next: null,
    });
    // One result is its own value, with no heading or fence around it: the
    // reply asked one question and this is the answer, parseable as it stands.
    expect(delivered).not.toContain("## REPL.Entry.Output");
    expect(delivered).not.toContain("```");
    expect(answered.value.output).toContain("I read it.");
  });

  it("R5: a Submit refused before it reserved anything still goes back", function* () {
    const held = yield* useHarness();
    // An empty draft, so the gate refuses before any slot is taken. Nothing is
    // written down for it — a reservation that was never taken has no outcome —
    // and the reply still has to be told.
    held.fake.script({ reply: "<REPL.Submit />\n" });
    held.fake.script({ reply: "<Output>I will prepare source first.</Output>\n" });

    const answered = yield* held.owner.message("submit it");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(held.fake.prompts).toHaveLength(2);
    const delivered = held.fake.prompts[1] ?? "";
    expect(delivered).toContain("REPL.Submit refused");
    // The reason has to say what to do next, so it names the draft.
    expect(delivered).toContain("the shared entry draft is empty");
    // And it names no entry, because none was admitted.
    expect(delivered).not.toContain("entry-1");

    // No entry, no reservation, and a history that still reads.
    expect(held.session.model.entries).toHaveLength(0);
    const written = yield* records(held.execution);
    expect(
      written.filter((record) => (record as { kind: string }).kind === "control"),
    ).toHaveLength(0);
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.submit).toBe(undefined);
    expect(answered.value.output).toContain("I will prepare source first.");
  });

  it("R5: two reads come back with their own headings, in admission order", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Guide.Lifetimes />\n<REPL.Environment />\n" });
    held.fake.script({ reply: "<Output>Read both.</Output>\n" });

    const answered = yield* held.owner.message("what should I know?");
    if (!answered.ok) {
      throw answered.error;
    }
    const delivered = held.fake.prompts[1] ?? "";
    // Two results, so each says which control produced it — and in the order
    // the reply admitted them, not in the order they happened to finish.
    expect(delivered).toContain("## Guide.Lifetimes");
    expect(delivered).toContain("## REPL.Environment");
    expect(delivered.indexOf("## Guide.Lifetimes")).toBeLessThan(
      delivered.indexOf("## REPL.Environment"),
    );
    // The chapter and the snapshot themselves, not a description of them.
    expect(delivered).toContain("# Lifetimes");
    expect(delivered).toContain("- working directory:");
    expect(answered.value.output).toContain("Read both.");
  });

  it("R5: reopening restores the chat and asks the provider for nothing", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>Noted.</Output>\n" });
    const answered = yield* held.owner.message("remember this");
    if (!answered.ok) {
      throw answered.error;
    }
    const before = held.fake.prompts.length;

    // Reopened the way a cold process does: the repository reads the file back
    // and hands over its own writer and records. Nothing is sent — restoring a
    // chat is not a turn.
    const cold = yield* held.repository.open(held.execution.id);
    const chat = cold.chat as PairedChatStorage;
    const reopened = yield* useSidekickOwner({
      assembly: held.profile.sidekickAssembly,
      chat,
      // deno-lint-ignore require-yield
      *establish(): Operation<Result<PairedChatStorage>> {
        return Ok(chat);
      },
      root: {
        ...rootReads(held.session, held.profile),
        // deno-lint-ignore require-yield
        *fill(): Operation<Result<void>> {
          throw new Error("reopening filled the draft");
        },
      },
      // deno-lint-ignore require-yield
      *submit(): Operation<Result<SubmitReceipt>> {
        throw new Error("reopening submitted an entry");
      },
      revision: () => 0,
      // deno-lint-ignore require-yield
      *acknowledge(): Operation<void> {
        // These rows hold their own state directly rather than through the
        // screen's loop, so a saved message needs nothing applied for it.
      },
      draft: () => "",
    });

    const reading = reopened.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.active).toBe(answered.value.conversation);
    expect(reading.value.chat).toHaveLength(2);
    expect(reading.value.chat[1]).toMatchObject({ kind: "reply", text: "Noted." });
    // No turn, and no agent process at all.
    expect(held.fake.prompts).toHaveLength(before);
    expect(held.fake.ensured).toHaveLength(1);
  });
});

/**
 * The entry a reply prepares and submits in the mounted rows below.
 *
 * One evaluated block that publishes a binding and one `<Output>`, because both
 * halves are read back: the binding by the second message's own read, and the
 * output by the receipt the first message is answered with.
 */
function entrySource(name: string, value: string, rendered: string): string {
  return [
    '<Let as="code" select="code">',
    "````xmd",
    "```js eval",
    `const ${name} = ${JSON.stringify(value)};`,
    "```",
    "",
    `<Output>${rendered}</Output>`,
    "````",
    "</Let>",
    "<REPL.EntryInput>{code}</REPL.EntryInput>",
    "<REPL.Submit />",
    "<Output>Submitted it.</Output>",
    "",
  ].join("\n");
}

/**
 * Tier R5/MP — the same path, reached from the screen.
 *
 * The rows above drive the owner the way the loop does. These drive the loop:
 * `runReplProgram` opens the repository, the session and the Sidekick, and the
 * message goes in through the mounted box and the mounted control. What is
 * replaced is the transport under the provider and the terminal under the
 * renderer, and nothing else — so what these add to R5 is the production
 * connection between somebody typing and the entry that runs.
 */
/** One real history, projected the way the root projects it. */
function* projected(chat: readonly SidekickRecord[]): Operation<SidekickReading> {
  const read = projectSidekick(chat);
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

/**
 * Wait until this command's own history holds this many evaluated replies.
 *
 * In the file, because a reply that says nothing to a person reaches no row: a
 * screen this one is waiting on would be waiting for text nothing is going to
 * draw.
 */
function* savedReplies(repl: MountedRepl, count: number): Operation<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const read = yield* mountedReading(repl);
    if (read.chat.filter((one) => one.kind === "response").length >= count) {
      return;
    }
    yield* settled(20);
  }
  throw new Error(`this chat never saved ${count} replies`);
}

/**
 * Every line of readable text this command's own chat composes into.
 *
 * Read from the files the mounted command wrote, through the same projection
 * and the same composition the screen is built from. It answers the one
 * question a screen search cannot: a sentence about an absence, a bare agent
 * name and an empty row are all *rows*, and asking the screen whether a row is
 * missing is asking it about the gaps between what it drew.
 */
function* composedChat(repl: MountedRepl): Operation<readonly string[]> {
  const read = yield* mountedReading(repl);
  const known = yield* projected(read.chat);
  return sidekickChatLines(
    Object.freeze({
      chat: sidekickChatRows(known, undefined),
      turns: Object.freeze([]),
      busy: false,
      agent: MOUNTED_AGENT,
      refusal: undefined,
      question: undefined,
      conversation: known.active,
      requested: undefined,
      verified: undefined,
      reading: known.active,
      setup: undefined,
      current: true,
      availability: Object.freeze({
        chats: Object.freeze([]),
        sessions: Object.freeze([]),
        refusal: undefined,
      }),
    }),
  ).map((line) => line.text);
}

/**
 * Tier PV — what a response is saying, while it is still saying it (#883, PV1).
 *
 * The literal Output of a reply arrives on the screen as it streams, labelled
 * as a preview, and nothing about it has happened yet: no control has run, no
 * turn is acknowledged, and nothing was pressed to make it appear. The same
 * item then becomes the evaluated reply.
 */
describe("Tier PV — a response in flight, shown as it arrives", () => {
  /**
   * A reply whose text arrives in pieces, with candidate controls in it.
   *
   * The Output region is split across two pieces, so the first prefix holds a
   * region nobody has closed — exactly what a transport delivers halfway
   * through — and the controls arrive only in the second.
   */
  const STREAMED = [
    "<Output>Half a thought",
    [
      ".</Output>\n",
      '<Let as="code" select="code">',
      "````xmd",
      "```js eval",
      'const said = "the entry ran";',
      "```",
      "",
      "<Output>{said}</Output>",
      "````",
      "</Let>",
      "<REPL.EntryInput>{code}</REPL.EntryInput>",
      "<REPL.Submit />",
      "",
    ].join("\n"),
  ];

  it("PV1: literal Output arrives as a preview, with nothing pressed and nothing run", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    // Held at the boundary between the pieces, so the second one arrives while
    // nothing else is happening: what reaches the screen then reached it
    // because the observation announced itself. And held again once both have
    // arrived and before the provider finishes, which is where the whole
    // candidate — its controls included — is on the screen and none of it has
    // run.
    repl.fake.script({
      deltas: STREAMED,
      holdsEachPiece: true,
      holdAfter: STREAMED.length,
    });
    repl.fake.script({ reply: "<Output>And the receipt.</Output>\n" });

    // Their own text in both composers first, which none of this may touch.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");
    yield* sendMessage(repl, "think");
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "later");

    // Generation is in flight with one piece delivered. Nothing is pressed from
    // here: what arrives has to arrive on its own.
    yield* repl.fake.streamingTurns(1);
    const fed = repl.terminal.fed;
    yield* awaiting(repl.terminal, "the preview of what has been said", (one) =>
      shows(one, `${MOUNTED_AGENT} (preview): Half a thought`),
    );
    expect(repl.terminal.fed).toBe(fed);

    // And nothing of it has happened. The controls are in the *second* piece,
    // so this is before them — but nothing from the first has run either: no
    // control pair, no entry, no reply.
    const during = yield* mountedReading(repl);
    expect(during.chat.filter((record) => record.kind === "control")).toEqual([]);
    expect(during.chat.filter((record) => record.kind === "response")).toEqual([]);
    expect(during.model.entries).toEqual([]);
    // The screen says the same thing by what it is showing: the catalog holds
    // no entry, and the draft is still a draft somebody is holding rather than
    // work that has been admitted.
    expect(shows(repl.terminal, "No entry yet")).toBe(true);
    // Both composers still hold what was typed into them, and the Sidekick is
    // working — so Stop is the control, not Send.
    expect(draftText(repl.terminal)).toBe("mine");
    expect(messageText(repl.terminal)).toBe("later");
    expect(shows(repl.terminal, "[stop]")).toBe(true);
    // The Sidekick's own control is Stop while it works. The entry draft keeps
    // its own Send beside it — they are two destinations with two controls —
    // so this asks the pane rather than the whole screen.
    const pane = screenOf(repl.terminal).map((line) => line.slice(sidekickColumn(repl.terminal)));
    expect(rowsShow(pane, "[send]")).toBe(false);

    // The rest of the text arrives, and the entry the reply submits is held
    // open: generation is over and the response is running its controls.
    const closing = gate.holdNext(
      (path, record) => path.endsWith("entries.jsonl") && record.includes('"type":"close"'),
    );
    repl.fake.releaseDeltas();
    // The update, with nothing else going on and still nothing pressed: the
    // sentence is finished by the piece that just arrived.
    yield* awaiting(repl.terminal, "the finished sentence", (one) =>
      shows(one, `${MOUNTED_AGENT} (preview): Half a thought.`),
    );
    expect(repl.terminal.fed).toBe(fed);

    // The whole candidate has now arrived — the EntryInput and the Submit came
    // with that second piece — and the provider has not finished. None of it
    // has run: no control pair, no fill, no entry. This is the boundary the
    // claim is about, because source nobody completed is not a program.
    yield* repl.fake.streamingTurns(1);
    const complete = yield* mountedReading(repl);
    expect(complete.chat.filter((record) => record.kind === "control")).toEqual([]);
    expect(complete.chat.filter((record) => record.kind === "response")).toEqual([]);
    expect(complete.model.entries).toEqual([]);
    expect(draftText(repl.terminal)).toBe("mine");
    expect(shows(repl.terminal, "No entry yet")).toBe(true);
    expect(repl.terminal.fed).toBe(fed);

    repl.fake.releaseDeltas();
    yield* closing.started();
    // Still a preview while its controls run: nothing has been evaluated into
    // a reply.
    expect(shows(repl.terminal, `${MOUNTED_AGENT} (preview): Half a thought.`)).toBe(true);
    const running = yield* mountedReading(repl);
    expect(running.chat.filter((record) => record.kind === "response")).toEqual([]);

    // Released: the entry settles, the response is evaluated, and the same item
    // becomes the reply — the preview is gone, not joined by an answer.
    closing.release();
    yield* awaiting(repl.terminal, "the evaluated reply", (one) =>
      saidBySidekick(one, "Half a thought."),
    );
    yield* settled(40);
    expect(shows(repl.terminal, "(preview)")).toBe(false);
    const after = yield* mountedReading(repl);
    // One response record for the turn that was being previewed, and exactly
    // one: the item a person watched arrive is the item they are reading.
    const answered = after.chat.filter(
      (record) => record.kind === "response" && record.response === "response:1",
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ output: "Half a thought.", hasOutput: true });
    // The entry really ran, and its feedback went back as the next turn's
    // request rather than as chat.
    expect(after.model.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
    yield* awaiting(repl.terminal, "the turn that was told what it did", (one) =>
      shows(one, "And the receipt."),
    );
    expect(repl.fake.prompts[1] ?? "").toContain("## REPL.Submit");
    expect(shows(repl.terminal, "REPL.Submit")).toBe(false);
  });
  it("PV2: what the screen shows a prefix saying is what the pure reader says", function* () {
    const repl = yield* useMountedRepl();
    /**
     * One sequence of prefixes, each the whole of what has arrived.
     *
     * A delimiter split mid-tag, an interpolation whose value nothing has
     * computed, a passive fence that only looks like a region, and a region
     * nested inside another — which is refused rather than shown. What the
     * screen may say about each is the pure reader's answer, so the reader is
     * what each one is compared against rather than a string chosen here.
     */
    const pieces = [
      "<Out",
      "put>one</Output>\n",
      "<Output>then {computed}</Output>\n",
      "Here is an example:\n\n```md\n<Output>not a region</Output>\n```\n",
      "<Output>outer <Output>inner</Output></Output>\n",
    ];
    // Held before every piece after the first, and once more when they have
    // all arrived: the last prefix is the invalid one, and what it does to the
    // screen has to be observable before the provider finishes — otherwise
    // evaluation's own refusal could be what took the body away.
    repl.fake.script({ deltas: pieces, holdsEachPiece: true, holdAfter: pieces.length });

    yield* sendMessage(repl, "stream it");
    // One step per boundary in the transport: the pieces up to here have
    // arrived, and the next one waits until this prefix has been read.
    for (let at = 0; at < pieces.length - 1; at += 1) {
      yield* repl.fake.streamingTurns(1);
      const whole = pieces.slice(0, at + 1).join("");
      const projected = previewGeneratedXmdRoot(whole);
      // Settled on the frame, then compared: what is on the screen for this
      // prefix is what the reader projects from it, and a refusal shows no body
      // at all rather than source.
      yield* settled(40);
      if (projected.ok && projected.value.output !== "") {
        yield* awaiting(repl.terminal, `the projection of prefix ${at + 1}`, (one) =>
          shows(one, `${MOUNTED_AGENT} (preview): ${projected.value.output.split("\n")[0]}`),
        );
      } else {
        expect(shows(repl.terminal, "(preview)")).toBe(false);
      }
      // Nothing about a prefix is executed, however complete it reads: a
      // syntactically whole region is not permission to run anything.
      const during = yield* mountedReading(repl);
      expect(during.chat.filter((record) => record.kind === "response")).toEqual([]);
      expect(during.model.entries).toEqual([]);
      // The interpolation waits rather than being guessed at, and a passive
      // example is not a region.
      expect(shows(repl.terminal, "{computed}")).toBe(false);
      expect(shows(repl.terminal, "not a region")).toBe(false);
      repl.fake.releaseDeltas();
    }

    // The whole candidate has arrived and the provider has not finished. Its
    // last piece nests a region inside another, which the reader refuses — so
    // the body is gone now, before anything was evaluated.
    yield* repl.fake.streamingTurns(1);
    expect(previewGeneratedXmdRoot(pieces.join("")).ok).toBe(false);
    yield* awaiting(repl.terminal, "the body being withdrawn", (one) => !shows(one, "(preview)"));
    const withdrawn = yield* mountedReading(repl);
    expect(withdrawn.chat.filter((record) => record.kind === "response")).toEqual([]);
    // And no source is shown in its place.
    expect(shows(repl.terminal, "<Output>")).toBe(false);
    repl.fake.releaseDeltas();
    // Bounded, and settled on what the files say: the response record is what
    // ends this turn, and the screen follows it.
    let answered = false;
    for (let tries = 0; tries < 200 && !answered; tries += 1) {
      answered = (yield* mountedReading(repl)).chat.some((record) => record.kind === "response");
      if (!answered) {
        yield* settled(20);
      }
    }
    expect(answered).toBe(true);
    expect(shows(repl.terminal, "(preview)")).toBe(false);
  });

  it("PV1: the preview and the reply that replaces it are one item", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ deltas: STREAMED, holdsEachPiece: true });

    yield* sendMessage(repl, "think");
    yield* repl.fake.streamingTurns(1);
    yield* awaiting(repl.terminal, "the preview", (one) =>
      shows(one, `${MOUNTED_AGENT} (preview): Half a thought`),
    );
    // The history as it stood while that preview was on the screen: the
    // person's message and no response at all.
    const during = (yield* mountedReading(repl)).chat;
    expect(during.filter((record) => record.kind === "response")).toEqual([]);

    repl.fake.releaseDeltas();
    yield* awaiting(repl.terminal, "the evaluated reply", (one) =>
      saidBySidekick(one, "Half a thought."),
    );
    // The screen says the Sidekick's words as soon as it has said them, and
    // this reply carries an entry: the response is published once that entry
    // has been evaluated, which is after the row is drawn. Caught on a loaded
    // runner as a published chat whose last record was still the control the
    // evaluation had just taken. So the fact this row goes on to read is the
    // one it waits for.
    yield* awaitedFact("the reply reaching the published chat", function* () {
      return (yield* mountedReading(repl)).chat.some((record) => record.kind === "response");
    });
    const after = (yield* mountedReading(repl)).chat;
    const answered = after.flatMap((record) =>
      record.kind === "response"
        ? [{ response: record.response, conversation: record.conversation }]
        : [],
    );
    expect(answered).toHaveLength(1);

    // One reply, under one response, composed through the production
    // composition out of the acknowledged history: nothing live is left beside
    // it. What the identity actually is across that transition is the pair of
    // rows below, from the owner's own live facts.
    const retained = sidekickChatRows(yield* projected(after), undefined);
    expect(retained.filter((row) => row.kind === "reply")).toHaveLength(1);
    expect(retained.filter((row) => row.kind === "preview")).toEqual([]);
    // The same is true of what is drawn: one agent row, not two.
    expect(shows(repl.terminal, "(preview)")).toBe(false);
  });

  /**
   * One generation is one item, from its first word to whatever ends it.
   *
   * Composed through the production composition from the owner's own facts at
   * two real moments: the preview that was actually on offer while generation
   * was held, and the reading after the cycle and its cleanup have both
   * finished. Nothing here is reconstructed from a record that landed later —
   * which matters, because the thing being asserted is that the row somebody
   * was watching is the row that remains, and a snapshot built after the fact
   * would be built out of the answer.
   *
   * Both ends of one transition: a generation that failed and one that
   * succeeded. The failed one is the case that needs it — its saved account is
   * a turn, addressed by a name the history holds, and a screen that let that
   * replace the item rather than fill it would mount two rows for one failure.
   */
  function* oneItem(failing: boolean): Operation<void> {
    const held = yield* useHarness();
    held.fake.script({
      deltas: ["<Output>Visible.</Output>", "\n"],
      holdAfter: 1,
      ...(failing ? { stopReason: "refusal" } : {}),
    });
    const task = yield* spawn(() => held.owner.message("say"));
    yield* held.fake.streamingTurns(1);
    yield* awaited("the preview", () => held.owner.previewing?.output === "Visible.");

    const during = held.owner.reading;
    if (!during.ok) {
      throw during.error;
    }
    const before = sidekickChatRows(during.value, held.owner.previewing).filter(
      (row) => row.kind !== "person",
    );
    expect(before).toHaveLength(1);
    expect(before[0]?.kind).toBe("preview");

    held.fake.releaseDeltas();
    const answer = yield* task;
    expect(answer.ok).toBe(true);
    const settled_ = held.owner.reading;
    if (!settled_.ok) {
      throw settled_.error;
    }
    // Read after the response's own cleanup has run, which is where a forgotten
    // association used to resurrect the live row beside the saved one.
    const after = sidekickChatRows(settled_.value, held.owner.previewing).filter(
      (row) => row.kind !== "person",
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.kind).toBe(failing ? "incomplete" : "reply");
    // What that row says is the saved account, not the live one: a failure it
    // can be retried from, and the Output the attempt had managed.
    if (failing) {
      expect(after[0]?.failure).not.toBe(undefined);
      expect(after[0]?.retry).not.toBe(undefined);
      expect(after[0]?.text).toBe("Visible.");
    }
  }

  it("PV1: a failed generation leaves one Incomplete in the item it was shown in", function* () {
    yield* oneItem(true);
  });

  it("PV1: control — a successful generation leaves one reply in that same item", function* () {
    yield* oneItem(false);
  });

  it("PV1: a reply that says nothing to the person leaves no preview behind", function* () {
    const repl = yield* useMountedRepl();
    // Controls and no Output at all: a response's own working is not chat, and
    // a preview of it would be a body nobody wrote.
    repl.fake.script({
      deltas: ["<REPL.Bindings ", "/>\n"],
      holdAfter: 1,
    });
    repl.fake.script({ reply: "<Output>Read it.</Output>\n" });

    yield* sendMessage(repl, "look");
    yield* repl.fake.streamingTurns(1);
    yield* settled(40);
    // Nothing to preview, because nothing was said: a declared control is not
    // literal Output, and the half-written element is not source to show.
    expect(shows(repl.terminal, "(preview)")).toBe(false);
    expect(shows(repl.terminal, "REPL.Bindings")).toBe(false);

    repl.fake.releaseDeltas();
    yield* awaiting(repl.terminal, "the turn that was told what it read", (one) =>
      shows(one, "Read it."),
    );
    // ER2 — and the follow-up that *did* say something says it, in its own row,
    // exactly as it always has: removing the silent reply's notice removes a
    // sentence nobody wrote and nothing else.
    expect(saidBySidekick(repl.terminal, "Read it.")).toBe(true);
    expect(shows(repl.terminal, "(preview)")).toBe(false);
    // And the reply that selected no chat contributed no utterance at all. The
    // superseded form of this row asserted a sentence about the absence; what
    // it asserts now is that there is none — and no bare name, no metadata
    // substitute and no empty row standing in for one either.
    expect(shows(repl.terminal, "answered without saying")).toBe(false);
    const composed = yield* composedChat(repl);
    expect(composed).toEqual(["  you: look", `  ${MOUNTED_AGENT}: Read it.`]);
  });

  /**
   * ER1 — a successful control-only reply is work, and not an utterance.
   *
   * The real control path: a reply that reads Bindings and says nothing, and
   * the automatic follow-up carrying its result, which also says nothing. Both
   * turns really happened — the control ran, its literal result reached the
   * next prompt, and both turns are saved — and neither of them told the person
   * anything, so neither of them is in the chat.
   */
  it("ER1: a reply that only runs controls leaves the request and nothing else", function* () {
    const repl = yield* useMountedRepl();
    // Two controls and no Output, then a follow-up that adds nothing: source is
    // not Output, so both turns succeeded and said nothing to anybody. Two
    // rather than one so that what came back is a result a reader can tell
    // apart from an empty answer.
    repl.fake.script({ reply: "<REPL.Bindings />\n<REPL.Environment />\n" });
    repl.fake.script({ reply: "Nothing to add.\n" });

    yield* sendMessage(repl, "look");
    // Waited for in the history rather than on the screen, because the chat is
    // exactly where these two replies have nothing to say: there is no row for
    // either of them to arrive in, so what settles this is the file.
    yield* savedReplies(repl, 2);
    yield* settled(40);

    // What a person asked for is still there, and nothing of the two replies is.
    expect(saidByPerson(repl.terminal, "look")).toBe(true);
    expect(shows(repl.terminal, "answered without saying")).toBe(false);
    expect(shows(repl.terminal, "(preview)")).toBe(false);
    expect(shows(repl.terminal, "REPL.Bindings")).toBe(false);
    expect(shows(repl.terminal, "Nothing to add.")).toBe(false);
    // Asked of the composition rather than of the screen, because this is the
    // question a screen search cannot answer: an empty row, a bare agent name
    // or a metadata sentence would all be *rows*, and the chat has one row.
    expect(yield* composedChat(repl)).toEqual(["  you: look"]);

    // The work happened. The control ran, and its literal result is what the
    // follow-up was asked with — so the turn that said nothing is the turn that
    // did something.
    expect(repl.fake.prompts).toHaveLength(2);
    const carried = repl.fake.prompts[1] ?? "";
    expect(carried).toContain("## REPL.Bindings");
    expect(carried).toContain("## REPL.Environment");
    expect(carried).toContain("a controlled mounted host");
    expect(carried.indexOf("## REPL.Bindings")).toBeLessThan(
      carried.indexOf("## REPL.Environment"),
    );
    // And every record is still there: both saved turns, the control's own
    // intent and outcome, and the feedback that carried it.
    const read = yield* mountedReading(repl);
    const known = yield* projected(read.chat);
    expect(known.turns.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(known.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(known.turns.map((turn) => turn.asked)).toEqual(["person", "automatic"]);
    expect(known.turns.every((turn) => turn.reply?.hasOutput === false)).toBe(true);
    expect(known.operations.map((one) => one.component)).toEqual([
      "REPL.Bindings",
      "REPL.Environment",
    ]);
    expect(known.operations.map((one) => one.status)).toEqual(["ok", "ok"]);
    expect(known.delivered).toEqual([{ conversation: known.active, turn: 2 }]);
    // Sessions keeps both turns with their own titles and status: a silent
    // reply is absent from the chat and from nothing else.
    expect(
      sidekickTurnRows(known, undefined).map((row) => `${row.title} \u00b7 ${row.state}`),
    ).toEqual(["look \u00b7 completed", "Automatic feedback \u00b7 completed"]);
  });

  /**
   * ER3 — a reply that failed is not a reply that said nothing.
   *
   * The same shape as a silent success — an evaluated reply with no Output —
   * and the opposite answer: the reason it failed is the one thing a reader can
   * act on, so it stays whether or not the response that failed had rendered
   * anything.
   */
  it("ER3: an evaluated reply that failed keeps its reason, with no Output to show", function* () {
    const repl = yield* useMountedRepl();
    // A name this ceiling does not admit, which refuses the whole reply before
    // any control runs. No Output was selected, so a rule filtering every
    // reply that rendered nothing would take this failure with it.
    repl.fake.script({ reply: "<REPL.Delete />\n" });
    repl.fake.script({ reply: "<Output>Fixed it.</Output>\n" });

    yield* sendMessage(repl, "remove it");
    yield* awaiting(repl.terminal, "the recorded reason", (one) =>
      shows(one, `${MOUNTED_AGENT} (failed):`),
    );
    // Its own recorded reason, and not a status this screen composed: what the
    // row says is what the history holds.
    const read = yield* mountedReading(repl);
    const known = yield* projected(read.chat);
    const failed = known.chat.find((item) => item.kind === "reply");
    if (failed === undefined || failed.kind !== "reply") {
      throw new Error("this history recorded no evaluated reply");
    }
    expect(failed.hasOutput).toBe(false);
    expect(failed.failure).not.toBe(undefined);
    expect(shows(repl.terminal, (failed.failure ?? "").slice(0, 24))).toBe(true);
    // The saved outcome says so too, so a fabricated sentence could not pass
    // this row: the turn is recorded as a reply that failed.
    expect(sidekickTurnRows(known, undefined)[0]?.state).toBe("reply failed");
    // And the correction it was given, which answered: the failure stands in
    // the chat beside the reply that followed it, in that order.
    yield* awaiting(repl.terminal, "the corrected reply", (one) =>
      saidBySidekick(one, "Fixed it."),
    );
    expect(yield* composedChat(repl)).toEqual([
      "  you: remove it",
      `  ${MOUNTED_AGENT} (failed): ${failed.failure}`,
      `  ${MOUNTED_AGENT}: Fixed it.`,
    ]);
  });
});

/**
 * A reply that prepares an entry whose preflight suspends, and submits it.
 *
 * Its one element is a component read from a file the row below gates, so the
 * preflight has somewhere to wait — between the slot being reserved and the
 * entry starting, which is the window the start check exists for.
 */
const GATED_ENTRY_REPLY = [
  '<Let as="entry" select="code">',
  "```md",
  "<GateThing />",
  "```",
  "</Let>",
  "<REPL.EntryInput>{entry}</REPL.EntryInput>",
  "<REPL.Submit />",
  "",
].join("\n");

describe("Tier R5 — a mounted message prepares and submits a real entry", () => {
  it("M3: the message a person sends runs its entry, and is answered about it", function* () {
    const repl = yield* useMountedRepl();
    const { terminal, fake } = repl;
    // The reply that prepares and submits, then the turn told what its writes did.
    fake.script({ reply: entrySource("greeting", "Hello from the reply.", "{greeting}") });
    fake.script({ reply: "<Output>Thanks for the receipt.</Output>\n" });
    yield* send(terminal, "greet");
    yield* untilShown(terminal, "the reply answering about its own entry", (one) =>
      shows(one, "Thanks for the receipt."),
    );

    // One entry ran, from the source the reply captured with its fence intact.
    const first = yield* mountedReading(repl);
    expect(first.model.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
    expect(first.model.entries[0]?.source).toContain("```js eval");
    expect(first.model.entries[0]?.source).toContain("Hello from the reply.");
    expect(first.model.entries[0]?.terminal?.output).toContain("Hello from the reply.");
    expect(shows(terminal, "Hello from the reply.")).toBe(true);
    expect(draftText(terminal)).toBe("");

    // The receipt names this entry, carries no body, and keeps admission order.
    expect(fake.prompts).toHaveLength(2);
    const receipt = fake.prompts[1] ?? "";
    expect(receipt).toContain("## REPL.EntryInput");
    expect(receipt).toContain("## REPL.Submit");
    expect(receipt).toContain("Entry entry-1 completed.");
    expect(receipt).not.toContain("```js eval");
    expect(receipt.indexOf("## REPL.EntryInput")).toBeLessThan(receipt.indexOf("## REPL.Submit"));

    // The chat is the message and the replies' own Output, nothing else.
    expect(saidByPerson(terminal, "greet")).toBe(true);
    expect(saidBySidekick(terminal, "Submitted it.")).toBe(true);
    expect(saidBySidekick(terminal, "Thanks for the receipt.")).toBe(true);
    expect(shows(terminal, "REPL.EntryInput")).toBe(false);

    // A second message in the same conversation, which is not oriented again.
    fake.script({ reply: "<REPL.Bindings />\n" });
    fake.script({ reply: entrySource("greeting", "| a | b |", "{greeting}") });
    fake.script({ reply: "<Output>Revised it.</Output>\n" });
    yield* send(terminal, "table");
    yield* untilShown(terminal, "the revision being answered", (one) => shows(one, "Revised it."));

    const second = yield* mountedReading(repl);
    const conversations = new Set(
      second.chat.flatMap((record) => (record.kind === "message" ? [record.conversation] : [])),
    );
    expect(conversations.size).toBe(1);
    expect(second.execution).toBe(first.execution);
    // The read came back with what the first entry published, as the history stands.
    expect(fake.prompts).toHaveLength(5);
    expect(JSON.parse(fake.prompts[3] ?? "")).toEqual({ greeting: "Hello from the reply." });
    expect(second.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
    expect(second.model.entries[1]?.terminal?.output).toContain("| a | b |");
    expect(fake.prompts[4] ?? "").toContain("Entry entry-2 completed.");
  });

  /**
   * #971 B1: the Sidekick's own rows carry the entry each reply admitted.
   *
   * The association is read out of the Submit records this history already
   * holds — which chat and which response performed the control, the slot it
   * reserved, the entry key it named and the exact source it reserved — so a
   * reply that really admitted an entry is followed by that entry's own state
   * and output, and a reply that admitted nothing is followed by nothing.
   *
   * What the row *says* is read from the model where it is drawn and nowhere
   * else: a reply's wording is not an account of what its entry did, and the
   * two are deliberately different strings here so that one cannot pass for the
   * other.
   */
  it("M3: each reply's rows carry the entry it admitted, and nothing it did not", function* () {
    // A component the entry below reads, so its preflight has somewhere to
    // wait: between the slot being reserved and the entry actually starting,
    // which is the window the start check exists for.
    const directory = yield* useTemporary("xmd-971-refused-reservation-");
    yield* until(writeFile(join(directory, "GateThing.md"), "The manual entry ran.\n"));
    const reached = withResolvers<void>();
    const allow = withResolvers<void>();
    // Released at the end whatever happened, so a failing row leaves no latch.
    yield* ensure(() => allow.resolve());
    let holding = false;
    yield* API.Fs.around({
      *readTextFile([path], next): Operation<string> {
        if (holding && path.endsWith("GateThing.md")) {
          holding = false;
          reached.resolve();
          yield* allow.operation;
        }
        return yield* next(path);
      },
    });
    const host = yield* useMountedHost({ includes: [directory] });
    let execution = "";
    /** A position holding the first entry and not the second. */
    let earlier = "";
    let entries = "";
    let chat = "";

    yield* scoped(function* (): Operation<void> {
      const repl = yield* useMountedRepl({ host });
      repl.fake.script({ reply: entrySource("first", "the first entry ran", "{first}") });
      repl.fake.script({ reply: "<Output>That is one.</Output>\n" });
      yield* sendMessage(repl, "run one");
      yield* awaiting(repl.terminal, "the first receipt", (one) => shows(one, "That is one."));

      const after = yield* mountedReading(repl);
      execution = after.execution;
      expect(after.model.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      // The position as it stands with one entry admitted, for the prefix arm
      // below. Taken now, because what makes it a prefix is what came after it.
      earlier = after.model.checkpoints[after.model.checkpoints.length - 1]?.marker ?? "";
      expect(earlier).not.toBe("");

      repl.fake.script({ reply: entrySource("second", "the second entry ran", "{second}") });
      repl.fake.script({ reply: "<Output>That is two.</Output>\n" });
      yield* sendMessage(repl, "run two");
      yield* awaiting(repl.terminal, "the second receipt", (one) => shows(one, "That is two."));

      // Each reply's work, after the reply that admitted it: the entry the
      // record names, the state the model holds it in, and what it actually
      // printed. The entry's own words and the reply's are different strings,
      // so a row carrying the reply's wording could not pass for either.
      const live = yield* mountedReading(repl);
      expect(live.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      const pane = sidekickPaneIn(screenOf(repl.terminal));
      const at = (said: string): number => pane.findIndex((row) => row.includes(said));
      expect(at("Entry 1 \u00b7 \u2713 COMPLETED")).toBeGreaterThan(at("Submitted it."));
      expect(at("the first entry ran")).toBe(at("Entry 1 \u00b7 \u2713 COMPLETED") + 1);
      expect(at("That is one.")).toBeGreaterThan(at("the first entry ran"));
      expect(at("Entry 2 \u00b7 \u2713 COMPLETED")).toBeGreaterThan(at("That is one."));
      expect(at("the second entry ran")).toBe(at("Entry 2 \u00b7 \u2713 COMPLETED") + 1);
      // One row each: a reply is followed by the entry it submitted, not by
      // every entry this execution has admitted.
      for (const said of ["Entry 1 \u00b7", "Entry 2 \u00b7"]) {
        expect([said, pane.filter((row) => row.includes(said)).length]).toEqual([said, 1]);
      }
      // The state is the model's own, not a word from the reply.
      expect(live.model.entries[0]?.terminal?.status).toBe("ok");
      expect(live.model.entries[0]?.terminal?.output).toContain("the first entry ran");

      // A reply that admits nothing is followed by nothing. The draft an
      // admission finished is empty, so this Submit is refused before any slot
      // is taken — no control record, and so no association to read.
      repl.fake.script({ reply: "<REPL.Submit />\n" });
      repl.fake.script({ reply: "<Output>I will prepare source first.</Output>\n" });
      yield* sendMessage(repl, "submit it");
      yield* awaiting(repl.terminal, "the refusal going back", (one) =>
        shows(one, "I will prepare source first."),
      );
      const refused = yield* mountedReading(repl);
      expect(refused.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      const after3 = sidekickPaneIn(screenOf(repl.terminal));
      const said = after3.findIndex((row) => row.includes("I will prepare source first."));
      expect(said).toBeGreaterThan(0);
      // Nothing after that reply says an entry: the rows below it are the
      // composer and the pane's own controls.
      expect(after3.slice(said + 1).some((row) => /Entry \d+ \u00b7/.test(row))).toBe(false);

      // And a reply whose reservation *was* retained and then refused, whose
      // exact reserved source somebody then runs themselves at the same slot.
      // This is the one the record's slot, key and source cannot tell apart on
      // their own: all three match, and the entry is still not that reply's.
      holding = true;
      repl.fake.script({ reply: GATED_ENTRY_REPLY });
      repl.fake.script({ reply: "<Output>I did not admit an entry.</Output>\n" });
      yield* sendMessage(repl, "run the gated one");
      yield* reached.operation;
      // The draft moves while the submission is being prepared, which is what
      // the start check refuses on: the prepared text is not the text anybody
      // is asking for any more.
      yield* focusDraft(repl.terminal);
      yield* typing(repl.terminal, "!");
      allow.resolve();
      yield* awaiting(repl.terminal, "the refused submission going back", (one) =>
        shows(one, "I did not admit an entry."),
      );

      // Retained, and retained as refused: an intent with a reservation, and
      // an outcome saying it ended without one. Nothing was admitted.
      const held = yield* mountedReading(repl);
      expect(held.model.entries.map((entry) => entry.key)).toEqual(["entry-1", "entry-2"]);
      // The reservation this message took, which is the last one written: the
      // two before it are the entries that really ran.
      const intent = held.chat
        .filter(
          (record) =>
            record.kind === "control" && record.component === "REPL.Submit" && record.submit,
        )
        .at(-1);
      if (intent?.kind !== "control" || intent.submit === undefined) {
        throw new Error("this history retained no Submit reservation to refuse");
      }
      const answered = held.chat.find(
        (record) =>
          record.kind === "control-outcome" &&
          record.conversation === intent.conversation &&
          record.response === intent.response &&
          record.order === intent.order,
      );
      if (answered?.kind !== "control-outcome" || answered.outcome.status !== "err") {
        throw new Error("that reservation was not retained as refused");
      }

      // Exactly the source it reserved, typed back in and run by hand. The
      // backspace takes off the character that moved the draft, which leaves
      // the reserved text itself.
      yield* focusDraft(repl.terminal);
      repl.terminal.feed("\x7f");
      yield* awaiting(repl.terminal, "the reserved source restored", (one) =>
        blockSays(draftText(one), intent.submit?.source ?? ""),
      );
      repl.terminal.feed("\r");
      yield* awaiting(repl.terminal, "the manual entry running", (one) =>
        shows(one, "The manual entry ran."),
      );
      const manual = yield* mountedReading(repl);
      // The same slot, the same key and the same source — every coordinate the
      // reservation named.
      const took = manual.model.entries[intent.submit.ordinal];
      expect([took?.key, took?.source]).toEqual([intent.submit.entry, intent.submit.source]);
      // And the refused reply is credited with none of it: no work row, no
      // state and no output of that entry anywhere after it.
      const paneNow = sidekickPaneIn(screenOf(repl.terminal));
      const refusedAt = paneNow.findIndex((row) => row.includes("I did not admit an entry."));
      expect(refusedAt).toBeGreaterThan(0);
      expect(paneNow.slice(refusedAt + 1).some((row) => /Entry \d+ \u00b7/.test(row))).toBe(false);
      expect(paneNow.some((row) => row.includes("The manual entry ran."))).toBe(false);
      expect(paneNow.filter((row) => /Entry \d+ \u00b7/.test(row))).toHaveLength(2);

      entries = yield* until(readFile(pairedLocation(host.root, execution).entries, "utf8"));
      chat = yield* until(readFile(pairedLocation(host.root, execution).sidekick, "utf8"));
      repl.terminal.end();
      yield* awaiting(repl.terminal, "the command leaving", () => repl.outcome() !== undefined);
    });

    // Cold, at a position that holds the first entry and not the second. The
    // association is read again from the same records, and the second reply's
    // work is not shown — an entry this prefix never admitted is not work this
    // reading can show.
    const calls = host.fake.prompts.length;
    yield* scoped(function* (): Operation<void> {
      const base = initialState(execution);
      const repl = yield* useMountedRepl({
        host,
        location: encodeLocation({ ...base.route, at: earlier }),
      });
      yield* awaiting(repl.terminal, "the cold chat", (one) => shows(one, "That is one."));
      const pane = sidekickPaneIn(screenOf(repl.terminal));
      const counted = (said: string): number => pane.filter((row) => row.includes(said)).length;
      // Once, after the one reply that admitted it. Twice would be an entry
      // handed to a reply that did not submit it — which is what following the
      // latest entry rather than the record's own coordinates would do here,
      // because this prefix holds exactly one.
      expect(counted("Entry 1 \u00b7 \u2713 COMPLETED")).toBe(1);
      expect(counted("the first entry ran")).toBe(1);
      expect(counted("Entry 2 \u00b7")).toBe(0);
      expect(counted("the second entry ran")).toBe(0);
      repl.terminal.end();
      yield* awaiting(
        repl.terminal,
        "the cold command leaving",
        () => repl.outcome() !== undefined,
      );
    });

    // And cold at the head, where every entry this execution admitted is in
    // the reading. The refusal is still a refusal: reopening reconciles what a
    // dead process left and retains what it finds, and what it finds here is
    // an answer already written — so nothing resurrects an association out of
    // a slot that was later filled by hand.
    yield* scoped(function* (): Operation<void> {
      const repl = yield* useMountedRepl({
        host,
        location: encodeLocation(initialState(execution).route),
      });
      yield* awaiting(repl.terminal, "the cold chat at the head", (one) =>
        shows(one, "I did not admit an entry."),
      );
      const pane = sidekickPaneIn(screenOf(repl.terminal));
      const refusedAt = pane.findIndex((row) => row.includes("I did not admit an entry."));
      expect(refusedAt).toBeGreaterThan(0);
      expect(pane.slice(refusedAt + 1).some((row) => /Entry \d+ \u00b7/.test(row))).toBe(false);
      expect(pane.some((row) => row.includes("The manual entry ran."))).toBe(false);
      // The two replies that really did admit still carry theirs, which is
      // what makes the absence above an answer rather than an empty pane.
      expect(pane.filter((row) => /Entry \d+ \u00b7/.test(row))).toHaveLength(2);
      repl.terminal.end();
      yield* awaiting(
        repl.terminal,
        "the second cold command leaving",
        () => repl.outcome() !== undefined,
      );
    });
    // And reading it asked nobody anything and wrote nothing.
    expect(host.fake.prompts).toHaveLength(calls);
    expect(yield* until(readFile(pairedLocation(host.root, execution).entries, "utf8"))).toBe(
      entries,
    );
    expect(yield* until(readFile(pairedLocation(host.root, execution).sidekick, "utf8"))).toBe(
      chat,
    );
  });
});

/**
 * Tier TE — the names a person published, and what a reply really does with them.
 *
 * The seed is an ordinary entry a person runs, the binding it publishes is the
 * one the reply reads, and the program the reply writes iterates that binding
 * with `<Each>` rather than carrying the names itself. Two arms differ in one
 * name and in nothing else, which is what makes the greetings evidence rather
 * than a transcript: a reply that wrote its greetings out by hand would answer
 * both arms identically.
 */
describe("Tier TE — a published binding becomes real greetings, and then a real table", () => {
  /** What the first arm publishes. */
  const FIRST = ["Ada", "Grace", "Linus"];
  /** The same arm with one name replaced, and nothing else changed. */
  const SECOND = ["Ada", "Grace", "Margaret"];

  /**
   * An ordinary seed entry, as a person types it.
   *
   * An evaluated block because that is what publishes a *root* binding: a
   * `<Let>` introduces a value for the document it is in, and the map a reply
   * reads is the one each entry durably published.
   */
  function seed(names: readonly string[]): string {
    return [
      "```js eval",
      `const names = ${JSON.stringify(names)};`,
      "```",
      "",
      "<Output>Names published.</Output>",
      "",
    ].join("\n");
  }

  /**
   * The greetings program, on one line.
   *
   * One line because the row below compares the draft's literal bytes on the
   * real screen, and the draft field draws one row — several lines would show
   * the last of them under a count of the rest, which is a reading of the
   * field rather than of the draft.
   */
  const GREETINGS = '<Output><Each in={names} let="name">Hello, {name}! </Each></Output>';

  /** The table program, which is read back through the entry it became. */
  const TABLE = [
    "<Output>",
    "| name |",
    "| --- |",
    '<Each in={names} let="name">| {name} |',
    "</Each>",
    "</Output>",
  ].join("\n");

  /** A reply that captures one program and fills the shared draft with it. */
  function fills(program: string, said: string): string {
    return [
      '<Let as="code" select="code">',
      "```xmd",
      program,
      "```",
      "</Let>",
      "<REPL.EntryInput>{code}</REPL.EntryInput>",
      `<Output>${said}</Output>`,
      "",
    ].join("\n");
  }

  /** The same, and it submits what it filled. */
  function submits(program: string, said: string): string {
    return [
      '<Let as="code" select="code">',
      "```xmd",
      program,
      "```",
      "</Let>",
      "<REPL.EntryInput>{code}</REPL.EntryInput>",
      "<REPL.Submit />",
      `<Output>${said}</Output>`,
      "",
    ].join("\n");
  }

  /**
   * One arm of the journey, driven through the real mounted command.
   *
   * The same driver for both arms: a seed a person runs, a message whose reply
   * reads the published map and fills the draft, a held response released into
   * a submission, and a second message that revises the entry as a table.
   */
  function* arm(names: readonly string[]): Operation<{
    readonly published: unknown;
    readonly heldDraft: string;
    readonly heldEntries: readonly string[];
    readonly greeting: { readonly source: string; readonly output: string };
    readonly table: { readonly source: string; readonly output: string };
    readonly greetingAfter: { readonly source: string; readonly output: string };
    readonly receipts: readonly string[];
    readonly conversations: number;
    readonly chatHas: (text: string) => boolean;
  }> {
    const repl = yield* useMountedRepl();

    // The seed, as a person's own entry: typed into the draft and run.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(seed(names)));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the seed entry publishing its names", (one) =>
      shows(one, "Names published."),
    );

    // The reply reads what that entry published, then prepares the greetings
    // from it — and the response that would submit them is held at the
    // transport, so the draft can be read while nothing has run.
    repl.fake.script({ reply: "<REPL.Bindings />\n" });
    repl.fake.script({ reply: fills(GREETINGS, "Prepared the greetings.") });
    repl.fake.script({ held: true, reply: "<REPL.Submit />\n<Output>Submitted it.</Output>\n" });
    repl.fake.script({ reply: "<Output>Thanks for the receipt.</Output>\n" });

    yield* sendMessage(repl, "greet");
    yield* repl.fake.holdingTurns(1);
    yield* awaiting(repl.terminal, "the draft holding the prepared greetings", (one) =>
      draftText(one).includes("<Each in={names}"),
    );

    // What the draft is holding, and what has run: a fill alone starts nothing,
    // so the seed is still the only entry there is.
    const heldDraft = draftText(repl.terminal);
    const held = yield* mountedReading(repl);

    repl.fake.releaseTurn();
    yield* awaiting(repl.terminal, "the reply answering about its own entry", (one) =>
      shows(one, "Thanks for the receipt."),
    );

    const after = yield* mountedReading(repl);

    // A second message in the same conversation, revising the same names as a
    // table. It prepares and submits in one response, so nothing is held.
    repl.fake.script({ reply: submits(TABLE, "Revised it as a table.") });
    repl.fake.script({ reply: "<Output>Table receipt.</Output>\n" });

    yield* sendMessage(repl, "table");
    yield* awaiting(repl.terminal, "the table being answered", (one) =>
      shows(one, "Table receipt."),
    );

    const finished = yield* mountedReading(repl);
    const conversations = new Set(
      finished.chat
        .filter((record) => record.kind === "message")
        .map((record) => (record.kind === "message" ? record.conversation : "")),
    );
    const screen = screenOf(repl.terminal).join("\n");

    const greetingEntry = finished.model.entries[1];
    const tableEntry = finished.model.entries[2];
    return {
      published: JSON.parse(repl.fake.prompts[1] ?? ""),
      heldDraft,
      heldEntries: held.model.entries.map((entry) => entry.key),
      greeting: {
        source: after.model.entries[1]?.source ?? "",
        output: after.model.entries[1]?.terminal?.output ?? "",
      },
      table: {
        source: tableEntry?.source ?? "",
        output: tableEntry?.terminal?.output ?? "",
      },
      greetingAfter: {
        source: greetingEntry?.source ?? "",
        output: greetingEntry?.terminal?.output ?? "",
      },
      receipts: [...repl.fake.prompts],
      conversations: conversations.size,
      chatHas: (text: string) => screen.includes(text),
    };
  }

  it("TE1: the names a seed published become the greetings a real entry prints", function* () {
    const ran = yield* arm(FIRST);

    // The map the provider was handed is the one that entry published, detached
    // and whole, with nothing of the host's own in it.
    expect(ran.published).toEqual({ names: FIRST });

    // Held at the transport with the draft filled: the program is there, byte
    // for byte, and the seed is still the only entry that has run.
    expect(blockSays(ran.heldDraft, GREETINGS)).toBe(true);
    expect(ran.heldEntries).toEqual(["entry-1"]);

    // The entry that ran is the draft that was held, and its output is the
    // greetings those three names make — stated from the names rather than read
    // back off the program.
    expect(ran.greeting.source).toBe(GREETINGS);
    for (const name of FIRST) {
      expect(ran.greeting.output).toContain(`Hello, ${name}!`);
    }

    // The receipt names that exact entry and carries no body.
    expect(ran.receipts[3] ?? "").toContain("Entry entry-2 completed.");
    expect(ran.receipts[3] ?? "").not.toContain("<Each in={names}");

    // The table is a second real entry in the same conversation, and every name
    // is a row of it.
    expect(ran.table.source).toBe(TABLE);
    for (const name of FIRST) {
      expect(ran.table.output).toContain(`| ${name} |`);
    }
    expect(ran.receipts[5] ?? "").toContain("Entry entry-3 completed.");
    expect(ran.conversations).toBe(1);

    // And the greetings entry is untouched by the revision: the same source and
    // the same output it settled with.
    expect(ran.greetingAfter).toEqual(ran.greeting);

    // The chat is what the replies selected, not the source they captured or
    // the envelope their feedback came in.
    expect(ran.chatHas("Prepared the greetings.")).toBe(true);
    expect(ran.chatHas("Revised it as a table.")).toBe(true);
    expect(ran.chatHas("REPL.EntryInput")).toBe(false);
  });

  it("TE1: changing one published name changes the greetings and the table", function* () {
    const ran = yield* arm(SECOND);

    expect(ran.published).toEqual({ names: SECOND });
    expect(blockSays(ran.heldDraft, GREETINGS)).toBe(true);

    // The program is the same program. What changed is the binding it reads,
    // and that is what the output has to show.
    expect(ran.greeting.source).toBe(GREETINGS);
    for (const name of SECOND) {
      expect(ran.greeting.output).toContain(`Hello, ${name}!`);
      expect(ran.table.output).toContain(`| ${name} |`);
    }

    // No cell of the arm before this one survives anywhere in either output.
    expect(ran.greeting.output).not.toContain("Linus");
    expect(ran.table.output).not.toContain("Linus");
  });
});

/**
 * Tier TE — an entry that failed, and the entry that corrects it (#883, J11).
 *
 * The mounted connection between the two, which is what remained: the owner's
 * existing provider-failure, Incomplete and explicit-Retry rows are the
 * contrasting boundary and are not repeated here, and R6's startup and cleanup
 * rows own the teardown one. What this proves is that a real failed entry's own
 * receipt reaches the conversation that submitted it, and that the correction it
 * authors becomes a second real entry while the first stays exactly as it failed.
 */
describe("Tier TE — a failed entry is corrected as a new entry", () => {
  it("TE2: the failure goes back to its owner, which submits a corrected entry", function* () {
    const repl = yield* useMountedRepl();

    // The failing entry fixture these rows already use: a real entry that is
    // admitted, runs, and settles badly.
    const failing = [
      '<Let as="code" select="code">',
      "````xmd",
      "```js eval",
      'throw new Error("entry failed on purpose");',
      "```",
      "````",
      "</Let>",
      "<REPL.EntryInput>{code}</REPL.EntryInput>",
      "<REPL.Submit />",
      "<Output>Submitted the first one.</Output>",
      "",
    ].join("\n");

    repl.fake.script({ reply: failing });
    repl.fake.script({ reply: entrySource("fixed", "it runs now", "{fixed}") });
    repl.fake.script({ reply: "<Output>Corrected it.</Output>\n" });

    yield* sendMessage(repl, "run this");
    yield* awaiting(repl.terminal, "the correction being answered", (one) =>
      shows(one, "Corrected it."),
    );

    const read = yield* mountedReading(repl);
    const [failed, corrected] = read.model.entries;

    // The first entry really ran and really failed, with its own reason.
    expect(failed?.key).toBe("entry-1");
    expect(failed?.terminal?.status).toBe("err");
    expect(failed?.source).toContain("entry failed on purpose");

    // Its own receipt went back to the conversation that submitted it: the
    // entry, its actual reason, and the read instruction for its output — not a
    // refused submission, which would have it try to submit the same thing again.
    const receipt = repl.fake.prompts[1] ?? "";
    expect(receipt).toContain("Entry entry-1 failed");
    expect(receipt).toContain("entry failed on purpose");
    expect(receipt).toContain("Inspect its saved evidence with <REPL.Entry.Journal entry={1} />.");
    expect(receipt).not.toContain("REPL.Submit refused");

    // And the correction is a *different* entry, admitted through the same
    // ordinary path, which succeeded.
    expect(corrected?.key).toBe("entry-2");
    expect(corrected?.terminal?.status).toBe("ok");
    expect(corrected?.source).not.toContain("entry failed on purpose");
    expect(corrected?.terminal?.output).toContain("it runs now");
    expect(repl.fake.prompts[2] ?? "").toContain("Entry entry-2 completed.");

    // The failed entry is still the failed entry: nothing rewrote its source,
    // its outcome or its reason to make the correction look like a repair of it.
    expect(failed?.terminal?.status).toBe("err");
    expect(read.model.entries).toHaveLength(2);

    // One conversation owns both.
    const conversations = new Set(
      read.chat
        .filter((record) => record.kind === "message")
        .map((record) => (record.kind === "message" ? record.conversation : "")),
    );
    expect(conversations.size).toBe(1);
  });
});

describe("Tier SS — the Sessions facts one real conversation establishes", () => {
  it("SS1: one turn keeps one row key from begin, through its saved Prompt, to its reply", function* () {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    // A control the response's root suspends in, which is the only way to hold
    // a turn *between* its canonical record being saved and the reply that
    // record's program produces. Those are two facts and this row is about
    // telling them apart.
    const held = yield* useHarness(undefined, {
      *fill(): Operation<Result<void>> {
        entered.resolve();
        yield* release.operation;
        return Ok(undefined);
      },
    });
    held.fake.script({ reply: "<REPL.EntryInput>held while evaluating</REPL.EntryInput>\n" });
    // The fill owes the agent an account of what it did, so the exchange has an
    // automatic follow-up after it. Scripted so that follow-up answers rather
    // than failing for a reason this row is not about.
    held.fake.script({ reply: "<Output>Noted.</Output>\n" });

    const sending = yield* spawn(() => held.owner.message("one ask"));
    yield* held.fake.startedTurns(1);

    /** The Sessions rows this owner's own facts compose, by their actual keys. */
    const rowsNow = (): readonly { key: string; state: string; running: boolean }[] => {
      const read = held.owner.reading;
      if (!read.ok) {
        throw read.error;
      }
      return sidekickTurnRows(read.value, held.owner.live).map((one) => ({
        key: one.key,
        state: one.state,
        running: one.running,
      }));
    };

    // Generating: one row, the live one, keyed by the response this owner
    // registered before it handed the request over.
    const generating = rowsNow();
    expect(generating).toHaveLength(1);
    expect(generating[0]?.running).toBe(true);
    expect(generating[0]?.state).toBe("generating");
    const key = generating[0]?.key;
    expect(key).toBeDefined();
    // No saved turn yet: the row exists because the turn does, not because a
    // record does, and it names no canonical ordinal it has not been told.
    const before = held.owner.reading;
    if (!before.ok) {
      throw before.error;
    }
    expect(before.value.turns).toEqual([]);
    expect(held.owner.live?.turn).toBeNull();

    yield* entered.operation;
    // The provider's turn has been saved and its program is now running. The
    // row is the *same* row — the same key, not a second one with a matching
    // title — and the two facts it now carries are separate: it names the
    // canonical turn its record was saved as, and it says the reply that turn
    // produced is still being evaluated.
    const evaluating = rowsNow();
    expect(evaluating).toHaveLength(1);
    expect(evaluating[0]?.key).toBe(key);
    expect(evaluating[0]?.state).toBe("evaluating the reply");
    expect(held.owner.live?.phase).toBe("evaluating");
    // Before publication this row named no saved turn; now it names the one
    // the canonical record actually is.
    expect(held.owner.live?.turn).toBe(1);

    // And the files say the same thing, which is what makes it the turn's
    // record rather than this owner's recollection: the saved Prompt is on
    // disk and no reply has been published against it.
    const written = yield* records(held.execution);
    expect(
      written.filter(
        // Narrowed by the discriminant each record carries: an `event` record
        // holds its own serialized durable event, and what makes this one the
        // canonical Prompt is that event naming an agent prompt.
        (one) => one.kind === "event" && one.event.includes("agent_prompt"),
      ),
    ).toHaveLength(1);
    expect(written.some((one) => one.kind === "response")).toBe(false);

    release.resolve();
    const answered = yield* sending;
    if (!answered.ok) {
      throw answered.error;
    }
    // Settled, and still exactly one row under the same key: the outcome
    // replaced what the row says and never what the row is. The follow-up the
    // fill owed is its own turn beside it, under a key of its own.
    const settledRows = rowsNow();
    expect(settledRows.filter((one) => one.key === key)).toEqual([
      { key, state: "completed", running: false },
    ]);
    expect(new Set(settledRows.map((one) => one.key)).size).toBe(settledRows.length);
  });

  it("SS6: a failed successor is its own turn, and an automatic turn is labelled", function* () {
    const held = yield* useHarness();
    // A first turn that answers and reads something, so the exchange owes an
    // automatic follow-up: that follow-up is agent work carrying a response's
    // results rather than anything a person said.
    held.fake.script({
      reply: ["<Output>First answer.</Output>", "<REPL.Bindings />", ""].join("\n"),
    });
    held.fake.script({ reply: "<Output>Second answer.</Output>\n" });
    // And then a message whose turn the provider does not finish.
    held.fake.script({ reply: "<Output>Half said.</Output>\n", stopReason: "max_tokens" });

    const first = yield* held.owner.message("the first ask");
    if (!first.ok) {
      throw first.error;
    }
    const second = yield* held.owner.message("the second ask");
    if (!second.ok) {
      throw second.error;
    }

    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    const turns = reading.value.turns;
    // Three turns, each its own: the person's first, the automatic follow-up
    // its read owed, and the person's second which the provider failed.
    expect(turns.map((one) => [one.turn, one.status, one.asked, one.title])).toEqual([
      [1, "completed", "person", "the first ask"],
      [2, "completed", "automatic", undefined],
      [3, "failed", "person", "the second ask"],
    ]);
    // Each names the conversation its own record names, and every one of them
    // is nonempty here because every turn really started.
    expect(new Set(turns.map((one) => one.sessionKey === undefined))).toEqual(new Set([false]));
    expect(new Set(turns.map((one) => one.conversation)).size).toBe(1);
    expect(new Set(turns.map((one) => one.agent))).toEqual(new Set([AGENT]));

    // The failed turn's own account is the safe incomplete projection of what
    // it streamed, with its own reason — and it collides with neither reply
    // before it.
    expect(turns[2]?.reply).toBeUndefined();
    expect(turns[2]?.incomplete?.output).toBe("Half said.");
    expect(turns[2]?.incomplete?.failure).toContain("max_tokens");
    expect(turns[0]?.reply?.output).toBe("First answer.");
    expect(turns[1]?.reply?.output).toBe("Second answer.");

    // Reopened cold, the same files say the same thing: none of this is this
    // process having remembered it.
    const cold = yield* held.repository.open(held.execution.id);
    const projected = projectSidekick(yield* (cold.chat as PairedChatStorage).writer.readAll());
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.turns.map((one) => [one.turn, one.status, one.asked])).toEqual([
      [1, "completed", "person"],
      [2, "completed", "automatic"],
      [3, "failed", "person"],
    ]);
  });

  it("SS6: Stop before acknowledgement leaves no saved turn and no cold row", function* () {
    const held = yield* useHarness();
    // A turn that says something and never settles, so Stop interrupts a
    // generation genuinely in flight.
    held.fake.script({ manual: true, reply: "<Output>Never saved.</Output>\n" });

    const sending = yield* spawn(() => held.owner.message("say it"));
    yield* held.fake.startedTurns(1);
    yield* held.owner.stop();
    yield* sending;

    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    // No saved turn at all: the provider never finished one, so nothing is
    // inferred from the text, the message id or the order anything happened in.
    expect(reading.value.turns).toEqual([]);
    expect(reading.value.chat.map((item) => item.kind)).toEqual(["person"]);
    // And the key this owner observed is the one it actually observed, which
    // for a turn that never reported one is none at all.
    expect(held.owner.observed).toEqual([]);
    expect(held.owner.live).toBeUndefined();

    // Cold, the files invent none of it.
    const cold = yield* held.repository.open(held.execution.id);
    const projected = projectSidekick(yield* (cold.chat as PairedChatStorage).writer.readAll());
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.turns).toEqual([]);
    // The message really is on disk, which is what says this run got as far as
    // asking: no saved turn is an absence of a turn rather than of a cycle.
    expect(projected.value.chat.map((item) => item.kind)).toEqual(["person"]);
  });
});

/**
 * Tier R5 — IN6: one capture, many responses, each with its own records.
 *
 * The controls a reply writes are sealed once, when the conversation opens. So
 * the two things a later response needs are not the same thing any more, and
 * these rows separate them: the *control* is the one the capture sealed, and
 * what it answers with is read now rather than remembered from setup. A frozen
 * reading would be the obvious way to get this wrong — a reply asking what is
 * published would be told what was published when its conversation opened.
 *
 * Beside that, the association: two responses in one conversation file their own
 * ordered pairs and are told their own results, and an ordinary failure in the
 * middle does not move either.
 */
describe("Tier R5 — one capture, and each response's own records", () => {
  it("R5: a later response reads a fact that changed, through the captured control", function* () {
    const held = yield* useHarness();

    // Nothing is published yet, and the first response reads that.
    held.fake.script({ reply: "<REPL.Bindings />\n" });
    held.fake.script({ reply: "<Output>Nothing yet.</Output>\n" });
    const first = yield* held.owner.message("what is published?");
    if (!first.ok) {
      throw first.error;
    }
    expect(JSON.parse(held.fake.prompts[1] ?? "")).toEqual({});

    // A real entry runs and publishes a root binding. This is the REPL fact
    // changing between responses — not a value this row injected.
    const prepared = [
      '<Let as="code" select="code">',
      "````xmd",
      "```js eval",
      'const published = "after the entry";',
      "```",
      "",
      "<Output>{published}</Output>",
      "````",
      "</Let>",
      "<REPL.EntryInput>{code}</REPL.EntryInput>",
      "<REPL.Submit />",
      "<Output>Submitted it.</Output>",
      "",
    ].join("\n");
    held.fake.script({ reply: prepared });
    held.fake.script({ reply: "<Output>Thanks.</Output>\n" });
    const ran = yield* held.owner.message("run a greeting");
    if (!ran.ok) {
      throw ran.error;
    }
    // Two writes are designated, so this message takes a second turn and the
    // answer is the reply to the receipt. What matters here is that the entry
    // really ran: its draft was filled and its submission was accepted.
    expect(ran.value.output).toContain("Thanks.");

    // A third response reads the same control again — the one sealed when this
    // conversation opened — and is told the *new* value. A control closed over
    // a reading taken at setup would still answer the empty map here.
    held.fake.script({ reply: "<REPL.Bindings />\n" });
    held.fake.script({ reply: "<Output>Read it again.</Output>\n" });
    const again = yield* held.owner.message("what is published now?");
    if (!again.ok) {
      throw again.error;
    }
    // The feedback turn is the last one sent, and this response ran one
    // designated control — so what it carries is that control's value with
    // nothing round it, exactly as the single-result case always does.
    const latest = held.fake.prompts.at(-1) ?? "";
    expect(JSON.parse(latest)).toEqual({ published: "after the entry" });
  });

  it("R5: each response files its own ordered pairs, across an ordinary failure", function* () {
    const held = yield* useHarness("fail-here");

    // One response that runs a real control and then fails at its second fill.
    // The control before the failure happened; what comes after it does not.
    // A designated control that ran still owes its feedback, so the correction
    // turn the product sends is scripted here — that is this conversation's own
    // sequence rather than an arrangement around it.
    held.fake.script({
      reply: [
        "<REPL.Bindings />",
        "<REPL.EntryInput>fail-here</REPL.EntryInput>",
        "<Output>Before.</Output>",
        "",
      ].join("\n"),
    });
    held.fake.script({ reply: "<Output>Carrying on from there.</Output>\n" });
    const failed = yield* held.owner.message("read and then fail");
    if (!failed.ok) {
      throw failed.error;
    }
    expect(failed.value.output).toContain("Carrying on from there.");

    // A second response, with its own control.
    held.fake.script({ reply: "<REPL.Environment />\n" });
    held.fake.script({ reply: "<Output>Done.</Output>\n" });
    const next = yield* held.owner.message("and now the environment");
    if (!next.ok) {
      throw next.error;
    }
    expect(next.value.output).toContain("Done.");

    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    // Each pair under the response that ran it, in the order that response
    // admitted it — read off the retained history rather than counted from the
    // prompts, because what is under test is which response a record belongs
    // to and a count cannot say that.
    expect(
      reading.value.operations.map((one) => ({
        response: one.response,
        order: one.order,
        component: one.component,
        status: one.status,
      })),
    ).toEqual([
      // Both of the failing response's own pairs, in the order it admitted
      // them: the read that happened, then the fill that failed. A failure is
      // recorded as the outcome it was rather than dropped.
      { response: "response:1", order: 0, component: "REPL.Bindings", status: "ok" },
      { response: "response:1", order: 1, component: "REPL.EntryInput", status: "failed" },
      // And the next response's control, independently associated and ordered
      // from zero again — its own response rather than a continuation of the
      // one that failed.
      { response: "response:3", order: 0, component: "REPL.Environment", status: "ok" },
    ]);
    // One conversation throughout, so these are three responses of the same
    // chat rather than of two chats.
    expect(new Set(reading.value.operations.map((one) => one.conversation)).size).toBe(1);
    // Said as the failure it guards against: nothing the failing response ran
    // is filed under the response that came after it.
    expect(
      reading.value.operations.filter(
        (one) => one.response === "response:3" && one.component !== "REPL.Environment",
      ),
    ).toEqual([]);

    // And what was delivered was delivered to this conversation, established by
    // the canonical turn that carried it rather than by a record of ours.
    expect(reading.value.delivered.map((one) => one.conversation)).toEqual([reading.value.active]);
  });
});

/**
 * Tier R5 — IN6: two Sidekick owners alive at once, each with its own controls.
 *
 * Capture moved from per-response definitions to definitions installed and
 * sealed once per conversation, and that is what makes this row necessary. The
 * controls-suite rows evaluate two canonical host captures one after the other,
 * which cannot see the failure that matters here: a Sidekick assembly that
 * reused the most recently opened owner's controls while both conversations
 * were alive would satisfy a sequential helper and lose somebody's chat.
 *
 * So both owners here are whole ones, each with its own repository, its own
 * session, its own scripted provider and its own conversation, and neither is
 * closed before the other opens. Both conversations are open before the
 * observation, and the second owner's capture and evaluation happen while the
 * first owner's response is suspended inside a control it already ran.
 *
 * What tells the two apart is a real REPL fact rather than anything written
 * into the reply: each session has run one entry of its own, and the two owners
 * are sent the same control source byte for byte.
 */
describe("Tier R5 — two live owners, and the controls each conversation captured", () => {
  /** What each REPL's own entry prints, so the two readings cannot be confused. */
  const FIRST = "the first chat's own entry";
  const SECOND = "the second chat's own entry";

  /**
   * The one reply both owners are sent, byte for byte.
   *
   * A read and then a write, so both classes of control are observed rather
   * than only the one that answers. The read names `entry-1` — which both
   * sessions have, holding different text — so an answer from the wrong REPL is
   * a different string rather than a refusal.
   */
  const SHARED = [
    "<REPL.Entry.Output entry={1} />",
    "<REPL.EntryInput>a prepared body</REPL.EntryInput>",
    "<Output>Read it.</Output>",
    "",
  ].join("\n");

  /** One harness, and the way into the scope it is held open in. */
  interface Held extends Harness {
    /** Run one operation inside this harness's own scope. */
    run<T>(work: () => Operation<T>): Operation<T>;
  }

  /**
   * One whole harness, held open in a task of its own.
   *
   * Two cannot be acquired in one scope: each registers the agent components,
   * and the engine refuses two registrations of a name at one scope rather than
   * letting one of them silently win — it says to shadow in a nested scope
   * instead, and a task is one. The task then suspends, so both harnesses stay
   * live for the whole row, and the row's own scope is what finally halts them.
   *
   * Its work runs in that same scope rather than in the caller's, because the
   * REPL host each harness installs is installed there: a message sent from out
   * here would be a conversation looking for a host that is not above it. That
   * is also what a command does — one host per command — so the indirection is
   * the arrangement rather than a way around it.
   *
   * Handed back through a resolver rather than after a count of turns, because
   * a spawned task starts a turn late.
   */
  function* holding(extra: Parameters<typeof useHarness>[1] = {}): Operation<Held> {
    const ready = withResolvers<Held>();
    yield* spawn(function* (): Operation<void> {
      const harness = yield* useHarness(undefined, extra);
      const scope = yield* useScope();
      ready.resolve({ ...harness, run: (work) => scope.run(work) });
      yield* suspend();
    });
    return yield* ready.operation;
  }

  /** This chat's control intents, as the records it wrote hold them. */
  function controlsIn(
    held: readonly SidekickRecord[],
  ): { conversation: string; response: string; order: number; component: string }[] {
    return held.flatMap((record) =>
      record.kind === "control"
        ? [
            {
              conversation: record.conversation,
              response: record.response,
              order: record.order,
              component: record.component,
            },
          ]
        : [],
    );
  }

  /** One control intent, as this owner's own conversation records it. */
  function ownControl(
    owner: SidekickOwner,
    response: string,
    order: number,
    component: string,
  ): { conversation: string; response: string; order: number; component: string } {
    return { conversation: active(owner), response, order, component };
  }

  /** This owner's reading of its own history, refused loudly. */
  function read(owner: SidekickOwner): SidekickReading {
    const held = owner.reading;
    if (!held.ok) {
      throw held.error;
    }
    return held.value;
  }

  /** The conversation this owner is in. */
  function active(owner: SidekickOwner): string {
    const conversation = read(owner).active;
    if (conversation === undefined) {
      throw new Error("this owner is in no conversation yet");
    }
    return conversation;
  }

  /** Every reply this owner's chat holds, in order. */
  function replies(owner: SidekickOwner): string[] {
    return read(owner).chat.flatMap((item) => (item.kind === "reply" ? [item.text] : []));
  }

  /** One real entry of this REPL's own, run as a person runs one. */
  function* seeded(held: Held, text: string): Operation<void> {
    const admitted = yield* held.run(() => held.session.submit(`<Output>${text}</Output>\n`));
    if (!admitted.ok) {
      throw admitted.error;
    }
    yield* held.run(() => held.session.join());
    expect(held.session.model.entries).toHaveLength(1);
    expect(held.session.model.entries[0]?.terminal?.output).toContain(text);
  }

  /** One message, through this owner, in this owner's own scope. */
  function said(held: Held, text: string): Operation<Result<SidekickTurn>> {
    return held.run(() => held.owner.message(text));
  }

  it("R5: the same reply in two live conversations reads and records only its own", function* () {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();

    // The first owner's fill suspends, which is what lets its response be left
    // live and mid-control while the second owner works. Only the fill differs
    // between the two harnesses; the reply they are sent does not.
    const one = yield* holding({
      *fill(): Operation<Result<void>> {
        entered.resolve();
        yield* release.operation;
        return Ok(undefined);
      },
    });
    const other = yield* holding();

    yield* seeded(one, FIRST);
    yield* seeded(other, SECOND);

    // Both conversations opened and activated, before any observation.
    one.fake.script({ reply: "<Output>Open.</Output>\n" });
    other.fake.script({ reply: "<Output>Open.</Output>\n" });
    const opened = yield* said(one, "open this one");
    if (!opened.ok) {
      throw opened.error;
    }
    const alsoOpened = yield* said(other, "open that one");
    if (!alsoOpened.ok) {
      throw alsoOpened.error;
    }
    expect(active(one.owner)).not.toBe(active(other.owner));

    one.fake.script({ reply: SHARED });
    one.fake.script({ reply: "<Output>Thanks.</Output>\n" });
    other.fake.script({ reply: SHARED });
    other.fake.script({ reply: "<Output>Thanks.</Output>\n" });
    other.fake.script({ reply: SHARED });
    other.fake.script({ reply: "<Output>Thanks.</Output>\n" });

    // The second owner's whole cycle, with both conversations live. Both writes
    // are designated, so the message takes a second turn: what it answers with
    // is that turn's reply, and the response that ran the controls is the one
    // before it in the chat.
    const answered = yield* said(other, "read and prepare");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.output).toContain("Thanks.");
    expect(replies(other.owner)).toContain("Read it.");

    // Its read answered from its own REPL. The source named `entry-1` and both
    // sessions have one, so this is the fact that distinguishes the handles: an
    // owner holding the other's captured controls would read the other's entry.
    const toOther = other.fake.prompts[2] ?? "";
    expect(toOther).toContain("## REPL.Entry.Output");
    expect(toOther).toContain(SECOND);
    expect(toOther).not.toContain(FIRST);
    // And its write reached its own session's draft, while the first owner's is
    // untouched — nothing of this cycle belonged to that conversation.
    expect(other.state().draft).toBe("a prepared body");
    expect(one.state().draft).toBe("");

    // Now the first owner's response, left suspended inside its own fill.
    const held = yield* spawn(() => said(one, "read and prepare"));
    yield* entered.operation;
    expect(one.owner.busy).toBe(true);
    // Both conversations are not merely open but working: one is mid-response
    // and the other is about to run a whole cycle of its own, which is the
    // state two sequential captures cannot reach.
    expect(active(one.owner)).not.toBe(active(other.owner));

    const again = yield* said(other, "read and prepare again");
    if (!again.ok) {
      throw again.error;
    }
    // Still its own REPL, with the other conversation's response in flight.
    const toOtherAgain = other.fake.prompts[4] ?? "";
    expect(toOtherAgain).toContain(SECOND);
    expect(toOtherAgain).not.toContain(FIRST);
    expect(one.owner.busy).toBe(true);

    // Released, and the first owner finishes the response it was holding.
    release.resolve();
    const finished = yield* held;
    if (!finished.ok) {
      throw finished.error;
    }
    expect(finished.value.output).toContain("Thanks.");
    expect(replies(one.owner)).toContain("Read it.");

    // The same source, the other REPL's answer.
    const toOne = one.fake.prompts[2] ?? "";
    expect(toOne).toContain("## REPL.Entry.Output");
    expect(toOne).toContain(FIRST);
    expect(toOne).not.toContain(SECOND);

    // Each owner asked its own provider, and only its own: a call that had
    // crossed would show as a turn on the wrong one.
    expect(one.fake.prompts).toHaveLength(3);
    expect(other.fake.prompts).toHaveLength(5);

    // And the records. Each chat holds its own controls, in admission order,
    // under its own conversation and its own response — and names the other
    // conversation nowhere at all.
    const oneRecords = yield* records(one.execution);
    const otherRecords = yield* records(other.execution);
    expect(controlsIn(oneRecords)).toEqual([
      ownControl(one.owner, "response:2", 0, "REPL.Entry.Output"),
      ownControl(one.owner, "response:2", 1, "REPL.EntryInput"),
    ]);
    expect(controlsIn(otherRecords)).toEqual([
      ownControl(other.owner, "response:2", 0, "REPL.Entry.Output"),
      ownControl(other.owner, "response:2", 1, "REPL.EntryInput"),
      ownControl(other.owner, "response:4", 0, "REPL.Entry.Output"),
      ownControl(other.owner, "response:4", 1, "REPL.EntryInput"),
    ]);
    expect(JSON.stringify(oneRecords)).not.toContain(active(other.owner));
    expect(JSON.stringify(otherRecords)).not.toContain(active(one.owner));
    // Neither session ran the other's entry either: one apiece, each its own.
    expect(one.session.model.entries).toHaveLength(1);
    expect(other.session.model.entries).toHaveLength(1);
  });
});

/**
 * Tier EI — a saved failure explains itself (#932).
 *
 * The history these rows read is produced here, by really running an entry
 * whose nine agent turns are the ones `fixtures/repl/issue-932/history.ts`
 * states: eight that complete, and a ninth that streams a complete ballot and
 * ends failed. Every prompt captures its reply, so the entry prints nothing at
 * all — which is the situation a reader is in when an entry fails and its
 * output is empty.
 *
 * What the rows then drive is one real Sidekick exchange over that history:
 * the owner, the conversation, the response ceiling, the controls and the
 * designated feedback are all the production ones, and the provider is the
 * same scripted one every journey row uses.
 */
describe("Tier EI — four reads make a saved failure diagnosable", () => {
  /** The entry history every row here starts from, really run. */
  function* savedFailure(held: Harness): Operation<void> {
    for (const reply of PROMPT_REPLIES) {
      held.fake.script({ reply });
    }
    held.fake.script({ reply: BALLOT_REPLY, stopReason: STOP_REASON });
    const failing = yield* held.session.submit(FAILED_ENTRY);
    if (!failing.ok) {
      throw failing.error;
    }
    // Joined and not checked: this entry is supposed to fail, and its outcome
    // is what the rows below read.
    yield* failing.value.join();
    const settling = yield* held.session.submit(SETTLED_ENTRY);
    if (!settling.ok) {
      throw settling.error;
    }
    const settled = yield* settling.value.join();
    if (!settled.ok) {
      throw settled.error;
    }
  }

  /** This execution's entry file, which no read may change. */
  function entryFile(held: Harness): string {
    const chat = held.execution.chat;
    if (chat.form !== "paired") {
      throw new Error("this execution has no published pair");
    }
    return chat.location.entries;
  }

  /**
   * How many turns the provider has already answered.
   *
   * The entry's own nine turns reach the same scripted provider, so a row that
   * counted from zero would be reading a watch request where it meant to read
   * the feedback its own exchange produced.
   */
  function answeredSoFar(held: Harness): number {
    return held.fake.prompts.length;
  }

  /** One JSON page a turn was sent, parsed as the value it is. */
  function page(text: string): Record<string, unknown> {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`that feedback is not one page: ${text.slice(0, 120)}`);
    }
    return parsed as Record<string, unknown>;
  }

  it("E1: Journal locates the failed turn, and Prompt reads what it said", function* () {
    const held = yield* useHarness();
    yield* savedFailure(held);

    const [failed, later] = held.session.model.entries;
    expect(failed?.key).toBe("entry-1");
    expect(failed?.terminal?.status).toBe("err");
    expect(failed?.terminal?.output).toBe("");
    expect(failed?.turns).toHaveLength(9);
    expect(later?.terminal?.status).toBe("ok");
    const before = yield* until(readFile(entryFile(held), "utf8"));
    const base = answeredSoFar(held);

    // One exchange: find the failure, then read the turn it names, then check
    // what ran and what it printed.
    held.fake.script({ reply: "<REPL.Entry.Journal entry={1} />\n" });
    held.fake.script({
      reply: [
        '<REPL.Entry.Prompt entry={1} prompt={9} field="reply" />',
        '<REPL.Entry.Prompt entry={1} prompt={9} field="request" />',
        '<REPL.Entry.Prompt entry={1} prompt={9} field="error" />',
        "",
      ].join("\n"),
    });
    held.fake.script({
      reply: "<REPL.Entry.Source entry={1} />\n<REPL.Entry.Output entry={1} />\n",
    });
    held.fake.script({ reply: "<Output>The ninth ballot failed.</Output>\n" });

    const answered = yield* held.owner.message("the entry failed — what happened?");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.output).toContain("The ninth ballot failed.");
    expect(held.fake.prompts).toHaveLength(base + 4);

    // The Journal page: the complete saved failure, how the entry's turns
    // ended, and the record that says which prompt to read.
    const located = page(held.fake.prompts[base + 1] ?? "");
    expect(located).toMatchObject({
      entry: 1,
      status: "failed",
      failure: 'agent prompt failed with stop reason "refusal"',
      prompts: { completed: 8, failed: 1, cancelled: 0 },
    });
    const records = located.records;
    if (!Array.isArray(records)) {
      throw new Error("a Journal page carries its records");
    }
    expect(records.filter((record) => (record as { prompt: unknown }).prompt === 9)).toHaveLength(
      1,
    );
    // A locator, not a transcript: no reply, request or source travels on it.
    expect(JSON.stringify(records)).not.toContain("open_watch");
    expect(JSON.stringify(records)).not.toContain("harbour ballot");

    // The turn it named: the valid JSON it returned, the complete request it
    // was sent, the complete failure it ended with, and where it was written.
    const turn = held.fake.prompts[base + 2] ?? "";
    expect(turn).toContain("## REPL.Entry.Prompt");
    expect(turn).toContain(JSON.stringify(BALLOT_REPLY).slice(1, 60));
    expect(turn).toContain(JSON.stringify(BALLOT_REQUEST).slice(1, 60));
    expect(turn).toContain('agent prompt failed with stop reason \\"refusal\\"');
    // The entry failed and so did this turn, and they are stated separately.
    expect(turn).toContain('"status": "failed"');
    expect(turn).toContain('"promptStatus": "failed"');
    expect(turn).toContain('"line": 9');
    // Returning parseable JSON is not succeeding: nothing calls this accepted.
    expect(turn).not.toContain('"promptStatus": "completed"');

    // What ran, and what it printed — which is nothing.
    const ran = held.fake.prompts[base + 3] ?? "";
    expect(ran).toContain("## REPL.Entry.Source");
    expect(ran).toContain("Set watch 1 of the harbour ballot");
    expect(ran).toContain("## REPL.Entry.Output");
    expect(ran).toContain('"text": ""');

    // Reading changed nothing: the entry file is the file, and the entry still
    // holds the nine turns it held.
    expect(yield* until(readFile(entryFile(held), "utf8"))).toBe(before);
    expect(held.session.model.entries[0]?.turns).toHaveLength(9);
    expect(held.session.model.entries).toHaveLength(2);
  });

  it("E5: a page is the object when captured, and the same feedback either way", function* () {
    const held = yield* useHarness();
    yield* savedFailure(held);

    const base = answeredSoFar(held);

    // Read once with nothing capturing it. The reply says nothing, so the
    // conversation gets work and no utterance.
    held.fake.script({ reply: "<REPL.Entry.Journal entry={1} />\n" });
    held.fake.script({ reply: "<Output>Read it.</Output>\n" });
    const uncaptured = yield* held.owner.message("what failed?");
    if (!uncaptured.ok) {
      throw uncaptured.error;
    }

    // Read again, captured, and composed into the reply's own Output. The
    // binding is the page object: `<Json>` serializes a value rather than
    // parsing rendered text.
    held.fake.script({
      reply:
        '<REPL.Entry.Journal entry={1} as="page" />\n<Output>\n<Json value={page} />\n</Output>\n',
    });
    held.fake.script({ reply: "<Output>And again.</Output>\n" });
    const captured = yield* held.owner.message("show me");
    if (!captured.ok) {
      throw captured.error;
    }

    // Read a third time, captured and with no Output at all. Capturing is not
    // publishing: the binding exists inside the response and the person is
    // told nothing, which is the case a reply that reads before deciding is in.
    held.fake.script({ reply: '<REPL.Entry.Journal entry={1} as="page" />\n' });
    held.fake.script({ reply: "<Output>Nothing to add.</Output>\n" });
    const quietly = yield* held.owner.message("look again");
    if (!quietly.ok) {
      throw quietly.error;
    }

    // Capturing a designated control does not switch its feedback off, and
    // what comes back is the same page every time — uncaptured, captured and
    // published, and captured and silent.
    expect(held.fake.prompts).toHaveLength(base + 6);
    expect(held.fake.prompts[base + 1]).toBe(held.fake.prompts[base + 3]);
    expect(held.fake.prompts[base + 1]).toBe(held.fake.prompts[base + 5]);
    expect(page(held.fake.prompts[base + 5] ?? "")).toMatchObject({
      entry: 1,
      status: "failed",
    });

    // The captured page reached the chat because the reply wrote an Output for
    // it, and only then.
    const chat = yield* records(held.execution);
    const replies = chat.filter((record) => (record as { kind: string }).kind === "response");
    expect(replies.map((record) => (record as { hasOutput: boolean }).hasOutput)).toEqual([
      // The control-only read published nothing.
      false,
      true,
      true,
      true,
      // Captured, and still control-only: a binding is not an utterance.
      false,
      true,
    ]);

    // And neither control-only response said anything. Each is in the chat as
    // the reply it was — the work happened and the history holds it — with no
    // output region and nothing to show, which is what keeps a reply that only
    // read from being padded with a fallback utterance.
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    // Trimmed, because what is being compared is what each reply said rather
    // than the blank lines its own Output region was written across.
    const said = reading.value.chat.flatMap((item) =>
      item.kind === "reply" ? [{ hasOutput: item.hasOutput, text: item.text.trim() }] : [],
    );
    expect(said).toEqual([
      { hasOutput: false, text: "" },
      { hasOutput: true, text: "Read it." },
      { hasOutput: true, text: JSON.stringify(page(held.fake.prompts[base + 3] ?? ""), null, 2) },
      { hasOutput: true, text: "And again." },
      // The captured control-only read: a binding is not an utterance.
      { hasOutput: false, text: "" },
      { hasOutput: true, text: "Nothing to add." },
    ]);
  });

  it("E5: a read that cannot answer comes back as the refusal it is", function* () {
    const held = yield* useHarness();
    yield* savedFailure(held);

    const base = answeredSoFar(held);
    held.fake.script({ reply: "<REPL.Entry.Prompt entry={2} prompt={1} />\n" });
    held.fake.script({ reply: "<Output>No turns there.</Output>\n" });
    const answered = yield* held.owner.message("read the second entry's prompt");
    if (!answered.ok) {
      throw answered.error;
    }

    const delivered = held.fake.prompts[base + 1] ?? "";
    expect(delivered).toContain("REPL.Entry.Prompt failed");
    expect(delivered).toContain("saved no agent turns");
    expect(answered.value.output).toContain("No turns there.");
  });

  it("E6: an unfamiliar first turn is told the four reads and where to learn them", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>Ready.</Output>\n" });

    const answered = yield* held.owner.message("help me");
    if (!answered.ok) {
      throw answered.error;
    }
    const first = held.fake.prompts[0] ?? "";
    // The derived surface, which is read off the ceiling this response is
    // admitted under rather than kept beside it.
    expect(first).toContain("<REPL.Entry.Source /> — read.");
    expect(first).toContain("<REPL.Entry.Prompt /> — read.");
    expect(first).toContain("<REPL.Entry.Output /> — read.");
    expect(first).toContain("<REPL.Entry.Journal /> — read.");
    expect(first).toContain("props: entry, offset, limit, prompt, field");
    // And the chapter that teaches what to do with them, by its own exact
    // invocation.
    expect(first).toContain("<Guide.Recovery />");
  });

  it("E6: the shipped chapter is enough to read a failure without a path", function* () {
    const held = yield* useHarness();
    yield* savedFailure(held);

    const base = answeredSoFar(held);

    // An agent that has not seen this feature: it reads the chapter, then does
    // what the chapter says, and nothing tells it where anything is on disk.
    held.fake.script({ reply: "<Guide.Recovery />\n" });
    held.fake.script({ reply: "<REPL.Entry.Journal entry={1} />\n" });
    held.fake.script({ reply: '<REPL.Entry.Prompt entry={1} prompt={9} field="error" />\n' });
    held.fake.script({ reply: "<Output>The ninth turn was refused.</Output>\n" });

    const answered = yield* held.owner.message("something went wrong");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.output).toContain("The ninth turn was refused.");

    // The chapter it actually read, as it ships: the four calls, and no
    // filesystem hint of any kind.
    const chapter = held.fake.prompts[base + 1] ?? "";
    expect(chapter).toContain("<REPL.Entry.Journal");
    expect(chapter).toContain("<REPL.Entry.Prompt");
    expect(chapter).toContain("<REPL.Entry.Source");
    expect(chapter).toContain("<REPL.Entry.Output");
    expect(chapter).not.toContain("entries.jsonl");
    expect(chapter).not.toContain("/repl/v1");

    // And the calls it made from it answered.
    expect(page(held.fake.prompts[base + 2] ?? "")).toMatchObject({
      entry: 1,
      status: "failed",
    });
    expect(held.fake.prompts[base + 3] ?? "").toContain('stop reason \\"refusal\\"');
  });
});

describe("975 — the shipped session component journey", () => {
  it("creates, discovers and invokes a component, then reopens without work", function* () {
    const project = yield* useTemporary("xmd-workspace-project-");
    const host = yield* useMountedHost({
      projectCwd: project,
      hostFiles: true,
    });
    let execution = "";
    let workspace = "";
    let beforeEntries = "";
    let beforeChat = "";
    yield* until(writeFile(join(project, "request.md"), "project input"));
    yield* scoped(function* () {
      const repl = yield* useMountedRepl({ host });
      execution = yield* mountedExecution(repl);
      const location = pairedLocation(host.root, execution);
      workspace = location.directory;
      expect((yield* until(stat(join(workspace, "components")))).isDirectory()).toBe(true);
      const chapter = yield* readGuideChapter("Entries");
      if (!chapter.ok) {
        throw chapter.error;
      }
      const journey =
        chapter.value
          .split("### Create and use a session component across responses")[1]
          ?.split("### Read the repository")[0] ?? "";
      const examples = [...journey.matchAll(/````xmd\n([\s\S]*?)\n````/g)].map((match) => match[1]);
      expect(examples).toHaveLength(2);
      const create = examples[0]!;
      const invoke = examples[1]!;
      expect(create).not.toContain("/known/project");
      repl.fake.script({
        reply:
          '<Guide.Environment />\n<Guide.Entries />\n<REPL.Environment />\n<REPL.Syntax names={["File"]} />',
      });
      repl.fake.script({ reply: create });
      repl.fake.script({ reply: "<REPL.Entry.Output entry={1} />" });
      repl.fake.script({ reply: '<REPL.Syntax names={["Greeting"]} />' });
      repl.fake.script({ reply: invoke });
      repl.fake.script({ reply: "<REPL.Entry.Output entry={2} />" });
      repl.fake.script({ reply: "<Output>Read the session greeting.</Output>" });
      yield* sendMessage(repl, "create and use the session greeting");
      yield* awaiting(repl.terminal, "the taught journey to finish", (one) =>
        shows(one, "Read the session greeting."),
      );
      const read = yield* mountedReading(repl);
      expect(read.model.entries.map((entry) => entry.source)).toEqual([
        '<File path="components/Greeting.md">Hello from this session.</File>',
        "<Greeting />",
      ]);
      expect(read.model.entries[0]?.terminal?.output).toBe("");
      expect(read.model.entries[1]?.terminal?.output).toBe("Hello from this session.");
      expect(yield* until(readFile(join(workspace, "components", "Greeting.md"), "utf8"))).toBe(
        "Hello from this session.",
      );
      expect(repl.fake.prompts[1]).toContain(`- working directory: ${workspace}`);
      expect(repl.fake.prompts[1]).toContain("# Environment");
      expect(repl.fake.prompts[1]).toContain(chapter.value);
      expect(repl.fake.prompts[2]).toContain("Entry entry-1 completed.");
      expect(repl.fake.prompts[4]).toContain(join(workspace, "components", "Greeting.md"));
      expect(repl.fake.prompts[6]).toContain("Hello from this session.");
      expect(repl.fake.ensured[0]?.cwd).toBe(project);
      const copy = `<Dir path=${JSON.stringify(project)}><File path="request.md" as="request" /></Dir>\n<File path="inputs/request.md">{request}</File>\n<Dir path="nested"><File path="inside.md">nested</File></Dir>\n<File path="notes.md">workspace sibling</File>`;
      const source =
        '<Let as="code" select="code">\n```xmd\n' +
        copy +
        "\n```\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n<REPL.Submit />";
      repl.fake.script({ reply: source });
      repl.fake.script({ reply: "<Output>Copied and wrote.</Output>" });
      yield* sendMessage(repl, "copy the known project input and write notes");
      yield* awaiting(repl.terminal, "the workspace copy", (one) =>
        shows(one, "Copied and wrote."),
      );
      expect(yield* until(readFile(join(workspace, "inputs", "request.md"), "utf8"))).toBe(
        "project input",
      );
      expect(yield* until(readFile(join(workspace, "nested", "inside.md"), "utf8"))).toBe("nested");
      expect(yield* until(readFile(join(workspace, "notes.md"), "utf8"))).toBe("workspace sibling");
      expect(yield* cwd()).toBe(project);
      const sibling = yield* spawn(() => cwd());
      expect(yield* sibling).toBe(project);
      yield* focusDraft(repl.terminal);
      yield* typing(repl.terminal, '<File path="manual.md">project manual</File>');
      repl.terminal.feed("\r");
      yield* awaiting(repl.terminal, "the manual successor", () =>
        screenOf(repl.terminal).some((line) => {
          // The same fact the catalog used to spell as `entry-4 [ok]`: the fourth
          // entry is the one being read, and it completed. The staged screen says
          // it in the selected work's own heading — both on that one row, because
          // a chat row naming an entry and a breadcrumb naming an outcome are two
          // different rows saying two different things.
          return line.includes("Entry 4") && line.includes("\u2713 COMPLETED");
        }),
      );
      expect(yield* until(readFile(join(project, "manual.md"), "utf8"))).toBe("project manual");
      beforeEntries = yield* until(readFile(location.entries, "utf8"));
      beforeChat = yield* until(readFile(location.sidekick, "utf8"));
      repl.terminal.end();
      yield* awaiting(
        repl.terminal,
        "the first command to exit",
        () => repl.outcome() !== undefined,
      );
    });
    const calls = host.fake.prompts.length;
    yield* until(writeFile(join(workspace, "notes.md"), "external edit"));
    yield* scoped(function* () {
      const repl = yield* useMountedRepl({
        host,
        location: encodeLocation(initialState(execution).route),
      });
      expect(host.fake.prompts).toHaveLength(calls);
      expect(yield* until(readFile(pairedLocation(host.root, execution).entries, "utf8"))).toBe(
        beforeEntries,
      );
      expect(yield* until(readFile(pairedLocation(host.root, execution).sidekick, "utf8"))).toBe(
        beforeChat,
      );
      expect(yield* until(readFile(join(workspace, "notes.md"), "utf8"))).toBe("external edit");
      expect(yield* until(readFile(join(workspace, "components", "Greeting.md"), "utf8"))).toBe(
        "Hello from this session.",
      );
      repl.terminal.end();
      yield* awaiting(
        repl.terminal,
        "the cold command to exit",
        () => repl.outcome() !== undefined,
      );
    });
    yield* scoped(function* () {
      const repl = yield* useMountedRepl({ host });
      const ids = yield* until(readdir(join(host.root, "v1")));
      const other = ids.find((id) => id !== execution);
      expect(other).toBeDefined();
      const location = pairedLocation(host.root, other!);
      expect(location.directory).not.toBe(workspace);
      expect(yield* until(readdir(join(location.directory, "components")))).toEqual([]);
      repl.terminal.end();
      yield* awaiting(
        repl.terminal,
        "the second session to exit",
        () => repl.outcome() !== undefined,
      );
    });
  });
});

describe("975 — entry cwd ends with its actual owner", () => {
  it("restores after body failure and cancellation, then admits a manual successor", function* () {
    const project = yield* useTemporary("xmd-cwd-project-");
    const workspace = yield* useTemporary("xmd-cwd-workspace-");
    yield* useHostFiles();
    yield* API.Env.around(
      {
        *cwd() {
          return project;
        },
      },
      { at: "min" },
    );
    const seen: string[] = [];
    let mode = "fail";
    yield* Elicitation.around({
      *elicit([request], next) {
        seen.push(yield* cwd());
        if (mode === "fail") {
          throw new Error("deliberate body failure");
        }
        if (mode === "cancel") {
          return yield* next(request);
        }
        return { go: "yes" };
      },
    });
    const source =
      '<Dir path="inner"><Elicit schema={{ type: "object", properties: { go: { type: "string" } }, required: ["go"], additionalProperties: false }} as="answer">wait</Elicit></Dir>\n<File path="settled.md">settled</File>';
    const failed = yield* openReplSession({
      execution: { id: "failed", stream: new InMemoryStream() },
      projectCwd: project,
      workspace,
    });
    if (!failed.ok) {
      throw failed.error;
    }
    const submission = yield* failed.value.submit(source, undefined, undefined, true);
    if (!submission.ok) {
      throw submission.error;
    }
    expect((yield* submission.value.join()).ok).toBe(false);
    expect(seen[0]).toBe(join(workspace, "inner"));
    expect(yield* cwd()).toBe(project);
    expect(yield* yield* spawn(() => cwd())).toBe(project);
    mode = "cancel";
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const opened = yield* openReplSession({
        execution: { id: "cancelled", stream },
        projectCwd: project,
        workspace,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      const submitted = yield* opened.value.submit(source, undefined, undefined, true);
      if (!submitted.ok) {
        throw submitted.error;
      }
      yield* awaited("the cancellable body", () => seen.length === 2);
      expect((yield* opened.value.submit("manual too early")).ok).toBe(false);
      expect(yield* cwd()).toBe(project);
    });
    expect(seen[1]).toBe(join(workspace, "inner"));
    expect(yield* cwd()).toBe(project);
    expect(yield* yield* spawn(() => cwd())).toBe(project);
    mode = "answer";
    const reopened = yield* openReplSession({
      execution: { id: "cancelled", stream },
      projectCwd: project,
      workspace,
      resumedWorkspaceEntry: "entry-1",
    });
    if (!reopened.ok) {
      throw reopened.error;
    }
    expect((yield* reopened.value.join()).ok).toBe(true);
    const manual = yield* reopened.value.submit(
      '<File path="manual.md">manual after resume</File>',
    );
    if (!manual.ok) {
      throw manual.error;
    }
    expect((yield* manual.value.join()).ok).toBe(true);
    expect(yield* until(readFile(join(project, "manual.md"), "utf8"))).toBe("manual after resume");
    expect(yield* until(readFile(join(workspace, "settled.md"), "utf8"))).toBe("settled");
    expect(yield* cwd()).toBe(project);
  });
});

describe("975 — configured-first lookup and unchanged permissions", () => {
  function submitSource(source: string): string {
    return (
      '<Let as="code" select="code">\n```xmd\n' +
      source +
      "\n```\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n<REPL.Submit />"
    );
  }

  it("one invocation-relative include wins in execution, validation and both Syntax forms", function* () {
    const project = yield* useTemporary("xmd-configured-project-");
    const configured = join(project, "configured");
    yield* ensureDir(configured);
    yield* ensureDir(join(project, "components"));
    yield* until(writeFile(join(project, "components", "ProjectDefault.md"), "excluded default"));
    yield* until(
      writeFile(
        join(configured, "Greeting.md"),
        "---\ndescription: Configured greeting contract.\nprops:\n  type: object\n  properties:\n    selected: { type: string }\n  required: [selected]\n  additionalProperties: false\n---\nConfigured greeting.",
      ),
    );
    const repl = yield* useMountedRepl({
      projectCwd: project,
      includes: ["configured"],
      hostFiles: true,
    });
    const workspace = pairedLocation(repl.root, yield* mountedExecution(repl)).directory;
    yield* until(writeFile(join(workspace, "components", "Greeting.md"), "Session collision."));
    repl.fake.script({ reply: '<REPL.Syntax />\n<REPL.Syntax names={["Greeting"]} />' });
    repl.fake.script({ reply: submitSource('<Greeting selected="configured" />') });
    repl.fake.script({ reply: "<Output>Configured greeting completed.</Output>" });
    yield* sendMessage(repl, "inspect and invoke the selected greeting");
    yield* awaiting(repl.terminal, "the selected greeting", (one) =>
      shows(one, "Configured greeting completed."),
    );
    const selected = yield* mountedReading(repl);
    expect(selected.model.entries[0]?.terminal?.output).toBe("Configured greeting.");
    expect(repl.fake.prompts[1]).toContain(join(configured, "Greeting.md"));
    expect(repl.fake.prompts[1]).not.toContain("Session collision.");
    expect(repl.fake.prompts[1]).not.toContain("ProjectDefault");
    expect(repl.fake.prompts[1]?.match(/Configured greeting contract\./g)?.length).toBe(2);
    yield* until(
      writeFile(join(workspace, "components", "Broken.md"), "Later fallback must not execute."),
    );
    yield* until(writeFile(join(configured, "Broken.md"), "---\nprops: [\n---\nbroken"));
    repl.fake.script({ reply: submitSource("<Broken />") });
    repl.fake.script({ reply: "<Output>Inspected the malformed definition.</Output>" });
    yield* sendMessage(repl, "inspect the broken selection");
    yield* awaiting(repl.terminal, "the selected-definition refusal", (one) =>
      shows(one, "Inspected the malformed definition."),
    );
    const refused = yield* mountedReading(repl);
    expect(refused.model.entries).toHaveLength(1);
    expect(repl.fake.prompts[4]).toContain("REPL.Submit");
    expect(repl.fake.prompts[4]).not.toContain("Later fallback must not execute.");
  });

  it("a terminal Files denial leaves the component untouched and preserves explicit native cwd", function* () {
    const project = yield* useTemporary("xmd-denied-project-");
    const native = yield* useTemporary("xmd-native-project-");
    yield* Permissions.around({ files: ([operation]) => operation !== "write" });
    const repl = yield* useMountedRepl({
      projectCwd: project,
      hostFiles: true,
      agentCwd: function* () {
        return native;
      },
    });
    const workspace = pairedLocation(repl.root, yield* mountedExecution(repl)).directory;
    repl.fake.script({
      reply: submitSource('<File path="components/Greeting.md">must not write</File>'),
    });
    repl.fake.script({ reply: "<REPL.Entry.Output entry={1} />" });
    repl.fake.script({ reply: "<Output>Inspected the denied write.</Output>" });
    yield* sendMessage(repl, "write a component");
    yield* awaiting(repl.terminal, "the denied-write feedback", (one) =>
      shows(one, "Inspected the denied write."),
    );
    expect(yield* until(readdir(join(workspace, "components")))).toEqual([]);
    const read = yield* mountedReading(repl);
    expect(read.model.entries).toHaveLength(1);
    expect(read.model.entries[0]?.terminal?.output).toContain("permission");
    expect(repl.fake.prompts[2]).toContain("permission");
    expect(repl.fake.ensured[0]?.cwd).toBe(native);
  });
});
