/**
 * Produce the saved-failure fixture these rows read (#932).
 *
 * Run by hand, never by a test:
 *
 * ```bash
 * deno run --allow-all packages/cli/tests/fixtures/repl/issue-932/produce.ts
 * ```
 *
 * What it writes is the bytes a real run left behind. The REPL session, the
 * entry executions, the canonical Prompt path, the Sidekick conversation and
 * the paired storage are all the production ones, assembled by the same
 * harness the journey rows use; only the agent is scripted, because what the
 * fixture has to hold is a saved failure rather than something a model said.
 * A history hand-authored to this shape would prove that the readers agree
 * with the author, which is the one thing it must not be able to do.
 *
 * Everything in it is written here: the entry source, the prompts, the replies
 * and the failure message. No host path, home directory, transcript or
 * credential of anybody's is involved, so the file is sanitary by construction
 * rather than by being cleaned afterwards.
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { main, until } from "effection";
import type { Operation } from "effection";

import { useHarness } from "../issue-883/sidekick-harness.ts";
import {
  BALLOT_REPLY,
  FAILED_ENTRY,
  PROMPT_REPLIES,
  SETTLED_ENTRY,
  STOP_REASON,
  SUBSTITUTED_STACK,
} from "./history.ts";

/** Where the produced bytes are checked in. */
const FIXTURE = new URL("./", import.meta.url);

await main(function* (): Operation<void> {
  const held = yield* useHarness();

  // Eight turns that complete, then one that streams valid JSON and ends
  // failed. The ninth is what makes this fixture worth having: a reply a
  // reader could parse, from a turn that did not succeed.
  for (const reply of PROMPT_REPLIES) {
    held.fake.script({ reply });
  }
  held.fake.script({ reply: BALLOT_REPLY, stopReason: STOP_REASON });

  const failed = yield* held.session.submit(FAILED_ENTRY);
  if (!failed.ok) {
    throw failed.error;
  }
  // Joined and not checked: this entry is supposed to fail, and its outcome
  // is the thing being produced. What must succeed is the admission above.
  yield* failed.value.join();

  const settled = yield* held.session.submit(SETTLED_ENTRY);
  if (!settled.ok) {
    throw settled.error;
  }
  const after = yield* settled.value.join();
  if (!after.ok) {
    throw after.error;
  }

  // One Sidekick exchange that reads an entry through the legacy control, so
  // the chat half holds a genuine `REPL.EntryOutput` pair for the
  // compatibility row to read without running the control again.
  held.fake.script({ reply: '<REPL.EntryOutput entry="entry-2" />\n' });
  held.fake.script({ reply: "<Output>Read it.</Output>\n" });
  const answered = yield* held.owner.message("what did the second entry print?");
  if (!answered.ok) {
    throw answered.error;
  }

  const chat = held.execution.chat;
  if (chat.form !== "paired") {
    throw new Error("this execution has no published pair to copy");
  }
  const held932 = fileURLToPath(new URL("entries.jsonl", FIXTURE));
  const chatFile = fileURLToPath(new URL("sidekick.jsonl", FIXTURE));
  yield* until(
    writeFile(held932, sanitized(yield* until(readFile(chat.location.entries, "utf8"))), "utf8"),
  );
  yield* until(copyFile(chat.location.sidekick, chatFile));
  yield* until(
    writeFile(
      fileURLToPath(new URL("RECEIPT.md", FIXTURE)),
      yield* receipt(held932, chatFile),
      "utf8",
    ),
  );
  console.log(`wrote the fixture from ${chat.location.directory}`);
});

/**
 * The same history, with the one machine-specific string taken out of it.
 *
 * A failed entry's close retains its error the way the stream serializes
 * one — message, name and the stack of the process that raised it — and that
 * stack names this checkout's own absolute paths. Nothing reads it: the
 * projection takes the message alone, deliberately, so an entry's reason never
 * carries host paths or engine frames into a reading. So the stack is replaced
 * with a sentence saying where it went, and every other byte is the run's.
 */
function sanitized(history: string): string {
  return history
    .split("\n")
    .map((line) => {
      if (line.length === 0) {
        return line;
      }
      const record = JSON.parse(line);
      const error = record?.result?.error;
      if (typeof error === "object" && error !== null && "stack" in error) {
        error.stack = SUBSTITUTED_STACK;
      }
      return JSON.stringify(record);
    })
    .join("\n");
}

/** What the produced files are, and what produced them. */
function* receipt(entries: string, sidekick: string): Operation<string> {
  const entryBytes = yield* until(readFile(entries));
  const chatBytes = yield* until(readFile(sidekick));
  return [
    "# Issue 932 saved-failure fixture — producer receipt",
    "",
    "Produced by running",
    "`deno run --allow-all packages/cli/tests/fixtures/repl/issue-932/produce.ts`",
    "against the production REPL session, entry execution, canonical Prompt path",
    "and paired chat storage assembled by",
    "`packages/cli/tests/fixtures/repl/issue-883/sidekick-harness.ts`. The only",
    "scripted part is the agent: `createFakeAcp()` answers each turn with the",
    "reply `history.ts` states, and the ninth turn settles with stop reason",
    `\`${STOP_REASON}\`, which is how a saved turn that streamed a complete reply and`,
    "still failed is produced. Nothing was appended by hand.",
    "",
    "## What it holds",
    "",
    `\`entries.jsonl\` — ${lines(entryBytes)} records, ${entryBytes.length} bytes,`,
    `sha256 \`${digest(entryBytes)}\``,
    "",
    "- **Entry 1 — failed, printed nothing.** Nine saved agent turns: eight",
    "  completed, and a ninth that streamed a valid ballot JSON object and ended",
    "  failed. Every prompt captures its reply with `as`, so the entry rendered",
    "  nothing before the failure stopped it.",
    "- **Entry 2 — completed.** A later settled entry, so the latest entry and",
    "  the failed one are different entries.",
    "",
    `\`sidekick.jsonl\` — ${lines(chatBytes)} records, ${chatBytes.length} bytes,`,
    `sha256 \`${digest(chatBytes)}\``,
    "",
    'One exchange whose reply wrote `<REPL.EntryOutput entry="entry-2" />`, so the',
    "chat retains a genuine control and control-outcome pair for that historical",
    "read.",
    "",
    "## Sanitation",
    "",
    "Every string in both files is written in `history.ts` or by the harness: the",
    "entry source, the prompts, the replies, the failure message and the chat.",
    "The producing run's temporary data root is removed with its scope, and the",
    "fake provider's own session store is no part of the fixture.",
    "",
    "One byte of the run is not kept. The failed entry's close retains its error",
    "the way the stream serializes one, and that includes the stack of the",
    "process that raised it, which names the producing checkout's absolute paths.",
    "The producer replaces exactly that member with",
    `\`${SUBSTITUTED_STACK}\`, and nothing else. No reader of this history looks`,
    "at it: the projection takes a failed outcome's message alone, so the stack",
    "reaches no page, no record and no screen.",
    "",
  ].join("\n");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lines(bytes: Uint8Array): number {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.length > 0).length;
}
