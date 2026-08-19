/**
 * Associating one document execution with a workflow run.
 *
 * `workflowInstallation({ base })` is a value, not an installation act. It
 * creates no workflow run: a run comes into being when a document execution
 * reaches its first durable operation, which resolves the base once, records
 * one immutable value, and only then lets the root document be imported.
 *
 * A journal can be in three states, and two of them are held to the run.
 *
 * - **Live** — no record yet. The installation's `prepare` hook allocates the
 *   run id, resolves `${base}^{commit}` through `Git.revParse()`, and records
 *   the value — inside the durable root, before any public document policy and
 *   before the root is imported.
 * - **Truncated** — the record is there but the root never closed. The durable
 *   operation replays the stored value, so neither the identifier nor Git is
 *   reached a second time, and the journal cursor still advances past its own
 *   entry.
 * - **Completed** — the root `Close` is recorded, and `durableRun` returns the
 *   stored result without entering the durable body at all, so preparation is
 *   never reached and the admission is what restores the run.
 *
 * `retainedWorkflowInstallation(run)` is the same three states under a run that already
 * exists. A workflow host has created the storage record before anything
 * executes, so the live path records exactly the value it was given rather than
 * allocating an id and resolving a base, and every state requires the journal to
 * agree with that value in full.
 *
 * ## Where identity is decided
 *
 * In no middleware at all. `ReplayGuard` is composable policy — a handler
 * installed further out may decline to call `next` — and so is `Execution`: a
 * handler registered at the same position can rebuild the options a later one
 * produced, stream included. A journal held to its run from either place would
 * be held to it by registration order.
 *
 * So this is an *installation* the trusted host hands to `executeInstalled()`,
 * and core owns the read. The admission is captured before any installation,
 * middleware or document code exists, and applied inside the same trusted
 * `readAll` that already holds a resumed run to its recorded root selection. That read happens before any middleware runs, on the retained
 * snapshot every later phase consumes — ahead of public guard policy, of any
 * retained Yield reaching execution, of a retained `Close` being reused, of
 * authored work, and of any append. Public `ReplayGuard` handlers still observe
 * and may still reject the history this admits; none of them can widen it.
 *
 * The two installations differ in what they require, not in how strictly it is
 * enforced. See `RunHistoryRules`: a base that would not resolve is recorded as
 * a failed effect (§6), so a programmatic run replays that failure rather than
 * demanding a successful record it never wrote.
 *
 * All of it is operation-scoped. The value is installed in the scope that owns
 * the document execution, so every descendant of the expansion reads it, the
 * output emitted after the durable run still sees it, and ordinary teardown
 * takes it away. Nothing lives at module scope.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import { createDurableOperation, ephemeral } from "@executablemd/durable-streams";
import type {
  DurableEvent,
  EffectDescription,
  Json,
  Workflow,
} from "@executablemd/durable-streams";
import type { ExecutionInstallation, JournalAdmission } from "@executablemd/core/host";
import { revParse } from "./git.ts";
import { rememberRetainedGitHostIdentities } from "./git-host/identities.ts";
import {
  admitWorkflowRunHistory,
  baseMismatch,
  describeWorkflowRun,
  malformedRecord,
  readWorkflowRun,
  retainedRunMismatch,
} from "./journal.ts";
import type { RunHistoryRules, WorkflowRun } from "./journal.ts";

export type { WorkflowRun } from "./journal.ts";

/**
 * Where the workflow run of the document execution running now is kept.
 *
 * A stable, namespaced name and a plain value: another loaded copy of this
 * package reads the same binding through its own descriptor and finds the same
 * frozen run under `run`. By the same property a descendant may bind this name
 * for its own descendants, and anyone holding the slot may write to it — which
 * is why durable enforcement never depends on it. What holds the run to its
 * journal is the admission and the durable record, neither of which this is
 * reachable from.
 */
const CurrentWorkflowRun: Context<RunSlot | undefined> = createContext<RunSlot | undefined>(
  "executablemd.workflow.run",
  undefined,
);

/**
 * Where the run of one document execution is kept while it is running.
 *
 * A slot rather than the value itself, because the two places that decide the
 * run are on the wrong side of the scope that reads it. Retained-history
 * admission runs inside canonical core's own journal read, and preparation runs
 * inside the durable root; a context *set* from either would end with the
 * operation that set it, while the document that has to read it starts
 * afterwards. So the installation puts an empty slot in the execution's scope
 * before either of them runs, and they fill it.
 *
 * The slot is created per installed execution and reclaimed with it. Nothing
 * lives at module scope, and one execution cannot see another's.
 */
interface RunSlot {
  run?: WorkflowRun;
}

/** The frozen run of the current document execution; throws outside one. */
export function* getWorkflowRun(): Operation<WorkflowRun> {
  const slot = yield* CurrentWorkflowRun.get();
  const run = slot?.run;
  if (run === undefined) {
    throw new Error(
      "getWorkflowRun() is available only inside a document execution associated with a " +
        "workflow run. Pass workflowInstallation({ base }) to executeInstalled().",
    );
  }
  return run;
}

