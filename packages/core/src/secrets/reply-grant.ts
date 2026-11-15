/**
 * The closed exception secret detection makes for one accepted Sidekick reply.
 *
 * A held conversation that withheld a completed reply may ask its trusted
 * foreground host whether to keep it. When the person accepts, the reply's
 * exact bytes are no longer something the journal must refuse — but only
 * where those bytes really are that reply: its acceptance record, the
 * evaluation of exactly that source, the question choices that source wrote
 * and the answer selected from them, and the one feedback turn that carries
 * that answer back. Anywhere else the same value is a new finding.
 *
 * So a grant is not a switch and not a fingerprint list. Each one names one
 * event — by the coroutine, effect type and durable name its owner is about to
 * append — and the exact string fields of that event that may hold an
 * approved match. The gate scans the whole serialized event as always. Every
 * finding must then translate, through the event's actual serialization, into
 * one of those fields at a position the grant can account for, with the same
 * rule, message and bytes. One finding anywhere else, or one the grant cannot
 * place, and the event is refused exactly as it would have been.
 *
 * Nothing here is durable, rendered or reachable from a document: the grants
 * live in the execution's own detection, beside its scanner, and are added
 * and retired only by the conversation that accepted the reply.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { ELICITATION_SCHEMA_FIELD, readElicitationAnswer } from "../elicit-journal.ts";
import { dataStringLiteral } from "../generated-expressions.ts";
import type { SourceRange } from "../document-targets.ts";
import { isJsonObject } from "../json.ts";
import { secretInputFields } from "./input-schema.ts";
import type { SecretSpan } from "./scanner.ts";

/** One approved match, in the coordinates of the reply it was found in. */
export interface ApprovedMatch extends SecretSpan {
  /** The exact matched bytes, held only in memory for the life of the grant. */
  readonly bytes: string;
}

/** A value the evaluation's own question answered with, carried to feedback. */
export interface FeedbackSlice extends SourceRange {
  readonly coroutineId: string;
  readonly index: number;
}

interface CarriedAnswer {
  readonly coroutineId: string;
  readonly index: number;
  readonly text: string;
  readonly matches: readonly ApprovedMatch[];
}

export interface ElicitChoiceSelection {
  readonly coroutineId: string;
  readonly index: number;
  readonly name: string;
  readonly fingerprint: string;
  readonly field: string;
  readonly option: number;
}

/** One live allowance, as the gate asks it. */
export interface ReplyCopyGrant {
  published?(event: DurableEvent): void;
  /**
   * Whether this grant speaks for `event` at all.
   *
   * Exactly one grant may speak for an event; one that does not leaves it to
   * the next, and an event no grant speaks for is refused on any finding.
   */
  claims(event: DurableEvent): boolean;
  /** Whether every span the scanner found in `serialized` is accounted for. */
  admits(event: DurableEvent, serialized: string, spans: readonly SecretSpan[]): boolean;
}

/** The acceptance record of one withheld turn, and nothing else. */
export function acceptanceGrant(input: {
  readonly type: string;
  readonly name: string;
  readonly text: string;
  readonly approved: readonly ApprovedMatch[];
}): ReplyCopyGrant {
  let used = false;
  return {
    claims(event) {
      return (
        !used &&
        event.type === "yield" &&
        event.coroutineId === "root" &&
        event.description.type === input.type &&
        event.description.name === input.name
      );
    },
    admits(event, serialized, spans) {
      used = true;
      if (event.type !== "yield" || event.result.status !== "ok") {
        return false;
      }
      const value = event.result.value;
      if (!isJsonObject(value) || value.text !== input.text) {
        return false;
      }
      const placed = place(serialized, [["result", "value", "text"]]);
      return (
        placed !== undefined &&
        spans.every((span) => {
          const at = within(placed, span);
          return at !== undefined && exactly(input.approved, span, at.start, at.end);
        })
      );
    },
  };
}

/**
 * One evaluation of exactly the accepted source.
 *
 * Bound on its admission record: the first `generated_xmd` admission named
 * for this request whose retained source is byte-equal to the accepted reply
 * fixes the evaluation's own coroutine. Afterwards the grant speaks only for
 * that coroutine's question records. Their schema may hold an approved match
 * only as an enum choice the `<Elicit>` element at that record's own source
 * position wrote, and their answer only as one of those choices, selected
 * whole. Anything else the evaluation journals is unaccounted for.
 */
