/**
 * ACPX agent provider (specs/acp-client-spec.md §ACPX provider).
 *
 * The factory owns every resource it starts. The shared runtime is
 * created lazily on first use with the contextual cwd — nothing spawns at
 * install time, and no timeout is invented for a prompt nobody bounded.
 * Availability
 * validation uses a disposable probe runtime per agent: ACPX 0.12.0's
 * `probeAvailability()` only updates internal health, so `doctor()` is
 * used and `report.ok` inspected explicitly; ACPX closes the probe
 * client internally on both success and failure.
 *
 * Prompt subscriptions follow a fixed sequence — resolve identity,
 * acquire the session's FIFO lock, register permission routing, take the
 * caller's timeout if it has one, start the turn — registering unconditional
 * cleanup for each resource as soon as it is acquired, and conditional
 * cancellation only once the turn exists. Provider teardown attempts
 * every remaining cancellation and every distinct handle close with an
 * all-settled strategy and throws the recorded failures from the
 * provider scope.
 */

import { createChannel, ensure, scoped, spawn, until, useScope } from "effection";
import type { Operation, Stream } from "effection";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, AgentLaunchJournal } from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  AgentProviderOptions,
  DetachedLaunchRecord,
  InstructionReconciliation,
  ExitedLaunchRecord,
  LaunchFailure,
  LaunchOptions,
  PreparedLaunchRecord,
  PromptOptions,
  Session,
  SessionLaunchResult,
} from "@executablemd/core";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeDoctorReport,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpSessionRecord,
  AcpSessionStore,
} from "acpx/runtime";
import { createPermissionBridge } from "./permission-bridge.ts";
import { consumeTurn } from "./events.ts";
import { resolveSessionPlacement } from "./session-key.ts";
import { useSerialQueues } from "./serial-queue.ts";
import { cwd, nativeLaunch } from "@executablemd/runtime";
import {
  ADVERTISED_NATIVE_LAUNCH,
  knownNativeAdapters,
  nativeAdapterFor,
} from "./native-launch.ts";
import type { NativeAdapter } from "./native-launch.ts";

/** The runtime surface the provider needs — ACPX's runtime plus its probe. */
export interface ProbeCapableRuntime extends AcpRuntime {
  doctor(): Promise<AcpRuntimeDoctorReport>;
}

/** What `withSessionRoute` maps to a route: the registry-dependent inputs. */
export interface SessionRouteContext {
  agentName: string;
  session: string | Session | undefined;
  /** Normalized contextual cwd. */
  cwd: string;
}

/**
 * What the provider builds on. Each entry has a working default, so an
 * embedder supplies only what it replaces: the ACPX runtime, session store,
 * and agent registry, plus the hook that bounds registry-dependent work.
 */
export interface AcpxProviderDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => ProbeCapableRuntime;
  sessionStore?: AcpSessionStore;
  agentRegistry?: AcpAgentRegistry;
  /**
   * The native adapters this host has proven and is therefore willing to hand
   * a session to. Absent means none: knowing an adapter's command shape is not
   * evidence that its native UI resumes the session ACP created.
   */
  advertiseNativeLaunch?: readonly string[];
  /**
   * Extra native adapters, by agent name. A harness driving an agent this
   * package has never heard of supplies its own resume command shape here
   * rather than being special-cased in the adapter table.
   */
  nativeAdapters?: Readonly<Record<string, NativeAdapter>>;
  /**
   * Wraps registry-dependent work — session preparation AND
   * ensure/session validation + turn start — so an embedder can pin its
   * route for that critical section. `op` runs in the CALLER's scope
   * (no `scoped()`), so returned prompt resources belong to the
   * subscriber. The default invokes `op` directly.
   */
  withSessionRoute?: <T>(context: SessionRouteContext, op: () => Operation<T>) => Operation<T>;
}

interface ManagedSession {
  handle: AcpRuntimeHandle;
  agentCommand: string;
  cwd: string;
  session: Session;
  /**
   * True once a native UI took ownership of this session. The handle predates
   * that handoff, so nothing may prompt through it again: the next use
   * re-ensures the same session key, which reattaches ACP to the provider
   * session the native UI was working in.
   */
  stale?: boolean;
  /**
   * True once a turn has started against this session.
   *
   * Tracked here because ACPX's cached `messages` cannot answer the question:
   * native turns are deliberately never mirrored back, so an emptied or
   * never-populated cache says nothing about what the provider session holds.
   * Only a session this provider established and has since left completely
   * alone is known to be an empty shell.
   */
  used?: boolean;
}

