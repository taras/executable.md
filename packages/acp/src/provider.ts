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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, sameExecutableBuild } from "@executablemd/core";
import type {
  AgentLaunchRequest,
  AgentProviderAuthority,
  AgentPromptEvent,
  ExecutableBuildBindingV1,
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
import {
  AgentSessionBusy,
  AgentSessionRecoveryRequired,
  cwd,
  ExecutableObservationError,
  nativeLaunch,
} from "@executablemd/runtime";
import type {
  AgentSessionCoordinator,
  AgentSessionKey,
  AgentSessionOwnerKind,
  AgentSessionOwnership,
  ExecutableObserver,
} from "@executablemd/runtime";
import {
  ADVERTISED_NATIVE_LAUNCH,
  knownNativeAdapters,
  nativeAdapterFor,
} from "./native-launch.ts";
import type { NativeAdapter, NativeBinding } from "./native-launch.ts";
import type { AgentSessionRouteStore, AgentSessionRouteV1 } from "./session-route.ts";
import { AgentSessionRouteError } from "./session-route.ts";

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
  /**
   * Who owns a logical session right now, across processes.
   *
   * Supplied directly by the host that built it, because ownership is a
   * security decision and one a document could replace is not one. Absent means
   * this host cannot answer the question: every operation on an advertised
   * session then refuses before any provider work at all, rather than acting
   * while a native UI may be in the conversation.
   */
  coordinator?: AgentSessionCoordinator;
  /**
   * Where this host keeps construction routes.
   *
   * Supplied directly beside the coordinator and rooted in the same namespace,
   * because the two answer different questions about one session and a host
   * that can answer only one of them cannot act on an advertised session at
   * all. Absent means the same refusal a missing coordinator gives.
   */
  routeStore?: AgentSessionRouteStore;
  /**
   * How this host observes the build behind an executable.
   *
   * Directly injected for the same reason the coordinator is: a resolver
   * document middleware could replace could point the observation at one
   * binary while the run spawns another.
   */
  executableObserver?: ExecutableObserver;
}

/**
 * The key one ACP runtime partition is held under.
 *
 * Every field binding equality is defined over, and the agent command besides.
 * Not the digest alone: identical bytes reported under a different canonical
 * version are two builds as far as this contract is concerned, and a key that
 * ignored the version would quietly share one child between them. The key and
 * `sameExecutableBuild()` have to agree, or a partition could be reused for a
 * build the binding comparison would have refused.
 */
function partitionKey(agentCommand: string, binding: ExecutableBuildBindingV1): string {
  return JSON.stringify([
    agentCommand,
    binding.schema,
    binding.reportedVersion,
    binding.executableDigest.algorithm,
    binding.executableDigest.value,
  ]);
}

/**
 * One observed build, ready to be bound to a session.
 *
 * `livePath` is the canonical path this run will spawn and hand to the
 * matching ACP child. It is live capability only: it reaches the launcher and
 * `agentProcessEnv`, and it appears in no record, route, diagnostic, result or
 * process-global environment. `binding` is the durable half.
 */
/** What a prepared client-native launch needs next, for this invocation only. */
interface PendingNative {
  bound: BoundBuild;
  fresh: boolean;
  binding: NativeBinding;
}

/**
 * Everything one launch learned by running, rather than by replaying.
 *
 * `pending` is what a prepared client-native launch needs next, held between
 * preparation and the spawn: the live path and the argv shape are capability
 * rather than record data, so they travel here rather than through the durable
 * record the authority retains.
 *
 * Both members are observations, and an observation is only about the run that
 * made it: a live executable path is capability this invocation proved, and a
 * detach phase that ran live rather than replaying is how this invocation knows
 * its own predecessor never reached the handoff. Held on the provider, either
 * one would answer a later replay with a previous launch's evidence — a
 * reobservation skipped because a key lingered, or a resume turned into a fresh
 * creation because some earlier run detached live. So it is created inside
 * `launch()` and reaches the phases only as an argument.
 */
interface LaunchInvocation {
  /** Live build state for sessions this invocation prepared or reconciled. */
  readonly pending: Map<string, PendingNative>;
  /** Sessions whose detach phase ran live in this invocation. */
  readonly detachedLive: Set<string>;
}

interface BoundBuild {
  agentName: string;
  agentCommand: string;
  adapterCommand: string;
  livePath: string;
  binding: ExecutableBuildBindingV1;
  environment: Record<string, string>;
}

