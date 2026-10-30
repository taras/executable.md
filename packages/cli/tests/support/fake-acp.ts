/**
 * A scriptable stand-in for the ACPX runtime, for driving a workflow Agent
 * without starting one.
 *
 * It implements the `acpx` runtime methods the provider actually calls, and
 * nothing else. Each scripted turn is one reply; a turn may also ask for a
 * native tool permission first, which is how the deny-and-fail path is driven
 * without an adapter that misbehaves on purpose.
 *
 * Session configuration is advertised the way an adapter advertises it — raw
 * `configOptions` selectors on a status read — and is held per session, because
 * that is where it lives: an inspection takes a session of its own and gives it
 * up, so a model written while inspecting must not be what a conversation is
 * then found to be running under.
 *
 * Promises appear only where the acpx boundary is defined in them.
 */

import { run, until, withResolvers } from "effection";
import { resolveAgentCommand } from "../../../acp/src/acpx-runtime.ts";
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

/** One cancellation this case is holding inside the provider's own teardown. */
export interface HeldCancellation {
  /** Settles once a cancellation has actually reached this hold. */
  readonly reached: Operation<void>;
  /** Let the teardown finish. */
  release(): void;
}

/** One scripted turn: what the agent says, and what it asks for first. */
export interface ScriptedTurn {
  /**
   * The reply text this turn streams, as one piece.
   *
   * Optional only for a turn that scripts its {@link ScriptedTurn.deltas}
   * instead, which is the same text delivered in the pieces it arrives in.
   */
  readonly reply?: string;
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
   * Hold this turn until the case releases it.
   *
   * Distinct from `manual`, which never settles and is the turn a case
   * interrupts. A held turn is generation genuinely in flight that the case
   * lets finish: acceptance is reported, nothing streams, and the reply and its
   * result arrive only once `releaseTurn` is called. It is the gate a row needs
   * to look at a busy Sidekick, because a sleep long enough today is a flake on
   * a slower machine.
   */
  readonly held?: boolean;
  /**
   * Whether the backend reports this turn cancelled after it has streamed.
   *
   * Distinct from `manual`: that turn never settles and is the one a test
   * interrupts, while this one settles the way an adapter reports a turn the
   * backend cancelled — keeping whatever text it had already streamed. It is how
   * a cancelled Prompt *record* is produced, which teardown cannot do: a run
   * that is being torn down appends nothing.
   */
  readonly cancelled?: boolean;
  /**
   * The pieces this turn streams, in order, instead of one whole `reply`.
   *
   * How a transport that arrives in chunks is modelled: a reader of this turn
   * sees each piece as it comes, and what the turn *returns* is all of them
   * joined — which is exactly what one `reply` produces when there is one
   * piece. A construct split across two of them is split in the transport, not
   * in the script.
   */
  readonly deltas?: readonly string[];
  /**
   * Hold this turn once it has streamed this many pieces.
   *
   * Generation genuinely in flight with text already said, which neither
   * `held` nor `manual` is: `held` says nothing before it is released and
   * `manual` never settles at all. A case releases it with
   * {@link FakeAcp.releaseDeltas}.
   */
  readonly holdAfter?: number;
  /**
   * Hold this turn before every piece after the first.
   *
   * For a case that reads what each prefix says: every boundary in the
   * transport becomes one the case steps through, rather than one chosen
   * boundary and then the rest arriving together.
   */
  readonly holdsEachPiece?: boolean;
  /**
   * The App Server turn this reply is, as an adapter that names its turns says
   * it: on this exact response's own `_meta`.
   *
   * Absent for an adapter that names none, which is how most of this suite's
   * turns answer.
   */
  readonly turnId?: string;
}

/** One value a scripted agent offers for a setting. */
export interface ScriptedChoice {
  /** The exact id a configuration names, which is what the provider writes. */
  readonly id: string;
  /** What the agent calls it for a reader, defaulting to its id. */
  readonly name?: string;
  readonly description?: string;
  /** The heading the agent filed it under, for an agent that groups its choices. */
  readonly group?: { readonly id: string; readonly name: string };
}

/** One setting a scripted agent advertises: what it is on, and what it offers. */
export interface ScriptedSetting {
  readonly selected: string;
  readonly choices: readonly ScriptedChoice[];
}

