/**
 * `<Git.Push>` — publish the checkout's current branch to its origin
 * (specs/workflow-workspace-spec.md §7.4).
 *
 * ```md
 * <Repository name="project" url={props.repository}>
 *   <Git.Switch branch="release/1.4" />
 *   <Git.Add paths="release/notes.md" />
 *   <Git.Commit message="Prepare 1.4" as="commit" />
 *   <Git.Push />
 * </Repository>
 * ```
 *
 * It takes no props. There is nothing to name: the remote is the Repository's
 * own `origin`, the branch is the one the checkout is on, and the commit is the
 * one that branch points at. Which checkout that is, is decided the way every
 * Git operation's place is decided — by the enclosing `<Repository>` and the
 * contextual working directory — so the same element inside a `<Dir>` at a
 * linked worktree publishes that worktree's branch instead.
 *
 * A prop for any of that would be a second way to say what the document already
 * said by writing the element where it wrote it, and a `remote`, `branch`,
 * `refspec` or `force` prop would be a way to say something else entirely.
 * Publishing somewhere other than where the checkout is takes an explicit
 * contract this component does not have.
 *
 * It renders nothing, binds nothing and takes no content. A push produces no
 * value a later element reads: what the run retains is the reconciliation
 * record, which is journal evidence rather than something a document could use.
 *
 * ## The remote is not the local Git
 *
 * Switch, Add and Commit move state the run's own SQLite transaction encloses.
 * The branch this publishes to belongs to a Git host, which no local
 * transaction can enclose, so Push reconciles through the shared Git-host state
 * machine instead: it observes the destination before it mutates, adopts a
 * destination that already names this exact commit, publishes a proven-absent
 * one once, and refuses a destination that names anything else. It never
 * force-pushes, and it changes no upstream tracking.
 *
 * ## Failure
 *
 * `<Git.Switch>`'s policy, with one refusal of its own. A checkout whose HEAD
 * names no branch has nothing for this to publish, and that is something the
 * document can act on: it arrives as a fixed `GitOperationError` before any
 * remote is contacted. No Repository in scope is missing authority and travels
 * past every printing boundary, because a document that continued past one
 * would run later siblings as though a branch had been published.
 */

import { cwd } from "@executablemd/runtime";
import { hasContent } from "@executablemd/core";
import type { PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { GitComposition } from "../git-api.ts";
import { selectedRepository } from "../context.ts";
import { GitOperationAuthorityError, GitOperationError } from "../errors.ts";

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
    throw new GitOperationAuthorityError(
      PUSH,
      "it is written outside a lexical <Repository>, so there is no repository in scope whose " +
        "origin a branch could be published to",
    );
  }

  yield* GitComposition.operations.pushCurrentBranch({
    repository,
    workingDirectory: yield* cwd(),
  });
  return "";
}
