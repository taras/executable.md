/**
 * Produce the saved-failure entry history these rows read (#932).
 *
 * Run by hand, never by a test:
 *
 * ```bash
 * deno run --allow-all packages/cli/tests/fixtures/repl/issue-932/produce.ts
 * ```
 *
 * What it writes is the bytes a real run left behind. The REPL session, the
 * entry executions, the canonical Prompt path and the paired storage are all
 * the production ones, assembled by the same harness the journey rows use;
 * only the agent is scripted, because what the fixture has to hold is a saved
 * failure rather than something a model said. A history hand-authored to this
 * shape would prove that the readers agree with the author, which is the one
 * thing it must not be able to do.
 *
 * It writes `entries.jsonl` and nothing else. The chat half beside it is a
 * **pinned snapshot** taken before `<REPL.Entry.Output />` replaced
 * `REPL.EntryOutput` in response admission: it holds that retired control's
 * own saved pair, which a current ceiling cannot produce because a response
 * can no longer write the name. `RECEIPT.md` states both halves, when each was
 * taken and the exact recipe for the pinned one, and is maintained by hand.
 *
 * Everything in the entry half is written here: the entry source, the prompts,
 * the replies and the failure message. No host path, home directory,
 * transcript or credential of anybody's is involved, so the file is sanitary
 * by construction rather than by being cleaned afterwards — with one
 * substitution the receipt names.
 *
 * Re-running this produces a history with different provider session keys,
 * because a key digests the working directory the run was made in and that
 * directory is a fresh temporary one. The receipt's digests describe the
 * checked-in bytes; refresh them by hand after deliberately regenerating.
 */

import { readFile, writeFile } from "node:fs/promises";
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

  const chat = held.execution.chat;
  if (chat.form !== "paired") {
    throw new Error("this execution has no published pair to copy");
  }
  const entries = fileURLToPath(new URL("entries.jsonl", FIXTURE));
  const produced = sanitized(yield* until(readFile(chat.location.entries, "utf8")));
  yield* until(writeFile(entries, produced, "utf8"));
  console.log(`wrote ${entries} from ${chat.location.directory}`);
  console.log(`${produced.length} bytes, sha256 ${digest(produced)}`);
  console.log("update RECEIPT.md by hand with those figures");
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

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
