/**
 * `<Worktree>` — a named linked checkout inside the contextual Repository
 * (specs/workflow-workspace-spec.md §6.2).
 *
 * Invalid without an enclosing lexical `<Repository>`. A Worktree exists inside
 * a Repository, and the Repository's name is half of what makes its identity
 * durable across replay; threading that name through props would let a document
 * name a Repository that is not in scope.
 *
 * Its two forms match Repository's. The self-closing form is the one the
 * adversarial workflow uses, because it is the spelling that both binds a path
 * and lets a sibling `<Dir>` render descendants at it:
 *
 * ```md
 * <Repository name="project" url={props.repository}>
 *   <Worktree name="implementation" branch={props.branch} as="worktree" />
 *   <Dir path={worktree}>…</Dir>
 * </Repository>
 * ```
 *
 * A lexical Worktree written with `as` keeps ordinary generic semantics: its
 * rendered descendants are captured and suppressed. It does not bind the
 * checkout path while also rendering them, and nothing here makes an exception
 * so that it could.
 *
 * Failure policy is `<Repository>`'s, for the same reason: a refusal this
 * recognizes — no Repository in scope, a branch another checkout holds, a name
 * already this Repository's for another branch — is described with a fixed
 * `WorktreeCompositionError` and then fails the operation it is part of. An
 * authored `<PrintErrors>` region decides otherwise, for its whole region.
 */

import { API } from "@executablemd/runtime";
import { content, hasContent } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { RepositoryComposition } from "../api.ts";
import { RepositoryContext } from "../context.ts";
import { WorktreeCompositionError } from "../errors.ts";

export const props = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    branch: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
  },
  required: ["name", "branch"],
  additionalProperties: false,
};

function required(props: Record<string, Json>, prop: string): string {
  const value = props[prop];
  if (typeof value !== "string" || value === "") {
    throw new WorktreeCompositionError(
      typeof props.name === "string" ? props.name : "",
      "no-repository-context",
      `<Worktree> needs a non-empty ${prop}.`,
    );
  }
  return value;
}

export default function* Worktree(props: Record<string, Json>): Operation<string> {
  const name = required(props, "name");
  const branch = required(props, "branch");
  const base = typeof props.base === "string" && props.base !== "" ? props.base : undefined;

  const repository = yield* RepositoryContext.operations.current;
  if (repository === undefined) {
    throw new WorktreeCompositionError(
      name,
      "no-repository-context",
      `<Worktree name=${JSON.stringify(name)}> is invalid outside a lexical <Repository>: a ` +
        "Worktree is a checkout of one, and there is none in scope here.",
    );
  }

  const record = yield* RepositoryComposition.operations.createWorktree({
    repositoryName: repository.name,
    name,
    branch,
    base,
  });
  yield* RepositoryComposition.operations.attachWorktree(record);

  if (!(yield* hasContent())) {
    return record.checkoutPath;
  }

  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return record.checkoutPath;
      },
    },
    { at: "min" },
  );
  return yield* content();
}
