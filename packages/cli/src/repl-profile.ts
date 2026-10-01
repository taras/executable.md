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
import type { ExecutionInstallation } from "@executablemd/core/host";
import { useScope } from "effection";
import type { Operation } from "effection";

import { installAgentProviderStack } from "./agent-stack.ts";
import type { AgentStack } from "./agent-stack.ts";
import { ordinaryEvaluationProfile } from "./evaluation-profile.ts";
import { planComponentDeclaration } from "./plan-component.ts";
import { planAgentContext } from "./plan-writer-profile.ts";
import type { CommandPlugins } from "./plugin-host.ts";

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

/** What one REPL execution runs under, decided once and read from then on. */
export interface ReplExecutionProfile {
  /** Where a declared name is looked for, outermost first. */
  readonly includes: readonly string[];
  /**
   * What this command declares to every execution it opens.
   *
   * In installation order: the selected Plugins as they were assembled, then
   * this command's own vocabulary — the Agent identity components, the packaged
   * `<Plan>` Component, and the ceiling a generated fragment runs under.
   */
  readonly installations: readonly ExecutionInstallation[];
  /** How this REPL answers an Agent permission request. */
  readonly permissionMode: PermissionMode;
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
  seams: ReplProfileSeams = {},
): Operation<ReplExecutionProfile> {
  yield* installAgentProviderStack(stack, seams.acp);

  const plan = yield* planComponentDeclaration({
    surface: "component",
    ...(seams.planWriterRoot === undefined ? {} : { planWriterRoot: seams.planWriterRoot }),
    includes: REPL_INCLUDES,
    // The command's own Plugin assembly, not a second installation of it: two
    // would be two catalogs claiming the same names.
    plugins,
    // The same seam `planAgentContext` already takes: production states none and
    // gets the real ACPX runtime, and a proof states a scriptable one so a
    // journey can drive this exact assembler rather than a copy of it.
    context: planAgentContext(stack, seams.acp),
    ...(stack.sessions === undefined ? {} : { sessions: stack.sessions }),
    host: yield* useScope(),
    // Plan review is answered by the REPL's own Elicit provider, which the
    // session installs around the execution. A Component that installed one of
    // its own here would answer the question in front of the person with
    // something else.
    installElicitation: noElicitationOfItsOwn,
  });

  return Object.freeze({
    includes: REPL_INCLUDES,
    installations: Object.freeze([
      ...plugins.installations,
      Object.freeze({
        components: agentIdentityComponents(),
        declarations: Object.freeze([plan]),
        evaluation: ordinaryEvaluationProfile(),
      }),
    ]),
    permissionMode: stack.permissionMode,
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
