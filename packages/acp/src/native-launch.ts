/**
 * Native launcher adapters (specs/native-agent-session-launch-spec.md
 * §Provider-native identity).
 *
 * An adapter knows one thing a document must never state: the argv that makes
 * a particular coding-agent CLI resume one exact provider-native session.
 * `claude --resume <id>` and `codex resume <id>` are adapter implementation
 * details, not authored values, and neither an executable path nor a session
 * id ever appears in a document.
 *
 * Knowing the command shape is not the same as being launch-capable.
 * Advertisement is separate, and what an adapter has to prove depends on who
 * names its sessions. An adapter the provider names proves that the session
 * ACP created is the session the native UI resumes; an adapter that names its
 * own sessions creates one directly, so what it proves instead is that the
 * native process makes that exact conversation, that the private instruction
 * layer governs its first user turn without a bootstrap, and that a later
 * invocation resumes the same identity rather than making a second one.
 * Until an adapter has proven its own contract against the installed CLI,
 * `<Session.Launch>` refuses that agent before anything of the session moves —
 * before a provider-returned adapter's ACP session is released, and before a
 * client-allocated one allocates an identity or writes a private file. That is
 * the failure the contract asks for rather than a hopeful spawn.
 *
 * Adapters differ in one structural way, and it is discriminated rather than
 * inferred: who chooses the provider-native session identity. A
 * `provider-returned` adapter can only resume a session something else created
 * and named. A `client-allocated` adapter names the session first and hands
 * that name to the native process, which is what lets a launch construct a
 * conversation instead of merely reattaching to one.
 */

import { randomUUID } from "node:crypto";
import type { IdentityProvenance } from "@executablemd/core";
import type {
  NativeCapabilityCompatibility,
  NativeCapabilityHost,
  ProvedNativeCapability,
} from "./native-capability.ts";

/**
 * What an adapter knows about the build behind its executable.
 *
 * A session whose identity XMD chose only means something while the build that
 * accepted it can be recognized later: two builds of one provider accept the
 * same identity and disagree silently about what it names. Everything here is
 * that adapter's private dialect — which command to observe, what its version
 * output looks like, and what the ACP adapter child needs in order to run the
 * same build. None of it reaches a document.
 */
export interface NativeBinding {
  /** The command whose build is observed, bound and retained. */
  command: string;
  /** The arguments that ask that exact file its version. */
  versionArgs?: readonly string[];
  /**
   * The canonical version from that output, or `undefined` when the output is
   * not something this adapter recognizes. An unrecognized version is a
   * refusal, not a value to retain — a build XMD cannot name is one it cannot
   * later confirm.
   */
  version(output: string): string | undefined;
  /**
   * The exact ACP adapter command this binding was proven against, when the
   * proof is tied to one.
   *
   * ACPX resolves adapters through a semver range of its own, which is free to
   * select a different adapter tomorrow than the one an integration proof ran
   * against. A capability that depends on how an adapter handles resume
   * identity cannot be left to that range.
   *
   * It pins which adapter process runs, and nothing else. It is live, like the
   * executable path beside it: it enters no route, journal or natural key, so a
   * session established before this pin existed is still found under the same
   * key.
   *
   * Absent leaves ACPX's own resolution in place, which is what an adapter with
   * no version-specific proof wants.
   */
  adapterCommand?: string;
  /**
   * The environment the ACP adapter child needs to run this exact build.
   *
   * Transient by construction: it is handed to the runtime for the children it
   * spawns, and never persisted, exported, or written into a session record.
   */
  environment(livePath: string): Record<string, string>;
}

/**
 * Claude reports `2.1.241 (Claude Code)`.
 *
 * The whole line is retained rather than the number alone, because the number
 * alone is not a build: the same version string from a different product would
 * compare equal. Anything that does not look like this is unrecognized, and an
 * unrecognized build is refused rather than retained under a guess.
 *
 * Exactly one line may match. Zero is an output this adapter does not
 * recognize; two or more is output it cannot read as one answer, and taking
 * the first would be picking a build out of a list of them. Neither is
 * repeated anywhere — the caller refuses with a stable class, and the output
 * itself is provider-private.
 */
function claudeVersion(output: string): string | undefined {
  const canonical = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(line));
  return canonical.length === 1 ? canonical[0] : undefined;
}

interface AdapterCommands {
  /** Stable adapter identity — `claude`, `codex`. Never an executable path. */
  launcher: string;
  /** Who chooses this adapter's native session identity. */
  identity: IdentityProvenance;
  /** The argv that resumes this exact provider-native session. */
  resume(nativeSessionId: string): string[];
  /**
   * The exact builds and machines a real-CLI proof of this adapter ran on.
   *
   * The adapter's, because the proof is about this adapter's own contract
   * against its own installed CLI. Absent is the honest default: knowing a
   * command shape establishes nothing, and an adapter that has proved nothing
   * contributes no point for a host to admit.
   */
  proved?: readonly ProvedNativeCapability[];
}

/**
 * An adapter whose native UI is handed the session it is to create.
 *
 * `allocate` is the adapter's because the identity is that provider's dialect:
 * what shape one takes and what the provider will accept is knowledge about
 * the provider, not about launching in general. The provider decides whether a
 * freshly allocated candidate wins publication; it does not decide what one
 * looks like.
 *
 * The instruction layer crosses as a file path and never as text, so nothing
 * here takes the instructions themselves.
 */
