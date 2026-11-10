import { all } from "effection";
import type { Operation } from "effection";
import { z } from "zod";
import { cwd } from "@executablemd/runtime";
import { currentRepository, GitQuery, Repository } from "@executablemd/git/api";
import type { GitChangesResult, GitCompareMode, RepositorySelection } from "@executablemd/git/api";
import { gitObservationValueJson, GitOperationAdmissionError } from "@executablemd/git";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function changes(
  repository: RepositorySelection,
  workingDirectory: string,
  compare: Extract<GitCompareMode, "staged" | "unstaged">,
): Operation<GitChangesResult> {
  return GitQuery.operations.changes({
    repository,
    workingDirectory,
    request: { kind: "changes", comparison: { compare }, paths: null, limit: 100, cursor: null },
  });
}

function complete(result: GitChangesResult): boolean {
  return result.changes.length === 0 && result.next === null;
}

export default function* CheckoutReads(value: unknown) {
  z.object({}).strict().parse(value);
  const repository = (yield* currentRepository()) ?? (yield* Repository.operations.ambient());
  if (repository === undefined) {
    throw new GitOperationAdmissionError(
      "<Git.Changes>",
      "it is written outside a lexical <Repository>, so there is no repository in scope to read",
    );
  }
  const workingDirectory = yield* cwd();
  // The staged and unstaged reads are independent observations, each with its
  // own containment and private index, so neither waits for the other.
  const [staged, unstaged] = yield* all([
    changes(repository, workingDirectory, "staged"),
    changes(repository, workingDirectory, "unstaged"),
  ]);
  if (staged.comparison.compare !== "staged") {
    throw new TypeError("a staged read answered a comparison other than staged");
  }
  return {
    head: staged.comparison.base,
    clean: complete(staged) && complete(unstaged),
    staged: gitObservationValueJson("changes", staged),
    unstaged: gitObservationValueJson("changes", unstaged),
  };
}
