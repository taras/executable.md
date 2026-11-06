import { Err, Ok } from "effection";
import type { Result } from "effection";
import { AGENT_PROMPT, parsePromptRecord } from "@executablemd/core/host";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { SidekickRecord } from "./history.ts";
import type { SidekickRequest } from "./model.ts";
import type { RecoveryDecisionRecord, RecoveryReferenceRecord } from "./recovery-record.ts";

export interface HumanStopFact {
  readonly at: number;
  readonly conversation: string;
  readonly requests: readonly number[];
  readonly controls: readonly { readonly response: string; readonly order: number }[];
}

export interface RecoveryDisposition {
  readonly decision: RecoveryDecisionRecord;
  readonly used: boolean;
  readonly withdrawn: boolean;
  readonly offer: RecoveryReferenceRecord | undefined;
  readonly acknowledged: boolean;
}

function completed(
  records: readonly SidekickRecord[],
  request: SidekickRequest,
  until: number,
): boolean {
  const beginning = records[request.at];
  for (const record of records.slice(
    request.at + 1,
    beginning?.kind === "feedback" ? records.length : until,
  )) {
    if (record.kind !== "event" || record.conversation !== request.conversation) {
      continue;
    }
    const parsed = parseDurableEvent(record.event);
    if (
      !parsed.ok ||
      parsed.value.type !== "yield" ||
      parsed.value.description.type !== AGENT_PROMPT ||
      parsed.value.result.status !== "ok"
    ) {
      continue;
    }
    const prompt = parsePromptRecord(parsed.value.result.value);
    if (beginning?.kind === "feedback" && parsed.value.description.input !== beginning.text) {
      continue;
    }
    return prompt?.status === "completed";
  }
  return false;
}

export function uncertainRequests(
  records: readonly SidekickRecord[],
  requests: readonly SidekickRequest[],
  conversation: string,
): readonly number[] {
  const bound = new Set(
    records.flatMap((one) => (one.kind === "recovery-decision" ? [one.message] : [])),
  );
  const selected = requests.filter((one) => one.conversation === conversation);
  return selected.flatMap((one, index) => {
    const record = records[one.at];
    if (one.kind === "message" && (record?.kind !== "message" || !bound.has(record.id))) {
      return [];
    }
    return completed(records, one, selected[index + 1]?.at ?? records.length) ? [] : [one.at];
  });
}

export function projectRecovery(
  records: readonly SidekickRecord[],
  requests: readonly SidekickRequest[],
): Result<readonly RecoveryDisposition[]> {
  const facts = recoveryFacts(records, requests);
  return facts.ok ? Ok(facts.value.dispositions) : facts;
}