/**
 * How one installation decides what the run is, and what the journal is held to.
 *
 * Two hosts need different answers to both questions. A programmatic caller
 * supplies a base and lets the first live execution allocate an id and resolve
 * that base, so the only thing a record can disagree about is the base it was
 * made from. A workflow host has already created the storage record, so the run
 * is not the execution's to allocate: it arrives whole, and a journal that
 * records a different one is not this run's journal.
 */
interface RunPreparation extends RunHistoryRules {
  readonly base: string;
  /** The run this execution is of, reached only when nothing is recorded yet. */
  allocate(): Operation<WorkflowRun>;
}

/** Append the run to the journal, and answer with what the journal holds. */
function* record(description: EffectDescription, preparation: RunPreparation): Workflow<unknown> {
  return yield createDurableOperation(description, function* (): Operation<Json> {
    // Reached only when nothing is recorded yet: a replay hands the stored
    // value back without running this at all, so neither the identifier nor Git
    // is reached a second time.
    const { runId, base, pinnedCommit } = yield* preparation.allocate();
    return { runId, base, pinnedCommit };
  });
}

function allocating(base: string): RunPreparation {
  return {
    base,
    // A base that would not resolve is recorded as a failed effect (§6), and a
    // history whose only record is that failure is this run's own. Requiring a
    // successful one would retry Git instead of replaying what happened.
    required: false,
    *allocate(): Operation<WorkflowRun> {
      const pinnedCommit = yield* revParse(`${base}^{commit}`);
      // Web Crypto rather than `node:crypto`: a run id is allocated in shared
      // code, which names no host.
      return { runId: crypto.randomUUID(), base, pinnedCommit };
    },
    /**
     * The description carries the base for a reader; divergence detection
     * compares only type and name, so the base this run supplied is checked
     * against the stored *value* rather than against the entry's identity.
     */
    agree(recorded: WorkflowRun): WorkflowRun {
      if (recorded.base !== base) {
        throw baseMismatch(recorded.base, base);
      }
      return recorded;
    },
  };
}

function retaining(run: WorkflowRun): RunPreparation {
  return {
    base: run.base,
    // The host created this run before anything executed, so a history of its
    // own is something it must have: none, or one that only failed, means the
    // recorded work is not this run's.
    required: true,
    // deno-lint-ignore require-yield
    *allocate(): Operation<WorkflowRun> {
      return run;
    },
    agree(recorded: WorkflowRun): WorkflowRun {
      const differing = (["runId", "base", "pinnedCommit"] as const).filter(
        (field) => recorded[field] !== run[field],
      );
      if (differing.length > 0) {
        throw retainedRunMismatch(differing);
      }
      return recorded;
    },
  };
}

/**
 * Read one member set off a value a host supplied, or answer that it refused.
 *
 * One read, nothing else inside — the same narrowness the journal's own reads
 * are held to, for the same reason.
 */
function readingRetainedValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Read the record this run is held to, refusing anything that is not it. */
function held(stored: unknown, preparation: RunPreparation): WorkflowRun {
  const run = readWorkflowRun(stored);
  if (run === undefined) {
    throw malformedRecord();
  }
  return preparation.agree(run);
}

function same(left: WorkflowRun, right: WorkflowRun): boolean {
  return (
    left.runId === right.runId &&
    left.base === right.base &&
    left.pinnedCommit === right.pinnedCommit
  );
}

/**
 * Bring the run into being, inside the durable root.
 *
 * Canonical core invokes this after retained-history admission and before any
 * public `Execution.document` policy, the root import, and every authored
 * effect — so the run exists before anything can observe it, and nothing a
 * handler does can prevent it, replace it, or reach the journal ahead of it.
 *
 * A `Workflow` because what it does is journaled. On a live run the durable
 * operation allocates and resolves once and records the value; on a partial
 * continuation the same operation restores what it already recorded, so
 * neither the identifier nor Git is reached a second time; on a completed
 * terminal replay core never enters the durable body at all, so this does not
 * run and the admission is what installs the recorded run.
 */
function* prepare(preparation: RunPreparation): Workflow<void> {
  const description = describeWorkflowRun(preparation.base);
  // Which run this is, and whether the journal agrees, are decided by the
  // captured `preparation` and the durable record — never by what the slot
  // happens to hold.
  const run = held(yield* record(description, preparation), preparation);
  const slot = yield* ephemeral(CurrentWorkflowRun.get());
  if (slot === undefined) {
    return;
  }
  const restored = slot.run;
  // A resumed journal already put this value in the slot when it was admitted;
  // keeping that object is what makes every read in one execution the same one.
  if (restored !== undefined && same(restored, run)) {
    return;
  }
  slot.run = run;
}

