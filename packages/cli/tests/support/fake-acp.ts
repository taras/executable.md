/**
 * A scriptable stand-in for the ACPX runtime, for driving a workflow Agent
 * without starting one.
 *
 * It implements the `acpx` runtime methods the provider actually calls, and
 * nothing else. Each scripted turn is one reply; a turn may also ask for a
 * native tool permission first, which is how the deny-and-fail path is driven
 * without an adapter that misbehaves on purpose.
 *
 * Promises appear only where the acpx boundary is defined in them.
 */

import { run, withResolvers } from "effection";
import type { Operation } from "effection";
import type {
  AcpAgentRegistry,
  AcpPermissionRequest,
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
  AcpxSessionStore,
  ProbeCapableRuntime,
} from "@executablemd/acp";

/** A session store whose records a case can read back. */
export type FakeStore = AcpxSessionStore & { records: Map<string, AcpSessionRecord> };

export function makeStore(): FakeStore {
  const records = new Map<string, AcpSessionRecord>();
  return {
    records,
    load(sessionId: string): Promise<AcpSessionRecord | undefined> {
      return Promise.resolve(records.get(sessionId));
    },
    save(record: AcpSessionRecord): Promise<void> {
      records.set(record.acpxRecordId, record);
      return Promise.resolve();
    },
  };
}

export function makeRegistry(commands: Record<string, string>): AcpAgentRegistry {
  return {
    resolve(agentName: string): string {
      return commands[agentName] ?? agentName;
    },
    list(): string[] {
      return Object.keys(commands);
    },
  };
}

/** One scripted turn: what the agent says, and what it asks for first. */
export interface ScriptedTurn {
  /** The reply text this turn streams. */
  readonly reply: string;
  /**
   * A native tool this turn asks permission for before replying.
   *
   * The title travels into the request exactly as an adapter would put it
   * there, which is what lets a test assert it reaches no diagnostic.
   */
  readonly requestsTool?: string;
  /**
   * Whether the backend accepts this turn, when the session is awaiting its
   * first accepted one.
   *
   * Scripted apart from the reply and the result: a turn that produces text and
   * settles while never reporting acceptance is exactly the case no fallback
   * may promote.
   */
  readonly accepted?: boolean;
  /**
   * Leave this turn unfinished until it is cancelled.
   *
   * How an interruption is modelled: the turn streams nothing and settles
   * nothing, so tearing the run's scope down leaves the journal holding exactly
   * the turns that had already committed.
   */
  readonly manual?: boolean;
  /**
   * The stop reason this turn settles with.
   *
   * `end_turn` unless a case says otherwise. Anything else is a turn the
   * provider reports as failed while keeping whatever text it streamed, which is
   * how a partial reply is driven without an adapter that misbehaves on purpose.
   */
  readonly stopReason?: string;
  /**
   * The App Server turn this reply is, as an adapter that names its turns says
   * it: on this exact response's own `_meta`.
   *
   * Absent for an adapter that names none, which is how most of this suite's
   * turns answer.
   */
  readonly turnId?: string;
}

export interface FakeAcp {
  create(options: AcpRuntimeOptions): ProbeCapableRuntime;
  /** Every runtime this provider created, with the options it was given. */
  readonly created: AcpRuntimeOptions[];
  /** Every session this provider established. */
  readonly ensured: AcpRuntimeEnsureInput[];
  /** Every prompt text this provider sent, in order. */
  readonly prompts: string[];
  /** Every turn this provider started, whole, in order. */
  readonly turns: AcpRuntimeTurnInput[];
  /** Every permission decision this fake was answered with. */
  readonly decisions: string[];
  /** Whether an agent process would have been started at all. */
  readonly started: boolean;
  /** Every handle this runtime was told to close, by the reason it was given. */
  readonly closes: string[];
  /** How many turns were cancelled rather than allowed to settle. */
  readonly cancels: number;
  /**
   * Fail every close.
   *
   * A provider whose teardown fails is the case a host has to survive without
   * acting on what the failed scope produced, and only a close that rejects
   * makes the provider report one.
   */
  closeFailure?: Error;
  script(turn: ScriptedTurn): void;
  /**
   * Settles once `count` turns have been started.
   *
   * A barrier rather than a delay: a test that halts a run mid-turn has to know
   * the turn it means to interrupt is actually in flight, and a sleep long
   * enough today is a flake on a slower machine.
   */
  startedTurns(count: number): Operation<void>;
  /**
   * Settles once `count` turns have had their events read.
   *
   * A turn's events are read only after the session it belongs to has been
   * established — the provider waits for the backend's acceptance and commits
   * the host's mapping before it exposes anything the turn produced. So this is
   * the barrier for "the mapping this turn earned is committed", which
   * `startedTurns` is not: a turn can be requested and never accepted.
   */
  consumedTurns(count: number): Operation<void>;
}

/**
 * Ask for one native tool permission, if this turn asks for one.
 *
 * The Promise is the acpx callback's own: `onPermissionRequest` is defined in
 * Promises, and this is the boundary rather than orchestration.
 */
