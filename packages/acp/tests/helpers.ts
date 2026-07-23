/**
 * Test fakes for the ACPX provider: an in-memory session store, a static
 * agent registry, and a scriptable runtime driven through the provider's
 * `createRuntime` seam.
 */

import type { Operation } from "effection";
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
  closeFailure?: Error;
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
          const handle: AcpRuntimeHandle = {
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: input.sessionKey,
            cwd: input.cwd,
            acpxRecordId: `record:${input.sessionKey}`,
            backendSessionId: `backend:${input.sessionKey}`,
            agentSessionId: `agent-session:${input.sessionKey}`,
          };
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
          let resolveResult: (value: AcpRuntimeTurnResult) => void = () => {};
          let releaseEvents: () => void = () => {};
          const gate = new Promise<void>((resolve) => {
            releaseEvents = resolve;
          });
          const resultPromise = new Promise<AcpRuntimeTurnResult>((resolve) => {
            resolveResult = resolve;
          });

          const fake: FakeTurn = {
            input,
            cancelled: false,
            finish(finishEvents, finishResult) {
              pushEvents = finishEvents;
              releaseEvents();
              resolveResult(finishResult);
            },
            turn: {
              requestId: input.requestId,
              events: {
                async *[Symbol.asyncIterator]() {
                  if (script.manual) {
                    await gate;
                  }
                  yield* pushEvents;
                },
              },
              result: resultPromise,
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
    // deno-lint-ignore require-yield
    *cwd() {
      return cwdPath;
    },
  });
  yield* API.Fs.around({
    // deno-lint-ignore require-yield
    *stat() {
      return { exists: false, isFile: false, isDirectory: false };
    },
  });
}
