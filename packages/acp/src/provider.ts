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

import {
  createChannel,
  ensure,
  scoped,
  spawn,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Scope, Stream } from "effection";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, AgentLaunchJournal, LaunchResolution, resolvingLaunch } from "@executablemd/core";
import type {
  AgentPromptEvent,
  AgentProviderFactory,
  AgentProviderOptions,
  DetachedLaunchRecord,
  ExecutableBuildBindingV1,
  InstructionReconciliation,
  ExitedLaunchRecord,
  LaunchFailure,
  LaunchOptions,
  PreparedLaunchRecord,
  PromptOptions,
  Session,
  SessionLaunchResult,
} from "@executablemd/core";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "./acpx-runtime.ts";
import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeDoctorReport,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpSessionRecord,
  AcpSessionStore,
} from "./acpx-runtime.ts";
import { createPermissionBridge } from "./permission-bridge.ts";
import { consumeTurn } from "./events.ts";
import { resolveSessionPlacement } from "./session-key.ts";
import { useSerialQueues } from "./serial-queue.ts";
import { cwd, nativeLaunch } from "@executablemd/runtime";
import {
  ADVERTISED_NATIVE_LAUNCH,
  knownNativeAdapters,
  nativeAdapterFor,
  pinnedAdapterCommands,
} from "./native-launch.ts";
import type { NativeAdapter, NativeBinding } from "./native-launch.ts";
import { createSessionRouteStore, NativeSessionConflict } from "./native-session-store.ts";
import type { ClientNativeRoute, SessionRoute, SessionRouteStore } from "./native-session-store.ts";
import { SessionLease } from "@executablemd/runtime";
import type { SessionLeaseOutcome } from "@executablemd/runtime";
import { SessionBusy, sessionLeaseKey, SessionOwnershipUnavailable } from "./session-ownership.ts";
import {
  ExecutableBindingRefused,
  observeBuild,
  requireRetainedBuild,
} from "./executable-build.ts";
import { sameExecutableBuild } from "@executablemd/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

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
   * Where this provider retains the native identities it allocated. Defaults
   * to a store beneath the ACPX state root, versioned separately from ACPX's
   * own records so clearing one never silently clears the other.
   */
  nativeSessionStore?: SessionRouteStore;
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
  /** Which runtime partition this session's handle belongs to. */
  partition: RuntimePartition;
  /**
   * True once a native UI took ownership of this session. The handle predates
   * that handoff, so nothing may prompt through it again: the next use
   * re-ensures the same session key, which reattaches ACP to the provider
   * session the native UI was working in.
   */
  stale?: boolean;
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
 * One runtime and the children it may spawn.
 *
 * Partitioning exists because a runtime's agent children inherit its bound
 * executable, and two sessions bound to different builds must never share one.
 * A shared runtime would hand a session to the wrong build without failing —
 * the exact silent substitution the binding exists to prevent.
 *
 * The key is the agent command plus the retained build, so an unbound session
 * and a bound one are different partitions even for the same agent.
 */
interface RuntimePartition {
  key: string;
  agentProcessEnv?: Record<string, string>;
}

function unboundPartition(agentCommand: string): RuntimePartition {
  return { key: agentCommand };
}

