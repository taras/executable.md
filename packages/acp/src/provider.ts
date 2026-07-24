/**
 * ACPX agent provider (specs/acp-client-spec.md §ACPX provider).
 *
 * The factory owns every resource it starts. The shared runtime is
 * created lazily on first use with the contextual cwd and validated
 * contextual timeout — nothing spawns at install time. Availability
 * validation uses a disposable probe runtime per agent: ACPX 0.12.0's
 * `probeAvailability()` only updates internal health, so `doctor()` is
 * used and `report.ok` inspected explicitly; ACPX closes the probe
 * client internally on both success and failure.
 *
 * Prompt subscriptions follow a fixed sequence — resolve identity,
 * acquire the session's FIFO lock, register permission routing, resolve
 * the effective timeout, start the turn — registering unconditional
 * cleanup for each resource as soon as it is acquired, and conditional
 * cancellation only once the turn exists. Provider teardown attempts
 * every remaining cancellation and every distinct handle close with an
 * all-settled strategy and throws the recorded failures from the
 * provider scope.
 */

import { createChannel, ensure, spawn, until, useScope, withResolvers } from "effection";
import type { Operation, Stream } from "effection";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, timeout as contextualTimeout } from "@executablemd/core";
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
import { cwd } from "@executablemd/runtime";

/** The runtime surface the provider needs — ACPX's runtime plus its probe. */
export interface ProbeCapableRuntime extends AcpRuntime {
  doctor(): Promise<AcpRuntimeDoctorReport>;
}

export interface AcpxProviderSeams {
  createRuntime?: (options: AcpRuntimeOptions) => ProbeCapableRuntime;
  sessionStore?: AcpSessionStore;
  agentRegistry?: AcpAgentRegistry;
}

interface ManagedSession {
  handle: AcpRuntimeHandle;
  agentCommand: string;
  cwd: string;
  session: Session;
}

interface Mutex {
  tail: Operation<void> | undefined;
}

/**
 * Per-sessionKey FIFO lock: each acquirer waits on its predecessor's
 * release, so same-session prompts run in submission order while
 * different sessions run concurrently.
 */
function* acquireLock(locks: Map<string, Mutex>, key: string): Operation<() => void> {
  let mutex = locks.get(key);
  if (!mutex) {
    mutex = { tail: undefined };
    locks.set(key, mutex);
  }
  const predecessor = mutex.tail;
  const mine = withResolvers<void>();
  mutex.tail = mine.operation;
  if (predecessor) {
    yield* predecessor;
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      mine.resolve();
    }
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The provider's operations, decoupled from the Agent Api install so
 * embedders (e.g. the test agent) can hold several independent states —
 * each with its own runtime, sessions, locks, and teardown — in sibling
 * scopes. Teardown registers in the calling scope.
 */
export interface AcpxProviderState {
  agent(name?: string): Operation<string>;
  session(option?: string | Session): Operation<Session>;
  promptStream(content: string, options?: PromptOptions): Stream<AgentPromptEvent, string>;
}

export function createAcpxProvider(seams?: AcpxProviderSeams): AgentProviderFactory {
  return function* (providerOptions: AgentProviderOptions): Operation<void> {
    const state = yield* useAcpxProviderState(providerOptions, seams);

    yield* Agent.around(
      {
        *agent([name], _next) {
          return yield* state.agent(name);
        },
        *session([name], _next) {
          return yield* state.session(name);
        },
        // deno-lint-ignore require-yield
        *prompt([content, options], _next) {
          return state.promptStream(content, options);
        },
      },
      { at: "min" },
    );
  };
}

export function* useAcpxProviderState(
  providerOptions: AgentProviderOptions,
  seams?: AcpxProviderSeams,
): Operation<AcpxProviderState> {
  const createRuntime = seams?.createRuntime ?? createAcpRuntime;
  const store = seams?.sessionStore ?? createRuntimeStore({ stateDir: join(homedir(), ".acpx") });
  const registry = seams?.agentRegistry ?? createAgentRegistry();
  const bridge = createPermissionBridge();

  let runtime: ProbeCapableRuntime | undefined;
  const validatedAgents = new Set<string>();
  const managed = new Map<string, ManagedSession>();
  const locks = new Map<string, Mutex>();
  const activeTurns = new Set<AcpRuntimeTurn>();
  const cleanupErrors: Error[] = [];

  function* runtimeOptions(): Operation<AcpRuntimeOptions> {
    const dir = yield* cwd();
    const timeoutMs = yield* contextualTimeout;
    return {
      cwd: dir,
      sessionStore: store,
      agentRegistry: registry,
      permissionMode: providerOptions.permissionMode,
      nonInteractivePermissions: "deny",
      timeoutMs,
    };
  }

  function* getRuntime(): Operation<ProbeCapableRuntime> {
    if (!runtime) {
      const base = yield* runtimeOptions();
      runtime = createRuntime({
        ...base,
        onPermissionRequest: (request, ctx) => bridge.onPermissionRequest(request, ctx),
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

  function* ensureManagedSession(
    agentName: string,
    name: string | undefined,
  ): Operation<ManagedSession> {
    const agentCommand = registry.resolve(agentName);
    const callerCwd = yield* cwd();
    const placement = yield* resolveSessionPlacement(store, agentCommand, callerCwd, name);
    const acp = yield* getRuntime();
    const handle = yield* until(
      acp.ensureSession({
        sessionKey: placement.sessionKey,
        agent: agentName,
        mode: "persistent",
        cwd: placement.cwd,
      }),
    );
    const session: Session = { sessionKey: placement.sessionKey, cwd: placement.cwd };
    if (handle.agentSessionId !== undefined) {
      session.agentSessionId = handle.agentSessionId;
    }
    const entry: ManagedSession = {
      handle,
      agentCommand,
      cwd: placement.cwd,
      session,
    };
    managed.set(placement.sessionKey, entry);
    return entry;
  }

  function* resolveManagedSession(
    agentName: string,
    option: string | Session | undefined,
  ): Operation<ManagedSession> {
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
      return entry;
    }
    return yield* ensureManagedSession(agentName, option);
  }

  function promptStream(
    content: string,
    options: PromptOptions | undefined,
  ): Stream<AgentPromptEvent, string> {
    return {
      *[Symbol.iterator]() {
        const agentName = yield* Agent.operations.agent(options?.agent);
        const entry = yield* resolveManagedSession(agentName, options?.session);

        const release = yield* acquireLock(locks, entry.session.sessionKey);
        yield* ensure(() => {
          release();
        });

        const scope = yield* useScope();
        const backendSessionId = entry.handle.backendSessionId;
        if (backendSessionId !== undefined) {
          const unregister = bridge.register(backendSessionId, scope, entry.session);
          yield* ensure(() => {
            unregister();
          });
        }

        const timeoutMs = options?.timeout ?? (yield* contextualTimeout);
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
      const entry = yield* resolveManagedSession(agentName, option);
      return entry.session;
    },
    promptStream,
  };
}
