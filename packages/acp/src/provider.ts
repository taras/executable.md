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
import { Agent } from "@executablemd/core";
import type {
  AgentLaunchRequest,
  AgentProviderAuthority,
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
  SessionAgentOptions,
} from "acpx/runtime";
import {
  AgentToolPermissionRefused,
  createPermissionBridge,
  strictPermissions,
} from "./permission-bridge.ts";
import { consumeTurn } from "./events.ts";
import { resolveSessionPlacement } from "./session-key.ts";
import { useSerialQueues } from "./serial-queue.ts";
import {
  AgentSessionBusy,
  AgentSessionRecoveryRequired,
  cwd,
  nativeLaunch,
} from "@executablemd/runtime";
import type {
  AgentSessionCoordinator,
  AgentSessionKey,
  AgentSessionOwnerKind,
  AgentSessionOwnership,
} from "@executablemd/runtime";
import {
  ADVERTISED_NATIVE_LAUNCH,
  knownNativeAdapters,
  nativeAdapterFor,
} from "./native-launch.ts";
import type { NativeAdapter } from "./native-launch.ts";

/**
 * One MCP server as ACPX configures them.
 *
 * Derived from ACPX's own options rather than imported from the ACP SDK, which
 * this package reaches only through ACPX.
 */
export type AcpMcpServer = NonNullable<AcpRuntimeOptions["mcpServers"]>[number];

/** The runtime surface the provider needs — ACPX's runtime plus its probe. */
export interface ProbeCapableRuntime extends AcpRuntime {
  doctor(): Promise<AcpRuntimeDoctorReport>;
}

/** What a host is asked when it, rather than a directory walk, places a session. */
export interface AcpxSessionContext {
  readonly agentName: string;
  /** The resolved agent command, not the name a document wrote. */
  readonly agentCommand: string;
  /** The authored `<Session>` name, when the document named one. */
  readonly session: string | undefined;
}

/** Where one logical session lives, as the host placing it decides. */
export interface AcpxSessionPlacement {
  readonly sessionKey: string;
  readonly cwd: string;
}

/** What ACPX asserted about a session it established. */
export interface AcpxSessionIdentity {
  readonly agentSessionId?: string;
  readonly acpxRecordId?: string;
}

/**
 * Where sessions live, when the host owns that decision.
 *
 * Absent keeps the ordinary walk from the caller's directory toward the Git
 * repository root. A host that keys a session by something other than a path —
 * a workflow run, say — answers here instead, which is also where it refuses a
 * retained session it cannot continue: before ACPX is contacted, and therefore
 * before a turn could start against a replacement.
 *
 * Supplied directly by the host that built it, like the coordinator beside it:
 * which conversation a prompt joins is not a decision a document composes.
 */