export function evaluationGrant(input: {
  readonly id: string;
  readonly source: string;
  readonly approved: readonly ApprovedMatch[];
}): ReplyCopyGrant & {
  readonly bind: (id: string) => void;
  readonly schemas: Map<number, SourceRange>;
  readonly select: (selection: ElicitChoiceSelection) => void;
  readonly carried: () => readonly CarriedAnswer[];
} {
  let coroutine: string | undefined;
  let admitted = false;
  const carried: CarriedAnswer[] = [];
  const positions = new Map<string, number>();
  let pending: CarriedAnswer | undefined;
  const schemas = new Map<number, SourceRange>();
  const selections = new Map<string, ElicitChoiceSelection>();
  const admission = `generated:${input.id}`;
  const owns = (id: string): boolean =>
    coroutine !== undefined && (id === coroutine || id.startsWith(`${coroutine}.`));
  return {
    schemas,
    select(selection) {
      if (
        owns(selection.coroutineId) &&
        selection.index === (positions.get(selection.coroutineId) ?? 0)
      ) {
        selections.set(selection.coroutineId, selection);
      }
    },
    published(event) {
      if (!owns(event.coroutineId) || event.type !== "yield") {
        return;
      }
      const index = positions.get(event.coroutineId) ?? 0;
      if (pending?.coroutineId === event.coroutineId && pending.index === index) {
        carried.push(pending);
        pending = undefined;
      }
      positions.set(event.coroutineId, index + 1);
      selections.delete(event.coroutineId);
    },
    bind(id) {
      coroutine ??= id;
    },
    carried: () => Object.freeze([...carried]),
    claims(event) {
      if (event.type !== "yield") {
        return false;
      }
      if (!admitted) {
        return (
          event.description.type === "generated_xmd" &&
          event.description.name === admission &&
          event.coroutineId === coroutine
        );
      }
      return owns(event.coroutineId) && event.description.type === "elicit";
    },
    admits(event, serialized, spans) {
      if (event.type !== "yield" || event.result.status !== "ok") {
        return false;
      }
      if (!admitted) {
        const value = event.result.value;
        if (!isJsonObject(value) || value.source !== input.source) {
          return false;
        }
        const placed = place(serialized, [["result", "value", "source"]]);
        const matched =
          placed !== undefined &&
          spans.every((span) => {
            const at = within(placed, span);
            return at !== undefined && exactly(input.approved, span, at.start, at.end);
          });
        if (matched) {
          admitted = true;
        }
        return matched;
      }
      return admitsQuestion(event, serialized, spans);
    },
  };

  function admitsQuestion(
    event: DurableEvent & { type: "yield" },
    serialized: string,
    spans: readonly SecretSpan[],
  ): boolean {
    const schema = event.description[ELICITATION_SCHEMA_FIELD];
    const position = event.description["executablemd.source-position"];
    if (!isJsonObject(schema) || !isJsonObject(position)) {
      return false;
    }
    if (position.generatedSource !== input.id || typeof position.offset !== "number") {
      return false;
    }
    const schemaRange = schemas.get(position.offset);
    if (schemaRange === undefined) {
      return false;
    }
    const authored = input.source.slice(schemaRange.start, schemaRange.end);
    const properties = isJsonObject(schema.properties) ? schema.properties : undefined;
    if (properties === undefined) {
      return false;
    }
    const leaves: Leaf[] = [];
    const selected = selections.get(event.coroutineId);
    selections.delete(event.coroutineId);
    const projection = readElicitationAnswer(event, positions.get(event.coroutineId) ?? 0);
    if (!projection.ok) {
      return false;
    }
    const answer = projection.value;
    const protectedReceipt = secretInputFields(schema).length > 0;
    for (const [name, property] of Object.entries(properties)) {
      if (!isJsonObject(property) || property.type !== "string" || property.writeOnly === true) {
        continue;
      }
      const offered = Array.isArray(property.enum) ? property.enum : [];
      offered.forEach((choice, index) => {
        const origin = originOf(name, index, choice);
        if (origin !== undefined) {
          leaves.push({
            path: ["description", ELICITATION_SCHEMA_FIELD, "properties", name, "enum", index],
            origin,
            carried: false,
          });
        }
      });
      if (
        selected?.field === name &&
        selected.name === event.description.name &&
        selected.fingerprint === event.description.input &&
        isJsonObject(answer) &&
        typeof answer[name] === "string" &&
        answer[name] === offered[selected.option]
      ) {
        const origin = originOf(name, selected.option, answer[name]);
        if (origin !== undefined) {
          const path = protectedReceipt
            ? ["result", "value", "executablemd.input", "members", name, "value"]
            : ["result", "value", name];
          leaves.push({ path, origin, carried: true });
        }
      }
    }
    const placed = place(
      serialized,
      leaves.map((leaf) => leaf.path),
    );
    if (placed === undefined) {
      return false;
    }
    const found: ApprovedMatch[] = [];
    const text = JSON.stringify(answer, null, 2);
    for (const span of spans) {
      const at = within(placed, span);
      if (at === undefined) {
        return false;
      }
      const leaf = leaves[at.leaf];
      if (
        leaf === undefined ||
        !exactly(input.approved, span, leaf.origin + at.start, leaf.origin + at.end)
      ) {
        return false;
      }
      if (leaf.carried) {
        const field = selected?.field;
        const fieldPlacement =
          field === undefined ? undefined : place(`${text}\n`, [[field]], 2)?.[0];
        const contentStart = fieldPlacement?.at;
        const start = encodedOffset(fieldPlacement, at.start);
        const end = encodedOffset(fieldPlacement, at.end);
        if (contentStart === undefined || start === undefined || end === undefined) {
          return false;
        }
        const bytes = at.value.slice(at.start, at.end);
        if (text.slice(start, end) !== bytes) {
          return false;
        }
        found.push({ ...span, bytes, start, end });
      }
    }
    if (found.length > 0 && selected !== undefined) {
      pending = { coroutineId: selected.coroutineId, index: selected.index, text, matches: found };
    }
    return true;

    function originOf(name: string, index: number, value: unknown): number | undefined {
      if (typeof value !== "string" || schemaRange === undefined) {
        return undefined;
      }
      try {
        const literal = dataStringLiteral(authored, ["properties", name, "enum", index]);
        return literal?.value === value ? schemaRange.start + literal.start : undefined;
      } catch {
        return undefined;
      }
    }
  }
}

