/**
 * The native session launch seam (specs/native-agent-session-launch-spec.md).
 *
 * A launch is one deterministic preparation followed by an ownership handoff,
 * and it moves through these phases:
 *
 * ```text
 * prepared -> materialization prompt -> materialized -> detached -> launched -> exited
 * ```
 *
 * `materialization prompt` and `materialized` are present only for a provider
 * whose freshly created conversation is not yet one its native UI can open. The
 * providers that need no such turn go straight from `prepared` to `detached`,
 * and a launch on them still costs zero model turns.
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
import type { AgentPromptCheckpoint } from "./checkpoint.ts";

export type LaunchPhase = "prepared" | "materialized" | "detached" | "launched" | "exited";

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
  | "executable-binding-refused"
  | "materialization-failed";

/**
 * `session-busy` is contention, not breakage: another XMD owner holds the
 * logical session right now, and the same command run again after that owner
 * exits succeeds. `session-recovery-required` is the conservative one — the
 * last owner never proved it stopped, so nothing here can say the session is
 * free, and no elapsed time, pid or released lock changes that.
 *
 * `executable-binding-refused` is the question of whether this run can account
 * for the build behind a provider command at all — never whether that build is
 * the one a session was opened by. Failing to see it ends here: no observer on
 * this host, resolution, canonicalization, executable-file validation, and
 * digesting. So does a client-allocated session whose durable records were
 * written before one of them said which build accepted the identity, because a
 * launch nobody completed is resumed by holding those two records to each
 * other, and there is nothing there to hold.
 *
 * Whether an executable this run *can* see may act is a different question with
 * a different answer: it is admitted on its own terms, and refusing it is
 * `unsupported-capability`.
 *
 * `materialization-failed` is the one turn a launch may owe: the conversation
 * ACP created is not yet one the native UI can open, the exchange that would
 * make it openable did not complete, and the launch stops with ACP ownership
 * still where it was rather than handing over a session the UI would refuse by
 * name.
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
 * Written once, when the identity is first published, and never rewritten. It
 * is audit evidence about a past observation and a cross-check between the two
 * durable accounts of that one observation — never a gate on the build
 * installed now. Whether a session may be continued is decided by admitting the
 * live executable on its own terms; which build accepted the identity first is
 * history, and history is not a capability.
 *
 * What is retained is deliberately not a path: a path says where a build was,
 * which stops being true, while a digest says which build it was, which does
 * not. That also keeps the record free of host layout.
 *
 * The digest is what names the build. `reportedVersion` is optional evidence
 * beside it: an executable that will not say which release it is, says
 * something this provider does not recognize, or says several things is
 * described by its bytes alone rather than refused for being quiet.
 */
export interface ExecutableBuildBindingV1 {
  readonly schema: "executable-build.v1";
  readonly reportedVersion?: string;
  readonly executableDigest: {
    readonly algorithm: "sha256";
    readonly value: string;
  };
}

/**
 * Whether `observed` is the build `retained` names.
 *
 * Asymmetric, because the two arguments are not the same kind of claim. The
 * digest decides: identical bytes are the same build reached through whatever
 * path, and different bytes are a different build however it describes itself.
 *
 * A retained version is then a claim the other account must still make. One
 * that named a release and now meets one calling itself something else — or
 * nothing at all — has lost the evidence it was written with. One that named
 * none never had that evidence, so a version appearing later adds nothing to
 * reproduce and does not rewrite what was retained.
 *
 * This says which build an account describes, and nothing about what an
 * installed executable can do. Continuation is not decided by asking it about a
 * live observation — a session crosses releases on a fresh capability admission
 * instead. What it is for is holding two durable accounts of one preparation to
 * each other, which is exact when asked in both directions.
 */
export function sameExecutableBuild(
  retained: ExecutableBuildBindingV1,
  observed: ExecutableBuildBindingV1,
): boolean {
  return (
    retained.schema === observed.schema &&
    retained.executableDigest.algorithm === observed.executableDigest.algorithm &&
    retained.executableDigest.value === observed.executableDigest.value &&
    (retained.reportedVersion === undefined ||
      retained.reportedVersion === observed.reportedVersion)
  );
}

/**
 * The one model turn a launch may owe, named before it is spent.
 *
 * Some providers persist a conversation only once something has been said in
 * it, so the session ACP just created is not yet one the native UI can open.
 * Exactly one XMD-owned turn closes that gap, and it is planned in the
 * preparation rather than decided later: the version says which exact prompt
 * will be sent, and the request id is fixed here so a replay that finds the
 * turn already retained is looking for the same turn rather than a new one.
 *
 * Present only for a provider that needs it, and only for a conversation this
 * launch created. Nothing else acquires a turn by being launched.
 */