export interface ClientAllocatedAdapter extends AdapterCommands {
  identity: "client-allocated";
  /** A fresh provider-native session identity. */
  allocate(): string;
  /** The argv that creates a session under `id` with that instruction layer. */
  create(nativeSessionId: string, instructionFile: string): string[];
  /**
   * Which build of this adapter's executable a session is bound to.
   *
   * Required, because an identity XMD chose is only meaningful beside the build
   * that accepted it. The argv `create` and `resume` return still begins with
   * the stable launcher name, which is what durable records carry; a run
   * replaces that first member with the exact path it observed.
   */
  binding: NativeBinding;
}

export interface ProviderReturnedAdapter extends AdapterCommands {
  identity: "provider-returned";
}

export type NativeAdapter = ProviderReturnedAdapter | ClientAllocatedAdapter;

/** Whether this adapter names its own sessions. */
export function allocatesIdentity(adapter: NativeAdapter): adapter is ClientAllocatedAdapter {
  return adapter.identity === "client-allocated";
}

/**
 * The one build and machine Claude's proofs ran on.
 *
 * Written once and shared by both points below so they cannot drift apart into
 * two claims about two builds. Raising either is a new proof rather than an
 * edit here: what makes this admissible is that a real CLI was driven through
 * the whole applicable contract on exactly this, and nothing about that
 * generalizes to the next release or the next machine.
 */
const CLAUDE_PROVED_BUILD = {
  reportedVersion: "2.1.241 (Claude Code)",
  platform: "darwin",
  architecture: "arm64",
} as const;

const ADAPTERS: Readonly<Record<string, NativeAdapter>> = {
  claude: {
    launcher: "claude",
    // XMD names the session before Claude exists, so the native process is
    // told which conversation to make rather than reporting one afterwards.
    identity: "client-allocated",
    // Claude takes a UUID it has never seen and makes it the session's name.
    allocate: () => randomUUID(),
    // Two points rather than one: `ClaudeNativeLaunch.test.md` and
    // `ClaudeZeroTurnExit.test.md` showed the launch contract, and
    // `ClaudeNativeToAcp.test.md` showed attachment. Either could have failed
    // while the other held, so neither is written down as the other's evidence.
    proved: [
      { capability: "native-launch", ...CLAUDE_PROVED_BUILD },
      { capability: "client-native-attachment", ...CLAUDE_PROVED_BUILD },
    ],
    binding: {
      command: "claude",
      version: claudeVersion,
      // The version #561's gates are proven against. Raising it is a new proof,
      // not a version bump.
      adapterCommand: "npx -y @agentclientprotocol/claude-agent-acp@0.70.0",
      // The first thing the Claude ACP adapter consults when deciding which
      // Claude to run. Without it the adapter resolves the build shipped with
      // the Agent SDK it pins, which is not the build that created the session.
      environment: (livePath) => ({ CLAUDE_CODE_EXECUTABLE: livePath }),
    },
    create: (nativeSessionId, instructionFile) => [
      "claude",
      "--session-id",
      nativeSessionId,
      "--system-prompt-file",
      instructionFile,
    ],
    resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
  },
  codex: {
    launcher: "codex",
    identity: "provider-returned",
    resume: (nativeSessionId) => ["codex", "resume", nativeSessionId],
  },
};

/**
 * The adapters this host will consider for native launch at all.
 *
 * A coarse selection and nothing more. For an adapter that names its own
 * sessions the name authorizes no work by itself: what admits one is the
 * compatibility point below, matched against the build actually found and the
 * machine actually running. A name reaches the question; it does not answer it.
 *
 * `codex` is absent. Its command shape is known and its adapter contract tests
 * pass, and neither is the proof: nothing has run it against an installed
 * Codex. A host may still name an adapter itself by passing it through
 * `AcpxProviderDependencies.advertiseNativeLaunch`.
 */
export const ADVERTISED_NATIVE_LAUNCH: readonly string[] = ["claude"];

/**
 * The adapters this host will consider for client-native ACP attachment.
 *
 * A separate list from the one above, because they are separate capabilities:
 * handing a session to a native UI and later joining that same conversation
 * through ACP prove different things. An adapter may have the first without the
 * second. Like that list, this one selects rather than authorizes.
 */
export const ADVERTISED_CLIENT_NATIVE_ATTACHMENT: readonly string[] = ["claude"];

/**
 * What this build's adapters have proved, on the machine a host says it is.
 *
 * The two halves come from where each is known. Which builds were driven
 * through a real CLI is the adapters' own evidence and is compiled in beside
 * them; which OS and architecture are underneath right now is the host's, and
 * arrives here rather than being detected. Neither half admits anything alone —
 * a point is only admitted where a proof and the machine it ran on meet.
 */
export function nativeCapabilityCompatibility(
  host: NativeCapabilityHost,
): NativeCapabilityCompatibility {
  return {
    host,
    points: Object.entries(ADAPTERS).flatMap(([agent, adapter]) =>
      (adapter.proved ?? []).map((proved) => ({ agent, ...proved })),
    ),
  };
}

export function nativeAdapterFor(agentName: string): NativeAdapter | undefined {
  return Object.hasOwn(ADAPTERS, agentName) ? ADAPTERS[agentName] : undefined;
}

/** Every adapter whose command shape this package knows, for diagnostics. */
export function knownNativeAdapters(): string[] {
  return Object.keys(ADAPTERS).sort();
}