export interface AcpxSessionPolicy {
  place(context: AcpxSessionContext): Operation<AcpxSessionPlacement>;
  /**
   * Retain what ACPX asserted, once it has established the session.
   *
   * Called after every `ensureSession()` this provider performs for a placed
   * session, so a host retaining provider-native identity records it the first
   * time the adapter asserts one.
   */
  established?(placement: AcpxSessionPlacement, identity: AcpxSessionIdentity): Operation<void>;
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
  /**
   * Who owns a logical session right now, across processes.
   *
   * Supplied directly by the host that built it, because ownership is a
   * security decision and one a document could replace is not one. Absent means
   * this host cannot answer the question: every operation on an advertised
   * provider-returned session then refuses before contacting ACPX, rather than
   * acting while a native UI may be in the conversation.
   */
  coordinator?: AgentSessionCoordinator;
  /**
   * The directory an Agent runs in, when the host decides it rather than the
   * document's working directory.
   *
   * The default answers with the contextual cwd, which is what `xmd run` wants:
   * an agent inspects the tree its caller invoked it from. A host whose
   * contextual cwd is a logical Workspace root has no such directory to offer —
   * a Workspace is not a checkout — so it answers with one of its own.
   */
  agentCwd?: () => Operation<string>;
  /**
   * The MCP servers this runtime configures.
   *
   * Absent leaves the field off the runtime options entirely, which is ACPX's
   * own default. An empty array is a different statement — this host configures
   * none — and is passed as one.
   */
  mcpServers?: readonly AcpMcpServer[];
  /**
   * The options ACPX applies when it creates a fresh ACP session.
   *
   * ACPX fixes these when the session is created and ignores them when it reuses
   * a persistent record, so a host that continues a session compares what that
   * session was created under rather than assuming these took effect.
   */
  newSessionOptions?: SessionAgentOptions;
  /**
   * How a native permission request is answered.
   *
   * `"composable"` routes it through the public Agent permission chain, which is
   * what an authored `<ApproveAll>` composes around. `"strict"` answers it in the
   * provider: the request is denied and the turn it belongs to fails, and no
   * public handler is consulted or can intervene.
   */
  permissions?: "composable" | "strict";
  sessions?: AcpxSessionPolicy;
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
/**
 * The provider's operations without the Agent install, for an embedder holding
 * several independent states in sibling scopes.
 *
 * Deliberately no launch. A launch is authoritative — it retains durable phases
 * and settles what the document believes happened — and authority reaches a
 * provider only when core installs its factory. An embedder that needs one
 * registers a provider and lets it be installed; what this surface offers is
 * the non-authoritative half: resolving an agent, establishing a session, and
 * running turns.
 */
export interface AcpxProvider {
  agent(name?: string): Operation<string>;
  session(option?: string | Session): Operation<Session>;
  promptStream(content: string, options?: PromptOptions): Stream<AgentPromptEvent, string>;
}

/** Which complete provider state a dispatch acts on. */
export type AcpxPartitionSelector = () => Operation<AcpxProvider | undefined>;

/** A partition handle that names no live state this module created. */
export class AcpxPartitionError extends Error {
  override name = "AcpxPartitionError";
}

/**
 * One installed factory over any number of complete provider states.
 *
 * Installation and state are different things, and only one of them carries
 * authority. Installing once says where this provider can be reached from —
 * which has to be the operation enclosing the content it serves, or it is not
 * reachable at all. Selecting says which state to act on, which is how sibling
 * `<Test>` elements keep sessions, queues and records of their own under a
 * single installation.
 *
 * The selector is injected here, when the factory is constructed, and is
 * deliberately not contextual: a replaceable selector would let document
 * middleware choose which state an authoritative dispatch acts on. It is asked
 * afresh for every dispatch, because a partition cached across calls is the
 * previous test's state serving this one.
 */
export function createPartitionedAcpxProvider(select: AcpxPartitionSelector): AgentProviderFactory {
  return function* (
    _providerOptions: AgentProviderOptions,
    authority: AgentProviderAuthority,
  ): Operation<void> {
    /**
     * The state behind the selected handle, or a refusal.
     *
     * Resolved by identity through this module's own map, at the moment of use.
     * A handle another loaded copy produced, a structural look-alike, and one
     * whose owner has already been dismantled are all simply absent from it —
     * and absence is a refusal, never a fall back to some other partition.
     */
    function* selected(): Operation<AcpxProviderState> {
      const handle = yield* select();
      if (handle === undefined) {
        throw new AcpxPartitionError(
          "no agent provider partition is current, so there is no session state to act on",
        );
      }
      const state = resolvePartition(handle);
      if (!state) {
        throw new AcpxPartitionError(
          "this is not a live agent provider partition — a rebuilt, foreign or already " +
            "dismantled handle reaches no session state",
        );
      }
      return state;
    }

    yield* Agent.around(
      {
        *agent([name], _next) {
          return yield* (yield* selected()).agent(name);
        },
        *session([name], _next) {
          return yield* (yield* selected()).session(name);
        },
        *prompt([content, options], _next) {
          // Selection belongs inside the subscription, with the rest of the
          // turn's work: constructing a stream chooses nothing and starts
          // nothing, which is what keeps it cold.
          return {
            *[Symbol.iterator]() {
              const state = yield* selected();
              return yield* state.promptStream(content, options);
            },
          };
        },
        // The terminal end of the public chain, and the only handler holding
        // this authority. Everything outside it routed a request; this is where
        // a request becomes work, and the verdict still belongs to core. The
        // authority is passed as a live argument and never stored on a
        // partition, so resolving a handle yields work, never permission.
        *launch([request], _next) {
          yield* (yield* selected()).launch(request, authority);
        },
      },
      { at: "min" },
    );
  };
}

/**
 * The ordinary provider: one partition, selected unconditionally.
 *
 * Production is the single-partition case of the same path, so there is no
 * test-only route through this provider — the shape tests exercise is the shape
 * a run takes.
 */
export function createAcpxProvider(dependencies?: AcpxProviderDependencies): AgentProviderFactory {
  return function* (
    providerOptions: AgentProviderOptions,
    authority: AgentProviderAuthority,
  ): Operation<void> {
    const handle = yield* useAcpxProvider(providerOptions, dependencies);
    yield* createPartitionedAcpxProvider(function* () {
      return handle;
    })(providerOptions, authority);
  };
}

/** Everything the provider does, including the authoritative launch path. */
interface AcpxProviderState extends AcpxProvider {
  launch(request: AgentLaunchRequest, authority: AgentProviderAuthority): Operation<void>;
}

/**
 * The provider's non-authoritative operations, without the Agent install.
 *
 * For an embedder holding several independent provider states in sibling
 * scopes. It cannot launch: see {@link AcpxProvider}.
 */
/**
 * How this module reaches what a handle names, without publishing the way.
 *
 * Assigned once from inside the class body, which is the only place a private
 * field can be named. They are module-local bindings rather than statics on the
 * class, because the class itself is reachable — `handle.constructor` is an
 * ordinary read — and a resolver hanging off it would hand the state to whoever
 * holds a handle.
 */
let createPartition: (state: AcpxProviderState) => AcpxProvider;
let resolvePartition: (handle: unknown) => AcpxProviderState | undefined;
let withdrawPartition: (handle: AcpxProvider) => void;

/**
 * The one value this module will admit as a partition handle.
 *
 * Reached by nothing: it is on no object, exported from nowhere, and named only
 * here. A caller who reaches the class through `handle.constructor` still
 * cannot build an instance, which matters because an instance carrying a state
 * of the caller's own would be handed this document's launch authority.
 */
const ADMIT: unique symbol = Symbol("executablemd.acpx.partition.admit");

/**
 * The public partition handle, and the only thing that is one.
 *
 * A class with a private field, because every other place to put the state can
 * be read back out of the object. A symbol property is recoverable —
 * `Reflect.ownKeys()` returns symbol keys as readily as string ones — so a
 * handler could read the state out of one handle and copy the descriptor onto a
 * look-alike, and that state carries the launch operation this surface exists
 * to withhold. A private field is not a property: it appears in no key list, no
 * descriptor, and no copy.
 *
 * Identity is therefore the field itself. A structural look-alike, a
 * descriptor-for-descriptor clone, an object built on this prototype, an
 * instance a caller tried to construct, and a handle another loaded copy
 * produced are none of them one, which is a refusal rather than a fallback to
 * some other partition.
 */
class AcpxPartition implements AcpxProvider {
  /** Cleared before the owner's teardown begins, so a closed handle names nothing. */
  #state: AcpxProviderState | undefined;

