/**
 * The authorship profile — the trusted-host assembly the plan command document
 * runs under, and the only thing that ever runs under it
 * (specs/plan-command-spec.md).
 *
 * `xmd plan` executes this root on every invocation, and a second one — the
 * Plan it returns — only under `--run`, behind a complete scope boundary. This
 * module is the one that always happens. It supplies that document's inputs, a
 * constrained Agent provider, Elicitation, the fixed first-party components and
 * the host-declared draft checker, and it exposes no custom root and no
 * repository component search: the document it runs is the one the CLI ships.
 *
 * The Agent context is assembled here rather than read from the command line,
 * because it is not the caller's to choose. Writing a Plan is a conversation
 * about text; it never lets an agent touch anything. So the provider gets a
 * host-owned directory dedicated to this logical session — created empty, and
 * required to be empty before anything is built — no additional directories, no
 * MCP servers, an empty native-tool allowlist and a private strict denial of
 * every native
 * permission request — one that answers inside the provider and consults no
 * authored approval scope, so nothing composed around it can widen a policy
 * with nothing in it. `--approve-all`, `--approve-reads` and `--deny-all`
 * configure the approved document, later, and reach none of this.
 *
 * The document itself is given no Files, command, service or XMD-mediated
 * network capability either. It decides what to write; it writes nothing.
 */

import { ensure, Err, Ok, scoped, until, useScope } from "effection";
import type { Operation, Result, Scope } from "effection";
import { createHash } from "node:crypto";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  agentIdentityComponents,
  collect,
  installAgentComponents,
  installPermissionMode,
  installPromptFailurePolicy,
  registerAgentProvider,
  retainedSource,
} from "@executablemd/core";
import type { AgentProviderOptions, Json } from "@executablemd/core";
import type { DeclaredMarkdownComponent } from "@executablemd/core/host";
import { executeInstalled, installInvocationAgentProvider } from "@executablemd/core/host";
import { createAcpxProvider } from "@executablemd/acp";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { FormOpener } from "@executablemd/web";

import { hostAcpDependencies } from "./agent-stack.ts";
import type { AgentStack } from "./agent-stack.ts";
import { PLAN_COMMAND_DOCUMENT, readPackagedDocument } from "./packaged-document.ts";

/**
 * The identity the plan command document runs under.
 *
 * Stable and internal: no path selects it, no include resolves it, and a
 * position reading `(<plan-command>:12:1)` says the source is the CLI's own.
 */
export const PLAN_COMMAND_IDENTITY = "<plan-command>";

/**
 * The permission mode the plan command document runs under.
 *
 * Fixed rather than configured. The provider denies native requests privately,
 * so this is what an authored approval scope inside that document would
 * compose around if one existed — and the honest answer for a profile that
 * grants no native authority is the one that grants none.
 */
const AUTHORSHIP_PERMISSION_MODE = "deny-all";

/** The closed answer the host gives about one candidate. */
export interface CandidateAssessment {
  valid: boolean;
  /** Empty when valid; the complete structured findings when not. */
  diagnostics: Json;
}

/** What the host supplies to one plan command document execution. */
export interface AuthorshipProfile {
  /** The request as the person typed it. */
  request: string;
  /** The rendered syntax catalog for this run profile and these includes. */
  syntax: string;
  /** The logical name every turn in this invocation belongs to. */
  session: string;
  /**
   * Whether the caller named that session.
   *
   * A trusted host value rather than something read back out of the name: only
   * the host knows whether `--session` was written, and the difference decides
   * whether this conversation's directory outlives the invocation. It reaches
   * the command document nowhere.
   */
  explicitSession: boolean;
  /**
   * Where this host keeps its profile session directories.
   *
   * A host dependency, not a caller's: no flag, environment variable, document
   * prop or replaceable context reaches it. Production leaves it at the default
   * below; a harness that owns a temporary tree supplies that tree instead, so a
   * test never reads, creates or removes anything under a real one.
   */
  root: string;
  /** The Agent context this host can give a Plan, or why it can give none. */
  context: Result<PlanAuthorship>;
  /** Who answers the review question. */
  installElicitation(): Operation<void>;
  /**
   * The `<Plan>` declaration this command runs under.
   *
   * Built by the command, from the packaged Component's bytes, before the adapter
   * root is imported. It carries the sealed surface, the precomputed catalog and
   * the Agent context this invocation settled — none of which is a prop the adapter
   * could supply or a document could reach.
   */
  declaration: DeclaredMarkdownComponent;
  /**
   * The host's assessment of one candidate.
   *
   * A candidate-authored failure comes back as `valid: false` and is repairable.
   * A caller-source failure raises, which ends that execution: the document
   * has no way to catch it and no way to recategorize it as feedback
   * for an agent that could not have caused it.
   */
  assess(source: string): Operation<CandidateAssessment>;
}

