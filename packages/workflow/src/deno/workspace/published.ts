/**
 * The Workspace attachment a host outside this package installs.
 *
 * Same name as the one beside it, and deliberately not the same function. The
 * internal `withWorkflowWorkspace` accepts the leaf substitutions a suite needs
 * — a temporary directory, a subprocess, a transport — and any one of them is a
 * seam through which a credential a run acquires would become visible to
 * whoever supplied it.
 *
 * So what is published is this: a wrapper that names the two things a *host*
 * owns and projects only those. There is no member on its options for a
 * substituted leaf, and no path through it that would reach one if a caller
 * invented the property anyway — the projection is explicit rather than a spread
 * of whatever arrived.
 *
 * The broad one keeps its name and stays where it is. Code inside this package
 * imports it source-relatively, which is a path nothing a document loaded can
 * write.
 */

import type { Operation } from "effection";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { withWorkflowWorkspace as withBroadWorkspace } from "./host.ts";
import type { WorkflowAgentInstaller, WorkflowWorkspaceInstaller } from "./host.ts";

/**
 * What a host may configure, and the whole of it.
 *
 * Which features attach to this run, and which Agent profile it installs. Both
 * are facts about the program that is running rather than anything a document
 * or a loaded package decides.
 */
export interface WorkflowWorkspaceOptions {
  /**
   * The features this host attaches to the run's Workspace, in authored order.
   *
   * What each one installs belongs to the package that wrote it. This package
   * supplies the run, the coordinator and the position in the chain, and reads
   * nothing else off the installer it was handed.
   */
  readonly attachments?: readonly WorkflowWorkspaceInstaller[];
  /**
   * The Agent profile this host installs for a live or partial attachment.
   *
   * A host fact like the attachments beside it: which agent client this program
   * can reach, and under what ceiling. This package names no agent client, so
   * the profile arrives from the runtime entrypoint that does.
   */
  readonly agent?: WorkflowAgentInstaller;
}

/** Run `operation` with this run's Workspace attached, as a host installs it. */
export function withWorkflowWorkspace<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
  options: WorkflowWorkspaceOptions = {},
): Operation<T> {
  // Projected member by member. A spread would carry whatever else a caller put
  // on the object, and reading an unknown property is how a getter somebody
  // else wrote gets to run.
  return withBroadWorkspace(database, operation, {
    ...(options.attachments === undefined ? {} : { attachments: [...options.attachments] }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
}
