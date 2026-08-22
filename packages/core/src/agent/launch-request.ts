/**
 * The opaque launch request, and the invocation that owns one
 * (architecture.md §Capability-backed execution).
 *
 * A launch used to be authorized by whatever reached the end of the public
 * chain: middleware could hand back a `SessionLaunchResult`, or replace the
 * phase callbacks the journal lent out, and the invocation settled on it. Both
 * are the same mistake — putting authority somewhere every handler can reach.
 *
 * So the public surface routes and nothing more. Middleware receives one frozen
 * request describing the launch, and may inspect it, narrow it through
 * `with()`, refuse by throwing, or delegate it. What it returns is discarded.
 * Authority to run and retain a phase never travels on that chain: it reaches
 * the selected provider directly, when its factory is installed.
 *
 * The request is the capability, and it is one-use. Identity is object
 * identity, not shape: a rebuilt look-alike describes the same ask and
 * authorizes none of it. `with()` registers a descendant and supersedes its
 * parent, so exactly one leaf is live at a time and a handler cannot route the
 * value it has already moved past.
 */

import type { Agent, LaunchOptions, PermissionMode, Session } from "./agent-api.ts";

/**
 * What public launch middleware is handed.
 *
 * Every member is a fact about the launch. None of them is a capability, and
 * `with()` produces another request rather than anything that can settle one.
 */
export interface AgentLaunchRequest {
  readonly instructions: string;
  readonly agent: Agent;
  readonly session?: string | Session;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly permissionMode: PermissionMode;
  readonly model?: string;
  /**
   * Derive a narrower request, superseding this one.
   *
   * Only the three members a handler is entitled to change: what the session is
   * told, which agent answers, and which session it belongs to. Everything else
   * describes authority the document already settled.
   */
  with(changes: {
    instructions?: string;
    agent?: Agent;
    session?: string | Session;
  }): AgentLaunchRequest;
}

/** Why a routed request cannot act. Never carries the request itself. */
export class AgentLaunchProtocolError extends Error {
  override name = "AgentLaunchProtocolError";
}

/**
 * One launch's private state.
 *
 * Held by the invocation that issued the launch and reached only through the
 * closure `with()` captures. Nothing on the public request points back here —
 * not a property, not a symbol, not a descriptor — because everything a handler
 * holds, it can read: `Reflect.ownKeys()` returns symbol keys as readily as
 * string ones, and a value recovered that way is a value that can be mutated.
 * A handler that could reach this object could retarget `leaf` and have its own
 * forgery admitted.
 */
interface LaunchInvocation {
  /** The one request that may currently be routed. */
  leaf: AgentLaunchRequest;
  /** False once the launch settled or its invocation was dismantled. */
  live: boolean;
  /** True once a provider accepted the request; a second acceptance refuses. */
  accepted: boolean;
  /** The document installation this launch belongs to. */
  generation: object;
  /**
   * Every request this launch issued, and the only values that are ones.
   *
   * Membership rather than a mark on the object: a look-alike is not refused
   * because it lacks a brand — brands can be copied — but because nothing ever
   * put it here. The set belongs to the invocation, so it lives and dies with
   * the launch rather than accumulating across runs.
   */
  issued: WeakSet<AgentLaunchRequest>;
}

/**
 * Where a request keeps its invocation.
 *
 * A module-local symbol, which is unreachable to another loaded copy and
 * unforgeable outside this file (architecture.md §State across loaded copies).
 * It is defined non-enumerable on a frozen object, so it survives none of the
 * ways a handler can produce a look-alike: a spread copy carries only
 * enumerable properties, and the frozen request admits no redefinition.
 */
const INVOCATION = Symbol("executablemd.agent.launch.invocation");

/**
 * The invocation `routed` belongs to, if it is one of ours.
 *
 * An *own* property, deliberately: `Object.create(request)` inherits everything
 * a prototype chain can reach, and a value that merely delegates to a live
 * request is not that request.
 */