/** What building the constrained provider needs, and nothing more. */
export interface AuthorshipProviderInputs {
  readonly stack: AgentStack;
  readonly acp?: AcpxProviderDependencies;
}

/**
 * The trusted host's ability to give one Plan invocation an Agent.
 *
 * A closure the host supplies before any Plan invocation exists, and the only
 * thing that decides whether a Plan can be written here. It is never a prop, a
 * Context value, a registration result or anything a document, component or
 * middleware can reach or replace — which is what keeps "who may write a Plan"
 * a question about the host rather than about what a document arranged.
 *
 * Availability is all it decides. What the Plan then runs under — the permission
 * mode, the prompt-failure policy, the capability refusals and the session
 * directory — is {@link installAuthorshipFrame}'s fixed policy, identical for
 * every provider, so a second implementation cannot quietly bring a weaker one.
 */
export interface PlanAuthorship {
  /** The agent this Plan conversation defaults to. */
  readonly defaultAgent: string;
  /**
   * Install this invocation's Agent provider under the fixed policy.
   *
   * Called within `<PlanAuthorship>`, so what it registers belongs to that one
   * invocation and goes when the invocation does. What comes back is what the
   * adapter actually assembled, so the frame can report the configuration that
   * is installed rather than the one it asked for.
   */
  installProvider(invocation: PlanAuthorshipInvocation): Operation<PlanProviderAssembly>;
}

export interface PlanAuthorshipInvocation {
  readonly workdir: string;
  readonly host: Scope;
  readonly session: string;
  readonly authoredSession?: string;
  readonly policy: PlanAuthorshipPolicy;
}

/** The fixed policy every Plan runs under, whoever supplies the Agent. */
export interface PlanAuthorshipPolicy {
  readonly systemInstruction: string;
  readonly permissionMode: "deny-all";
  readonly promptFailures: "fail";
  readonly mcpServers: readonly never[];
  readonly allowedTools: readonly never[];
}

/**
 * One installed provider, as the objects it was installed with.
 *
 * Not a description built beside the installation but the installation itself:
 * the same value registers the provider, installs the invocation options, and
 * is handed to a trusted host as its observation. There is nothing for a report
 * to disagree with, because there is no second report.
 */
export interface PlanProviderAssembly {
  /** The identity registered and selected for this invocation. */
  readonly provider: string;
  /** The dependencies the provider was built from, as the provider holds them. */
  readonly dependencies: AcpxProviderDependencies;
  /** The options the invocation provider was installed with. */
  readonly invocation: AgentProviderOptions;
}

/** What a Plan's configuration turned out to be, once it is installed. */
export type PlanAuthorshipObservation = PlanProviderAssembly;

/** What a host that supplies no Agent at all refuses a Plan with. */
export const NO_AGENT_CONTEXT = "No Agent context was found. No Plan was returned.";

/** What a host whose provider supplies no Agent for `<Plan>` refuses it with. */
export function noAgentContextFrom(provider: string): string {
  return (
    `The ${provider} provider did not provide an Agent context for <Plan>. ` +
    "No Plan was returned."
  );
}

/**
 * The production Agent context: ACPX, built from the stack this run settled.
 *
 * One concrete implementation of {@link PlanAuthorship}, and the only one
 * production has. Its ACPX construction, embedded adapters, machine-session
 * assembly, system instruction, strict permission policy, empty MCP servers,
 * empty allowed tools and controlled working directory are exactly what they
 * were when this was the only way to supply one.
 */
