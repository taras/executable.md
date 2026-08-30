/**
 * Test fakes for the ACPX provider: an in-memory session store, a static
 * agent registry, and a scriptable runtime driven through the provider's
 * `createRuntime` seam.
 *
 * The fake returns Promises and an async iterable only where it implements
 * the `acpx` `AcpRuntime` method signatures — the acpx boundary. Manual-turn
 * timing is driven by Effection Futures (`withResolvers`), bridged to that
 * boundary with `run`; there is no Promise-based test orchestration.
 */

import { ensure, Err, Ok, run, scoped, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
import {
  AgentSessionBusy,
  agentSessionKeyDigest,
  AgentSessionRecoveryRequired,
  API,
  ExecutableObservationError,
} from "@executablemd/runtime";
import type {
  AgentSessionCoordinator,
  AgentSessionKey,
  AgentSessionOwner,
  AgentSessionOwnerKind,
  AgentSessionOwnership,
  ExecutableObserver,
  ExecutableRefusal,
} from "@executablemd/runtime";
import type {
  AcpAgentRegistry,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeMaterialization,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpSessionRecord,
  AcpSessionStore,
} from "../src/acpx-runtime.ts";
import type { ProbeCapableRuntime } from "../src/provider.ts";

export function makeRecord(agentCommand: string, cwd: string): AcpSessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: `record:${agentCommand}:${cwd}`,
    acpSessionId: `acp:${agentCommand}:${cwd}`,
    agentCommand,
    cwd,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    lastSeq: 0,
    eventLog: { active_path: "", segment_count: 0, max_segment_bytes: 0, max_segments: 0 },
    messages: [],
    updated_at: "2026-01-01T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}

export function makeStore(records?: Record<string, AcpSessionRecord>): AcpSessionStore & {
  records: Map<string, AcpSessionRecord>;
} {
  const map = new Map(Object.entries(records ?? {}));
  return {
    records: map,
    load(sessionId) {
      return Promise.resolve(map.get(sessionId));
    },
    save(record) {
      map.set(record.acpxRecordId, record);
      return Promise.resolve();
    },
  };
}

export function makeRegistry(commands: Record<string, string>): AcpAgentRegistry {
  return {
    resolve(agentName) {
      return commands[agentName] ?? agentName;
    },
    list() {
      return Object.keys(commands);
    },
  };
}

export interface ScriptedTurn {
  events?: AcpRuntimeEvent[];
  result?: AcpRuntimeTurnResult;
  /** Leaves the turn unresolved until `finish()` is called. */
  manual?: boolean;
  /**
   * Whether the backend accepts this turn, when the session is still awaiting
   * its first accepted one.
   *
   * Scripted apart from the events and the result on purpose: an adapter that
   * produces text, a stop reason and a terminal result while never reporting
   * acceptance is exactly the case no fallback may promote. Defaults to
   * accepting, which is what an ordinary turn does.
   */
  accepted?: boolean;
  /** Withhold acceptance until `accept()`, however the turn itself is driven. */
  manualAcceptance?: boolean;
}

export interface FakeTurn {
  input: AcpRuntimeTurnInput;
  turn: AcpRuntimeTurn;
  cancelled: boolean;
  finish(events: AcpRuntimeEvent[], result: AcpRuntimeTurnResult): void;
  /** Report that the backend accepted this turn, promoting the session's record. */
  accept(): void;
}

export interface FakeRuntimeHarness {
  create(options: AcpRuntimeOptions): ProbeCapableRuntime;
  createdOptions: AcpRuntimeOptions[];
  doctorReports: AcpRuntimeDoctorReport[];
  doctorCalls: number;
  ensureCalls: AcpRuntimeEnsureInput[];
  turns: FakeTurn[];
  closeCalls: AcpRuntimeHandle[];
  /**
   * Every close, whole.
   *
   * A discard and a release are the same call with different options, so the
   * option is the only thing that tells them apart — and "no launch path ever
   * discards persistent state" is a claim about exactly that.
   */
  closeInputs: Record<string, unknown>[];
  /**
   * The bound executable each close went through, in order.
   *
   * A handle belongs to the runtime that made it, and the only thing that
   * distinguishes two runtimes here is the transient environment they were
   * built with — so this is what shows a close reached its own partition.
   */
  closeRuntimes: (string | undefined)[];
  /**
   * Which created runtime served each close, by its index in `createdOptions`.
   *
   * The transient environment tells two *bound* runtimes apart; this tells any
   * two apart, including the unbound one a provider-returned launch uses.
   */
  closeRuntimeIndexes: number[];
  closeFailure?: Error;
  /**
   * Every handle this runtime issued, in order, by the id it carries.
   *
   * Unique per ensure, so a test can show that the ensure and the turn beside
   * it went through one uninterrupted handle rather than through a second one
   * opened in between.
   */
  handleIds: string[];
  /** Fail every attempt to establish a session, as an unreachable agent does. */
  ensureFailure?: Error;
  /**
   * Create sessions the way an adapter that asserts no provider-native
   * identity does. The handle still carries ACP and record ids, which is the
   * shape a client could mistake one of for a native id.
   */
  omitAgentSessionId?: boolean;
  /**
   * What to wait on, or raise, before an ensure for this input answers.
   *
   * Returning nothing lets it answer immediately, which is what every other
   * case wants. Returning an operation is how a test holds one ensure open
   * while another runs, or fails one of several without failing them all.
   */
  ensureGate?: (input: AcpRuntimeEnsureInput) => Operation<void> | undefined;
  /**
   * The conversation an attachment reports, whatever it was asked to resume.
   *
   * A real adapter answers with the session it loaded; this is how a test makes
   * one answer with a different conversation than the one it was told to open.
   */
  assertIdentity?: string;
  script(turn: ScriptedTurn): void;
}

/** One controlled build, as an observer would report it. */
export interface FakeObservation {
  path: string;
  digest: string;
  versionOutput: string;
}

export interface FakeObserverHarness {
  observer: ExecutableObserver;
  /** Every command this observer was asked about, in order. */
  observed: string[];
  /** What the next observation answers, or the failure it raises. */
  observation: FakeObservation;
  /** Answers taken in order before `observation`, so a build can change. */
  queued: FakeObservation[];
  failure?: ExecutableRefusal;
}

/**
 * A complete substitute for the host's executable observer.
 *
 * The whole seam is replaced, exactly as a trusted host supplies the whole
 * thing: nothing inside the observer is made replaceable to be testable, so
 * drift is expressed by answering differently rather than by a control the
 * production path also has.
 */
export function createFakeObserver(observation?: Partial<FakeObservation>): FakeObserverHarness {
  const harness: FakeObserverHarness = {
    observed: [],
    queued: [],
    observation: {
      path: "/opt/builds/claude",
      digest: "a".repeat(64),
      versionOutput: "2.1.241 (Claude Code)\n",
      ...observation,
    },
    observer: {
      // deno-lint-ignore require-yield
      *observe(command) {
        harness.observed.push(command);
        if (harness.failure) {
          throw new ExecutableObservationError(`${command} could not be observed`, {
            refusal: harness.failure,
          });
        }
        const answer = harness.queued.shift() ?? harness.observation;
        return {
          path: answer.path,
          digest: { algorithm: "sha256", value: answer.digest },
          versionOutput: answer.versionOutput,
        };
      },
    },
  };
  return harness;
}

/** One settled-once promise, with its resolvers, at the acpx boundary. */
function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DEFAULT_EVENTS: AcpRuntimeEvent[] = [
  { type: "text_delta", text: "hello ", stream: "output" },
  { type: "text_delta", text: "hidden", stream: "thought" },
  { type: "text_delta", text: "world", stream: "output" },
];

export function createFakeRuntime(): FakeRuntimeHarness {
  const scripted: ScriptedTurn[] = [];
  /** The identity a pending record is not yet asserting, by record id. */
  const withheld = new Map<string, string | undefined>();
  /** The record this fake wrote for each record id, so promotion can move it. */
  const records = new Map<string, AcpSessionRecord>();
  const harness: FakeRuntimeHarness = {
    createdOptions: [],
    doctorReports: [],
    doctorCalls: 0,
    ensureCalls: [],
    turns: [],
    handleIds: [],
    closeCalls: [],
    closeInputs: [],
    closeRuntimes: [],
    closeRuntimeIndexes: [],
    script(turn) {
      scripted.push(turn);
    },
    create(options) {
      const runtimeIndex = harness.createdOptions.length;
      harness.createdOptions.push(options);
      return {
        doctor() {
          harness.doctorCalls++;
          const report = harness.doctorReports.shift() ?? {
            ok: true,
            message: "fake runtime ready",
          };
          return Promise.resolve(report);
        },
        ensureSession(input) {
          if (harness.ensureFailure) {
            return Promise.reject(harness.ensureFailure);
          }
          harness.ensureCalls.push(input);
          const handleId = `${input.sessionKey}#${harness.handleIds.length}`;
          harness.handleIds.push(handleId);
          // Deferred materialization: the record occupies the key and asserts
          // nothing, and the identity the adapter answered with is held here
          // until the backend accepts a turn.
          const deferred = input.materialization === "first-turn-acceptance";
          // ACPX persists a record as it establishes a session, including the
          // instruction layer the caller asked for; a fake that skipped that
          // would hide every decision a later launch makes by reading it back.
          const record: AcpSessionRecord = {
            ...makeRecord(options.agentRegistry.resolve(input.agent), input.cwd ?? options.cwd),
            acpxRecordId: input.sessionKey,
            messages: [],
          };
          // What the adapter says it opened. An exact resume answers with the
          // conversation it was told to load, and `assertIdentity` is how a
          // test makes it answer with another one.
          const asserted =
            harness.assertIdentity ?? input.resumeSessionId ?? `agent-session:${input.sessionKey}`;
          if (input.sessionOptions?.systemPrompt !== undefined) {
            record.acpx = { session_options: { system_prompt: input.sessionOptions.systemPrompt } };
          }
          const handle: AcpRuntimeHandle = {
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: handleId,
            cwd: input.cwd,
            acpxRecordId: `record:${input.sessionKey}`,
            backendSessionId: `backend:${input.sessionKey}`,
          };
          if (deferred) {
            record.sessionMaterialization = {
              state: "pending",
              contract: "executablemd.session-materialization/v1",
            };
            withheld.set(handle.acpxRecordId!, harness.omitAgentSessionId ? undefined : asserted);
          } else if (!harness.omitAgentSessionId) {
            handle.agentSessionId = asserted;
            record.agentSessionId = asserted;
          }
          const answer = (): AcpRuntimeHandle => {
            records.set(handle.acpxRecordId!, record);
            void options.sessionStore.save(record);
            return handle;
          };
          // The gate runs on Effection and `run` bridges it to the acpx Promise
          // boundary, the same way a manual turn's release does.
          const gate = harness.ensureGate?.(input);
          return gate ? run(() => gate).then(answer) : Promise.resolve(answer());
        },
        startTurn(input) {
          const script = scripted.shift() ?? {};
          const recordId = input.handle.acpxRecordId ?? input.handle.sessionKey;
          const awaiting = withheld.has(recordId);
          // A native promise rather than an Effection future: this is the acpx
          // boundary, and a turn nobody accepts leaves it unsettled — which as a
          // root task would be a pending operation the runner refuses to end on.
          const materialized = promiseWithResolvers<AcpRuntimeMaterialization>();
          // Observed here as the provider's own deferreds are: a test that only
          // reads events must not turn an unaccepted turn into an unhandled
          // rejection.
          materialized.promise.catch(() => {});
          const events = script.events ?? DEFAULT_EVENTS;
          const result: AcpRuntimeTurnResult = script.result ?? {
            status: "completed",
            stopReason: "end_turn",
          };

          let pushEvents = events;
          // Manual-turn timing runs on Effection Futures; `run` bridges them
          // to the acpx async-iterable / Promise boundary.
          const gate = withResolvers<void>();
          const resultReady = withResolvers<AcpRuntimeTurnResult>();

          const promote = (): void => {
            if (!withheld.has(recordId)) {
              return;
            }
            const identity = withheld.get(recordId);
            withheld.delete(recordId);
            const stored = records.get(recordId);
            if (stored) {
              stored.sessionMaterialization = undefined;
              if (identity !== undefined) {
                stored.agentSessionId = identity;
              }
              void options.sessionStore.save(stored);
            }
            materialized.resolve({
              acpxRecordId: recordId,
              ...(identity === undefined ? {} : { agentSessionId: identity }),
            });
          };
          const refuse = (): void => {
            materialized.reject(new Error("this session still awaits first-turn materialization"));
          };
          const fake: FakeTurn = {
            input,
            cancelled: false,
            accept: promote,
            finish(finishEvents, finishResult) {
              pushEvents = finishEvents;
              gate.resolve();
              resultReady.resolve(finishResult);
              // A turn that ends still awaiting acceptance never got it.
              refuse();
            },
            turn: {
              requestId: input.requestId,
              events: {
                [Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
                  let index = 0;
                  let gateTask: Task<void> | undefined;
                  const emit = (): IteratorResult<AcpRuntimeEvent> => {
                    if (index < pushEvents.length) {
                      return { done: false, value: pushEvents[index++]! };
                    }
                    return { done: true, value: undefined };
                  };
                  return {
                    next(): Promise<IteratorResult<AcpRuntimeEvent>> {
                      // A manual turn withholds its events until the release
                      // gate resolves; run() bridges the Effection Future to
                      // the acpx async-iterator boundary.
                      if (script.manual && !gateTask) {
                        gateTask = run(() => gate.operation);
                        return gateTask.then(emit);
                      }
                      return Promise.resolve(emit());
                    },
                    return(): Promise<IteratorResult<AcpRuntimeEvent>> {
                      index = pushEvents.length;
                      const halted = gateTask?.halt();
                      gateTask = undefined;
                      // Observe the halt so no root task is left dangling.
                      if (halted) {
                        return halted.then(() => ({ done: true, value: undefined }));
                      }
                      return Promise.resolve({ done: true, value: undefined });
                    },
                  };
                },
              },
              result: run(() => resultReady.operation),
              materialized: materialized.promise,
              cancel() {
                fake.cancelled = true;
                fake.finish([], { status: "cancelled" });
                return Promise.resolve();
              },
              closeStream() {
                return Promise.resolve();
              },
            },
          };
          if (!awaiting) {
            // Already asserting. The barrier says the session no longer awaits
            // its first accepted turn, not that this one was accepted.
            const stored = records.get(recordId);
            materialized.resolve({
              acpxRecordId: recordId,
              ...(stored?.agentSessionId === undefined
                ? {}
                : { agentSessionId: stored.agentSessionId }),
            });
          } else if (script.accepted !== false && script.manualAcceptance !== true) {
            // Acceptance is not the turn's output: a backend takes the turn
            // before it says anything, so a manual turn — which withholds its
            // events — still reports acceptance at once unless a case asks it
            // not to.
            promote();
          }
          if (!script.manual) {
            fake.finish(events, result);
          }
          harness.turns.push(fake);
          return fake.turn;
        },
        runTurn(input) {
          return this.startTurn(input).events;
        },
        cancel() {
          return Promise.resolve();
        },
        close(input) {
          harness.closeRuntimes.push(options.agentProcessEnv?.CLAUDE_CODE_EXECUTABLE);
          harness.closeRuntimeIndexes.push(runtimeIndex);
          harness.closeCalls.push(input.handle);
          harness.closeInputs.push({ ...(input as unknown as Record<string, unknown>) });
          if (harness.closeFailure) {
            return Promise.reject(harness.closeFailure);
          }
          return Promise.resolve();
        },
      };
    },
  };
  return harness;
}

/** Pin the contextual cwd and give the git walk a bare, repo-less view. */
export function* useFlatWorld(cwdPath: string): Operation<void> {
  yield* API.Env.around({
    *cwd() {
      return cwdPath;
    },
  });
  yield* API.Fs.around({
    *stat() {
      return { exists: false, isFile: false, isDirectory: false };
    },
  });
}

/**
 * A world with a mutable contextual cwd and a Git root at `gitRoot`, so
 * the session-placement walk reaches a common ancestor — different
 * caller cwds under the root resolve to the same nearest session.
 */
export function* useGitWorld(cwdRef: { value: string }, gitRoot: string): Operation<void> {
  yield* API.Env.around({
    *cwd() {
      return cwdRef.value;
    },
  });
  yield* API.Fs.around({
    *stat([path]) {
      const isGit = path === `${gitRoot}/.git`;
      return { exists: isGit, isFile: false, isDirectory: isGit };
    },
  });
}

/**
 * A session coordinator with the Deno adapter's semantics and none of its
 * machinery: one live owner at a time, and an owner that never proved it
 * stopped leaves the session owned.
 *
 * It records every acquisition, because "which operations coordinate, under
 * which owner kind, against which key" is the observation most of the ownership
 * evidence is made of — and one an ordinary coordinator has no reason to offer.
 */
export interface CoordinatorHarness {
  coordinator: AgentSessionCoordinator;
  /** Every acquisition attempt, in order, with what it was answered. */
  acquisitions: {
    kind: AgentSessionOwnerKind;
    key: AgentSessionKey;
    outcome: "granted" | "busy" | "recovery-required";
  }[];
  /** Leave `key` looking like the work of an owner that never finished. */
  tombstone(key: AgentSessionKey): void;
  /**
   * Ownership's own ordered log — `owned`, `quiesced`, `released-idle` or
   * `released-active`.
   *
   * Separate from a caller's own trace so a case can say what ownership was
   * doing at the moment of some other observation.
   */
  events: string[];
}

export function makeCoordinator(): CoordinatorHarness {
  const occupied = new Set<string>();
  const retained = new Map<string, "active" | "idle">();
  const acquisitions: CoordinatorHarness["acquisitions"] = [];
  const order: string[] = [];

  const harness: CoordinatorHarness = {
    acquisitions,
    events: order,
    tombstone(key) {
      retained.set(agentSessionKeyDigest(key), "active");
    },
    coordinator: {
      coordinate<T>(
        key: AgentSessionKey,
        owner: AgentSessionOwner,
        body: (ownership: AgentSessionOwnership) => Operation<T>,
      ): Operation<Result<T>> {
        return scoped(function* (): Operation<Result<T>> {
          const digest = agentSessionKeyDigest(key);
          if (occupied.has(digest)) {
            acquisitions.push({ kind: owner.kind, key, outcome: "busy" });
            return Err(new AgentSessionBusy(`session "${key.sessionKey}" is held`));
          }
          occupied.add(digest);
          yield* ensure(() => {
            occupied.delete(digest);
          });
          if (retained.get(digest) === "active") {
            acquisitions.push({ kind: owner.kind, key, outcome: "recovery-required" });
            return Err(
              new AgentSessionRecoveryRequired(`session "${key.sessionKey}" needs recovery`),
            );
          }
          acquisitions.push({ kind: owner.kind, key, outcome: "granted" });
          retained.set(digest, "active");
          order.push("owned");
          let quiesced = false;
          yield* ensure(() => {
            // Last, by construction: registered before the body runs, so every
            // finalizer the body registers unwinds ahead of it.
            order.push(quiesced ? "released-idle" : "released-active");
            if (quiesced) {
              retained.set(digest, "idle");
            }
          });
          return Ok(
            yield* body({
              quiesced() {
                quiesced = true;
                order.push("quiesced");
              },
            }),
          );
        });
      },
    },
  };
  return harness;
}
