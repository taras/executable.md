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

interface AdapterCommands {
  /** Stable adapter identity — `claude`, `codex`. Never an executable path. */
  launcher: string;
  /** Who chooses this adapter's native session identity. */
  identity: IdentityProvenance;
  /** The argv that resumes this exact provider-native session. */
  resume(nativeSessionId: string): string[];
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
}

export interface ProviderReturnedAdapter extends AdapterCommands {
  identity: "provider-returned";
}

export type NativeAdapter = ProviderReturnedAdapter | ClientAllocatedAdapter;

/** Whether this adapter names its own sessions. */
export function allocatesIdentity(adapter: NativeAdapter): adapter is ClientAllocatedAdapter {
  return adapter.identity === "client-allocated";
}

const ADAPTERS: Readonly<Record<string, NativeAdapter>> = {
  claude: {
    launcher: "claude",
    // XMD names the session before Claude exists, so the native process is
    // told which conversation to make rather than reporting one afterwards.
    identity: "client-allocated",
    // Claude takes a UUID it has never seen and makes it the session's name.
    allocate: () => randomUUID(),
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