export function planAgentContext(
  stack: AgentStack | undefined,
  acp?: AcpxProviderDependencies,
): Result<PlanAuthorship> {
  if (stack === undefined) {
    return Err(new Error(NO_AGENT_CONTEXT));
  }
  if (stack.provider !== "acpx") {
    return Err(new Error(noAgentContextFrom(stack.provider)));
  }
  return Ok({
    defaultAgent: stack.defaultAgent,
    *installProvider(invocation: PlanAuthorshipInvocation): Operation<PlanProviderAssembly> {
      // One assembly, used for every installation and handed back as the
      // observation. Nothing is reconstructed afterward, so a report cannot
      // describe an arrangement other than the one installed.
      const installed: PlanProviderAssembly = {
        provider: "acpx",
        dependencies: authorshipDependencies(
          { stack, ...(acp === undefined ? {} : { acp }) },
          invocation.workdir,
          invocation.host,
          invocation.policy,
        ),
        invocation: {
          defaultAgent: stack.defaultAgent,
          permissionMode: invocation.policy.permissionMode,
        },
      };
      yield* registerAgentProvider(installed.provider, createAcpxProvider(installed.dependencies));
      yield* installInvocationAgentProvider(installed.provider, installed.invocation);
      return installed;
    },
  });
}

/** What claiming one conversation's directory needs, and nothing more. */
export interface AuthorshipPlacement {
  /** Where this host keeps its authorship session directories. */
  readonly root: string;
  /** The logical name this conversation belongs to. */
  readonly session: string;
  /** Whether that name is one a caller can ask for again. */
  readonly explicitSession: boolean;
}

/** Everything the constrained authorship frame is built from. */
export interface AuthorshipFrame {
  /** This conversation's directory, already established and proven empty. */
  readonly workdir: string;
  /** The scope the two host acts run in, captured before this frame exists. */
  readonly host: Scope;
  /** The host's ability to give this invocation an Agent. */
  readonly authorship: PlanAuthorship;
  /** The opaque conversation identity the provider must preserve. */
  readonly session: string;
  /** The exact authored label a trusted child host may address privately. */
  readonly authoredSession?: string;
  observe?(observation: PlanAuthorshipObservation): Operation<void>;
  installElicitation(): Operation<void>;
}

/**
 * Install the constrained authorship frame on the current scope.
 *
 * One function for both surfaces, because what a Plan is written under is not a
 * property of who asked for it. What leaving this scope tears down is the
 * provider, the Elicitation resources, the Prompt tasks and the capability
 * refusals — so whoever installs it decides what the frame covers by choosing
 * the scope, and nothing else has to be remembered.
 *
 * The refusals go last, over whatever the entrypoint provided, so the document
 * is refused rather than served. They are ambient, and the frame cannot tell the
 * host's own act from the document's — which is why the two acts that are the
 * host's run in the scope captured before this one (src/host-acts.ts).
 */
export function* installAuthorshipFrame(frame: AuthorshipFrame): Operation<void> {
  yield* openFormsThroughHost(frame.host);
  yield* frame.installElicitation();

  // Installed here, so the provider resolves for *this* invocation and not for
  // whatever the enclosing document registered, and in this invocation rather
  // than in a frame nested inside it — the content this frame was selected for
  // is projected into the invocation, and a provider installed anywhere else
  // would be invisible to it. The default agent and the permission mode travel
  // with the installation, so an enclosing document cannot widen either by
  // inheritance.
  //
  // Which provider it is belongs to the host that supplied the capability. What
  // does not is everything below: one policy, whoever is underneath it.
  const assembly = yield* frame.authorship.installProvider({
    workdir: frame.workdir,
    host: frame.host,
    session: frame.session,
    ...(frame.authoredSession === undefined ? {} : { authoredSession: frame.authoredSession }),
    policy: PLAN_AUTHORSHIP_POLICY,
  });
  yield* installPlanPromptFailurePolicy();
  yield* refuseDocumentCapabilities();
  // After everything, and it is the installation rather than an account of one.
  // Whether the prompt-failure policy is installed is not reported here at all:
  // a value saying so would agree with itself however the middleware behaved,
  // so a turn that fails partway proves it instead.
  if (frame.observe !== undefined) {
    yield* frame.observe(assembly);
  }
}

/**
 * End authorship on a failed turn.
 *
 * A candidate comes from a turn's complete successful close value or from
 * nowhere. `<Prompt>` ordinarily renders whatever a failed turn managed to emit
 * and carries on, which for a workflow that reviews source would mean showing a
 * person half a program; the host decides otherwise here, so a failed, cancelled
 * or protocol-invalid turn ends authorship before anything is presented. The
 * Component cannot opt out of it.
 */
function* installPlanPromptFailurePolicy(): Operation<void> {
  yield* installPromptFailurePolicy(function* () {
    return PLAN_AUTHORSHIP_POLICY.promptFailures === "fail";
  });
}

