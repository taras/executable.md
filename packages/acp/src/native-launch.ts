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
import type { ExecutableMetadata, ExecutableMetadataQuery } from "@executablemd/runtime";
import type {
  NativeCapability,
  NativeCapabilityHost,
  NativeCapabilityPolicy,
  ProvedNativeCapability,
} from "./native-capability.ts";

/**
 * What one adapter's probe recognized in the executable that was just hashed.
 *
 * The profile travels with the answer rather than being assumed by the caller,
 * because it is what an admission is matched against: a probe that recognized a
 * different shape than the one a proof ran on must not be read as the proved
 * one. An empty capability list is the ordinary answer for an executable this
 * probe does not recognize — the shape was looked for and was not there.
 */
export interface ProbedNativeCapabilities {
  readonly probeProfile: string;
  readonly capabilities: readonly NativeCapability[];
}

/**
 * An adapter's own reading of its executable's read-only declarations.
 *
 * Adapter-owned because only the adapter knows which declarations it consumes.
 * Structural rather than a snapshot: it inspects the shapes this adapter's argv
 * depends on, so added options, unrelated prose and rewrapped lines mean
 * nothing and a missing or renamed one means everything.
 */
export type NativeCapabilityProbe = (metadata: ExecutableMetadata) => ProbedNativeCapabilities;

/**
 * What an adapter knows about the build behind its executable.
 *
 * A session whose identity XMD chose only means something while the build that
 * accepted it can be recognized later: two builds of one provider accept the
 * same identity and disagree silently about what it names. Everything here is
 * that adapter's private dialect — which command to observe, which read-only
 * questions to ask it, how to read the answers, and what the ACP adapter child
 * needs in order to run the same build. None of it reaches a document.
 */
