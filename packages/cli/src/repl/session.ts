/**
 * One execution, running or reconstructed, and what the application reads.
 *
 * Both directions arrive here. A **fresh** session submits one entry into an
 * empty history; a **cold** one opens a history somebody else wrote and reaches
 * the same place through ordinary replay. They share this module because they
 * are the same thing: a retained stream, an execution over it, and a model
 * reprojected from what that stream now holds.
 *
 * ## The entry is admitted once, or not at all
 *
 * Submitted text is a draft until the root `import_component` record appends.
 * So a submission validates the document first, against the same environment
 * the run would use, and a document that cannot run leaves the history as it was
 * and the draft editable — rather than admitting an entry whose only history is
 * its own failure. After admission that entry is immutable.
 *
 * ## One session, one entry task, in turn
 *
 * A session owns the one physical stream, installs its one observer on it, and
 * owns **at most one** entry task. Starting another entry needs two separate
 * facts: the entry before it has a retained terminal close, and that entry's own
 * task has finished tearing down and been joined. Observing a terminal outcome
 * is not the second of those — an execution whose root has closed is still
 * releasing providers, middleware and held permissions — so a submission that
 * arrives in between is refused rather than queued. There is no queue: a refused
 * submission starts nothing, appends nothing and leaves what was proposed with
 * whoever proposed it.
 *
 * Settled entries are read, never re-run. Replay is for exactly one thing: the
 * final segment of a history that never finished, resumed through a view of
 * that segment alone. A new entry starts at the physical end with the root
 * bindings every earlier entry durably published, derived from the live head of
 * the file rather than from this process's memory or from whatever prefix
 * somebody is inspecting.
 *
 * ## Cold opening commits nothing until everything succeeded
 *
 * Parsing the file, projecting the requested prefix and admitting the replay all
 * have to succeed before this hands back a session. Until then the execution
 * runs in a scope the caller can drop: a divergence, a stale answer or a
 * malformed record comes back as a refusal, and the application mounts that
 * instead of a half-reconstructed view. Nothing was appended and no provider was
 * called, because replay contacts neither until it is past what was retained.
 *
 * Admission is the first thing that proves replay got past the retained prefix:
 * the execution settling, the first new record reaching the file, or the first
 * question reaching this process. Before any of those, a divergence class is a
 * refusal; after them, a failure is an outcome the transcript shows.
 *
 * ## The model is the truth and the overlay says so
 *
 * A component never sees an event, a stream or a running execution. It sees a
 * frozen `ReplModel` plus an `ReplOverlay` that is explicitly this process's
 * own: text the document has emitted but the Journal has not settled, the
 * question waiting right now, what expansion is doing, and an unadmitted draft.
 * When the root closes, the recorded output replaces the overlay's, because at
 * that point the Journal knows and this process is merely remembering.
 */

import {
  Err,
  Ok,
  createScope,
  createSignal,
  ensure,
  scoped,
  spawn,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream, Task } from "effection";
import { INLINE_SOURCE_PATH, inlineSource, validateDocument } from "@executablemd/core";
import type { DocumentValidationDiagnostic, Json, PermissionMode } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type {
  ExecutionDeclaration,
  ExecutionInstallation,
  IdentityComponent,
} from "@executablemd/core/host";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  EarlyReturnDivergenceError,
  MalformedDurableEventError,
  StaleInputError,
  TerminalDivergenceError,
} from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { useReplAgent } from "./agent.ts";
import { filter } from "@effectionx/stream-helpers";
import { consumeAdmissions } from "./admission.ts";
import type { ReplAgentAuthority, ReplAgentReading } from "./agent.ts";
import { useReplElicitation } from "./elicitation.ts";
import { useReplLifecycle } from "./lifecycle.ts";
import type { ReplLifecycleReading } from "./lifecycle.ts";
import type { ReplElicitations, ReplQuestion } from "./elicitation.ts";
import { EntrySegmentStream, entryKey, partitionEntrySegments } from "./entries.ts";
import { useExpansionController } from "./expansion.ts";
import type { ExpansionController, ExpansionState } from "./expansion.ts";
import type { ReplExecution } from "./journal.ts";
import { entryInitialBindings, projectRepl } from "./model.ts";
import type { ReplEntry, ReplModel } from "./model.ts";

