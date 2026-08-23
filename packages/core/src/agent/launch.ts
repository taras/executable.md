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
 * Each phase a provider completes is retained by the invocation that issued
 * the launch, through the authority core delivers to the selected provider.
 * The provider hands each phase's work over rather than performing it and
 * reporting afterwards, so a replay of that phase never runs the work again: a
 * resumed launch reuses the provider-native identity the first attempt
 * retained instead of creating a replacement session.
 *
 * That is what keeps operational authority with the launch invocation. Public
 * middleware composed around the Agent Api receives a request and may refuse
 * it; there is nothing on that chain it can use to retain a phase, and a value
 * it returns settles nothing.
 *
 * `launched` is the live state between the spawn and the child's exit. It is
 * deliberately not a retained record: an interrupted native process leaves
 * `detached` as the last retained phase, and resuming reattaches the native UI
 * to that same provider session.
 */

import type { PermissionMode } from "./agent-api.ts";

export type LaunchPhase = "prepared" | "detached" | "launched" | "exited";

/**
 * What a launch did about the instruction layer, so the choice is observable
 * rather than inferred from the identity that came back.
 *
 * `installed` — a session was created carrying the prepared layer.
 * `resumed` — the session already carried this exact layer.
 * `replaced` — the provider changed the layer in place, preserving identity
 *   and history.
 *
 * There is no "recreated": V1 discards no persistent provider state to install
 * a layer, because nothing available to a provider distinguishes a shell it
 * created from a conversation another owner is having.
 */
export type InstructionReconciliation = "installed" | "resumed" | "replaced";

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
  | "session-busy"
  | "session-recovery-required"
  | "executable-binding-refused";

/**
 * `session-busy` is contention, not breakage: another XMD owner holds the
 * logical session right now, and the same command run again after that owner
 * exits succeeds. `session-recovery-required` is the conservative one — the
 * last owner never proved it stopped, so nothing here can say the session is
 * free, and no elapsed time, pid or released lock changes that.
 *
 * `executable-binding-refused` is the build question: the session was
 * established by one build of a provider executable, and this run could not
 * show it is talking to that same build. Resolution, canonicalization,
 * executable-file validation, version parsing, digesting, schema recognition,
 * equality, and a session established before any build was recorded all end
 * here.
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
 *   the property that lets a native UI be handed a session to create.
 *
 * Retained rather than inferred, because the two are indistinguishable after
 * the fact: a returned identity and a supplied one are both just a string in
 * the record.
 */
export type IdentityProvenance = "provider-returned" | "client-allocated";

/**
 * Which build of a provider executable a session was established against.
 *
 * A client-allocated session is only meaningful while the build that created
 * it can be reproduced. Two builds of the same provider accept the same
 * identity and disagree silently about what it names, so a session whose build
 * cannot be reproduced is refused rather than resumed.
 *
 * What is retained is deliberately not a path: a path says where a build was,
 * which stops being true, while a version and a digest say which build it was,
 * which does not. That also keeps the record free of host layout.
 */
export interface ExecutableBuildBindingV1 {
  readonly schema: "executable-build.v1";
  readonly reportedVersion: string;
  readonly executableDigest: {
    readonly algorithm: "sha256";
    readonly value: string;
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
   * identity a reader cannot tell from a returned one is an identity a replay
   * could silently replace.
   */
  identityProvenance: IdentityProvenance;
  /**
   * Which build accepted the client-allocated identity, present exactly when
   * this provider binds one. A provider that returns its own identity owns its
   * own session lifetime and binds nothing, so it carries none.
   *
   * Optional because the client-allocated path was released before any build
   * was observed. A record without it is legacy history: readable, resumable by
   * the native-only contract that wrote it, and never an attachable session.
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
