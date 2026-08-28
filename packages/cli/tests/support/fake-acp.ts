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
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpSessionRecord,
  AcpxSessionStore,
  ProbeCapableRuntime,
} from "@executablemd/acp";

export function makeStore(): AcpxSessionStore & { records: Map<string, AcpSessionRecord> } {
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
   * Leave this turn unfinished until it is cancelled.
   *
   * How an interruption is modelled: the turn streams nothing and settles
   * nothing, so tearing the run's scope down leaves the journal holding exactly
   * the turns that had already committed.
   */
  readonly manual?: boolean;
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
  /** Every permission decision this fake was answered with. */
  readonly decisions: string[];
  /** Whether an agent process would have been started at all. */
  readonly started: boolean;
  script(turn: ScriptedTurn): void;
  /**
   * Settles once `count` turns have been started.
   *
   * A barrier rather than a delay: a test that halts a run mid-turn has to know
   * the turn it means to interrupt is actually in flight, and a sleep long
   * enough today is a flake on a slower machine.
   */
  startedTurns(count: number): Operation<void>;
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
  const created: AcpRuntimeOptions[] = [];
  const ensured: AcpRuntimeEnsureInput[] = [];
  const prompts: string[] = [];
  const decisions: string[] = [];
  const waiting: Array<{ count: number; settle: () => void }> = [];
  let started = false;

  function announceTurn(): void {
    for (const barrier of [...waiting]) {
      if (prompts.length >= barrier.count) {
        waiting.splice(waiting.indexOf(barrier), 1);
        barrier.settle();
      }
    }
  }

  const fake: FakeAcp = {
    created,
    ensured,
    prompts,
    decisions,
    get started(): boolean {
      return started;
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
    create(options) {
      created.push(options);
      return {
        doctor(): Promise<AcpRuntimeDoctorReport> {
          return Promise.resolve({ ok: true, message: "fake agent ready" });
        },
        ensureSession(input) {
          started = true;
          ensured.push(input);
          const record: AcpSessionRecord = {
            schema: "acpx.session.v1",
            acpxRecordId: input.sessionKey,
            acpSessionId: `acp:${input.sessionKey}`,
            agentSessionId: `agent-session:${input.sessionKey}`,
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
          void options.sessionStore.save(record);
          return Promise.resolve({
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: input.sessionKey,
            cwd: input.cwd,
            acpxRecordId: input.sessionKey,
            backendSessionId: `acp:${input.sessionKey}`,
            agentSessionId: `agent-session:${input.sessionKey}`,
          } satisfies AcpRuntimeHandle);
        },
        startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
          prompts.push(input.text);
          announceTurn();
          const turn = scripted.shift() ?? { reply: "" };
          const settled = withResolvers<AcpRuntimeTurnResult>();
          const released = withResolvers<void>();
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
                stopReason: "end_turn",
                ...(turn.turnId === undefined ? {} : { _meta: { codex: { turnId: turn.turnId } } }),
              });
            });
          }

          return {
            requestId: input.requestId,
            events: {
              [Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
                let index = 0;
                return {
                  next(): Promise<IteratorResult<AcpRuntimeEvent>> {
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
        close(): Promise<void> {
          return Promise.resolve();
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
