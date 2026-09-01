/**
 * `<Git.Switch>` — put the contextual checkout on a named branch
 * (specs/workflow-workspace-spec.md §7.1).
 *
 * ```md
 * <Repository name="project" url={props.repository}>
 *   <Git.Switch branch="release/1.4" base="main" />
 * </Repository>
 * ```
 *
 * There is no path prop, and there is no repository prop. Which checkout this
 * moves is decided by where it is written: the enclosing `<Repository>` names
 * the repository, and the contextual working directory names the checkout
 * inside it, so the same element inside a `<Dir path={worktree}>` moves that
 * linked worktree instead. Both are observations. This component holds no
 * authority over either, and the installed provider rereads what this run
 * retained rather than believing what it was handed.
 *
 * It renders nothing and binds nothing. A switch is a state change, not a value
 * a later element reads; what the run retains about it is journal evidence
 * rather than something a document could have used, and returning a branch name
 * a document already wrote would only invite reading it back as though it were
 * an answer.
 *
 * ## Two kinds of failure, and only one of them is the document's
 *
 * A refusal is something the document asked for and did not get: a base that
 * names no commit, a branch another checkout holds, local changes Git would
 * overwrite. Each arrives as a fixed `GitOperationError` and then fails the
 * operation it is part of, and an authored `<PrintErrors>` region decides
 * otherwise for its whole region.
 *
 * Authority is not that. No Repository in scope, a Repository this run does not
 * retain, a working directory inside none of its checkouts, retained state that
 * has stopped agreeing with the identity naming it — none of these is an outcome
 * a document could have avoided by asking for something else, and continuing
 * past one would run later siblings as though a branch had moved. They travel as
 * `GitOperationAuthorityError`, past every printing boundary, and nothing is
 * published for them.
 */

import { cwd } from "@executablemd/runtime";
import { hasContent } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { GitComposition } from "../git-api.ts";
import { selectedRepository } from "../context.ts";
import { GitOperationAuthorityError, GitOperationError } from "../errors.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const SWITCH = "<Git.Switch>";

export const props = {
  type: "object",
  properties: {
    branch: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
  },
  required: ["branch"],
  additionalProperties: false,
};

function required(props: Record<string, Json>, prop: string): string {
  const value = props[prop];
  if (typeof value !== "string" || value === "") {
    throw new GitOperationError(
      SWITCH,
      "invalid-invocation",
      `${SWITCH} needs a non-empty ${prop}.`,
    );
  }
  return value;
}

export default function* GitSwitch(props: Record<string, Json>): Operation<string> {
  const branch = required(props, "branch");
  const base = typeof props.base === "string" && props.base !== "" ? props.base : undefined;

  // Content would have nowhere to go: this element renders nothing, so children
  // written inside it would expand into a result nobody reads. Refusing says so
  // where a document can still be corrected.
  if (yield* hasContent()) {
    throw new GitOperationError(
      SWITCH,
      "invalid-invocation",
      `${SWITCH} renders nothing, so it takes no content. Write it as ` +
        `<Git.Switch branch=${JSON.stringify(branch)} />.`,
    );
  }

  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new GitOperationAuthorityError(
      SWITCH,
      "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
        "branch to be a branch of",
    );
  }

  yield* GitComposition.operations.switchBranch({
    repository,
    workingDirectory: yield* cwd(),
    branch,
    base,
  });
  return "";
}