/** A submitted entry this environment cannot run, refused before it is admitted. */
export class ReplPreflightError extends Error {
  readonly diagnostics: readonly DocumentValidationDiagnostic[];

  constructor(diagnostics: readonly DocumentValidationDiagnostic[]) {
    const first = diagnostics[0];
    super(
      first === undefined
        ? "this entry cannot run here."
        : `this entry cannot run here: ${first.message}`,
    );
    this.name = "ReplPreflightError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/** A history this process cannot continue, refused before anything is shown. */
export class ReplReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplReconstructionError";
  }
}

/**
 * A submission this session cannot start, refused having started nothing.
 *
 * Separate from a preflight refusal, which is about the document, and from a
 * reconstruction refusal, which is about the history: this one is about *when*.
 * The same text is submittable once the entry before it has settled and its task
 * has been joined.
 */
export class ReplLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplLifecycleError";
    markLifecycleRefusal(this, message);
  }
}

/**
 * The mark itself.
 *
 * Stable and namespaced, because it is read across loaded copies. Changing this
 * string is changing a cross-copy contract.
 */
const LIFECYCLE_REFUSAL = "executablemd.cli.repl.lifecycleRefusal";

/**
 * State that this failure is the execution's readiness refusing a submission,
 * and answer with it.
 *
 * ## Why a mark rather than a class or a name
 *
 * What reads this is the screen, deciding whether a refusal it is already showing
 * has stopped being true. Three refusals reach that decision and only this one
 * goes stale: readiness refuses a *moment*, while a document that cannot be
 * admitted and a form that does not validate are refusals of the thing itself and
 * stay true however the execution moves on. Dropping one of those would take away
 * the only explanation of why somebody's draft is still sitting there.
 *
 * `instanceof` cannot make that distinction safely, because a separately loaded
 * copy of this module has its own class and the check silently answers no. The
 * `name` cannot either, in the other direction: it is an ordinary writable
 * property, so any error at all can carry this one and be mistaken for a refusal
 * the session never gave. A namespaced own-property survives the boundary and is
 * only there because a throw site put it there.
 *
 * Non-enumerable, so an error that is copied, wrapped or serialized does not take
 * the mark along by accident — a wrapper meaning to pass the classification on
 * marks its own.
 */
export function markLifecycleRefusal<E extends Error>(error: E, reason: string): E {
  if (Object.getOwnPropertyDescriptor(error, LIFECYCLE_REFUSAL) === undefined) {
    Object.defineProperty(error, LIFECYCLE_REFUSAL, { value: reason, enumerable: false });
  }
  return error;
}

/**
 * The reason this failure carries, when it is readiness refusing a submission.
 *
 * Answers `undefined` for everything else: an unmarked error, an ordinary one
 * merely *named* `ReplLifecycleError`, a mark it only inherits from a prototype
 * it was created with, and a mark whose payload is not a non-empty string. Reads
 * an own property descriptor rather than the property, so an inherited value is
 * never read at all.
 */
export function lifecycleRefusal(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const held = Object.getOwnPropertyDescriptor(error, LIFECYCLE_REFUSAL)?.value;
  return typeof held === "string" && held.length > 0 ? held : undefined;
}

/** What this process knows that the Journal does not. */
export interface ReplOverlay {
  /** Text the document emitted that no recorded outcome has replaced. */
  readonly output: string;
  /** The question waiting right now, or none. */
  readonly question: ReplQuestion | undefined;
  /** What expansion is doing. */
  readonly expansion: ExpansionState;
  /** Text typed and not yet admitted as an entry. */
  readonly draft: string | undefined;
}

/**
 * What expansion is doing, for a view that only needs to say so.
 *
 * Separate from the controller because reading the state and *changing* it are
 * different authorities: every surface may show that expansion is paused, and
 * only the process holding the continuations may release them.
 */
export interface ExpansionView {
  readonly state: ExpansionState;
  readonly states: Stream<ExpansionState, never>;
}

