/**
 * The base-format REPL history #939's legacy rows read, and the documents that
 * produced it.
 *
 * `legacy-root-bindings.jsonl` was written by really running these two entries
 * through `submitReplEntry` at commit `7ee526665dcadd9ec79dca9f8b6a4726903d9a4f`,
 * before root-binding publication existed. Its records are therefore the ones
 * that revision wrote: four root captures and one eval control in a completed
 * entry, then a capture, a component and an eval block retained ahead of a
 * question nobody answered, which is what left the second entry unfinished.
 *
 * The bytes are checked in rather than regenerated, because what the rows
 * assert is that a history written *without* publication metadata still reads
 * and still continues in its own mode. A fixture rebuilt by the current runtime
 * would carry today's records and prove nothing about that.
 */

import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Operation } from "effection";

/** The commit whose runtime wrote these records. */
export const LEGACY_BASE = "7ee526665dcadd9ec79dca9f8b6a4726903d9a4f";

/**
 * The completed legacy entry: four root captures and one eval control.
 *
 * At the base revision only the eval block published anything durable, which is
 * what makes this a recorded-only history for every other name.
 */
export const LEGACY_COMPLETED = [
  '<Let as="legacySaved" value="alpha" />',
  "",
  '<Let as="legacyText">beta</Let>',
  "",
  '<Json value={{ answer: 1 }} as="legacyJson" />',
  "",
  '<Checklist title="Legacy" steps={2} as="legacySummary" />',
  "",
  "```js eval",
  'const legacyEval = "control";',
  "```",
  "",
  "Saved {legacySaved} and {legacyText}; eval {legacyEval}.",
  "",
].join("\n");

/**
 * The legacy entry that never settled: a capture and a component before its
 * question, and a capture and an eval block after it.
 */
export const LEGACY_UNFINISHED = [
  '<Let as="legacyResumed" value="prefix" />',
  "",
  '<Checklist title="Prefix" steps={3} as="legacyPrefixSummary" />',
  "",
  "```js eval",
  'const legacyPrefixEval = "before";',
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Go?</Elicit>',
  "",
  '<Let as="legacySuffix" value="after" />',
  "",
  "```js eval",
  "const legacySuffixEval = `${legacyPrefixEval}/${answer.decision}`;",
  "```",
  "",
  "Answered {legacySuffixEval} with {legacySuffix}.",
  "",
].join("\n");

/** The exact bytes the fixture file holds. */
export function legacyHistoryText(): Operation<string> {
  return readTextFile(fileURLToPath(new URL("./legacy-root-bindings.jsonl", import.meta.url)));
}

/**
 * The fixture's records, parsed through the reader the REPL's own journal uses.
 *
 * A record this version could not read would be a fixture that stopped
 * describing a readable legacy history, so it refuses here rather than being
 * skipped.
 */
export function* legacyHistory(): Operation<DurableEvent[]> {
  const text = yield* legacyHistoryText();
  const events: DurableEvent[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      throw new Error(`the legacy fixture holds a record this version cannot read: ${line}`);
    }
    events.push(parsed.value);
  }
  return events;
}
