import type { Json } from "./types.ts";
import type { DurableEvent } from "@executablemd/durable-streams";
import { ELICITATION_SCHEMA_FIELD, readElicitationAnswer } from "./elicit-journal.ts";
import { dataStringLiteral } from "./generated-expressions.ts";
import type { SourceRange } from "./document-targets.ts";
import { isJsonObject } from "./json.ts";
import { secretInputFields } from "./secrets/input-schema.ts";
import type { SecretSpan } from "./secrets/scanner.ts";
import type { AppendGrant } from "./secrets/append-approval.ts";
import { exactly, place, within } from "./secrets/secret-placement.ts";
import type { ApprovedMatch, Path } from "./secrets/secret-placement.ts";
/**
 * An acknowledged answer and the exact value ranges carried from authored choices.
 * The journal coordinate identifies the question observed by the host.
 */
export interface ApprovedElicitAnswer {
  readonly coroutineId: string;
  readonly index: number;
  readonly value: Json;
  readonly copies: readonly {
    readonly field: string;
    readonly source: SourceRange;
    readonly match: ApprovedMatch;
  }[];
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
 * Provenance for one evaluation of exactly the approved source.
 *
 * Bound on its admission record: the first `generated_xmd` admission named
 * for this request whose retained source is byte-equal to the approved source
 * fixes the evaluation's own coroutine. Afterwards the grant speaks only for
 * that coroutine's question records. Their schema may hold an approved match
 * only as an enum choice the `<Elicit>` element at that record's own source
 * position wrote, and their answer only as one of those choices, selected
 * whole. Anything else the evaluation journals is unaccounted for.
 */
export function approvedGeneratedSource(input: {
  readonly id: string;
  readonly source: string;
  readonly approved: readonly ApprovedMatch[];
}): AppendGrant & {
  readonly bind: (id: string) => void;
  readonly schemas: Map<number, SourceRange>;
  readonly matches: readonly ApprovedMatch[];
  readonly select: (selection: ElicitChoiceSelection) => void;
  readonly acknowledge: (event: DurableEvent) => void;
  readonly answers: () => readonly ApprovedElicitAnswer[];
} {
  let coroutine: string | undefined;
  let admitted = false;
  const answers: ApprovedElicitAnswer[] = [];
  const positions = new Map<string, number>();
  const pending = new Map<string, ApprovedElicitAnswer>();
  const schemas = new Map<number, SourceRange>();
  const selections = new Map<string, Map<string, ElicitChoiceSelection>>();
  const admission = `generated:${input.id}`;
  const owns = (id: string): boolean =>
    coroutine !== undefined && (id === coroutine || id.startsWith(`${coroutine}.`));
  return {
    schemas,
    matches: input.approved,
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
    acknowledge(event) {
      if (!owns(event.coroutineId) || event.type !== "yield") {
        return;
      }
      const index = positions.get(event.coroutineId) ?? 0;
      const answer = pending.get(event.coroutineId);
      if (answer?.index === index) {
        answers.push(answer);
        pending.delete(event.coroutineId);
      }
      positions.set(event.coroutineId, index + 1);
      selections.delete(event.coroutineId);
    },
    bind(id) {
      coroutine ??= id;
    },
    answers: () => Object.freeze([...answers]),
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
    const copies: ApprovedElicitAnswer["copies"][number][] = [];
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
      if (leaf.answerField !== undefined) {
        const bytes = at.value.slice(at.start, at.end);
        if (serialized.slice(span.start, span.end) !== bytes) {
          return false;
        }
        copies.push({
          field: leaf.answerField,
          source: { start: leaf.origin + at.start, end: leaf.origin + at.end },
          match: { ...span, bytes, start: at.start, end: at.end },
        });
      }
    }
    if (copies.length > 0 && answer !== undefined) {
      pending.set(event.coroutineId, {
        coroutineId: event.coroutineId,
        index,
        value: answer,
        copies,
      });
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

interface Leaf {
  readonly path: Path;
  readonly origin: number;
  readonly answerField?: string;
}
