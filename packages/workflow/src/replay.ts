/**
 * What a completed run replays on, taken from the history its owner already
 * holds.
 *
 * A completed run asked to run again does not run: canonical execution reads
 * the terminal its journal recorded and answers with it, importing nothing,
 * performing nothing and appending nothing. It still has to be *given* a root
 * document, because that value is what the retained history is held to — the
 * document a recorded import must have selected, and the one a terminal written
 * before any import is bound to.
 *
 * Locally that value came out of Git, because a checkout was there. A run whose
 * durable owner is somewhere else has no checkout at all, and fetching one for
 * a replay that imports nothing would be live retrieval performed for a document
 * nobody is going to read. So it comes from the run: the retained root import
 * holds the exact selection canonical execution made — the document's path, its
 * text and the target it resolved to — and a run that failed before importing
 * anything holds the same three in the binding core writes into its terminal.
 *
 * Either way the path is held to the definition the run record retains, and
 * that is the load-bearing half. Journal data decides nothing about which
 * document a run is a run of; it supplies only the bytes the run already
 * recorded for the document its immutable definition names.
 *
 * The bundle is the same judgment made narrower. A completed replay imports no
 * component, so it is handed no component source and no authority to resolve
 * one. What it is handed is the admission that holds every component import the
 * history recorded to the exact name, canonical path and object id the
 * definition declares — so a member the definition declares and this history
 * never imported is neither read nor fetched, and grants nothing by existing.
 *
 * Nothing here reads or writes anything. It is a decision over values, like
 * `lifecycle/policy.ts`, so both hosts reach it the same way.
 */