/**
 * Run the packaged plan command document and answer with the Plan it approved.
 *
 * Every resource this builds lives inside one scope, so leaving it is what tears
 * the Prompt tasks, the provider and the Elicitation provider down. A teardown
 * failure raises out of here rather than being folded into the result, because
 * a failure to release is not an outcome the source that was selected survives.
 */
export function* runPlanCommandDocument(profile: AuthorshipProfile): Operation<Result<string>> {
  // Before a directory exists, before a provider exists, and therefore before
  // any session could be placed or any turn started. A host that cannot
  // supplies no Agent context refuses rather than writing a Plan under a weaker one.
  const context = profile.context;
  if (!context.ok) {
    return Err(new Error(`${context.error.message} Nothing was output or run.`));
  }

  return yield* scoped(function* (): Operation<Result<string>> {
    // The agent words and this execution's prompt bookkeeping, with no root
    // provider: what writes the Plan is the frame the Component installs around
    // its own content, and a root provider here would be one the Component's
    // regional install had to shadow rather than one it owns.
    yield* installAgentComponents({
      defaultAgent: context.value.defaultAgent,
      permissionMode: PLAN_AUTHORSHIP_POLICY.permissionMode,
    });
    const source = yield* readPackagedDocument(PLAN_COMMAND_DOCUMENT);
    try {
      // The command root is a thin adapter: it projects the request into
      // `<Plan>` and returns what comes back. Everything that used to be
      // installed around it — the directory, the provider, the Elicitation, the
      // refusals — is installed by the Component itself, inside the invocation that
      // owns it, so the command and an ordinary document run one workflow rather
      // than two arrangements of one.
      const approved = yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(PLAN_COMMAND_IDENTITY, source),
            // Invocation-owned and thrown away with the scope. Ordinary
            // document and Prompt semantics need a durable stream; nothing
            // about writing a Plan needs a durable one, and `--journal`
            // belongs to the Plan you approved rather than to the
            // conversation that wrote it.
            stream: new InMemoryStream(),
            // No repository component search. What the adapter may name is
            // what this command declares, so a file in the caller's tree
            // cannot answer for `<Plan>` or anything else.
            includes: [],
            props: {
              request: profile.request,
              syntax: profile.syntax,
              session: profile.session,
            },
          },
          [
            {
              components: agentIdentityComponents(),
              declarations: [profile.declaration],
            },
          ],
        ),
      );
      if (typeof approved !== "string") {
        return Err(new Error("the plan command document returned something that is not a Plan"));
      }
      return Ok(approved);
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * The fixed policy, stated as the dependencies the provider is built from.
 *
 * Each entry is the whole of one clause: the directory the agent runs in — this
 * session's own, proven empty above — the MCP servers it configures, the native
 * tools a fresh session may use,
 * and who answers a native permission request. `mcpServers: []` and
 * `allowedTools: []` are statements rather than omissions — leaving either off
 * is the backend's default, which is not this host's.
 *
 * The host's own assembly is passed through, then overridden: a coordinator or
 * a route store says who owns a session, which this profile still has to respect,
 * while nothing a caller wrote may reach the four fields below.
 *
 * That assembly is also where this build's own ACP adapters enter, so the
 * assistant that writes a Plan is launched from the same snapshot as the run of
 * the approved Plan. An assembly built without them resolved Codex and Claude
 * through ACPX's published pins and could reach neither (#672).
 *
 * Putting one on disk runs `npm install`, which is the one thing this profile
 * refuses to everything inside it, so the host states that act as its own and it
 * runs in `host` (src/host-acts.ts). The distinction is the whole of it: the
 * document decides what to write and may run nothing, while the host installs
 * the adapter it was always going to launch.
 *
 * Exported for the suite that pins exactly that: what a provider is built from
 * is not observable through a provider, and a case that could only watch a turn
 * fail would be reading a live agent's machine rather than this host's decision.
 */
export function authorshipDependencies(
  profile: AuthorshipProviderInputs,
  workdir: string,
  host: Scope,
  policy: PlanAuthorshipPolicy = PLAN_AUTHORSHIP_POLICY,
): AcpxProviderDependencies {
  const assembly = hostAcpDependencies(profile.stack);
  const prepare = assembly.prepareAgent;
  return {
    ...assembly,
    ...(prepare === undefined
      ? {}
      : { prepareAgent: (agentName: string) => inScope(host, () => prepare(agentName)) }),
    ...profile.acp,
    // deno-lint-ignore require-yield
    *agentCwd() {
      return workdir;
    },
    mcpServers: [...policy.mcpServers],
    permissions: "strict",
    newSessionOptions: {
      systemPrompt: policy.systemInstruction,
      allowedTools: [...policy.allowedTools],
    },
  };
}

/**
 * Open this host's own review form the way this host opens anything.
 *
 * The frame refuses *ambiently*: the middleware sits on a scope, and a call
 * carries no mark saying who made it — `API.Process.exec` looks the same whether
 * an `exec` fence reached it or this host did. So showing a person the review,
 * which runs `open`, `xdg-open` or `start`, was refused as though the document
 * had asked, and `xmd plan` printed its URL and warned that it could not open it.
 *
 * The act is the host's: its provider asking its question, about a URL it is
 * serving, decided by no document, agent or authored element. Only the opening
 * moves — a file, a command, the network and a service stay refused — and a
 * failed launch is still a warning printed beside a URL that stands on its own.
 */
function openFormsThroughHost(host: Scope): Operation<void> {
  return FormOpener.around({
    *open([url], next): Operation<void> {
      yield* inScope(host, () => next(url));
    },
  });
}

/**
 * Run one operation in a scope this one is nested inside, and wait for it here.
 *
 * The waiting is what makes it this operation's work: a task created in an outer
 * scope outlives its creator by construction, so the halt is registered before
 * the wait and an ended command takes an unfinished act with it rather than
 * leaving one running under a conversation that is over.
 *
 * `@effectionx/scope-eval` answers a different question. Its worker decouples the
 * call from the work — the operation finishes even when the caller is gone, which
 * is what `persist`, `daemon` and `service` want from it and the opposite of what
 * a host act wants.
 */
function* inScope<T>(scope: Scope, operation: () => Operation<T>): Operation<T> {
  return yield* scoped(function* () {
    const task = scope.run(operation);
    yield* ensure(() => task.halt());
    return yield* task;
  });
}

/**
 * What the assistant session is told once, before it is asked anything.
 *
 * The host owns this layer, and it owns only this: that an answer belongs to the
 * message that asked for it. Which shape any particular message wants — a Plan,
 * or an explanation of why there is not one — is that message's own business, and
 * every message is the plan command document's text. Hiding a shape here would
 * be hiding a policy decision in a place nobody reviewing the workflow can read.
 */
export const AUTHORSHIP_INSTRUCTIONS = [
  "You are the coding agent behind `xmd plan`. A workflow asks you for one thing",
  "at a time, on behalf of one person, and every message states what its answer has",
  "to be.",
  "",
  "Answer the message you were sent, in the shape it asked for, and nothing else. A",
  "message asking for a Plan is answered with Plan source; a message asking for an",
  "explanation is answered with an explanation. Never answer one in the shape the",
  "other asked for.",
].join("\n");

/** The one policy both production and controlled Plan providers consume. */
export const PLAN_AUTHORSHIP_POLICY: PlanAuthorshipPolicy = Object.freeze({
  systemInstruction: AUTHORSHIP_INSTRUCTIONS,
  permissionMode: AUTHORSHIP_PERMISSION_MODE,
  promptFailures: "fail",
  mcpServers: Object.freeze([]),
  allowedTools: Object.freeze([]),
});

/**
 * Where this host keeps its profile session directories by default.
 *
 * Under its own state directory rather than the caller's tree: an agent writing
 * a document has no reason to read the checkout it will run in, and a policy
 * that starts there is not one.
 */
export const DEFAULT_AUTHORSHIP_ROOT: string = join(homedir(), ".xmd", "plan", "sessions");

/**
 * The directory one logical session's conversation runs in.
 *
 * Dedicated to that session rather than shared by every invocation, so two
 * conversations never see one ambient directory. The leaf is the digest of the
 * name and never the name itself: a logical session name is a caller's string,
 * and a caller's string that becomes a path is a caller's string that can escape
 * one.
 *
 * A digest also gives the identity `--session` needs. The generated
 * invocation-unique name digests to a location nothing else reaches, while the
 * same explicit name digests to the same one — which is what lets ACPX find the
 * session record it established last time, since a session's key includes the
 * directory it lives in.
 */
export function authorshipDirectoryFor(root: string, session: string): string {
  return join(root, createHash("sha256").update(session).digest("hex"));
}

/**
 * This conversation's directory, for as long as the conversation lasts.
 *
 * An explicitly named session's directory is durable — a later `--session` finds
 * the same location and therefore the same ACPX session — so nothing is
 * registered against it and nothing removes it.
 *
 * An invocation-unique one belongs to this scope, and the release is registered
 * *before* the first filesystem call that could create it. A leaf this call
 * made and then failed on is still a leaf this call made; registering after the
 * `mkdir` would leave one behind exactly in the case nobody is watching. Being
 * the first thing registered in the scope is also what puts it last in teardown,
 * after every provider, Prompt task and Elicitation resource has gone.
 */
export function* useSessionDirectory(profile: AuthorshipPlacement): Operation<Result<string>> {
  const directory = authorshipDirectoryFor(profile.root, profile.session);
  if (profile.explicitSession) {
    return yield* establishDirectory(directory);
  }
  const claim: DirectoryClaim = { established: false };
  yield* ensure(() => releaseSessionDirectory(directory, claim));
  const established = yield* establishDirectory(directory);
  claim.established = established.ok;
  return established;
}

/** Whether the directory was ever handed to this conversation to use. */
interface DirectoryClaim {
  established: boolean;
}

/**
 * Establish this session's directory, or refuse.
 *
 * Created empty, and required to be empty every time — not cleaned. Whatever is
 * in there was put there by something this host did not authorize, and deleting
 * a stranger's files to get on with the work is the opposite of what this policy
 * is for. So the command says what it found and where, and stops.
 */
function* establishDirectory(directory: string): Operation<Result<string>> {
  try {
    yield* until(mkdir(directory, { recursive: true }));
    const entries = yield* until(readdir(directory));
    if (entries.length > 0) {
      return Err(
        new Error(
          `${directory} is not empty, and xmd plan writes a Plan in a directory of its own ` +
            "with nothing in it. Move or remove what is in there, or name a different " +
            "--session; nothing was written or run",
        ),
      );
    }
    return Ok(directory);
  } catch (error) {
    return Err(
      new Error(
        `could not establish ${directory}: ` +
          (error instanceof Error ? error.message : String(error)),
      ),
    );
  }
}

/**
 * Give an invocation-unique conversation's directory back when it is over.
 *
 * One attempt, non-recursive, always. A directory this conversation was given
 * empty and is handing back empty is removed; anything else is reported and
 * nothing is deleted, because a leaf that changed underneath a conversation
 * nobody authorized to write there is interference, not a tidying job. The
 * failure raises out of the profile's scope, so no final admission follows it,
 * and the approved Plan reaches no stdout, no file and no run.
 *
 * A directory the conversation never got — establishment refused it, or never
 * made it — is a different question, and one already answered: whatever
 * establishment reported is the honest account, and this leaves both it and the
 * directory's contents alone. An empty leaf this call did create is still handed
 * back, which is the whole reason the release is registered before the `mkdir`.
 */
function* releaseSessionDirectory(directory: string, claim: DirectoryClaim): Operation<void> {
  try {
    yield* until(rmdir(directory));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (!claim.established) {
      return;
    }
    if (code === "ENOENT") {
      throw new Error(
        `${directory} was made for this conversation and is already gone. Something removed ` +
          "it while the conversation was still running, which nothing here is allowed to do; " +
          "nothing was output or run",
      );
    }
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      throw new Error(
        `${directory} was empty when this conversation started and is not now. It belongs to ` +
          "one invocation, so nothing should have written there; its contents were left alone " +
          "and nothing was output or run",
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * The capabilities the plan command document does not get.
 *
 * Installed above whatever the entrypoint provided, so the document is
 * refused rather than served. It decides what to write; writing a file,
 * running a command, starting a service and reaching the network are all the
 * approved document's business, under the caller's own configuration.
 */
function* refuseDocumentCapabilities(): Operation<void> {
  const refuse = (capability: string) => () => {
    throw new Error(
      `xmd plan asked for ${capability}, which the authorship profile grants to nothing`,
    );
  };
  yield* API.Files.around({
    // deno-lint-ignore require-yield
    *checkFilePath() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *readTextFile() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *writeTextFile() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *deleteFile() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *globFiles() {
      return refuse("a file")();
    },
    // deno-lint-ignore require-yield
    *temporaryDirectory() {
      return refuse("a directory")();
    },
  });
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec() {
      return refuse("a command")();
    },
  });
  yield* API.Fetch.around({
    // deno-lint-ignore require-yield
    *fetch() {
      return refuse("the network")();
    },
  });
  yield* API.Service.around({
    // deno-lint-ignore require-yield
    *start() {
      return refuse("a service")();
    },
  });
}