  constructor(admit: symbol, state: AcpxProviderState) {
    if (admit !== ADMIT) {
      throw new AcpxPartitionError(
        "an agent provider partition is created by the provider that owns its state",
      );
    }
    this.#state = state;
  }

  static {
    createPartition = (state) => new AcpxPartition(ADMIT, state);
    // `#state in handle` is the unforgeable test: a private field can be probed
    // only from inside the class that declares it, and no object this file did
    // not construct has one. It answers rather than throws, so an ordinary
    // refusal does not have to be caught.
    resolvePartition = (handle) =>
      typeof handle === "object" && handle !== null && #state in handle ? handle.#state : undefined;
    withdrawPartition = (handle) => {
      if (handle instanceof AcpxPartition) {
        handle.#state = undefined;
      }
    };
  }

  /** What this handle still names, or a refusal in the caller's own terms. */
  #live(): AcpxProviderState {
    if (!this.#state) {
      throw new AcpxPartitionError(
        "this agent provider partition has been dismantled, so it reaches no session state",
      );
    }
    return this.#state;
  }

  agent(name?: string): Operation<string> {
    return this.#live().agent(name);
  }

  session(option?: string | Session): Operation<Session> {
    return this.#live().session(option);
  }

  promptStream(content: string, options?: PromptOptions): Stream<AgentPromptEvent, string> {
    const live = () => this.#live();
    return {
      // Cold: the refusal a dismantled partition owes belongs with the rest of
      // the turn's work, not with constructing the stream.
      *[Symbol.iterator]() {
        return yield* live().promptStream(content, options);
      },
    };
  }
}

