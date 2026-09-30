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
 * So a fresh session validates the document first, against the same environment
 * the run would use, and a document that cannot run leaves the history empty
 * and the draft editable — rather than admitting an entry whose only history is
 * its own failure. After admission the entry is immutable and the draft is over.
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
import type { DocumentValidationDiagnostic, PermissionMode } from "@executablemd/core";
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
import { consumeAdmissions } from "./admission.ts";
import type { ReplAgentAuthority, ReplAgentReading } from "./agent.ts";
import { useReplElicitation } from "./elicitation.ts";
import type { ReplElicitations, ReplQuestion } from "./elicitation.ts";
import { useExpansionController } from "./expansion.ts";
import type { ExpansionController, ExpansionState } from "./expansion.ts";
import type { ReplExecution } from "./journal.ts";
import { projectRepl } from "./model.ts";
import type { ReplModel } from "./model.ts";

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
  /** Whether an execution is still running in this process. */
  readonly live: boolean;
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
  /** Wait for this process's execution to finish, and answer how it finished. */
  join(): Operation<Result<unknown>>;
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

/** Submit one entry into an execution whose history is empty. */
export function submitReplEntry(
  options: ReplSessionOptions & { readonly source: string },
): Operation<Result<ReplSession>> {
  return start(options, options.source);
}

/** Reconstruct one execution from the history its file holds. */
export function openReplSession(options: ReplSessionOptions): Operation<Result<ReplSession>> {
  return start(options, undefined);
}

