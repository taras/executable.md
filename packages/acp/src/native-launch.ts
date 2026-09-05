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
 * Adapters differ along two structural axes, and both are discriminated rather
 * than inferred. The first is who chooses the provider-native session identity:
 * a `provider-returned` adapter can only resume a session something else
 * created and named, while a `client-allocated` adapter names the session first
 * and hands that name to the native process, which is what lets a launch
 * construct a conversation instead of merely reattaching to one. The second is
 * whether the adapter pins the build behind its executable, and it is
 * independent of the first: a name means one conversation only beside the build
 * that issued or accepted it, whichever side chose the name.
 */

import { randomUUID } from "node:crypto";
import type { IdentityProvenance } from "@executablemd/core";

/**
 * What an adapter knows about the build behind its executable.
 *
 * A provider-native identity only means something while the build behind it can
 * be recognized later: two builds of one provider accept the same identity and
 * disagree silently about what it names, whether XMD chose that identity or the
 * provider issued it. Everything here is
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

/**
 * Codex reports `codex-cli 0.153.2`.
 *
 * The product word is retained with the number for the same reason Claude's
 * whole line is: a bare semver from another tool compares equal. The one-line
 * rule is the same as well, and so is the silence about what did not match.
 */
function codexVersion(output: string): string | undefined {
  const canonical = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^codex-cli \d+\.\d+\.\d+$/.test(line));
  return canonical.length === 1 ? canonical[0] : undefined;
}

/**
 * The one XMD-owned model turn a freshly created conversation needs before the
 * native UI can open it.
 *
 * Declared by the adapter that needs it and by no other, because needing one is
 * a fact about a provider's persistence rather than about launching. An adapter
 * without this member owes no turn, and a launch on it may not take one.
 *
 * The prompt is a constant of this build. It interpolates nothing, carries no
 * authored content, no path, no identity and no environment, and it is the same
 * bytes every time so a reader of a journal can recognize an XMD-owned turn in
 * their own conversation.
 */
export interface MaterializationContract {
  /** Which exact prompt this is — versioned, because the bytes are the contract. */
  readonly promptVersion: string;
  /** The prompt itself, sent as one text block. */
  readonly prompt: string;
}

