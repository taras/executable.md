/**
 * `<Git.Add>` — stage exactly the paths a document names
 * (specs/workflow-workspace-spec.md §7.2).
 *
 * ```md
 * <Repository name="project" url={props.repository}>
 *   <Git.Add paths="release/notes.md" />
 *   <Git.Add paths={["packages/core", "deno.lock"]} />
 * </Repository>
 * ```
 *
 * `paths` is a Git pathspec, and that is all it is. It does not choose a
 * checkout — where this stages is decided the way every Git operation's place is
 * decided, by the enclosing `<Repository>` and the contextual working directory
 * — and it is never optional. Omitting it does not mean everything; `"."` is how
 * a document says everything here, and "here" is the directory the element was
 * written in, so `<Git.Add paths="." />` inside a `<Dir path="packages">` stages
 * that directory rather than the checkout.
 *
 * What a document wrote is what Git receives. One string is the one-entry array,
 * and an array keeps its order, its repetitions, its spelling and its pathspec
 * magic, because each of those changes what Git stages. The whole array is one
 * command and one effect: Git decides what a pathspec matches, and staging entry
 * by entry would be several transitions where the document wrote one.
 *
 * It renders nothing, binds nothing and takes no content. What the run retains
 * is journal evidence — the pathspecs, and the checkout on both sides — rather
 * than anything a later element could read.
 *
 * Failure policy is `<Git.Switch>`'s. An invocation this cannot read is a fixed
 * `GitOperationError`; no Repository in scope is missing authority and travels
 * past every printing boundary, because a document that continued past one would
 * run later siblings as though something had been staged.
 */

import { cwd } from "@executablemd/runtime";
import { hasContent } from "@executablemd/core";
import type { PropsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { GitComposition } from "../git-api.ts";
import { currentRepository } from "../context.ts";
import { GitOperationAuthorityError, GitOperationError } from "../errors.ts";
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

  const repository = yield* currentRepository();
  if (repository === undefined) {
    throw new GitOperationAuthorityError(
      ADD,
      "it is written outside a lexical <Repository>, so there is no repository in scope to " +
        "stage anything in",
    );
  }

  yield* GitComposition.operations.addPaths({
    repository,
    workingDirectory: yield* cwd(),
    paths,
  });
  return "";
}
