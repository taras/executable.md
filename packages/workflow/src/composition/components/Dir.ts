/**
 * `<Dir path="..">` — lexical working directory
 * (specs/workflow-workspace-spec.md §6.3).
 *
 * One meaning and one effect on the world: the content expands with `path` as
 * the contextual working directory, and the enclosing one is restored when the
 * invocation ends — on success, failure and cancellation alike, because the
 * installation lives on the invocation's own scope.
 *
 * It creates nothing and retains nothing. A `<Dir>` inside a `<Repository>`
 * leaves that Repository contextual, which is what lets the self-closing
 * Worktree spelling work: the path is bound by `as`, `<Dir>` moves the working
 * directory to it, and the Repository a later Git component would act on is
 * still the enclosing one.
 *
 * Self-closing `<Dir />` is invalid. A working directory installed for no
 * content is a directory nothing runs in, and silently rendering nothing would
 * hide a document that meant to write children. Being invalid, it fails the
 * operation it is part of; an authored `<PrintErrors>` region may recover from
 * that explicitly, and nothing here decides it on an author's behalf.
 */

import { API, cwd } from "@executablemd/runtime";
import { authoredForm, content } from "@executablemd/core";
import type { ComponentInvocation } from "@executablemd/core";
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

export default function* Dir(
  props: Record<string, Json>,
  invocation: ComponentInvocation,
): Operation<string> {
  const path = props.path;
  if (typeof path !== "string" || path === "") {
    throw new DirInvocationError("<Dir> needs a non-empty path.");
  }

  // From the invocation the engine issued, not from the composable chain and not
  // from a method the caller supplied: which form this was written as decides
  // whether a working directory is installed at all, and both a handler
  // answering that question and a wrapper minting an object that answers it
  // could validate a self-closing `<Dir />` the document never wrote children
  // for. `authoredForm()` authenticates before answering.
  const form = authoredForm(invocation);
  if (form === undefined) {
    throw new DirInvocationError(
      `<Dir path=${JSON.stringify(path)}> was called without the invocation the engine issued, ` +
        "so which form it was written as cannot be established.",
    );
  }

  if (!form.content) {
    throw new DirInvocationError(
      `<Dir path=${JSON.stringify(path)} /> is invalid: Dir installs a working directory for ` +
        `its content, and a self-closing invocation has none. Write it as <Dir path=` +
        `${JSON.stringify(path)}>…</Dir>.`,
    );
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