interface AdapterCommands {
  /** Stable adapter identity — `claude`, `codex`. Never an executable path. */
  launcher: string;
  /** Who chooses this adapter's native session identity. */
  identity: IdentityProvenance;
  /** The argv that resumes this exact provider-native session. */
  resume(nativeSessionId: string): string[];
  /** The turn a session this adapter newly creates owes, when it owes one. */
  materialization?: MaterializationContract;
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

/**
 * A provider-returned adapter whose sessions are pinned to one observed build.
 *
 * The provider still names the session, so nothing here chooses an identity.
 * What the binding adds is the other half of what makes that name mean
 * something: an identity a provider issued is only resumable by the build that
 * issued it, and two builds of one provider accept the same string while
 * disagreeing about which conversation it is.
 *
 * It is a separate type rather than an optional member on the one above,
 * because an adapter a host supplies for a provider that does not pin builds
 * must not be able to reach a binding at all. Narrowing is the only way in.
 */
export interface BoundProviderReturnedAdapter extends ProviderReturnedAdapter {
  binding: NativeBinding;
}

export type NativeAdapter =
  | ProviderReturnedAdapter
  | BoundProviderReturnedAdapter
  | ClientAllocatedAdapter;

/** An adapter whose sessions are bound to the build that accepted them. */
export type BuildBoundAdapter = BoundProviderReturnedAdapter | ClientAllocatedAdapter;

/** Whether this adapter names its own sessions. */
export function allocatesIdentity(adapter: NativeAdapter): adapter is ClientAllocatedAdapter {
  return adapter.identity === "client-allocated";
}

/**
 * Whether this adapter's sessions are bound to one observed executable build.
 *
 * Independent of who names the session: `claude` allocates its identities and
 * `codex` is handed them, and both are meaningless beside a build this run
 * cannot recognize. An adapter without a binding keeps the released
 * native-only behavior — it observes nothing and gains nothing.
 */
export function bindsBuild(adapter: NativeAdapter): adapter is BuildBoundAdapter {
  return "binding" in adapter;
}

const ADAPTERS: Readonly<Record<string, NativeAdapter>> = {
  claude: {
    launcher: "claude",
    // XMD names the session before Claude exists, so the native process is
    // told which conversation to make rather than reporting one afterwards.
    identity: "client-allocated",
    // Claude takes a UUID it has never seen and makes it the session's name.
    allocate: () => randomUUID(),
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
    // Codex creates the conversation through ACP and reports what it is called.
    // XMD supplies nothing here and accepts only that assertion.
    identity: "provider-returned",
    binding: {
      command: "codex",
      version: codexVersion,
      // No `adapterCommand`: the host registry already resolves `codex` to the
      // vendored patched adapter this build carries, and a command pinned here
      // would replace that exact snapshot with whatever a fetch produced.
      //
      // The first thing the Codex ACP adapter consults when deciding which
      // Codex to run, so the build that creates the session through ACP is the
      // build the native UI then resumes it with.
      environment: (livePath) => ({ CODEX_PATH: livePath }),
    },
    // The App Server writes a thread's rollout at its first turn, and `codex
    // resume <id>` reads rollouts — so a thread ACP created and nothing has
    // spoken in is refused by name. One turn closes exactly that gap and
    // nothing else, which is why the prompt asks for an acknowledgement and
    // forbids the work the session was prepared for.
    materialization: {
      promptVersion: "codex-materialization.v1",
      prompt:
        "This turn only makes the Codex conversation resumable. Do not perform the prepared " +
        "task, inspect or modify files, call tools, or take any external action. Reply with a " +
        "brief acknowledgement only.",
    },
    resume: (nativeSessionId) => ["codex", "resume", nativeSessionId],
  },
};

/**
 * The adapters whose native creation, instruction and resume contracts have
 * been proven against the installed CLI.
 *
 * `claude` is here because `packages/acp/src/ClaudeNativeLaunch.test.md` and
 * `packages/acp/src/ClaudeZeroTurnExit.test.md` ran the production command
 * through the built binary against Claude Code 2.1.241 on macOS arm64 and
 * showed the whole applicable contract: the adapter allocated the identity, the
 * native process created that exact conversation from a private mode-0600 file,
 * the layer governed the first user turn with no bootstrap, and a second
 * independent invocation resumed the same identity — including a session left
 * without a word said in it.
 *
 * `codex` is here because `packages/acp/src/CodexNativeLaunch.test.md` and
 * `packages/acp/src/CodexZeroNativeTurnExit.test.md` ran the production command
 * through the built binary against `codex-cli 0.153.2` on macOS arm64 and showed
 * the same contract, reached differently: Codex allocates the identity and
 * reports it on the response `_meta`, the layer governs the first native user
 * turn, and a second independent invocation reaches that same conversation.
 *
 * Codex costs one model turn to get there. The App Server writes a thread's
 * rollout at its first turn and `codex resume <id>` reads rollouts, so a thread
 * ACP created and nothing has spoken in is refused by name: `session/resume`
 * answers "no rollout found for thread id <id>", and the native UI answers "No
 * saved session found with ID <id>". `codex-materialization.v1` is the one
 * XMD-owned turn that closes exactly that gap, and it runs only for a freshly
 * created conversation. It is not a bootstrap turn: it carries no authored
 * content, and providers that need no materialization keep spending none.
 *
 * A host may still advertise an adapter itself by passing its name through
 * `AcpxProviderDependencies.advertiseNativeLaunch`.
 */
export const ADVERTISED_NATIVE_LAUNCH: readonly string[] = ["claude", "codex"];

/**
 * The adapters whose client-native ACP attachment has been proven against the
 * installed CLI.
 *
 * A separate list from the one above, because they are separate capabilities:
 * handing a session to a native UI and later joining that same conversation
 * through ACP prove different things. An adapter may have the first without the
 * second.
 *
 * `claude` is here because `packages/acp/src/ClaudeNativeToAcp.test.md` ran the
 * production command through the built binary: a native turn carrying a random
 * marker, then a marker-free ACP Prompt that recovered it under the same
 * provider-native identity and the same observed build, and an independent
 * absent identity that refused without taking a turn.
 */
export const ADVERTISED_CLIENT_NATIVE_ATTACHMENT: readonly string[] = ["claude"];

export function nativeAdapterFor(agentName: string): NativeAdapter | undefined {
  return Object.hasOwn(ADAPTERS, agentName) ? ADAPTERS[agentName] : undefined;
}

/** Every adapter whose command shape this package knows, for diagnostics. */
export function knownNativeAdapters(): string[] {
  return Object.keys(ADAPTERS).sort();
}
