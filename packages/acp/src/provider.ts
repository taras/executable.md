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

import { createChannel, ensure, spawn, until, useScope } from "effection";
import type { Operation, Stream } from "effection";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  AgentProviderOptions,
  PromptOptions,
  Session,
} from "@executablemd/core";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeDoctorReport,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpSessionStore,
} from "acpx/runtime";
import { createPermissionBridge } from "./permission-bridge.ts";
import { consumeTurn } from "./events.ts";
import { resolveSessionPlacement } from "./session-key.ts";
import { useSerialQueues } from "./serial-queue.ts";
import { cwd } from "@executablemd/runtime";

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
  };
}