/** One execution as the application reads it. */
export interface ReplSession {
  /** The opaque identifier this execution's history is named by. */
  readonly execution: string;
  /** The frozen model of the projected prefix, as it stands. */
  readonly model: ReplModel;
  /** Everything about this process that the model deliberately does not hold. */
  readonly overlay: ReplOverlay;
  /** What expansion is doing. Always readable, never actionable. */
  readonly expansion: ExpansionView;
  /**
   * The controller that owns this process's expansion, or none.
   *
   * Absent — not a controller whose Continue does nothing — whenever there is
   * no live expansion to continue: a settled history that replay restored
   * whole, an execution with no entry yet, or a run that has already finished.
   * Pause and Continue are the capability of the exact process holding the
   * continuations, so a session that holds none offers neither.
   */
  readonly controller: ExpansionController | undefined;
  readonly elicitation: ReplElicitations;
  /**
   * What this process knows about Agent turns the Journal has not settled.
   *
   * Empty for an idle execution, a full replay and a document with no Agent
   * work — a live reading describes work this process is doing, and replay does
   * none.
   */
  readonly agent: ReplAgentReading;
  /** Every change to that reading, as it changes. */
  readonly agentChanges: Stream<ReplAgentReading, never>;
  /**
   * Settling a pending permission request.
   *
   * Separate from reading one, so a surface that draws requests does not
   * thereby hold the capability that answers them.
   */
  readonly permissions: ReplAgentAuthority;
  /** Whether an entry's execution is still running in this process. */
  readonly live: boolean;
  /**
   * What this process is doing element by element, for the entry that is open.
   *
   * Ephemeral and detached, like the Agent reading beside it: a cold process
   * reconstructs none of it, and an entry that closes takes its observations
   * with it. Static syntax and a retained admission prove nothing about it —
   * what is here is what this process actually watched happen.
   */
  readonly lifecycle: ReplLifecycleReading;
  /** Every change to that reading, as it changes. */
  readonly lifecycleChanges: Stream<ReplLifecycleReading, never>;
  /** Each reprojection, as the history grows under it. */
  readonly changes: Stream<ReplModel, never>;
  /**
   * The overlay's output, each time the document adds to it.
   *
   * Separate from `changes` because plain output is precisely what the Journal
   * does not record: a document that only writes appends nothing, reprojects
   * nothing, and would otherwise be invisible to anything watching the
   * history. A reader that shows `overlay.output` has to watch this too, or it
   * shows text only when something unrelated happens to move.
   */
  readonly outputs: Stream<string, never>;
  /** Wait for the entry running in this process to finish, and answer how. */
  join(): Operation<Result<unknown>>;
  /**
   * Admit one more entry into this execution, or refuse and start nothing.
   *
   * Answers once that entry's work has reached past what the history retained —
   * its first record, its first question or its own settlement — so a caller that
   * is told `Ok` has an entry, not an intention. A refusal names why this is not
   * a moment to submit and leaves the history, the running entry and the proposed
   * source exactly as they were.
   */
  submit(source: string): Operation<Result<void>>;
}

/** What starting or reopening a session needs. */
export interface ReplSessionOptions {
  readonly execution: ReplExecution;
  /** Where components are looked for. */
  readonly includes?: readonly string[];
  /** What this host installs around the document. */
  readonly installations?: readonly ExecutionInstallation[];
  /** The history position a location selected, or none for the head. */
  readonly selection?: string;
  /**
   * How this session answers Agent permission requests.
   *
   * The REPL presents interactive requests in its own surface, so it installs
   * this policy rather than Core's readline one. Absent means `deny-all`, which
   * is what an execution with no configured mode already does.
   */
  readonly permissionMode?: PermissionMode;
}

/**
 * Submit one entry into an execution, opening the session that will own it.
 *
 * The convenience the command's first submission is made through: the session is
 * opened over whatever the file holds, and the submitted source becomes the entry
 * after the last one it admitted. A history whose final entry never settled is
 * refused, because nothing may follow an entry that has no outcome.
 */
export function submitReplEntry(
  options: ReplSessionOptions & { readonly source: string },
): Operation<Result<ReplSession>> {
  return start(options, options.source);
}

/** Reconstruct one execution from the history its file holds. */
export function openReplSession(options: ReplSessionOptions): Operation<Result<ReplSession>> {
  return start(options, undefined);
}