function invocationOf(routed: unknown): LaunchInvocation | undefined {
  if (typeof routed !== "object" || routed === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(routed, INVOCATION)?.value as LaunchInvocation | undefined;
}

/** The normalized facts one launch is made of, before it becomes a request. */
export interface LaunchFacts {
  instructions: string;
  agent: Agent;
  session?: string | Session;
  cwd: string;
  additionalDirectories: readonly string[];
  permissionMode: PermissionMode;
  model?: string;
}

function build(facts: LaunchFacts, invocation: LaunchInvocation): AgentLaunchRequest {
  const request: AgentLaunchRequest = Object.freeze({
    instructions: facts.instructions,
    agent: facts.agent,
    ...(facts.session === undefined ? {} : { session: facts.session }),
    cwd: facts.cwd,
    additionalDirectories: Object.freeze([...facts.additionalDirectories]),
    permissionMode: facts.permissionMode,
    ...(facts.model === undefined ? {} : { model: facts.model }),
    with(changes: {
      instructions?: string;
      agent?: Agent;
      session?: string | Session;
    }): AgentLaunchRequest {
      const owner = invocation;
      if (!owner.live) {
        throw new AgentLaunchProtocolError(
          "this launch request is stale: its invocation has already settled",
        );
      }
      if (!Object.is(owner.leaf, request)) {
        throw new AgentLaunchProtocolError(
          "this launch request was already superseded by one derived from it",
        );
      }
      const derived = build(
        {
          ...facts,
          ...(changes.instructions === undefined ? {} : { instructions: changes.instructions }),
          ...(changes.agent === undefined ? {} : { agent: changes.agent }),
          ...(changes.session === undefined ? {} : { session: changes.session }),
        },
        owner,
      );
      owner.leaf = derived;
      return derived;
    },
  });
  // The only record that this value is one of this launch's requests. It is on
  // the invocation, never on the request, so holding the request grants a
  // reader nothing to recover.
  invocation.issued.add(request);
  return request;
}

/** What core keeps for one launch: the request to route, and its controls. */
export interface IssuedLaunch {
  request(): AgentLaunchRequest;
  /** Whether `routed` descends from this launch at all. */
  owns(routed: AgentLaunchRequest): boolean;
  /**
   * Admit `routed` as the request a provider is acting on.
   *
   * Refuses a copy, a foreign or superseded request, a second acceptance, and
   * anything arriving after the invocation stopped being live — each before the
   * provider performs any work.
   */
  admit(routed: AgentLaunchRequest, generation: object): void;
  accepted(): boolean;
  close(): void;
}

/** Issue one launch request for `generation`'s document installation. */
export function issueLaunch(facts: LaunchFacts, generation: object): IssuedLaunch {
  const invocation: LaunchInvocation = {
    leaf: undefined as unknown as AgentLaunchRequest,
    live: true,
    accepted: false,
    generation,
    issued: new WeakSet<AgentLaunchRequest>(),
  };
  invocation.leaf = build(facts, invocation);
  const root = invocation.leaf;

  return {
    request: () => root,
    owns: (routed) => invocation.issued.has(routed),
    admit(routed, routedGeneration) {
      const owner = invocation;
      // Not "does it look like one of ours" — whether this exact object is one
      // this launch issued. A descriptor-for-descriptor copy is a different
      // object, and no amount of reflection puts it in the set.
      if (!owner.issued.has(routed)) {
        throw new AgentLaunchProtocolError(
          "this is not a live launch request — a rebuilt or foreign value authorizes no launch",
        );
      }
      if (!owner.live) {
        throw new AgentLaunchProtocolError(
          "this launch request is stale: its invocation has already settled",
        );
      }
      if (!Object.is(owner.leaf, routed)) {
        throw new AgentLaunchProtocolError(
          "this launch request was already superseded by one derived from it",
        );
      }
      if (owner.generation !== routedGeneration) {
        throw new AgentLaunchProtocolError(
          "this launch request belongs to a different provider installation",
        );
      }
      if (owner.accepted) {
        throw new AgentLaunchProtocolError("this launch request was already performed");
      }
      owner.accepted = true;
    },
    accepted: () => invocation.accepted,
    close() {
      invocation.live = false;
    },
  };
}

/** The facts a routed request carries, for the provider that accepted it. */
export function launchOptionsOf(request: AgentLaunchRequest): LaunchOptions {
  return {
    agent: request.agent,
    ...(request.session === undefined ? {} : { session: request.session }),
  };
}
