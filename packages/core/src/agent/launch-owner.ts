/**
 * `Agent.launch()` — the one operation that owns a native session launch.
 *
 * `<Session.Launch>` renders its body and calls this; a repository function
 * component may call it directly. There is exactly one implementation of the
 * phases, so the component and the programmatic caller cannot drift, and
 * neither of them is where authority lives.
 *
 * The order here is the contract. The terminal is reserved before an agent is
 * resolved, because a host with no terminal cannot launch anything and learning
 * that should not cost an agent probe. The request is issued next, routed
 * through the public `Agent` chain, and settled only from what the invocation
 * retained — never from what came back up the chain.
 */

import { createApi } from "@effectionx/context-api";
import { scoped } from "effection";
import type { Operation, Stream } from "effection";
import { cwd, flushOutput, reserveTerminal } from "@executablemd/runtime";
import { Agent, AGENT_API } from "./agent-api.ts";
import type {
  AgentApi,
  AgentPromptEvent,
  LaunchOptions,
  PermissionRequest,
  Session,
  SessionLaunchResult,
} from "./agent-api.ts";
import { AgentInternal, formatLocation } from "./internal.ts";
import { AgentLaunchError } from "./launch.ts";
import type {
  DetachedLaunchRecord,
  ExitedLaunchRecord,
  LaunchPhase,
  PreparedLaunchRecord,
} from "./launch.ts";
import { AgentLaunchProtocolError, issueLaunch } from "./launch-request.ts";
import type { AgentLaunchRequest } from "./launch-request.ts";
import type { LiveLaunch } from "./launch-authority.ts";
import { persistDetach, persistExit, persistPreparation } from "./launch-journal.ts";
import type { LaunchIdentity } from "./launch-journal.ts";
import { getExpansion } from "../expansion.ts";

/** Where a launch's durable identity and normalized facts come from. */
export interface LaunchSite {
  identity: LaunchIdentity;
  cwd: string;
  additionalDirectories: string[];
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
}

/**
 * Read the launch site from the running expansion.
 *
 * A launch outside an installed agent execution has no ordinal, no journal and
 * no terminal, so it refuses here rather than performing something no replay
 * could resume.
 */
export function* launchSite(): Operation<LaunchSite> {
  const expansion = yield* getExpansion();
  const location = formatLocation(expansion);
  const ordinal = yield* AgentInternal.operations.launchOrdinal(location);
  const identity: LaunchIdentity = { name: `launch:${location}#${ordinal}` };
  if (expansion.position) {
    identity.position = expansion.position;
  }
  return {
    identity,
    cwd: yield* cwd(),
    // `Agent.AddDir` is not built, so a launch declares no additional roots yet
    // and the retained request says so explicitly rather than omitting it.
    additionalDirectories: [],
    permissionMode: yield* AgentInternal.operations.permissionMode,
  };
}

/** Registered live launches, so the authority can resolve a routed request. */
export interface LaunchRegistry {
  live(): readonly LiveLaunch[];
  add(launch: LiveLaunch): void;
  remove(launch: LiveLaunch): void;
}

export function createLaunchRegistry(): LaunchRegistry {
  const launches = new Set<LiveLaunch>();
  return {
    live: () => [...launches],
    add: (launch) => {
      launches.add(launch);
    },
    remove: (launch) => {
      launches.delete(launch);
    },
  };
}

/**
 * Raise a phase that was retained as a refusal.
 *
 * Retained first and raised second, so the phase a later replay resumes from is
 * the phase that actually happened — including when what happened was the
 * provider declining to go further.
 */
function raiseRetained(phase: LaunchPhase, failure: { class: string; message: string }): never {
  throw new AgentLaunchError(failure.message, {
    phase,
    failureClass: parseFailureClass(failure.class),
  });
}

function parseFailureClass(value: string): AgentLaunchError["failureClass"] {
  switch (value) {
    case "unsupported-capability":
    case "identity-unavailable":
    case "instructions-refused":
    case "directory-authority":
    case "detach-failed":
    case "process-creation-failed":
    case "native-exit":
    case "session-busy":
    case "session-recovery-required":
      return value;
    default:
      return "unsupported-capability";
  }
}

/** What a launch retains when no provider ever accepted its request. */
function unaccepted(request: AgentLaunchRequest, site: LaunchSite): PreparedLaunchRecord {
  return {
    phase: "prepared",
    agent: request.agent,
    sessionKey: "",
    provider: "",
    nativeSessionId: "",
    sessionState: "created",
    instructionChannel: "",
    instructionReconciliation: "installed",
    // Nobody prepared anything, so nobody chose an identity. The weaker of the
    // two claims is the honest one to retain.
    identityProvenance: "provider-returned",
    instructionsDigest: "",
    instructions: "",
    cwd: site.cwd,
    additionalDirectories: [...site.additionalDirectories],
    permissionMode: site.permissionMode,
    launcher: "",
    failure: {
      class: "unsupported-capability",
      message:
        `no agent provider performed this launch. A provider installs the launch ` +
        `capability explicitly; middleware composed around Agent.launch() routes a ` +
        `request and cannot perform one.`,
    },
  };
}