import { Err, Ok, type Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import { retainedSource } from "@executablemd/core/host";
import type { ExecutionInstallation, RetainedRootDocument } from "@executablemd/core/host";
import { workflowBundleReplayInstallation } from "./bundle.ts";
import { retainedWorkflowInstallation } from "./run.ts";
import {
  agreesWithRetainedResult,
  rootOutcome,
  terminal,
  terminalFrontier,
} from "./lifecycle/policy.ts";
import type { JournalEntry } from "./storage/api.ts";
import type { WorkflowRunRecord } from "./storage/record.ts";

/** The root import a run's own entry is recorded under. */
const ROOT = "__root__";

const IMPORT_COMPONENT = "import_component";

/** Where core writes the document a terminal it created before importing was about. */
const ROOT_BINDING = "root_binding";

/** What a completed run hands canonical execution, and nothing else. */
export interface RetainedReplay {
  /** The root document, exactly as this run's own history recorded it. */
  readonly root: RetainedRootDocument;
  /** The run contract and the bundle admission this replay is held to. */
  readonly installations: readonly ExecutionInstallation[];
}

/**
 * Retained state that describes no completed run.
 *
 * Fixed diagnostics throughout, and deliberately so: what is being refused is
 * journal and lifecycle data, and a refusal that quoted a path, a source or a
 * recorded value would publish exactly what it exists to reject.
 */
export class WorkflowReplayHistoryError extends Error {
  override name = "WorkflowReplayHistoryError";
}

const REFUSALS = Object.freeze({
  live: "this run's retained state is not terminal, so it replays nothing.",
  absent:
    "this run is retained as ended and its history records no document result, so there is " +
    "nothing for a replay to restore. The run is left exactly as it is.",
  mixed:
    "this run's history continues past the document result it records, so the two describe " +
    "different moments of the run. The run is left exactly as it is.",
  ambiguous:
    "this run's history records more than one root document import, so no single one " +
    "describes what it ran. The run is left exactly as it is.",
  malformed:
    "this run's retained root document cannot be read by this version. The run is left " +
    "exactly as it is.",
  document:
    "this run's retained root document is not the document its definition names. The run is " +
    "left exactly as it is.",
  disagreed:
    "this run's retained state and its recorded document result describe different outcomes, " +
    "so neither is the one to replay. The run is left exactly as it is.",
  damaged:
    "this run's recorded document result cannot be read by this version, so there is no " +
    "outcome to restore. The run is left exactly as it is.",
});

function refuse(reason: string): Result<never> {
  return Err(new WorkflowReplayHistoryError(reason));
}

/**
 * Read one journal-controlled value, or answer that reading it refused.
 *
 * As narrow as the reads a retained import is parsed through, and for the same
 * reason: a throwing accessor and a proxy trap both mean this record does not
 * describe a replay, and nothing wider should be swallowed.
 */
function reading<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A recorded value that is an ordinary object, or nothing. */
function recorded(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const names = reading(() => Object.keys(value));
  if (names === undefined) {
    return undefined;
  }
  const held: Record<string, unknown> = {};
  for (const name of names) {
    const member = reading(() => Reflect.get(value, name));
    if (member === undefined) {
      return undefined;
    }
    held[name] = member;
  }
  return held;
}

/** Whether a retained event is recognizably a settled component import. */
function importedName(event: DurableEvent): string | undefined {
  if (reading(() => event.type) !== "yield") {
    return undefined;
  }
  const description = reading(() => (event.type === "yield" ? event.description : undefined));
  if (description === undefined || reading(() => description.type) !== IMPORT_COMPONENT) {
    return undefined;
  }
  const name = reading(() => description.name);
  return typeof name === "string" ? name : undefined;
}

/** The document one retained selection names, as a root source is built from it. */
interface RetainedRoot {
  readonly path: string;
  readonly content: string;
  readonly target: string | undefined;
}

/**
 * The selection a settled root import recorded.
 *
 * Only the shapes canonical execution writes for a root: the whole document,
 * one exact target, and a selector the document offered no single target for.
 * A settlement that failed recorded no selection at all, and is refused by the
 * caller rather than guessed at.
 */
function rootSelection(event: DurableEvent): RetainedRoot | undefined {
  const settlement = recorded(reading(() => (event.type === "yield" ? event.result : undefined)));
  if (settlement === undefined || settlement["status"] !== "ok") {
    return undefined;
  }
  const selection = recorded(settlement["value"]);
  if (selection === undefined) {
    return undefined;
  }
  const path = selection["path"];
  const content = selection["content"];
  const kind = selection["kind"];
  const members = Object.keys(selection).length;
  if (typeof path !== "string" || typeof content !== "string") {
    return undefined;
  }

  if (kind === "repository") {
    const target = selection["target"];
    if (target === undefined) {
      return members === 3 ? { path, content, target: undefined } : undefined;
    }
    return members === 4 && typeof target === "string" ? { path, content, target } : undefined;
  }

  if (kind === "target-failure") {
    // The selector as the run was asked for it. Handing it back is what makes
    // the replayed request the same request: canonical execution resolves it
    // against the recorded document again and finds the same failure.
    const failure = recorded(selection["failure"]);
    const selector = failure?.["selector"];
    return members === 4 && typeof selector === "string"
      ? { path, content, target: selector }
      : undefined;
  }

  return undefined;
}

/**
 * The document a terminal written before any import was about.
 *
 * A run can fail before it imports anything, and canonical core records which
 * document that failure was about inside the terminal itself. That binding is
 * the only account such a history has of its own root, so it is what a replay
 * of one is built from.
 */
function boundRoot(close: DurableEvent): RetainedRoot | undefined {
  const settlement = recorded(reading(() => close.result));
  if (settlement === undefined || settlement["status"] !== "ok") {
    return undefined;
  }
  const result = recorded(settlement["value"]);
  const binding = recorded(result?.[ROOT_BINDING]);
  if (binding === undefined || Object.keys(binding).length !== 3) {
    return undefined;
  }
  const path = binding["path"];
  const source = binding["source"];
  const target = binding["target"];
  if (typeof path !== "string" || typeof source !== "string") {
    return undefined;
  }
  if (target !== null && typeof target !== "string") {
    return undefined;
  }
  return { path, content: source, target: target ?? undefined };
}

/**
 * What this run's owner already holds, as the inputs one canonical replay runs
 * on — or why the state it holds describes no completed run.
 *
 * Every refusal here happens before an attachment, a provider, a materialized
 * root or a native operation: the caller has read one coherent frontier and has
 * done nothing else with it.
 */
export function retainedReplay(
  record: WorkflowRunRecord,
  entries: readonly JournalEntry[],
): Result<RetainedReplay> {
  if (!terminal(record.status)) {
    return refuse(REFUSALS.live);
  }

  // The terminal is the frontier, and there is one of it. A history holding a
  // second result, or continuing past the one it stands behind, is one whose
  // lifecycle row and journal describe different moments of the run — and
  // reconciling those is not a replay's to do. The same reading decides it for
  // stale recovery, so neither can accept what the other refuses; what this
  // adds is only which way it refused.
  const frontier = terminalFrontier(entries);
  if (frontier.kind === "absent") {
    return refuse(REFUSALS.absent);
  }
  if (frontier.kind === "mixed") {
    return refuse(REFUSALS.mixed);
  }
  const close = frontier.entry;

  // What the root recorded, read once, by the lifecycle's own judgment: the
  // same one stale recovery publishes through and the same one a settlement
  // is held to. A second copy of it here would be a second authority.
  //
  // A terminal this build cannot read is refused before canonical core is
  // handed it, because core's rejection would arrive as *this* invocation's
  // document failure and be offered as a replacement outcome.
  const canonical = rootOutcome(entries);
  if (canonical === undefined || canonical.kind === "damaged") {
    return refuse(REFUSALS.damaged);
  }
  if (!agreesWithRetainedResult(record, canonical)) {
    return refuse(REFUSALS.disagreed);
  }

  const imports = entries.filter((entry) => importedName(entry.event) === ROOT);
  if (imports.length > 1) {
    return refuse(REFUSALS.ambiguous);
  }

  const imported = imports[0];
  const retained = imported === undefined ? boundRoot(close.event) : rootSelection(imported.event);
  if (retained === undefined) {
    return refuse(REFUSALS.malformed);
  }
  if (retained.path !== record.definition.rootDocumentPath) {
    return refuse(REFUSALS.document);
  }

  const { path, content, target } = retained;
  return Ok({
    root:
      target === undefined
        ? retainedSource(path, content)
        : retainedSource(path, content, { target }),
    installations: [
      retainedWorkflowInstallation({
        runId: record.runId,
        base: record.base,
        pinnedCommit: record.definition.objectId,
      }),
      workflowBundleReplayInstallation(record.definition),
    ],
  });
}