function* start(
  options: ReplSessionOptions,
  submitted: string | undefined,
): Operation<Result<ReplSession>> {
  const { execution, includes, installations = [], selection, permissionMode } = options;
  const stream = execution.stream;

  const projection = projectRepl(yield* stream.readAll(), selection);
  if (!projection.ok) {
    return projection;
  }
  let model = projection.value;

  const admitted = model.entry;
  if (admitted !== undefined && submitted !== undefined) {
    return Err(
      new ReplReconstructionError(
        "this execution has already admitted its entry, and an admitted entry is immutable.",
      ),
    );
  }
  if (admitted !== undefined && admitted.path !== INLINE_SOURCE_PATH) {
    return Err(
      new ReplReconstructionError(
        "this history was written by something other than the REPL: its entry came from a file " +
          "rather than from submitted text.",
      ),
    );
  }

  const source = admitted?.source ?? submitted;
  if (source === undefined) {
    // Nothing admitted and nothing submitted: an empty execution waiting for an
    // entry. There is no document to run, so there is nothing to admit either.
    return Ok(idle(execution.id, model));
  }
  // Named again after the guard, because the execution below runs from a
  // hoisted body and the narrowing does not reach it.
  const entry: string = source;

  if (submitted !== undefined) {
    // Validated against the vocabulary the execution will actually install, not
    // against the bare registry: a host that declares `<Session>` to the
    // execution would otherwise have every entry naming one refused here and
    // run perfectly if it got past. Preflight and the run answer to one
    // environment or preflight is describing a different document.
    // In a scope of its own, because admitting a declaration in order to ask
    // about it mints the durable identity domain that name answers under.
    // Leaving that behind would have the execution resolve `<Session>` through
    // preflight's admission while issuing its invocations under its own.
    const validation = yield* scoped(function* () {
      return yield* validateDocument({
        ...inlineSource(submitted),
        includes,
        components: declaredComponents(installations),
        declarations: declaredMarkdown(installations),
      });
    });
    if (validation.outcome === "invalid") {
      return Err(new ReplPreflightError(validation.diagnostics));
    }
  }

  const changes = createSignal<ReplModel, never>();
  const outputs = createSignal<string, never>();
  let output = "";
  let live = true;
  const admission = withResolvers<Result<ReplSession>>();
  let settled = false;

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
    if (!settled) {
      settled = true;
      admission.resolve(Err(error));
    }
  }

  provisional.run(function* () {
    const expansion = yield* useExpansionController();
    const elicitation = yield* useReplElicitation();
    // Created here and installed into the execution below, so the middleware it
    // owns belongs to this session's scope and dies with it. An execution
    // elsewhere would otherwise inherit an observer watching for a session that
    // is gone.
    const agent = useReplAgent(permissionMode ?? "deny-all");

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
      changes,
      outputs,
      join(): Operation<Result<unknown>> {
        return task;
      },
    };

    function admit(): void {
      if (!settled) {
        settled = true;
        admission.resolve(Ok(session));
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
      admit();
    };

    // Registered before the callback is published, and removing exactly the one
    // this session installed. The stream outlives the session that was watching
    // it — a repository hands the same stream to whoever opens the execution
    // next — so a callback left behind would reproject into, and signal, a
    // session whose scope is gone.
    yield* ensure(() => {
      if (stream.onAppend === observe) {
        stream.onAppend = null;
      }
    });
    stream.onAppend = observe;

    /**
     * How this session finished: the execution's own outcome, or the first
     * failure that withdrew its authority.
     *
     * Settled once, by whichever happened first. A withdrawn session may not be
     * left waiting on the work it withdrew authority from, so the watcher below
     * halts the execution and waits for it before answering — which is what
     * makes the provider turn, the held permission wait and the execution task
     * all gone by the time `join()` returns. A later failure cannot replace the
     * first one, because by then there is nothing left for it to describe.
     */
    const finished = withResolvers<Result<unknown>>();
    let answered = false;
    function settle(outcome: Result<unknown>): void {
      if (!answered) {
        answered = true;
        finished.resolve(outcome);
      }
    }

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
    const agentReadings = yield* agent.changes;
    const questions = yield* elicitation.changes;

    const document: Task<Result<unknown>> = yield* spawn(function* () {
      const outcome = yield* runExecution();
      settle(outcome);
      return outcome;
    });

    yield* spawn(function* () {
      const error = yield* agent.failed;
      live = false;
      admit();
      // Halted and joined before the failure is answered, in that order.
      yield* document.halt();
      settle(Err(error));
    });

    const task: Operation<Result<unknown>> = finished.operation;

    function* runExecution(): Operation<Result<unknown>> {
      try {
        const running = yield* executeInstalled(
          {
            ...inlineSource(entry),
            stream,
            ...(includes === undefined ? {} : { includes: [...includes] }),
          },
          // Installed into this exact execution, and nowhere else: the live
          // observer and the permission policy are this session's, not the
          // process's.
          [...installations, agent.installation],
        );
        // Consumed as it arrives, inside this session's scope. Collecting until
        // the stream closed would leave the overlay empty for the whole of the
        // run and fill it in at the end, which is the opposite of what an
        // overlay is for: what it shows is what the document has rendered
        // *so far*.
        yield* spawn(function* () {
          const chunks = yield* running.output;
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
        const outcome = yield* running;
        live = false;
        if (!outcome.ok && isReconstructionFailure(outcome.error)) {
          refuse(outcome.error);
          return outcome;
        }
        admit();
        return outcome;
      } catch (error) {
        live = false;
        const raised = error instanceof Error ? error : new Error(String(error));
        if (isReconstructionFailure(raised)) {
          refuse(raised);
        } else {
          admit();
        }
        return Err(raised);
      }
    }

    // A queued Agent turn is work beyond the retained prefix, exactly as a new
    // record or a question is: replay that reached one is past what the history
    // held, so the session is admitted rather than still provisional.
    yield* spawn(consumeAdmissions(agentReadings, (reading) => reading.turns.length > 0, admit));

    yield* spawn(consumeAdmissions(questions, (question) => question !== undefined, admit));

    // Held open deliberately. This body owns the observer and both tasks, and
    // finishing it would halt them — so it lasts as long as the scope does, and
    // the scope lasts as long as the session is wanted.
    yield* suspend();
  });

  const opened = yield* admission.operation;
  if (!opened.ok) {
    // Before the refusal is returned, not after: the caller is about to be told
    // there is no session, and everything this one started has to be gone by
    // the time it hears that.
    yield* until(dispose());
    return opened;
  }
  return opened;
}

const EMPTY_AGENT_READING: ReplAgentReading = Object.freeze({
  turns: Object.freeze([]),
  requests: Object.freeze([]),
});

/** No live request exists, so no key settles one. */
const IDLE_PERMISSIONS: ReplAgentAuthority = Object.freeze({
  choose: () => false,
  dismiss: () => false,
});

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

/** An execution with no entry yet: a draft surface and nothing running. */
function idle(execution: string, model: ReplModel): ReplSession {
  const changes = createSignal<ReplModel, never>();
  const elicitation: ReplElicitations = {
    pending: undefined,
    changes: createSignal<ReplQuestion | undefined, never>(),
    asked: 0,
  };
  return {
    execution,
    model,
    overlay: { output: "", question: undefined, expansion: "playing", draft: undefined },
    expansion: { state: "playing", states: createSignal<ExpansionState, never>() },
    // Nothing is expanding, so there is nothing to pause or continue.
    controller: undefined,
    elicitation,
    // Nothing is running, so there is no live Agent work and nothing to settle.
    agent: EMPTY_AGENT_READING,
    agentChanges: createSignal<ReplAgentReading, never>(),
    permissions: IDLE_PERMISSIONS,
    live: false,
    changes,
    // Nothing is running, so nothing will ever write.
    outputs: createSignal<string, never>(),
    // deno-lint-ignore require-yield
    *join(): Operation<Result<unknown>> {
      return Ok(undefined);
    },
  };
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