export interface MaterializationPlan {
  /** Which exact prompt this is — `codex-materialization.v1`. */
  readonly promptVersion: string;
  /** The request id the turn runs under, immutable once `prepared` is kept. */
  readonly requestId: string;
  /**
   * The exact text that will be sent, retained before it is sent.
   *
   * A version names a prompt; this is the prompt. Keeping the bytes with the
   * plan is what lets a reader of the journal see what an XMD-owned turn said
   * in someone's conversation without holding the build that composed it.
   */
  readonly prompt: string;
}

/**
 * What the provider reported about what the materialization turn cost.
 *
 * Every field is optional and a missing one means the provider reported
 * nothing, which is displayed and retained as exactly that. Nothing here reads
 * absence as zero: a turn whose token count was never reported is not a free
 * turn, and saying so would be inventing an observation.
 */
export interface MaterializationUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly thoughtTokens?: number;
  readonly totalTokens?: number;
  readonly costAmount?: number;
  readonly costCurrency?: string;
}

/**
 * The turn that made a fresh conversation openable, and what it cost.
 *
 * Retained as its own phase because it sits between two facts that must not be
 * confused: the session exists (`prepared`) and ACP has let go of it
 * (`detached`). A launch interrupted after the turn must never spend a second
 * one, and the only thing that can say the first was spent is a record of it.
 *
 * `turn` is the provider's own name for the completed turn, carried across
 * unchanged. It is the evidence the exchange reached the backend rather than
 * merely being written to a socket, and it is the same checkpoint the durable
 * prompt retained — which is what lets this record be rebuilt from that prompt
 * when a run stopped between the two.
 */
export interface MaterializedLaunchRecord {
  phase: "materialized";
  promptVersion: string;
  requestId: string;
  /**
   * The provider-native identity this turn made real. Absent on a failure.
   *
   * A conversation a backend has not accepted a turn in is not one a native UI
   * can open, so the identity of one is asserted here rather than in the
   * preparation: the launch that plans a turn prepares no identity at all, and
   * this is where the one it produced becomes the thing that gets handed over.
   */
  nativeSessionId?: string;
  /** The provider's identity for the completed turn. Absent on a failure. */
  turn?: AgentPromptCheckpoint;
  /** How long the turn took, in milliseconds. Absent when no turn was run. */
  durationMs?: number;
  usage: MaterializationUsage;
  /** The assistant's full response text, retained and displayed unabridged. */
  response: string;
  stopReason?: string;
  failure?: LaunchFailure;
}

/**
 * What one provider retained about the session it prepared.
 *
 * `nativeSessionId` is asserted by the provider. An ACP session id, an ACPX
 * record id, and a provider-native session id are three different identities,
 * and only the third one crosses the handoff.
 *
 * It is empty exactly when `materialization` names a turn this launch still
 * owes. Until that turn is accepted there is no conversation for an identity to
 * name — the provider holds occupancy, not a session — so the preparation says
 * so rather than asserting a name nothing would resume, and the accepted turn
 * asserts the identity instead.
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
   * Which build the provider-native identity belongs to, present exactly when
   * the adapter behind it binds one. Independent of who chose the identity: a
   * build accepted the name XMD allocated, or issued the name XMD was handed,
   * and neither name resolves to one conversation without it. Copied from the
   * construction route rather than observed here, so the journal and the route
   * are two accounts of a single observation instead of two observations.
   *
   * It is never held against a build installed later; the one comparison it
   * takes part in is with the route it was copied from, which is how an
   * incomplete launch proves which session it is resuming.
   *
   * Optional because both paths were released before any build was observed. A
   * record without it is legacy history: readable, resumable by the native-only
   * contract that wrote it, and never an attachable session.
   */
  executableBinding?: ExecutableBuildBindingV1;
  /**
   * The one turn this launch owes before the native UI can open, when it owes
   * one. Absent means no turn is owed and none may be taken.
   *
   * Retained with the preparation so the plan is fixed before anything is
   * spent: a replay reads which prompt and which request id the first attempt
   * committed to, rather than choosing them again.
   */
  materialization?: MaterializationPlan;
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

export type LaunchRecord =
  | PreparedLaunchRecord
  | MaterializedLaunchRecord
  | DetachedLaunchRecord
  | ExitedLaunchRecord;

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