/**
 * The next turn's input, where it carries the evaluation's own answer.
 *
 * `slices` are the host's statement of where, in the text it handed the turn,
 * it placed that answer. The turn's final input must still begin with exactly
 * that text, so a composition that changed it inherits nothing, and each
 * finding must lie inside one slice with the bytes the evaluation's answer
 * carried.
 */
export function feedbackGrant(input: {
  readonly name: string;
  readonly type: string;
  readonly prepare: (delegated: string) => readonly ApprovedMatch[];
}): ReplyCopyGrant {
  let used = false;
  return {
    claims(event) {
      return (
        !used &&
        event.type === "yield" &&
        event.coroutineId === "root" &&
        event.description.type === input.type &&
        event.description.name === input.name
      );
    },
    admits(event, serialized, spans) {
      used = true;
      if (event.type !== "yield") {
        return false;
      }
      const delegated = event.description.input;
      if (typeof delegated !== "string") {
        return false;
      }
      const copies = input.prepare(delegated);
      const placed = place(serialized, [["description", "input"]]);
      return (
        placed !== undefined &&
        spans.every((span) => {
          const at = within(placed, span);
          if (at === undefined) {
            return false;
          }
          return exactly(copies, span, at.start, at.end);
        })
      );
    },
  };
}

export function carriedCopies(
  text: string,
  slices: readonly FeedbackSlice[],
  carried: readonly CarriedAnswer[],
): ApprovedMatch[] {
  return slices.flatMap((slice) => {
    const answer = carried.find(
      (one) => one.coroutineId === slice.coroutineId && one.index === slice.index,
    );
    if (answer === undefined || text.slice(slice.start, slice.end) !== answer.text) {
      return [];
    }
    return answer.matches.map((match) => ({
      ...match,
      start: slice.start + match.start,
      end: slice.start + match.end,
    }));
  });
}

/** Whether one located span is exactly one approved match. */
function exactly(
  approved: readonly ApprovedMatch[],
  span: SecretSpan,
  start: number,
  end: number,
): boolean {
  return approved.some(
    (one) =>
      one.ruleId === span.ruleId &&
      one.messageId === span.messageId &&
      one.start === start &&
      one.end === end,
  );
}

type Path = readonly (string | number)[];