export function recoveryFacts(
  records: readonly SidekickRecord[],
  requests: readonly SidekickRequest[],
): Result<{
  readonly dispositions: readonly RecoveryDisposition[];
  readonly stops: readonly HumanStopFact[];
}> {
  const decisions = new Map<string, RecoveryDisposition>();
  const stops: HumanStopFact[] = [];
  const messages = new Set<string>();
  const retired = new Set<number>();
  function refused(): Result<never> {
    return Err(
      new Error(
        "this recovery history has inconsistent decision, request or reference associations.",
      ),
    );
  }
  function open(index: number, conversation: string): readonly number[] {
    return uncertainRequests(
      records.slice(0, index),
      requests.filter((one) => one.at < index),
      conversation,
    ).filter((at) => !retired.has(at));
  }
  function unfinished(index: number, conversation: string) {
    const prefix = records.slice(0, index);
    const previouslyRetired = new Set(
      [...decisions.values()]
        .filter((one) => one.used)
        .flatMap((one) =>
          one.decision.controls.map((control) => `${control.response}\0${control.order}`),
        ),
    );
    return prefix.flatMap((one) =>
      one.kind === "control" &&
      one.conversation === conversation &&
      !previouslyRetired.has(`${one.response}\0${one.order}`) &&
      !prefix.some(
        (outcome) =>
          outcome.kind === "control-outcome" &&
          outcome.conversation === one.conversation &&
          outcome.response === one.response &&
          outcome.order === one.order,
      )
        ? [{ response: one.response, order: one.order }]
        : [],
    );
  }
  for (const [index, record] of records.entries()) {
    if (record.kind === "human-stop") {
      if (
        record.retained.records !== index ||
        JSON.stringify(open(index, record.conversation)) !== JSON.stringify(record.requests) ||
        JSON.stringify(unfinished(index, record.conversation)) !==
          JSON.stringify(record.controls) ||
        !record.requests.some((at) => records[at]?.kind === "feedback")
      ) {
        return refused();
      }
      stops.push({
        at: index,
        conversation: record.conversation,
        requests: record.requests,
        controls: record.controls,
      });
    } else if (record.kind === "recovery-decision") {
      if (
        decisions.has(record.id) ||
        messages.has(record.message) ||
        record.retained.records !== index ||
        JSON.stringify(open(index, record.conversation)) !== JSON.stringify(record.requests)
      ) {
        return refused();
      }
      const controls = new Set<string>();
      if (
        JSON.stringify(unfinished(index, record.conversation)) !== JSON.stringify(record.controls)
      ) {
        return refused();
      }
      for (const control of record.controls) {
        const key = `${control.response}\0${control.order}`;
        if (
          controls.has(key) ||
          !records
            .slice(0, index)
            .some(
              (one) =>
                one.kind === "control" &&
                one.conversation === record.conversation &&
                one.response === control.response &&
                one.order === control.order,
            )
        ) {
          return refused();
        }
        controls.add(key);
      }
      decisions.set(record.id, {
        decision: record,
        used: false,
        withdrawn: false,
        offer: undefined,
        acknowledged: false,
      });
      messages.add(record.message);
      for (const at of record.requests) {
        retired.add(at);
      }
    } else if (record.kind === "conversation" && record.phase === "failed") {
      for (const [id, held] of decisions) {
        if (
          !held.used &&
          held.decision.action === "replace" &&
          held.decision.target === record.conversation
        ) {
          decisions.set(id, { ...held, withdrawn: true });
          for (const at of held.decision.requests) {
            retired.delete(at);
          }
        }
      }
    } else if (record.kind === "message") {
      const held = [...decisions.values()].find((one) => one.decision.message === record.id);
      if (held === undefined) {
        continue;
      }
      if (
        held.used ||
        held.withdrawn ||
        record.conversation !== held.decision.target ||
        record.origin.kind !== "ui" ||
        record.text !== held.decision.text
      ) {
        return refused();
      }
      decisions.set(held.decision.id, { ...held, used: true });
    } else if (record.kind === "recovery-reference") {
      const held = decisions.get(record.decision);
      if (
        held === undefined ||
        held.withdrawn ||
        held.decision.action !== "replace" ||
        held.decision.conversation !== record.previous ||
        held.decision.target !== record.next ||
        record.conversation !== record.previous ||
        held.used
      ) {
        return refused();
      }
      if (record.phase === "offered") {
        if (
          held.offer !== undefined ||
          [...decisions.values()].some((one) => one.offer?.sessionId === record.sessionId)
        ) {
          return refused();
        }
        decisions.set(record.decision, { ...held, offer: record });
      } else {
        if (held.acknowledged || held.offer?.sessionId !== record.sessionId) {
          return refused();
        }
        decisions.set(record.decision, { ...held, acknowledged: true });
      }
    }
  }
  return Ok({ dispositions: [...decisions.values()], stops });
}

export function recoveryBlocked(
  records: readonly SidekickRecord[],
  requests: readonly SidekickRequest[],
  dispositions: readonly RecoveryDisposition[],
  conversation: string,
  permission?: string,
): boolean {
  const retired = new Set(
    dispositions
      .filter((one) => one.used || (!one.withdrawn && one.decision.id === permission))
      .flatMap((one) => one.decision.requests),
  );
  if (
    dispositions.some(
      (one) =>
        !one.used &&
        !one.withdrawn &&
        (one.decision.conversation === conversation || one.decision.target === conversation) &&
        one.decision.id !== permission,
    )
  ) {
    return true;
  }
  return uncertainRequests(records, requests, conversation).some((at) => !retired.has(at));
}
