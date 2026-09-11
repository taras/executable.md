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
 * One observation answers two separate questions: what this run may do with the
 * executable it is about to spawn, and what to write down once about the build
 * that first accepted an identity. The first is the whole authorization — a
 * capability is a claim about a build, asked fresh every time — and the second
 * is audit evidence that is never asked again. Everything here is that
 * adapter's private dialect — which command to observe, which read-only
 * questions to ask it, how to read the answers, and what the ACP adapter child
 * needs in order to run the same build. None of it reaches a document.
 */
export interface NativeBinding {
  /** The command whose build is observed, admitted and recorded. */
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

/**
 * One option declaration, kept in parts rather than collapsed to a verdict.
 *
 * The parts are what make this a value contract instead of a spelling check.
 * "Takes a value" cannot tell `--session-id <uuid>` from `--session-id <name>`,
 * and a launch that supplied a UUID to the second would be naming a session by
 * something the build does not accept as one. So the placeholder is retained
 * whole, and so is the description an entry uses to say what its value is.
 */
interface OptionDeclaration {
  /** Every spelling this entry declares — `-r` and `--resume` alike. */
  readonly flags: readonly string[];
  /** The declared value with its brackets stripped, absent for a bare flag. */
  readonly placeholder: string | undefined;
  /** Whether the value is required (`<uuid>`) rather than optional (`[value]`). */
  readonly required: boolean;
  /** Everything after the head, whitespace-normalized and lowercased. */
  readonly description: string;
  /** The whole entry, for a spelling this adapter reads inside a description. */
  readonly entry: string;
}

/** Whitespace-insensitive text, for reading prose rather than layout. */
function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * One entry, split into the spellings it declares and the value it takes.
 *
 * An entry's head is its spellings and at most one placeholder; the first token
 * that is neither has begun the description. The placeholder is matched against
 * the rejoined remainder rather than a single token so a value written with
 * spaces inside its brackets is still one value.
 */
function declaredOption(entry: string): OptionDeclaration {
  const tokens = entry.split(" ").filter((token) => token.length > 0);
  const flags: string[] = [];
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const raw = tokens[index] ?? "";
    const token = raw.endsWith(",") ? raw.slice(0, -1) : raw;
    if (!/^-{1,2}[A-Za-z0-9][\w-]*$/.test(token)) {
      break;
    }
    flags.push(token);
  }
  const rest = tokens.slice(index).join(" ");
  const value = /^<([^<>]*)>|^\[([^[\]]*)\]/.exec(rest);
  return {
    flags,
    placeholder: value === null ? undefined : (value[1] ?? value[2]),
    required: value !== null && rest.startsWith("<"),
    description: normalized(value === null ? rest : rest.slice(value[0].length)).toLowerCase(),
    entry,
  };
}

