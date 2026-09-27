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
  spawn,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Stream, Task } from "effection";
import { INLINE_SOURCE_PATH, inlineSource, validateDocument } from "@executablemd/core";
import type { DocumentValidationDiagnostic } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  EarlyReturnDivergenceError,
  MalformedDurableEventError,
  StaleInputError,
  TerminalDivergenceError,
} from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

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
  const { execution, includes, installations = [], selection } = options;
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

  if (submitted !== undefined) {
    const validation = yield* validateDocument({ ...inlineSource(submitted), includes });
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
      reproject();
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

    const task: Task<Result<unknown>> = yield* spawn(function* () {
      try {
        const running = yield* executeInstalled(
          {
            ...inlineSource(source),
            stream,
            ...(includes === undefined ? {} : { includes: [...includes] }),
          },
          installations,
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
    });

    yield* spawn(function* () {
      const questions = yield* elicitation.changes;
      let next = yield* questions.next();
      while (!next.done) {
        if (next.value !== undefined) {
          admit();
        }
        next = yield* questions.next();
      }
    });

    // Held open deliberately. This body owns the observer and both tasks, and
    // finishing it would halt them — so it lasts as long as the scope does, and
    // the scope lasts as long as the session is wanted.
    yield* suspend();
  });

  const entry = yield* admission.operation;
  if (!entry.ok) {
    // Before the refusal is returned, not after: the caller is about to be told
    // there is no session, and everything this one started has to be gone by
    // the time it hears that.
    yield* until(dispose());
    return entry;
  }
  return entry;
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