/** The one entry task a session owns, for as long as it owns one. */
interface ReplEntryTask {
  /** The admission-order key of the entry this task is running. */
  readonly key: string;
  readonly task: Task<void>;
  /** Resolves once this entry's work has passed what its segment retained. */
  readonly admitted: Operation<Result<void>>;
  /** Resolves with how this entry's execution finished. */
  readonly finished: Operation<Result<unknown>>;
  admit(outcome: Result<void>): void;
  settle(outcome: Result<unknown>): void;
}

function* start(
  options: ReplSessionOptions,
  submitted: string | undefined,
): Operation<Result<ReplSession>> {
  const { execution, includes, installations = [], selection, permissionMode } = options;
  const stream = execution.stream;

  const events = yield* stream.readAll();
  const projection = projectRepl(events, selection);
  if (!projection.ok) {
    return projection;
  }
  let model = projection.value;

  // The live head as well as the selected prefix. Which entries exist, which one
  // is unfinished and what a successor inherits are facts about the file, and a
  // reader standing at a historical position has changed none of them.
  const atHead = selection === undefined ? projection : projectRepl(events);
  if (!atHead.ok) {
    return atHead;
  }
  const head = atHead.value;

  // The ranges the file holds, which is what a segment view is cut from. The
  // projection above already refused a prefix whose ranges are not ranges, so
  // this agrees with it or nothing does.
  const partitioned = partitionEntrySegments(events);
  if (!partitioned.ok) {
    return partitioned;
  }
  const segments = partitioned.value;

  for (const entry of head.entries) {
    if (entry.path !== INLINE_SOURCE_PATH) {
      return Err(
        new ReplReconstructionError(
          "this history was written by something other than the REPL: its entry came from a file " +
            "rather than from submitted text.",
        ),
      );
    }
  }

  const last = head.entries[head.entries.length - 1];
  if (submitted !== undefined && last !== undefined && !last.settled) {
    return Err(
      new ReplLifecycleError(
        `this execution's ${last.key} has not settled, so nothing can follow it. An entry ends ` +
          "with its own outcome.",
      ),
    );
  }

  /** The one unfinished final entry this session resumes, and its range. */
  const finalSegment = segments[segments.length - 1];
  const resumed =
    submitted === undefined && last !== undefined && !last.settled && finalSegment !== undefined
      ? { entry: last, segment: finalSegment }
      : undefined;

  if (submitted !== undefined) {
    const validated = yield* preflight(submitted, includes, installations);
    if (!validated.ok) {
      return validated;
    }
  }

  const changes = createSignal<ReplModel, never>();
  const outputs = createSignal<string, never>();
  const opening = withResolvers<Result<ReplSession>>();
  let answered = false;

  /**
   * Everything this session owns lives here, and nothing outside it does.
   *
   * A cold open is provisional until replay is admitted, so the observer it
   * installs and the tasks it starts have to be droppable as one thing. Built
   * as a child of the caller's scope, so an accepted session is torn down with
   * its owner and a refused one is torn down here, before the refusal is
   * returned — a refused reconstruction that left a live observer behind would
   * keep reprojecting into a session nobody was ever given.
   */
  const [provisional, dispose] = createScope(yield* useScope());

  function refuse(error: Error): void {
    if (!answered) {
      answered = true;
      opening.resolve(Err(error));
    }
  }

  provisional.run(function* () {
    // Created before anything can start an entry, and owned by this session:
    // its consumers outlive every element's dispatch, which is the only place
    // a terminal observation can reach them.
    const lifecycle = yield* useReplLifecycle();
    const expansion = yield* useExpansionController(lifecycle);
    const elicitation = yield* useReplElicitation(lifecycle);
    // Created here and installed into each entry's execution below, so the
    // middleware it owns belongs to this session's scope and dies with it. An
    // execution elsewhere would otherwise inherit an observer watching for a
    // session that is gone.
    const agent = yield* useReplAgent(permissionMode ?? "deny-all");
    // The scope every entry task is started in. One session, one owner: a task
    // started anywhere else would outlive the observer and the kernels it
    // reports through.
    const owner = yield* useScope();

    /** Text the entry that is running has printed, which no record holds yet. */
    let output = "";
    /** Whether an entry's execution is still running in this process. */
    let live = false;
    /** The one entry task this session owns, or none. */
    let running: ReplEntryTask | undefined;
    /** Whether this session still starts entry tasks. */
    let admitting = true;
    /** How the last entry to finish finished. */
    let finished: Result<unknown> | undefined;

    function reproject(): void {
      const next = projectRepl(retained, selection);
      if (!next.ok) {
        // A history this process wrote and can no longer read is a refusal,
        // not a stale view: the alternative is a screen that keeps describing
        // a prefix while the file has moved past it.
        refuse(next.error);
        return;
      }
      model = next.value;
      changes.send(model);
    }

    const session: ReplSession = {
      execution: execution.id,
      get model() {
        return model;
      },
      get overlay(): ReplOverlay {
        return {
          // The recorded outcome wins the moment there is one: after the root
          // closes, what this process happens to remember is no longer the
          // authority on what the document rendered.
          output: model.terminal?.output ?? output,
          question: elicitation.pending,
          expansion: expansion.state,
          draft: undefined,
        };
      },
      expansion,
      get controller(): ExpansionController | undefined {
        // The capability, not a disabled copy of it: once nothing is expanding
        // there is no continuation for Continue to release, and offering one
        // would be offering an action that cannot act.
        return live ? expansion : undefined;
      },
      elicitation,
      get agent() {
        return agent.reading;
      },
      agentChanges: agent.changes,
      permissions: agent.authority,
      get live() {
        return live;
      },
      get lifecycle() {
        return lifecycle.reading();
      },
      lifecycleChanges: lifecycle.changes,
      changes,
      outputs,
      join(): Operation<Result<unknown>> {
        return joining();
      },
      submit(source: string): Operation<Result<void>> {
        return submitting(source);
      },
    };

    function open(): void {
      if (!answered) {
        answered = true;
        opening.resolve(Ok(session));
      }
    }

    /**
     * Whichever entry is running has reached past what its segment retained.
     *
     * The same fact admits the session and answers the submission that started
     * the entry: both are waiting to hear that replay got beyond the records
     * that were already there.
     */
    function reached(): void {
      running?.admit(Ok(undefined));
      open();
    }

    function* joining(): Operation<Result<unknown>> {
      const held = running;
      if (held === undefined) {
        return finished ?? Ok(undefined);
      }
      const outcome = yield* held.finished;
      // The outcome and then the join, because they are two different moments:
      // an execution whose root has closed is still releasing its providers, its
      // middleware and anything it was holding. Halting a task that has already
      // produced its outcome cancels nothing and waits for exactly that
      // teardown, which is what a caller told "this entry is finished" needs.
      yield* held.task.halt();
      return outcome;
    }

    /**
     * The live head a submission would follow, or why there is no following it.
     *
     * Three separate refusals, because they are three different situations a
     * person is in: this session is ending, this session's entry is still
     * running, or the history's last entry never produced an outcome. None of
     * them is a queue — each leaves the proposed source with whoever proposed it.
     */
    function admissible(): Result<ReplModel> {
      if (!admitting) {
        return Err(
          new ReplLifecycleError("this session is ending, so it starts no further entry."),
        );
      }
      if (running !== undefined) {
        return Err(
          new ReplLifecycleError(
            `this execution's ${running.key} has not finished, so there is nothing to submit into ` +
              "yet. One entry runs at a time, and the next one starts after this one has ended.",
          ),
        );
      }
      const prefix = projectRepl(retained);
      if (!prefix.ok) {
        return prefix;
      }
      const latest = prefix.value.entries[prefix.value.entries.length - 1];
      if (latest !== undefined && !latest.settled) {
        return Err(
          new ReplLifecycleError(
            `this execution's ${latest.key} has not settled, so nothing can follow it.`,
          ),
        );
      }
      return prefix;
    }

    function* submitting(source: string): Operation<Result<void>> {
      const before = admissible();
      if (!before.ok) {
        return before;
      }
      const validated = yield* preflight(source, includes, installations);
      if (!validated.ok) {
        return validated;
      }
      // Asked again, because validating suspended. What a submission needs to be
      // true is true at the moment the task starts, not at the moment somebody
      // pressed a key — a session that began tearing down in between starts
      // nothing.
      const after = admissible();
      if (!after.ok) {
        return after;
      }
      const started = begin(
        entryKey(after.value.entries.length + 1),
        source,
        new EntrySegmentStream(stream),
        // From the live head of the file, and from nothing else: not from what
        // this process remembers of the entry that just ran, and not from the
        // prefix somebody happens to be inspecting.
        entryInitialBindings(after.value),
      );
      return yield* started.admitted;
    }

    /**
     * Start one entry's task, and own it until it has torn down and joined.
     *
     * The occupancy is taken here, synchronously, before anything suspends: a
     * second submission arriving in the same turn finds this session occupied
     * rather than starting beside it.
     */
    function begin(
      key: string,
      source: string,
      view: EntrySegmentStream,
      initialBindings: Readonly<Record<string, Json>>,
    ): ReplEntryTask {
      const admission = withResolvers<Result<void>>();
      const completion = withResolvers<Result<unknown>>();
      let admitted = false;
      let settled = false;
      function admit(outcome: Result<void>): void {
        if (!admitted) {
          admitted = true;
          admission.resolve(outcome);
        }
      }
      function settle(outcome: Result<unknown>): void {
        if (!settled) {
          settled = true;
          finished = outcome;
          completion.resolve(outcome);
        }
      }
      // This entry's own overlay, from here: what the entry before it printed is
      // not what this one has printed, and the Journal holds that one's anyway.
      output = "";
      live = true;
      lifecycle.open(key);
      const task = owner.run(function* () {
        // Registered before anything this task acquires, and therefore released
        // after all of it: destructors run in reverse order of registration. By
        // the time this runs the execution has been torn down, every provider,
        // held permission and piece of middleware it installed is gone, and this
        // entry's Agent attachment has discarded whatever it never transferred.
        // That is what makes the next entry's start a start rather than an
        // overlap.
        //
        // And released only for an entry that reached an outcome of its own. A
        // task halted — by this session's teardown, or by a failure that
        // withdrew its authority — leaves the slot occupied, so nothing can
        // follow an entry that was interrupted, whatever order the surrounding
        // destructors happen to run in.
        yield* ensure(() => {
          if (running?.task === task && settled) {
            running = undefined;
          }
        });
        // Registered here, so it runs after everything this entry acquired has
        // been released: the execution and its providers, the output consumer
        // and the Agent attachment all come down first, and only then does the
        // session say it is no longer live. The two readings that describe
        // work in flight go with it, because by now there is none.
        yield* ensure(() => {
          live = false;
          lifecycle.close(key);
          // Said on the ordinary path, because nothing else will: an entry
          // that appended no record and took no input still stopped running,
          // and a reader waiting for that is waiting for this.
          changes.send(model);
        });
        const outcome = yield* runEntry(key, source, view, initialBindings);
        settle(outcome);
        // A settled entry is past whatever its segment retained, whichever way
        // it settled — including a failure that appended nothing at all, which
        // is still an answer to the submission that asked for it.
        admit(outcome.ok ? Ok(undefined) : Err(outcome.error));
      });
      const started: ReplEntryTask = {
        key,
        task,
        admitted: admission.operation,
        finished: completion.operation,
        admit,
        settle,
      };
      running = started;
      return started;
    }

    function* runEntry(
      key: string,
      source: string,
      view: EntrySegmentStream,
      initialBindings: Readonly<Record<string, Json>>,
    ): Operation<Result<unknown>> {
      try {
        // This entry's Agent attachment, acquired here and nowhere else. It is a
        // resource, so everything it holds — live turns, pending requests, the
        // places they took, the handles that correlate them — has this task's
        // lifetime. Acquired *after* the release finalizer above and *before* the
        // execution below, which is what orders teardown: the execution and its
        // provider work come down first, then this attachment discards whatever it
        // never transferred, and only then is the session's entry slot freed.
        const installation = yield* agent.owning(key);
        const started = yield* executeInstalled(
          {
            ...inlineSource(source),
            // This entry's own range of the one physical stream. An execution
            // handed the file would replay another entry's records as its own,
            // because a root import and a coroutine id mean the same thing in
            // every entry.
            stream: view,
            ...(includes === undefined ? {} : { includes: [...includes] }),
          },
          // Installed into this exact execution, and nowhere else: the live
          // observer and the permission policy are this session's, not the
          // process's, and the attachment carries the entry whose turns they are.
          [...installations, lifecycle.installation, installation],
          { initialBindings },
        );
        // Consumed as it arrives, inside this session's scope. Collecting until
        // the stream closed would leave the overlay empty for the whole of the
        // run and fill it in at the end, which is the opposite of what an
        // overlay is for: what it shows is what the document has rendered
        // *so far*.
        yield* spawn(function* () {
          const chunks = yield* started.output;
          let next = yield* chunks.next();
          while (!next.done) {
            output += next.value;
            // Announced, not merely accumulated: nothing else will say that the
            // overlay moved, because output the Journal has not settled leaves
            // no record to reproject from.
            outputs.send(output);
            next = yield* chunks.next();
          }
        });
        const outcome = yield* started;
        if (!outcome.ok && isReconstructionFailure(outcome.error)) {
          refuse(outcome.error);
          return outcome;
        }
        open();
        return outcome;
      } catch (error) {
        const raised = error instanceof Error ? error : new Error(String(error));
        if (isReconstructionFailure(raised)) {
          refuse(raised);
        } else {
          open();
        }
        return Err(raised);
      }
    }

    // The stream is the one writer, so what it acknowledges is what the file
    // holds. Reprojection reads that acknowledged array rather than
    // accumulating a second copy of the history beside it.
    const retained = yield* stream.readAll();
    const observe = (event: DurableEvent): void => {
      retained.push(event);
      // One transition, and nothing suspends inside it: the record joins the
      // history, the live overlay it completed is removed, and only then does
      // anything announce. No observable snapshot holds one turn twice, and
      // none holds it neither way.
      try {
        agent.consume(event);
      } catch {
        // A correlation failure after admission is not a stale view to carry
        // on with. The owner below is already being told; refusing here as
        // well would report one failure as two.
        return;
      }
      reproject();
      agent.announce();
      reached();
    };

    // Registered before the callback is published, and removing exactly the one
    // this session installed. The stream outlives the session that was watching
    // it — a repository hands the same stream to whoever opens the execution
    // next — so a callback left behind would reproject into, and signal, a
    // session whose scope is gone. One observer for the whole session, whatever
    // number of entries it goes on to run.
    yield* ensure(() => {
      if (stream.onAppend === observe) {
        stream.onAppend = null;
      }
    });
    stream.onAppend = observe;

    // Both subscriptions belong to this scope, and both exist before the
    // document can publish anything. `spawn()` returns before its child body
    // has run, and a Signal drops what it sends while no subscription is
    // active, so subscribing inside a watcher loses an announcement the
    // execution makes immediately — which is the announcement that admits a
    // cold session. Effection's contract is explicit that the subscription is
    // created in the enclosing scope and only iterated in the child
    // (`docs/agents.md`, "Subscription readiness across `spawn()`"). Spawning
    // the consumer earlier would not be equivalent: what must precede the
    // document is the subscription, not the task that reads it.
    // Filtered before either is subscribed, so what reaches the drain is
    // already only the announcements that admit. The composition belongs here,
    // in the scope that owns the subscription.
    const agentReadings = yield* filter(function* (reading: ReplAgentReading) {
      return reading.turns.length > 0;
    })(agent.changes);
    const questions = yield* filter(function* (question: ReplQuestion | undefined) {
      return question !== undefined;
    })(elicitation.changes);

    // A queued Agent turn is work beyond the retained prefix, exactly as a new
    // record or a question is: replay that reached one is past what the history
    // held, so the session is admitted rather than still provisional.
    yield* spawn(consumeAdmissions(agentReadings, reached));
    yield* spawn(consumeAdmissions(questions, reached));

    yield* spawn(function* () {
      const error = yield* agent.failed;
      // A journal this process can no longer reconcile is not one to add to, so
      // a session failure withdraws the authority to start anything else as well
      // as ending what was running. Halted and joined before the failure is
      // answered, in that order.
      admitting = false;
      live = false;
      open();
      const held = running;
      if (held !== undefined) {
        yield* held.task.halt();
        held.settle(Err(error));
      }
    });

    if (resumed !== undefined) {
      // Only the one segment that never finished, and only ever that one. A
      // settled range is read by the projector and handed to nobody: replaying
      // it would re-run work the file already records, and correlate one entry's
      // coroutines against another's.
      begin(
        resumed.entry.key,
        resumed.entry.source,
        new EntrySegmentStream(stream, { retained: resumed.segment.events, final: true }),
        entryInitialBindings(head, resumed.entry),
      );
    } else if (submitted !== undefined) {
      begin(
        entryKey(head.entries.length + 1),
        submitted,
        new EntrySegmentStream(stream),
        entryInitialBindings(head),
      );
    } else {
      // Nothing to run. Every entry this history holds has settled, so the
      // reading of them is the whole answer and the session opens at once.
      open();
    }

    // Registered last so that it runs first: destructors run in reverse order,
    // and a submission racing this teardown has to find the door already shut
    // rather than start a task into a scope that is going away. Only then is the
    // entry that was running halted and joined.
    yield* ensure(function* () {
      admitting = false;
      const held = running;
      if (held !== undefined) {
        yield* held.task.halt();
      }
    });

    // Held open deliberately. This body owns the observer and every task, and
    // finishing it would halt them — so it lasts as long as the scope does, and
    // the scope lasts as long as the session is wanted.
    yield* suspend();
  });

  const opened = yield* opening.operation;
  if (!opened.ok) {
    // Before the refusal is returned, not after: the caller is about to be told
    // there is no session, and everything this one started has to be gone by
    // the time it hears that.
    yield* until(dispose());
    return opened;
  }
  return opened;
}