interface ManagedSession {
  handle: AcpRuntimeHandle;
  /**
   * The runtime that created or resumed this handle.
   *
   * Retained because a handle belongs to the runtime that made it. Runtimes are
   * partitioned by agent command and executable build, so reaching for "the"
   * runtime later would use a different ACP child for a handle this one owns —
   * which is a second connection to one session, not a shortcut.
   */
  runtime: ProbeCapableRuntime;
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
 * A client-native session takes its layer from a file the native process reads
 * at creation, not from an ACP session option. Naming the channel is how a
 * reader of the record can tell which of the two happened.
 */
const CLIENT_NATIVE_CHANNEL = "claude.systemPromptFile";

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

/**
 * The build behind an agent could not be named or confirmed.
 *
 * One class for every way the question goes unanswered, because the answer is
 * the same: this run cannot show it is talking to the build that created the
 * session, so it refuses rather than resuming into a conversation that may not
 * be there.
 */
/**
 * This host is not assembled to serve an advertised agent.
 *
 * A subclass, because the two halves of the contract want different answers to
 * the same fact: `session()` and Prompt keep the typed
 * `AgentSessionRecoveryRequired` refusal they always raised, while a launch
 * retains `unsupported-capability` — a capability this host does not have is
 * not a session someone left in a bad state.
 */
export class HostAssemblyIncomplete extends AgentSessionRecoveryRequired {
  override name = "HostAssemblyIncomplete";
}

export class ExecutableBindingRefused extends Error {
  override name = "ExecutableBindingRefused";
}

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
  const routeStore = dependencies?.routeStore;
  const executableObserver = dependencies?.executableObserver;
  const bridge = createPermissionBridge();
  const stateScope = yield* useScope();
  const turns = yield* useSerialQueues();

  /**
   * One ACP runtime per (agent command, executable build).
   *
   * Sessions established against different builds never share an ACP child.
   * That is the whole point of observing a build at all: a child running the
   * wrong Claude accepts the session identity and disagrees silently about
   * what it names.
   */
  const runtimes = new Map<string, ProbeCapableRuntime>();
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

  function* getRuntime(bound?: BoundBuild): Operation<ProbeCapableRuntime> {
    // Unbound work keeps the single runtime it always had. A bound agent gets
    // one per build, so a session established against one Claude is never
    // reattached through a child running another.
    const key = bound ? partitionKey(bound.agentCommand, bound.binding) : "";
    const held = key === "" ? runtime : runtimes.get(key);
    if (held) {
      return held;
    }
    const base = yield* runtimeOptions();
    const created = createRuntime({
      ...base,
      ...(bound
        ? {
            // Transient by construction: handed to the runtime for the children
            // it spawns, never persisted, exported, or written into a session
            // record. `agentProcessEnv` is the vendored patch's whole purpose.
            agentProcessEnv: bound.environment,
            agentCommands: { [bound.agentName]: bound.adapterCommand },
          }
        : {}),
      // The acpx callback boundary: `scope.run` returns a Promise-compatible
      // Future over the operation-based bridge decision.
      onPermissionRequest: (request, ctx) =>
        stateScope.run(() => bridge.decision(request, ctx.signal)),
    } as AcpRuntimeOptions);
    if (key === "") {
      runtime = created;
    } else {
      runtimes.set(key, created);
    }
    return created;
  }

