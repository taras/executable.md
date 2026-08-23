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
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpSessionRecord,
  AcpSessionStore,
} from "acpx/runtime";
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
}

export interface FakeTurn {
  input: AcpRuntimeTurnInput;
  turn: AcpRuntimeTurn;
  cancelled: boolean;
  finish(events: AcpRuntimeEvent[], result: AcpRuntimeTurnResult): void;
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
  closeFailure?: Error;
  /** Fail every attempt to establish a session, as an unreachable agent does. */
  ensureFailure?: Error;
  /**
   * Create sessions the way an adapter that asserts no provider-native
   * identity does. The handle still carries ACP and record ids, which is the
   * shape a client could mistake one of for a native id.
   */
  omitAgentSessionId?: boolean;
  /**
   * Answer every attachment with this identity, whatever was asked for.
   *
   * An adapter is free to report the session it actually attached to, and the
   * one case that matters is when that is not the one XMD named.
   */
  misreportAgentSessionId?: string;
  script(turn: ScriptedTurn): void;
}

const DEFAULT_EVENTS: AcpRuntimeEvent[] = [
  { type: "text_delta", text: "hello ", stream: "output" },
  { type: "text_delta", text: "hidden", stream: "thought" },
  { type: "text_delta", text: "world", stream: "output" },
];

export function createFakeRuntime(): FakeRuntimeHarness {
  const scripted: ScriptedTurn[] = [];
  const harness: FakeRuntimeHarness = {
    createdOptions: [],
    doctorReports: [],
    doctorCalls: 0,
    ensureCalls: [],
    turns: [],
    closeCalls: [],
    closeInputs: [],
    script(turn) {
      scripted.push(turn);
    },
    create(options) {
      harness.createdOptions.push(options);
      // Per created runtime, not per harness: the whole question is whether one
      // runtime is handed a handle another runtime made, and a set shared by
      // every runtime this harness builds could never answer it.
      const mine = new WeakSet<object>();
      const own = (handle: unknown, what: string) => {
        if (typeof handle === "object" && handle !== null && !mine.has(handle)) {
          throw new Error(`foreign handle reached ${what}: this runtime did not create it`);
        }
      };
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
          harness.ensureCalls.push(input);
          if (harness.ensureFailure) {
            return Promise.reject(harness.ensureFailure);
          }
          // ACPX persists a record as it establishes a session, including the
          // instruction layer the caller asked for; a fake that skipped that
          // would hide every decision a later launch makes by reading it back.
          const record: AcpSessionRecord = {
            ...makeRecord(options.agentRegistry.resolve(input.agent), input.cwd ?? options.cwd),
            acpxRecordId: input.sessionKey,
            messages: [],
          };
          if (input.sessionOptions?.systemPrompt !== undefined) {
            record.acpx = { session_options: { system_prompt: input.sessionOptions.systemPrompt } };
          }
          void options.sessionStore.save(record);
          const handle: AcpRuntimeHandle = {
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: input.sessionKey,
            cwd: input.cwd,
            acpxRecordId: `record:${input.sessionKey}`,
            backendSessionId: `backend:${input.sessionKey}`,
          };
          if (!harness.omitAgentSessionId) {
            // An attachment by name reports the name it attached to. Answering
            // with something of the fake's own would make every resume look
            // like a mismatch, and hide the one that is.
            handle.agentSessionId =
              harness.misreportAgentSessionId ??
              input.resumeSessionId ??
              `agent-session:${input.sessionKey}`;
          }
          mine.add(handle);
          return Promise.resolve(handle);
        },
        startTurn(input) {
          own(input.handle, "startTurn");
          const script = scripted.shift() ?? {};
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

          const fake: FakeTurn = {
            input,
            cancelled: false,
            finish(finishEvents, finishResult) {
              pushEvents = finishEvents;
              gate.resolve();
              resultReady.resolve(finishResult);
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
          own(input.handle, "close");
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
   * Clear that marker, as recovering the session does.
   *
   * The coordinator contract offers no recovery operation — recovery is what an
   * operator does to the durable state, out of band. This is that, so a case
   * can put a session past an unrecovered owner and go on to ask what the next
   * thing wrong with it is.
   */
  recovered(key: AgentSessionKey): void;
  /** What this session's ownership is retained as right now. */
  state(key: AgentSessionKey): "active" | "idle" | undefined;
  /**
   * Ownership's own ordered log — `owned`, `quiesced`, `released-idle` or
   * `released-active`.
   *
   * Separate from the provider/launcher trace so a caller can interleave its
   * own markers into exactly one of the two without disturbing assertions on
   * the other.
   */
  events: string[];
}

export function makeCoordinator(): CoordinatorHarness {
  const order: string[] = [];
  const occupied = new Set<string>();
  const retained = new Map<string, "active" | "idle">();
  const acquisitions: CoordinatorHarness["acquisitions"] = [];

  const harness: CoordinatorHarness = {
    acquisitions,
    events: order,
    tombstone(key) {
      retained.set(agentSessionKeyDigest(key), "active");
    },
    recovered(key) {
      retained.delete(agentSessionKeyDigest(key));
    },
    state(key) {
      return retained.get(agentSessionKeyDigest(key));
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

/**
 * An executable observer that answers without a filesystem.
 *
 * The amendment's own seam: controlled tests substitute the whole observer
 * rather than moving PATH, because the real one deliberately reads the process
 * environment and cannot be redirected. `observed` is what every command
 * resolves to; changing it between calls is how a test makes a build drift
 * under a stable command.
 */
export interface ObserverHarness {
  observer: ExecutableObserver;
  /** What the next observation answers. */
  observed: { path: string; digest: string; versionOutput: string };
  /** Every command this observer was asked about, in order. */
  asked: string[];
  /** Refuse the next observation the way the host does. */
  refuse?: ExecutableRefusal;
}

export function makeObserver(initial: Partial<ObserverHarness["observed"]> = {}): ObserverHarness {
  const harness: ObserverHarness = {
    asked: [],
    observed: {
      path: "/observed/claude",
      digest: "d".repeat(64),
      versionOutput: "2.1.235 (Claude Code)\n",
      ...initial,
    },
    observer: {
      // deno-lint-ignore require-yield
      *observe(command) {
        harness.asked.push(command);
        if (harness.refuse) {
          throw new ExecutableObservationError(`${command} refused`, { refusal: harness.refuse });
        }
        return {
          path: harness.observed.path,
          digest: { algorithm: "sha256", value: harness.observed.digest },
          versionOutput: harness.observed.versionOutput,
        };
      },
    },
  };
  return harness;
}