export function* useAcpxProvider(
  providerOptions: AgentProviderOptions,
  dependencies?: AcpxProviderDependencies,
): Operation<AcpxProvider> {
  const state = yield* useAcpxProviderState(providerOptions, dependencies);
  const handle = createPartition(state);
  // Withdrawn before this partition's own teardown begins, so a handle that
  // outlives its owner selects nothing rather than reaching a state that is
  // being dismantled.
  yield* ensure(() => {
    withdrawPartition(handle);
  });
  return handle;
}

function* useAcpxProviderState(
  providerOptions: AgentProviderOptions,
  dependencies?: AcpxProviderDependencies,
): Operation<AcpxProviderState> {
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
  const coordinator = dependencies?.coordinator;
  const agentCwd = dependencies?.agentCwd ?? cwd;
  const mcpServers = dependencies?.mcpServers;
  const newSessionOptions = dependencies?.newSessionOptions;
  const sessions = dependencies?.sessions;
  const strict = dependencies?.permissions === "strict";
  const stateScope = yield* useScope();
  const turns = yield* useSerialQueues();

  /**
   * The turn each session currently has in flight, so a denial fails the turn
   * that asked for it. One session has at most one, because `turns.slot()`
   * serializes them.
   */
  const inFlight = new Map<string, { denied: boolean }>();
  const bridge = createPermissionBridge(
    strict
      ? strictPermissions((session) => {
          const turn = inFlight.get(session.sessionKey);
          if (turn) {
            turn.denied = true;
          }
        })
      : undefined,
  );

  let runtime: ProbeCapableRuntime | undefined;
  const validatedAgents = new Set<string>();
  const managed = new Map<string, ManagedSession>();
  const activeTurns = new Set<AcpRuntimeTurn>();
  const cleanupErrors: Error[] = [];

  function* runtimeOptions(): Operation<AcpRuntimeOptions> {
    const dir = yield* agentCwd();
    const options: AcpRuntimeOptions = {
      cwd: dir,
      sessionStore: store,
      agentRegistry: registry,
      permissionMode: providerOptions.permissionMode,
      nonInteractivePermissions: "deny",
    };
    if (mcpServers !== undefined) {
      options.mcpServers = [...mcpServers];
    }
    return options;
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
    if (sessions) {
      const placed = yield* sessions.place({ agentName, agentCommand, session: option });
      return { kind: "placement", sessionKey: placed.sessionKey, agentCommand, placement: placed };
    }
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
        ...(newSessionOptions === undefined ? {} : { sessionOptions: newSessionOptions }),
      }),
    );
    if (sessions?.established) {
      const identity: AcpxSessionIdentity = {
        ...(handle.agentSessionId === undefined ? {} : { agentSessionId: handle.agentSessionId }),
        ...(handle.acpxRecordId === undefined ? {} : { acpxRecordId: handle.acpxRecordId }),
      };
      yield* sessions.established(prepared.placement, identity);
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
    };
    managed.set(prepared.sessionKey, entry);
    return entry;
  }

  /** The natural key one logical session is owned under. */
  function sessionKeyOf(agentName: string, sessionKey: string): AgentSessionKey {
    return { provider: ACPX_PROVIDER, agent: registry.resolve(agentName), sessionKey };
  }

  /**
   * Whether this agent's sessions can be handed to a native UI.
   *
   * Coverage follows the agent's capability, not the operation: a prompt for an
   * advertised agent can be talking to a session a native UI is in right now,
   * so it is owned exactly as a launch is. An agent nobody can launch keeps
   * ordinary ACP behavior, on every host.
   */
  function ownable(agentName: string): boolean {
    return advertised.has(agentName) && adapterFor(agentName) !== undefined;
  }

  /**
   * Whether this provider still holds a handle that can act on `sessionKey`.
   *
   * The one thing quiescence is a claim about. `quiesced()` does not mean "I
   * finished" — it means nothing this owner started can still touch the
   * session, and a live ACP handle is exactly such a thing. So every path
   * acknowledges through this: a released handle quiesces, and a release that
   * did not happen leaves the session owned rather than looking finished.
   */
  function holding(sessionKey: string): boolean {
    const entry = managed.get(sessionKey);
    return entry !== undefined && !entry.stale;
  }

  /**
   * Run `body` while this process owns `sessionKey`, or say why not.
   *
   * A host that installed no coordinator cannot tell whether a native UI is in
   * the session, so it refuses rather than proceeding unprotected — the same
   * answer it gives for a session whose last owner never proved it stopped.
   */
  function* owning<T>(
    agentName: string,
    sessionKey: string,
    kind: AgentSessionOwnerKind,
    body: (ownership: AgentSessionOwnership) => Operation<T>,
  ): Operation<T> {
    if (!ownable(agentName)) {
      return yield* body({ quiesced() {} });
    }
    if (!coordinator) {
      throw new AgentSessionRecoveryRequired(
        `this host installs no way to take exclusive ownership of an agent session, so it ` +
          `cannot act on "${sessionKey}" — a native UI may be in it right now. Deno and the ` +
          `compiled binary can.`,
      );
    }
    const outcome = yield* coordinator.coordinate(
      sessionKeyOf(agentName, sessionKey),
      { kind, operationId: randomUUID() },
      body,
    );
    if (outcome.ok) {
      return outcome.value;
    }
    throw outcome.error;
  }

  /**
   * Take ownership that outlives the operation asking for it.
   *
   * A cold prompt stream acquires on subscription but must keep ownership
   * through the whole turn, its permission routing and its cleanup — all of
   * which belong to the subscriber's scope, not to this call. Acquiring inside
   * a task spawned into that scope puts the release exactly where the
   * subscription ends, however it ends.
   */
  function* ownWithin(
    scope: Scope,
    agentName: string,
    sessionKey: string,
    kind: AgentSessionOwnerKind,
  ): Operation<AgentSessionOwnership> {
    if (!ownable(agentName)) {
      return { quiesced() {} };
    }
    if (!coordinator) {
      throw new AgentSessionRecoveryRequired(
        `this host installs no way to take exclusive ownership of an agent session, so it ` +
          `cannot act on "${sessionKey}" — a native UI may be in it right now. Deno and the ` +
          `compiled binary can.`,
      );
    }
    const settled = withResolvers<AgentSessionOwnership>();
    yield* scope.spawn(function* () {
      const outcome = yield* coordinator.coordinate(
        sessionKeyOf(agentName, sessionKey),
        { kind, operationId: randomUUID() },
        function* (ownership) {
          settled.resolve(ownership);
          // Held until this task is halted, which is when the subscriber's
          // scope closes — after the turn and everything it registered.
          yield* suspend();
        },
      );
      if (!outcome.ok) {
        settled.reject(outcome.error);
      }
    });
    const ownership = yield* settled.operation;
    // Registered after acquisition and before the turn, so teardown reaches it
    // only once the turn's own finalizers — and the handle release below it —
    // have run.
    yield* ensure(() => {
      if (!holding(sessionKey)) {
        ownership.quiesced();
      }
    });
    return ownership;
  }

  function promptStream(
    content: string,
    options: PromptOptions | undefined,
  ): Stream<AgentPromptEvent, string> {
    return {
      *[Symbol.iterator]() {
        const agentName = yield* Agent.operations.agent(options?.agent);
        const callerCwd = resolve(yield* agentCwd());
        const context: SessionRouteContext = {
          agentName,
          session: options?.session,
          cwd: callerCwd,
        };

        const prepared = yield* withSessionRoute(context, () =>
          prepare(agentName, options?.session, callerCwd),
        );

        // Ownership before the turn, and before ensure: a prompt for an agent
        // whose sessions can be handed to a native UI is talking to a session
        // that UI may be in right now.
        yield* ownWithin(yield* useScope(), agentName, prepared.sessionKey, "prompt");
        if (ownable(agentName)) {
          // Registered before the turn, so it runs after the turn's own
          // finalizers and before ownership ends. No usable handle for an
          // advertised session outlives the release that frees it: the next
          // operation — here or in another process — reattaches under its own
          // acquisition.
          yield* ensure(() => releaseHandle(prepared.sessionKey));
        }
        yield* turns.slot(prepared.sessionKey);

        return yield* withSessionRoute(context, function* () {
          const entry = yield* ensureFromPrepared(agentName, prepared);
          // From here this session has been spoken to, whatever the cache
          // later says, so nothing may discard it to install a new layer.

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

          // Registered after the turn exists and before its events are
          // consumed, so a permission request arriving mid-turn reaches the
          // turn it belongs to and nothing else.
          const denials = { denied: false };
          if (strict) {
            const sessionKey = entry.session.sessionKey;
            inFlight.set(sessionKey, denials);
            yield* ensure(() => {
              if (inFlight.get(sessionKey) === denials) {
                inFlight.delete(sessionKey);
              }
            });
          }

          const channel = createChannel<AgentPromptEvent, string>();
          const subscription = yield* channel;
          yield* spawn(() =>
            consumeTurn(
              turn,
              { agent: agentName, session: entry.session },
              channel,
              () => {
                completed = true;
              },
              () => (denials.denied ? new AgentToolPermissionRefused() : undefined),
            ),
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
      // created, so putting a different one in force would mean discarding the
      // session — and nothing available here shows that would be safe. An ACPX
      // transcript is empty whether or not the session was ever used, because
      // native turns are never mirrored back into it, and a record restored
      // from an earlier run reports no turns in the scope that reopened it.
      //
      // So V1 discards no persistent provider state. What it costs is a refusal
      // where a recreation would have been convenient; what it buys is that no
      // launch destroys a conversation XMD does not own and cannot see.
      return refusal(
        "instructions-refused",
        `session "${sessionKey}" already carries a different XMD instruction layer, and ` +
          `this provider does not replace one. Launch a differently named <Session>, or ` +
          `launch the same prepared instructions again.`,
        { agent: agentName, sessionKey, cwd: sessionCwd, launcher: adapter.launcher },
      );
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

  /**
   * Give up this provider's ACP handle for `sessionKey`, keeping its record.
   *
   * Never a discard: what the record holds is the conversation, and the next
   * operation — here or in another process — reattaches to it. Marking the
   * handle stale is what stops this scope reusing a connection that predates
   * whatever owned the session next.
   */
  function* releaseHandle(sessionKey: string): Operation<void> {
    const entry = managed.get(sessionKey);
    if (!entry || entry.stale) {
      return;
    }
    try {
      const acp = yield* getRuntime();
      yield* until(acp.close({ handle: entry.handle, reason: "releasing session ownership" }));
    } catch (error) {
      // Reported, and the entry stays live. A close that failed released
      // nothing, and marking it stale here would tell `holding()` this scope
      // holds nothing — which is what lets the caller acknowledge quiescence
      // and publish an idle record for a session ACP may still be in.
      cleanupErrors.push(toError(error));
      return;
    }
    entry.stale = true;
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

  /**
   * Perform one launch the authority routed here.
   *
   * The order is the contract: the terminal is already held by the time this
   * runs, so what happens here is session ownership, then preparation, then the
   * handoff. Ownership encloses the native child and its cleanup, and is proven
   * quiescent only once that child can no longer act — a launch that released
   * earlier would be telling the next process the session is free while a UI is
   * still drawing in it.
   */
  function launch(request: AgentLaunchRequest, authority: AgentProviderAuthority): Operation<void> {
    return scoped(function* (): Operation<void> {
      const agentName = request.agent;
      const callerCwd = resolve(yield* agentCwd());
      const context: SessionRouteContext = {
        agentName,
        session: request.session,
        cwd: callerCwd,
      };

      const placement = yield* withSessionRoute(context, () =>
        prepare(agentName, request.session, callerCwd),
      );

      try {
        yield* owning(agentName, placement.sessionKey, "native-launch", function* (ownership) {
          // Provider-local FIFO stays, and stays what it is: ordering inside
          // one provider. It is not ownership, and it never was.
          yield* turns.slot(placement.sessionKey);

          yield* authority.perform(request, {
            prepare: () =>
              withSessionRoute(context, () =>
                prepareLaunch(agentName, callerCwd, request.instructions, placement),
              ),
            detach: (prepared) => detachSession(prepared.sessionKey),
            exit: (prepared) => runNativeUi(prepared),
          });

          // Only here, and only once this provider is holding nothing. By the
          // time `perform` returns the native child has exited and been reaped,
          // so what is left to check is the ACP handle: a handoff that released
          // it quiesces, and one that could not — a detach that failed, a
          // session prepared but never handed over — leaves the session owned
          // rather than looking finished.
          if (!holding(placement.sessionKey)) {
            ownership.quiesced();
          }
        });
      } catch (error) {
        // Contention and an unrecovered session are launch outcomes, not
        // crashes: they are retained as a refusal, before any ACP ensure,
        // detach or child, so the reader is told what to do about it.
        const refusal = ownershipRefusal(error, agentName, placement.sessionKey, callerCwd);
        if (!refusal) {
          throw error;
        }
        yield* authority.refuse(request, refusal);
        return;
      }
    });
  }

  /** Start the native UI for a prepared session and report how it ended. */
  function* runNativeUi(prepared: PreparedLaunchRecord): Operation<ExitedLaunchRecord> {
    const adapter = adapterFor(prepared.agent);
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
  }

  /** The retained refusal an ownership failure becomes, if it is one. */
  function ownershipRefusal(
    error: unknown,
    agentName: string,
    sessionKey: string,
    sessionCwd: string,
  ): PreparedLaunchRecord | undefined {
    const known = {
      agent: agentName,
      sessionKey,
      cwd: sessionCwd,
      launcher: adapterFor(agentName)?.launcher ?? "",
    };
    if (error instanceof AgentSessionBusy) {
      return refusal("session-busy", error.message, known);
    }
    if (error instanceof AgentSessionRecoveryRequired) {
      return refusal(
        coordinator ? "session-recovery-required" : "unsupported-capability",
        error.message,
        known,
      );
    }
    return undefined;
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
      const callerCwd = resolve(yield* agentCwd());
      const context: SessionRouteContext = { agentName, session: option, cwd: callerCwd };
      const prepared = yield* withSessionRoute(context, () =>
        prepare(agentName, option, callerCwd),
      );
      return yield* owning(agentName, prepared.sessionKey, "session", function* (ownership) {
        const session = yield* turns.withSlot(prepared.sessionKey, () =>
          withSessionRoute(context, function* () {
            const entry = yield* ensureFromPrepared(agentName, prepared);
            return entry.session;
          }),
        );
        // Establishing a session is not owning one. The handle is released
        // here, so nothing this provider holds afterwards is a second owner of
        // a session a native UI may take — the next operation reattaches under
        // its own acquisition.
        yield* releaseHandle(prepared.sessionKey);
        if (!holding(prepared.sessionKey)) {
          ownership.quiesced();
        }
        return session;
      });
    },
    promptStream,
    launch,
  };
}