/**
 * What this installation requires of the history a document execution replays.
 *
 * Contributed to core rather than wrapped around core. The comparison runs
 * inside the execution's own trusted journal read, on the retained snapshot
 * every later phase consumes — so no `ReplayGuard` handler that declines to
 * delegate, and no `Execution` handler that rebuilds the options a later one
 * produced, can suppress, replace or reorder it. By the time any middleware
 * runs, the read has already happened.
 *
 * Publishing the run here is not incidental: a completed journal never enters
 * the durable body, so preparation does not run and this is the only place
 * inside the execution where the run a recorded result belongs to is known.
 */
function admits(preparation: RunPreparation): JournalAdmission {
  return function* (retained: readonly DurableEvent[]): Operation<void> {
    // What the history is held to is decided by the captured `preparation`, and
    // by nothing that is read here. The slot is reached only afterwards, to
    // publish what was already admitted.
    const admitted = admitWorkflowRunHistory(retained, preparation);
    if (admitted === undefined) {
      return;
    }
    // The one place both halves are in hand: the run canonical core just
    // admitted, and the snapshot it admitted it from. A Git-host effect at a
    // position this history already holds a record at is named by the identity
    // that record holds, and this is where that association is established —
    // out of reach of every name a document could bind.
    rememberRetainedGitHostIdentities(admitted, retained);
    yield* publish(admitted);
  };
}

/**
 * Put the run where this execution's readers will find it.
 *
 * The slot is looked up rather than closed over, because the one that matters
 * is the one `install()` made for *this* invocation. Nothing is read back out
 * of it to decide anything: publication is the whole purpose, and a slot that
 * is somehow absent means this run is unreadable, never that it is undecided.
 */
function* publish(run: WorkflowRun): Operation<void> {
  const slot = yield* CurrentWorkflowRun.get();
  if (slot === undefined) {
    return;
  }
  slot.run = run;
}

/**
 * What a trusted host attaches to one execution to make it this run's.
 *
 * An installation rather than something installed into an ambient scope: the
 * admission is a value the host hands to `executeInstalled()`, so canonical
 * core captures it before any middleware or document code exists, and a second
 * loaded copy of this package composes by handing over its own closure rather
 * than by agreeing on a name.
 */
function installation(preparation: RunPreparation): ExecutionInstallation {
  return {
    admissions: [admits(preparation)],
    prepare: () => prepare(preparation),
    *install(): Operation<void> {
      // A fresh slot per invocation, not per installation value. `install()`
      // runs once for each execution this value is passed to, so a host that
      // holds one installation and runs two documents with it gets two slots,
      // and neither execution can see the other's run. Closing over a slot
      // built alongside the value would have shared it between them.
      yield* CurrentWorkflowRun.set({});
    },
  };
}

/**
 * The installation that associates one document execution with a workflow run.
 *
 * Constructing it creates nothing. Executing a document under it does.
 *
 * ```ts
 * yield* executeInstalled(options, [workflowInstallation({ base: "main" })]);
 * ```
 */
export function workflowInstallation(options: { base: string }): ExecutionInstallation {
  return installation(allocating(options.base));
}

/**
 * Associate the document execution this scope owns with a run that already
 * exists.
 *
 * A workflow host creates the run's storage record before it executes anything,
 * so by the time a document runs there is nothing left to allocate or resolve:
 * the run id is the one storage answered with, and the pinned commit is the one
 * the definition was established from. This installation records exactly that
 * value and requires a journal to agree with it in every field, so a resumed
 * execution can never continue under a run the storage record does not describe.
 *
 * Git is not consulted, and no identifier is generated.
 */
export function retainedWorkflowInstallation(run: WorkflowRun): ExecutionInstallation {
  return installation(retaining(retainedRun(run)));
}

/**
 * The retained run as a frozen value of its own.
 *
 * Parsed rather than believed: it arrives from a storage record a host read
 * back, so a member that is missing or empty is a value that identifies no run
 * rather than one to install and discover later. The three members are named
 * here, so a host handing over a wider record installs the run it describes
 * rather than being refused for carrying its own bookkeeping.
 */
function retainedRun(run: WorkflowRun): WorkflowRun {
  // Named through the same total read as a journal value: a host that hands
  // over a record whose members refuse to be read has supplied a value that
  // identifies no run, which is the sentence below rather than its exception.
  const parsed = readWorkflowRun(
    readingRetainedValue(() => ({
      runId: run?.runId,
      base: run?.base,
      pinnedCommit: run?.pinnedCommit,
    })),
  );
  if (parsed === undefined || parsed.runId === "" || parsed.base === "") {
    throw new Error(
      "retainedWorkflowInstallation() needs the retained run's id, base and pinned commit. A run " +
        "installed without them identifies no workflow run.",
    );
  }
  if (parsed.pinnedCommit === "") {
    throw new Error(
      "retainedWorkflowInstallation() needs the retained run's pinned commit: an empty one pins the " +
        "run to no repository state at all.",
    );
  }
  return parsed;
}
