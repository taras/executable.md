import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { parseJson } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { pageSelectedValue, selectJson } from "@executablemd/core/host";
import type { SelectedValuePageAdapter, SelectedValueWindow } from "@executablemd/core/host";
import {
  formatJournalWindow as format,
  recognizeJournalWindow as recognize,
  resolveJournalMaxBytes,
} from "./journal-policy.ts";
import { MAX_FRAME } from "../../sidekick-acp/protocol.ts";
import type { EntryJournalPage } from "./entry-inspection.ts";

function* evaluate(expression: string, input: string): Operation<Result<Json>> {
  if (expression.trim() === "") {
    return Err(new Error("Journal needs a nonempty yq expression."));
  }
  try {
    const selected = yield* selectJson(expression, input);
    return selected.ok ? Ok(parseJson(JSON.parse(selected.value))) : selected;
  } catch (error) {
    return Err(new Error("Journal could not evaluate this yq expression.", { cause: error }));
  }
}

function fits(page: EntryJournalPage, maxBytes?: number): boolean {
  if (maxBytes !== undefined) {
    return new TextEncoder().encode(JSON.stringify(page)).length <= maxBytes;
  }
  return (
    new TextEncoder().encode(
      JSON.stringify({
        id: Number.MAX_SAFE_INTEGER,
        kind: "value",
        value: page,
      }),
    ).length <= MAX_FRAME
  );
}

function tooLarge(): Error {
  return new Error(
    "Journal result exceeds the serialized response bound. Use a narrower yq selection, " +
      "such as .records[0].exec.stdout or .records[0].exec.stderr, to read a channel by pages.",
  );
}

function adapterFor(entry: number): SelectedValuePageAdapter {
  return {
    format: (query, range, maxBytes) => format(entry, query, range, maxBytes),
    fits,
    tooLarge,
  };
}

/** Evaluate one request against one complete acknowledged Journal value. */
export function* queryJournal(
  expression: string,
  input: { entry: number; [key: string]: Json },
  explicitMaxBytes?: number,
): Operation<Result<EntryJournalPage>> {
  const policy = resolveJournalMaxBytes(expression, explicitMaxBytes);
  if (!policy.ok) {
    return policy;
  }
  const maxBytes = policy.value;
  const recognized = recognize(expression);
  // A collecting query can emit a value after an empty guard; check the resolved entry too.
  if (recognized !== undefined && recognized.entry !== input.entry) {
    return Err(
      new Error("This Journal window belongs to another entry. Reuse its positive entry number."),
    );
  }
  const serialized = JSON.stringify(input);
  const selected = yield* evaluate(expression, serialized);
  if (!selected.ok) {
    return selected;
  }
  let window: SelectedValueWindow | undefined;
  if (recognized !== undefined) {
    const base = yield* evaluate(
      `select(.entry == ${recognized.entry}) |\n(\n${recognized.query}\n)`,
      serialized,
    );
    if (base.ok && (typeof base.value === "string" || Array.isArray(base.value))) {
      window = {
        value: base.value,
        query: recognized.query,
        range: recognized.range,
        preserveWindow: recognized.maxBytes === maxBytes,
      };
    }
  }
  return pageSelectedValue(selected.value, expression, window, maxBytes, adapterFor(input.entry));
}
