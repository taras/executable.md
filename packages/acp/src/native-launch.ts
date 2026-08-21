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
 * Advertisement is separate and deliberately empty by default: an adapter is
 * advertised only once an integration test has proven, against the installed
 * CLI, that the session ACP created is the session the native UI resumes and
 * that the prepared instruction layer is in force on its first user turn.
 * Until then `<Session.Launch>` refuses that agent before releasing its ACP
 * session, which is the failure the contract asks for rather than a hopeful
 * spawn.
 */

import type { IdentityProvenance } from "@executablemd/core";

/**
 * What an adapter needs in order to bind one executable build to a session it
 * names itself.
 *
 * An adapter that declares this creates sessions natively under an identity
 * XMD allocated, which only stays meaningful while the exact build that
 * created them can be reproduced. Everything here is that adapter's private
 * dialect: which command it runs, what its version output looks like, the
 * arguments that create and resume, and the environment the ACP adapter needs
 * in order to run the same build. None of it reaches a document.
 */
export interface NativeBinding {
  /** The command whose build is observed, bound and retained. */
  command: string;
  /**
   * The exact ACP adapter command this binding was proven against.
   *
   * ACPX resolves adapters through a semver range of its own — `^0.37.0` for
   * Claude — which is free to select a different adapter tomorrow than the one
   * an integration proof ran against. A capability that depends on how an
   * adapter handles resume identity cannot be left to that range: the proof
   * would describe a version nobody runs.
   */
  adapterCommand: string;
  /**
   * The canonical version from `--version` output, or `undefined` when the
   * output is not something this adapter recognizes. An unrecognized version
   * is a refusal, not a value to retain — a build XMD cannot name is one it
   * cannot later confirm.
   */
  version(output: string): string | undefined;
  /** Arguments after the executable that create a session under `id`. */
  create(nativeSessionId: string, instructionFile: string): string[];
  /** Arguments after the executable that resume `id`. */
  resume(nativeSessionId: string): string[];
  /**
   * The environment the ACP adapter child needs to run this exact build.
   *
   * Transient by construction: it is handed to the runtime for the children it
   * spawns, and never persisted, exported, or written into a session record.
   */
  environment(livePath: string): Record<string, string>;
}

export interface NativeAdapter {
  /** Stable adapter identity — `claude`, `codex`. Never an executable path. */
  launcher: string;
  /** Who chooses this adapter's native session identity. */
  identity: IdentityProvenance;
  /** The argv that resumes this exact provider-native session. */
  resume(nativeSessionId: string): string[];
  /** Present exactly when this adapter binds one executable build. */
  binding?: NativeBinding;
}

/**
 * Claude reports `2.1.235 (Claude Code)`.
 *
 * The whole line is retained rather than the number alone, because the number
 * alone is not a build: the same version string from a different product would
 * compare equal. Anything that does not look like this is unrecognized, and an
 * unrecognized build is refused rather than retained under a guess.
 */
function claudeVersion(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const candidate = line.trim();
    if (/^\d+\.\d+\.\d+ \(Claude Code\)$/.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const ADAPTERS: Readonly<Record<string, NativeAdapter>> = {
  claude: {
    launcher: "claude",
    // XMD allocates the identity before Claude exists, so the native UI and a
    // later ACP attachment can name one conversation. See #519.
    identity: "client-allocated",
    resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
    binding: {
      command: "claude",
      // The version #519's gates were proven against. Raising it is a new
      // proof, not a version bump.
      adapterCommand: "npx -y @agentclientprotocol/claude-agent-acp@0.70.0",
      version: claudeVersion,
      create: (nativeSessionId, instructionFile) => [
        "--session-id",
        nativeSessionId,
        "--system-prompt-file",
        instructionFile,
      ],
      resume: (nativeSessionId) => ["--resume", nativeSessionId],
      // The first thing the Claude ACP adapter consults when deciding which
      // Claude to run. Without it the adapter resolves the build shipped with
      // the Agent SDK it pins, which is not the build that created the
      // session.
      environment: (livePath) => ({ CLAUDE_CODE_EXECUTABLE: livePath }),
    },
  },
  codex: {
    launcher: "codex",
    identity: "provider-returned",
    resume: (nativeSessionId) => ["codex", "resume", nativeSessionId],
  },
};

/**
 * The adapters whose native resume and instruction contracts have been proven
 * against the installed CLI.
 *
 * Empty on `main`. A host that has run the opt-in integration proof for an
 * adapter passes its name through `AcpxProviderDependencies.advertiseNativeLaunch`.
 */
export const ADVERTISED_NATIVE_LAUNCH: readonly string[] = [];

export function nativeAdapterFor(agentName: string): NativeAdapter | undefined {
  return Object.hasOwn(ADAPTERS, agentName) ? ADAPTERS[agentName] : undefined;
}

/** Every adapter whose command shape this package knows, for diagnostics. */
export function knownNativeAdapters(): string[] {
  return Object.keys(ADAPTERS).sort();
}

/**
 * The ACP adapter command each bound agent must run, by agent name.
 *
 * Only bound adapters appear. An agent whose identity the provider returns has
 * no proof tied to one adapter version, so it keeps ACPX's own resolution.
 */
export function pinnedAdapterCommands(
  extra: Readonly<Record<string, NativeAdapter>> = {},
): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const [agent, adapter] of [...Object.entries(ADAPTERS), ...Object.entries(extra)]) {
    if (adapter.binding) {
      pinned[agent] = adapter.binding.adapterCommand;
    }
  }
  return pinned;
}
