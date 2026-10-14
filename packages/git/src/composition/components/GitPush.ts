/**
 * Publish the contextual checkout's current branch to its Repository origin
 * (specs/workflow-workspace-spec.md §7.4).
 *
 * `<Git.Push />` takes no props or content, renders nothing and binds nothing.
 * The enclosing Repository and cwd select the checkout, including a linked
 * worktree reached through Dir. Remote, branch, commit, refspec and force are not
 * authored inputs; reconciliation evidence stays in the journal.
 *
 * The remote cannot join the local transaction. Shared Git-host reconciliation
 * observes first, adopts this exact commit, publishes a proven absence or advances
 * a proven ancestor once, and refuses unproven compatibility. It never force-pushes
 * or changes upstream tracking.
 *
 * Git.Switch's failure policy applies. Detached HEAD is a fixed GitOperationError
 * before remote contact; missing Repository is an admission failure that printing
 * cannot recover.
 */

import { cwd } from "@executablemd/runtime";
import { hasContent } from "@executablemd/core";
import type { PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { Git } from "../git-api.ts";
import { selectedRepository } from "../context.ts";
import { GitOperationAdmissionError, GitOperationError } from "../errors.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const PUSH = "<Git.Push>";

export const props: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export default function* GitPush(_props: Record<string, Json>): Operation<string> {
  if (yield* hasContent()) {
    throw new GitOperationError(
      PUSH,
      "invalid-invocation",
      `${PUSH} renders nothing, so it takes no content. Write it as <Git.Push />.`,
    );
  }

  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new GitOperationAdmissionError(
      PUSH,
      "it is written outside a lexical <Repository>, so there is no repository in scope whose " +
        "origin a branch could be published to",
    );
  }

  yield* Git.operations.push({
    repository,
    workingDirectory: yield* cwd(),
  });
  return "";
}
