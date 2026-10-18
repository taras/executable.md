/**
 * The one immutable profile a REPL execution runs under.
 *
 * Assembled once, in the command's own scope, before a terminal is opened or a
 * history file exists — and then read and never changed. What a REPL execution
 * may resolve, what ceiling a generated fragment runs under and how permission
 * requests are answered are facts about the command a person invoked, not about
 * the entry they later type: a profile assembled per entry could differ between
 * two entries of one session, and there is only ever one.
 *
 * It carries data and installations, never authority. No Agent stack, provider,
 * Plan writer, live request or scope reaches the application model, the route or
 * the Journal through it.
 */

import type { AcpxProviderDependencies } from "@executablemd/acp";
import { agentIdentityComponents } from "@executablemd/core";
import type { PermissionMode } from "@executablemd/core";
import type { GeneratedSelection } from "@executablemd/core/api";
import type { ExecutionInstallation, IdentityComponent } from "@executablemd/core/host";
import { useScope } from "effection";
import type { Operation } from "effection";

import { contextualAgent, hostAcpDependencies, installAgentProviderStack } from "./agent-stack.ts";
import type { AgentStack } from "./agent-stack.ts";
import { sidekickAssembly } from "./repl/sidekick/assembly.ts";
import type { SidekickAssembly } from "./repl/sidekick/owner.ts";
import { ordinaryGeneratedSelection } from "./evaluation-profile.ts";
import { planComponentDeclaration } from "./plan-component.ts";
import { planAgentContext } from "./plan-writer-profile.ts";
import type { CommandPlugins } from "./plugin-host.ts";
import { ReplEntryHost } from "./repl-entry-installation.ts";
import type { ReplEntryInstallation } from "./repl-entry-installation.ts";
import { renderSyntaxDocumentation, renderSyntaxMarkdown, syntaxSymbols } from "./syntax.ts";

/**
 * Where a REPL entry looks for components.
 *
 * Fixed, because this command takes no include option: an entry is typed rather
 * than named, so there is no document beside which a caller could have meant
 * something else.
 */
const REPL_INCLUDES: readonly string[] = Object.freeze(["components", "."]);

/**
 * The two facts a proof states and production leaves to the host.
 *
 * `planAgentContext` and `installAgentProviderStack` already take the first:
 * production states none and both get the real ACPX runtime, while a journey
 * states a scriptable one so it can drive this exact assembler and this exact
 * provider stack rather than copies of them. The second is where the Plan writer
 * keeps its conversations, which production leaves at the host default and a
 * proof points at a directory it created itself — a suite that used the default
 * would read and remove directories under the developer's own home.
 */
export interface ReplProfileSeams {
  readonly acp?: AcpxProviderDependencies;
  readonly planWriterRoot?: string;
}

/**
 * What one profile assembly is told, beyond the Agent stack and the Plugins.
 *
 * The command's own Sidekick selection and the two seams above, in one
 * parameter: a caller states what it knows and leaves out the rest.
 */
export interface ReplProfileFacts extends ReplProfileSeams {
  /**
   * The name `--sidekick-agent` carried, or none when the line named none.
   *
   * A name, and nothing else: no provider, no installation authority and no
   * availability. Whether an agent by this name can be reached is the first
   * explicit Sidekick turn's question, asked where there is somebody to answer
   * it, and assembling a profile asks nobody anything.
   */
  readonly sidekickAgent?: string;
}

/**
 * What an entry may write here, described and never run.
 *
 * The same two questions canonical `<Syntax />` answers, over this command's own
 * profile: what the vocabulary holds, and what a named component's contract is.
 * It exists because an entry's vocabulary is not a reply's — `<Each>` is
 * ordinary in an entry and unavailable in a response — so a reply about to
 * write one has to be able to ask about the other, and ask the same machinery
 * `xmd syntax` answers from rather than a list kept beside it.
 *
 * Describing resolves nothing and admits nothing. A name rendered here is a name
 * this profile has words for; whether a particular execution admits a particular
 * capability is still that execution's decision.
 */
export interface EntryVocabulary {
  /** Everything an entry may write, as the Markdown `xmd syntax` prints. */
  symbols(): Operation<string>;
  /** The named components' metadata and long-form documentation. */
  documentation(names: readonly string[]): Operation<string>;
}

