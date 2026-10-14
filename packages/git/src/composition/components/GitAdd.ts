/**
 * Stage exactly the authored Git pathspecs (specs/workflow-workspace-spec.md §7.2).
 *
 * `<Git.Add paths={["packages/core", "deno.lock"]} />` stages one array in one
 * command and effect, preserving order, repetitions, spelling and pathspec magic.
 * Paths are required; `"."` explicitly selects everything beneath contextual cwd,
 * including a Dir inside the selected Repository. They never select a checkout.
 *
 * The component takes no content, renders nothing and binds nothing. The journal
 * retains pathspecs and checkout evidence before and after staging. Invalid input
 * is a fixed GitOperationError; missing or invalid Repository admission bypasses
 * printing boundaries under the Git.Switch failure contract.
 */

import { cwd } from "@executablemd/runtime";
import { hasContent } from "@executablemd/core";
import type { PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { Git } from "../git-api.ts";
import { selectedRepository } from "../context.ts";
import { GitOperationAdmissionError, GitOperationError } from "../errors.ts";
import { wellFormedText } from "../parse.ts";

/** The component name, as a document writes it and as a failure names it. */
export const ADD = "<Git.Add>";

// Annotated rather than inferred: a heterogeneous `anyOf` widens to member
// types carrying `undefined`, which is not JSON.
export const props: PropsSchema = {
  type: "object",
  properties: {
    paths: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      ],
    },
  },
  required: ["paths"],
  additionalProperties: false,
};

function invalid(sentence: string): never {
  throw new GitOperationError(ADD, "invalid-invocation", `${ADD} ${sentence}`);
}

/**
 * The pathspec array this invocation names.
 *
 * A string is the one-entry array and nothing else is inferred: an empty string,
 * an empty array and an empty entry are all refused rather than read as "here"
 * or as "everything", because both are things a document says explicitly.
 */
export function canonicalPaths(value: Json | undefined): readonly string[] {
  if (typeof value === "string") {
    return admitPathspecs([value]);
  }
  if (!Array.isArray(value)) {
    return invalid("needs a paths pathspec, as one string or an array of them.");
  }
  if (value.length === 0) {
    return invalid("needs at least one pathspec. Omitting paths never means every path.");
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return invalid("needs every pathspec to be a non-empty string.");
    }
    paths.push(entry);
  }
  return admitPathspecs(paths);
}

/**
 * The pathspecs, once each is one a host can hand to Git unchanged.
 *
 * Every entry keeps its spelling — that is the whole contract — so an entry no
 * boundary can carry without changing it is refused rather than sent. A string
 * holding an unpaired surrogate is the case: a process argument list is UTF-8,
 * and what Git would receive is U+FFFD while the run's history would still say
 * what the document wrote. Nothing is normalized, respelled or dropped to make
 * one fit.
 *
 * Applied wherever a request enters, not only where a document writes one: the
 * Api is public, and a caller reaching it directly is subject to the same
 * boundary.
 */
export function admitPathspecs(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) {
    return invalid("needs at least one pathspec. Omitting paths never means every path.");
  }
  for (const path of paths) {
    if (path === "") {
      return invalid("needs every pathspec to be a non-empty string.");
    }
    if (!wellFormedText(path)) {
      return invalid(
        "needs every pathspec to be well-formed text. One of them holds an unpaired surrogate, " +
          "which this host cannot hand to Git as written.",
      );
    }
  }
  return Object.freeze([...paths]);
}

export default function* GitAdd(props: Record<string, Json>): Operation<string> {
  const paths = canonicalPaths(props.paths);

  if (yield* hasContent()) {
    invalid("renders nothing, so it takes no content. Write it as <Git.Add paths=… />.");
  }

  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new GitOperationAdmissionError(
      ADD,
      "it is written outside a lexical <Repository>, so there is no repository in scope to " +
        "stage anything in",
    );
  }

  yield* Git.operations.add({
    repository,
    workingDirectory: yield* cwd(),
    paths,
  });
  return "";
}