/**
 * Whether this environment can run one submitted document at all.
 *
 * Validated against the vocabulary the execution will actually install, not
 * against the bare registry: a host that declares `<Session>` to the execution
 * would otherwise have every entry naming one refused here and run perfectly if
 * it got past. Preflight and the run answer to one environment or preflight is
 * describing a different document.
 *
 * In a scope of its own, because admitting a declaration in order to ask about
 * it mints the durable identity domain that name answers under. Leaving that
 * behind would have the execution resolve `<Session>` through preflight's
 * admission while issuing its invocations under its own.
 */
function* preflight(
  source: string,
  includes: readonly string[] | undefined,
  installations: readonly ExecutionInstallation[],
): Operation<Result<void>> {
  const validation = yield* scoped(function* () {
    return yield* validateDocument({
      ...inlineSource(source),
      includes,
      components: declaredComponents(installations),
      declarations: declaredMarkdown(installations),
    });
  });
  return validation.outcome === "invalid"
    ? Err(new ReplPreflightError(validation.diagnostics))
    : Ok(undefined);
}

/** Every identity component these installations declare, in installation order. */
function declaredComponents(
  installations: readonly ExecutionInstallation[],
): readonly IdentityComponent[] {
  // Copied, never the host's own values. Admitting a declaration mints the
  // durable identity domain its implementation answers under, and preflight
  // admits in this scope while the execution admits in its own — so handing
  // both the same object would leave the run resolving an implementation
  // minted for a domain its invocations were never issued under.
  return installations.flatMap((installation) =>
    (installation.components ?? []).map((component) => ({ ...component })),
  );
}

/** Every exact Markdown component these installations declare, in order. */
function declaredMarkdown(
  installations: readonly ExecutionInstallation[],
): readonly ExecutionDeclaration[] {
  return installations.flatMap((installation) =>
    (installation.declarations ?? []).map((declaration) => ({ ...declaration })),
  );
}

/**
 * Whether a failure means "this history cannot be continued" rather than "the
 * document failed".
 *
 * A closed list of the protocol's own refusals. A document that fails after
 * replay is past the retained prefix is an outcome the transcript shows; one of
 * these means the run never got there, and what a reader would otherwise be
 * shown is a reconstruction of something that did not happen.
 */
function isReconstructionFailure(error: Error): boolean {
  return (
    error instanceof DivergenceError ||
    error instanceof EarlyReturnDivergenceError ||
    error instanceof TerminalDivergenceError ||
    error instanceof ContinuePastCloseDivergenceError ||
    error instanceof StaleInputError ||
    error instanceof MalformedDurableEventError
  );
}
