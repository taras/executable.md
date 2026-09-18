/**
 * What the bundled Git Plugin contributes to one workflow execution.
 *
 * Asked of the Plugin value rather than assembled here. Its admissions are what
 * let a replay recognize the Git-host and Issue records a run retained or
 * inherited, and each one derives an execution's identities from that
 * execution's own snapshot — so one Plugin value serves every execution the
 * command runs without any of them reading another's history.
 *
 * The workflow command reaches the Plugin directly because it assembles its
 * execution itself. The ordinary run profile does not need this: a Plugin the
 * command selected is installed by `plugin-host.ts`, and what it returns
 * already travels on `CommandPlugins.installations`.
 */

import type { Operation } from "effection";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { gitPlugin } from "@executablemd/git";

/**
 * The Git Plugin's contribution for one workflow action, as installations.
 *
 * The action is stated as the argv that names it rather than on its own, so
 * what the Plugin answers here is what it answers for the real command line.
 */
export function* gitPluginInstallation(action: string): Operation<ExecutionInstallation> {
  const install = gitPlugin.install;
  if (install === undefined) {
    return {};
  }
  // The command token and the action, as the Plugin's own predicate reads an
  // argv: it locates `workflow` and then finds the first positional after it.
  const installed = yield* install.call(gitPlugin, {
    command: "workflow",
    args: ["workflow", action],
  });
  return { admissions: [...(installed?.admissions ?? [])] };
}