function permissionAsked(
  options: AcpRuntimeOptions,
  input: AcpRuntimeTurnInput,
  turn: ScriptedTurn,
  record: (outcome: string) => void,
): Promise<void> {
  const tool = turn.requestsTool;
  if (tool === undefined || options.onPermissionRequest === undefined) {
    return Promise.resolve();
  }
  const sessionId = `acp:${input.handle.sessionKey}`;
  const request: AcpPermissionRequest = {
    sessionId,
    inferredKind: undefined,
    raw: {
      sessionId,
      toolCall: { toolCallId: "call-1", title: tool, rawInput: { command: tool } },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  };
  return Promise.resolve(
    options.onPermissionRequest(request, { signal: new AbortController().signal }),
  ).then((decision) => {
    record(decision?.outcome ?? "none");
  });
}

export function createFakeAcp(): FakeAcp {
  const scripted: ScriptedTurn[] = [];
  /** The identity a record placed for a first turn is not yet asserting. */
  const withheld = new Map<string, string>();
  /** The record this fake wrote for each key, so an acceptance can promote it. */
  const records = new Map<string, AcpSessionRecord>();
  const created: AcpRuntimeOptions[] = [];
  const ensured: AcpRuntimeEnsureInput[] = [];
  const prompts: string[] = [];
  const turns: AcpRuntimeTurnInput[] = [];
  const decisions: string[] = [];
  const closes: string[] = [];
  const waiting: Array<{ count: number; settle: () => void }> = [];
  const reading: Array<{ count: number; settle: () => void }> = [];
  let consumed = 0;
  let started = false;
  let cancels = 0;

  function announceTurn(): void {
    for (const barrier of [...waiting]) {
      if (prompts.length >= barrier.count) {
        waiting.splice(waiting.indexOf(barrier), 1);
        barrier.settle();
      }
    }
  }

  function announceConsumed(): void {
    consumed += 1;
    for (const barrier of [...reading]) {
      if (consumed >= barrier.count) {
        reading.splice(reading.indexOf(barrier), 1);
        barrier.settle();
      }
    }
  }

  const fake: FakeAcp = {
    created,
    ensured,
    prompts,
    turns,
    decisions,
    closes,
    get started(): boolean {
      return started;
    },
    get cancels(): number {
      return cancels;
    },
    script(turn) {
      scripted.push(turn);
    },
    startedTurns(count) {
      return {
        *[Symbol.iterator]() {
          if (prompts.length >= count) {
            return;
          }
          const reached = withResolvers<void>();
          waiting.push({ count, settle: reached.resolve });
          yield* reached.operation;
        },
      };
    },
    consumedTurns(count) {
      return {
        *[Symbol.iterator]() {
          if (consumed >= count) {
            return;
          }
          const reached = withResolvers<void>();
          reading.push({ count, settle: reached.resolve });
          yield* reached.operation;
        },
      };
    },
    create(options) {
      created.push(options);
      return {
        doctor(): Promise<AcpRuntimeDoctorReport> {
          return Promise.resolve({ ok: true, message: "fake agent ready" });
        },
        ensureSession(input) {
          started = true;
          ensured.push(input);
          // Deferred materialization: the record occupies the key and asserts
          // nothing until a turn is accepted, so a workflow reading it sees
          // occupancy rather than a conversation.
          const deferred = input.materialization === "first-turn-acceptance";
          const identity = `agent-session:${input.sessionKey}`;
          const record: AcpSessionRecord = {
            schema: "acpx.session.v1",
            acpxRecordId: input.sessionKey,
            acpSessionId: `acp:${input.sessionKey}`,
            agentCommand: options.agentRegistry.resolve(input.agent),
            cwd: input.cwd ?? options.cwd,
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: "2026-01-01T00:00:00.000Z",
            lastSeq: 0,
            eventLog: { active_path: "", segment_count: 0, max_segment_bytes: 0, max_segments: 0 },
            messages: [],
            updated_at: "2026-01-01T00:00:00.000Z",
            cumulative_token_usage: {},
            request_token_usage: {},
          };
          if (deferred) {
            record.sessionMaterialization = {
              state: "pending",
              contract: "executablemd.session-materialization/v1",
            };
            withheld.set(input.sessionKey, identity);
          } else {
            record.agentSessionId = identity;
          }
          records.set(input.sessionKey, record);
          void options.sessionStore.save(record);
          const handle: AcpRuntimeHandle = {
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: input.sessionKey,
            cwd: input.cwd,
            acpxRecordId: input.sessionKey,
            backendSessionId: `acp:${input.sessionKey}`,
          };
          if (!deferred) {
            handle.agentSessionId = identity;
          }
          return Promise.resolve(handle);
        },
        startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
          prompts.push(input.text);
          turns.push(input);
          announceTurn();
          const turn = scripted.shift() ?? { reply: "" };
          const settled = withResolvers<AcpRuntimeTurnResult>();
          const released = withResolvers<void>();
          const recordKey = input.handle.acpxRecordId ?? input.handle.sessionKey;
          // A native promise rather than an Effection future: this is the acpx
          // boundary, and a turn nobody accepts leaves it unsettled — which as a
          // root task would be a pending operation the runner refuses to end on.
          let resolveMaterialized!: (value: AcpRuntimeMaterialization) => void;
          let rejectMaterialized!: (error: unknown) => void;
          const materialized = new Promise<AcpRuntimeMaterialization>((resolve, reject) => {
            resolveMaterialized = resolve;
            rejectMaterialized = reject;
          });
          // Observed here as the provider's own deferreds are, so a turn nobody
          // waited on cannot become an unhandled rejection.
          materialized.catch(() => {});
          const accept = (): void => {
            const identity = withheld.get(recordKey);
            const stored = records.get(recordKey);
            if (identity !== undefined && stored) {
              withheld.delete(recordKey);
              stored.sessionMaterialization = undefined;
              stored.agentSessionId = identity;
              void options.sessionStore.save(stored);
            }
            resolveMaterialized({
              acpxRecordId: recordKey,
              ...(identity === undefined
                ? {
                    ...(stored?.agentSessionId === undefined
                      ? {}
                      : { agentSessionId: stored.agentSessionId }),
                  }
                : { agentSessionId: identity }),
            });
          };
          if (turn.accepted === false) {
            rejectMaterialized(new Error("this session still awaits first-turn materialization"));
          } else {
            // Acceptance is not the turn's output: a backend takes the turn
            // before it says anything, so a manual turn reports it too.
            accept();
          }
          const events: AcpRuntimeEvent[] = [
            { type: "text_delta", text: turn.reply, stream: "output" },
          ];

          // The permission request happens before the reply streams, the way an
          // adapter reaching for a tool mid-turn does. Promise chaining rather
          // than `await`: this is the acpx callback boundary, and it is the one
          // place a Promise belongs.
          const asked = permissionAsked(options, input, turn, (outcome) => {
            decisions.push(outcome);
          });

          if (turn.manual) {
            // Nothing settles it. `cancel()` is the only way out.
            released.resolve();
          } else {
            void asked.then(() => {
              settled.resolve({
                status: "completed",
                stopReason: turn.stopReason ?? "end_turn",
                ...(turn.turnId === undefined ? {} : { _meta: { codex: { turnId: turn.turnId } } }),
              });
            });
          }

          return {
            requestId: input.requestId,
            materialized,
            events: {
              [Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
                let index = 0;
                let announced = false;
                return {
                  next(): Promise<IteratorResult<AcpRuntimeEvent>> {
                    if (!announced) {
                      announced = true;
                      announceConsumed();
                    }
                    if (turn.manual) {
                      // Never resolves: this turn is the one that gets
                      // interrupted.
                      return new Promise<IteratorResult<AcpRuntimeEvent>>(() => {});
                    }
                    return asked.then(() =>
                      index < events.length
                        ? { done: false, value: events[index++]! }
                        : { done: true, value: undefined },
                    );
                  },
                  return(): Promise<IteratorResult<AcpRuntimeEvent>> {
                    index = events.length;
                    return Promise.resolve({ done: true, value: undefined });
                  },
                };
              },
            },
            result: run(() => settled.operation),
            cancel(): Promise<void> {
              cancels += 1;
              settled.resolve({ status: "cancelled" });
              released.resolve();
              return Promise.resolve();
            },
            closeStream(): Promise<void> {
              return Promise.resolve();
            },
          };
        },
        runTurn(input: AcpRuntimeTurnInput) {
          return this.startTurn(input).events;
        },
        cancel(): Promise<void> {
          return Promise.resolve();
        },
        close(input?: { reason?: string }): Promise<void> {
          closes.push(input?.reason ?? "");
          return fake.closeFailure ? Promise.reject(fake.closeFailure) : Promise.resolve();
        },
      };
    },
  };
  return fake;
}

/** A runtime nothing may reach: reaching it at all is the observation. */
export function tripwireAcp(
  report: (what: string) => void,
): (options: AcpRuntimeOptions) => ProbeCapableRuntime {
  return function create(_options: AcpRuntimeOptions): ProbeCapableRuntime {
    report("createRuntime");
    function refuse<T>(what: string): Promise<T> {
      report(what);
      return Promise.reject(new Error(`a replay reached the agent provider: ${what}`));
    }
    return {
      doctor(): Promise<AcpRuntimeDoctorReport> {
        return refuse("doctor");
      },
      ensureSession(): Promise<AcpRuntimeHandle> {
        return refuse("ensureSession");
      },
      startTurn(): AcpRuntimeTurn {
        report("startTurn");
        throw new Error("a replay reached the agent provider: startTurn");
      },
      runTurn(): AsyncIterable<AcpRuntimeEvent> {
        report("runTurn");
        throw new Error("a replay reached the agent provider: runTurn");
      },
      cancel(): Promise<void> {
        return refuse("cancel");
      },
      close(): Promise<void> {
        return refuse("close");
      },
    };
  };
}
