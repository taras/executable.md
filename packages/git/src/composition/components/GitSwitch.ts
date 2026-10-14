/**
 * Switch the contextual checkout to a branch
 * (specs/workflow-workspace-spec.md §7.1).
 *
 * `<Git.Switch branch="release/1.4" base="main" />` uses the enclosing Repository
 * and contextual cwd; a Dir may select one of its linked worktrees. Both values
 * are observations the provider verifies against retained state, never permission.
 * The component renders and binds nothing; before/after evidence is journal-only.
 *
 * Git refusals such as an unresolved base, an occupied branch or overwritten local
 * changes become fixed GitOperationError failures recoverable by PrintErrors.
 * Missing or unretained Repository selection, cwd outside its checkouts and identity
 * mismatch are GitOperationAdmissionError failures: printing cannot recover them,
 * and they publish no outcome.
 */

import { cwd } from "@executablemd/runtime";
import { hasContent } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { Git } from "../git-api.ts";
import { selectedRepository } from "../context.ts";
import { GitOperationAdmissionError, GitOperationError } from "../errors.ts";

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
    throw new GitOperationAdmissionError(
      SWITCH,
      "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
        "branch to be a branch of",
    );
  }

  yield* Git.operations.switch({
    repository,
    workingDirectory: yield* cwd(),
    branch,
    base,
  });
  return "";
}