function boundPartition(
  agentCommand: string,
  binding: ExecutableBuildBindingV1,
  environment: Record<string, string>,
): RuntimePartition {
  return {
    key: `${agentCommand}\u0000${binding.reportedVersion}\u0000${binding.executableDigest.value}`,
    agentProcessEnv: environment,
  };
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
  // Bound adapters pin their own ACP adapter command. Without the override
  // ACPX resolves Claude through its built-in `^0.37.0` range, which can
  // select a different adapter than the one #519's gates were proven against —
  // and the behavior those gates measured is exactly adapter behavior.
  const registry =
    dependencies?.agentRegistry ??
    createAgentRegistry({ overrides: pinnedAdapterCommands(dependencies?.nativeAdapters ?? {}) });
  const routes =
    dependencies?.nativeSessionStore ??
    createSessionRouteStore(join(homedir(), ".acpx", "xmd-native-sessions", "v1"));
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

  const runtimes = new Map<string, ProbeCapableRuntime>();
  // Availability is a property of an agent under a partition, not of a name:
  // the same agent bound to a different build is a different question.
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

  function* getRuntime(partition: RuntimePartition): Operation<ProbeCapableRuntime> {
    const existing = runtimes.get(partition.key);
    if (existing) {
      return existing;
    }
    const base = yield* runtimeOptions();
    const options: AcpRuntimeOptions = {
      ...base,
      // The acpx callback boundary: `scope.run` returns a Promise-compatible
      // Future over the operation-based bridge decision.
      onPermissionRequest: (request, ctx) =>
        stateScope.run(() => bridge.decision(request, ctx.signal)),
    };
    if (partition.agentProcessEnv !== undefined) {
      // Transient: it reaches the children this runtime spawns and nothing
      // else — not this process, not a session record, not a diagnostic.
      options.agentProcessEnv = partition.agentProcessEnv;
    }
    const created = createRuntime(options);
    runtimes.set(partition.key, created);
    return created;
  }

  /**
   * The build an availability probe should run, observed once per provider
   * scope.
   *
   * Memoized because availability is asked on every prompt and hashing an
   * executable is not free. The decisions that matter — establishing a binding
   * and spawning under one — deliberately do not use this: they observe again,
   * so a build that changed underneath a long-running document is caught where
   * catching it still means something.
   *
   * A build that cannot be observed raises. Deferring that is the launch
   * path's business, and a launch never reaches this function.
   */
  const availabilityBuilds = new Map<string, RuntimePartition>();

  function* availabilityPartition(
    agentName: string,
    agentCommand: string,
  ): Operation<RuntimePartition | undefined> {
    const declared = bindingOf(agentName);
    if (!declared) {
      return undefined;
    }
    const cached = availabilityBuilds.get(agentName);
    if (cached) {
      return cached;
    }
    // A refusal propagates. Only a launch defers this question, and a launch
    // returns before reaching here — so anything that arrives is an ordinary
    // caller asking whether the agent is available, and "its executable cannot
    // be validated" is that caller's answer. Returning the name instead would
    // report an agent as available on the strength of not having been able to
    // check.
    const observed = yield* observeBuild(declared.adapter.launcher, declared.binding);
    const partition = boundPartition(
      agentCommand,
      observed.binding,
      declared.binding.environment(observed.livePath),
    );
    availabilityBuilds.set(agentName, partition);
    return partition;
  }

  function* resolveAgent(
    name: string | undefined,
    partition?: RuntimePartition,
  ): Operation<string> {
    const selected = name ?? providerOptions.defaultAgent;
    const cacheKey = `${partition?.key ?? ""}\u0000${selected}`;
    if (!validatedAgents.has(cacheKey)) {
      const base = yield* runtimeOptions();
      const probeOptions: AcpRuntimeOptions & { probeAgent: string } = {
        ...base,
        probeAgent: selected,
      };
      if (partition?.agentProcessEnv !== undefined) {
        // The availability probe must ask the same build session creation
        // will use, or it answers a question nobody asked.
        probeOptions.agentProcessEnv = partition.agentProcessEnv;
      }
      const probe = createRuntime(probeOptions);
      const report = yield* until(probe.doctor());
      if (!report.ok) {
        const code = report.code ? ` [${report.code}]` : "";
        const details = report.details?.length ? ` (${report.details.join("; ")})` : "";
        throw new Error(`agent "${selected}" is unavailable${code}: ${report.message}${details}`);
      }
      validatedAgents.add(cacheKey);
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

  /**
   * Lease keys this provider currently owns, and how many of its scopes are
   * inside each.
   *
   * The lease decides ownership between processes. Inside one provider it is
   * already decided, and asking the kernel a second time would only make this
   * provider contend with itself — a `<Prompt>` inside the `<Session>` that
   * established the session would refuse as busy against its own lease. So a
   * nested asker is admitted, and the lease is released once the outermost
   * scope holding it closes.
   */
  const owned = new Map<string, number>();

  function releaseOwnership(key: string): void {
    const depth = (owned.get(key) ?? 1) - 1;
    if (depth <= 0) {
      owned.delete(key);
      return;
    }
    owned.set(key, depth);
  }

  /**
   * Take exclusive live ownership for the calling scope, or say why not.
   *
   * Asked once and never waited on. A native UI can stay open for hours, so a
   * caller that queued would hold the user's terminal with no way to reach the
   * owner it was waiting for.
   */
  function* ownSession(agentName: string, sessionKey: string): Operation<SessionLeaseOutcome> {
    const key = sessionLeaseKey(mappingKey(agentName, sessionKey));
    const depth = owned.get(key);
    if (depth !== undefined) {
      owned.set(key, depth + 1);
      yield* ensure(() => releaseOwnership(key));
      return "acquired";
    }
    const outcome = yield* SessionLease.operations.acquire(key);
    if (outcome !== "acquired") {
      return outcome;
    }
    // Registered after the lease resource, so this runs before the lock is
    // given up rather than after it.
    owned.set(key, 1);
    yield* ensure(() => releaseOwnership(key));
    return outcome;
  }

  /**
   * Take ownership that outlives the operation asking for it.
   *
   * A launch asks during preparation, but the native child, its terminal
   * recovery and the private instruction file all outlive that phase — and a
   * replayed launch performs no phase at all, so the request cannot simply be
   * moved outward. Acquiring inside a task spawned into the launch's own scope
   * puts the release exactly where the launch ends, whether it ends by
   * returning, failing or being cancelled.
   */
  function* ownSessionWithin(
    scope: Scope,
    agentName: string,
    sessionKey: string,
  ): Operation<SessionLeaseOutcome> {
    const settled = withResolvers<SessionLeaseOutcome>();
    yield* scope.spawn(function* () {
      let outcome: SessionLeaseOutcome;
      try {
        outcome = yield* ownSession(agentName, sessionKey);
      } catch (error) {
        settled.reject(toError(error));
        return;
      }
      settled.resolve(outcome);
      if (outcome === "acquired") {
        yield* suspend();
      }
    });
    return yield* settled.operation;
  }

  /**
   * Why a phase resuming a client-native launch may not act.
   *
   * A launch that reaches a live phase past a retained `prepared` has done no
   * ownership check yet — the phase that would have done it never ran. Asking
   * here is what stops a replay from spawning a second native UI into a
   * session someone else is already in.
   */
  function* refuseUnowned(
    prepared: PreparedLaunchRecord,
    own: (sessionKey: string) => Operation<SessionLeaseOutcome>,
  ): Operation<LaunchFailure | undefined> {
    if (prepared.identityProvenance !== "client-allocated") {
      return undefined;
    }
    const outcome = yield* own(prepared.sessionKey);
    if (outcome === "acquired") {
      return undefined;
    }
    if (outcome === "busy") {
      return {
        class: "session-busy",
        message:
          `another XMD owner is using session "${prepared.sessionKey}" — a native UI ` +
          `or a turn in another process holds it. Run this again once that owner exits.`,
      };
    }
    return {
      class: "unsupported-capability",
      message:
        `this host installs no way to take exclusive ownership of a native agent ` +
        `session, so it cannot hand one to ${prepared.launcher}. Deno and the compiled ` +
        `binary can.`,
    };
  }

  /** The adapter's binding declaration, when it has one. */
  function bindingOf(
    agentName: string,
  ): { adapter: NativeAdapter; binding: NativeBinding } | undefined {
    const adapter = adapterFor(agentName);
    return adapter?.binding ? { adapter, binding: adapter.binding } : undefined;
  }

  function mappingKey(agentName: string, sessionKey: string) {
    return { provider: ACPX_PROVIDER, agent: agentName, sessionKey };
  }

  /**
   * What a retained native identity requires before it can be reached again.
   *
   * Reattachment revalidates the build first, so a session established by a
   * different one is refused here rather than silently resumed through
   * whatever is installed now. Only after that does it select the partition
   * whose children run the build the session was created by.
   */
  interface BoundSession {
    route: ClientNativeRoute;
    partition: RuntimePartition;
  }

  function* boundSession(
    agentName: string,
    sessionKey: string,
    agentCommand: string,
  ): Operation<BoundSession | undefined> {
    const declared = bindingOf(agentName);
    if (!declared) {
      return undefined;
    }
    const retained = yield* routes.read(mappingKey(agentName, sessionKey));
    if (retained?.route !== "client-native") {
      return undefined;
    }
    const observed = yield* requireRetainedBuild(
      declared.adapter.launcher,
      declared.binding,
      retained.executableBinding,
    );
    const partition = boundPartition(
      agentCommand,
      retained.executableBinding,
      declared.binding.environment(observed.livePath),
    );
    // Availability is asked of the build this session will actually reach,
    // through the same partition that will serve it. Cached per partition, so
    // a second prompt on the same build asks nothing.
    yield* resolveAgent(agentName, partition);
    return { route: retained, partition };
  }

  /** A route that says ACP owns construction of this logical session. */
  function acpFirstRoute(agentName: string, sessionKey: string): SessionRoute {
    return {
      schema: "session-route.v1",
      route: "acp-first",
      ...mappingKey(agentName, sessionKey),
    };
  }

  /**
   * Refuse a pre-amendment state whose two accounts disagree.
   *
   * Before routes existed, a client-native mapping and an ACPX record could
   * both describe one logical session without either naming the other. If that
   * record turns out to be a different conversation, there is no way to tell
   * which of the two the user means — so the ambiguity is reported rather than
   * resolved by picking one, and nothing is deleted to make it go away.
   */
  function* requireUnambiguousRoute(route: ClientNativeRoute): Operation<void> {
    if (route.origin === undefined) {
      return;
    }
    const record = yield* until(store.load(route.sessionKey));
    if (record === undefined || record.agentSessionId === route.nativeSessionId) {
      return;
    }
    throw new NativeSessionConflict(
      `session "${route.sessionKey}" was retained before session routes existed, and the ` +
        `provider session recorded beside it names a different conversation than the one ` +
        `${route.launcher} was given. Launch a differently named session rather than ` +
        `choosing between them.`,
    );
  }

  function* ensureFromPrepared(agentName: string, prepared: Prepared): Operation<ManagedSession> {
    if (prepared.kind === "existing") {
      return prepared.entry;
    }
    const bound = yield* boundSession(
      agentName,
      prepared.placement.sessionKey,
      prepared.agentCommand,
    );
    const partition = bound?.partition ?? unboundPartition(prepared.agentCommand);

    if (bound) {
      // A client-native session has a live owner, and this is ACP asking to
      // become one. Without the lease there is no way to know whether a native
      // UI is in it right now, so acting would be acting blind.
      const outcome = yield* ownSession(agentName, prepared.placement.sessionKey);
      if (outcome === "busy") {
        throw new SessionBusy(
          `another XMD owner is using session "${prepared.placement.sessionKey}" — a native ` +
            `UI or a turn in another process holds it. Run this again once that owner exits.`,
        );
      }
      if (outcome === "unavailable") {
        throw new SessionOwnershipUnavailable(
          `session "${prepared.placement.sessionKey}" was created by a native UI, and this ` +
            `host installs no way to take exclusive ownership of it`,
        );
      }
      yield* requireUnambiguousRoute(bound.route);
    } else {
      // Claim the construction path before establishing anything. Publishing
      // after the ensure would leave a window in which a native launch could
      // claim the same session and create a second conversation under it.
      yield* routes.publish(acpFirstRoute(agentName, prepared.placement.sessionKey));
    }

    const acp = yield* getRuntime(partition);
    const request: Parameters<ProbeCapableRuntime["ensureSession"]>[0] = {
      sessionKey: prepared.placement.sessionKey,
      agent: agentName,
      mode: "persistent",
      cwd: prepared.placement.cwd,
    };
    if (bound) {
      // The identity XMD allocated, handed back unchanged. Nothing ACP or
      // ACPX produced may stand in for it — a session that answers to a
      // different name is a different conversation.
      request.resumeSessionId = bound.route.nativeSessionId;
    }
    const handle = yield* until(acp.ensureSession(request));
    if (bound && handle.agentSessionId !== bound.route.nativeSessionId) {
      // A client-native route authorizes resume and nothing else. A handle
      // answering to another name — or to none — means the retained
      // conversation was not loaded, and continuing would put this turn in a
      // session the native UI never created.
      throw new Error(
        `session "${prepared.placement.sessionKey}" was created by ${bound.route.launcher} and ` +
          `could not be resumed, so there is nothing here to continue. This provider does not ` +
          `create a replacement under the same name.`,
      );
    }
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
      partition,
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
          const acp = yield* getRuntime(entry.partition);
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
      // A refusal retains no session, so it claims no allocated identity —
      // the neutral provenance is the one that describes having none.
      identityProvenance: "provider-returned",
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
  /**
   * Prepare a session whose identity XMD allocates and whose native UI creates
   * the conversation.
   *
   * Nothing is created through ACP here. That is the point of the ordering: a
   * conversation created by ACP under one build and continued natively under
   * another is the divergence this path exists to remove, so the native side
   * creates and ACP only ever reattaches.
   *
   * Everything refusable is refused before the identity is retained. Once a
   * UUID is published it can never be replaced, so an executable that cannot
   * be confirmed has to stop the launch while stopping it still costs nothing.
   */
  function* prepareBoundLaunch(
    agentName: string,
    adapter: NativeAdapter,
    binding: NativeBinding,
    instructions: string,
    prepared: Prepared,
    own: (sessionKey: string) => Operation<SessionLeaseOutcome>,
  ): Operation<PreparedLaunchRecord> {
    const sessionKey = prepared.sessionKey;
    const sessionCwd = prepared.kind === "existing" ? prepared.entry.cwd : prepared.placement.cwd;
    const known = {
      agent: agentName,
      sessionKey,
      cwd: sessionCwd,
      launcher: adapter.launcher,
    };
    const instructionsDigest = createHash("sha256").update(instructions).digest("hex");

    let retainedRoute: SessionRoute | undefined;
    try {
      retainedRoute = yield* routes.read(mappingKey(agentName, sessionKey));
    } catch (error) {
      if (error instanceof NativeSessionConflict) {
        return refusal("identity-unavailable", toError(error).message, known);
      }
      throw error;
    }
    if (retainedRoute?.route === "acp-first") {
      // ACP claimed construction of this session first. A native launch cannot
      // take it back: the conversation ACP established is the one that exists,
      // and routes never convert.
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" is already established through ACP, and a native launch ` +
          `cannot take over a session it did not create. Launch a differently named ` +
          `<Session.Launch session="…">, or prompt this one through ACP.`,
        known,
      );
    }
    const retained = retainedRoute?.route === "client-native" ? retainedRoute : undefined;

    // Exclusive live ownership, before any provider or native work. A host
    // that installs no lease cannot tell whether a native UI is in this
    // session right now, so it refuses instead of guessing.
    const outcome = yield* own(sessionKey);
    if (outcome === "unavailable") {
      return refusal(
        "unsupported-capability",
        `this host installs no way to take exclusive ownership of a native agent session, ` +
          `so it cannot hand one to ${adapter.launcher}. Deno and the compiled binary can.`,
        known,
      );
    }
    if (outcome === "busy") {
      return refusal(
        "session-busy",
        `another XMD owner is using session "${sessionKey}" — a native UI or a turn in ` +
          `another process holds it. Run this again once that owner exits.`,
        known,
      );
    }

    if (retained) {
      try {
        yield* requireUnambiguousRoute(retained);
      } catch (error) {
        if (error instanceof NativeSessionConflict) {
          return refusal("identity-unavailable", error.message, known);
        }
        throw error;
      }
    }

    let observed;
    try {
      // A retained session is confirmed against the build that established it;
      // a new one is bound to whatever is installed now.
      observed = retained?.executableBinding
        ? yield* requireRetainedBuild(adapter.launcher, binding, retained.executableBinding)
        : yield* observeBuild(adapter.launcher, binding);
    } catch (error) {
      if (error instanceof ExecutableBindingRefused) {
        return refusal("executable-binding-refused", error.message, known);
      }
      throw error;
    }

    // The same question, asked where a fresh launch can still refuse it: is the
    // agent available *under this build*? An unbound probe would answer for a
    // different Claude than the one about to create the session.
    try {
      yield* resolveAgent(
        agentName,
        boundPartition(
          prepared.kind === "existing" ? prepared.entry.agentCommand : prepared.agentCommand,
          observed.binding,
          binding.environment(observed.livePath),
        ),
      );
    } catch (error) {
      return refusal("unsupported-capability", toError(error).message, known);
    }

    if (retained) {
      if (retained.instructionsDigest !== instructionsDigest) {
        // The layer changed. A native session's history is invisible to XMD by
        // design — native turns are never mirrored back — so there is no
        // evidence under which discarding it would be safe, and an empty ACPX
        // cache is not that evidence.
        return refusal(
          "instructions-refused",
          `session "${sessionKey}" was established with a different XMD instruction ` +
            `layer, and this provider cannot replace one on a session a native UI ` +
            `owns. Launch a differently named <Session>, or launch the same prepared ` +
            `instructions again.`,
          known,
        );
      }
      return boundRecord({
        agentName,
        adapter,
        sessionKey,
        sessionCwd,
        nativeSessionId: retained.nativeSessionId,
        sessionState: "resumed",
        reconciliation: "resumed",
        instructions,
        instructionsDigest,
        binding: observed.binding,
      });
    }

    // Allocated before anything exists to name it, which is what makes it
    // XMD's own: no ACP id, ACPX record id or CLI output can become this.
    const nativeSessionId = randomUUID();
    let published: SessionRoute;
    try {
      published = yield* routes.publish({
        schema: "session-route.v1",
        route: "client-native",
        provider: ACPX_PROVIDER,
        agent: agentName,
        sessionKey,
        nativeSessionId,
        identityProvenance: "client-allocated",
        instructionsDigest,
        launcher: adapter.launcher,
        executableBinding: observed.binding,
      });
    } catch (error) {
      if (error instanceof NativeSessionConflict) {
        return refusal("identity-unavailable", error.message, known);
      }
      throw error;
    }

    if (published.route !== "client-native") {
      // Unreachable through the store, which refuses a conversion rather than
      // returning one. Narrowed rather than asserted, because the record built
      // below carries the identity this answer names.
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" is already established through ACP, and a native launch ` +
          `cannot take over a session it did not create.`,
        known,
      );
    }
    const winner = published.nativeSessionId;

    return boundRecord({
      agentName,
      adapter,
      sessionKey,
      sessionCwd,
      // Whatever the store says is authoritative: a concurrent writer may have
      // published first, and adopting its identity is how both attempts end up
      // in one conversation.
      nativeSessionId: winner,
      sessionState: winner === nativeSessionId ? "created" : "resumed",
      reconciliation: winner === nativeSessionId ? "installed" : "resumed",
      instructions,
      instructionsDigest,
      binding: observed.binding,
    });
  }

  function boundRecord(fields: {
    agentName: string;
    adapter: NativeAdapter;
    sessionKey: string;
    sessionCwd: string;
    nativeSessionId: string;
    sessionState: "created" | "resumed";
    reconciliation: InstructionReconciliation;
    instructions: string;
    instructionsDigest: string;
    binding: ExecutableBuildBindingV1;
  }): PreparedLaunchRecord {
    return {
      phase: "prepared",
      agent: fields.agentName,
      sessionKey: fields.sessionKey,
      provider: ACPX_PROVIDER,
      nativeSessionId: fields.nativeSessionId,
      sessionState: fields.sessionState,
      instructionChannel: INSTRUCTION_CHANNEL,
      instructionReconciliation: fields.reconciliation,
      instructionsDigest: fields.instructionsDigest,
      instructions: fields.instructions,
      cwd: fields.sessionCwd,
      additionalDirectories: [],
      permissionMode: providerOptions.permissionMode,
      launcher: fields.adapter.launcher,
      identityProvenance: "client-allocated",
      executableBinding: fields.binding,
    };
  }

  function* prepareLaunch(
    agentName: string,
    callerCwd: string,
    instructions: string,
    prepared: Prepared,
    own: (sessionKey: string) => Operation<SessionLeaseOutcome>,
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

    if (adapter.binding) {
      return yield* prepareBoundLaunch(
        agentName,
        adapter,
        adapter.binding,
        instructions,
        prepared,
        own,
      );
    }

    const sessionKey = prepared.sessionKey;
    const sessionCwd = prepared.kind === "existing" ? prepared.entry.cwd : prepared.placement.cwd;
    const agentCommand =
      prepared.kind === "existing" ? prepared.entry.agentCommand : prepared.agentCommand;
    const acp = yield* getRuntime(unboundPartition(agentCommand));
    const existing = yield* until(store.load(sessionKey));
    let sessionState: "created" | "resumed" = existing ? "resumed" : "created";
    let reconciliation: InstructionReconciliation = existing ? "resumed" : "installed";

    if (existing && storedSystemPrompt(existing) !== instructions) {
      // ACPX fixes a session's instruction layer when its ACP session is
      // created, so putting a different one in force would mean discarding the
      // session — and V1 discards no persistent ACPX state. Nothing available
      // here shows that would be safe: an ACPX transcript is empty whether or
      // not the session was ever used, because native turns are never mirrored
      // back into it, and a record restored from an earlier run reports no
      // turns in this scope at all.
      return refusal(
        "instructions-refused",
        `session "${sessionKey}" already carries a different XMD instruction layer, and ` +
          `this provider does not replace one. Launch a differently named <Session>, or ` +
          `launch the same prepared instructions again.`,
        { agent: agentName, sessionKey, cwd: sessionCwd, launcher: adapter.launcher },
      );
    }

    // The construction fence, claimed before ACPX is contacted. This launch
    // creates the session through ACP, so the route it publishes is the same
    // one an ordinary `session()` would — and a client-allocated launch that
    // arrives later refuses instead of creating a second conversation.
    try {
      yield* routes.publish(acpFirstRoute(agentName, sessionKey));
    } catch (error) {
      if (error instanceof NativeSessionConflict) {
        return refusal("identity-unavailable", toError(error).message, {
          agent: agentName,
          sessionKey,
          cwd: sessionCwd,
          launcher: adapter.launcher,
        });
      }
      throw error;
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
    managed.set(sessionKey, {
      handle,
      agentCommand,
      cwd: sessionCwd,
      session,
      partition: unboundPartition(agentCommand),
    });

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
      identityProvenance: "provider-returned",
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

  /**
   * Release ACP ownership. Nothing is spawned until this has completed.
   *
   * Releasing is all this does. The record the native UI is about to resume is
   * exactly what a discard would remove, and V1 removes nothing: a session's
   * construction route never converts, so there is no shell here standing in
   * front of a conversation someone else created.
   */
  function* detachSession(sessionKey: string): Operation<DetachedLaunchRecord> {
    const entry = managed.get(sessionKey);
    if (!entry || entry.stale) {
      // Nothing of this provider's owns the session. A resumed launch reaches
      // here with no live ACP connection at all, which is the state detaching
      // exists to produce.
      return { phase: "detached" };
    }
    // Ownership is released, never discarded. A logical session keeps one
    // construction route for its whole life, so an ACP session under this key
    // is the conversation, not a shell standing in front of one — and there is
    // nothing here that a native UI is about to replace.
    try {
      const acp = yield* getRuntime(entry.partition);
      // The record is what the native UI is about to resume, so removing it
      // would destroy the thing being handed over.
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

  /**
   * Require the two durable accounts of one launch to say the same thing.
   *
   * A replayed launch reaches its detach and spawn holding a `prepared` record
   * the journal retained, while the mapping lives in a file the journal knows
   * nothing about. Nothing keeps them together on its own: a store restored
   * from a backup, a hand-repaired record, or a mapping written by a different
   * attempt would all leave a launch resuming one identity under another's
   * terms — and, because both accounts are individually well-formed, it would
   * look entirely healthy.
   *
   * So every field the two share is compared, and any disagreement stops the
   * launch where a refusal still costs nothing.
   */
  function* reconcileRetained(prepared: PreparedLaunchRecord): Operation<void> {
    if (prepared.identityProvenance !== "client-allocated") {
      return;
    }
    let retained: SessionRoute | undefined;
    try {
      retained = yield* routes.read(mappingKey(prepared.agent, prepared.sessionKey));
    } catch (error) {
      if (error instanceof NativeSessionConflict) {
        throw new ExecutableBindingRefused({
          launcher: prepared.launcher,
          mismatch: "unknown-binding-schema",
          message: toError(error).message,
        });
      }
      throw error;
    }
    // An allocated identity with no mapping is not a fresh start. Something
    // retained this launch, and allocating a replacement now would strand the
    // conversation the first attempt created.
    const mapping = retained?.route === "client-native" ? retained : undefined;
    const agrees =
      mapping !== undefined &&
      // The provider too, not only what it retained. The mapping is looked up
      // under this provider's own key, so a record naming another provider
      // means the two accounts were written by different owners — and an
      // identity is only meaningful under the provider that allocated it.
      mapping.provider === prepared.provider &&
      mapping.agent === prepared.agent &&
      mapping.sessionKey === prepared.sessionKey &&
      mapping.nativeSessionId === prepared.nativeSessionId &&
      mapping.identityProvenance === prepared.identityProvenance &&
      mapping.instructionsDigest === prepared.instructionsDigest &&
      mapping.launcher === prepared.launcher &&
      mapping.executableBinding !== undefined &&
      prepared.executableBinding !== undefined &&
      sameExecutableBuild(mapping.executableBinding, prepared.executableBinding);
    if (!agrees) {
      throw new ExecutableBindingRefused({
        launcher: prepared.launcher,
        mismatch: "unknown-binding-schema",
        message:
          mapping === undefined
            ? `this launch retained a session identity that the provider no longer holds a ` +
              `mapping for, so there is nothing to confirm it against`
            : `this launch's retained record and its provider mapping describe different ` +
              `sessions, so neither can be trusted to name the conversation`,
      });
    }
  }

  /**
   * The argv that hands a bound session to its native UI.
   *
   * The build is confirmed again here, immediately before the spawn, because
   * this is the last moment at which refusing still costs nothing — and
   * because a replayed launch reaches this point without having observed
   * anything. A completed launch never gets here at all: its exit is already
   * retained, so the journal performs no work and nothing is observed.
   *
   * The prepared instructions travel by file rather than argv or environment.
   * Both of those are readable by any other process on the host, and prepared
   * text is the one thing in a launch that is authored content.
   */
  function* boundCommand(
    adapter: NativeAdapter,
    binding: NativeBinding,
    prepared: PreparedLaunchRecord,
    detachedHere: boolean,
  ): Operation<{ argv: string[] }> {
    // Again here, because an attempt that resumes past a retained detach never
    // ran the check above.
    yield* reconcileRetained(prepared);
    const observed = yield* requireRetainedBuild(
      adapter.launcher,
      binding,
      prepared.executableBinding as ExecutableBuildBindingV1,
    );

    // Creation happens once. An attempt that resumed an existing identity, or
    // that is continuing past a retained detach, resumes — retrying creation
    // against an id the native side may already have used would ask for a
    // conflict, not a conversation.
    if (prepared.sessionState !== "created" || !detachedHere) {
      return { argv: [observed.livePath, ...binding.resume(prepared.nativeSessionId)] };
    }

    const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-launch-")));
    // Removed on success, failure and cancellation alike: the scope this
    // registers in is the launch's, and it closes either way.
    yield* ensure(() => until(rm(directory, { recursive: true, force: true })));
    const file = join(directory, "instructions.md");
    yield* until(writeFile(file, prepared.instructions, { mode: 0o600 }));

    return {
      argv: [observed.livePath, ...binding.create(prepared.nativeSessionId, file)],
    };
  }

  function launch(instructions: string, options?: LaunchOptions): Operation<SessionLaunchResult> {
    return scoped(function* (): Operation<SessionLaunchResult> {
      // Marked so the provider's own availability check defers, exactly as it
      // does for the authored `<Session.Launch>` boundary above it.
      const agentName = yield* resolvingLaunch(() => Agent.operations.agent(options?.agent));
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

      // The launch's own scope, so live ownership taken by any phase is
      // released where the launch ends rather than where that phase does: the
      // native child, its terminal recovery and the private instruction file
      // all outlive `prepared`.
      const launchScope = yield* useScope();
      // Asked for by whichever phase runs live first, and asked once. A
      // completed launch runs none of them and takes no ownership at all; a
      // launch resuming past a retained `prepared` takes it here, before it
      // reconciles that record against the route.
      let ownership: SessionLeaseOutcome | undefined;
      function* requireOwnership(sessionKey: string): Operation<SessionLeaseOutcome> {
        if (ownership === undefined) {
          ownership = yield* ownSessionWithin(launchScope, agentName, sessionKey);
        }
        return ownership;
      }
      const prepared = yield* AgentLaunchJournal.operations.recordPreparation(() =>
        withSessionRoute(context, () =>
          prepareLaunch(agentName, callerCwd, instructions, placement, requireOwnership),
        ),
      );

      // Whether *this* attempt is the one that released ACP ownership. A
      // retained `detached` means an earlier attempt already handed the
      // session to a native process, which may have created the conversation
      // before it stopped — so creation is never retried past that point.
      let detachedHere = false;
      yield* AgentLaunchJournal.operations.recordDetach(function* () {
        detachedHere = true;
        const refused = yield* refuseUnowned(prepared, requireOwnership);
        if (refused) {
          return { phase: "detached", failure: refused };
        }
        // Before ownership moves, and only when this attempt is the one moving
        // it: a completed launch replays its detach and reconciles nothing,
        // because it performs nothing.
        yield* reconcileRetained(prepared);
        return yield* detachSession(prepared.sessionKey);
      });

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
        const refused = yield* refuseUnowned(prepared, requireOwnership);
        if (refused) {
          return { phase: "exited", failure: refused };
        }
        try {
          const command =
            adapter.binding && prepared.executableBinding
              ? yield* boundCommand(adapter, adapter.binding, prepared, detachedHere)
              : { argv: adapter.resume(prepared.nativeSessionId) };
          const outcome = yield* nativeLaunch({
            command: command.argv,
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
          if (error instanceof ExecutableBindingRefused) {
            return {
              phase: "exited",
              failure: { class: "executable-binding-refused", message: error.message },
            };
          }
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
    if (runtimes.size > 0) {
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
        // Closed through the partition that opened it: another partition's
        // runtime does not know this handle.
        const owner = runtimes.get(entry.partition.key);
        if (!owner) {
          continue;
        }
        try {
          yield* until(owner.close({ handle: entry.handle, reason: "scope teardown" }));
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
      // Asking whether an agent is available is a question in its own right,
      // and for a bound agent it can only be answered under the build a
      // session would be created by — probing an unbound runtime would answer
      // for a different Claude. So this observes, and `launch()` deliberately
      // does not come through here.
      const selected = name ?? providerOptions.defaultAgent;
      if ((yield* LaunchResolution.get()) && bindingOf(selected)) {
        // A launch resolves its agent before its journal exists, so answering
        // here would observe an executable on every replay of a launch that
        // performs nothing. `prepareBoundLaunch` asks the same question inside
        // `prepared`, under the build it just observed — which is the only
        // place the answer is about the right Claude anyway.
        return selected;
      }
      const partition = yield* availabilityPartition(selected, registry.resolve(selected));
      return yield* resolveAgent(name, partition);
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
