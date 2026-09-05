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
  createScope,
  each,
  ensure,
  Err,
  Ok,
  scoped,
  spawn,
  stream,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Result, Scope, Stream } from "effection";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent, isSessionRequest, sameExecutableBuild } from "@executablemd/core";
import type {
  ExecutableBuildBindingV1,
  AgentSessionRequest,
  AgentLaunchRequest,
  AgentProviderAuthority,
  AgentPromptEvent,
  AgentProviderFactory,
  AgentProviderOptions,
  DetachedLaunchRecord,
  InstructionReconciliation,
  ExitedLaunchRecord,
  LaunchFailure,
  LaunchFailureClass,
  LaunchOptions,
  MaterializationPlan,
  MaterializationUsage,
  MaterializedLaunchRecord,
  PreparedLaunchRecord,
  PromptOptions,
  Session,
  SessionLaunchResult,
} from "@executablemd/core";
import { allocatesIdentity, bindsBuild } from "./native-launch.ts";
import type {
  BoundProviderReturnedAdapter,
  BuildBoundAdapter,
  ClientAllocatedAdapter,
  NativeAdapter,
  NativeBinding,
} from "./native-launch.ts";
import { AgentSessionRouteError } from "./session-route.ts";
import type {
  AgentSessionRoute,
  AgentSessionRouteStore,
  AgentSessionRouteV3,
} from "./session-route.ts";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "./acpx-runtime.ts";
import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeMaterialization,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult,
  AcpRuntimeUsageBreakdown,
  AcpRuntimeUsageCost,
  AcpSessionRecord,
  AcpSessionStore,
  SessionAgentOptions,
} from "./acpx-runtime.ts";
import {
  AgentToolPermissionRefused,
  createPermissionBridge,
  strictPermissions,
} from "./permission-bridge.ts";
import { consumeTurn } from "./events.ts";
import { checkpointFromResult } from "./checkpoint.ts";
import { resolveSessionPlacement } from "./session-key.ts";
import { useSerialQueues } from "./serial-queue.ts";
import {
  AgentSessionBusy,
  AgentSessionRecoveryRequired,
  cwd,
  ExecutableObservationError,
  nativeLaunch,
  notifyTerminal,
} from "@executablemd/runtime";
import type {
  AgentSessionCoordinator,
  AgentSessionKey,
  AgentSessionOwnerKind,
  AgentSessionOwnership,
  ExecutableObserver,
} from "@executablemd/runtime";
import {
  ADVERTISED_CLIENT_NATIVE_ATTACHMENT,
  ADVERTISED_NATIVE_LAUNCH,
  knownNativeAdapters,
  nativeAdapterFor,
} from "./native-launch.ts";

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
  /** The authored `<Session>` name, when the document named one. Descriptive. */
  readonly session: string | undefined;
  /**
   * The engine-derived expansion identity of the `<Session>` element, when one
   * routed a placement.
   *
   * The only thing here a document cannot change. It arrives through the
   * authority delivered to this provider rather than on the public chain, so a
   * handler that rewrote the name above did not rewrite this.
   */
  readonly sessionIdentity?: string;
}

