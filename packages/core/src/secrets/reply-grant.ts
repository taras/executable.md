/**
 * Provenance of an accepted reply through generated evaluation and feedback.
 * Each allowance accounts for a finding in a particular durable event using
 * its authored source range or a choice carried from an acknowledged answer.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { ELICITATION_SCHEMA_FIELD, readElicitationAnswer } from "../elicit-journal.ts";
import { dataStringLiteral } from "../generated-expressions.ts";
import type { SourceRange } from "../document-targets.ts";
import { isJsonObject } from "../json.ts";
import { secretInputFields } from "./input-schema.ts";
import type { SecretSpan } from "./scanner.ts";
import type { AppendGrant as ReplyCopyGrant } from "./append-approval.ts";
import { encodedOffset, exactly, place, within } from "./secret-placement.ts";
import type { ApprovedMatch, Path } from "./secret-placement.ts";
export type { ApprovedMatch } from "./secret-placement.ts";

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
  const selections = new Map<string, Map<string, ElicitChoiceSelection>>();
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
        const fields = selections.get(selection.coroutineId) ?? new Map();
        fields.set(selection.field, selection);
        selections.set(selection.coroutineId, fields);
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
      if (event.type !== "yield") {
        return false;
      }
      if (!admitted) {
        if (event.result.status !== "ok") {
          return false;
        }
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
    const choices = selections.get(event.coroutineId);
    selections.delete(event.coroutineId);
    const index = positions.get(event.coroutineId) ?? 0;
    const projection =
      event.result.status === "ok" ? readElicitationAnswer(event, index) : undefined;
    if (projection?.ok === false) {
      return false;
    }
    const answer = projection?.value;
    const protectedReceipt = secretInputFields(schema).length > 0;
    for (const [name, property] of Object.entries(properties)) {
      if (
        !isJsonObject(property) ||
        (projection !== undefined && (property.type !== "string" || property.writeOnly === true))
      ) {
        continue;
      }
      const offered = Array.isArray(property.enum) ? property.enum : [];
      offered.forEach((choice, index) => {
        const origin = originOf(name, index, choice);
        if (origin !== undefined) {
          leaves.push({
            path: ["description", ELICITATION_SCHEMA_FIELD, "properties", name, "enum", index],
            origin,
          });
        }
      });
      const selected = choices?.get(name);
      if (
        selected !== undefined &&
        property.type === "string" &&
        property.writeOnly !== true &&
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
          leaves.push({ path, origin, answerField: name });
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
    const text = answer === undefined ? undefined : JSON.stringify(answer, null, 2);
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
      if (leaf.answerField !== undefined && text !== undefined) {
        const fieldPlacement = place(`${text}\n`, [[leaf.answerField]], 2)?.[0];
        const start = encodedOffset(fieldPlacement, at.start);
        const end = encodedOffset(fieldPlacement, at.end);
        if (start === undefined || end === undefined) {
          return false;
        }
        const bytes = at.value.slice(at.start, at.end);
        if (text.slice(start, end) !== bytes) {
          return false;
        }
        found.push({ ...span, bytes, start, end });
      }
    }
    if (found.length > 0 && text !== undefined) {
      pending = { coroutineId: event.coroutineId, index, text, matches: found };
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

interface Leaf {
  readonly path: Path;
  readonly origin: number;
  readonly answerField?: string;
}

/** The approved matches of one reply, from the spans its own scan located. */
export function approvedMatches(text: string, spans: readonly SecretSpan[]): ApprovedMatch[] {
  return spans.map((span) => Object.freeze({ ...span, bytes: text.slice(span.start, span.end) }));
}