/** Read-only session resolution; the placement linearization point. */
type Prepared =
  | { kind: "existing"; sessionKey: string; entry: ManagedSession }
  | {
      kind: "placement";
      sessionKey: string;
      agentCommand: string;
      placement: { sessionKey: string; cwd: string };
    };

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The provider identity retained in a launch record. */
const ACPX_PROVIDER = "acpx";

/** Where this provider puts prepared instructions on a session it creates. */
const INSTRUCTION_CHANNEL = "acp.session.systemPrompt";

/**
 * The provider's operations, decoupled from the Agent Api install so
 * embedders (e.g. the test agent) can hold several independent states —
 * each with its own runtime, sessions, locks, and teardown — in sibling
 * scopes. Teardown registers in the calling scope.
 */
export interface AcpxProvider {
  agent(name?: string): Operation<string>;
  session(option?: string | Session): Operation<Session>;
  promptStream(content: string, options?: PromptOptions): Stream<AgentPromptEvent, string>;
  launch(instructions: string, options?: LaunchOptions): Operation<SessionLaunchResult>;
}

export function createAcpxProvider(dependencies?: AcpxProviderDependencies): AgentProviderFactory {
  return function* (providerOptions: AgentProviderOptions): Operation<void> {
    const state = yield* useAcpxProvider(providerOptions, dependencies);

    yield* Agent.around(
      {
        *agent([name], _next) {
          return yield* state.agent(name);
        },
        *session([name], _next) {
          return yield* state.session(name);
        },
        *prompt([content, options], _next) {
          return state.promptStream(content, options);
        },
        *launch([instructions, options], _next) {
          return yield* state.launch(instructions, options);
        },
      },
      { at: "min" },
    );
  };
}