/**
 * What a scripted agent says about the two settings XMD configures.
 *
 * An omitted setting is advertised as nothing at all, which is how the agent
 * that offers no choice is driven — distinct from one that offers choices none
 * of which are yours.
 *
 * Effort is keyed by the model it belongs to, because effort levels are a
 * model's own: an agent asked about another model answers with that model's
 * levels. A flat list would make a refresh indistinguishable from a re-read,
 * which is the one thing a refresh has to be told apart from.
 */
export interface ScriptedConfiguration {
  readonly model?: ScriptedSetting;
  readonly effort?: Readonly<Record<string, ScriptedSetting>>;
}

/**
 * As much of a status read as this fake answers with.
 *
 * Spelled structurally rather than imported: ACPX's own status type is not part
 * of this package's public surface, and what the provider reads off a status is
 * exactly the selector list under `details`.
 */
interface ScriptedStatus {
  readonly details?: Record<string, unknown>;
}

/** What one session of this agent is running under right now. */
interface Running {
  model?: string;
  effort?: string;
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
   * Advertise this configuration to every session established from now on.
   *
   * Scripted rather than fixed because "this agent offers no model choice" and
   * "this agent offers these three" are different answers a case has to be able
   * to drive, and because an agent that cannot report at all is the state a
   * runtime with no `getStatus` already is.
   */
  configuration(advertised: ScriptedConfiguration | undefined): void;
  /**
   * Every configuration call this runtime received, in order.
   *
   * `status` for a read and `set <key>=<value>` for a write, so one assertion
   * can state the whole sequence a configured session went through — the
   * refresh between two writes included.
   */
  readonly configCalls: string[];
  /**
   * Refuse to establish a session for this agent, with this reason.
   *
   * How an unavailable agent is driven: the process cannot be started, so
   * nothing this agent is asked for answers — a configuration inspection and a
   * turn alike.
   */
  unavailable(agent: string, reason: Error): void;
  /**
   * Report this native conversation identity instead of a derived one.
   *
   * A transport fact a case controls. The derived identity is a function of the
   * session key, so two processes over one directory would assert the same one
   * whatever happened in between — which is the opposite of what a case about
   * reconciling an established identity needs to be able to vary.
   */
  identity(value: string): void;
  /** What one existing session is running under, by its key. */
  running(sessionKey: string): Running | undefined;
  /**
   * Settles once `count` session records carrying a native identity have been
   * saved to the store.
   *
   * A barrier rather than a delay. The runtime saves at the acpx boundary and
   * does not wait for it — `void store.save(...)` is what the real one does — so
   * a case that needs the provider's assertion to be *durable* has to observe
   * the write landing rather than assume it did. Reading the store without this
   * races it, and a sleep long enough today is a flake on a slower machine.
   */
  assertedSessions(count: number): Operation<void>;
  /**
   * Settles once `count` turns have been started.
   *
   * A barrier rather than a delay: a test that halts a run mid-turn has to know
   * the turn it means to interrupt is actually in flight, and a sleep long
   * enough today is a flake on a slower machine.
   */
  startedTurns(count: number): Operation<void>;
  /**
   * Hold the next status read until the case releases it.
   *
   * The seam a row about a *stale* inspection needs: an answer only matters
   * for the question it was asked about, and proving that an answer arriving
   * late changes nothing requires the answer to actually arrive late.
   */
  holdStatus(): HeldCancellation;
  /**
   * Hold every turn cancellation from now until it is released.
   *
   * The seam a Stop row needs: without it the provider's teardown comes down so
   * fast that a Stop which reported completion early and one which joined
   * properly look the same. The hold sits inside `cancel`, which is what the
   * provider awaits in its own cleanup.
   */
  holdCancellation(): HeldCancellation;
  /**
   * Settles once `count` held turns are waiting to be released.
   *
   * The barrier for "generation is in flight", which `startedTurns` is not: a
   * turn can be requested and answered in the same breath.
   */
  holdingTurns(count: number): Operation<void>;
  /**
   * Let the turn that has been held longest stream and settle.
   *
   * Refuses rather than doing nothing when none is held, because a row that
   * released a turn nobody was holding is a row whose script and whose
   * expectations disagree.
   */
  releaseTurn(): void;
  /**
   * Settles once `count` turns are holding partway through their pieces.
   *
   * The barrier for "this turn has said something and has not finished",
   * which is the state a live preview is read in.
   */
  streamingTurns(count: number): Operation<void>;
  /**
   * Let the turn that has been holding partway through longest carry on.
   *
   * Refuses rather than doing nothing when none is holding: a row that
   * released a turn nobody was holding is a row whose script and whose
   * expectations disagree.
   */
  releaseDeltas(): void;
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
  const configCalls: string[] = [];
  /** What each existing session is running under, by its own key. */
  const running = new Map<string, Running>();
  /** Agents whose session this runtime refuses to establish, by reason. */
  const refusals = new Map<string, Error>();
  let advertised: ScriptedConfiguration | undefined;
  /** The native identity every session of this runtime reports, when scripted. */
  let asserted: string | undefined;
  const waiting: Array<{ count: number; settle: () => void }> = [];
  /** Held turns, oldest first, each with the resolver that lets it go. */
  const holding: Array<() => void> = [];
  /** The cancellation hold a case installed, if it installed one. */
  let cancelling: { arrived(): void; waiting: Promise<void> } | undefined;
  /** The status read a case is holding, if it is holding one. */
  let statusHold: { arrived(): void; waiting: Promise<void> } | undefined;
  const held: Array<{ count: number; settle: () => void }> = [];
  /** Turns holding partway through their pieces, oldest first. */
  const streaming: Array<() => void> = [];
  const midstream: Array<{ count: number; settle: () => void }> = [];
  const reading: Array<{ count: number; settle: () => void }> = [];
  const asserting: Array<{ count: number; settle: () => void }> = [];
  let saved = 0;
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