/** What one REPL execution runs under, decided once and read from then on. */
export interface ReplExecutionProfile {
  /** Where a declared name is looked for, outermost first. */
  readonly includes: readonly string[];
  /**
   * What this command declares to every execution it opens.
   *
   * In installation order: the selected Plugins as they were assembled, then
   * this command's own vocabulary — the Agent identity components and the
   * packaged `<Plan>` Component.
   */
  readonly installations: readonly ExecutionInstallation[];
  /**
   * What a generated fragment may write in every entry this command opens.
   *
   * Data, like everything else here: the names and authored forms this command
   * offers, which the session installs as ordinary Component middleware in each
   * entry's own execution scope. A profile-construction scope ends before the
   * first entry runs, so a selection installed there would be a chain nothing
   * reads.
   */
  readonly generated: GeneratedSelection;
  /** How this REPL answers an Agent permission request. */
  readonly permissionMode: PermissionMode;
  /**
   * What each executing entry installs for itself, built per entry.
   *
   * The one thing here that is not a finished installation, because it cannot
   * be: an entry's issue work is retained under an owner derived from the
   * execution and the entry key, so the installation exists once that entry
   * does. The factory is the host's selection, captured here with everything
   * else this command decided once.
   *
   * Absent on a runtime that selected none, which is an entry with no issue
   * host rather than one with a partly configured one.
   */
  readonly entryInstallation?: ReplEntryInstallation;
  /**
   * The repository operations this command declares, as metadata.
   *
   * The preflight that runs before an entry exists validates against these,
   * and a session whose host selected no entry capability declares them as they
   * stand — the ordinary policy, which is each feature Api's own refusal where
   * nothing is installed. An entry with a capability declares its own set
   * instead, with this host's policy under the operations it retains, so one
   * execution captures one declaration of each name.
   */
  readonly entryComponents: readonly IdentityComponent[];
  /**
   * Which agent this command's Sidekick opens a fresh conversation under.
   *
   * Its own selection, settled from `--sidekick-agent` and falling back to the
   * context rather than to `--default-agent`: the entry stack's default is the
   * agent a `<Session>` an entry writes means, and a person who chose one for
   * their documents has not thereby chosen who they talk to about them.
   *
   * It decides a *fresh* conversation only. A conversation this history already
   * holds was opened under the agent it records, and reopening continues it
   * under that one whatever this command was started with — so this name never
   * overrides what the history says.
   */
  readonly sidekickAgent: string;
  /**
   * The provider and installation a Sidekick conversation runs under.
   *
   * Separate from `installations`, which is the entry vocabulary. A Sidekick
   * conversation installs a provider of its own with the constraints this host
   * decides — no tools, no servers, denied permissions, no prompt
   * customization — rather than inheriting the entry stack's, which would
   * leave what a chat may do decided by how the command was started.
   */
  readonly sidekickAssembly: SidekickAssembly;
  /**
   * The Plugins this command installed, by name, in its own selection order.
   *
   * Names and nothing else. What a Plugin contributes is already in
   * `installations` and `declarations`, and a reply asking what this host is
   * needs to know *which* vocabulary is in play rather than to be handed the
   * values that provide it — so the descriptive half is retained separately
   * from the acting half, and only the descriptive half is readable.
   *
   * The command's order, because that is the order it selected them in and the
   * order every other surface describes them in. An empty selection is a fact
   * about this command, not a missing one.
   */
  readonly plugins: readonly string[];
  /**
   * What an entry may write under this profile, for a reply that asks.
   *
   * Closed over the includes and the Plugin assembly this command was invoked
   * with, so the vocabulary described is the one an entry would actually be
   * validated against. Built per ask rather than resolved here: a command whose
   * entries never ask enumerates no include and parses no component.
   */
  readonly vocabulary: EntryVocabulary;
}

/**
 * Assemble the profile this command's REPL runs under.
 *
 * Runs in the command scope, which is what the packaged `<Plan>` Component
 * captures as its host: putting this build's adapter on disk is the host's act,
 * and it happens outside the frame the Component installs around itself.
 *
 * The provider half of the Agent stack is installed here, exactly once, for the
 * whole command. The REPL's own policy is the session's — this installs no
 * readline permission handling, no foreground launcher and no browser form, so a
 * `<Session.Launch>` refuses through the established missing-launcher contract
 * and `<Elicit>` is answered by the drawer a person is looking at.
 */
