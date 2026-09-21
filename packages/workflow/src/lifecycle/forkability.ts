/**
 * Whether a run's history can be continued as somebody else's.
 *
 * A fork inherits a journal prefix and replays it under a new identity. That
 * only works while every retained event in the prefix means the same thing to
 * the fork as it did to the source: a recorded value the fork can consume, and
 * a Workspace root the fork can be given. An Agent turn whose provider session
 * the fork cannot enter, and a retained effect this build has never heard of,
 * are events a fork would have to pretend it understood.
 *
 * ## An external effect is judged by its record, not by its type
 *
 * A Git-host effect reaches a service no local transaction encloses, but what
 * decides forkability is what the history *holds* about it. A completed
 * reconciliation record carries the pre-state, the observations, the decision
 * and the result, and replays without installing or contacting a provider at
 * all — so a fork consumes it, mutates nothing, and continues. A Git-host event
 * that did not settle into such a record is the other case: the run stopped
 * without establishing what happened at the remote, and continuing across it
 * would mean asking a provider the question the source could not answer.
 *
 * Forkability is therefore cumulative rather than per-event. `--at` selects a
 * prefix, so a blocker introduced anywhere in that prefix blocks every later
 * checkpoint too, and each blocker names the earliest event that introduced it.
 *
 * ## Recognition is an allowlist
 *
 * A retained effect type is forkable because it is named here, never because it
 * failed to match something. A build that meets an effect a later build wrote
 * reports `unsupported-effect` rather than inheriting a record whose meaning it
 * is guessing at.
 *
 * ## What a blocker may say
 *
 * A stable code and an event id. Nothing else: the retained description, the
 * filtered result, the run's props and whatever a provider said about a
 * session are history this classification reads and never republishes.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { WORKFLOW_RUN } from "../journal.ts";
import { SUSPENSION_ANSWER } from "../suspension/answer.ts";
import { SUSPENSION_REQUEST } from "../suspension/suspend.ts";

/**
 * Why a checkpoint cannot be forked.
 *
 * Four categories, and they are the public vocabulary: a caller reads a code,
 * not a sentence this build happened to compose.
 */
export type ForkBlockerCode =
  | "workspace-root-unavailable"
  | "agent-state-unavailable"
  | "external-state-unavailable"
  | "unsupported-effect";

/** One reason, and the earliest event that introduced it. */
export interface ForkBlocker {
  readonly code: ForkBlockerCode;
  readonly eventId: string;
}

/** Whether a checkpoint at one event can be forked, and why not when it cannot. */
export interface Forkability {
  readonly forkable: boolean;
  /** Empty exactly when `forkable` is true. */
  readonly blockers: readonly ForkBlocker[];
}

/**
 * Effect types a fork can inherit.
 *
 * Each one records a value the fork replays and a Workspace root the fork is
 * given. None of them names state living outside the run's own database.
 */
const INHERITABLE_EFFECTS: ReadonlySet<string> = new Set([
  WORKFLOW_RUN,
  SUSPENSION_REQUEST,
  SUSPENSION_ANSWER,
  // Core's own durable operations. Named as the durable record names them,
  // because that is what a retained row holds — a build reading history a
  // different build wrote has only these strings to go on.
  "import_component",
  "eval",
  "exec",
  "fetch",
  // A pull-request evidence read, for the same reason `fetch` is here: it
  // changed nothing at the host, and what the record holds is the normalized
  // collection itself. A fork consumes it and asks the provider nothing.
  "pull_request_read",
  "elicit",
  "loop",
  "loop_iteration",
  // The Workspace effects the local provider records. Every one of them is
  // content inside this run's database, and a retained root carries it.
  "workspace_file",
  "workspace_repository",
  "workspace_worktree",
  "workspace_git_switch",
  "workspace_git_add",
  "workspace_git_commit",
]);

/**
 * Whether a retained Git-host event carries a completed reconciliation record.
 *
 * A failed Git-host effect retains no record — its outcome is the durable
 * operation's failed result — so there is nothing there a fork could continue
 * from. What a completed one carries is a decision, and that member is the
 * whole of what this classification needs.
 *
 * Read as compatibility data rather than through the feature's own parser. The
 * effect belongs to `@executablemd/git` now, and this module classifies
 * retained history without importing what wrote it. A record that will not
 * read as completed is classified `external-state-unavailable`, which is the
 * conservative answer and the one the total parse also gave.
 */
function carriesCompletedGitHostRecord(event: DurableEvent): boolean {
  try {
    if (event.type !== "yield" || event.result.status !== "ok") {
      return false;
    }
    const record = exactly(event.result.value, RECORD_MEMBERS);
    if (record === undefined) {
      return false;
    }
    const decision = record["decision"];
    if (decision !== "adopted" && decision !== "performed") {
      return false;
    }
    const request = exactly(record["request"], REQUEST_MEMBERS);
    if (request === undefined) {
      return false;
    }
    const identity = exactly(request["identity"], IDENTITY_MEMBERS);
    if (
      identity === undefined ||
      !text(identity["runId"]) ||
      !text(identity["expansionId"]) ||
      !text(request["kind"])
    ) {
      return false;
    }
    // Every remaining member is a JSON value the record claims to hold, and a
    // value this cannot read is a record this build cannot classify. Read in
    // full rather than sampled: a sparse array, a cycle, a non-finite number,
    // an `undefined` or anything else JSON cannot express is the difference
    // between a completed reconciliation and something that resembles one.
    return (
      readsAsJson(request["inputs"]) &&
      readsAsJson(request["naturalKey"]) &&
      readsAsJson(record["preState"]) &&
      readsAsJson(record["observations"]) &&
      readsAsJson(record["result"])
    );
  } catch {
    return false;
  }
}