export interface NativeBinding {
  /** The command whose build is observed, bound and retained. */
  command: string;
  /**
   * The read-only questions one observation asks that exact file.
   *
   * Declared here so the host's observer runs argv it was handed rather than
   * argv it invented. A question that did anything but report would be a side
   * effect on a session nobody has decided to act on yet.
   */
  metadata: readonly ExecutableMetadataQuery[];
  /** What those answers say this build can do. */
  probe: NativeCapabilityProbe;
  /**
   * The canonical version those answers report, or `undefined` when they report
   * none this adapter recognizes.
   *
   * Optional evidence, deliberately: a version says which release is installed,
   * not what it can do. A build that will not say, says something unexpected, or
   * says several things is bound by its digest alone rather than refused.
   */
  reportedVersion(metadata: ExecutableMetadata): string | undefined;
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
 * The output one query produced, or nothing when it did not answer.
 *
 * A query that failed to start, failed to settle, or settled nonzero reported
 * nothing about the shape it was asked about. Reading its output anyway would
 * let a crashing executable look like one missing an option.
 */
function answered(metadata: ExecutableMetadata, name: string): string | undefined {
  const observation = metadata[name];
  if (observation === undefined || !observation.settled || observation.code !== 0) {
    return undefined;
  }
  return observation.stdout;
}

/**
 * The option declarations in a help surface, one entry per option, rewrapped.
 *
 * Claude's help is Commander's: an option entry begins at exactly two spaces
 * and a dash, and its description wraps onto more deeply indented lines. Those
 * continuations are rejoined so a declaration that happened to wrap reads the
 * same as one that did not — which is the difference between a structural
 * reading and a snapshot of one terminal width.
 *
 * Everything else is dropped, and that is the point: `Arguments:`, `Commands:`
 * and free prose are not declarations. An option named inside another option's
 * description is a mention, not a thing this executable accepts.
 */
function optionEntries(help: string): string[] {
  const entries: string[] = [];
  let open = false;
  for (const line of help.split("\n")) {
    if (/^ {2}-/.test(line)) {
      entries.push(line.trim());
      open = true;
      continue;
    }
    if (open && /^ {3,}\S/.test(line)) {
      entries[entries.length - 1] += ` ${line.trim()}`;
      continue;
    }
    open = false;
  }
  return entries;
}

/** What one option entry declares: its spellings, and whether it takes a value. */
function declaredFlags(entry: string): { flags: string[]; takesValue: boolean } {
  const flags: string[] = [];
  for (const raw of entry.split(" ")) {
    const token = raw.endsWith(",") ? raw.slice(0, -1) : raw;
    if (/^-{1,2}[A-Za-z0-9][\w-]*$/.test(token)) {
      flags.push(token);
      continue;
    }
    // The head of an entry is its spellings and at most one value placeholder.
    // Anything else has begun the description, and a description is prose.
    return { flags, takesValue: token.startsWith("<") || token.startsWith("[") };
  }
  return { flags, takesValue: false };
}

/**
 * How this executable declares one option, if it declares it at all.
 *
 * `ambiguous` is separate from `absent` on purpose. Two entries declaring one
 * spelling is output this adapter cannot read as a single answer, and choosing
 * either would be guessing which one a launch would reach.
 */
function declaresOption(
  entries: string[],
  flag: string,
): "absent" | "ambiguous" | "flag" | "valued" {
  const matched = entries
    .map(declaredFlags)
    .filter((declaration) => declaration.flags.includes(flag));
  if (matched.length === 0) {
    return "absent";
  }
  if (matched.length > 1) {
    return "ambiguous";
  }
  return matched[0].takesValue ? "valued" : "flag";
}

/** Whitespace-insensitive text, for reading prose rather than layout. */
function normalized(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * The ACP adapter Claude's attachment proof ran against.
 *
 * Named once and used twice — pinned for the child that actually runs, and an
 * input to the probe that decides whether attachment was observed — so the
 * capability cannot be answered for a bridge nobody proved.
 */
const CLAUDE_ACP_BRIDGE = "npx -y @agentclientprotocol/claude-agent-acp@0.70.0";

/** The probe whose recognized shape Claude's admissions were proved against. */
const CLAUDE_PROBE_PROFILE = "claude-help-native-session.v1";

/**
 * What Claude's own help declares about the operations a launch needs.
 *
 * Structural rather than a version comparison: what matters is whether this
 * build accepts a caller-chosen session identity, resumes one exactly, and
 * takes its private instruction layer as a file. A release that adds options,
 * rewords prose or rewraps lines still declares those, and a release that
 * stopped declaring one cannot launch whatever it calls itself.
 *
 * The private-file member has two accepted spellings because Claude declares
 * the family rather than the member: `--system-prompt-file` appears as the
 * documented `--system-prompt[-file]` spelling in builds that do not give it
 * its own entry. Both are the same declaration, and neither is inferred from
 * the other's absence.
 *
 * The two capabilities are read independently from what is present, never one
 * from the other: attachment additionally needs the bridge this adapter pins,
 * which is knowledge about the ACP child rather than about the CLI.
 */
function claudeNativeProbe(pinnedBridge: string | undefined): NativeCapabilityProbe {
  return (metadata) => {
    const capabilities: NativeCapability[] = [];
    const help = answered(metadata, "help");
    if (help === undefined) {
      return { probeProfile: CLAUDE_PROBE_PROFILE, capabilities };
    }
    const text = normalized(help);
    const entries = optionEntries(help);
    const product = text.includes("Claude Code") && /(^| )Usage: claude( |$)/.test(text);
    const identity = declaresOption(entries, "--session-id") === "valued";
    const resume = declaresOption(entries, "--resume") === "valued";
    const privateFile =
      declaresOption(entries, "--system-prompt-file") === "valued" ||
      text.includes("--system-prompt[-file]");

    if (product && identity && resume && privateFile) {
      capabilities.push("native-launch");
    }
    if (product && resume && pinnedBridge === CLAUDE_ACP_BRIDGE) {
      capabilities.push("client-native-attachment");
    }
    return { probeProfile: CLAUDE_PROBE_PROFILE, capabilities };
  };
}

/**
 * Claude reports `2.1.241 (Claude Code)`.
 *
 * The whole line is retained rather than the number alone, because the number
 * alone is not a build: the same version string from a different product would
 * compare equal.
 *
 * Exactly one line may match. Zero is output this adapter does not recognize;
 * two or more is output it cannot read as one answer, and taking the first
 * would be picking a build out of a list of them. Both mean no version was
 * reported, which is an ordinary answer rather than a refusal — the digest is
 * what binds the build.
 */
function claudeReportedVersion(metadata: ExecutableMetadata): string | undefined {
  const output = answered(metadata, "version");
  if (output === undefined) {
    return undefined;
  }
  const canonical = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(line));
  return canonical.length === 1 ? canonical[0] : undefined;
}

interface AdapterCommands {
  /** Stable adapter identity — `claude`, `codex`. Never an executable path. */
  launcher: string;
  /**
   * The protocol this adapter speaks, as an admission names it.
   *
   * Distinct from both the Agent registry name and the launcher command, and
   * versioned, because either of those can be pointed at something else while
   * neither says what the thing behind it speaks. Changing what this adapter
   * does to a session is a new protocol identifier, not an edit to this one.
   */
  protocol: string;
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
 * The one shape and machine Claude's proofs ran on.
 *
 * Written once and shared by both points below so they cannot drift apart into
 * two claims about two things. Raising either is a new proof rather than an
 * edit here: what makes this admissible is that a real CLI was driven through
 * the whole applicable contract on exactly this, and nothing about that
 * generalizes to another machine or another way of recognizing the shape.
 *
 * No version appears. A version says which release was installed, not what it
 * can do, and admitting one would disable every new session on a routine
 * upgrade while telling nobody why.
 */
const CLAUDE_PROVED_BUILD = {
  probeProfile: CLAUDE_PROBE_PROFILE,
  platform: "darwin",
  architecture: "arm64",
} as const;

const ADAPTERS: Readonly<Record<string, NativeAdapter>> = {
  claude: {
    launcher: "claude",
    protocol: "claude-client-native.v1",
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
      // Read-only by construction: both report and exit, and neither carries a
      // session, an instruction, or anything else a launch would act on.
      metadata: [
        { name: "help", args: ["--help"] },
        { name: "version", args: ["--version"] },
      ],
      probe: claudeNativeProbe(CLAUDE_ACP_BRIDGE),
      reportedVersion: claudeReportedVersion,
      // The bridge #561's attachment gate is proven against. Raising it is a
      // new proof, not a version bump.
      adapterCommand: CLAUDE_ACP_BRIDGE,
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
    protocol: "codex-provider-returned.v1",
    identity: "provider-returned",
    resume: (nativeSessionId) => ["codex", "resume", nativeSessionId],
  },
};

/**
 * The adapters this host will consider for native launch at all.
 *
 * A coarse selection and nothing more. For an adapter that names its own
 * sessions the name authorizes no work by itself: what admits one is the
 * admission below, matched against the protocol resolved, the shape its own
 * probe recognized in the executable actually found, and the machine actually
 * running. A name reaches the question; it does not answer it.
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
 * The two halves come from where each is known. Which protocols and shapes were
 * driven through a real CLI is the adapters' own evidence and is compiled in
 * beside them; which OS and architecture are underneath right now is the host's,
 * and arrives here rather than being detected. Neither half admits anything
 * alone — an admission stands only where a proof and the machine it ran on meet.
 *
 * Keyed by each adapter's protocol rather than by the Agent name it happens to
 * be registered under, because the Agent name is what a document can point
 * somewhere else.
 */
export function nativeCapabilityPolicy(host: NativeCapabilityHost): NativeCapabilityPolicy {
  return {
    host,
    admissions: Object.values(ADAPTERS).flatMap((adapter) =>
      (adapter.proved ?? []).map((proved) => ({ adapterProtocol: adapter.protocol, ...proved })),
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
