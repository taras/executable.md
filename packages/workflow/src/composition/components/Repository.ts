/**
 * `<Repository>` — name a Git repository inside the run's Workspace
 * (specs/workflow-workspace-spec.md §6.1).
 *
 * Two forms, one meaning. Lexical
 * `<Repository name=".." url={..}>…</Repository>` creates or restores the named
 * checkout, then expands its content with that Repository installed as the
 * contextual one and its checkout as the contextual working directory. Both are
 * restored when the invocation ends, on success, failure and cancellation
 * alike, because they live on the invocation's own scope.
 *
 * Self-closing `<Repository name=".." url={..} />` creates or restores the same
 * checkout, renders nothing, and returns the stable Workspace-relative checkout
 * path. Nothing here reaches into how `as` works: the engine's ordinary capture
 * binds the returned string, which is what keeps `as` one rule rather than a
 * Repository-shaped exception to one.
 *
 * ## Who decides what a failure means
 *
 * This component describes what went wrong; it does not decide what the
 * document does about it. A refusal it recognizes — a locator it will not use,
 * a base that names no commit, a name already this run's for another url —
 * arrives as a fixed `RepositoryCompositionError` and then fails the operation
 * it is part of, like any other Effection work. An authored `<PrintErrors>`
 * region is what says otherwise, and it says so for everything inside it rather
 * than for this component alone.
 *
 * Declaring `printErrors` here would have made that decision for every author,
 * for every failure this invocation owns: invalid props, a provider that is not
 * installed, a protocol answer that will not parse. None of those is a refusal
 * a document asked for, and continuing past one would run later siblings as
 * though a checkout existed.
 *
 * Two things are unaffected, in opposite directions. A stale-state failure is a
 * durability failure and travels past every printing boundary, authored or not.
 * A failure of the content a caller projected is the caller's, decided by the
 * region that text is written in.
 */

import { API } from "@executablemd/runtime";
import { content, hasContent } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { RepositoryComposition } from "../api.ts";
import { RepositoryContext } from "../context.ts";
import { RepositoryCompositionError } from "../errors.ts";
import type { RepositoryCreationRequest } from "../records.ts";

export const props = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    base: { type: "string", minLength: 1 },
  },
  required: ["name", "url"],
  additionalProperties: false,
};

function required(props: Record<string, Json>, prop: string): string {
  const value = props[prop];
  if (typeof value !== "string" || value === "") {
    throw new RepositoryCompositionError(
      typeof props.name === "string" ? props.name : "",
      "invalid-locator",
      `<Repository> needs a non-empty ${prop}.`,
    );
  }
  return value;
}

function optional(props: Record<string, Json>, prop: string): string | undefined {
  const value = props[prop];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseRepositoryProps(props: Record<string, Json>): RepositoryCreationRequest {
  return {
    name: required(props, "name"),
    locator: required(props, "url"),
    base: optional(props, "base"),
  };
}

export default function* Repository(props: Record<string, Json>): Operation<string> {
  const record = yield* RepositoryComposition.operations.createRepository(
    parseRepositoryProps(props),
  );
  yield* RepositoryComposition.operations.attachRepository(record);

  if (!(yield* hasContent())) {
    return record.checkoutPath;
  }

  yield* RepositoryContext.around({ current: () => record }, { at: "min" });
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
