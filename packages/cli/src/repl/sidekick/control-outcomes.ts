import {
  elicitationEffectName,
  readElicitationAnswer,
  readGeneratedRootAdmission,
} from "@executablemd/core/host";
import { parseDurableEvent, SOURCE_POSITION_FIELD } from "@executablemd/durable-streams";
import type { Yield } from "@executablemd/durable-streams";
import { Err, Ok } from "effection";
import type { Result } from "effection";
import { SidekickHistoryError } from "./history.ts";
import type { ControlOutcomeRecord, ControlRecord, SidekickRecord } from "./history.ts";

export function controlSlot(conversation: string, response: string, order: number): string {
  return `${conversation}\0${response}\0${order}`;
}

interface Coroutine {
  index: number;
  closed: boolean;
  admission?: Yield;
  asking?: ControlRecord;
}

export interface ControlOutcome {
  readonly intent: ControlRecord;
  readonly outcome: ControlOutcomeRecord;
  readonly at: number;
}

function generatedRoot(id: string): string | undefined {
  return /^(generated_root:[1-9][0-9]*)(?:\..+)?$/.exec(id)?.[1];
}

/** Resolve operations in the order their facts were acknowledged. */
export function acknowledgedControlOutcomes(
  records: readonly SidekickRecord[],
): Result<ReadonlyMap<string, ControlOutcome>> {
  const outcomes = new Map<string, ControlOutcome>();
  const intents = new Map<string, ControlRecord>();
  const coroutines = new Map<string, Coroutine>();
  function coroutine(conversation: string, id: string): Coroutine {
    const key = `${conversation}\0${id}`;
    let state = coroutines.get(key);
    if (state === undefined) {
      state = { index: 0, closed: false };
      coroutines.set(key, state);
    }
    return state;
  }
  const refused = (detail = "has inconsistent control outcome associations") =>
    Err<never>(new SidekickHistoryError(`this chat history ${detail}.`));

  for (const [at, record] of records.entries()) {
    if (record.kind === "control") {
      const key = controlSlot(record.conversation, record.response, record.order);
      if (intents.has(key)) {
        return refused(`records two operations at one position (record ${at + 1})`);
      }
      intents.set(key, record);
      const ref = record.elicit;
      if (ref !== undefined) {
        const rootId = generatedRoot(ref.coroutineId);
        if (rootId === undefined) {
          return refused();
        }
        const root = coroutine(record.conversation, rootId);
        const site = coroutine(record.conversation, ref.coroutineId);
        if (
          root.closed ||
          site.closed ||
          site.index !== ref.index ||
          root.admission === undefined ||
          readGeneratedRootAdmission(root.admission, record.response) === undefined
        ) {
          return refused();
        }
        site.asking = record;
      }
    } else if (record.kind === "control-outcome") {
      const key = controlSlot(record.conversation, record.response, record.order);
      const intent = intents.get(key);
      if (intent === undefined) {
        return refused(
          `records what an operation answered without recording the operation (record ${at + 1})`,
        );
      }
      if (intent.elicit !== undefined || outcomes.has(key)) {
        return refused(`answers one operation twice (record ${at + 1})`);
      }
      outcomes.set(key, { intent, outcome: record, at });
    } else if (record.kind === "event") {
      const parsed = parseDurableEvent(record.event);
      if (!parsed.ok) {
        return refused();
      }
      const event = parsed.value;
      const rootId = generatedRoot(event.coroutineId);
      if (rootId === undefined) {
        continue;
      }
      const root = coroutine(record.conversation, rootId);
      const site = coroutine(record.conversation, event.coroutineId);
      if (event.type === "close") {
        site.closed = true;
        site.asking = undefined;
        continue;
      }
      const index = site.index++;
      if (event.coroutineId === rootId && index === 0) {
        root.admission = event;
      }
      const intent = site.asking;
      site.asking = undefined;
      if (intent?.elicit === undefined || event.description.type !== "elicit") {
        continue;
      }
      const source =
        root.admission === undefined
          ? undefined
          : readGeneratedRootAdmission(root.admission, intent.response);
      const key = controlSlot(intent.conversation, intent.response, intent.order);
      if (
        root.closed ||
        site.closed ||
        source === undefined ||
        outcomes.has(key) ||
        !matchesQuestion(event, intent, source)
      ) {
        return refused();
      }
      if (event.result.status === "cancelled") {
        continue;
      }
      const result = event.result;
      const observed = result.status === "ok" ? readElicitationAnswer(event, index) : undefined;
      if (observed !== undefined && !observed.ok) {
        return observed;
      }
      outcomes.set(key, {
        intent,
        at,
        outcome: {
          kind: "control-outcome",
          conversation: intent.conversation,
          response: intent.response,
          order: intent.order,
          outcome: result.status === "ok" ? { status: "ok" } : result,
          ...(observed === undefined ? {} : { observed: observed.value }),
        },
      });
    }
  }
  return Ok(outcomes);
}

function matchesQuestion(event: Yield, intent: ControlRecord, source: string): boolean {
  const ref = intent.elicit;
  const position = event.description[SOURCE_POSITION_FIELD];
  if (
    ref === undefined ||
    event.description.name !== ref.name ||
    event.description.input !== ref.fingerprint ||
    position === null ||
    typeof position !== "object" ||
    Array.isArray(position) ||
    Object.keys(position).length !== 4 ||
    position.generatedSource !== intent.response ||
    typeof position.offset !== "number" ||
    !Number.isSafeInteger(position.offset) ||
    position.offset < 0 ||
    typeof position.line !== "number" ||
    typeof position.column !== "number"
  ) {
    return false;
  }
  const { offset, line, column } = position;
  const prefix = source.slice(0, offset);
  return (
    /^<Elicit(?=[\s>])/.test(source.slice(offset)) &&
    line === prefix.split("\n").length &&
    column === offset - prefix.lastIndexOf("\n") &&
    ref.name === elicitationEffectName({ offset, line, column })
  );
}
