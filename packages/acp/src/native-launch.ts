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

export interface NativeAdapter {
  /** Stable adapter identity — `claude`, `codex`. Never an executable path. */
  launcher: string;
  /** The argv that resumes this exact provider-native session. */
  resume(nativeSessionId: string): string[];
}

const ADAPTERS: Readonly<Record<string, NativeAdapter>> = {
  claude: {
    launcher: "claude",
    resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
  },
  codex: {
    launcher: "codex",
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