/** Where one logical session lives, as the host placing it decides. */
export interface AcpxSessionPlacement {
  readonly sessionKey: string;
  readonly cwd: string;
  /**
   * Whether a session already stands behind this placement.
   *
   * `pending` names where a session will live and says nothing has constructed
   * one: no construction route, no provider handle, no resumable identity.
   * `established` says the immutable route and the durable identity both exist,
   * which is what makes eager validation meaningful.
   */
  readonly state: "pending" | "established";
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
   * Retain what ACPX asserted, once the session is established.
   *
   * Called where an assertion exists and not before: for a session this
   * provider reattaches to, after the ensure that validated it; for one being
   * constructed through ACP, after the backend accepted its first turn and the
   * provider's own record was promoted to assert an identity. A placement whose
   * first turn failed reaches this on no path, because there is nothing to
   * retain.
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
   * Make one agent's command runnable, before anything tries to run it.
   *
   * Called with the resolved agent name at the first point this provider would
   * spawn that agent — the availability probe — and again is harmless. A host
   * whose agent command names something it has to put on disk first hooks here;
   * the default does nothing, because an ordinary command is already there.
   *
   * It runs only when an agent is actually resolved, so a document that never
   * asks for one prepares nothing.
   */
  prepareAgent?: (agentName: string) => Operation<void>;
  /**
   * The native adapters this host has proven and is therefore willing to hand
   * a session to. Absent means none: knowing an adapter's command shape is not
   * evidence that its native UI resumes the session ACP created.
   */
  advertiseNativeLaunch?: readonly string[];
  /**
   * The adapters this host has proven it can attach ACP to after a native
   * process constructed the session.
   *
   * A separate choice from the one above, and never inferred from it: handing a
   * session to a native UI and later joining that same conversation through ACP
   * prove different things. Absent means none.
   */
  advertiseClientNativeAttachment?: readonly string[];
  /**
   * How this host observes the build behind an executable.
   *
   * Supplied directly by the host that built it, like the coordinator and the
   * route store beside it. It is deliberately not a contextual Api: executable
   * validation decides which retained history may be accepted, and a decision
   * document middleware could replace could point the observation at one binary
   * while the run spawns another.
   *
   * Absent means this host cannot say which build it would run, so an agent
   * whose sessions XMD names refuses before any provider effect.
   */
  executableObserver?: ExecutableObserver;
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
   * How each logical session was first constructed, durably.
   *
   * Supplied directly by the same host that built the coordinator, and rooted
   * beside it, because one session's ownership and its construction are two
   * facts about one thing. Absent means this host cannot say how a session was
   * constructed: an advertised agent that names its own sessions then refuses
   * before any provider effect, because constructing one a second way is
   * exactly what the route exists to prevent. An adapter whose provider returns
   * the identity does not need one — it constructs nothing this route governs.
   */
  routeStore?: AgentSessionRouteStore;
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

/**
 * One observed build, ready to be bound to a session.
 *
 * `livePath` is the canonical path this run spawns and hands to the matching
 * ACP child through `environment`. It appears in no record, route, diagnostic,
 * result, or parent environment, and it does not outlive the operation that
 * observed it.
 */
interface BoundBuild {
  agentName: string;
  agentCommand: string;
  binding: ExecutableBuildBindingV1;
  livePath: string;
  environment: Record<string, string>;
  /** The exact ACP adapter command this binding was proven against, if pinned. */
  adapterCommand: string | undefined;
}

/**
 * One live ACP runtime, and what it is for.
 *
 * A bound entry exists only while it owns handles. When its last one closes it
 * is removed and a later operation reobserves the build and builds another —
 * because what a bound partition holds is a live executable path, and a
 * partition kept past its work would be holding one for nobody.
 */
interface RuntimeEntry {
  runtime: ProbeCapableRuntime;
  /** The `(agent command, binding)` partition, or nothing for the unbound one. */
  partition: string | undefined;
  /** Handles created through this runtime that have not been closed. */
  handles: number;
  /**
   * Work that has claimed this runtime and has not yet produced a handle.
   *
   * Counted apart from `handles` because the two are true at different times
   * and both keep the partition alive. An ensure in flight owns no handle yet,
   * and a partition evicted underneath it would let a concurrent operation
   * build a second child for the same build while the first is still talking.
   */
  active: number;
}

/**
 * What a returned `Session` value still resolves to once its handle is gone.
 *
 * Placement and session metadata, and nothing else. The handle and the runtime
 * that made it are deliberately absent: a runtime carries the transient child
 * environment, and therefore the canonical executable path, so a released
 * session that still named one would be that path outliving the single owned
 * operation it was observed for. The next use of this value re-ensures, which
 * is what reattaches ACP to whatever holds the session now — a native UI it was
 * handed to, or nothing at all.
 */
interface DetachedSession {
  agentCommand: string;
  cwd: string;
  /**
   * The exact value `session()` issued for this placement.
   *
   * Retained rather than rebuilt, and compared by identity rather than by
   * `sessionKey`: provider provenance is what this value carries, and a
   * structural copy carrying the same key was issued by nobody.
   */
  session: Session;
  state: "pending" | "established";
}

interface ManagedSession extends DetachedSession {
  handle: AcpRuntimeHandle;
  /**
   * The runtime that created this handle.
   *
   * Retained rather than looked up again: reaching for "the" runtime afterwards
   * opens a second child for a session the first already owns, so every turn,
   * close, detach and teardown goes through the one that made the handle.
   */
  runtime: RuntimeEntry;
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
      placement: AcpxSessionPlacement;
      /** The exact value already issued for this placement, when there is one. */
      issued?: Session;
    };

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The provider identity retained in a launch record. */
const ACPX_PROVIDER = "acpx";

/** Where this provider puts prepared instructions on a session it creates. */
const INSTRUCTION_CHANNEL = "acp.session.systemPrompt";
/**
 * Where a client-native session's instruction layer comes from.
 *
 * A file, not a session option: the native process is what creates the session,
 * and it is told the layer by path so the text never reaches the process table.
 */
const CLIENT_NATIVE_CHANNEL = "claude.systemPromptFile";

/**
 * A host that cannot answer a question this session needs answered.
 *
 * Raised where ownership is acquired, so it travels the path a contention or
 * recovery answer travels, but it is a different thing to be told: nothing is
 * wrong with the session, and no recovery would help. This host simply is not
 * assembled to act on it, and another one is.
 */
class HostAssemblyIncomplete extends AgentSessionRecoveryRequired {
  override name = "HostAssemblyIncomplete";
}

/**
 * Everything one launch learned by running, rather than by replaying.
 *
 * Both members are observations, and an observation is only about the run that
 * made it. `fresh` says this invocation published the identity, so the native
 * process still has to create the session. `detachedLive` says the detach phase
 * ran here rather than coming back from the journal, which is how a replay
 * knows its predecessor never reached the handoff.
 *
 * Held on the provider, either one would answer a later replay with a previous
 * launch's evidence — a creation attempted twice, or a resume turned into a
 * second conversation under an identity that already names one. So it is
 * created inside `launch()` and reaches the phases only as an argument.
 */
/**
 * A refusal this launch retains rather than raises.
 *
 * A `Result` carries its failure as an `Error`, and what has to travel here is
 * the settled thing to say about a session whose two durable accounts disagree
 * — so the `LaunchFailure` rides on the error rather than beside it. Only this
 * class means "already decided": anything else raised on the same path came
 * from private setup and says nothing repeatable.
 */
class RetainedRefusal extends Error {
  override name = "RetainedRefusal";
  constructor(readonly failure: LaunchFailure) {
    super(failure.message);
  }
}

/**
 * A refusal on a path that has no launch to fail.
 *
 * `<Session>` and `<Prompt>` raise rather than retain, so the same settled
 * decision travels as an ordinary error with its stable class attached. A
 * launch that meets one turns it back into a retained refusal.
 */
class AttachmentRefused extends Error {
  override name = "AttachmentRefused";
  constructor(readonly failure: LaunchFailure) {
    super(failure.message);
  }
}

interface LaunchInvocation {
  /** Sessions this invocation published an identity for. */
  readonly fresh: Map<string, boolean>;
  /**
   * The build each bound session in this invocation observed, and the argv
   * shape that goes with it.
   *
   * Held on the invocation rather than the provider, because a live executable
   * path is only true for the run that observed it. A later replay reobserves
   * rather than finding one lying about.
   */
  readonly bound: Map<string, { build: BoundBuild; adapter: BuildBoundAdapter }>;
  /** Sessions whose detach phase ran live in this invocation. */
  readonly detachedLive: Set<string>;
  /**
   * Sessions whose retained record this invocation has already checked against
   * its route.
   *
   * A replay reconciles before its own first live phase, and which phase that
   * is depends on what the journal retained — detach for one suffix, exit for
   * the other. Recording it is what keeps the check from running twice.
   */
  readonly reconciled: Set<string>;
}

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
  session(option?: string | Session | AgentSessionRequest): Operation<Session>;
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
          return yield* (yield* selected()).placeSession(name, authority);
        },
        *prompt([content, options], _next) {
          // Selection belongs inside the subscription, with the rest of the
          // turn's work: constructing a stream chooses nothing and starts
          // nothing, which is what keeps it cold.
          return {
            *[Symbol.iterator]() {
              const state = yield* selected();
              return yield* state.promptStream(content, options, authority);
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
  /**
   * The same turn, with the authority that can name which turn it was.
   *
   * Optional here and absent from {@link AcpxProvider}: an embedder holding a
   * partition drives turns without an authority and names none, and the public
   * handle forwards no third argument. A checkpoint is durable identity, so the
   * ability to state one arrives the way a launch's does — delivered to the
   * installed factory, never reachable from a handle.
   */
  promptStream(
    content: string,
    options?: PromptOptions,
    authority?: AgentProviderAuthority,
  ): Stream<AgentPromptEvent, string>;
  /**
   * The same resolution, with the authority that can read a placement.
   *
   * Delivered as a live argument for the same reason a launch's is: the engine
   * identity a `<Session>` routes is readable only through it, and a provider
   * state holding one would be holding authority it could hand anywhere.
   */
  placeSession(
    option: string | Session | AgentSessionRequest | undefined,
    authority: AgentProviderAuthority,
  ): Operation<Session>;
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

  session(option?: string | Session | AgentSessionRequest): Operation<Session> {
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
  const launchAdvertised = new Set(dependencies?.advertiseNativeLaunch ?? ADVERTISED_NATIVE_LAUNCH);
  const attachAdvertised = new Set(
    dependencies?.advertiseClientNativeAttachment ?? ADVERTISED_CLIENT_NATIVE_ATTACHMENT,
  );
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
  const agentCwd = dependencies?.agentCwd ?? cwd;
  const prepareAgent = dependencies?.prepareAgent;
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

  /**
   * One ACP runtime per `(agent command, executable build)`, plus the unbound
   * one ordinary ACP-first work has always used.
   *
   * Sessions established against different builds never share an ACP child.
   * That is what observing a build is for: a child running the wrong Claude
   * accepts the session identity and disagrees silently about what it names.
   */
  let unbound: RuntimeEntry | undefined;
  const runtimes = new Map<string, RuntimeEntry>();
  /**
   * Every handle this provider created and has not successfully closed.
   *
   * Separate from `managed`, which is the map of *usable* sessions. A handle
   * whose ensure came back and whose validation then failed is not a session
   * anyone may prompt through, but it is still a live thing this provider owns
   * — so teardown has to be able to reach it, through the runtime that made it.
   */
  const owned = new Set<ManagedSession>();
  const validatedAgents = new Set<string>();
  const managed = new Map<string, ManagedSession | DetachedSession>();
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

  /** The `(agent command, build)` partition a bound runtime is kept under. */
  function partitionOf(build: BoundBuild): string {
    return [
      build.agentCommand,
      build.binding.reportedVersion,
      build.binding.executableDigest.algorithm,
      build.binding.executableDigest.value,
    ].join("\u0000");
  }

  /**
   * The registry a bound runtime resolves adapters through.
   *
   * Only the bound agent is pinned, and only for the child this runtime spawns.
   * Everything else — including the natural key this session is owned and
   * routed under — keeps the base registry's answer, so a session established
   * before the pin existed is still found under the same key.
   */
  function pinnedRegistry(agentName: string, adapterCommand: string): AcpAgentRegistry {
    return {
      resolve: (name) => (name === agentName ? adapterCommand : registry.resolve(name)),
      list: () => registry.list(),
    };
  }

  /**
   * Everything building a runtime for `build` would need, resolved in advance.
   *
   * This is where the suspension lives — the directory an Agent runs in is
   * asked for here — and it deliberately decides nothing and publishes nothing.
   * Separating it is what lets the decision that follows be one synchronous
   * step: an election that suspends part-way through is an election another
   * operation can act between.
   */
  function* runtimeBlueprint(build?: BoundBuild): Operation<AcpRuntimeOptions> {
    const base = yield* runtimeOptions();
    const options: AcpRuntimeOptions = {
      ...base,
      // The acpx callback boundary: `scope.run` returns a Promise-compatible
      // Future over the operation-based bridge decision.
      onPermissionRequest: (request, ctx) =>
        stateScope.run(() => bridge.decision(request, ctx.signal)),
    };
    if (build) {
      // Transient by construction: handed to the runtime for the children it
      // spawns, never persisted, exported, or written into a session record.
      // `agentProcessEnv` is the vendored patch's whole purpose.
      options.agentProcessEnv = build.environment;
      if (build.adapterCommand !== undefined) {
        options.agentRegistry = pinnedRegistry(build.agentName, build.adapterCommand);
      }
    }
    return options;
  }

  /**
   * Elect the runtime for this partition and claim it, in one step.
   *
   * Synchronous from the map read to the claim, and that is the whole point.
   * Publishing an entry and then claiming it across a suspension leaves it in
   * the map standing on nothing — long enough for a sibling giving up its own
   * claim to evict it, after which this caller holds a runtime the map no
   * longer names and the next operation builds a second child for the same
   * build. Here the entry is published already claimed.
   */
  function electRuntime(partition: string | undefined, options: AcpRuntimeOptions): RuntimeEntry {
    const held = partition === undefined ? unbound : runtimes.get(partition);
    if (held) {
      held.active++;
      return held;
    }
    const entry: RuntimeEntry = {
      runtime: createRuntime(options),
      partition,
      handles: 0,
      active: 1,
    };
    if (partition === undefined) {
      unbound = entry;
    } else {
      runtimes.set(partition, entry);
    }
    return entry;
  }

  /** Whether this placement still names a handle this provider can act through. */
  function isLive(placed: ManagedSession | DetachedSession): placed is ManagedSession {
    return "handle" in placed;
  }

  /**
   * Keep what a returned `Session` value needs, and drop everything else.
   *
   * Called only where a close actually settled. What is left names the session
   * and where it is; the handle and its runtime are gone from every map this
   * provider can reach, which is what stops a live executable path outliving
   * the work it was observed for.
   */
  function detachPlacement(sessionKey: string, entry: ManagedSession): void {
    managed.set(sessionKey, {
      agentCommand: entry.agentCommand,
      cwd: entry.cwd,
      session: entry.session,
      state: entry.state,
    });
  }

  /**
   * Remove a bound partition nothing is using any more.
   *
   * A bound partition holds a live executable path for the work it owns, so it
   * is kept exactly as long as something is standing on it — a handle nobody
   * has closed, or work that has claimed the runtime and not yet produced one.
   * Both have to be zero: evicting while either is nonzero is how a concurrent
   * operation ends up building a second child for a build the first is still
   * talking to. The unbound runtime is ordinary ACP-first state and stays.
   */
  function evictIfIdle(entry: RuntimeEntry): void {
    if (entry.partition === undefined || entry.handles > 0 || entry.active > 0) {
      return;
    }
    if (runtimes.get(entry.partition) === entry) {
      runtimes.delete(entry.partition);
    }
  }

  /**
   * The claimed work produced this handle, so the claim becomes ownership of it.
   *
   * One step, because the two counts must never both be zero in between: that
   * gap is a partition another operation could evict out from under a handle
   * that had just been created.
   */
  function adoptHandle(session: ManagedSession): void {
    session.runtime.handles++;
    session.runtime.active = Math.max(0, session.runtime.active - 1);
    owned.add(session);
  }

  /** The claimed work produced no handle. Nothing is standing on it here. */
  function releaseReservation(entry: RuntimeEntry): void {
    entry.active = Math.max(0, entry.active - 1);
    evictIfIdle(entry);
  }

  /**
   * The bookkeeping a close earns by settling.
   *
   * Never called for a close that failed: a failed close released nothing, so
   * decrementing the partition, evicting it, or forgetting the handle would all
   * be claiming something that did not happen. Idempotent, because the set
   * membership is the guard — a handle released twice must not decrement twice.
   */
  function releasedHandle(session: ManagedSession): void {
    if (!owned.delete(session)) {
      return;
    }
    session.runtime.handles = Math.max(0, session.runtime.handles - 1);
    evictIfIdle(session.runtime);
  }

  /**
   * Ensure through the runtime for `build`, settling that work's claim exactly
   * once however this operation ends.
   *
   * `ensureSession()` is a Promise, and starting one is not the same as owning
   * it. Once called it runs whether or not anybody is still waiting: a scope
   * halted at the `until()` below leaves it in flight, and the provider may
   * still answer with a live handle — a child nobody would ever close, on a
   * partition nobody would ever release.
   *
   * So the settlement is scope-owned rather than written into a `catch`, which
   * a cancellation does not run at all. The cleanup is registered with the
   * Promise already started and before anything yields, so there is no window
   * in which this can end with the claim unsettled and the answer unobserved.
   * The three ways out are the three branches below, and the flag is what keeps
   * the normal continuation and the cleanup from both taking one: nothing
   * yields between the handle arriving and that flag being set.
   */
  function ensureThrough(
    build: BoundBuild | undefined,
    input: AcpRuntimeEnsureInput,
    toSession: (handle: AcpRuntimeHandle, entry: RuntimeEntry) => ManagedSession,
  ): Operation<ManagedSession> {
    return scoped(function* (): Operation<ManagedSession> {
      const partition = build ? partitionOf(build) : undefined;
      // Every suspension this needs, taken before anything is decided. What
      // follows must not yield, so nothing it depends on may.
      const options = yield* runtimeBlueprint(build);
      let claimed: RuntimeEntry | undefined;
      let pending: Promise<AcpRuntimeHandle> | undefined;
      let settled = false;

      // Registered before anything is claimed or published, and before the
      // ensure is started, because all of those are synchronous and this is
      // not: an `ensure` registered after them could be cut off by a
      // cancellation delivered while `ensureSession()` was still on the stack,
      // which is exactly when there is a Promise in flight and nobody left to
      // observe it.
      yield* ensure(function* () {
        if (settled) {
          return;
        }
        settled = true;
        if (claimed === undefined) {
          // Cancelled before the election. Nothing was published and nothing
          // claimed, so there is nothing here to give back.
          return;
        }
        const entry = claimed;
        if (pending === undefined) {
          releaseReservation(entry);
          return;
        }
        // Cancelled with the ensure in flight. Waiting for the answer is the
        // point: walking away from it is how a handle is created for a session
        // this run has already stopped caring about, and never closed.
        const answered = yield* until(
          pending.then(
            (handle: AcpRuntimeHandle) => handle,
            () => undefined,
          ),
        );
        if (answered === undefined) {
          releaseReservation(entry);
          return;
        }
        // It answered. The handle is this provider's, so it goes into the
        // ledger before it is given up — a close that fails then leaves it
        // owned, the session unquiesced and the partition standing, exactly as
        // a close that fails anywhere else does.
        const late = toSession(answered, entry);
        adoptHandle(late);
        yield* abandonHandle(late, "cancelled before the session was established");
      });

      // One synchronous step: the map is read, an entry is published already
      // claimed if this is the first work to want one, and the ensure is
      // started. Nothing yields in here, so no sibling runs between the
      // publication and the claim that keeps it alive.
      const entry = electRuntime(partition, options);
      claimed = entry;
      pending = entry.runtime.ensureSession(input);

      let handle: AcpRuntimeHandle;
      try {
        handle = yield* until(pending);
      } catch (error) {
        // Eager, so a later attempt in this same scope does not meet a
        // partition this one is no longer standing on. The cleanup above would
        // reach the same answer; this reaches it now.
        settled = true;
        releaseReservation(entry);
        throw error;
      }
      const session = toSession(handle, entry);
      adoptHandle(session);
      settled = true;
      return session;
    });
  }

  /**
   * Give up a handle that may not be used, through the runtime that made it.
   *
   * A close that failed leaves the handle owned and its partition standing, so
   * teardown reaches both again. Whatever the caller does next — raise, refuse,
   * retain a failure — is unaffected by which of those happened; what differs
   * is what this provider still has to answer for.
   */
  function* abandonHandle(session: ManagedSession, reason: string): Operation<void> {
    try {
      yield* until(session.runtime.runtime.close({ handle: session.handle, reason }));
    } catch (error) {
      cleanupErrors.push(toError(error));
      return;
    }
    releasedHandle(session);
  }

  function* resolveAgent(name: string | undefined): Operation<string> {
    const selected = name ?? providerOptions.defaultAgent;
    // Before the probe, because the probe spawns this agent's command: a host
    // that materializes its own adapter has to have done so by now, and a
    // failure here refuses the agent rather than reporting it unavailable for a
    // reason that names the wrong cause.
    if (prepareAgent !== undefined) {
      yield* prepareAgent(selected);
    }
    // Resolution is read-only for an agent whose sessions are bound to a build.
    // Probing spawns an ACP child, and that is provider work on a session whose
    // construction has not been settled yet — it would run before the route is
    // published, before a route this surface cannot serve can refuse it, and
    // before a host missing either capability has said so. It would also spawn a
    // child of a build nothing has observed, which is the one thing a bound
    // session may not talk to. Nothing on that path needs the answer: a
    // client-native session is created by a native process, and where ACP does
    // serve one, the establishment itself reports being unable to.
    if (!validatedAgents.has(selected) && !boundSessions(selected)) {
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
    sessionIdentity?: string,
  ): Operation<Prepared> {
    if (typeof option === "object") {
      const entry = managed.get(option.sessionKey);
      // Identity, never the key: this provider issued exactly one value for this
      // placement and kept it. A structural copy, a value from another provider
      // copy or a torn-down scope, and a look-alike built around a key somebody
      // read are none of them that value.
      if (!entry || entry.session !== option) {
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
      if (!isLive(entry)) {
        // Nothing of this provider's holds the session any more: the handle was
        // released, or handed to a native UI. Reaching for the same key
        // re-ensures it, which reattaches ACP to whatever holds it now rather
        // than reusing a connection older than that.
        return {
          kind: "placement",
          sessionKey: entry.session.sessionKey,
          agentCommand: entry.agentCommand,
          placement: {
            sessionKey: entry.session.sessionKey,
            cwd: entry.cwd,
            state: entry.state,
          },
          issued: entry.session,
        };
      }
      return { kind: "existing", sessionKey: option.sessionKey, entry };
    }
    const agentCommand = registry.resolve(agentName);
    if (sessions) {
      const placed = yield* sessions.place({
        agentName,
        agentCommand,
        session: option,
        ...(sessionIdentity === undefined ? {} : { sessionIdentity }),
      });
      return placedPrepared(agentCommand, placed);
    }
    const placement = yield* resolveSessionPlacement(store, agentCommand, callerCwd, option);
    return placedPrepared(agentCommand, placement);
  }

  /**
   * One placement, with whatever this provider has already issued for it.
   *
   * A second `<Session>` naming the same placement gets the same value back:
   * the exact object is what provenance is, and minting a replacement would
   * leave the first one unusable.
   */
  function placedPrepared(agentCommand: string, placement: AcpxSessionPlacement): Prepared {
    const held = managed.get(placement.sessionKey);
    const prepared: Prepared = {
      kind: "placement",
      sessionKey: placement.sessionKey,
      agentCommand,
      placement,
    };
    return held === undefined ? prepared : { ...prepared, issued: held.session };
  }

  /**
   * Whether this placement's construction route and durable identity exist.
   *
   * The host's own answer, plus the one thing it cannot see: a session a native
   * process constructed is established from the moment its route exists, even
   * though ACPX has attached to it and holds no record yet. An `acp-first`
   * route is not establishment — it is what a first turn publishes before it
   * runs, and a first turn that failed leaves exactly that behind.
   */
  function* placementState(
    agentName: string,
    agentCommand: string,
    placement: AcpxSessionPlacement,
  ): Operation<"pending" | "established"> {
    if (placement.state === "established") {
      return "established";
    }
    if (!namesOwnSessions(agentName) || !routeStore) {
      return "pending";
    }
    const route = yield* routeStore.read(sessionKeyOf(agentCommand, placement.sessionKey));
    return route?.route === "client-native" ? "established" : "pending";
  }

  /**
   * What this placement is now, read again after its queue granted.
   *
   * The predecessor in that queue may have established the very session this
   * caller is about to construct, and acting on what was read before waiting is
   * how one placement ends up with two conversations.
   */
  function* requeried(prepared: Prepared): Operation<Prepared> {
    const sessionKey = prepared.sessionKey;
    const held = managed.get(sessionKey);
    if (held && isLive(held)) {
      return { kind: "existing", sessionKey, entry: held };
    }
    const agentCommand = agentCommandOf(prepared);
    const cwd =
      held?.cwd ?? (prepared.kind === "existing" ? prepared.entry.cwd : prepared.placement.cwd);
    const record = yield* until(store.load(sessionKey));
    const established =
      held?.state === "established" ||
      (record !== undefined && record.sessionMaterialization?.state !== "pending");
    const placement: AcpxSessionPlacement = {
      sessionKey,
      cwd,
      state: established ? "established" : "pending",
    };
    return placedPrepared(agentCommand, placement);
  }

  /**
   * Remember the exact pending value this placement was issued.
   *
   * Nothing else happens: no ownership is taken, no route is published, no
   * runtime is built, no record is written and no backend is contacted. What
   * this provider keeps is the value itself, because that object — not the key
   * inside it — is what a later operation has to present.
   */
  function placePending(prepared: Extract<Prepared, { kind: "placement" }>): Session {
    if (prepared.issued !== undefined) {
      return prepared.issued;
    }
    const session: Session = {
      sessionKey: prepared.placement.sessionKey,
      cwd: prepared.placement.cwd,
    };
    managed.set(prepared.sessionKey, {
      agentCommand: prepared.agentCommand,
      cwd: prepared.placement.cwd,
      session,
      state: "pending",
    });
    return session;
  }

  /** This placement now has a route and an identity of its own. */
  function markEstablished(sessionKey: string): void {
    const held = managed.get(sessionKey);
    if (held) {
      held.state = "established";
    }
  }

  /** What one ensure is for, beyond the placement it is for. */
  interface EnsureIntent {
    /**
     * The observed build this ensure's ACP child must be.
     *
     * Separate from `attachment`, because the two answer different questions
     * and not every session that has one has the other: a session the provider
     * named is bound to a build without any identity for ACP to be told to
     * reopen.
     */
    build?: BoundBuild;
    attachment?: { resumeSessionId: string };
    /** The placement's state, as the caller resolved it. */
    state: "pending" | "established";
    /**
     * Let ACPX hold this record as occupancy until the backend accepts the
     * first turn, rather than asserting an identity the moment it is created.
     */
    materialization?: boolean;
    /**
     * Leave the host mapping to the caller, which commits it after that
     * acceptance rather than after this ensure.
     */
    deferEstablished?: boolean;
  }

  function* ensureFromPrepared(
    agentName: string,
    prepared: Prepared,
    intent: EnsureIntent,
  ): Operation<ManagedSession> {
    if (prepared.kind === "existing") {
      return prepared.entry;
    }
    const attachment = intent.attachment;
    // A client-native session was created by a native process under an identity
    // XMD chose, so ACP attaches to it by name and never creates under it. That
    // is what `resumeSessionId` says, and it is the whole reason the identity
    // was allocated before the provider existed.
    //
    // The handle it answers with is this provider's from the moment it exists,
    // bound to its creator, and every check below can still refuse it — which
    // is why the ensure settles its own claim rather than leaving that to a
    // `catch` a cancellation never reaches.
    let managedEntry: ManagedSession;
    try {
      managedEntry = yield* ensureThrough(
        intent.build,
        {
          sessionKey: prepared.placement.sessionKey,
          agent: agentName,
          mode: "persistent",
          cwd: prepared.placement.cwd,
          ...(attachment === undefined ? {} : { resumeSessionId: attachment.resumeSessionId }),
          ...(newSessionOptions === undefined ? {} : { sessionOptions: newSessionOptions }),
          ...(intent.materialization === true
            ? { materialization: "first-turn-acceptance" as const }
            : {}),
        },
        (handle, entry) => {
          // The exact value this provider already issued, when it issued one.
          // A fresh <Session> pinned that object, and handing back a second one
          // here would leave the pinned one naming a session nothing admits.
          const session: Session = prepared.issued ?? {
            sessionKey: prepared.placement.sessionKey,
            cwd: prepared.placement.cwd,
          };
          if (handle.agentSessionId !== undefined) {
            session.agentSessionId = handle.agentSessionId;
          }
          return {
            handle,
            runtime: entry,
            agentCommand: prepared.agentCommand,
            cwd: prepared.placement.cwd,
            session,
            state: intent.state,
          };
        },
      );
    } catch (error) {
      if (attachment === undefined) {
        throw error;
      }
      // An exact resume that the provider could not perform: it has no such
      // history, or it cannot resume by name at all. Either way the
      // conversation this session names is not reachable, and the adapter's own
      // message would carry provider-private detail — so the stable class is
      // what crosses, and nothing was created in its place.
      throw new AttachmentRefused({
        class: "identity-unavailable",
        message:
          `session "${prepared.placement.sessionKey}" names a conversation this provider ` +
          `could not open, so there is nothing here to continue`,
      });
    }
    const handle = managedEntry.handle;

    if (attachment !== undefined && handle.agentSessionId !== attachment.resumeSessionId) {
      // The attachment answers with a different conversation than the one this
      // session was constructed as — or with none at all. Nothing here
      // reconciles that, and a turn taken through this handle would land in
      // history that is not this session's, so it is given up before it is used.
      yield* abandonHandle(managedEntry, "attachment identity mismatch");
      throw new AttachmentRefused({
        class: "identity-unavailable",
        message:
          `session "${prepared.placement.sessionKey}" names a conversation this attachment ` +
          `did not report, so a turn taken here would not belong to it`,
      });
    }
    if (sessions?.established && intent.deferEstablished !== true) {
      const identity: AcpxSessionIdentity = {
        ...(handle.agentSessionId === undefined ? {} : { agentSessionId: handle.agentSessionId }),
        ...(handle.acpxRecordId === undefined ? {} : { acpxRecordId: handle.acpxRecordId }),
      };
      try {
        yield* sessions.established(prepared.placement, identity);
      } catch (error) {
        // The host could not retain what this session is. It is not a session
        // anyone may prompt through, so the handle is given up through the
        // runtime that made it — and the host's own refusal is what the caller
        // is told.
        yield* abandonHandle(managedEntry, "session retention refused");
        throw error;
      }
    }
    managed.set(prepared.sessionKey, managedEntry);
    return managedEntry;
  }

  /**
   * The natural key one logical session is owned under.
   *
   * Takes the command that was already resolved, never re-resolves it. A
   * registry may answer differently outside the critical section that pinned
   * this operation's placement, and a key recomputed there would name a
   * different session than the one this operation prepared. The coordinator key
   * and the route key have to be the same string or they are not describing one
   * session.
   */
  function sessionKeyOf(agentCommand: string, sessionKey: string): AgentSessionKey {
    return { provider: ACPX_PROVIDER, agent: agentCommand, sessionKey };
  }

  /** The resolved agent command behind a placement or an existing entry. */
  function agentCommandOf(prepared: Prepared): string {
    return prepared.kind === "existing" ? prepared.entry.agentCommand : prepared.agentCommand;
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
    return (
      (launchAdvertised.has(agentName) || attachAdvertised.has(agentName)) &&
      adapterFor(agentName) !== undefined
    );
  }

  /**
   * Whether this host will attach ACP to a session a native process constructed.
   *
   * Separate from native-launch advertisement, and never inferred from it. An
   * adapter may be proven to hand a session over without being proven to join
   * that conversation afterwards.
   */
  function attachable(agentName: string): boolean {
    const adapter = adapterFor(agentName);
    return attachAdvertised.has(agentName) && adapter !== undefined && allocatesIdentity(adapter);
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
    // The ledger, not the managed map. A handle whose validation failed never
    // became a usable session, so it is in no map a caller can reach — and it
    // is still a live thing this owner started. Membership here is the whole
    // answer: a handle leaves only when its close actually settled.
    for (const held of owned) {
      if (held.session.sessionKey === sessionKey) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether this agent's sessions are constructed under an identity XMD names.
   *
   * Only that shape needs a construction route: a provider that returns its own
   * identity constructs nothing this route governs, and keeps exactly its
   * merged behavior on a host that installs no route store.
   */
  function namesOwnSessions(agentName: string): boolean {
    const adapter = adapterFor(agentName);
    return ownable(agentName) && adapter !== undefined && allocatesIdentity(adapter);
  }

  /**
   * Whether this agent's sessions carry a construction route and one build.
   *
   * The two facts arrive together and for the same reason. A route says how the
   * session was first constructed, and for an adapter that pins a build the
   * build is part of that account: whichever side chose the identity, the name
   * resolves to one conversation only beside the build that issued or accepted
   * it. An agent whose adapter binds nothing keeps its merged behavior, on a
   * host that installs neither.
   */
  function boundSessions(agentName: string): boolean {
    const adapter = adapterFor(agentName);
    return ownable(agentName) && adapter !== undefined && bindsBuild(adapter);
  }

  /**
   * Refuse an advertised agent this host is not assembled to serve.
   *
   * Fail-closed, and closed means what the agent actually needs: every
   * advertised session needs a coordinator to say who owns it, and one bound to
   * a build also needs a route store to say how it was constructed and an
   * observer to say which build that was. A host that can answer one question
   * but not the other cannot act on a session a native UI may be in.
   */
  function requireAssembly(agentName: string, sessionKey: string): void {
    if (!ownable(agentName)) {
      return;
    }
    const missing: string[] = [];
    if (!coordinator) {
      missing.push("exclusive ownership");
    }
    if (boundSessions(agentName)) {
      if (!routeStore) {
        missing.push("construction routes");
      }
      if (!executableObserver) {
        missing.push("executable build observation");
      }
    }
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
   * Reconcile this session's construction route while ownership is held.
   *
   * Called after the coordinator has granted and before any provider
   * construction effect, which is the ordering the whole contract rests on: a
   * route read outside ownership could be published by someone else before this
   * caller acted on it.
   *
   * `intended` is what this operation would construct if nothing exists yet.
   * The answer is the route that governs — this caller's, or the one already
   * published — and adopting it is not optional: whoever published first
   * described the session that exists.
   */
  function* reconcileRoute(
    agentCommand: string,
    sessionKey: string,
    intended: () => Operation<AgentSessionRoute>,
    hasProviderState: boolean,
  ): Operation<AgentSessionRoute> {
    const key = sessionKeyOf(agentCommand, sessionKey);
    const existing = yield* routeStore!.read(key);
    if (existing) {
      return existing;
    }
    // A session ACP already established is ACP-first, whatever this operation
    // would otherwise have constructed. Existing history is never reclassified.
    if (hasProviderState) {
      return yield* routeStore!.publish(acpFirstRoute(agentCommand, sessionKey));
    }
    return yield* routeStore!.publish(yield* intended());
  }

  /**
   * What a route failure may say.
   *
   * `AgentSessionRouteError` is this package's own, and its text is written to
   * carry no path or host detail. Anything else came from somewhere that makes
   * no such promise, so it is replaced rather than quoted.
   */
  function routeMessage(error: unknown): string {
    return error instanceof AgentSessionRouteError
      ? error.message
      : "the construction route for this session could not be read, so it is not acted on";
  }

  /** The ACP-first route this session would be constructed under. */
  function acpFirstRoute(agentCommand: string, sessionKey: string): AgentSessionRoute {
    return {
      schema: "session-route.v1",
      route: "acp-first",
      provider: ACPX_PROVIDER,
      agent: agentCommand,
      sessionKey,
    };
  }

  /** The same route, for a session whose build was observed as it was bound. */
  function boundAcpFirstRoute(
    agentCommand: string,
    sessionKey: string,
    executableBinding: AgentSessionRouteV3["executableBinding"],
  ): AgentSessionRouteV3 {
    return {
      schema: "session-route.v3",
      route: "acp-first",
      provider: ACPX_PROVIDER,
      agent: agentCommand,
      sessionKey,
      executableBinding,
    };
  }

  /**
   * Publish or adopt `acp-first` for an agent whose sessions XMD would
   * otherwise name, and refuse if this session already has an identity.
   *
   * Eager on purpose. Creating provider history first and writing down how it
   * was constructed afterwards leaves a window in which a crash makes the
   * session look unconstructed — and a client-native launch meeting that window
   * would give a conversation that already exists a second identity.
   */
  /**
   * The exact live path of the build behind an adapter's command.
   *
   * Every way this can fail — no observer, resolution, canonicalization, an
   * unreadable or non-executable file, a version this adapter does not
   * recognize — ends in one stable class, because they are all the same
   * question: is this the build that established the session.
   */
  function* observeBuild(
    agentName: string,
    agentCommand: string,
    binding: NativeBinding,
  ): Operation<BoundBuild> {
    if (!executableObserver) {
      throw new AttachmentRefused({
        class: "executable-binding-refused",
        message:
          `this host cannot observe which build of "${agentName}" it would run, so it cannot ` +
          `bind a session to one`,
      });
    }
    let observed;
    try {
      observed = yield* executableObserver.observe(binding.command, {
        ...(binding.versionArgs === undefined ? {} : { versionArgs: binding.versionArgs }),
      });
    } catch (error) {
      // Only the observer's own stable reason crosses. Its message names a
      // path, and a path is host layout.
      throw new AttachmentRefused({
        class: "executable-binding-refused",
        message: `the build behind "${agentName}" could not be observed: ${
          error instanceof ExecutableObservationError ? error.refusal : "unavailable"
        }`,
      });
    }
    const version = binding.version(observed.versionOutput);
    if (version === undefined) {
      // Deliberately without the raw output: it is provider-private, and this
      // message is retained in a diagnostic.
      throw new AttachmentRefused({
        class: "executable-binding-refused",
        message:
          `"${agentName}" reported a version this adapter does not recognize, so the build ` +
          `behind it cannot be named`,
      });
    }
    return {
      agentName,
      agentCommand,
      livePath: observed.path,
      binding: {
        schema: "executable-build.v1",
        reportedVersion: version,
        executableDigest: observed.digest,
      },
      environment: binding.environment(observed.path),
      adapterCommand: binding.adapterCommand,
    };
  }

  /** The stable comparison two builds of one session fail. */
  function buildDrift(
    sessionKey: string,
    retained: ExecutableBuildBindingV1,
    live: ExecutableBuildBindingV1,
  ): LaunchFailure {
    return {
      class: "executable-binding-refused",
      message:
        `session "${sessionKey}" was created by ${retained.reportedVersion} and this run ` +
        `would use ${live.reportedVersion}, so the conversation it names cannot be confirmed`,
    };
  }

  /**
   * What a client-native route's provider arrangement already asserts.
   *
   * An ACPX record is arrangement, not identity, so its absence is not a reason
   * to refuse: exact resume is what this attachment is for, and a record is
   * created by making it. What a record that already exists may not do is
   * disagree — a record asserting another conversation, or asserting none at
   * all, describes provider state this session cannot account for.
   */
  function* retainedAssertion(sessionKey: string, nativeSessionId: string): Operation<void> {
    const record = yield* until(store.load(sessionKey));
    if (record === undefined) {
      return;
    }
    if (record.agentSessionId === nativeSessionId) {
      return;
    }
    throw new AttachmentRefused({
      class: "identity-unavailable",
      message:
        record.agentSessionId === undefined
          ? `session "${sessionKey}" has provider arrangement that asserts no conversation, so ` +
            `there is nothing here to confirm it names the one this session was constructed as`
          : `session "${sessionKey}" has provider arrangement naming a different conversation ` +
            `than the one it was constructed as, and neither account repairs the other`,
    });
  }

  /**
   * Observe the build behind a session the provider names, and settle its route.
   *
   * The order is the contract. The build is observed before the route is read,
   * because for this construction the build is part of what the route says: an
   * identity the provider issues resolves to one conversation only beside the
   * build that issued it, so a route published without one would describe a
   * session no later run could confirm. What comes back is the build every
   * provider effect for this session then goes through.
   *
   * A session that already has provider state but no route was constructed
   * before this contract. Its route is published as the unbound one it is —
   * this run's observation says which build is installed today, not which one
   * issued that identity — and it refuses here rather than being bound after
   * the fact.
   */
  function* bindProviderNamed(
    agentName: string,
    agentCommand: string,
    adapter: BoundProviderReturnedAdapter,
    sessionKey: string,
    hasProviderState: boolean,
  ): Operation<BoundBuild> {
    const build = yield* observeBuild(agentName, agentCommand, adapter.binding);
    let route: AgentSessionRoute;
    try {
      route = yield* reconcileRoute(
        agentCommand,
        sessionKey,
        // deno-lint-ignore require-yield
        function* () {
          return boundAcpFirstRoute(agentCommand, sessionKey, build.binding);
        },
        hasProviderState,
      );
    } catch (error) {
      throw new AttachmentRefused({ class: "identity-unavailable", message: routeMessage(error) });
    }
    if (route.route !== "acp-first") {
      throw new AttachmentRefused({
        class: "identity-unavailable",
        message:
          `session "${sessionKey}" was constructed under an identity XMD chose, and ` +
          `"${agentName}" names its own sessions, so neither account describes the other`,
      });
    }
    if (route.schema !== "session-route.v3") {
      // Constructed before any build was recorded. A build observed now says
      // which build is installed today, not which one issued this identity, so
      // there is nothing to compare and nothing to continue.
      throw new AttachmentRefused({
        class: "executable-binding-refused",
        message:
          `session "${sessionKey}" was constructed before XMD recorded which build issued its ` +
          `identity, so this run cannot show it is talking to that build. Name a different ` +
          `<Session>.`,
      });
    }
    if (!sameExecutableBuild(build.binding, route.executableBinding)) {
      throw new AttachmentRefused(buildDrift(sessionKey, route.executableBinding, build.binding));
    }
    return build;
  }

  /** What a settled construction route lets one ACP operation do. */
  interface SessionConstruction {
    /** The observed build every provider effect for this session goes through. */
    build: BoundBuild;
    /**
     * The exact conversation ACP must open rather than create.
     *
     * Present only for a session a native process constructed under an identity
     * XMD chose. A session the provider named has its own history to reopen, and
     * a name supplied here would be XMD choosing one after the fact.
     */
    resumeSessionId?: string;
  }

  /**
   * Reconcile this session's construction route, and say what an ACP operation
   * may do with it.
   *
   * `<Session>` and `<Prompt>` are eager, so a session nobody constructed is
   * constructed here — as `acp-first`, bound to the observed build when the
   * adapter pins one — before ensure. A session a native process constructed is
   * attached to — never converted, never republished — and only when this host
   * has proven that capability for this adapter and can still show it is talking
   * to the build that created it.
   */
  function* constructRoute(
    agentName: string,
    prepared: Prepared,
  ): Operation<SessionConstruction | undefined> {
    const adapter = adapterFor(agentName);
    if (!ownable(agentName) || adapter === undefined) {
      return undefined;
    }
    const agentCommand = agentCommandOf(prepared);
    // An existing managed entry, or a durable record ACPX already kept, is
    // provider state — and existing history is never reclassified.
    const constructed =
      prepared.kind === "existing" || (yield* until(store.load(prepared.sessionKey))) !== undefined;
    if (!allocatesIdentity(adapter)) {
      if (!bindsBuild(adapter)) {
        return undefined;
      }
      const build = yield* bindProviderNamed(
        agentName,
        agentCommand,
        adapter,
        prepared.sessionKey,
        constructed,
      );
      return { build };
    }
    const route = yield* reconcileRoute(
      agentCommand,
      prepared.sessionKey,
      // deno-lint-ignore require-yield
      function* () {
        return acpFirstRoute(agentCommand, prepared.sessionKey);
      },
      constructed,
    );
    if (route.route !== "client-native") {
      return undefined;
    }
    if (route.schema === "session-route.v1") {
      // Constructed before any build was recorded. A build observed now says
      // which build is installed today, not which one established this
      // conversation, so there is nothing to compare and nothing to attach to.
      throw new AttachmentRefused({
        class: "executable-binding-refused",
        message:
          `session "${prepared.sessionKey}" was constructed with a client-allocated identity ` +
          `before XMD recorded which build accepted it, so this run cannot show it is talking ` +
          `to that build. Continue it with <Session.Launch>, or name a different <Session>.`,
      });
    }
    if (!attachable(agentName)) {
      throw new AttachmentRefused({
        class: "unsupported-capability",
        message:
          `agent "${agentName}" is not advertised as able to attach to a session a native ` +
          `process constructed. Continue it with <Session.Launch>, or name a different ` +
          `<Session>.`,
      });
    }
    const build = yield* observeBuild(agentName, agentCommand, adapter.binding);
    if (!sameExecutableBuild(build.binding, route.executableBinding)) {
      throw new AttachmentRefused(
        buildDrift(prepared.sessionKey, route.executableBinding, build.binding),
      );
    }
    yield* retainedAssertion(prepared.sessionKey, route.nativeSessionId);
    return { build, resumeSessionId: route.nativeSessionId };
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
    // Registered before anything is written into it. Cleanup that waited for a
    // successful write would leave a partial file behind exactly when the write
    // is what failed — and prepared instructions are the one thing that must
    // not outlive the ownership that knows they exist.
    yield* ensure(function* () {
      yield* until(rm(directory, { recursive: true, force: true }).catch(() => undefined));
    });
    const path = join(directory, "instructions.md");
    yield* until(writeFile(path, instructions, { mode: 0o600 }));
    return path;
  }

  /**
   * The one thing a private setup or child-creation failure is allowed to say.
   *
   * Everything on that path knows something the reader must not be told: the
   * private file's path, the argv, the environment, the host's own message
   * about a file nobody else can see. A normalizer at the boundary is what
   * makes that true once rather than at each site that could leak it.
   */
  function privateFailure(): LaunchFailure {
    return {
      class: "process-creation-failed",
      message:
        "the native session could not be started. Its private setup is not described here, " +
        "because nothing about it belongs in a durable record or a document.",
    };
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

  /**
   * Wait for the backend to accept this turn, then commit what it created.
   *
   * The durable order is the contract: the provider's own record asserts an
   * identity first, the host's mapping commits second, and the session becomes
   * established last. A crash between the first two leaves exactly one
   * canonical assertion, which the next established-session validation
   * reconciles and commits — the same pre-commit window a reattachment has
   * always had.
   *
   * Nothing infers acceptance. A turn that fails, is cancelled, or simply ends
   * without the adapter saying so leaves this placement pending: no identity is
   * published, no mapping is called, and the exact Session value a retry would
   * use is still the one the document is holding.
   */
  function* materialize(
    entry: ManagedSession,
    placement: AcpxSessionPlacement,
    turn: AcpRuntimeTurn,
  ): Operation<void> {
    const accepted: Result<AcpRuntimeMaterialization> = yield* until(
      turn.materialized.then(
        (value): Result<AcpRuntimeMaterialization> => Ok(value),
        (error: unknown): Result<AcpRuntimeMaterialization> => Err(toError(error)),
      ),
    );
    if (!accepted.ok) {
      // Give up the arrangement no backend accepted, through the runtime that
      // made it. Keeping it would let a retry continue the zero-turn session
      // this attempt left behind instead of creating one — and the record it
      // stands on is still marked pending, so ACPX would not have resumed it
      // either.
      yield* releaseHandle(entry.session.sessionKey);
      // The turn's own outcome is the useful thing to say when it has one: the
      // barrier only knows that this session is still awaiting its first
      // accepted turn.
      const settled = yield* until(turn.result);
      if (settled.status === "failed") {
        throw new Error(settled.error.message);
      }
      throw accepted.error;
    }
    const identity: AcpxSessionIdentity = {
      acpxRecordId: accepted.value.acpxRecordId,
      ...(accepted.value.agentSessionId === undefined
        ? {}
        : { agentSessionId: accepted.value.agentSessionId }),
    };
    if (sessions?.established) {
      try {
        yield* sessions.established(placement, identity);
      } catch (error) {
        // The host could not retain what this session is, so it is not one
        // anyone may prompt through. The provider's assertion stands, and the
        // next attachment reconciles and commits that same identity — which it
        // can only do by reattaching, so the placement gives up its handle here
        // rather than staying live with one nobody may use.
        yield* abandonHandle(entry, "session retention refused");
        if (!holding(entry.session.sessionKey)) {
          detachPlacement(entry.session.sessionKey, entry);
        }
        throw error;
      }
    }
    if (accepted.value.agentSessionId !== undefined) {
      entry.session.agentSessionId = accepted.value.agentSessionId;
    }
    entry.state = "established";
  }

  function promptStream(
    content: string,
    options: PromptOptions | undefined,
    authority?: AgentProviderAuthority,
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

        // Where this prompt lands. Resolving it constructs nothing, which is
        // what lets the queue below be entered before any provider effect.
        const placed = yield* withSessionRoute(context, () =>
          prepare(agentName, options?.session, callerCwd),
        );

        // The session's FIFO first, and before ownership. Two prompts on one
        // session in one provider are not competing for it — they are two turns
        // in one conversation, and the queue is what makes them sequential. The
        // coordinator refuses contention rather than queueing, so asking it
        // first would turn the second subscription into a refusal instead of
        // the turn that follows the first.
        //
        // What still refuses is what genuinely competes: another provider
        // state, another process, and another kind of operation on this
        // session. None of them shares this queue, so all of them still meet
        // the coordinator while this one holds the session.
        //
        // The global route slot is deliberately not held across the wait:
        // waiting for one session's turn is not a reason to stop every other
        // session resolving.
        yield* turns.slot(placed.sessionKey);
        // Ownership before the turn, and before ensure: a prompt for an agent
        // whose sessions can be handed to a native UI is talking to a session
        // that UI may be in right now.
        yield* ownWithin(
          yield* useScope(),
          agentName,
          agentCommandOf(placed),
          placed.sessionKey,
          "prompt",
        );
        if (ownable(agentName)) {
          // Registered after acquisition, so it runs before ownership ends: no
          // usable handle for an advertised session outlives the release that
          // frees it, and the next operation — here or in another process —
          // reattaches under its own acquisition.
          yield* ensure(() => releaseHandle(placed.sessionKey));
        }

        return yield* withSessionRoute(context, function* () {
          // Read again now the queue has granted, so a concurrent first prompt
          // continues what its predecessor established instead of constructing
          // a second conversation beside it.
          const prepared = yield* requeried(placed);
          const state =
            prepared.kind === "existing"
              ? prepared.entry.state
              : yield* placementState(agentName, prepared.agentCommand, prepared.placement);
          // Inside ownership, before the runtime exists and before a turn: a
          // first Prompt constructs this session through ACP, so that is what
          // its construction route says — and a session a native process
          // constructed is attached to under the identity it already has.
          const construction = yield* constructRoute(agentName, prepared);
          const resumeSessionId = construction?.resumeSessionId;
          // The pending ACP-first branch, and the only one that defers: an
          // attachment resumes an identity that already exists, and an
          // established placement has one of its own. A build alone does not
          // defer anything — a session the provider names is still constructed
          // by this ensure, bound to the build that names it.
          const constructing =
            state === "pending" && resumeSessionId === undefined && prepared.kind === "placement";
          const entry = yield* ensureFromPrepared(agentName, prepared, {
            ...(construction === undefined ? {} : { build: construction.build }),
            ...(resumeSessionId === undefined ? {} : { attachment: { resumeSessionId } }),
            state,
            materialization: constructing,
            deferEstablished: constructing,
          });
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
          // The runtime that made this handle, never "the" runtime: a turn
          // started through another partition would be a second child in a
          // conversation the first already owns.
          const turn = entry.runtime.runtime.startTurn({
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

          if (constructing && prepared.kind === "placement") {
            // Before any of this turn's events are exposed. Until the backend
            // has accepted it there is no conversation to be reporting on, and
            // an event published first would be describing one.
            yield* materialize(entry, prepared.placement, turn);
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
              authority === undefined
                ? undefined
                : (terminal, token) => authority.checkpoint(terminal, token),
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
      // A refusal prepared nothing, so nobody chose an identity. The weaker of
      // the two claims is the honest one to retain.
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
   * Prepare a session whose identity XMD chose.
   *
   * The order is the contract, and every step happens while the coordinator
   * holds this session:
   *
   *   route + existing ACPX state -> refuse conversion -> allocate a UUID ->
   *   publish or adopt the route -> retain a record that matches it exactly.
   *
   * Nothing is created through ACP here. A client-native session is
   * materialized by the native process itself, which is why the route has to be
   * settled before that process exists: two accounts of one session, published
   * in the wrong order, is exactly the failure this route prevents.
   */
  function* prepareClientNative(
    invocation: LaunchInvocation,
    agentName: string,
    agentCommand: string,
    adapter: ClientAllocatedAdapter,
    sessionKey: string,
    sessionCwd: string,
    instructions: string,
    prepared: Prepared,
  ): Operation<PreparedLaunchRecord> {
    const known = { agent: agentName, sessionKey, cwd: sessionCwd, launcher: adapter.launcher };
    const instructionsDigest = createHash("sha256").update(instructions).digest("hex");

    // Both durable accounts, read while ownership is held. A route this build
    // cannot account for is an outcome of this launch rather than something to
    // raise past it: the reader asked for a session, and what it must be told
    // is that the session it named cannot be confirmed. `session()` and
    // `prompt()` raise instead, because neither of them has a launch to fail.
    let existing;
    let route: AgentSessionRoute | undefined;
    try {
      existing = yield* until(store.load(sessionKey));
      route = yield* routeStore!.read(sessionKeyOf(agentCommand, sessionKey));

      // A session ACP already established, from before this session had a route
      // at all. Writing down what it is — now, under ownership — is what makes
      // it un-reclassifiable: the next run meets a durable account rather than
      // the same open question. Adopting is not optional, so a concurrent
      // winner is what comes back and the checks below read it.
      if (route === undefined && existing !== undefined) {
        route = yield* routeStore!.publish(acpFirstRoute(agentCommand, sessionKey));
      }
    } catch (error) {
      return refusal("identity-unavailable", routeMessage(error), known);
    }

    // A route never converts. Refused before an identity exists, before a
    // private file is written, and long before detach or spawn.
    if (route?.route === "acp-first") {
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" was constructed through ACP, so it already has an identity ` +
          `of its own. A launch that names one would be naming a different conversation.`,
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
    if (route?.route === "client-native" && route.launcher !== adapter.launcher) {
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" was constructed by a different launcher, and neither ` +
          `account repairs the other`,
        known,
      );
    }

    // A legacy route: constructed before XMD recorded which build accepted the
    // identity. Native resume is exactly what that contract released, so it
    // continues on it — under the launcher name, with no build observed, and
    // with nothing written into the record it never had.
    if (route?.route === "client-native" && route.schema === "session-route.v1") {
      invocation.fresh.set(sessionKey, false);
      return retained(agentName, adapter, route, instructions, sessionCwd, "resumed");
    }

    // Observed before an identity exists, so a build this run cannot name stops
    // the launch before anything durable is written.
    let build: BoundBuild;
    try {
      build = yield* observeBuild(agentName, agentCommand, adapter.binding);
    } catch (error) {
      if (error instanceof AttachmentRefused) {
        return refusal(error.failure.class, error.failure.message, known);
      }
      throw error;
    }
    if (
      route?.route === "client-native" &&
      !sameExecutableBuild(build.binding, route.executableBinding)
    ) {
      const drift = buildDrift(sessionKey, route.executableBinding, build.binding);
      return refusal(drift.class, drift.message, known);
    }

    // A session that already has an identity is resumed under it, and nothing
    // is allocated at all: a second candidate for a conversation that already
    // exists is a value with nowhere to go.
    if (route?.route === "client-native") {
      invocation.fresh.set(sessionKey, false);
      invocation.bound.set(sessionKey, { build, adapter });
      return retained(agentName, adapter, route, instructions, sessionCwd, "resumed");
    }

    // The adapter allocates, because only it knows what identity this provider
    // will accept. Never an authored value, an ACP id, an ACPX record id, or
    // anything that merely looks like a UUID.
    const candidate = adapter.allocate();

    // Publish or adopt: a caller meeting a compatible existing route takes its
    // retained identity rather than insisting its own candidate win, because
    // the first durable publication is authoritative.
    let winner: AgentSessionRoute;
    try {
      winner = yield* routeStore!.publish({
        schema: "session-route.v2",
        route: "client-native",
        provider: ACPX_PROVIDER,
        agent: agentCommand,
        sessionKey,
        nativeSessionId: candidate,
        identityProvenance: "client-allocated",
        instructionsDigest,
        launcher: adapter.launcher,
        executableBinding: build.binding,
      });
    } catch (error) {
      return refusal("identity-unavailable", routeMessage(error), known);
    }
    if (winner.route !== "client-native") {
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" was constructed through ACP, so it already has an identity ` +
          `of its own`,
        known,
      );
    }
    if (winner.instructionsDigest !== instructionsDigest || winner.launcher !== adapter.launcher) {
      return refusal(
        "identity-unavailable",
        `session "${sessionKey}" is already constructed under an account this launch does ` +
          `not match, and neither account repairs the other`,
        known,
      );
    }
    // A concurrent winner published before any build was recorded is legacy
    // state, and this launch adopts it as one rather than treating its own
    // observation as that session's history.
    if (winner.schema === "session-route.v1") {
      invocation.fresh.set(sessionKey, false);
      return retained(agentName, adapter, winner, instructions, sessionCwd, "resumed");
    }
    if (!sameExecutableBuild(winner.executableBinding, build.binding)) {
      const drift = buildDrift(sessionKey, winner.executableBinding, build.binding);
      return refusal(drift.class, drift.message, known);
    }

    // The record is built from the winner rather than from the candidate, so
    // the two accounts agree by construction rather than by comparison. Losing
    // the race means this session already exists and is resumed.
    const fresh = winner.nativeSessionId === candidate;
    invocation.fresh.set(sessionKey, fresh);
    invocation.bound.set(sessionKey, { build, adapter });
    void prepared;
    return retained(
      agentName,
      adapter,
      winner,
      instructions,
      sessionCwd,
      fresh ? "created" : "resumed",
    );
  }

  /** The prepared record a client-native route describes, exactly. */
  function retained(
    agentName: string,
    adapter: ClientAllocatedAdapter,
    route: Extract<AgentSessionRoute, { route: "client-native" }>,
    instructions: string,
    sessionCwd: string,
    sessionState: "created" | "resumed",
  ): PreparedLaunchRecord {
    const record: PreparedLaunchRecord = {
      phase: "prepared",
      agent: agentName,
      sessionKey: route.sessionKey,
      provider: ACPX_PROVIDER,
      nativeSessionId: route.nativeSessionId,
      // Materialized by the native process; ACP has created nothing.
      sessionState,
      instructionChannel: CLIENT_NATIVE_CHANNEL,
      instructionReconciliation: sessionState === "created" ? "installed" : "resumed",
      identityProvenance: "client-allocated",
      instructionsDigest: route.instructionsDigest,
      instructions,
      cwd: sessionCwd,
      additionalDirectories: [],
      permissionMode: providerOptions.permissionMode,
      launcher: adapter.launcher,
    };
    // Exactly what the route says, so the journal and the route agree by
    // construction. A legacy route has none, and inventing one here would claim
    // knowledge of which build established a session XMD never recorded.
    if (route.schema === "session-route.v2") {
      record.executableBinding = route.executableBinding;
    }
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
    if (!adapter || !launchAdvertised.has(agentName)) {
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
    const agentCommand = agentCommandOf(prepared);

    // An adapter that names its own sessions never goes through ACP session
    // creation at all: the native process is what materializes the session.
    if (allocatesIdentity(adapter)) {
      const clientNative = yield* prepareClientNative(
        invocation,
        agentName,
        agentCommand,
        adapter,
        sessionKey,
        sessionCwd,
        instructions,
        prepared,
      );
      if (clientNative.failure === undefined) {
        // A client-native route now exists for this placement, so a <Session>
        // nested after this launch attaches to it eagerly instead of taking it
        // for one nothing has constructed.
        markEstablished(sessionKey);
      }
      return clientNative;
    }

    // No runtime is claimed yet. Everything between here and the ensure can
    // return — a store read that fails, an instruction layer this provider will
    // not replace — and a claim taken before them is one those exits would have
    // to remember to give back.
    const stored = yield* until(store.load(sessionKey));
    // A pending record is occupancy an earlier attempt left behind: ACPX will
    // not reuse it, no backend ever accepted a turn in it, and treating it as a
    // conversation would skip the very turn that would make one openable. So
    // this launch is creating, whatever is on disk under the same key.
    const existing =
      stored !== undefined && stored.sessionMaterialization?.state !== "pending"
        ? stored
        : undefined;
    const sessionState: "created" | "resumed" = existing ? "resumed" : "created";
    const reconciliation: InstructionReconciliation = existing ? "resumed" : "installed";
    const known = { agent: agentName, sessionKey, cwd: sessionCwd, launcher: adapter.launcher };

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
        known,
      );
    }

    // Which build this session belongs to, settled before ACP is asked for
    // anything. The provider names the session, and the name it issues resolves
    // to one conversation only beside the build that issued it — so the build is
    // observed, the route recording it is published or adopted, and the two are
    // compared, all under ownership and before the first provider effect.
    let build: BoundBuild | undefined;
    if (bindsBuild(adapter)) {
      try {
        build = yield* bindProviderNamed(
          agentName,
          agentCommand,
          adapter,
          sessionKey,
          existing !== undefined,
        );
      } catch (error) {
        if (error instanceof AttachmentRefused) {
          return refusal(error.failure.class, error.failure.message, known);
        }
        throw error;
      }
      invocation.bound.set(sessionKey, { build, adapter });
      // The check a replay performs at its own first live phase, performed here
      // against a live observation. Recording it is what keeps the detach or the
      // spawn below from reading the same two accounts a second time.
      invocation.reconciled.add(sessionKey);
    }

    // Planned before the ensure it decides the shape of, and only for the
    // conversation this launch creates through an adapter that says one is
    // owed. A resumed session has already been spoken in — whatever made it
    // openable happened before this run — so taking a turn in it would be
    // spending someone's model turn to learn nothing. The request id is minted
    // here rather than at the turn so a replay reading the retained record is
    // looking for the turn the first attempt committed to.
    const plan: MaterializationPlan | undefined =
      sessionState === "created" && adapter.materialization
        ? {
            promptVersion: adapter.materialization.promptVersion,
            requestId: randomUUID(),
            prompt: adapter.materialization.prompt,
          }
        : undefined;

    const ensureInput: AcpRuntimeEnsureInput = {
      sessionKey,
      agent: agentName,
      mode: "persistent",
      cwd: sessionCwd,
      sessionOptions: { systemPrompt: instructions },
    };
    if (plan !== undefined) {
      // A conversation this adapter cannot open until something has been said
      // in it is not one the record may assert. ACPX holds it as occupancy
      // instead, and only the adapter's own acceptance of the turn below
      // promotes it — which is what makes that acceptance decide whether this
      // launch reaches a native UI at all.
      ensureInput.materialization = "first-turn-acceptance";
    }

    // Claimed here, one line before the ensure it is for, and settled by the
    // same scope-owned cleanup an attachment uses. The handle enters the ledger
    // the moment it exists, bound to the runtime that made it: everything below
    // can refuse, and a handle only the managed map knew about is one teardown
    // could not close through its creator.
    const managedEntry = yield* ensureThrough(build, ensureInput, (handle, entry) => {
      const session: Session = { sessionKey, cwd: sessionCwd };
      if (handle.agentSessionId !== undefined) {
        session.agentSessionId = handle.agentSessionId;
      }
      // Established by construction when nothing is owed: this adapter's
      // provider returns the identity, so the session exists the moment the
      // ensure answers. A launch that owes a turn holds a placement instead,
      // and the accepted turn is what establishes it.
      return {
        handle,
        runtime: entry,
        agentCommand,
        cwd: sessionCwd,
        session,
        state: plan === undefined ? "established" : "pending",
      };
    });
    managed.set(sessionKey, managedEntry);

    const nativeSessionId = plan === undefined ? managedEntry.handle.agentSessionId : "";
    if (nativeSessionId === undefined) {
      // An ACP session id and an ACPX record id are not native identities, and
      // neither is a string that merely looks like one.
      //
      // Nothing will detach this session, so the connection is given up here
      // rather than held to teardown. A close that fails keeps the handle owned
      // and the session unquiesced, which is the honest half of the same act.
      yield* releaseHandle(sessionKey);
      return refusal(
        "identity-unavailable",
        `agent "${agentName}" created a session but asserted no provider-native ` +
          `session identity, so there is nothing ${adapter.launcher} can resume`,
        known,
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
      // ACP created this session and reported what it is called.
      identityProvenance: "provider-returned",
      instructionsDigest: createHash("sha256").update(instructions).digest("hex"),
      instructions,
      cwd: sessionCwd,
      additionalDirectories: [],
      permissionMode: providerOptions.permissionMode,
      launcher: adapter.launcher,
    };
    if (build) {
      // Exactly the binding the route carries, so the journal and the route
      // agree by construction rather than by comparison.
      record.executableBinding = build.binding;
    }
    if (plan !== undefined) {
      record.materialization = plan;
    }
    let model: string | undefined;
    try {
      model = yield* effectiveModel(managedEntry.runtime.runtime, managedEntry.handle);
    } catch (error) {
      // Asking for status is the last thing preparation does, and a provider
      // that cannot answer leaves a handle this launch will never hand over.
      yield* releaseHandle(sessionKey);
      throw error;
    }
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
   * What the provider said this turn cost, and nothing else.
   *
   * A member the provider did not report is left absent rather than copied as
   * `undefined`, because these are merged over what earlier events reported: an
   * explicit `undefined` would overwrite a figure the provider did give with the
   * claim that it gave none. Zero is a figure; saying nothing is not.
   */
  function reportedUsage(
    breakdown: AcpRuntimeUsageBreakdown | undefined,
    cost: AcpRuntimeUsageCost | undefined,
  ): MaterializationUsage {
    const usage: {
      -readonly [K in keyof MaterializationUsage]: MaterializationUsage[K];
    } = {};
    if (breakdown?.inputTokens !== undefined) {
      usage.inputTokens = breakdown.inputTokens;
    }
    if (breakdown?.outputTokens !== undefined) {
      usage.outputTokens = breakdown.outputTokens;
    }
    if (breakdown?.cachedReadTokens !== undefined) {
      usage.cachedReadTokens = breakdown.cachedReadTokens;
    }
    if (breakdown?.cachedWriteTokens !== undefined) {
      usage.cachedWriteTokens = breakdown.cachedWriteTokens;
    }
    if (breakdown?.thoughtTokens !== undefined) {
      usage.thoughtTokens = breakdown.thoughtTokens;
    }
    if (breakdown?.totalTokens !== undefined) {
      usage.totalTokens = breakdown.totalTokens;
    }
    if (cost?.amount !== undefined) {
      usage.costAmount = cost.amount;
    }
    if (cost?.currency !== undefined) {
      usage.costCurrency = cost.currency;
    }
    return usage;
  }

  /** One line per member, saying `provider did not report` where it did not. */
  function usageLines(usage: MaterializationUsage): string {
    const figure = (value: number | undefined): string =>
      value === undefined ? "provider did not report" : String(value);
    const cost =
      usage.costAmount === undefined
        ? "provider did not report"
        : `${usage.costAmount}${usage.costCurrency === undefined ? "" : ` ${usage.costCurrency}`}`;
    return [
      `  input tokens: ${figure(usage.inputTokens)}`,
      `  output tokens: ${figure(usage.outputTokens)}`,
      `  cached read tokens: ${figure(usage.cachedReadTokens)}`,
      `  cached write tokens: ${figure(usage.cachedWriteTokens)}`,
      `  thought tokens: ${figure(usage.thoughtTokens)}`,
      `  total tokens: ${figure(usage.totalTokens)}`,
      `  cost: ${cost}`,
    ].join("\n");
  }

  /**
   * Spend the one turn this launch planned, and report what it cost.
   *
   * Reached only for a preparation that planned one, which is only ever a
   * conversation this launch created through an adapter that says a fresh one is
   * not yet openable. Everything about it is fixed before it runs: the exact
   * prompt and the request id come from the retained plan, so a replay is
   * looking for this turn rather than authorizing another.
   *
   * It is not a Prompt. It publishes no event stream, reaches no authored
   * middleware, and is deliberately not registered with the permission bridge —
   * an unregistered turn's permission request is refused by the bridge's own
   * fail-closed answer, so there is no composed handler that could grant this
   * turn the tool authority its prompt already forbids. A tool call that arrives
   * anyway fails materialization, and the session is never handed over.
   *
   * It is also what settles the session's identity. The preparation held
   * occupancy and asserted nothing, so the conversation this launch hands over
   * is named here — by the backend's own acceptance of this turn, and by
   * nothing else.
   */
  function materializeSession(
    placed: Prepared,
    prepared: PreparedLaunchRecord,
    plan: MaterializationPlan,
  ): Operation<MaterializedLaunchRecord> {
    return scoped(function* (): Operation<MaterializedLaunchRecord> {
      const base: Pick<MaterializedLaunchRecord, "phase" | "promptVersion" | "requestId"> = {
        phase: "materialized",
        promptVersion: plan.promptVersion,
        requestId: plan.requestId,
      };
      const refused = (message: string): MaterializedLaunchRecord => ({
        ...base,
        usage: {},
        response: "",
        failure: { class: "materialization-failed", message },
      });

      const entry = managed.get(prepared.sessionKey);
      if (!entry || !isLive(entry)) {
        return refused(
          `session "${prepared.sessionKey}" is no longer held by this provider, so the turn ` +
            `that would make it resumable cannot be taken here`,
        );
      }
      // Occupancy, and only occupancy. The preparation asserted no identity
      // because no backend had accepted a turn here, so a handle that already
      // names a conversation is not the placement this launch prepared — and
      // spending a turn in it would be spending one in someone else's.
      if (entry.handle.agentSessionId !== undefined) {
        return refused(
          `session "${prepared.sessionKey}" is held under a provider-native identity this ` +
            `launch never prepared`,
        );
      }

      // Before the turn, never after: what is about to be spent is the reader's
      // model turn, and telling them once it is gone is telling them too late.
      yield* notifyTerminal(
        `${prepared.agent}: spending one model turn in session "${prepared.sessionKey}" so ` +
          `${prepared.launcher} can open it (${plan.promptVersion}).`,
      );

      // Registered before the turn exists, and reaching it through a slot the
      // start fills. Registering afterwards puts a suspension point between a
      // live turn and the only thing that would stop it, and a cancellation
      // landing there — a reader closing the grid this launch is running in is
      // one — leaves a model turn running in their conversation that nothing
      // is waiting for and nothing cancels until this whole provider comes
      // down. There is no such gap this way round: `startTurn` answers without
      // suspending, so the slot is filled in the step that creates the turn.
      let turn: AcpRuntimeTurn | undefined;
      let settled = false;
      yield* ensure(function* () {
        if (!turn || settled) {
          return;
        }
        activeTurns.delete(turn);
        try {
          yield* until(turn.cancel());
        } catch (error) {
          cleanupErrors.push(toError(error));
        }
      });
      turn = entry.runtime.runtime.startTurn({
        handle: entry.handle,
        text: plan.prompt,
        mode: "prompt",
        requestId: plan.requestId,
      });
      activeTurns.add(turn);

      const started = Date.now();
      let response = "";
      let usage: MaterializationUsage = {};
      let acted = false;
      let outcome: Result<AcpRuntimeTurnResult>;
      try {
        for (const event of yield* each(stream(turn.events))) {
          if (event.type === "text_delta" && (event.stream ?? "output") === "output") {
            response += event.text;
          } else if (event.type === "tool_call") {
            // The prompt forbids this, so an arriving tool call means the turn
            // did something other than acknowledge. Recorded rather than acted
            // on: the turn is already running, and what this decides is that no
            // native UI opens on what it left behind.
            acted = true;
          } else if (event.type === "status") {
            usage = { ...usage, ...reportedUsage(event.breakdown, event.cost) };
          }
          yield* each.next();
        }
        outcome = Ok(yield* until(turn.result));
      } catch (error) {
        outcome = Err(toError(error));
      }
      settled = true;
      const durationMs = Date.now() - started;

      const stopped = (
        message: string,
        stopReason?: string,
        failureClass: LaunchFailureClass = "materialization-failed",
      ): MaterializedLaunchRecord => {
        const record: MaterializedLaunchRecord = {
          ...base,
          durationMs,
          usage,
          response,
          failure: { class: failureClass, message },
        };
        if (stopReason !== undefined) {
          record.stopReason = stopReason;
        }
        return record;
      };

      if (!outcome.ok) {
        return stopped(outcome.error.message);
      }
      const result = outcome.value;
      if (result.status === "cancelled") {
        return stopped("the materialization turn was cancelled", result.stopReason);
      }
      if (result.status === "failed") {
        return stopped(result.error.message);
      }
      // ACP defines end_turn as the only successful stop reason, and an adapter
      // that omits it on a normal completion means that one.
      const stopReason = result.stopReason ?? "end_turn";
      if (stopReason !== "end_turn") {
        return stopped(
          `the materialization turn ended with stop reason "${stopReason}"`,
          stopReason,
        );
      }
      if (acted) {
        return stopped(
          "the materialization turn called a tool, which its prompt forbids, so this launch " +
            "will not hand the session to a native UI",
          stopReason,
        );
      }
      // The backend's own acceptance, asked for after the turn completed. A
      // turn that failed, was cancelled, or simply ended without the adapter
      // saying so rejects here, and a turn nothing accepted materialized
      // nothing — so there is no identity, and nothing to hand over.
      const accepted: Result<AcpRuntimeMaterialization> = yield* until(
        turn.materialized.then(
          (value): Result<AcpRuntimeMaterialization> => Ok(value),
          (error: unknown): Result<AcpRuntimeMaterialization> => Err(toError(error)),
        ),
      );
      if (!accepted.ok) {
        return stopped(accepted.error.message, stopReason);
      }
      const nativeSessionId = accepted.value.agentSessionId;
      if (nativeSessionId === undefined || nativeSessionId.length === 0) {
        // The turn itself reached the backend and was accepted; what is absent
        // is the conversation's name, which is the same thing an adapter that
        // asserts no identity leaves absent before any turn. Classed as that
        // rather than as a failed turn, because the turn did not fail.
        return stopped(
          "the backend accepted the materialization turn without naming the session it made " +
            "openable, so there is nothing a native UI could resume",
          stopReason,
          "identity-unavailable",
        );
      }
      // The provider's own name for the turn, read from the response metadata
      // this package recognizes and from nothing else. Without it there is no
      // evidence the exchange reached the backend rather than a socket.
      const named = checkpointFromResult(result);
      if (named === undefined) {
        return stopped(
          "the materialization turn completed without naming the provider turn it was",
          stopReason,
        );
      }
      if (response.length === 0) {
        return stopped(
          "the materialization turn produced no assistant response, so nothing was said in " +
            "the conversation this launch was making openable",
          stopReason,
        );
      }

      // The durable order the prompt path uses, for the same reason: ACPX's own
      // record asserted the identity as it promoted this session, the host's
      // mapping commits second, and the placement becomes established last. A
      // host that refuses to retain it leaves a session nobody may prompt
      // through, so the handle is given up rather than held under a mapping
      // that does not exist.
      const identity: AcpxSessionIdentity = {
        acpxRecordId: accepted.value.acpxRecordId,
        agentSessionId: nativeSessionId,
      };
      if (sessions?.established && placed.kind === "placement") {
        try {
          yield* sessions.established(placed.placement, identity);
        } catch (error) {
          yield* abandonHandle(entry, "session retention refused");
          if (!holding(prepared.sessionKey)) {
            detachPlacement(prepared.sessionKey, entry);
          }
          return stopped(toError(error).message, stopReason);
        }
      }
      entry.session.agentSessionId = nativeSessionId;
      entry.state = "established";

      yield* notifyTerminal(
        `${prepared.agent}: materialization turn completed in ${durationMs}ms ` +
          `(${named.provider} ${named.kind} ${named.value}).\n` +
          `${response}\n` +
          `${usageLines(usage)}`,
      );

      return { ...base, nativeSessionId, turn: named, durationMs, usage, response, stopReason };
    });
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
    if (!entry || !isLive(entry)) {
      return;
    }
    try {
      yield* until(
        entry.runtime.runtime.close({
          handle: entry.handle,
          reason: "releasing session ownership",
        }),
      );
    } catch (error) {
      // Reported, and the entry stays live. A close that failed released
      // nothing, and marking it stale here would tell `holding()` this scope
      // holds nothing — which is what lets the caller acknowledge quiescence
      // and publish an idle record for a session ACP may still be in.
      cleanupErrors.push(toError(error));
      return;
    }
    releasedHandle(entry);
    detachPlacement(sessionKey, entry);
  }

  /** Release ACP ownership. Nothing is spawned until this has completed. */
  function* detachSession(
    invocation: LaunchInvocation,
    prepared: PreparedLaunchRecord,
    agentCommand: string,
  ): Operation<DetachedLaunchRecord> {
    const sessionKey = prepared.sessionKey;
    // A client-native session was never created through ACP, so there is no ACP
    // ownership to release. Detach is still a phase — it is the point after
    // which a spawn may happen — and it succeeds trivially.
    if (invocation.fresh.has(sessionKey)) {
      return { phase: "detached" };
    }
    // For a session bound to a build, this detach may be the first live phase of
    // a replay. The durable accounts are checked here rather than at the spawn,
    // because retaining a detach is itself advancing the launch: a journal that
    // says the handoff began is not something to write about a session this run
    // cannot confirm. A launch that prepared live has already checked them, and
    // this reads them once per invocation.
    const bound = adapterFor(prepared.agent);
    if (bound && bindsBuild(bound)) {
      const refused = yield* reconcile(invocation, prepared, agentCommand);
      if (refused) {
        return { phase: "detached", failure: refused };
      }
    }
    // Reached live means the detach phase was absent from the journal, which is
    // what tells a resumed launch that native creation may not have begun.
    invocation.detachedLive.add(sessionKey);
    const entry = managed.get(sessionKey);
    if (!entry || !isLive(entry)) {
      // Nothing of this provider's owns the session. A resumed launch reaches
      // here with no live ACP connection at all, which is the state detaching
      // exists to produce.
      return { phase: "detached" };
    }
    try {
      // Not `discardPersistentState`: the record is exactly what the native UI
      // is about to resume.
      yield* until(
        entry.runtime.runtime.close({ handle: entry.handle, reason: "native session launch" }),
      );
    } catch (error) {
      return {
        phase: "detached",
        failure: { class: "detach-failed", message: toError(error).message },
      };
    }
    releasedHandle(entry);
    detachPlacement(sessionKey, entry);
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

      // This launch's own state, reachable only through the phase callbacks
      // below. Nothing one invocation observed is visible to the next.
      const invocation: LaunchInvocation = {
        fresh: new Map(),
        bound: new Map(),
        detachedLive: new Set(),
        reconciled: new Set(),
      };

      try {
        yield* owning(
          agentName,
          agentCommandOf(placement),
          placement.sessionKey,
          "native-launch",
          function* (ownership) {
            // No provider-local queue here. A launch is only ever performed for
            // an advertised agent, so the acquisition above is already this
            // session's exclusion — inside this provider and outside it. Taking
            // the queue as well would put a prompt behind a native UI that may
            // hold the session for hours, and a prompt that queued would hold
            // the reader's terminal while offering no way to reach the owner it
            // was waiting for. It refuses instead, and the coordinator is what
            // refuses it.
            //
            // The launch runs in a scope of its own so that this owner can bring
            // it down deliberately and watch how that goes. A cancelled launch —
            // the reader closing a terminal grid is one — unwinds past every
            // statement after it, so a decision written down here would never be
            // reached; written as this scope's cleanup, it is reached on every
            // path there is.
            const [running, stop] = createScope(yield* useScope());
            let stopped = false;

            yield* ensure(function* () {
              // Registered after the scope exists, so it runs before the scope
              // is destroyed on its own: the launch comes down here, and
              // `destroy()` carries the outcome of its teardown. A child that
              // could not be proven stopped, or a cleanup that failed, throws
              // out of it — and is not quiescence, and is still a failure.
              try {
                yield* until(stop());
                stopped = true;
              } finally {
                // Everything this owner started has to be finished with the
                // session, and that is two facts rather than one: the native
                // child and its cleanup settled, and this provider holds no
                // handle for the session — a detach that failed, or a session
                // prepared and never handed over, leaves one. Either one
                // missing leaves the session owned rather than looking
                // finished, which is what the next owner is told to recover
                // deliberately.
                if (stopped && !holding(placement.sessionKey)) {
                  ownership.quiesced();
                }
              }
            });

            yield* running.run(() =>
              authority.perform(request, {
                prepare: () =>
                  withSessionRoute(context, () =>
                    prepareLaunch(
                      invocation,
                      agentName,
                      callerCwd,
                      request.instructions,
                      placement,
                    ),
                  ),
                materialize: (prepared, plan) => materializeSession(placement, prepared, plan),
                detach: (prepared) =>
                  detachSession(invocation, prepared, agentCommandOf(placement)),
                exit: (prepared) => runNativeUi(invocation, prepared, agentCommandOf(placement)),
              }),
            );
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
   * What this run must ask the native process to do.
   *
   * The retained phase is the whole question, and it is answered by what the
   * journal gave back rather than by anything the provider kept. A replay that
   * retained only `prepared` proves the handoff never began — core retains
   * `detached` before it invokes this phase — so creation may still be owed. A
   * replay that retained `detached` may have had a process start under this
   * identity already, so it resumes and never falls back to creating.
   */
  function* nativeCommand(
    invocation: LaunchInvocation,
    prepared: PreparedLaunchRecord,
    adapter: NativeAdapter,
    agentCommand: string,
  ): Operation<Result<string[]>> {
    const publishedHere = invocation.fresh.get(prepared.sessionKey);
    if (publishedHere === undefined && bindsBuild(adapter)) {
      // A replay. Whichever suffix it holds, the two durable accounts are
      // checked before this run does anything a native process could act on —
      // a detached replay reaches here as its first live phase, and a
      // prepared-only one has already been checked at its own.
      const refused = yield* reconcile(invocation, prepared, agentCommand);
      if (refused) {
        return Err(new RetainedRefusal(refused));
      }
    }
    // Creation is a question only for an identity XMD chose. A session the
    // provider named already exists — ACP made it — so there is nothing here to
    // create and no instruction layer to install through argv.
    let argv: string[];
    if (
      allocatesIdentity(adapter) &&
      (publishedHere ?? invocation.detachedLive.has(prepared.sessionKey))
    ) {
      argv = adapter.create(
        prepared.nativeSessionId,
        yield* privateInstructionFile(prepared.instructions),
      );
    } else {
      argv = adapter.resume(prepared.nativeSessionId);
    }
    // The exact file this run observed, in place of the launcher name the
    // adapter writes. The name is what durable records carry; the path is what
    // this invocation spawns, and it is live only. A legacy session observed no
    // build, so it keeps the released behavior and runs the name.
    const observed = invocation.bound.get(prepared.sessionKey);
    return Ok(observed ? [observed.build.livePath, ...argv.slice(1)] : argv);
  }

  /** Check a retained launch against its route once per invocation. */
  function* reconcile(
    invocation: LaunchInvocation,
    prepared: PreparedLaunchRecord,
    agentCommand: string,
  ): Operation<LaunchFailure | undefined> {
    if (invocation.reconciled.has(prepared.sessionKey)) {
      return undefined;
    }
    const refused = yield* reconcileRetainedLaunch(invocation, prepared, agentCommand);
    if (refused) {
      return refused;
    }
    invocation.reconciled.add(prepared.sessionKey);
    return undefined;
  }

  /**
   * Check a retained launch against the route before resuming or creating.
   *
   * Two durable accounts of this session already exist — the journal's and the
   * route's — and a replay may act only if they still agree. Neither account
   * repairs the other and neither is republished: a replay that found a
   * disagreement has discovered that the session it was going to continue is
   * not the session it prepared.
   */
  function* reconcileRetainedLaunch(
    invocation: LaunchInvocation,
    prepared: PreparedLaunchRecord,
    agentCommand: string,
  ): Operation<LaunchFailure | undefined> {
    const stop = (message: string): LaunchFailure => ({ class: "identity-unavailable", message });
    const disagree = (): LaunchFailure =>
      stop(
        `session "${prepared.sessionKey}" is described differently by its journal and its ` +
          `construction route, and neither account repairs the other`,
      );
    // A launch that never got as far as the native process, prepared under a
    // contract that recorded no build. Nothing here can show which build has
    // this session's history, and resuming anyway would be answering the
    // question by ignoring it. A completed launch never reaches this code.
    const unrecorded = (): LaunchFailure => ({
      class: "executable-binding-refused",
      message:
        `session "${prepared.sessionKey}" was prepared before XMD recorded which build its ` +
        `identity belongs to, so this run cannot confirm the conversation it names`,
    });
    // Which provider retained this preparation, before anything is compared
    // against it. A record another provider wrote describes a session this one
    // does not own, and an ACPX route that happens to agree about a UUID is not
    // evidence that it does — it is two providers naming one string.
    if (prepared.provider !== ACPX_PROVIDER) {
      return stop(
        `session "${prepared.sessionKey}" was prepared by a different provider, so this one ` +
          `cannot confirm the conversation it names`,
      );
    }
    // The live half's adapter first, because which construction this journal can
    // be checked against is the adapter's fact rather than the route's: a route
    // agreeing with a record about one string is not evidence that the same side
    // named the session both times.
    const adapter = adapterFor(prepared.agent);
    if (!adapter || !bindsBuild(adapter)) {
      return {
        class: "executable-binding-refused",
        message:
          `session "${prepared.sessionKey}" names a launcher this build has no way to observe, ` +
          `so the conversation it prepared cannot be confirmed`,
      };
    }
    let route;
    try {
      route = yield* routeStore!.read(sessionKeyOf(agentCommand, prepared.sessionKey));
    } catch (error) {
      return stop(routeMessage(error));
    }
    let retainedBinding: ExecutableBuildBindingV1;
    if (allocatesIdentity(adapter)) {
      if (!route || route.route !== "client-native") {
        return stop(
          `session "${prepared.sessionKey}" has no client-allocated construction route, so the ` +
            `conversation this launch prepared cannot be confirmed`,
        );
      }
      if (
        route.nativeSessionId !== prepared.nativeSessionId ||
        route.identityProvenance !== prepared.identityProvenance ||
        route.instructionsDigest !== prepared.instructionsDigest ||
        route.launcher !== prepared.launcher
      ) {
        return disagree();
      }
      if (route.schema === "session-route.v1") {
        return unrecorded();
      }
      retainedBinding = route.executableBinding;
    } else {
      if (!route || route.route !== "acp-first") {
        return stop(
          `session "${prepared.sessionKey}" has no provider-named construction route, so the ` +
            `conversation this launch prepared cannot be confirmed`,
        );
      }
      if (route.schema !== "session-route.v3") {
        return unrecorded();
      }
      retainedBinding = route.executableBinding;
      // ACPX's own record, which is what any later ACP operation would reopen
      // this session through. A record naming another conversation, or none,
      // means the identity the native process is about to be handed is not the
      // one this provider would come back to.
      try {
        yield* retainedAssertion(prepared.sessionKey, prepared.nativeSessionId);
      } catch (error) {
        if (error instanceof AttachmentRefused) {
          return error.failure;
        }
        throw error;
      }
    }
    if (prepared.executableBinding === undefined) {
      return unrecorded();
    }
    if (!sameExecutableBuild(retainedBinding, prepared.executableBinding)) {
      return disagree();
    }
    // The live half, before the first effect a native process could act on.
    let build: BoundBuild;
    try {
      build = yield* observeBuild(prepared.agent, agentCommand, adapter.binding);
    } catch (error) {
      if (error instanceof AttachmentRefused) {
        return error.failure;
      }
      throw error;
    }
    if (!sameExecutableBuild(build.binding, retainedBinding)) {
      return buildDrift(prepared.sessionKey, retainedBinding, build.binding);
    }
    invocation.bound.set(prepared.sessionKey, { build, adapter });
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
    let resolved: Result<string[]>;
    try {
      resolved = yield* nativeCommand(invocation, prepared, adapter, agentCommand);
    } catch {
      // Anything raised here came from private setup — an adapter's own code, a
      // temporary directory, a write. Whatever shape it has, it says nothing
      // that may be repeated.
      return { phase: "exited", failure: privateFailure() };
    }
    if (!resolved.ok) {
      // Only a refusal this provider already settled says anything; a failure
      // of any other kind came from that same private path.
      const failure =
        resolved.error instanceof RetainedRefusal ? resolved.error.failure : privateFailure();
      return { phase: "exited", failure };
    }
    const command = resolved.value;
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
    } catch {
      // Normalized: everything this boundary knows — the argv, the private
      // file's path, the host's own message about a file nobody else can see —
      // is what a durable record must not carry.
      return { phase: "exited", failure: privateFailure() };
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

  /**
   * Resolve one session, reading a routed placement's engine identity through
   * the authority when there is one.
   *
   * The name and the identity arrive by different routes on purpose: a handler
   * on the public chain may change the name it routes, and the identity it
   * cannot see is the one this run retains a session under.
   */
  function* resolveSession(
    option: string | Session | AgentSessionRequest | undefined,
    authority: AgentProviderAuthority | undefined,
  ): Operation<Session> {
    let named: string | Session | undefined;
    let sessionIdentity: string | undefined;
    if (option !== undefined && typeof option === "object" && isSessionRequest(option)) {
      if (authority === undefined) {
        throw new Error(
          "a session placement reached this provider without the authority that reads it",
        );
      }
      named = option.name;
      sessionIdentity = authority.sessionIdentity(option);
    } else {
      named = option;
    }

    const agentName = yield* Agent.operations.agent();
    const callerCwd = resolve(yield* agentCwd());
    const context: SessionRouteContext = { agentName, session: named, cwd: callerCwd };
    const prepared = yield* withSessionRoute(context, () =>
      prepare(agentName, named, callerCwd, sessionIdentity),
    );
    const state =
      prepared.kind === "existing"
        ? prepared.entry.state
        : yield* placementState(agentName, prepared.agentCommand, prepared.placement);
    if (prepared.kind === "placement" && state === "pending") {
      // A fresh <Session> places a session; it does not create one. It has
      // validated the agent and where the session will live, and that is all it
      // may do — the first consuming operation chooses how the session is
      // constructed, and choosing here would take that choice away from a
      // <Session.Launch> nested inside this very element.
      requireAssembly(agentName, prepared.sessionKey);
      return placePending(prepared);
    }
    return yield* owning(
      agentName,
      agentCommandOf(prepared),
      prepared.sessionKey,
      "session",
      function* (ownership) {
        // An established session, reattached eagerly: its route and its durable
        // identity both exist, so validating them here is what makes a
        // mismatched or missing history refusable before any turn. A failed
        // ensure leaves the route standing — it may have created provider state
        // before the caller saw the failure, and preserving the route is what
        // stops that uncertainty from later being reclassified as
        // client-native.
        const construction = yield* constructRoute(agentName, prepared);
        const resumeSessionId = construction?.resumeSessionId;
        const session = yield* turns.withSlot(prepared.sessionKey, () =>
          withSessionRoute(context, function* () {
            const entry = yield* ensureFromPrepared(agentName, prepared, {
              ...(construction === undefined ? {} : { build: construction.build }),
              ...(resumeSessionId === undefined ? {} : { attachment: { resumeSessionId } }),
              state,
            });
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
    // Everything this provider still owns, whether or not it ever became a
    // usable session. A handle a native UI took over has already left this set;
    // one whose validation failed has not.
    const closedHandles = new Set<string>();
    for (const entry of [...owned]) {
      const handleKey = entry.handle.acpxRecordId ?? entry.handle.sessionKey;
      if (closedHandles.has(handleKey)) {
        // One ACP record, one close. The duplicate is released rather than
        // closed again, so its partition's count still comes down.
        releasedHandle(entry);
        continue;
      }
      closedHandles.add(handleKey);
      try {
        // Through the runtime that made it, so a bound partition's own children
        // are the ones told to stop.
        yield* until(
          entry.runtime.runtime.close({ handle: entry.handle, reason: "scope teardown" }),
        );
      } catch (error) {
        // Attempted, failed, and reported. The next handle is still attempted,
        // and this one keeps its partition: a close that did not settle is not
        // a partition that did.
        cleanupErrors.push(toError(error));
        continue;
      }
      releasedHandle(entry);
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
      return yield* resolveSession(option, undefined);
    },
    *placeSession(option, authority) {
      return yield* resolveSession(option, authority);
    },
    promptStream,
    launch,
  };
}