export function* assembleReplProfile(
  stack: AgentStack,
  plugins: CommandPlugins,
  facts: ReplProfileFacts = {},
): Operation<ReplExecutionProfile> {
  yield* installAgentProviderStack(stack, facts.acp);
  // Settled here, with the stack and the Plugins, because it is a fact about
  // the command a person invoked rather than about any conversation they later
  // have. Resolved rather than retained as "unstated": a profile that carried
  // the absence would leave every reader of it to apply the fallback again,
  // and the one place that applies it is the one place it is right.
  const agent = facts.sidekickAgent ?? (yield* contextualAgent());

  const plan = yield* planComponentDeclaration({
    surface: "component",
    ...(facts.planWriterRoot === undefined ? {} : { planWriterRoot: facts.planWriterRoot }),
    includes: REPL_INCLUDES,
    // The command's own Plugin assembly, not a second installation of it: two
    // would be two catalogs claiming the same names.
    plugins,
    // The same seam `planAgentContext` already takes: production states none and
    // gets the real ACPX runtime, and a proof states a scriptable one so a
    // journey can drive this exact assembler rather than a copy of it.
    context: planAgentContext(stack, facts.acp),
    ...(stack.sessions === undefined ? {} : { sessions: stack.sessions }),
    host: yield* useScope(),
    // Plan review is answered by the REPL's own Elicit provider, which the
    // session installs around the execution. A Component that installed one of
    // its own here would answer the question in front of the person with
    // something else.
    installElicitation: noElicitationOfItsOwn,
  });

  // The host's selection, read once in the command scope. A value read per
  // entry would be a value a later installation could have changed.
  const entryInstallation = yield* ReplEntryHost.get();

  return Object.freeze({
    includes: REPL_INCLUDES,
    vocabulary: entryVocabulary(REPL_INCLUDES, plugins),
    // Read off the admitted assembly here, once, while it is in hand. Copied
    // rather than referenced so nothing downstream can reach a Plugin value
    // through the profile, and frozen because a profile is read and never
    // changed.
    plugins: Object.freeze(plugins.plugins.map((plugin) => plugin.name)),
    installations: Object.freeze([
      ...plugins.installations,
      Object.freeze({
        components: agentIdentityComponents(),
        declarations: Object.freeze([plan]),
      }),
    ]),
    generated: ordinaryGeneratedSelection(),
    permissionMode: stack.permissionMode,
    ...(entryInstallation === undefined ? {} : { entryInstallation }),
    entryComponents: plugins.components,
    // Settled here, with the stack and the Plugins, because it is a fact about
    // the command a person invoked rather than about any conversation they
    // later have. Resolved rather than retained as "unstated": a profile that
    // carried the absence would leave every reader of it to apply the fallback
    // again, and the one place that applies it is the one place it is right.
    sidekickAgent: agent,
    // Built from the same resolved dependencies the provider stack above was
    // installed with, so a journey that scripts the runtime drives this exact
    // assembly rather than a second one standing in for it.
    sidekickAssembly: sidekickAssembly(agent, facts.acp ?? hostAcpDependencies(stack)),
  });
}

/**
 * Describe one profile's entry vocabulary, through the machinery `xmd syntax` uses.
 *
 * One construction for both questions, and the same one the command line
 * answers from: an operator printing the vocabulary and a reply asking about it
 * are asking about one language, and two renderings that agreed only by hand
 * would be one release away from disagreeing.
 *
 * Exported because a profile assembled for a proof describes the same vocabulary
 * as a profile assembled for a command — the includes and the Plugins differ,
 * and nothing else does.
 */
export function entryVocabulary(
  includes: readonly string[],
  plugins: CommandPlugins,
): EntryVocabulary {
  return Object.freeze({
    *symbols(): Operation<string> {
      return renderSyntaxMarkdown(yield* syntaxSymbols(includes, plugins));
    },
    documentation(names: readonly string[]): Operation<string> {
      return renderSyntaxDocumentation(includes, names, plugins);
    },
  });
}

/**
 * The Plan Component's elicitation installer, which installs nothing.
 *
 * Named rather than inline so what it does is stated where it is read: the
 * enclosing REPL owns the question, and a provider installed here would be a
 * second answerer inside the one that is already asking.
 */
// deno-lint-ignore require-yield
function* noElicitationOfItsOwn(): Operation<void> {}
