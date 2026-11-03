import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { parseJson } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { selectJson } from "@executablemd/core/host";
import { z } from "zod";
import { MAX_FRAME } from "../../sidekick-acp/protocol.ts";
import type { EntryJournalPage } from "./entry-inspection.ts";

const windowMetadata = z
  .tuple([
    z.number().int().positive().safe(),
    z.string(),
    z.number().int().nonnegative().safe(),
    z.number().int().positive().safe(),
  ])
  .refine(([, , start, end]) => start < end);

type Range = { start: number; end: number };

function format(entry: number, query: string, range: Range): string {
  return (
    `select(${JSON.stringify([entry, query, range.start, range.end])} != null) |\n` +
    `select(.entry == ${entry}) |\n(\n${query}\n) | .[${range.start}:${range.end}]`
  );
}

function recognize(expression: string) {
  const line = expression.slice(0, expression.indexOf("\n"));
  if (!line.startsWith("select(") || !line.endsWith(" != null) |")) {
    return undefined;
  }
  try {
    const parsed = windowMetadata.safeParse(JSON.parse(line.slice(7, -11)));
    if (!parsed.success) {
      return undefined;
    }
    const [entry, query, start, end] = parsed.data;
    const range = { start, end };
    return expression === format(entry, query, range) ? { entry, query, range } : undefined;
  } catch {
    return undefined;
  }
}

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

function fits(page: EntryJournalPage): boolean {
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

function tooLarge(): Result<never> {
  return Err(
    new Error(
      "Journal result exceeds the serialized response bound. Use a narrower yq selection, " +
        "such as .records[0].exec.stdout or .records[0].exec.stderr, to read a channel by pages.",
    ),
  );
}

function rangesOf(value: string | Json[], entry: number, query: string): Result<Range[]> {
  const ranges: Range[] = [];
  if (typeof value === "string") {
    const length = [...value].length;
    for (let start = 0; start < length; start += 4096) {
      ranges.push({ start, end: Math.min(start + 4096, length) });
    }
    return Ok(ranges);
  }
  const navigation = format(entry, query, {
    start: Number.MAX_SAFE_INTEGER - 1,
    end: Number.MAX_SAFE_INTEGER,
  });
  for (let start = 0; start < value.length; ) {
    let end = start;
    while (
      end < value.length &&
      end - start < 20 &&
      fits({
        value: value.slice(start, end + 1),
        next: navigation,
        prev: navigation,
        last: navigation,
      })
    ) {
      end += 1;
    }
    if (end === start) {
      return tooLarge();
    }
    ranges.push({ start, end });
    start = end;
  }
  return Ok(ranges);
}

/** Evaluate one request against one complete acknowledged Journal value. */
export function* queryJournal(
  expression: string,
  input: { entry: number; [key: string]: Json },
): Operation<Result<EntryJournalPage>> {
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
  let value = selected.value;
  let query = expression;
  let range: Range | undefined;
  if (recognized !== undefined) {
    const base = yield* evaluate(
      `select(.entry == ${recognized.entry}) |\n(\n${recognized.query}\n)`,
      serialized,
    );
    if (base.ok && (typeof base.value === "string" || Array.isArray(base.value))) {
      value = base.value;
      query = recognized.query;
      range = recognized.range;
    }
  }
  const empty = { value, next: null, prev: null, last: null };
  if (typeof value !== "string" && !Array.isArray(value)) {
    return fits(empty) ? Ok(empty) : tooLarge();
  }
  const length = typeof value === "string" ? [...value].length : value.length;
  if (range === undefined && length <= (typeof value === "string" ? 4096 : 20) && fits(empty)) {
    return Ok(empty);
  }
  const cuts = rangesOf(value, input.entry, query);
  if (!cuts.ok) {
    return cuts;
  }
  const current = range ?? cuts.value[0] ?? { start: 0, end: 0 };
  const previous = cuts.value.findLast((one) => one.start < current.start);
  const next = current.end < length ? cuts.value.find((one) => one.end > current.end) : undefined;
  const last = current.end < length ? cuts.value.at(-1) : undefined;
  const navigation = (one: Range | undefined): string | null =>
    one === undefined ? null : format(input.entry, query, one);
  const page: EntryJournalPage = {
    value:
      range === undefined
        ? typeof value === "string"
          ? [...value].slice(current.start, current.end).join("")
          : value.slice(current.start, current.end)
        : selected.value,
    next: navigation(next === undefined ? undefined : { start: current.end, end: next.end }),
    prev: navigation(
      previous === undefined ? undefined : { start: previous.start, end: current.start },
    ),
    last: navigation(last),
  };
  return fits(page) ? Ok(page) : tooLarge();
}
