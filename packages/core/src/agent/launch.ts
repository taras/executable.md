/**
 * The native session launch seam (specs/native-agent-session-launch-spec.md).
 *
 * A launch is one deterministic preparation followed by an ownership handoff,
 * and it moves through four phases:
 *
 * ```text
 * prepared -> detached -> launched -> exited
 * ```
 *
 * Each phase a provider completes is retained through `AgentLaunchJournal`,
 * which `<Session.Launch>` installs for exactly one invocation. The provider
 * hands each phase's work to the journal rather than performing it and
 * reporting afterwards, so a replay of that phase never runs the work again:
 * a resumed launch reuses the provider-native identity the first attempt
 * retained instead of creating a replacement session.
 *
 * That is also what keeps operational authority with the launch invocation.
 * Public middleware composed around the Agent Api can observe a launch or
 * refuse one, but a middleware that returns a `SessionLaunchResult` without
 * going through this journal retains no phase, and `<Session.Launch>` refuses
 * a launch whose phases it never saw reach `exited`.
 *
 * `launched` is the live state between the spawn and the child's exit. It is
 * deliberately not a retained record: an interrupted native process leaves
 * `detached` as the last retained phase, and resuming reattaches the native UI
 * to that same provider session.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { type Context, createContext, type Operation, scoped } from "effection";
import type { PermissionMode } from "./agent-api.ts";

export type LaunchPhase = "prepared" | "detached" | "launched" | "exited";

/**
 * Set while an agent is being resolved *for* a launch, ahead of its journal.
 *
 * A launch resolves its agent before `AgentLaunchJournal` is installed, which
 * is the right order for reporting a missing agent as an expansion failure
 * rather than as a retained refusal. It is the wrong order for a provider that
 * answers "is this agent available?" by inspecting something in the world: a
 * completed launch replays without performing any phase, so an inspection made
 * here would be made on every replay of a launch that does nothing at all.
 *
 * A provider that reads this defers such an inspection into its own `prepared`
 * work, where the journal decides whether it runs. Availability asked for any
 * other reason is unaffected — this is only ever set around a launch's own
 * resolution.
 */
export const LaunchResolution: Context<boolean> = createContext<boolean>(
  "agent.launch.resolution",
  false,
);

/** Resolve `agent` as a launch's own, so a provider can defer live checks. */
export function resolvingLaunch<T>(agent: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* LaunchResolution.set(true);
    return yield* agent();
  });
}

/**
 * What a launch did about the instruction layer, so the choice is observable
 * rather than inferred from the identity that came back.
 *
 * `installed` — a session was created carrying the prepared layer.
 * `resumed` — the session already carried this exact layer.
 * `replaced` — the provider changed the layer in place, preserving identity
 *   and history.
 * `recreated` — an XMD-owned shell that had never been used was discarded and
 *   re-established carrying the prepared layer.
 */
export type InstructionReconciliation = "installed" | "resumed" | "replaced" | "recreated";

/**
 * Why a launch stopped, in terms an author can act on.
 *
 * The class is stable and retained; the message is diagnostic. Neither
 * carries provider credentials, adapter settings, executable paths, argv,
 * environment, temporary paths, or native transcript content.
 */
export type LaunchFailureClass =
  | "unsupported-capability"
  | "identity-unavailable"
  | "instructions-refused"
  | "directory-authority"
  | "detach-failed"
  | "process-creation-failed"
  | "native-exit"
  | "executable-binding-refused"
  | "session-busy";

/**
 * `session-busy` is contention, not breakage. Another XMD owner holds the
 * logical session right now — a native UI someone is working in, or a turn in
 * another process — and this launch refused instead of queueing behind it. The
 * same command run again after that owner exits succeeds.
 */
export interface LaunchFailure {
  class: LaunchFailureClass;
  message: string;
}

/**
 * Who chose the provider-native session identity.
 *
 * `provider-returned` — the provider created the session and told XMD what it
 *   is called. Whatever it returns is the identity.
 * `client-allocated` — XMD chose the identity before the provider existed and
 *   supplied it unchanged. Nothing the provider says can replace it, which is
 *   the property that lets a native UI and a later ACP attachment name the
 *   same conversation.
 *
 * The distinction is retained rather than inferred, because the two are
 * indistinguishable after the fact: a returned identity and a supplied one are
 * both just a string in the record.
 */
export type IdentityProvenance = "provider-returned" | "client-allocated";

/**
 * Which build of a provider executable a session was established against.
 *
 * A client-allocated session is only meaningful while the build that created
 * it can be reproduced. Two builds of the same provider will accept the same
 * identity and disagree silently about what it names — the observed cause of
 * issue #519's first failed gate, where one Claude build created a session and
 * a second was asked to resume it and produced an empty conversation.
 *
 * So the binding is retained and compared, and a session whose build cannot be
 * reproduced is refused rather than resumed. What is retained is deliberately
 * not a path: a path says where a build was, which stops being true, while a
 * version and a digest say which build it was, which does not. That also keeps
 * the record free of host layout.
 */