  function* resolveAgent(name: string | undefined): Operation<string> {
    const selected = name ?? providerOptions.defaultAgent;
    // Selection stays read-only for an advertised agent this host is not
    // assembled to serve. Availability is a question for the adapter, and
    // asking it spawns a probe child — which is provider work, and provider
    // work on such a session must not happen before the refusal. Resolving the
    // name itself is free and stays available.
    if (ownable(selected) && !assembled(selected)) {
      return selected;
    }
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

  function* ensureFromPrepared(
    agentName: string,
    prepared: Prepared,
    bound?: BoundBuild,
    resume?: string,
  ): Operation<ManagedSession> {
    if (prepared.kind === "existing") {
      return prepared.entry;
    }
    const acp = yield* getRuntime(bound);
    // Every later use of this handle goes through `entry.runtime`, never
    // through `getRuntime()` again.
    //
    // A client-native session was created by a native process under an identity
    // XMD chose, so ACP attaches to it by name and never creates under it. That
    // is what `resumeSessionId` says, and it is the whole reason the identity
    // was allocated before the provider existed.
    const handle = yield* until(
      acp.ensureSession({
        sessionKey: prepared.placement.sessionKey,
        agent: agentName,
        mode: "persistent",
        cwd: prepared.placement.cwd,
        ...(resume === undefined ? {} : { resumeSessionId: resume }),
      }),
    );
    if (
      resume !== undefined &&
      handle.agentSessionId !== undefined &&
      handle.agentSessionId !== resume
    ) {
      // The attachment answers with a different conversation than the one this
      // session was constructed as. Nothing here reconciles that, and a turn
      // taken through the handle would land in history that is not this
      // session's — so it is released before it is ever used.
      try {
        yield* until(acp.close({ handle, reason: "attachment identity mismatch" }));
      } catch (error) {
        cleanupErrors.push(toError(error));
      }
      throw new Error(
        `session "${prepared.placement.sessionKey}" was constructed as ${resume}, but attaching ` +
          `to it reports ${handle.agentSessionId} — a turn taken here would not belong to the ` +
          `conversation this session names`,
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
      runtime: acp,
      agentCommand: prepared.agentCommand,
      cwd: prepared.placement.cwd,
      session,
    };
    managed.set(prepared.sessionKey, entry);
    return entry;
  }

  /**
   * The natural key one logical session is owned under.
   *
   * Takes the command that was already resolved, never re-resolves it. A
   * registry may answer differently outside the critical section that pinned
   * its route — TestAgent's deliberately does — and a key recomputed there
   * would name a different session than the one this operation prepared. The
   * coordinator key, the route key and the ACPX command have to be the same
   * string or they are not describing one session.
   */
  function sessionKeyOf(agentCommand: string, sessionKey: string): AgentSessionKey {
    return { provider: ACPX_PROVIDER, agent: agentCommand, sessionKey };
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
   * Refuse an advertised agent this host is not assembled to serve.
   *
   * Fail-closed, and closed means all of it: an advertised session needs a
   * coordinator to say who owns it, a route store to say how it was
   * constructed, and — for an adapter that binds a build — an observer to say
   * which build. A host with two of the three can answer two of the three
   * questions, and answering two is not enough to act on a session a native UI
   * may be in.
   *
   * Unadvertised agents keep ordinary ACP behavior on every host, which is why
   * the dependencies stay optional.
   */
  /** What this host is missing before it may act on `agentName`'s sessions. */
  function missingAssembly(agentName: string): string[] {
    const missing: string[] = [];
    if (!coordinator) {
      missing.push("exclusive ownership");
    }
    if (!routeStore) {
      missing.push("construction routes");
    }
    if (adapterFor(agentName)?.binding && !executableObserver) {
      missing.push("executable observation");
    }
    return missing;
  }

  /** Whether this host can serve `agentName` at all. */
  function assembled(agentName: string): boolean {
    return missingAssembly(agentName).length === 0;
  }

  function requireAssembly(agentName: string, sessionKey: string): void {
    if (!ownable(agentName)) {
      return;
    }
    const missing = missingAssembly(agentName);
    if (missing.length === 0) {
      return;
    }
    throw new HostAssemblyIncomplete(
      `this host installs no way to take ${missing.join(" or ")} for an agent session, so it ` +
        `cannot act on "${sessionKey}" — a native UI may be in it right now. Deno and the ` +
        `compiled binary can.`,
    );
  }

  /**
   * Refuse before a placement is resolved.
   *
   * `requireAssembly` names a session key, and finding one means resolving a
   * placement — which loads ACP session records to decide which existing
   * session the caller meant. A host that may not act on a session must not
   * read that session's store to discover which session it is refusing, so the
   * pre-placement refusal names the session as the caller asked for it.
   */
  function requestedSession(option: string | Session | undefined): string {
    return typeof option === "object" ? option.sessionKey : (option ?? "the default session");
  }

  function requireAssemblyBeforePlacement(
    agentName: string,
    option: string | Session | undefined,
  ): void {
    requireAssembly(agentName, requestedSession(option));
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
    agentCommand: string,
    sessionKey: string,
    kind: AgentSessionOwnerKind,
    body: (ownership: AgentSessionOwnership) => Operation<T>,
  ): Operation<T> {
    if (!ownable(agentName)) {
      return yield* body({ quiesced() {} });
    }
    requireAssembly(agentName, sessionKey);
    const outcome = yield* coordinator!.coordinate(
      sessionKeyOf(agentCommand, sessionKey),
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
    agentCommand: string,
    sessionKey: string,
    kind: AgentSessionOwnerKind,
  ): Operation<AgentSessionOwnership> {
    if (!ownable(agentName)) {
      return { quiesced() {} };
    }
    requireAssembly(agentName, sessionKey);
    const settled = withResolvers<AgentSessionOwnership>();
    yield* scope.spawn(function* () {
      const outcome = yield* coordinator!.coordinate(
        sessionKeyOf(agentCommand, sessionKey),
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
        const callerCwd = resolve(yield* cwd());
        const context: SessionRouteContext = {
          agentName,
          session: options?.session,
          cwd: callerCwd,
        };

        requireAssemblyBeforePlacement(agentName, options?.session);
        const prepared = yield* withSessionRoute(context, () =>
          prepare(agentName, options?.session, callerCwd),
        );

        // Ownership before the turn, and before ensure: a prompt for an agent
        // whose sessions can be handed to a native UI is talking to a session
        // that UI may be in right now.
        yield* ownWithin(
          yield* useScope(),
          agentName,
          agentCommandOf(prepared),
          prepared.sessionKey,
          "prompt",
        );
        // Inside the acquisition, before ensure or turn. A first Prompt on a
        // session nobody constructed is itself an ACP-first construction.
        const route = yield* reconciled(agentName, prepared, () =>
          acpFirstRoute(agentCommandOf(prepared), prepared.sessionKey),
        );
        const bound = yield* attachmentBuild(agentName, prepared, route);
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
          const entry = yield* ensureFromPrepared(
            agentName,
            prepared,
            bound,
            route?.route === "client-native" ? route.nativeSessionId : undefined,
          );
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
          // The runtime that owns this handle, not whichever one this provider
          // would build now.
          const turn = entry.runtime.startTurn({
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
      // This provider returns the identity ACPX gave it. #519 adds the
      // client-allocated path; nothing here allocates one.
      identityProvenance: "provider-returned",
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
  /**
   * Observe the build behind `binding.command` and bind it.
   *
   * Every way this can fail — no observer, resolution, canonicalization,
   * executable-file validation, digesting, or a version this adapter does not
   * recognize — is one refusal class, because they all answer the same
   * question with "cannot say". A build XMD cannot name is one it cannot later
   * confirm, so it refuses rather than proceeding under a guess.
   *
   * Called inside coordinator ownership, before any route is published or any
   * provider state exists.
   */
  /**
   * Reconcile the construction route while ownership is held.
   *
   * Called after the coordinator has granted and before any provider
   * construction effect, which is the ordering the whole contract rests on: a
   * route read outside ownership could be published by someone else before
   * this caller acted on it.
   *
   * `intended` is what this operation would construct if nothing exists yet.
   * The answer is the route that governs — this caller's, or the one already
   * published — and adopting it is not optional: whoever published first
   * described the session that exists.
   */
  function* reconcileRoute(
    agentName: string,
    agentCommand: string,
    sessionKey: string,
    intended: () => Operation<AgentSessionRouteV1>,
    hasProviderState: boolean,
  ): Operation<AgentSessionRouteV1> {
    const key = sessionKeyOf(agentCommand, sessionKey);
    const existing = yield* routeStore!.read(key);
    if (existing) {
      return existing;
    }
    // The #518 upgrade rule: a session ACP already established is ACP-first,
    // whatever this operation would otherwise have constructed. Existing
    // history is never reclassified as client-native.
    if (hasProviderState) {
      return yield* routeStore!.publish({
        schema: "session-route.v1",
        route: "acp-first",
        provider: ACPX_PROVIDER,
        agent: agentCommand,
        sessionKey,
      });
    }
    return yield* routeStore!.publish(yield* intended());
  }

  /** The ACP-first route this session would be constructed under. */
  function acpFirstRoute(agentCommand: string, sessionKey: string): AgentSessionRouteV1 {
    return {
      schema: "session-route.v1",
      route: "acp-first",
      provider: ACPX_PROVIDER,
      agent: agentCommand,
      sessionKey,
    };
  }

  /**
   * Refuse to act on a session whose route says it is not this kind of thing.
   *
   * The route never converts. An ACP operation meeting `client-native` may
   * attach to the retained identity but never create under it, and a
   * client-native launch meeting `acp-first` refuses outright — converting
   * would mean claiming an identity for a conversation that already has one.
   */
  function refuseConversion(route: AgentSessionRouteV1, sessionKey: string): never {
    throw new AgentSessionRouteError(
      `session "${sessionKey}" was constructed ${
        route.route === "acp-first" ? "through ACP" : "with a client-allocated identity"
      }, and this launch would construct it the other way. A construction route never converts.`,
    );
  }

  /** The resolved agent command behind a placement or an existing entry. */
  function agentCommandOf(prepared: Prepared): string {
    return prepared.kind === "existing" ? prepared.entry.agentCommand : prepared.agentCommand;
  }

  /**
   * Reconcile this session's route, or nothing when the agent is not one whose
   * sessions can be handed to a native UI.
   *
   * An unadvertised agent keeps ordinary ACP behavior on every host and
   * publishes no route: there is no handoff for a route to govern.
   */
  function* reconciled(
    agentName: string,
    prepared: Prepared,
    intended: () => AgentSessionRouteV1,
  ): Operation<AgentSessionRouteV1 | undefined> {
    if (!ownable(agentName)) {
      return undefined;
    }
    return yield* reconcileRoute(
      agentName,
      agentCommandOf(prepared),
      prepared.sessionKey,
      // deno-lint-ignore require-yield
      function* () {
        return intended();
      },
      // An existing managed entry, or a durable record ACPX already kept, is
      // provider state — and existing history is never reclassified.
      prepared.kind === "existing" || (yield* until(store.load(prepared.sessionKey))) !== undefined,
    );
  }

  /**
   * The build an ACP attachment must run, for a route that names one.
   *
   * Client-native history is resume-only and belongs to one build. Reattaching
   * revalidates before selecting a partition, because the build behind a
   * command changes without the command changing.
   */
  function* attachmentBuild(
    agentName: string,
    prepared: Prepared,
    route: AgentSessionRouteV1 | undefined,
  ): Operation<BoundBuild | undefined> {
    if (!route || route.route !== "client-native") {
      return undefined;
    }
    const binding = adapterFor(agentName)?.binding;
    if (!binding) {
      throw new ExecutableBindingRefused(
        `session "${prepared.sessionKey}" was created under a client-allocated identity, and ` +
          `this build has no way to confirm the executable that created it`,
      );
    }
    const bound = yield* observeBuild(agentName, agentCommandOf(prepared), binding);
    if (!sameExecutableBuild(bound.binding, route.executableBinding)) {
      throw new ExecutableBindingRefused(
        `session "${prepared.sessionKey}" was created by ${route.executableBinding.reportedVersion} ` +
          `and this run would use ${bound.binding.reportedVersion}, so the conversation it names ` +
          `cannot be confirmed`,
      );
    }
    return bound;
  }

  function* observeBuild(
    agentName: string,
    agentCommand: string,
    binding: NativeBinding,
  ): Operation<BoundBuild> {
    if (!executableObserver) {
      throw new ExecutableBindingRefused(
        `this host cannot observe which build of "${agentName}" it would run, so it cannot ` +
          `bind a session to one`,
      );
    }
    let observed;
    try {
      observed = yield* executableObserver.observe(binding.command);
    } catch (error) {
      throw new ExecutableBindingRefused(
        `the build behind "${agentName}" could not be observed: ${
          error instanceof ExecutableObservationError ? error.refusal : "unavailable"
        }`,
      );
    }
    const version = binding.version(observed.versionOutput);
    if (version === undefined) {
      // Deliberately without the raw output: it is provider-private and this
      // message is retained in a diagnostic.
      throw new ExecutableBindingRefused(
        `"${agentName}" reported a version this adapter does not recognize, so the build ` +
          `cannot be named`,
      );
    }
    return {
      agentName,
      agentCommand,
      adapterCommand: binding.adapterCommand,
      livePath: observed.path,
      binding: {
        schema: "executable-build.v1",
        reportedVersion: version,
        executableDigest: observed.digest,
      },
      environment: binding.environment(observed.path),
    };
  }

  /**
   * The prepared instructions, in a file only this invocation can read.
   *
   * Claude takes its instruction layer from a file rather than argv, which is
   * what keeps prepared text out of the process table. Mode `0600` and a
   * per-launch name; removed on success, failure and cancellation alike, while
   * session ownership is still held — a file that outlived the ownership would
   * outlive the only thing that knows it exists.
   */
  function* privateInstructionFile(instructions: string): Operation<string> {
    const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-launch-")));
    const path = join(directory, "instructions.md");
    yield* until(writeFile(path, instructions, { mode: 0o600 }));
    yield* ensure(function* () {
      yield* until(rm(directory, { recursive: true, force: true }).catch(() => undefined));
    });
    return path;
  }

  /**
   * Prepare a session whose identity XMD chose.
   *
   * The order is the contract, and every step happens while the coordinator
   * holds this session:
   *
   *   route + existing ACPX state -> refuse conversion -> observe the build and
   *   allocate a UUID -> publish or adopt the route -> retain a record that
   *   matches it exactly.
   *
   * Nothing is created through ACP here. A client-native session is materialized
   * by the native process itself, which is why the route has to be settled
   * before the process exists: two accounts of one session, published in the
   * wrong order, is exactly the failure this route prevents.
   */
  function* prepareClientNative(
    invocation: LaunchInvocation,
    agentName: string,
    agentCommand: string,
    adapter: NativeAdapter,
    binding: NativeBinding,
    sessionKey: string,
    sessionCwd: string,
    instructions: string,
    prepared: Prepared,
  ): Operation<PreparedLaunchRecord> {
    const known = { agent: agentName, sessionKey, cwd: sessionCwd, launcher: adapter.launcher };
    const instructionsDigest = createHash("sha256").update(instructions).digest("hex");

    // Step 2: the route and the provider's own durable state, both read while
    // ownership is held.
    const existing = yield* until(store.load(sessionKey));
    let route = yield* routeStore!.read(sessionKeyOf(agentCommand, sessionKey));

    // The #518 upgrade rule, which is this path's too. A session ACP already
    // established before construction routes existed has never had what it is
    // written down anywhere. Writing it now — while this launch holds ownership
    // — is what makes it un-reclassifiable: the next run meets a durable
    // account rather than the same open question, and this one refuses against
    // the account it just published rather than against an inference. Adopting
    // is not optional, so a concurrent client-native winner is what comes back
    // and the checks below read it.
    if (route === undefined && existing !== undefined) {
      route = yield* routeStore!.publish(acpFirstRoute(agentCommand, sessionKey));
    }

    // Step 3: an ACP-first session is not this kind of thing, and a route never
    // converts. Refused before the observer runs, before a UUID exists, and
    // long before detach or spawn.
    if (route?.route === "acp-first") {
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" was constructed through ACP, so it already has an identity ` +
          `of its own. A launch that allocates one would be naming a different conversation.`,
        known,
      );
    }
    if (route?.route === "client-native" && route.instructionsDigest !== instructionsDigest) {
      return refusal(
        "instructions-refused",
        `session "${sessionKey}" already carries a different XMD instruction layer, and ` +
          `this provider does not replace one. Launch a differently named <Session>, or ` +
          `launch the same prepared instructions again.`,
        known,
      );
    }

    // Step 4: observe the build and allocate the identity, both owned.
    let bound: BoundBuild;
    try {
      bound = yield* observeBuild(agentName, agentCommand, binding);
    } catch (error) {
      return refusal(
        "executable-binding-refused",
        error instanceof Error ? error.message : String(error),
        known,
      );
    }
    if (
      route?.route === "client-native" &&
      !sameExecutableBuild(bound.binding, route.executableBinding)
    ) {
      return refusal(
        "executable-binding-refused",
        `session "${sessionKey}" was created by ${route.executableBinding.reportedVersion} and ` +
          `this run would use ${bound.binding.reportedVersion}, so the conversation it names ` +
          `cannot be confirmed`,
        known,
      );
    }

    // The adapter allocates, because only it knows what identity this provider
    // will accept. Never an authored value, an ACP id, an ACPX record id, or
    // anything that merely looks like a UUID.
    const candidate = binding.allocate();

    // Step 5: publish or adopt. A caller meeting a compatible existing route
    // adopts its retained UUID rather than insisting its own candidate win —
    // the first durable publication is authoritative.
    let winner: AgentSessionRouteV1;
    try {
      winner = yield* routeStore!.publish({
        schema: "session-route.v1",
        route: "client-native",
        provider: ACPX_PROVIDER,
        agent: agentCommand,
        sessionKey,
        nativeSessionId: candidate,
        identityProvenance: "client-allocated",
        instructionsDigest,
        launcher: adapter.launcher,
        executableBinding: bound.binding,
      });
    } catch (error) {
      return refusal("identity-unavailable", toError(error).message, known);
    }
    if (winner.route !== "client-native") {
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" was constructed through ACP, so it already has an identity ` +
          `of its own`,
        known,
      );
    }
    if (
      winner.instructionsDigest !== instructionsDigest ||
      winner.launcher !== adapter.launcher ||
      !sameExecutableBuild(winner.executableBinding, bound.binding)
    ) {
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" is already constructed under an account this launch does not ` +
          `match, and neither account repairs the other`,
        known,
      );
    }

    // The record and the route agree exactly, because the record is built from
    // the winner rather than from the candidate.
    const record: PreparedLaunchRecord = {
      phase: "prepared",
      agent: agentName,
      sessionKey,
      provider: ACPX_PROVIDER,
      nativeSessionId: winner.nativeSessionId,
      // Materialized by the native process; ACP has created nothing.
      sessionState: winner.nativeSessionId === candidate ? "created" : "resumed",
      instructionChannel: CLIENT_NATIVE_CHANNEL,
      instructionReconciliation: winner.nativeSessionId === candidate ? "installed" : "resumed",
      identityProvenance: "client-allocated",
      executableBinding: winner.executableBinding,
      instructionsDigest,
      instructions,
      cwd: sessionCwd,
      additionalDirectories: [],
      permissionMode: providerOptions.permissionMode,
      launcher: adapter.launcher,
    };
    // Held for the launch that follows: the live path and the argv shape are
    // capability, not record data.
    invocation.pending.set(sessionKey, {
      bound,
      fresh: winner.nativeSessionId === candidate,
      binding,
    });
    void prepared;
    return record;
  }

  function* prepareLaunch(
    invocation: LaunchInvocation,
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

    // An adapter that binds a build allocates its own identity, so its launch
    // never goes through ACP session creation at all.
    if (adapter.binding) {
      return yield* prepareClientNative(
        invocation,
        agentName,
        agentCommand,
        adapter,
        adapter.binding,
        sessionKey,
        sessionCwd,
        instructions,
        prepared,
      );
    }

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
    managed.set(sessionKey, { handle, runtime: acp, agentCommand, cwd: sessionCwd, session });

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
      identityProvenance: "provider-returned",
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
      yield* until(
        entry.runtime.close({ handle: entry.handle, reason: "releasing session ownership" }),
      );
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
  function* detachSession(
    invocation: LaunchInvocation,
    sessionKey: string,
  ): Operation<DetachedLaunchRecord> {
    // A client-native session was never created through ACP, so there is no ACP
    // ownership to release. Detach is still a phase — it is the point after
    // which a spawn may happen — and it succeeds trivially.
    if (invocation.pending.has(sessionKey)) {
      return { phase: "detached" };
    }
    // Reached live means the detach phase was absent from the journal, which is
    // what tells a resumed launch that native creation may not have happened.
    invocation.detachedLive.add(sessionKey);
    const entry = managed.get(sessionKey);
    if (!entry || entry.stale) {
      // Nothing of this provider's owns the session. A resumed launch reaches
      // here with no live ACP connection at all, which is the state detaching
      // exists to produce.
      return { phase: "detached" };
    }
    try {
      // Not `discardPersistentState`: the record is exactly what the native UI
      // is about to resume.
      yield* until(entry.runtime.close({ handle: entry.handle, reason: "native session launch" }));
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
      const callerCwd = resolve(yield* cwd());
      const context: SessionRouteContext = {
        agentName,
        session: request.session,
        cwd: callerCwd,
      };

      try {
        requireAssemblyBeforePlacement(agentName, request.session);
      } catch (error) {
        // Retained, not thrown — an unassembled host is a launch outcome. Both
        // a fresh launch and a replay reach this before any placement, so
        // neither reads the ACP session store on a host that may not act.
        const refused = ownershipRefusal(
          error,
          agentName,
          requestedSession(request.session),
          callerCwd,
        );
        if (!refused) {
          throw error;
        }
        yield* authority.refuse(request, refused);
        return;
      }

      const placement = yield* withSessionRoute(context, () =>
        prepare(agentName, request.session, callerCwd),
      );

      // This launch's own state, reachable only through the phase callbacks
      // below. Nothing one invocation observed is visible to the next: a later
      // replay reobserves the build rather than finding a lingering live path,
      // and reads its own detach phase rather than a previous run's.
      const invocation: LaunchInvocation = {
        pending: new Map(),
        detachedLive: new Set(),
      };

      try {
        yield* owning(
          agentName,
          agentCommandOf(placement),
          placement.sessionKey,
          "native-launch",
          function* (ownership) {
            // Provider-local FIFO stays, and stays what it is: ordering inside
            // one provider. It is not ownership, and it never was.
            yield* turns.slot(placement.sessionKey);

            yield* authority.perform(request, {
              prepare: () =>
                withSessionRoute(context, () =>
                  prepareLaunch(invocation, agentName, callerCwd, request.instructions, placement),
                ),
              detach: (prepared) => detachSession(invocation, prepared.sessionKey),
              exit: (prepared) => runNativeUi(invocation, prepared, agentCommandOf(placement)),
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
          },
        );
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

  /**
   * Reconcile a retained client-allocated launch before resuming it.
   *
   * Two durable accounts of this session already exist — the journal's and the
   * route's — and a replay may act only if they still agree with each other and
   * with the build this run would use. Neither account repairs the other, and
   * neither is republished: a replay that found a disagreement has discovered
   * that the session it was going to resume is not the session it prepared.
   *
   * Unlike a fresh launch, the UUID is fixed: a retained preparation must match
   * the route's exact identity, because both accounts already exist.
   */
  function* reconcileRetainedLaunch(
    invocation: LaunchInvocation,
    prepared: PreparedLaunchRecord,
    adapter: NativeAdapter,
    agentCommand: string,
  ): Operation<ExitedLaunchRecord | undefined> {
    // The settled classes, not one generic process failure. A replay that
    // cannot reconcile its two durable accounts has not failed to start a
    // process — it has discovered that the session it was going to resume is
    // not the session it prepared, and that is a different thing to be told.
    const stop = (
      failureClass: "identity-unavailable" | "executable-binding-refused",
      message: string,
    ): ExitedLaunchRecord => ({ phase: "exited", failure: { class: failureClass, message } });
    const binding = adapter.binding;
    if (!binding || !prepared.executableBinding) {
      return stop(
        "executable-binding-refused",
        `session "${prepared.sessionKey}" was retained under a client-allocated identity this ` +
          `build cannot confirm`,
      );
    }
    let route;
    try {
      // The command the record itself retained, not one resolved again now.
      route = yield* routeStore!.read(sessionKeyOf(agentCommand, prepared.sessionKey));
    } catch (error) {
      return stop("identity-unavailable", toError(error).message);
    }
    if (!route || route.route !== "client-native") {
      return stop(
        "identity-unavailable",
        `session "${prepared.sessionKey}" has no client-allocated construction route, so the ` +
          `conversation this launch prepared cannot be confirmed`,
      );
    }
    // Every retained fact, against the route: identity, provenance, the
    // instruction layer, the launcher, and the whole binding.
    if (
      route.nativeSessionId !== prepared.nativeSessionId ||
      route.identityProvenance !== prepared.identityProvenance ||
      route.instructionsDigest !== prepared.instructionsDigest ||
      route.launcher !== prepared.launcher ||
      !sameExecutableBuild(route.executableBinding, prepared.executableBinding)
    ) {
      return stop(
        "identity-unavailable",
        `session "${prepared.sessionKey}" is described differently by its journal and its ` +
          `construction route, and neither account repairs the other`,
      );
    }
    let bound: BoundBuild;
    try {
      bound = yield* observeBuild(prepared.agent, route.agent, binding);
    } catch (error) {
      return stop("executable-binding-refused", toError(error).message);
    }
    if (!sameExecutableBuild(bound.binding, route.executableBinding)) {
      return stop(
        "executable-binding-refused",
        `session "${prepared.sessionKey}" was created by ${route.executableBinding.reportedVersion} ` +
          `and this run would use ${bound.binding.reportedVersion}`,
      );
    }
    // Prepared-only replay may still need to create: native creation may never
    // have happened. A detached replay is resume-only.
    invocation.pending.set(prepared.sessionKey, {
      bound,
      fresh: invocation.detachedLive.has(prepared.sessionKey),
      binding,
    });
    return undefined;
  }

  /** Start the native UI for a prepared session and report how it ended. */
  function* runNativeUi(
    invocation: LaunchInvocation,
    prepared: PreparedLaunchRecord,
    agentCommand: string,
  ): Operation<ExitedLaunchRecord> {
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
    // An incomplete replay reaches here with nothing prepared live. Everything
    // the retained record claims is reconciled against the durable route before
    // the first live effect — which is this spawn.
    if (
      prepared.identityProvenance === "client-allocated" &&
      !invocation.pending.has(prepared.sessionKey)
    ) {
      const refused = yield* reconcileRetainedLaunch(invocation, prepared, adapter, agentCommand);
      if (refused) {
        return refused;
      }
    }

    // Step 6: the exact live path this run observed, with the argv the adapter
    // says creates or resumes. A fresh session is created BY this process —
    // `--session-id` plus the private instruction file — and a retained one is
    // resumed. Neither shape reaches a record.
    const pending = invocation.pending.get(prepared.sessionKey);
    let command: string[];
    if (pending) {
      const args = pending.fresh
        ? pending.binding.create(
            prepared.nativeSessionId,
            yield* privateInstructionFile(prepared.instructions),
          )
        : pending.binding.resume(prepared.nativeSessionId);
      command = [pending.bound.livePath, ...args];
    } else {
      command = adapter.resume(prepared.nativeSessionId);
    }

    try {
      const outcome = yield* nativeLaunch({ command, cwd: prepared.cwd });
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
    if (error instanceof HostAssemblyIncomplete) {
      return refusal("unsupported-capability", error.message, known);
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
    // Every handle this provider still holds, closed through the runtime that
    // made it — not through "the" runtime. A provider with a bound partition
    // has more than one, and closing a bound handle through the unbound runtime
    // is the same cross-partition mistake as prompting through it.
    {
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
          yield* until(entry.runtime.close({ handle: entry.handle, reason: "scope teardown" }));
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
      requireAssemblyBeforePlacement(agentName, option);
      const prepared = yield* withSessionRoute(context, () =>
        prepare(agentName, option, callerCwd),
      );
      return yield* owning(
        agentName,
        agentCommandOf(prepared),
        prepared.sessionKey,
        "session",
        function* (ownership) {
          // Inside ownership, before any provider construction effect.
          // `<Session>` is eager, so establishing one publishes `acp-first` and
          // a client-native launch inside it later refuses rather than converting.
          const route = yield* reconciled(agentName, prepared, () =>
            acpFirstRoute(agentCommandOf(prepared), prepared.sessionKey),
          );
          const bound = yield* attachmentBuild(agentName, prepared, route);
          const session = yield* turns.withSlot(prepared.sessionKey, () =>
            withSessionRoute(context, function* () {
              const entry = yield* ensureFromPrepared(
                agentName,
                prepared,
                bound,
                route?.route === "client-native" ? route.nativeSessionId : undefined,
              );
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
        },
      );
    },
    promptStream,
    launch,
  };
}
