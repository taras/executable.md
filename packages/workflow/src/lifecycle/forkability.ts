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
import { GIT_HOST_EFFECT } from "../git-host/effect-type.ts";
import { parseGitHostReconciliationRecord } from "../git-host/records.ts";
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
 * Read through the same total parse the reconciliation itself uses. A failed
 * Git-host effect retains no record — its outcome is the durable operation's
 * failed result — so there is nothing there a fork could continue from.
 */
function carriesCompletedGitHostRecord(event: DurableEvent): boolean {
  try {
    if (event.type !== "yield" || event.result.status !== "ok") {
      return false;
    }
    return parseGitHostReconciliationRecord(event.result.value) !== undefined;
  } catch {
    return false;
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
