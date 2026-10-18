/**
 * Read the selected repository: its tracked files, what changed, the patch, and
 * one file as a commit holds it (specs/workflow-workspace-spec.md §7.8).
 *
 * ```mdx
 * <Git.Files prefix="packages/core/" limit={100} as="files" />
 * <Git.Changes compare="staged" as="changes" />
 * <Git.Diff compare="staged" paths={["packages/core/"]} as="diff" />
 * <Git.File commit="HEAD~1" path="packages/core/src/expand.ts" as="source" />
 * ```
 *
 * All four are self-closing value components that bind JSON and render nothing.
 * Each observes the two things a document can see — the Repository in scope and
 * the contextual working directory — and asks whoever is installed to read. The
 * provider decides which checkout, if any, those two select; neither the
 * selection nor a `cursor` a document is holding grants access to one.
 *
 * `as` is required by an explicit `returns` declaration, which is checked before
 * the body runs: an invocation that forgot it is refused before a provider is
 * asked anything. Props are closed and admitted here, so a zero limit, a
 * fractional offset, an absolute path or a revision pair on a live comparison is
 * refused before any Git work.
 *
 * Self-closing form is declared to canonical dispatch, so neither replaceable
 * `hasContent()` nor a caller-made invocation object turns a paired element into
 * a read.
 */

import { cwd } from "@executablemd/runtime";
import type { FormDeclaration, InvocationForm } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { GitQuery } from "../../git.ts";
import { selectedRepository } from "../context.ts";
import { GitObservationError, GitOperationAdmissionError } from "../errors.ts";
import {
  admitChangesRequest,
  admitDiffRequest,
  admitFileRequest,
  admitFilesRequest,
} from "../observation-api.ts";
import type { GitObservationRequest } from "../observation-api.ts";
import {
  gitChangesResultJson,
  gitDiffResultJson,
  gitFileResultJson,
  gitFilesResultJson,
} from "../observation-records.ts";

/** The component names, as a document writes them and a refusal names them. */
export const FILES_ELEMENT = "<Git.Files>";
export const CHANGES_ELEMENT = "<Git.Changes>";
export const DIFF_ELEMENT = "<Git.Diff>";
export const FILE_ELEMENT = "<Git.File>";

function* Files(props: Record<string, Json>): Operation<Json> {
  const request = admitFilesRequest(FILES_ELEMENT, props);
  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw outside(FILES_ELEMENT);
  }
  return gitFilesResultJson(
    yield* GitQuery.operations.files({
      repository,
      workingDirectory: yield* cwd(),
      request,
    }),
  );
}

function* Changes(props: Record<string, Json>): Operation<Json> {
  const request = admitChangesRequest(CHANGES_ELEMENT, props);
  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw outside(CHANGES_ELEMENT);
  }
  return gitChangesResultJson(
    yield* GitQuery.operations.changes({
      repository,
      workingDirectory: yield* cwd(),
      request,
    }),
  );
}

function* Diff(props: Record<string, Json>): Operation<Json> {
  const request = admitDiffRequest(DIFF_ELEMENT, props);
  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw outside(DIFF_ELEMENT);
  }
  return gitDiffResultJson(
    yield* GitQuery.operations.diff({
      repository,
      workingDirectory: yield* cwd(),
      request,
    }),
  );
}

function* File(props: Record<string, Json>): Operation<Json> {
  const request = admitFileRequest(FILE_ELEMENT, props);
  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw outside(FILE_ELEMENT);
  }
  return gitFileResultJson(
    yield* GitQuery.operations.file({
      repository,
      workingDirectory: yield* cwd(),
      request,
    }),
  );
}

function outside(element: string): Error {
  return new GitOperationAdmissionError(
    element,
    "it is written outside a lexical <Repository>, so there is no repository in scope to read",
  );
}

function declare(
  element: string,
  fn: (props: Record<string, Json>) => Operation<Json>,
): FormDeclaration {
  return {
    forms: "self-closing",
    fn,
    refuse: (_props: Record<string, Json>, written: InvocationForm | undefined) =>
      new GitObservationError(
        element,
        "unexpected-content",
        written === "paired"
          ? `${element} reads the repository and renders nothing of its own, so it is written ` +
              "self-closing."
          : `${element} was called without the invocation the engine issued, so which form it ` +
              "was written as cannot be established.",
      ),
  };
}

export const filesForm: FormDeclaration = declare(FILES_ELEMENT, Files);
export const changesForm: FormDeclaration = declare(CHANGES_ELEMENT, Changes);
export const diffForm: FormDeclaration = declare(DIFF_ELEMENT, Diff);
export const fileForm: FormDeclaration = declare(FILE_ELEMENT, File);
