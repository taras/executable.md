/**
 * What a host installs around one workflow document execution.
 *
 * Three installations, in one place, because they only make sense together: the
 * run's effect coordinator decides how a Workspace effect commits, the Files
 * provider is what turns a document's `<File>` into one of those effects, and
 * the logical working directory is what those paths are relative to. Installing
 * any two without the third would leave a document resolving paths one provider
 * cannot reach.
 *
 * They are installed **inside** the execution rather than at the entrypoint, so
 * they sit beneath the host adapter `xmd run` installs and answer ahead of it.
 * Ordinary `xmd run` keeps its host Files provider untouched; a workflow run's
 * document never reaches it.
 *
 * This is the attachment path, and a completed run does not take it. A root
 * result that is already recorded returns without expanding the document, so
 * there is nothing to give a filesystem to — and attaching one anyway would
 * open a transaction and capture a root for a run that is not going to perform
 * an effect.
 *
 * `withWorkflowWorkspace()` is therefore the whole of what a host may install.
 * The three pieces are not published separately: the Files provider alone would
 * resolve a document's paths against whatever working directory the host adapter
 * answers with, and a host path resolved that way is retained in the durable
 * effects a run replays from.
 */

import { scoped, type Operation } from "effection";
import { API } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { withWorkspaceEffects } from "./effect.ts";
import { useWorkflowFiles } from "./files.ts";
import { WORKSPACE_ROOT } from "./logical-path.ts";

/**
 * The working directory a workflow document starts in.
 *
 * The Workspace root, and a logical path rather than a host one. A document
 * that resolves `notes.md` against it names an entry in the run's own
 * filesystem, and nothing it can write reaches the directory the caller
 * happened to invoke `xmd` from.
 */
function useLogicalWorkspaceCwd(): Operation<void> {
  return API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return WORKSPACE_ROOT;
      },
    },
    { at: "min" },
  );
}

/** Run `operation` with this run's Workspace attached to the document filesystem. */
export function withWorkflowWorkspace<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
): Operation<T> {
  return withWorkspaceEffects(
    database,
    scoped(function* () {
      yield* useLogicalWorkspaceCwd();
      yield* useWorkflowFiles(database);
      return yield* operation;
    }),
  );
}