export interface ExecutableBuildBindingV1 {
  schema: "executable-build.v1";
  reportedVersion: string;
  executableDigest: {
    algorithm: "sha256";
    value: string;
  };
}

/**
 * Whether two bindings name the same build.
 *
 * Equality is over what was retained, so the same build reached through a
 * different path is compatible and a different build at the same path is not.
 */
export function sameExecutableBuild(
  left: ExecutableBuildBindingV1,
  right: ExecutableBuildBindingV1,
): boolean {
  return (
    left.schema === right.schema &&
    left.reportedVersion === right.reportedVersion &&
    left.executableDigest.algorithm === right.executableDigest.algorithm &&
    left.executableDigest.value === right.executableDigest.value
  );
}

/**
 * What one provider retained about the session it prepared.
 *
 * `nativeSessionId` is asserted by the provider. An ACP session id, an ACPX
 * record id, and a provider-native session id are three different identities,
 * and only the third one crosses the handoff.
 *
 * `instructions` is the prepared text itself, and it is retained beside its
 * digest — the execution's secret gate runs before this record persists, so
 * prepared text carrying a credential-shaped value never reaches the journal
 * and never reaches a native UI either.
 */
export interface PreparedLaunchRecord {
  phase: "prepared";
  agent: string;
  sessionKey: string;
  provider: string;
  nativeSessionId: string;
  sessionState: "created" | "resumed";
  instructionChannel: string;
  instructionReconciliation: InstructionReconciliation;
  /**
   * Retained rather than derived from the provider, because a client-allocated
   * identity that a reader cannot distinguish from a returned one is an
   * identity a replay could silently replace.
   */
  identityProvenance: IdentityProvenance;
  /**
   * Present exactly when the provider binds one executable build, which today
   * is the client-allocated path. A provider that returns its own identity
   * owns its own session lifetime and binds nothing.
   */
  executableBinding?: ExecutableBuildBindingV1;
  instructionsDigest: string;
  instructions: string;
  cwd: string;
  additionalDirectories: string[];
  permissionMode: PermissionMode;
  launcher: string;
  requestedModel?: string;
  model?: string;
  failure?: LaunchFailure;
}

/** ACP ownership of the prepared session has ended. */
export interface DetachedLaunchRecord {
  phase: "detached";
  failure?: LaunchFailure;
}

/** The native UI exited on its own, and this is how. */
export interface ExitedLaunchRecord {
  phase: "exited";
  exitCode?: number;
  signal?: string;
  failure?: LaunchFailure;
}

export type LaunchRecord = PreparedLaunchRecord | DetachedLaunchRecord | ExitedLaunchRecord;

/**
 * A launch that stopped at a phase, carrying the phase it reached and the
 * stable class of what stopped it.
 */
export class AgentLaunchError extends Error {
  override name = "AgentLaunchError";
  phase: LaunchPhase;
  failureClass: LaunchFailureClass;

  constructor(
    message: string,
    options: { phase: LaunchPhase; failureClass: LaunchFailureClass; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.phase = options.phase;
    this.failureClass = options.failureClass;
  }
}

/**
 * The phase journal one `<Session.Launch>` invocation lends its provider.
 *
 * Each operation runs its phase's work once and retains the record it
 * produced; a replay returns the retained record and never invokes the work.
 * A record carrying a failure is retained and then raised, so the provider
 * stops where the first attempt stopped without repeating what came after it.
 */
export interface AgentLaunchJournalApi {
  recordPreparation(live: () => Operation<PreparedLaunchRecord>): Operation<PreparedLaunchRecord>;
  recordDetach(live: () => Operation<DetachedLaunchRecord>): Operation<DetachedLaunchRecord>;
  recordExit(live: () => Operation<ExitedLaunchRecord>): Operation<ExitedLaunchRecord>;
}

function noLaunch(operation: string): Error {
  return new Error(
    `AgentLaunchJournal.${operation} is available only while a <Session.Launch> ` +
      `invocation is running — a provider records launch phases through the ` +
      `journal that invocation installs`,
  );
}

export const AgentLaunchJournal: Api<AgentLaunchJournalApi> = createApi<AgentLaunchJournalApi>(
  "agent.launch.journal",
  {
    // deno-lint-ignore require-yield
    *recordPreparation(): Operation<PreparedLaunchRecord> {
      throw noLaunch("recordPreparation()");
    },
    // deno-lint-ignore require-yield
    *recordDetach(): Operation<DetachedLaunchRecord> {
      throw noLaunch("recordDetach()");
    },
    // deno-lint-ignore require-yield
    *recordExit(): Operation<ExitedLaunchRecord> {
      throw noLaunch("recordExit()");
    },
  },
);
