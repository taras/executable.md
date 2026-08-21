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

import { run, withResolvers } from "effection";
import type { Operation, Task } from "effection";
import { API } from "@executablemd/runtime";
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
   * The whole close request, not only its handle.
   *
   * Two closes mean different things: releasing a session to a native UI keeps
   * the record the UI is about to resume, while discarding an unused shell
   * removes it. A test that can only count closes cannot tell them apart.
   */
  closeRequests: { handle: AcpRuntimeHandle; discardPersistentState?: boolean }[];
  closeFailure?: Error;
  /**
   * Create sessions the way an adapter that asserts no provider-native
   * identity does. The handle still carries ACP and record ids, which is the
   * shape a client could mistake one of for a native id.
   */
  omitAgentSessionId?: boolean;
  /**
   * Answer an ensure with an identity of the runtime's own choosing, whatever
   * was asked to be resumed.
   *
   * The state after interrupted preparation: XMD retained a native identity,
   * and the provider has no session under it to load.
   */
  unresumable?: boolean;
  /** Fail every `ensureSession`, the way an unreachable agent does. */
  ensureFailure?: Error;
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
    closeRequests: [],
    script(turn) {
      scripted.push(turn);
    },
    create(options) {
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
            // A resumed session answers to the identity it was resumed under.
            // Reporting the session key back instead would make a provider
            // that substituted an identity indistinguishable from one that
            // loaded the retained conversation.
            handle.agentSessionId =
              harness.unresumable === true
                ? `agent-session:${input.sessionKey}`
                : (input.resumeSessionId ?? `agent-session:${input.sessionKey}`);
          }
          return Promise.resolve(handle);
        },
        startTurn(input) {
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
          harness.closeCalls.push(input.handle);
          harness.closeRequests.push({
            handle: input.handle,
            ...(input.discardPersistentState === undefined
              ? {}
              : { discardPersistentState: input.discardPersistentState }),
          });
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