/**
 * Perform one launch and return what the invocation retained.
 *
 * The registry is this document installation's; the authority handed to
 * providers resolves a routed request through it.
 */
export function launchSession(
  registry: LaunchRegistry,
  generation: object,
  instructions: string,
  options: LaunchOptions | undefined,
): Operation<SessionLaunchResult> {
  return scoped(function* (): Operation<SessionLaunchResult> {
    // The one foreground-terminal lease, and the first thing asked for.
    yield* reserveTerminal();
    // Everything the document has said so far reaches the reader before the
    // native UI draws over the terminal.
    yield* flushOutput();

    const site = yield* launchSite();
    // Resolving here is the availability boundary: an agent that is not there
    // fails expansion rather than being retained as a refused launch.
    const agent = yield* Agent.operations.agent(options?.agent);

    const sessionProp = typeof options?.session === "string" ? options.session : undefined;
    const issued = issueLaunch(
      {
        instructions,
        agent,
        ...(options?.session === undefined ? {} : { session: options.session }),
        cwd: site.cwd,
        additionalDirectories: site.additionalDirectories,
        permissionMode: site.permissionMode,
      },
      generation,
    );

    const launch: LiveLaunch = {
      issued,
      retention: {
        prepared: (live) =>
          persistPreparation(
            site.identity,
            {
              instructions,
              agent,
              ...(sessionProp === undefined ? {} : { session: sessionProp }),
              cwd: site.cwd,
              additionalDirectories: site.additionalDirectories,
              permissionMode: site.permissionMode,
            },
            live,
          ),
        detached: (live) => persistDetach(site.identity, live),
        exited: (live) => persistExit(site.identity, live),
      },
    };
    registry.add(launch);

    const request = issued.request();
    let refused: AgentLaunchProtocolError | undefined;
    try {
      // Same stable name, so every public handler composes exactly as it
      // always did; own descriptor, so the chain ends in this invocation's
      // terminal rather than in the exported default that refuses.
      const invocation = createApi<AgentApi>(AGENT_API, terminalHandlers(request));
      yield* invocation.operations.launch(request);
    } catch (error) {
      // A routed value the terminal would not accept — a copy, a superseded
      // parent, a foreign request, a second delegation. Nobody performed the
      // launch, and that is what the retention below records.
      if (!(error instanceof AgentLaunchProtocolError)) {
        throw error;
      }
      refused = error;
    } finally {
      issued.close();
      registry.remove(launch);
    }
    if (refused && issued.accepted()) {
      // The request was accepted and then something violated the protocol. That
      // is not "nobody performed it", so it is not retained as one.
      throw refused;
    }

    // Nobody performed it. That is retained as a refusal rather than raised
    // bare, so a replay resumes from the phase that actually happened.
    if (!issued.accepted()) {
      const record = yield* launch.retention.prepared(
        // deno-lint-ignore require-yield
        function* () {
          return unaccepted(request, site);
        },
      );
      raiseRetained("prepared", record.failure!);
    }

    if (launch.preparation?.failure) {
      raiseRetained("prepared", launch.preparation.failure);
    }
    if (launch.detachment?.failure) {
      raiseRetained("detached", launch.detachment.failure);
    }
    const exited = launch.exit;
    if (exited?.failure) {
      raiseRetained("exited", exited.failure);
    }
    // The UI ran and ended badly. Reported from the retained record, so a
    // replay says the same thing without starting a second one.
    if (exited?.signal !== undefined) {
      throw new AgentLaunchError(`the native agent UI was terminated by ${exited.signal}`, {
        phase: "exited",
        failureClass: "native-exit",
      });
    }
    if (exited && exited.exitCode !== 0) {
      throw new AgentLaunchError(
        `the native agent UI exited with status ${exited.exitCode ?? "unknown"}`,
        { phase: "exited", failureClass: "native-exit" },
      );
    }
    if (!launch.settled) {
      throw new AgentLaunchError(`the launch stopped before the native session was handed over`, {
        phase: "detached",
        failureClass: "detach-failed",
      });
    }
    return launch.settled;
  });
}

/**
 * This invocation's authoritative terminal.
 *
 * Reaching it means no provider consumed the request, so nothing prepared,
 * detached or spawned. Every other operation delegates outward unchanged: the
 * launch route is the only one this descriptor is authoritative for.
 */
function terminalHandlers(request: AgentLaunchRequest): AgentApi {
  return {
    *agent(name?: string) {
      return yield* Agent.operations.agent(name);
    },
    *session(name?: string): Operation<Session> {
      return yield* Agent.operations.session(name);
    },
    *prompt(
      content: string,
      options?: Parameters<AgentApi["prompt"]>[1],
    ): Operation<Stream<AgentPromptEvent, string>> {
      return yield* Agent.operations.prompt(content, options);
    },
    // deno-lint-ignore require-yield
    *launch(routed: AgentLaunchRequest): Operation<void> {
      // Deliberately silent: the caller sees "nobody accepted" through the
      // invocation's own state, which a handler cannot write to.
      void routed;
      void request;
    },
    *requestPermission(permission: PermissionRequest) {
      return yield* Agent.operations.requestPermission(permission);
    },
  };
}