/** The members a completed reconciliation record declares, and no others. */
const RECORD_MEMBERS: readonly string[] = [
  "request",
  "preState",
  "observations",
  "decision",
  "result",
];

const REQUEST_MEMBERS: readonly string[] = ["identity", "kind", "inputs", "naturalKey"];

const IDENTITY_MEMBERS: readonly string[] = ["runId", "expansionId"];

function text(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

/**
 * One retained object, when it declares exactly these members.
 *
 * Exactly, because a member the shape does not declare describes something
 * else and a fork does not guess at it. A record that is nearly one is still
 * not one, and is classified `external-state-unavailable` like any other
 * Git-host event this history cannot read a completion from.
 *
 * Guarded throughout: classification, enumeration and every read are the
 * value's to refuse, and a refusal of any of them is the same answer. A getter
 * somebody else wrote throws here rather than deciding forkability.
 */
function exactly(value: unknown, members: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const keys = Object.keys(value);
    if (
      keys.length !== members.length ||
      !members.every((member) => Object.hasOwn(value, member))
    ) {
      return undefined;
    }
    const read: Record<string, unknown> = Object.create(null);
    for (const member of members) {
      read[member] = Reflect.get(value, member);
    }
    return read;
  } catch {
    return undefined;
  }
}

/**
 * Whether this value is one JSON can express, all the way down.
 *
 * The same total reading the feature's own parser performs, expressed here
 * because this module classifies retained history without importing what wrote
 * it. It answers rather than detaching: what forkability needs is whether the
 * record can be read, not a copy of it.
 */
function readsAsJson(value: unknown, ancestors: Set<object> = new Set<object>()): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        // A hole is not a member. `[1, , 3]` reads its middle element as
        // `undefined`, which JSON cannot express and this must not invent.
        if (!Object.hasOwn(value, index) || !readsAsJson(Reflect.get(value, index), ancestors)) {
          return false;
        }
      }
      return true;
    }
    for (const key of Object.keys(value)) {
      if (!readsAsJson(Reflect.get(value, key), ancestors)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * The Agent turn a fork would have to re-enter.
 *
 * Conversation state belongs to the provider's session, and no supported
 * provider can hand a fork the same session at the same turn. Substituting a
 * new session would give the fork a transcript the source never had.
 */
const AGENT_EFFECT = "agent_prompt";

/**
 * The effect that reaches a Git host, as the durable record names it.
 *
 * Written out for the same reason every string in the allowlist above is: what
 * a retained row holds is this text, and a build classifying history a
 * different build wrote has only the text to go on. The effect belongs to
 * `@executablemd/git`; recognizing its retained rows is this module's own
 * compatibility obligation and not a dependency on that package.
 */
const GIT_HOST_EFFECT = "git_host_effect";

/** One retained event, as forkability reads it. */
export interface ForkabilityCandidate {
  readonly eventId: string;
  readonly event: DurableEvent;
  readonly workspaceRootId: string;
}

/** What the classification needs to know about the run's retained state. */
export interface ForkabilityContext {
  /** Every Workspace root the run still retains. */
  readonly retainedRoots: ReadonlySet<string>;
}

/**
 * Forkability at each event, in the order the events were retained.
 *
 * One entry per candidate, so a caller can read the answer for the exact
 * checkpoint it is considering without recomputing the prefix.
 */
export function classifyForkability(
  candidates: readonly ForkabilityCandidate[],
  context: ForkabilityContext,
): readonly Forkability[] {
  const accumulated: ForkBlocker[] = [];
  const introduced = new Set<ForkBlockerCode>();

  return Object.freeze(
    candidates.map((candidate) => {
      for (const code of blockersOf(candidate, context)) {
        if (introduced.has(code)) {
          continue;
        }
        introduced.add(code);
        accumulated.push(Object.freeze({ code, eventId: candidate.eventId }));
      }
      return Object.freeze({
        forkable: accumulated.length === 0,
        blockers: Object.freeze([...accumulated]),
      });
    }),
  );
}

/**
 * What this one event introduces, before anything before it is taken into
 * account.
 *
 * A Close ends a coroutine and records no effect of its own, so it can only
 * name a root the run no longer holds.
 */
function blockersOf(
  candidate: ForkabilityCandidate,
  context: ForkabilityContext,
): readonly ForkBlockerCode[] {
  const codes: ForkBlockerCode[] = [];
  if (!context.retainedRoots.has(candidate.workspaceRootId)) {
    codes.push("workspace-root-unavailable");
  }
  const { event } = candidate;
  if (event.type !== "yield") {
    return codes;
  }
  const type = event.description.type;
  if (type === AGENT_EFFECT) {
    codes.push("agent-state-unavailable");
    return codes;
  }
  if (type === GIT_HOST_EFFECT) {
    if (!carriesCompletedGitHostRecord(event)) {
      codes.push("external-state-unavailable");
    }
    return codes;
  }
  if (!INHERITABLE_EFFECTS.has(type)) {
    codes.push("unsupported-effect");
  }
  return codes;
}