/** A placeholder compared by its letters, so `<session-id>` and `[sessionId]` agree. */
function placeholderName(placeholder: string): string {
  return placeholder.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * The one entry declaring `flag`, or nothing when it is absent or ambiguous.
 *
 * Two entries declaring one spelling is output this adapter cannot read as a
 * single answer, and choosing either would be guessing which one a launch
 * would reach. Both are the same absence of evidence.
 */
function soleDeclaration(
  options: readonly OptionDeclaration[],
  flag: string,
): OptionDeclaration | undefined {
  const matched = options.filter((option) => option.flags.includes(flag));
  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * A line whose whole subject is Claude Code, rather than one beginning with it.
 *
 * A program description line is a name and then a summary of it, so the name
 * ends where the separator starts. `Claude Code compatibility wrapper` does not
 * name Claude Code and describe it — it continues the words into the name of
 * something else, which is exactly what a wrapper is.
 */
const CLAUDE_PRODUCT_LINE = /^Claude Code\s*(?:[-–—:]|$)/;

/** The invocation this build documents for itself, not one it mentions. */
const CLAUDE_USAGE_LINE = /^Usage: claude(?:\s|$)/;

/**
 * Whether this help surface is Claude Code's own.
 *
 * Read from dedicated, unindented lines. Every option entry and every wrapped
 * continuation of one is indented, so a product named inside a description is a
 * mention — `compatible with Claude Code`, or a usage example quoted in prose,
 * says what some other tool interoperates with rather than what this build is.
 */
function declaresClaudeProduct(help: string): boolean {
  let named = false;
  let usage = false;
  for (const line of help.split("\n")) {
    named ||= CLAUDE_PRODUCT_LINE.test(line);
    usage ||= CLAUDE_USAGE_LINE.test(line);
  }
  return named && usage;
}

/**
 * The separately-stated parts of a description.
 *
 * Prose is read one clause at a time because a sentence states one thing and
 * its neighbours are not it. `Resume a conversation by URL; session ID is not
 * supported` contains every word a naive read wants, distributed across two
 * clauses that each deny what the read would conclude.
 */
function clauses(description: string): readonly string[] {
  return description.split(/[;.]/).map((clause) => clause.trim());
}

/** Wording that takes back the clause it appears in. */
const DENIED = /\b(?:not|never|no|cannot|unsupported|instead of|rather than)\b/;

/** A clause that states `stated` and does not then withdraw it. */
function states(description: string, stated: RegExp): boolean {
  return clauses(description).some((clause) => stated.test(clause) && !DENIED.test(clause));
}

/**
 * Whether this build accepts a session identity the caller chose.
 *
 * The value has to be required and has to be a UUID: that is the whole contract
 * a client-allocated identity stands on. An option that will take any name is
 * not one this adapter can hand a UUID to and expect the same session back.
 */
function declaresChosenIdentity(options: readonly OptionDeclaration[]): boolean {
  const declaration = soleDeclaration(options, "--session-id");
  return (
    declaration?.placeholder !== undefined &&
    declaration.required &&
    placeholderName(declaration.placeholder) === "uuid"
  );
}

/** Placeholders that name the identity itself. */
const IDENTITY_VALUE = /^(session|conversation)id$/;

/** Placeholders that commit to nothing, so the entry has to say what it takes. */
const UNCOMMITTED_VALUE = /^(value|arg|argument|id)$/;

/**
 * The one thing an uncommitted resume value may be: what the conversation is
 * named by. Read as a phrase rather than as words that happen to co-occur —
 * `by session ID` says the argument is the identity, where `conversation` and
 * `session ID` scattered through a sentence say only that both were mentioned.
 */
const RESUMED_BY_IDENTITY = /\bby (?:its |the |a )?(?:session|conversation) id\b/;

/**
 * Whether this build resumes the exact conversation an identity names.
 *
 * A placeholder that names the identity answers by itself. A placeholder that
 * names something else — a URL, a path, a title — is a positive statement that
 * the argument is not an identity, and no description overrides it. Only a
 * placeholder committing to nothing is settled by the entry's own words, which
 * is how the shipped `[value]` spelling is read without pinning its prose.
 */
function declaresIdentityResume(options: readonly OptionDeclaration[]): boolean {
  const declaration = soleDeclaration(options, "--resume");
  if (declaration?.placeholder === undefined) {
    return false;
  }
  const value = placeholderName(declaration.placeholder);
  if (IDENTITY_VALUE.test(value)) {
    return true;
  }
  if (!UNCOMMITTED_VALUE.test(value)) {
    return false;
  }
  return states(declaration.description, RESUMED_BY_IDENTITY);
}

/** A placeholder naming a file on disk, compared by its letters. */
const FILE_VALUE = /^(?:file|filename|filepath|path)$/;

/**
 * Whether the instruction layer can be handed over as a private file.
 *
 * The argument itself has to be the file. A description is where a build
 * explains its value, not where it changes it: `--system-prompt-file <text>`
 * takes the prompt inline whatever its prose goes on to mention about paths.
 *
 * Two accepted spellings, because Claude documents the family rather than the
 * member: builds that give `--system-prompt-file` no entry of its own name it
 * as `--system-prompt[-file]` inside another option's description. That is a
 * declaration this executable makes about itself, so it is read from a parsed
 * entry — never from a header, a command list, a footer, or free prose, where
 * the same characters say only that someone wrote them.
 */
function declaresPrivateInstructionFile(options: readonly OptionDeclaration[]): boolean {
  const declaration = soleDeclaration(options, "--system-prompt-file");
  if (
    declaration?.placeholder !== undefined &&
    FILE_VALUE.test(placeholderName(declaration.placeholder))
  ) {
    return true;
  }
  return options.some((option) => states(option.entry.toLowerCase(), /--system-prompt\[-file]/));
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
 * Each member is a value contract, not a flag spelling. A launch supplies a
 * UUID it chose, names that exact conversation again later, and hands over
 * instructions as a private file — so what is read is the value each option
 * says it takes. A build offering `--session-id <name>` or `--resume <url>`
 * accepts the spelling and means something else by it, and admitting it would
 * be reading agreement out of a coincidence of names.
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
    const options = optionEntries(help).map(declaredOption);
    const product = declaresClaudeProduct(help);
    const identity = declaresChosenIdentity(options);
    const resume = declaresIdentityResume(options);
    const privateFile = declaresPrivateInstructionFile(options);

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
 * what names the build.
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

const CODEX_PROBE_PROFILE = "codex-help-native-session.v1";
const CODEX_PROVIDER_PROTOCOL = "codex-provider-returned.v1";

function helpSection(help: string, heading: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of help.split("\n")) {
    if (/^\S.*:$/.test(line)) {
      inside = line === `${heading}:`;
    } else if (inside) {
      lines.push(line);
    }
  }
  return lines;
}

interface PositionalDeclaration {
  readonly name: string;
  readonly optional: boolean;
  description: string;
}

function positionalDeclarations(help: string): PositionalDeclaration[] {
  const positions: PositionalDeclaration[] = [];
  let current: PositionalDeclaration | undefined;
  for (const line of helpSection(help, "Arguments")) {
    const head = /^ {2}(?:\[([^\[\]]+)\]|<([^<>]+)>)(?:\s+(.*))?$/.exec(line);
    if (head) {
      current = {
        name: head[1] ?? head[2],
        optional: head[1] !== undefined,
        description: normalized(head[3] ?? "").toLowerCase(),
      };
      positions.push(current);
    } else if (current && /^ {3,}\S/.test(line)) {
      current.description += ` ${normalized(line).toLowerCase()}`;
    } else if (line.trim().length > 0) {
      return [];
    }
  }
  return positions;
}

function usageDeclarations(help: string): string[] {
  const entries: string[] = [];
  let inside = false;
  for (const line of help.split("\n")) {
    if (/^Usage:/.test(line)) {
      entries.push(normalized(line));
      inside = true;
    } else if (inside && /^ {3,}[[<]/.test(line)) {
      entries[entries.length - 1] += ` ${normalized(line)}`;
    } else {
      inside = false;
    }
  }
  return entries;
}

function declaresCodexResume(root: string, resume: string): boolean {
  const product = root.split("\n").some((line) => /^Codex CLI\s*(?:[-–—:]|$)/.test(line));
  const rootUsage = root.split("\n").some((line) => /^Usage: codex(?:\s|$)/.test(line));
  const commands = helpSection(root, "Commands").filter((line) => /^ {2}resume(?:\s|$)/.test(line));
  const usages = usageDeclarations(resume);
  const usage =
    usages.length === 1
      ? /^Usage: codex resume \[OPTIONS\] \[SESSION_ID\](?: \[PROMPT\])?$/.exec(
          normalized(usages[0]),
        )
      : null;
  const positions = positionalDeclarations(resume);
  const identity = positions[0];
  const optionalPrompt =
    positions.length === 1 ||
    (positions.length === 2 && positions[1].name === "PROMPT" && positions[1].optional);
  const uuidIdentity =
    identity !== undefined &&
    states(
      identity.description,
      /\b(?:session|conversation) (?:id|identity|identifier)\s*\(\s*uuid\s*\)/,
    );
  return (
    product &&
    rootUsage &&
    commands.length === 1 &&
    usage !== null &&
    identity?.name === "SESSION_ID" &&
    identity.optional &&
    optionalPrompt &&
    uuidIdentity
  );
}

function codexNativeProbe(pinnedBridgeProtocol: string | undefined): NativeCapabilityProbe {
  return (metadata) => {
    const capabilities: NativeCapability[] = [];
    const root = answered(metadata, "help");
    const resume = answered(metadata, "resume-help");
    if (root !== undefined && resume !== undefined && declaresCodexResume(root, resume)) {
      capabilities.push("native-launch");
      // This assertion belongs to the compiled vendored bridge contract. An
      // executable declaration alone cannot confer ACP continuation.
      if (pinnedBridgeProtocol === CODEX_PROVIDER_PROTOCOL) {
        capabilities.push("provider-native-continuation");
      }
    }
    return { probeProfile: CODEX_PROBE_PROFILE, capabilities };
  };
}

function codexReportedVersion(metadata: ExecutableMetadata): string | undefined {
  const output = answered(metadata, "version");
  if (output === undefined) {
    return undefined;
  }
  const canonical = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^codex-cli \d+\.\d+\.\d+$/.test(line));
  return canonical.length === 1 ? canonical[0] : undefined;
}

export interface MaterializationContract {
  readonly promptVersion: string;
  readonly prompt: string;
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
  materialization?: MaterializationContract;
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
   * How this adapter's executable is observed, admitted and recorded.
   *
   * Required, because an adapter that names its own sessions may not act on one
   * until the build it would run has been admitted for what it is about to do.
   * The argv `create` and `resume` return still begins with the stable launcher
   * name, which is what durable records carry; a run replaces that first member
   * with the exact path it observed.
   */
  binding: NativeBinding;
}

export interface ProviderReturnedAdapter extends AdapterCommands {
  identity: "provider-returned";
}

export interface BoundProviderReturnedAdapter extends ProviderReturnedAdapter {
  binding: NativeBinding;
}

export type BuildBoundAdapter = BoundProviderReturnedAdapter | ClientAllocatedAdapter;
export type NativeAdapter = ProviderReturnedAdapter | BuildBoundAdapter;

/** Whether this adapter names its own sessions. */
export function allocatesIdentity(adapter: NativeAdapter): adapter is ClientAllocatedAdapter {
  return adapter.identity === "client-allocated";
}

export function bindsBuild(adapter: NativeAdapter): adapter is BuildBoundAdapter {
  return "binding" in adapter;
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

const CODEX_PROVED_HOST = {
  probeProfile: CODEX_PROBE_PROFILE,
  platform: "darwin",
  architecture: "arm64",
};

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
    protocol: CODEX_PROVIDER_PROTOCOL,
    identity: "provider-returned",
    proved: [
      { capability: "native-launch", ...CODEX_PROVED_HOST },
      { capability: "provider-native-continuation", ...CODEX_PROVED_HOST },
    ],
    binding: {
      command: "codex",
      metadata: [
        { name: "help", args: ["--help"] },
        { name: "resume-help", args: ["resume", "--help"] },
        { name: "version", args: ["--version"] },
      ],
      probe: codexNativeProbe(CODEX_PROVIDER_PROTOCOL),
      reportedVersion: codexReportedVersion,
      // The host registry supplies the vendored bridge. Replacing its command
      // here would bypass the snapshot whose identity contract is proved.
      environment: (livePath) => ({ CODEX_PATH: livePath }),
    },
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
 * The stable protocol each published client-native route contract fixes.
 *
 * Written here, compiled in, and reachable through no dependency a host can
 * supply — because it is the one thing about a route that a later installation
 * may not answer. Everything else on the live side is discovered: which adapter
 * is registered, which executable is found, what it declares. If the protocol
 * were discovered too, then registering an adapter under the same launcher name
 * would be enough to adopt a conversation constructed by something else, and a
 * host policy that admitted the newcomer's own protocol would call that proved.
 *
 * Keyed by the launcher because that is the durable member of the contract that
 * names an implementation. A route's provider says which provider published it
 * and its agent is the command it is filed under; those are matched by the
 * caller that read the record, and this answers the remaining question of what
 * the thing behind that launcher was speaking at the time.
 *
 * An absent entry is a refusal, not a default. There is no protocol migration:
 * a different protocol needs a route contract that names it, so a launcher this
 * build has fixed no protocol for is one whose sessions it cannot continue.
 */
const ROUTE_PROTOCOLS: Readonly<Record<string, string>> = {
  claude: "claude-client-native.v1",
};

/** The protocol a client-native route naming `launcher` was published under. */
export function pinnedRouteProtocol(launcher: string): string | undefined {
  return Object.hasOwn(ROUTE_PROTOCOLS, launcher) ? ROUTE_PROTOCOLS[launcher] : undefined;
}

/** V3 has one compiled interpretation, independent of a registered adapter. */
export function pinnedProviderRouteProtocol(launcher: string): string | undefined {
  return launcher === "codex" ? CODEX_PROVIDER_PROTOCOL : undefined;
}

/**
 * The adapters this host will consider for native launch at all.
 *
 * A coarse selection and nothing more. For an adapter that names its own
 * sessions the name authorizes no work by itself: what admits one is the
 * admission below, matched against the protocol resolved, the shape its own
 * probe recognized in the executable actually found, and the machine actually
 * running. A name reaches the question; it does not answer it.
 *
 * Codex's provider-returned proof used codex-cli 0.153.2 on macOS arm64. That
 * release identifies the evidence; each current executable still has to pass
 * the live protocol, shape, capability and host admission independently.
 */
export const ADVERTISED_NATIVE_LAUNCH: readonly string[] = ["claude", "codex"];

/**
 * The adapters this host will consider for client-native ACP attachment.
 *
 * A separate list from the one above, because they are separate capabilities:
 * handing a session to a native UI and later joining that same conversation
 * through ACP prove different things. An adapter may have the first without the
 * second. Like that list, this one selects rather than authorizes.
 */
export const ADVERTISED_CLIENT_NATIVE_ATTACHMENT: readonly string[] = ["claude"];

export const ADVERTISED_PROVIDER_NATIVE_CONTINUATION: readonly string[] = ["codex"];

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
