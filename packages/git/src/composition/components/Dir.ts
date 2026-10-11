/**
 * `<Dir path="..">` — lexical working directory
 * (specs/workflow-workspace-spec.md §6.3).
 *
 * Two acts, in this order. First the directory named by `path` is made to
 * exist: it is created recursively when it is missing, used as it stands when
 * it is already a directory, and refused when something that is not a directory
 * is there or on the way to it. Only then does the content expand, with `path`
 * as the contextual working directory. Content never begins on the far side of
 * a refusal, because a document that named a directory asked for that directory
 * and not for whatever it would otherwise have run in.
 *
 * The enclosing working directory is restored when the invocation ends — on
 * success, failure and cancellation alike, because the installation lives on
 * the invocation's own scope. Restoring it removes nothing: a directory this
 * element created stays, and a later failure of the content inside it says
 * nothing about whether the directory should exist. There is no rollback here
 * and no teardown deletion.
 *
 * It retains nothing of its own. A `<Dir>` inside a `<Repository>` leaves that
 * Repository contextual, which is what lets the self-closing Worktree spelling
 * work: the path is bound by `as`, `<Dir>` moves the working directory to it,
 * and the Repository a later Git component would act on is still the enclosing
 * one. Neither the selection nor any member of its identity is touched.
 *
 * Self-closing `<Dir />` is invalid. A working directory installed for no
 * content is a directory nothing runs in, and silently rendering nothing would
 * hide a document that meant to write children. Being invalid, it fails the
 * operation it is part of; an authored `<PrintErrors>` region may recover from
 * that explicitly, and nothing here decides it on an author's behalf.
 */

import { API, cwd } from "@executablemd/runtime";
import { content, ensureDirectory } from "@executablemd/core";
import { parseFilesFailure } from "@executablemd/runtime";
import type { FormDeclaration, InvocationForm } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";

export const props = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
  },
  required: ["path"],
  additionalProperties: false,
};

export class DirInvocationError extends Error {
  override name = "DirInvocationError";
}

/** What a refusal means, in the document's terms rather than the platform's. */
function reason(value: string): string {
  switch (value) {
    case "not-directory":
      return "something that is not a directory is already there, or is on the way to it";
    case "missing":
      return "part of the path is not there and could not be created";
    case "permission-denied":
      return "this run is not allowed to create or enter it";
    case "read-only":
      return "the filesystem it would be created on is read-only";
    case "lexical-escape":
    case "resolved-escape":
      return "it is outside the directory this run is working in";
    case "empty-path":
      return "the path is empty";
    default:
      return "the directory operation did not succeed";
  }
}

function* Dir(props: Record<string, Json>): Operation<string> {
  const path = props.path;
  if (typeof path !== "string" || path === "") {
    throw new DirInvocationError("<Dir> needs a non-empty path.");
  }

  // A bound Workspace path is absolute and is used as written; anything else is
  // read the way every other authored path is read — against the directory the
  // document is already working in. `<Dir path="nested">` inside a Repository
  // therefore means that Repository's `nested`, and a `<Dir>` that meant the
  // Workspace root would be the surprising one.
  const enclosing = yield* cwd();
  const target = path.startsWith("/")
    ? path
    : `${enclosing.endsWith("/") ? enclosing.slice(0, -1) : enclosing}/${path}`;

  // Before the working directory is installed and before any content expands.
  // A document that names a directory has asked for it to exist, and content
  // that ran in a directory the ensure was going to refuse would be content run
  // somewhere nobody chose.
  //
  // One provider-neutral call, and nothing else: which filesystem this reaches
  // — the caller's own or a workflow run's logical one — is the installed
  // provider's business, and a component that asked would be a component that
  // behaves differently under the two profiles.
  const refusal = yield* ensureDirectory({ cwd: enclosing, path });
  if (!refusal.ok) {
    const failure = parseFilesFailure(refusal.error);
    throw new DirInvocationError(
      `<Dir path=${JSON.stringify(path)}> could not be used: ${
        failure === undefined ? "the directory operation failed" : reason(failure.reason)
      }`,
    );
  }

  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return target;
      },
    },
    { at: "min" },
  );
  return yield* content();
}

/**
 * The one form this component runs.
 *
 * `<Dir>` installs a working directory for its content, and a self-closing
 * invocation has none — so which form it was written as decides whether it does
 * anything at all. That is canonical dispatch's decision, taken from the scan
 * before this body is entered, so neither a contextual handler answering ahead
 * of the engine nor a wrapper minting an object that answers can validate a
 * `<Dir />` the document wrote no children for (executable-mdx-spec §5.6).
 *
 * The sentences stay this component's, so the refusal is the same
 * `DirInvocationError` it always was.
 */
export const form: FormDeclaration = {
  forms: "paired",
  fn: Dir,
  refuse: (props: Record<string, Json>, written: InvocationForm | undefined) =>
    new DirInvocationError(
      written === "self-closing"
        ? `<Dir path=${JSON.stringify(String(props.path))} /> is invalid: Dir installs a working ` +
            `directory for its content, and a self-closing invocation has none. Write it as <Dir ` +
            `path=${JSON.stringify(String(props.path))}>…</Dir>.`
        : `<Dir path=${JSON.stringify(String(props.path))}> was called without the invocation the ` +
            "engine issued, so which form it was written as cannot be established.",
    ),
};

export default form;