export function* useAcpxProvider(
  providerOptions: AgentProviderOptions,
  dependencies?: AcpxProviderDependencies,
): Operation<AcpxProvider> {
  const createRuntime = dependencies?.createRuntime ?? createAcpRuntime;
  const store =
    dependencies?.sessionStore ?? createRuntimeStore({ stateDir: join(homedir(), ".acpx") });
  const registry = dependencies?.agentRegistry ?? createAgentRegistry();
  const withSessionRoute =
    dependencies?.withSessionRoute ??
    (<T>(_c: SessionRouteContext, op: () => Operation<T>) => op());
  const advertised = new Set(dependencies?.advertiseNativeLaunch ?? ADVERTISED_NATIVE_LAUNCH);
  const extraAdapters = dependencies?.nativeAdapters;
  const adapterFor = (agentName: string): NativeAdapter | undefined => {
    if (extraAdapters && Object.hasOwn(extraAdapters, agentName)) {
      return extraAdapters[agentName];
    }
    return nativeAdapterFor(agentName);
  };
  const bridge = createPermissionBridge();
  const stateScope = yield* useScope();
  const turns = yield* useSerialQueues();

  let runtime: ProbeCapableRuntime | undefined;
  const validatedAgents = new Set<string>();
  const managed = new Map<string, ManagedSession>();
  const activeTurns = new Set<AcpRuntimeTurn>();
  const cleanupErrors: Error[] = [];

  function* runtimeOptions(): Operation<AcpRuntimeOptions> {
    const dir = yield* cwd();
    return {
      cwd: dir,
      sessionStore: store,
      agentRegistry: registry,
      permissionMode: providerOptions.permissionMode,
      nonInteractivePermissions: "deny",
    };
  }

  function* getRuntime(): Operation<ProbeCapableRuntime> {
    if (!runtime) {
      const base = yield* runtimeOptions();
      runtime = createRuntime({
        ...base,
        // The acpx callback boundary: `scope.run` returns a Promise-compatible
        // Future over the operation-based bridge decision.
        onPermissionRequest: (request, ctx) =>
          stateScope.run(() => bridge.decision(request, ctx.signal)),
      });
    }
    return runtime;
  }

  function* resolveAgent(name: string | undefined): Operation<string> {
    const selected = name ?? providerOptions.defaultAgent;
    if (!validatedAgents.has(selected)) {
      const base = yield* runtimeOptions();
      const probe = createRuntime({ ...base, probeAgent: selected });
      const report = yield* until(probe.doctor());
      if (!report.ok) {
        const code = report.code ? ` [${report.code}]` : "";
        const details = report.details?.length ? ` (${report.details.join("; ")})` : "";
        throw new Error(`agent "${selected}" is unavailable${code}: ${report.message}${details}`);
      }
      validatedAgents.add(selected);
    }
    return selected;
  }

  // Read-only session resolution. For a Session value it validates the
  // existing managed entry; otherwise it derives the placement (the
  // nearest-existing session), so the RESOLVED sessionKey — not the
  // caller cwd — becomes the session-queue key.
  function* prepare(
    agentName: string,
    option: string | Session | undefined,
    callerCwd: string,
  ): Operation<Prepared> {
    if (typeof option === "object") {
      const entry = managed.get(option.sessionKey);
      if (!entry) {
        throw new Error(
          `unknown or stale agent session "${option.sessionKey}" — a Session value must ` +
            `come from this provider's session()`,
        );
      }
      const agentCommand = registry.resolve(agentName);
      if (agentCommand !== entry.agentCommand) {
        throw new Error(
          `agent "${agentName}" (${agentCommand}) does not match session ` +
            `"${option.sessionKey}" (${entry.agentCommand})`,
        );
      }
      if (entry.stale) {
        // The handle predates a native handoff. Reaching for the same key
        // again re-ensures it, which is a reattach to the provider session the
        // native UI left behind rather than a connection older than it.
        return {
          kind: "placement",
          sessionKey: entry.session.sessionKey,
          agentCommand: entry.agentCommand,
          placement: { sessionKey: entry.session.sessionKey, cwd: entry.cwd },
        };
      }
      return { kind: "existing", sessionKey: option.sessionKey, entry };
    }
    const agentCommand = registry.resolve(agentName);
    const placement = yield* resolveSessionPlacement(store, agentCommand, callerCwd, option);
    return { kind: "placement", sessionKey: placement.sessionKey, agentCommand, placement };
  }

  function* ensureFromPrepared(agentName: string, prepared: Prepared): Operation<ManagedSession> {
    if (prepared.kind === "existing") {
      return prepared.entry;
    }
    const acp = yield* getRuntime();
    const handle = yield* until(
      acp.ensureSession({
        sessionKey: prepared.placement.sessionKey,
        agent: agentName,
        mode: "persistent",
        cwd: prepared.placement.cwd,
      }),
    );
    const session: Session = {
      sessionKey: prepared.placement.sessionKey,
      cwd: prepared.placement.cwd,
    };
    if (handle.agentSessionId !== undefined) {
      session.agentSessionId = handle.agentSessionId;
    }
    const entry: ManagedSession = {
      handle,
      agentCommand: prepared.agentCommand,
      cwd: prepared.placement.cwd,
      session,
    };
    managed.set(prepared.sessionKey, entry);
    return entry;
  }

  function promptStream(
    content: string,
    options: PromptOptions | undefined,
  ): Stream<AgentPromptEvent, string> {
    return {
      *[Symbol.iterator]() {
        const agentName = yield* Agent.operations.agent(options?.agent);
        const callerCwd = resolve(yield* cwd());
        const context: SessionRouteContext = {
          agentName,
          session: options?.session,
          cwd: callerCwd,
        };

        const prepared = yield* withSessionRoute(context, () =>
          prepare(agentName, options?.session, callerCwd),
        );

        yield* turns.slot(prepared.sessionKey);

        return yield* withSessionRoute(context, function* () {
          const entry = yield* ensureFromPrepared(agentName, prepared);
          // From here this session has been spoken to, whatever the cache
          // later says, so nothing may discard it to install a new layer.
          entry.used = true;

          const scope = yield* useScope();
          const recordKey = entry.handle.acpxRecordId ?? entry.session.sessionKey;
          // Route by the record's ACP session id, refreshed on demand so
          // a reconnect that updates the record mid-turn (ACPX
          // checkpoints it before the prompt runs) still routes to this
          // scope's policy.
          const refresh = () =>
            (function* () {
              const record = yield* until(store.load(recordKey));
              if (!record) {
                return undefined;
              }
              return { acpSessionId: record.acpSessionId, agentSessionId: record.agentSessionId };
            })();
          const initial = yield* refresh();
          if (initial?.agentSessionId !== undefined) {
            entry.session.agentSessionId = initial.agentSessionId;
          }
          const activeSessionId = initial?.acpSessionId ?? entry.handle.backendSessionId;
          if (activeSessionId !== undefined) {
            const registration = bridge.register(activeSessionId, scope, entry.session, refresh);
            yield* ensure(() => {
              registration.unregister();
            });
          }

          const timeoutMs = options?.timeout;
          const acp = yield* getRuntime();
          const turn = acp.startTurn({
            handle: entry.handle,
            text: content,
            mode: "prompt",
            requestId: randomUUID(),
            timeoutMs,
          });
          activeTurns.add(turn);
          let completed = false;
          yield* ensure(function* () {
            activeTurns.delete(turn);
            if (!completed) {
              try {
                yield* until(turn.cancel());
              } catch (error) {
                cleanupErrors.push(toError(error));
              }
            }
          });

          const channel = createChannel<AgentPromptEvent, string>();
          const subscription = yield* channel;
          yield* spawn(() =>
            consumeTurn(turn, { agent: agentName, session: entry.session }, channel, () => {
              completed = true;
            }),
          );
          return subscription;
        });
      },
    };
  }

  function refusal(
    failureClass: LaunchFailure["class"],
    message: string,
    known: Partial<PreparedLaunchRecord> = {},
  ): PreparedLaunchRecord {
    return {
      phase: "prepared",
      agent: "",
      sessionKey: "",
      provider: ACPX_PROVIDER,
      nativeSessionId: "",
      sessionState: "created",
      instructionChannel: INSTRUCTION_CHANNEL,
      instructionReconciliation: "installed",
      instructionsDigest: "",
      instructions: "",
      cwd: "",
      additionalDirectories: [],
      permissionMode: providerOptions.permissionMode,
      launcher: "",
      ...known,
      failure: { class: failureClass, message },
    };
  }

  function storedSystemPrompt(record: AcpSessionRecord | undefined): string | undefined {
    const stored = record?.acpx?.session_options?.system_prompt;
    if (typeof stored === "string") {
      return stored;
    }
    if (stored && typeof stored === "object") {
      return stored.append;
    }
    return undefined;
  }

  /**
   * Prepare one durable session and report the identity the native UI will be
   * handed.
   *
   * Everything refusable is refused here, while ACP still owns the session: an
   * agent with no proven native launcher, an instruction layer this provider
   * cannot put in force, and a session whose provider-native identity the
   * adapter never asserted.
   */
  function* prepareLaunch(
    agentName: string,
    callerCwd: string,
    instructions: string,
    prepared: Prepared,
  ): Operation<PreparedLaunchRecord> {
    const adapter = adapterFor(agentName);
    if (!adapter || !advertised.has(agentName)) {
      const known = knownNativeAdapters().join(", ");
      return refusal(
        "unsupported-capability",
        `agent "${agentName}" is not advertised as native-launch capable. An adapter ` +
          `is advertised only once its integration proof shows the native UI resumes ` +
          `the session ACP created and the prepared instructions are in force on its ` +
          `first turn. Adapters with a known command shape: ${known || "none"}.`,
        { agent: agentName, cwd: callerCwd },
      );
    }

    const sessionKey = prepared.sessionKey;
    const sessionCwd = prepared.kind === "existing" ? prepared.entry.cwd : prepared.placement.cwd;
    const agentCommand =
      prepared.kind === "existing" ? prepared.entry.agentCommand : prepared.agentCommand;
    const acp = yield* getRuntime();
    const existing = yield* until(store.load(sessionKey));
    let sessionState: "created" | "resumed" = existing ? "resumed" : "created";
    let reconciliation: InstructionReconciliation = existing ? "resumed" : "installed";

    if (existing && storedSystemPrompt(existing) !== instructions) {
      // ACPX fixes a session's instruction layer when its ACP session is
      // created, so an existing session's layer cannot simply be replaced.
      // What that protects is the conversation the session holds, and only a
      // session this provider established and never used is known to hold
      // none. The ordinary authoring shape is exactly that: `<Session name>`
      // establishes the shell, and the `<Session.Launch>` inside it is its
      // first real use.
      //
      // An empty `messages` cache proves nothing on its own. Native turns are
      // never mirrored back into ACPX, so a session handed to a native UI and
      // worked in for an hour still reads as empty — and discarding it on that
      // evidence would destroy conversation XMD does not own and cannot see.
      const entry = managed.get(sessionKey);
      const untouched = entry !== undefined && entry.stale !== true && entry.used !== true;
      const conversation = existing.messages?.length ?? 0;
      if (!untouched || conversation > 0) {
        return refusal(
          "instructions-refused",
          `session "${sessionKey}" already carries a different XMD instruction layer, ` +
            `and this provider cannot replace one on a session that has been used. ` +
            `Launch a differently named <Session>, or launch the same prepared ` +
            `instructions again.`,
          { agent: agentName, sessionKey, cwd: sessionCwd, launcher: adapter.launcher },
        );
      }
      try {
        yield* until(
          acp.close({
            handle: entry.handle,
            reason: "installing the prepared instruction layer",
            discardPersistentState: true,
          }),
        );
      } catch (error) {
        return refusal("instructions-refused", toError(error).message, {
          agent: agentName,
          sessionKey,
          cwd: sessionCwd,
          launcher: adapter.launcher,
        });
      }
      managed.delete(sessionKey);
      sessionState = "created";
      reconciliation = "recreated";
    }

    const handle = yield* until(
      acp.ensureSession({
        sessionKey,
        agent: agentName,
        mode: "persistent",
        cwd: sessionCwd,
        sessionOptions: { systemPrompt: instructions },
      }),
    );

    const session: Session = { sessionKey, cwd: sessionCwd };
    if (handle.agentSessionId !== undefined) {
      session.agentSessionId = handle.agentSessionId;
    }
    managed.set(sessionKey, { handle, agentCommand, cwd: sessionCwd, session });

    const nativeSessionId = handle.agentSessionId;
    if (nativeSessionId === undefined) {
      // An ACP session id and an ACPX record id are not native identities, and
      // neither is a string that merely looks like one.
      return refusal(
        "identity-unavailable",
        `agent "${agentName}" created a session but asserted no provider-native ` +
          `session identity, so there is nothing ${adapter.launcher} can resume`,
        { agent: agentName, sessionKey, cwd: sessionCwd, launcher: adapter.launcher },
      );
    }

    const record: PreparedLaunchRecord = {
      phase: "prepared",
      agent: agentName,
      sessionKey,
      provider: ACPX_PROVIDER,
      nativeSessionId,
      sessionState,
      instructionChannel: INSTRUCTION_CHANNEL,
      instructionReconciliation: reconciliation,
      instructionsDigest: createHash("sha256").update(instructions).digest("hex"),
      instructions,
      cwd: sessionCwd,
      additionalDirectories: [],
      permissionMode: providerOptions.permissionMode,
      launcher: adapter.launcher,
    };
    const model = yield* effectiveModel(acp, handle);
    if (model !== undefined) {
      record.model = model;
    }
    return record;
  }

  function* effectiveModel(
    acp: ProbeCapableRuntime,
    handle: AcpRuntimeHandle,
  ): Operation<string | undefined> {
    if (!acp.getStatus) {
      return undefined;
    }
    const status = yield* until(acp.getStatus({ handle }));
    return status.models?.currentModelId;
  }

  /** Release ACP ownership. Nothing is spawned until this has completed. */
  function* detachSession(sessionKey: string): Operation<DetachedLaunchRecord> {
    const entry = managed.get(sessionKey);
    if (!entry || entry.stale) {
      // Nothing of this provider's owns the session. A resumed launch reaches
      // here with no live ACP connection at all, which is the state detaching
      // exists to produce.
      return { phase: "detached" };
    }
    try {
      const acp = yield* getRuntime();
      // Not `discardPersistentState`: the record is exactly what the native UI
      // is about to resume.
      yield* until(acp.close({ handle: entry.handle, reason: "native session launch" }));
    } catch (error) {
      return {
        phase: "detached",
        failure: { class: "detach-failed", message: toError(error).message },
      };
    }
    entry.stale = true;
    return { phase: "detached" };
  }

  function launch(instructions: string, options?: LaunchOptions): Operation<SessionLaunchResult> {
    return scoped(function* (): Operation<SessionLaunchResult> {
      const agentName = yield* Agent.operations.agent(options?.agent);
      const callerCwd = resolve(yield* cwd());
      const context: SessionRouteContext = {
        agentName,
        session: options?.session,
        cwd: callerCwd,
      };

      const placement = yield* withSessionRoute(context, () =>
        prepare(agentName, options?.session, callerCwd),
      );

      // Held from preparation through the native child's exit: while a native
      // UI owns this session, nothing else may run a turn against it.
      yield* turns.slot(placement.sessionKey);

      const prepared = yield* AgentLaunchJournal.operations.recordPreparation(() =>
        withSessionRoute(context, () =>
          prepareLaunch(agentName, callerCwd, instructions, placement),
        ),
      );

      yield* AgentLaunchJournal.operations.recordDetach(() => detachSession(prepared.sessionKey));

      const adapter = adapterFor(prepared.agent);
      yield* AgentLaunchJournal.operations.recordExit(function* (): Operation<ExitedLaunchRecord> {
        if (!adapter) {
          return {
            phase: "exited",
            failure: {
              class: "process-creation-failed",
              message: `no native launcher adapter for agent "${prepared.agent}"`,
            },
          };
        }
        try {
          const outcome = yield* nativeLaunch({
            command: adapter.resume(prepared.nativeSessionId),
            cwd: prepared.cwd,
          });
          const exited: ExitedLaunchRecord = { phase: "exited" };
          if (outcome.exitCode !== undefined) {
            exited.exitCode = outcome.exitCode;
          }
          if (outcome.signal !== undefined) {
            exited.signal = outcome.signal;
          }
          return exited;
        } catch (error) {
          return {
            phase: "exited",
            failure: { class: "process-creation-failed", message: toError(error).message },
          };
        }
      });

      return {
        agent: prepared.agent,
        session: {
          sessionKey: prepared.sessionKey,
          cwd: prepared.cwd,
          agentSessionId: prepared.nativeSessionId,
        },
        nativeSessionId: prepared.nativeSessionId,
        launcher: prepared.launcher,
      };
    });
  }

  yield* ensure(function* () {
    for (const turn of [...activeTurns]) {
      activeTurns.delete(turn);
      try {
        yield* until(turn.cancel());
      } catch (error) {
        cleanupErrors.push(toError(error));
      }
    }
    if (runtime) {
      const closedHandles = new Set<string>();
      for (const entry of managed.values()) {
        // A handle a native UI took over is not this provider's to close, and
        // skipping it leaves every unrelated cleanup below still attempted.
        if (entry.stale) {
          continue;
        }
        const handleKey = entry.handle.acpxRecordId ?? entry.handle.sessionKey;
        if (closedHandles.has(handleKey)) {
          continue;
        }
        closedHandles.add(handleKey);
        try {
          yield* until(runtime.close({ handle: entry.handle, reason: "scope teardown" }));
        } catch (error) {
          cleanupErrors.push(toError(error));
        }
      }
    }
    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "agent provider teardown failed");
    }
  });

  return {
    *agent(name) {
      return yield* resolveAgent(name);
    },
    *session(option) {
      const agentName = yield* Agent.operations.agent();
      const callerCwd = resolve(yield* cwd());
      const context: SessionRouteContext = { agentName, session: option, cwd: callerCwd };
      const prepared = yield* withSessionRoute(context, () =>
        prepare(agentName, option, callerCwd),
      );
      return yield* turns.withSlot(prepared.sessionKey, () =>
        withSessionRoute(context, function* () {
          const entry = yield* ensureFromPrepared(agentName, prepared);
          return entry.session;
        }),
      );
    },
    promptStream,
    launch,
  };
}
