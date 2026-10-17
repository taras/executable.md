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
import type { GeneratedSelection } from "@executablemd/core/api";
import { executeInstalled, recordedRootBindingPublicationMode } from "@executablemd/core/host";
import { useGeneratedFallback } from "../evaluation-profile.ts";
import type {
  ExecutionDeclaration,
  ExecutionInstallation,
  IdentityComponent,
  RootBindingPublicationMode,
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
import { canonicalJson } from "@executablemd/workflow";
import type { ReplEntryInstallation } from "../repl-entry-installation.ts";

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
import { headOf, navigationOf, NO_NAVIGATION } from "./navigation.ts";
import type { ReplHeadState, ReplHistoryNavigation, ReplNavigationPoint } from "./navigation.ts";
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
/**
 * The retention every newly admitted entry runs under.
 *
 * One mode and one spelling, stated here because this is the host that keeps a
 * journal across executions: an entry is one of several over one file, so what
 * it captures at its root is what the entry after it may start from.
 */
const ROOT_BINDING_PUBLICATIONS: RootBindingPublicationMode = "json-v1";

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

/**
 * One coherent reading of this history at one position.
 *
 * Both halves from the same acknowledged array: the content the position
 * asks for, and the whole file's positions beside it. Handed over together
 * so a caller cannot pair one of them with a snapshot the other never saw —
 * which is what happens when a frame reads the content, suspends to measure
 * the terminal, and then reads the navigation again.
 */
/**
 * The entry running in this process, and what it has printed so far.
 *
 * Separate from {@link ReplOverlay} because the overlay is a *view*: it answers
 * at the position this session was opened at, and a recorded outcome at that
 * position wins over anything this process remembers. That is right for a
 * screen and wrong for a caller that has to say which entry printed what — a
 * session opened at a historical location would otherwise report an earlier
 * entry's retained text as the output of the entry running now.
 *
 * Absent whenever nothing is running, which is also what makes a running
 * entry's text attributable: the key is the task's own, not a position in a
 * list, so nothing is credited to an entry that merely happens to be last.
 */
export interface ReplPrinting {
  /** The entry this text belongs to, by its admission-order key. */
  readonly entry: string;
  /** Everything it has printed so far, buffering respected. */
  readonly output: string;
}

export interface ReplReading {
  /** The model of the requested prefix. */
  readonly model: ReplModel;
  /** Every position the whole file retained, and what the head is doing. */
  readonly navigation: ReplHistoryNavigation;
}

/**
 * The two projections one position needs, from one array.
 *
 * Held together as a single `Result` rather than as optional fields beside an
 * optional error: the pair either exists or the file could not be read, and a
 * shape that can hold neither asks every reader to assert that it does.
 */
interface ReplProjections {
  /** The whole validated file, which answers navigation and the head. */
  readonly whole: ReplModel;
  /** The requested position, which answers everything else. */
  readonly prefix: ReplModel;
}

/**
 * Project both readings of one acknowledged array.
 *
 * The prefix is the whole file when no position is asked for, so the common
 * case projects once.
 */
function project(
  snapshot: readonly DurableEvent[],
  at: string | undefined,
): Result<ReplProjections> {
  const whole = projectRepl(snapshot);
  if (!whole.ok) {
    return whole;
  }
  if (at === undefined) {
    return Ok({ whole: whole.value, prefix: whole.value });
  }
  const prefix = projectRepl(snapshot, at);
  return prefix.ok ? Ok({ whole: whole.value, prefix: prefix.value }) : prefix;
}

/** One execution as the application reads it. */
export interface ReplSession {
  /** The opaque identifier this execution's history is named by. */
  readonly execution: string;
  /** The frozen model of the projected prefix, as it stands. */
  readonly model: ReplModel;
  /**
   * Every position the whole history retained, and what the head is doing.
   *
   * The one reading not taken at the selected prefix. A reader standing at an
   * earlier position is owed the whole rail — the positions after theirs are
   * where they can go next — and nothing of what those positions hold. It
   * carries a marker and a kind, and no payload of any sort.
   */
  readonly navigation: ReplHistoryNavigation;
  /**
   * Both readings at one position, from one acknowledged array.
   *
   * What the root asks for every time it builds a frame. A later record this
   * process can no longer read refuses the whole reading — including for a
   * position earlier than the record — because stale navigation standing
   * beside a prefix that still looks plausible is the worst of both.
   */
  reading(at: string | undefined): Result<ReplReading>;
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
   * The entry running in this process and what it has printed, or none.
   *
   * The process's own fact rather than the screen's reading of it. See
   * {@link ReplPrinting} for why the overlay is not this.
   */
  readonly printing: ReplPrinting | undefined;
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
   * Whether this session will take an entry at all, right now.
   *
   * The same three refusals a submission would get — ending, an entry already
   * running, an unsettled last entry — asked without proposing anything. It
   * exists because a caller that has to write something down *before* it
   * submits cannot learn this from the submission: by then the record is on
   * disk, recording an attempt that was refused on terms the caller could have
   * asked about first.
   *
   * Not a reservation and not a promise. It answers about this moment, and the
   * submission asks again on its own terms.
   */
  admits(): Result<void>;
  /**
   * Admit one more entry into this execution, or refuse and start nothing.
   *
   * Answers once that entry's work has reached past what the history retained —
   * its first record, its first question or its own settlement — so a caller that
   * is told `Ok` has an entry, not an intention. A refusal names why this is not
   * a moment to submit and leaves the history, the running entry and the proposed
   * source exactly as they were.
   */
  submit(
    source: string,
    pausing?: PendingPause,
    starting?: StartingCheck,
  ): Operation<Result<ReplSubmission>>;
}

/**
 * Whether the caller still wants this submission's entry held before it expands.
 *
 * A question rather than a value, and asked at the moment the entry starts
 * rather than at the moment it was submitted. Preflight suspends — a component
 * read, an import, a provider — and Pause can be pressed while it does, so a
 * flag copied at the call would be the answer to a question nobody had asked
 * yet. The caller owns the request; this is how the entry collects it.
 */
export type PendingPause = () => boolean;

/**
 * Whether the caller still wants this entry, asked as it starts.
 *
 * The session checks its own readiness before and after the preflight, and this
 * is the other half: the route a person is standing at, the revision the draft
 * is on and whether the request has been withdrawn are the screen's facts, not
 * the session's, and all three can move while a preflight suspends. A refusal
 * here starts nothing, appends nothing and is the submission's own outcome.
 */
export type StartingCheck = () => Result<void>;

/**
 * The entry one submission admitted, and that one only.
 *
 * Handed back rather than left for {@link ReplSession.join} to find, because
 * the two answer different questions. `join()` answers "is this session busy",
 * which is about whatever is running now; this answers "did the entry I
 * submitted finish", which is about one task that may well have been replaced
 * by the time anybody asks. A caller that admitted Entry 3 and waited on the
 * session would be handed Entry 4's outcome the moment Entry 3 ended and
 * another began — and a reply waiting to read what *its* entry printed would
 * read somebody else's.
 */
export interface ReplSubmission {
  /** The admission-order key of the entry this submission became. */
  readonly entry: string;
  /**
   * Wait for this entry's execution to finish and its task to join.
   *
   * Bound to the task that was started, so the answer is this entry's outcome
   * whenever it is asked for — including after the session has moved on.
   */
  join(): Operation<Result<unknown>>;
}

/** What starting or reopening a session needs. */
export interface ReplSessionOptions {
  readonly execution: ReplExecution;
  /** Where components are looked for. */
  readonly includes?: readonly string[];
  /** What this host installs around the document. */
  readonly installations?: readonly ExecutionInstallation[];
  /**
   * What a generated fragment may write in every entry this session opens,
   * unless something nearer states its own.
   *
   * Installed as ordinary Component middleware inside each entry's own
   * execution scope, because that is the scope core reads the selection in. The
   * value is the command's — a fact about the command a person invoked rather
   * than about the entry they typed — and a default rather than an answer: a
   * plugin or a host installation that states a selection is the one core
   * reads, including a defined empty one it then refuses.
   */
  readonly generated?: GeneratedSelection;
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
  /**
   * What each executing entry installs for itself.
   *
   * Called once per entry, inside that entry's own task, with the owner its
   * retained external work is named by. Absent is a session whose entries have
   * no issue host, which is every runtime that selected none.
   */
  readonly entryInstallation?: ReplEntryInstallation;
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
  /**
   * Record that the history now holds this exact entry.
   *
   * Called from the one transition that establishes it, beside {@link arm}, and
   * separate from {@link admit} because `admit` also carries a refusal: a task
   * whose admission answered `Err` admitted nothing. This is the fact that
   * decides whether an interrupted task was an *entry* being interrupted or a
   * startup that never became one.
   */
  place(): void;
  /** Whether that acknowledgement has happened. */
  placed(): boolean;
  /**
   * Take whatever hold this entry's submission is still asking for.
   *
   * Called once, at the moment the history is known to hold this exact entry,
   * and before that admission is acknowledged. The request is read here rather
   * than carried from the submission because Pause can be pressed throughout a
   * preflight and a startup that both suspend: a flag copied at the call would
   * be the answer to a question nobody had asked yet.
   */
  arm(): void;
}

function* start(
  options: ReplSessionOptions,
  submitted: string | undefined,
): Operation<Result<ReplSession>> {
  const {
    execution,
    includes,
    installations = [],
    generated,
    selection,
    permissionMode,
    entryInstallation,
  } = options;
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
  const continuing =
    submitted === undefined && last !== undefined && !last.settled && finalSegment !== undefined
      ? { entry: last, segment: finalSegment }
      : undefined;
  // The retention that entry recorded for itself, read off its own admission.
  // An entry admitted before root captures were retained says nothing here, and
  // continues saying nothing for the whole of its remaining body — which is
  // what keeps its replay aligned and leaves its completed effects alone. A
  // retention this version cannot read refuses the reconstruction rather than
  // continuing the entry under a guess.
  const recorded =
    continuing === undefined
      ? Ok(undefined)
      : recordedRootBindingPublicationMode(continuing.segment.admission.description);
  if (!recorded.ok) {
    return Err(new ReplReconstructionError(recorded.error.message));
  }
  const resumed =
    continuing === undefined ? undefined : { ...continuing, publications: recorded.value };

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
    const agent = yield* useReplAgent(permissionMode ?? "deny-all", lifecycle);
    // The scope every entry task is started in. One session, one owner: a task
    // started anywhere else would outlive the observer and the kernels it
    // reports through.
    const owner = yield* useScope();

    /** Text the entry that is running has printed, which no record holds yet. */
    let output = "";
    /** Whether an entry's execution is still running in this process. */
    let live = false;
    /**
     * Whether the entry that is running is one the acknowledged history holds.
     *
     * Separate from `live`, because the two answer different questions: `live`
     * says work is in flight, which it is from the moment a task is allocated,
     * and this says the entry that work is for has a durable position. Only the
     * second one makes a hold mean anything, so only the second one decides
     * whether the controller is offered.
     */
    let positioned = false;
    /** The one entry task this session owns, or none. */
    let running: ReplEntryTask | undefined;
    /** Whether this session still starts entry tasks. */
    let admitting = true;
    /** How the last entry to finish finished. */
    let finished: Result<unknown> | undefined;
    /**
     * Every retained position, taken at the whole file rather than at the
     * selected prefix. Rebuilt with the model, so a wake that moves one moves
     * both.
     */
    let points: readonly ReplNavigationPoint[] = NO_NAVIGATION.checkpoints;
    /** Whether the latest entry of the *whole* file has a retained outcome. */
    let outcome = false;
    /** How many entries the whole file holds. */
    let admitted = 0;
    /**
     * The last pair of projections, and the array they were taken from.
     *
     * Keyed by the length of the acknowledged array and the position asked
     * for, which together are the only things that can change what either
     * projection says. A failure is memoized too: a file this process cannot
     * read does not become readable by being asked again.
     */
    let memo:
      | {
          readonly length: number;
          readonly at: string | undefined;
          readonly projected: Result<ReplProjections>;
        }
      | undefined;

    /**
     * Rebuild both readings from one acknowledged array.
     *
     * The full file answers navigation and the head; the requested prefix
     * answers every other pane. Two projections of one immutable input, so
     * the rail and the content cannot disagree about what the file holds —
     * and the full model is dropped here rather than kept, because nothing
     * downstream may reach a later entry through it.
     *
     * A later malformed segment refuses the whole reading, including for an
     * earlier marker: the alternative is stale navigation standing beside a
     * prefix that still looks plausible.
     */
    function readingAt(at: string | undefined): Result<ReplReading> {
      // One acknowledged array answers both halves. The stream is the one
      // writer, so `retained` is what the file holds; projecting the whole of
      // it and the requested prefix from the same slice is what makes the
      // rail and the content incapable of describing different files.
      //
      // Memoized on the length of that array and the position asked for,
      // because the root asks for this reading on every wake and a wake is
      // usually an overlay moving rather than a record arriving. The head is
      // *not* memoized: pausing, resuming and the last of an entry's
      // resources being released all change it while the file stands still.
      if (memo === undefined || memo.length !== retained.length || memo.at !== at) {
        memo = { length: retained.length, at, projected: project(retained.slice(), at) };
      }
      if (!memo.projected.ok) {
        return memo.projected;
      }
      const { whole, prefix } = memo.projected.value;
      const latest = whole.entries[whole.entries.length - 1];
      return Ok({
        model: prefix,
        navigation: Object.freeze({
          checkpoints: navigationOf(whole.checkpoints, "empty").checkpoints,
          head: headNow(whole.entries.length, latest?.terminal !== undefined),
        }),
      });
    }

    /**
     * Adopt the reading at the opening selection, and announce it.
     *
     * The session's own published model, for everything that reads
     * `session.model` rather than asking for a position. The root does ask,
     * which is why this is no longer the only way a reading is built.
     */
    function reproject(): void {
      const read = readingAt(selection);
      if (!read.ok) {
        // A history this process wrote and can no longer read is a refusal,
        // not a stale view: the alternative is a screen that keeps describing
        // a prefix while the file has moved past it. Before admission that is
        // the opening's answer; after it, the root reads the same failure for
        // itself through `reading()` and shows the refused view.
        refuse(read.error);
        changes.send(model);
        return;
      }
      model = read.value.model;
      points = read.value.navigation.checkpoints;
      // The whole file's own facts, from the same projection the reading above
      // came from. Reaching for them separately would be the second snapshot
      // this whole change exists to remove.
      if (memo !== undefined && memo.projected.ok) {
        const { whole } = memo.projected.value;
        admitted = whole.entries.length;
        outcome = whole.entries[whole.entries.length - 1]?.terminal !== undefined;
      }
      changes.send(model);
    }

    /**
     * The whole file's positions, and what the head is doing *now*.
     *
     * The positions come from the last reprojection, because only an append
     * moves them. The head does not: pausing, resuming and the last of an
     * entry's resources being released all change it while the file stands
     * still. So it is derived on read, from the facts as they are, and the
     * wake that publishes it is the one the session and the controller
     * already send.
     *
     * Liveness is `live` — the entry-wide signal that stays true until every
     * resource that entry acquired has been released. A body that returned
     * and a root Close that was recorded are both earlier than that, which is
     * why neither of them is consulted here.
     */
    function navigation(): ReplHistoryNavigation {
      return Object.freeze({ checkpoints: points, head: headNow(admitted, outcome) });
    }

    /**
     * What the head is doing, from the facts as they stand.
     *
     * The one place the head is derived. Both readings ask here rather than
     * each assembling the same five facts: two derivations of one head are
     * two things to keep in step, and the owned-work fact — the entry-wide
     * signal that stays true until every resource that entry acquired has
     * been released — is exactly the one a second copy would be written
     * without.
     */
    function headNow(entries: number, settled: boolean): ReplHeadState {
      return headOf({
        entries,
        outcome: settled,
        working: live,
        paused: expansion.state === "paused",
        pausing: expansion.state === "pausing",
      });
    }

    const session: ReplSession = {
      execution: execution.id,
      get model() {
        return model;
      },
      get navigation(): ReplHistoryNavigation {
        return navigation();
      },
      reading(at: string | undefined): Result<ReplReading> {
        return readingAt(at);
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
        //
        // And only once the running entry is one the history holds. A task that
        // has been allocated is busy, not admitted: the setup import that gives
        // the entry its position is crossed before the record naming it is
        // appended, so a controller offered on the strength of `live` alone
        // would let a hold land on that import — paused expansion above an
        // entry list that says nothing was submitted, and no position to walk
        // back to. Until then the request belongs to the reservation that made
        // it, and {@link ReplEntryTask.arm} is what collects it.
        return live && positioned ? expansion : undefined;
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
      get printing(): ReplPrinting | undefined {
        // The task's own key, so the text is credited to the entry that is
        // actually producing it. `live` is what ends it: a task whose entry
        // reached an outcome is no longer printing, and what it printed is in
        // the record that outcome carries.
        return live && running !== undefined ? { entry: running.key, output } : undefined;
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
      admits(): Result<void> {
        const answer = admissible();
        return answer.ok ? Ok(undefined) : answer;
      },
      submit(
        source: string,
        pausing?: PendingPause,
        starting?: StartingCheck,
      ): Operation<Result<ReplSubmission>> {
        return submitting(source, pausing, starting);
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
      // Only an actual admission answers the submission. A record arriving is
      // not an entry existing: a startup refused before its document was
      // delegated writes that entry's settlement and never writes the record
      // admitting it, and acknowledging on the strength of *any* appended event
      // hands the caller a completion handle for an entry the history does not
      // have — and cannot have, because that history is refused. What answers
      // such a submission is the task's own failure, which carries the
      // authoritative startup error.
      //
      // Read from the projection the reprojection above just took, so the one
      // thing consulted is the same immutable reading every pane sees. A
      // refused projection names no entries at all, which is the case this is
      // about; a readable one names exactly the entries the file admitted.
      const held = running;
      if (held !== undefined && admits(held.key)) {
        // Three things in one transition, in this order, and nothing suspends
        // between them.
        //
        // The record is already persisted and the durable continuation that
        // will resume into authored expansion has not run yet — that is the
        // property this whole handoff rests on. So the entry both has a
        // position and has expanded nothing, which is the one moment a hold is
        // both meaningful and early enough to be worth asking for.
        //
        // The controller is offered first, then the request this submission is
        // still carrying is collected, and only then is the admission
        // acknowledged. Acknowledging first would hand the caller its handle
        // while the request was still unread, and the loop could clear the
        // reservation holding it before anything had asked.
        positioned = true;
        // Recorded on the task itself as well, before anything is offered or
        // acknowledged. It is what tells a cancelled *entry* from a cancelled
        // startup, and from here on this entry is the session's rather than its
        // submission's.
        held.place();
        held.arm();
        held.admit(Ok(undefined));
      }
      // Unconditional, because the session's own opening is a different
      // question: a history that cannot be read has already answered it with
      // the refusal, and this is a no-op once either answer has been given.
      open();
    }

    /**
     * Whether the whole file now holds the entry this key names.
     *
     * By key rather than by count, because a count answers "how many" and this
     * asks "is mine there". Two entries' records interleave in no legal
     * history, but an admission that counted would be answering about whichever
     * entry the file happened to hold rather than about the one that asked.
     */
    function admits(key: string): boolean {
      return (
        memo !== undefined &&
        memo.projected.ok &&
        memo.projected.value.whole.entries.some((entry) => entry.key === key)
      );
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

    /**
     * One entry's own completion, bound to the task rather than to the slot.
     *
     * The same two moments `joining()` waits for — the outcome, and then the
     * teardown that halting an already-settled task waits for — over a task
     * this closure captured. Nothing here reads `running`, which is what makes
     * it answer for this entry after the session has started another.
     */
    function submissionOf(held: ReplEntryTask): ReplSubmission {
      return {
        entry: held.key,
        *join(): Operation<Result<unknown>> {
          const outcome = yield* held.finished;
          yield* held.task.halt();
          return outcome;
        },
      };
    }

    function* submitting(
      source: string,
      pausing?: PendingPause,
      starting?: StartingCheck,
    ): Operation<Result<ReplSubmission>> {
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
      // And the caller's own terms, asked here for the same reason: validating
      // suspended, so the route, the draft and whether anybody still wants this
      // can all have moved while it did. The session cannot answer those — they
      // are the screen's — so it asks, and a refusal starts nothing.
      const wanted = starting?.() ?? Ok(undefined);
      if (!wanted.ok) {
        return wanted;
      }
      const started = begin(
        entryKey(after.value.entries.length + 1),
        source,
        new EntrySegmentStream(stream),
        // From the live head of the file, and from nothing else: not from what
        // this process remembers of the entry that just ran, and not from the
        // prefix somebody happens to be inspecting.
        entryInitialBindings(after.value),
        ROOT_BINDING_PUBLICATIONS,
        pausing,
      );
      return yield* scoped(function* (): Operation<Result<ReplSubmission>> {
        // Registered before the wait below, so it covers the whole interval in
        // which this task is allocated and its entry is not yet admitted. The
        // task is the session's — it has to be, so that an admitted entry
        // outlives the submission that asked for it — and until the admission
        // is acknowledged there is nothing for it to outlive. A caller that
        // stops wanting this in that interval would otherwise walk away from a
        // startup that goes on to admit and run an entry nobody is waiting for.
        //
        // Halting joins, so this does not return while that startup could still
        // continue behind it. Past the acknowledgement it does nothing at all:
        // the entry is the session's then, and cancelling a caller's wait is
        // not cancelling an entry.
        yield* ensure(function* () {
          if (!started.placed()) {
            yield* started.task.halt();
          }
        });
        const admission = yield* started.admitted;
        // The handle only for an entry that was actually admitted. A refusal
        // started nothing, so there is no entry to hand anybody a completion
        // for.
        return admission.ok ? Ok(submissionOf(started)) : admission;
      });
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
      /**
       * Whether this entry retains the root values its captures bind.
       *
       * A newly admitted entry retains them, because the entry after it reads
       * what the file says this one published. An entry being continued runs
       * under the retention its own admission recorded for its whole remaining
       * body, including the suffix no record describes: that admission is
       * already written, and publishing into the middle of a sequence it does
       * not mention would diverge against work the entry had already done.
       */
      publications: RootBindingPublicationMode | undefined,
      /**
       * Whether the submission that asked for this entry wants it held.
       *
       * Asked at this entry's own admission, which is the earliest moment a
       * hold means anything and still earlier than every authored effect.
       * Asking at the call would ask before anyone could have pressed Pause;
       * asking once expansion was under way would ask about a walk that had
       * already crossed its first gate.
       */
      pausing?: PendingPause,
    ): ReplEntryTask {
      const admission = withResolvers<Result<void>>();
      const completion = withResolvers<Result<unknown>>();
      let admitted = false;
      let settled = false;
      /**
       * Whether the history holds this exact entry.
       *
       * The one fact that distinguishes an entry from a startup. A task is
       * allocated before the record that gives its entry a position, and the
       * interval between the two is real: the execution installs its providers
       * and composes its envelope in it. Within that interval there is no entry
       * — nothing to wait for, nothing to follow, and nothing for a later
       * reading to find.
       */
      let placed = false;
      /** Whether this entry put the session into a stop it must undo. */
      let armed = false;
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
      /**
       * Collect the hold this submission is still asking for, if it is.
       *
       * The cleanup that undoes an arming is registered inside the task below,
       * and this cannot run before it: the earliest thing that calls it is the
       * admission of a record this entry appends, and the entry does not append
       * until its body is well past that registration. So an arming always has
       * its disarm already in place.
       *
       * Collected once, which is what makes it a request and not a mode. The
       * transition that calls this runs for every record the entry appends, and
       * the reservation it reads goes on saying what was asked for long after it
       * was given — so a second reading would re-apply a hold the person had
       * already released, and the entry would stop again at every record it
       * wrote.
       */
      let collected = false;
      function arm(): void {
        if (collected) {
          return;
        }
        collected = true;
        if (pausing?.() === true) {
          armed = true;
          expansion.pause();
        }
      }
      // This entry's own overlay, from here: what the entry before it printed is
      // not what this one has printed, and the Journal holds that one's anyway.
      output = "";
      live = true;
      // Busy, and not yet anywhere: the record that gives this entry a position
      // has not been appended, so whatever the entry before it established about
      // where the file stands says nothing about this one.
      positioned = false;
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
        // And released for an entry that reached an outcome of its own, or for a
        // task that never became an entry at all. An *entry* halted — by this
        // session's teardown, or by a failure that withdrew its authority —
        // leaves the slot occupied, because nothing may follow an entry that
        // was interrupted, whatever order the surrounding destructors happen to
        // run in. A task cancelled before its admission was acknowledged is not
        // that: it admitted nothing, the history holds nothing of it, and there
        // is no entry for anything to follow — so holding the slot against it
        // would wedge the session over work that never happened.
        yield* ensure(() => {
          if (running?.task === task && (settled || !placed)) {
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
        // Registered before the controller is armed, and therefore run before
        // the two above it: an arming that never reached a hold must not outlive
        // the entry that asked for it. A startup that fails after this point —
        // a refused document policy, a provider that will not install — leaves
        // the session-wide mode asking for a stop no walk of this entry will
        // ever reach, and the entry after it would hold at its first gate for a
        // request nobody made of it. The interval is real and not narrow: once
        // the setup import is retained this entry is admitted, and root metadata
        // and the document envelope are composed before the body expands, so a
        // refusal there fails an entry that is armed and holds nothing.
        //
        // Only while this entry is still the session's: an older entry tearing
        // down after another has started must not disarm the newer one's
        // controller. And only where this entry armed it — a hold the person
        // asked for through the live control is theirs to release.
        yield* ensure(() => {
          if (armed && running?.task === task) {
            // Disarming, not a Continue nobody asked for: by the time this runs
            // the walks below have unwound through their own holds, so there is
            // no continuation left to release and the release count of a
            // torn-down controller stays zero. What this clears is the mode.
            expansion.resume();
          }
        });
        // Nothing waits for the admission here. `arm()` is called from the
        // transition that establishes it — the append observer, which runs after
        // the record is persisted and before the durable continuation resumes —
        // so the hold is in place before any authored step can run. A task
        // scheduled to notice the admission instead would be ordered by the
        // scheduler rather than by the record, and the continuation it was
        // racing has no reason to lose.
        const outcome = yield* runEntry(key, source, view, initialBindings, publications);
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
        arm,
        place: () => {
          placed = true;
        },
        placed: () => placed,
      };
      running = started;
      return started;
    }

    function* runEntry(
      key: string,
      source: string,
      view: EntrySegmentStream,
      initialBindings: Readonly<Record<string, Json>>,
      publications: RootBindingPublicationMode | undefined,
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
        // This entry's own external capability, built here and nowhere else,
        // for the exact execution and entry key its retained work is named by.
        // It is built before the execution captures its installations, because
        // what a host attaches is copied by value before anything installs:
        // an entry that got one afterwards would be running under a capability
        // the execution never admitted.
        //
        // Yielded in this task, after the Agent attachment above and before the
        // execution below, so what the capability registers for the execution —
        // the initialization its own private state is created by — belongs to
        // the entry rather than to a scope that has already closed.
        const owned =
          entryInstallation === undefined
            ? []
            : [yield* entryInstallation(entryOwner(execution.id, key))];
        // This entry's own selection, offered in the scope this execution runs
        // in. Every entry installs it again: core reads the final contextual
        // answer once per execution, and a chain assembled in a scope that has
        // already ended answers nothing.
        //
        // Offered as the ordinary fallback rather than as the answer. The
        // session's value is the command's; a plugin or a captured installation
        // callback that states its own is nearer, and answering here is what
        // would hide it.
        if (generated !== undefined) {
          yield* useGeneratedFallback(generated);
        }
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
          [...installations, lifecycle.installation, installation, ...owned],
          {
            initialBindings,
            ...(publications === undefined ? {} : { rootBindingPublications: publications }),
          },
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
    // The positions this history already holds, before anything is appended.
    // `start` validated the same bytes; this derives the thin summary from
    // them so a session that never appends still shows its rail.
    reproject();
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
        resumed.publications,
      );
    } else if (submitted !== undefined) {
      begin(
        entryKey(head.entries.length + 1),
        submitted,
        new EntrySegmentStream(stream),
        entryInitialBindings(head),
        ROOT_BINDING_PUBLICATIONS,
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

/**
 * What one entry's retained external work is named by.
 *
 * The execution and the entry's admission-order key, and nothing else. Both
 * survive a reopening — the execution id is in the printed location and the key
 * is the position the history already holds — so an entry that was interrupted
 * presents the same owner when it is continued, and the key an unfinished
 * upsert was made under is the one its next attempt presents.
 *
 * Neither the source, a counter, the working directory, a tracker, a prop nor
 * anything a document can write takes part in it: two entries that happen to
 * hold the same text are two entries, and an entry of another execution is
 * somebody else's.
 *
 * Derived here, in the session, because this is where both facts are known and
 * where nothing composable can answer for them. It is handed to the host's
 * factory as a string and appears in no Context, no prop and no request data.
 */
function entryOwner(execution: string, entry: string): string {
  return canonicalJson(["executablemd.repl.issue-owner", 1, execution, entry]);
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