  /**
   * Save one record, and say so once a native identity of its has landed.
   *
   * The call itself stays fire-and-forget, because that is what the runtime
   * does; what this adds is an observation of the write completing, for a case
   * that needs the assertion to have survived rather than to have been issued.
   */
  function store(sessionStore: AcpxSessionStore, record: AcpSessionRecord): void {
    const asserts = record.agentSessionId !== undefined;
    void Promise.resolve(sessionStore.save(record)).then(
      () => {
        if (!asserts) {
          return;
        }
        saved += 1;
        for (const barrier of [...asserting]) {
          if (saved >= barrier.count) {
            asserting.splice(asserting.indexOf(barrier), 1);
            barrier.settle();
          }
        }
      },
      () => {},
    );
  }

  function announceHeld(): void {
    for (const barrier of [...held]) {
      if (holding.length >= barrier.count) {
        held.splice(held.indexOf(barrier), 1);
        barrier.settle();
      }
    }
  }

  function announceStreaming(): void {
    for (const barrier of [...midstream]) {
      if (streaming.length >= barrier.count) {
        midstream.splice(midstream.indexOf(barrier), 1);
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

  /** One choice as ACP sends it, inside the group the agent filed it under. */
  function raw(choices: readonly ScriptedChoice[]): unknown[] {
    const sent: unknown[] = [];
    const groups = new Map<string, { options: unknown[] }>();
    for (const choice of choices) {
      const value = {
        value: choice.id,
        name: choice.name ?? choice.id,
        ...(choice.description === undefined ? {} : { description: choice.description }),
      };
      if (choice.group === undefined) {
        sent.push(value);
        continue;
      }
      let group = groups.get(choice.group.id);
      if (group === undefined) {
        // Pushed where the group first appears, so the order the provider reads
        // is the order this script wrote.
        group = { options: [] };
        groups.set(choice.group.id, group);
        sent.push({ group: choice.group.id, name: choice.group.name, options: group.options });
      }
      group.options.push(value);
    }
    return sent;
  }

  /**
   * The selectors this agent advertises to one session, as ACP sends them.
   *
   * Built per read rather than held as a list, because the effort selector a
   * read answers with belongs to the model that session is on: a status read
   * after a model write has to show the new model's levels, which a single
   * mutated list cannot do.
   */
  function selectors(sessionKey: string): Record<string, unknown>[] | undefined {
    if (advertised === undefined) {
      return undefined;
    }
    const state = running.get(sessionKey) ?? {};
    const sent: Record<string, unknown>[] = [];
    const model = state.model ?? advertised.model?.selected;
    if (advertised.model !== undefined) {
      sent.push({
        id: "model",
        category: "model",
        type: "select",
        currentValue: model,
        options: raw(advertised.model.choices),
      });
    }
    const effort = model === undefined ? undefined : advertised.effort?.[model];
    if (effort !== undefined) {
      sent.push({
        id: "effort",
        category: "thought_level",
        type: "select",
        currentValue: state.effort ?? effort.selected,
        options: raw(effort.choices),
      });
    }
    return sent;
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
    configCalls,
    configuration(scripted) {
      advertised = scripted;
    },
    unavailable(agent, reason) {
      refusals.set(agent, reason);
    },
    identity(value) {
      asserted = value;
    },
    running(sessionKey) {
      return running.get(sessionKey);
    },
    assertedSessions(count) {
      return {
        *[Symbol.iterator]() {
          if (saved >= count) {
            return;
          }
          const reached = withResolvers<void>();
          asserting.push({ count, settle: reached.resolve });
          yield* reached.operation;
        },
      };
    },
    holdingTurns(count) {
      return {
        *[Symbol.iterator]() {
          if (holding.length >= count) {
            return;
          }
          const reached = withResolvers<void>();
          held.push({ count, settle: reached.resolve });
          yield* reached.operation;
        },
      };
    },
    streamingTurns(count) {
      return {
        *[Symbol.iterator]() {
          if (streaming.length >= count) {
            return;
          }
          const reached = withResolvers<void>();
          midstream.push({ count, settle: reached.resolve });
          yield* reached.operation;
        },
      };
    },
    releaseDeltas() {
      const letGo = streaming.shift();
      if (letGo === undefined) {
        throw new Error("no turn of this fake agent is holding partway through its pieces");
      }
      letGo();
    },
    holdStatus(): HeldCancellation {
      let announce = (): void => {};
      let letGo = (): void => {};
      const arrival = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      statusHold = { arrived: announce, waiting };
      return {
        reached: {
          *[Symbol.iterator]() {
            yield* until(arrival);
          },
        },
        release: (): void => {
          letGo();
        },
      };
    },
    holdCancellation(): HeldCancellation {
      let announce = (): void => {};
      let letGo = (): void => {};
      const arrival = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      cancelling = { arrived: announce, waiting };
      return {
        reached: {
          *[Symbol.iterator]() {
            yield* until(arrival);
          },
        },
        release: (): void => {
          letGo();
        },
      };
    },
    releaseTurn() {
      const release = holding.shift();
      if (release === undefined) {
        throw new Error("no turn of this fake agent is being held, so there is none to release");
      }
      release();
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
          ensured.push(input);
          const refused = refusals.get(input.agent);
          if (refused !== undefined) {
            // Refused before anything is marked started, because an agent whose
            // process cannot be started was never started.
            return Promise.reject(refused);
          }
          started = true;
          // Deferred materialization: the record occupies the key and asserts
          // nothing until a turn is accepted, so a workflow reading it sees
          // occupancy rather than a conversation.
          const deferred = input.materialization === "first-turn-acceptance";
          const identity = asserted ?? `agent-session:${input.sessionKey}`;
          const record: AcpSessionRecord = {
            schema: "acpx.session.v1",
            acpxRecordId: input.sessionKey,
            acpSessionId: `acp:${input.sessionKey}`,
            agentCommand: resolveAgentCommand(options.agentRegistry, input.agent),
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
          store(options.sessionStore, record);
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
          // A turn nobody scripted is a case whose expectations and whose
          // script disagree, and answering it with an empty reply hides that:
          // an empty response is not something an agent produces, and a
          // workflow that treats it as one is being tested against a fiction.
          // Two `<Plan>` sites with one scripted reply silently gave the second
          // site "" for exactly this reason.
          const turn = scripted.shift();
          if (turn === undefined) {
            throw new Error(
              `the fake agent was asked for turn ${prompts.length} and only ` +
                `${prompts.length - 1} were scripted. Script one per turn the case expects. ` +
                `The unscripted prompt began: ${JSON.stringify(input.text.slice(0, 120))}`,
            );
          }
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
              store(options.sessionStore, stored);
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
          const events: AcpRuntimeEvent[] = (turn.deltas ?? [turn.reply ?? ""]).map((text) => ({
            type: "text_delta",
            text,
            stream: "output",
          }));

          // The permission request happens before the reply streams, the way an
          // adapter reaching for a tool mid-turn does. Promise chaining rather
          // than `await`: this is the acpx callback boundary, and it is the one
          // place a Promise belongs.
          const asked = permissionAsked(options, input, turn, (outcome) => {
            decisions.push(outcome);
          });
          /**
           * What this turn is waiting for before it says anything.
           *
           * The permission request alone for an ordinary turn, and the case's
           * own release after it for a held one — so a held turn has reported
           * acceptance and is producing nothing, which is what a busy Sidekick
           * is.
           */
          let allowed = asked;
          if (turn.held === true) {
            const letGo = new Promise<void>((resolve) => {
              holding.push(resolve);
            });
            announceHeld();
            allowed = asked.then(() => letGo);
          }
          // Observed here, as the provider's own deferreds are: a host that is
          // torn down while a request is pending rejects the operation behind
          // this promise, and an unobserved rejection would fail the runner
          // instead of being the ending the case is about.
          asked.catch(() => {});

          if (turn.manual) {
            // Nothing settles it. `cancel()` is the only way out.
            released.resolve();
          } else {
            void allowed.then(() => {
              if (turn.cancelled === true) {
                settled.resolve({ status: "cancelled" });
                return;
              }
              settled.resolve({
                status: "completed",
                stopReason: turn.stopReason ?? "end_turn",
                ...(turn.turnId === undefined ? {} : { _meta: { codex: { turnId: turn.turnId } } }),
              });
            });
          }

          return {
            requestId: input.requestId,
            promptStarted: Promise.resolve(),
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
                    // Partway through, and waiting. The pieces already read
                    // have been read; this one arrives when the case says so.
                    if (
                      (turn.holdAfter !== undefined && index === turn.holdAfter) ||
                      (turn.holdsEachPiece === true && index > 0 && index < events.length)
                    ) {
                      const letGo = new Promise<void>((resolve) => {
                        streaming.push(resolve);
                      });
                      announceStreaming();
                      return letGo.then(() =>
                        index < events.length
                          ? { done: false, value: events[index++]! }
                          : { done: true, value: undefined },
                      );
                    }
                    return allowed.then(() =>
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
              const hold = cancelling;
              if (hold === undefined) {
                return Promise.resolve();
              }
              hold.arrived();
              return hold.waiting;
            },
            closeStream(): Promise<void> {
              return Promise.resolve();
            },
          };
        },
        runTurn(input: AcpRuntimeTurnInput) {
          return this.startTurn(input).events;
        },
        getStatus(input: { handle: AcpRuntimeHandle }): Promise<ScriptedStatus> {
          configCalls.push("status");
          const sent = selectors(input.handle.sessionKey);
          const answer: ScriptedStatus =
            sent === undefined ? {} : { details: { configOptions: sent } };
          const held = statusHold;
          if (held === undefined) {
            return Promise.resolve(answer);
          }
          // One read at a time: a case holds the read it means to and the rest
          // of the session answers normally.
          statusHold = undefined;
          held.arrived();
          return held.waiting.then(() => answer);
        },
        setConfigOption(input: {
          handle: AcpRuntimeHandle;
          key: string;
          value: string;
        }): Promise<void> {
          configCalls.push(`set ${input.key}=${input.value}`);
          const state = running.get(input.handle.sessionKey) ?? {};
          if (input.key === "model") {
            state.model = input.value;
            // The new model's own default level. An agent that kept the old
            // one would be reporting a level the new model may not offer, and
            // the provider reads a current value that is not a choice as a
            // refusal rather than a value.
            state.effort = undefined;
          } else if (input.key === "effort") {
            state.effort = input.value;
          }
          running.set(input.handle.sessionKey, state);
          return Promise.resolve();
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