interface Leaf {
  readonly path: Path;
  readonly origin: number;
  readonly carried: boolean;
}

/** One string field, where the event's serialization holds its literal. */
interface Placed {
  readonly value: string;
  /** Offset of the literal's opening quote in the serialized event. */
  readonly at: number;
  /** For each content offset of the literal, the value index it begins, or -1. */
  readonly boundaries: Map<number, number>;
  readonly length: number;
}

/**
 * Where each named string field sits in this exact serialization.
 *
 * Found by serializing the same event with each field replaced by a unique
 * marker and then putting the real literals back: what that reconstructs must
 * be byte-identical to what the gate scanned, or nothing is placed. A field
 * that is absent or not a string places nothing either.
 */
function place(serialized: string, paths: readonly Path[], indent?: number): Placed[] | undefined {
  let copy: unknown;
  try {
    copy = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  const nonce = crypto.randomUUID();
  const values: string[] = [];
  for (const [index, path] of paths.entries()) {
    const parent = walk(copy, path.slice(0, -1));
    const key = path[path.length - 1];
    if (parent === undefined || key === undefined) {
      return undefined;
    }
    const value = (parent as Record<string | number, unknown>)[key];
    if (typeof value !== "string") {
      return undefined;
    }
    values.push(value);
    (parent as Record<string | number, unknown>)[key] = `\u0001${nonce}:${index}\u0001`;
  }
  const marked = `${JSON.stringify(copy, null, indent)}\n`;
  const located = values
    .map((value, index) => {
      const marker = JSON.stringify(`\u0001${nonce}:${index}\u0001`);
      const at = marked.indexOf(marker);
      return { index, value, at, marker };
    })
    .sort((a, b) => a.at - b.at);
  if (located.some((one) => one.at < 0)) {
    return undefined;
  }
  let rebuilt = "";
  let cursor = 0;
  const placed: Placed[] = new Array(values.length);
  for (const one of located) {
    rebuilt += marked.slice(cursor, one.at);
    const literal = JSON.stringify(one.value);
    const boundaries = boundariesOf(one.value);
    if (boundaries === undefined) {
      return undefined;
    }
    placed[one.index] = {
      value: one.value,
      at: rebuilt.length,
      boundaries,
      length: literal.length,
    };
    rebuilt += literal;
    cursor = one.at + one.marker.length;
  }
  rebuilt += marked.slice(cursor);
  return rebuilt === serialized ? placed : undefined;
}

function encodedOffset(field: Placed | undefined, index: number): number | undefined {
  if (field === undefined) {
    return undefined;
  }
  for (const [offset, unit] of field.boundaries) {
    if (unit === index) {
      return field.at + 1 + offset;
    }
  }
  return undefined;
}

/** Translate one serialized span into a field's own value coordinates. */
function within(
  placed: readonly Placed[],
  span: SecretSpan,
): { leaf: number; value: string; start: number; end: number } | undefined {
  for (const [leaf, one] of placed.entries()) {
    if (span.start <= one.at || span.end >= one.at + one.length) {
      continue;
    }
    const start = one.boundaries.get(span.start - one.at - 1);
    const end = one.boundaries.get(span.end - one.at - 1);
    if (start === undefined || end === undefined || start < 0 || end < 0) {
      return undefined;
    }
    return { leaf, value: one.value, start, end };
  }
  return undefined;
}

/**
 * Each content offset of `JSON.stringify(value)` that begins a code unit of
 * `value`, mapped to that unit's index — with the end of the value mapped to
 * its length. Offsets inside an escape sequence or between the halves of a
 * surrogate pair are not boundaries.
 */
export function boundariesOf(value: string): Map<number, number> | undefined {
  const boundaries = new Map<number, number>();
  let offset = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    let width = 1;
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 2;
      }
    }
    boundaries.set(offset, index);
    offset += JSON.stringify(value.slice(index, index + width)).length - 2;
    index += width;
  }
  boundaries.set(offset, value.length);
  return offset === JSON.stringify(value).length - 2 ? boundaries : undefined;
}

function walk(value: unknown, path: Path): object | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current !== null && typeof current === "object" ? current : undefined;
}

/** The approved matches of one reply, from the spans its own scan located. */
export function approvedMatches(text: string, spans: readonly SecretSpan[]): ApprovedMatch[] {
  return spans.map((span) => Object.freeze({ ...span, bytes: text.slice(span.start, span.end) }));
}
