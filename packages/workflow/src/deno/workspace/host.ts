/**
 * What a host installs around one workflow document execution.
 *
 * Three installations, in one place, because they only make sense together: the
 * run's effect coordinator decides how a Workspace effect commits, the Files
 * provider is what turns a document's `<File>` into one of those effects, and
 * the logical working directory is what every path either of them resolves is
 * relative to. Installing some without the rest would leave a document
 * resolving paths one provider cannot reach.
 *
 * Two more belong here for a different reason: `<Elicit>`, and the Agent
 * profile a host installs, which needs a run to keep provider sessions for.
 * This is the only path that has one.
 *
 * Everything a *feature* needs is an attachment. A host names the installers it
 * wants and they run here, in authored order, between the Files provider and
 * `<Elicit>` — which is the position a Repository, a Git operation or a
 * service-reaching effect has to be in for the run's own coordinator to be
 * beneath it. What those installers do is theirs; this package neither names
 * them nor imports what they install.
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
 * an effect. It is also why a completed replay contacts no remote and spawns no
 * Git: the attachment that could is never installed.
 *
 * `withWorkflowWorkspace()` is therefore the whole of what a host may install.
 * The pieces are not published separately: the Files provider alone would
 * resolve a document's paths against whatever working directory the host adapter
 * answers with, and a host path resolved that way is retained in the durable
 * effects a run replays from.
 */

import { scoped, type Operation } from "effection";
import { API } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { useWorkflowElicitation } from "../../suspension/elicitation.ts";
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

/**
 * Installation options a host owns and a document cannot reach.
 *
 * Supplied where the provider is installed, which is before any document
 * exists. A suite substitutes the leaf host dependencies here — the Git
 * subprocess and the temporary directory — because those are the two things a
 * repository arranged on disk cannot make behave deterministically.
 */
export interface WorkflowWorkspaceOptions {
  /**
   * The further providers this host attaches to the run's Workspace.
   *
   * Where a feature outside this package installs what its own vocabulary
   * needs — the Repository and Git providers, the retained lifecycles for a
   * service-reaching effect, its component registrations. They are installed
   * here, in authored order, after the Files provider and the logical working
   * directory and before `<Elicit>`, because that is the position the run's own
   * coordinator has to be beneath them in.
   *
   * A completed replay never reaches this path, so nothing installed through it
   * runs for a run that is not going to perform an effect.
   */
  readonly attachments?: readonly WorkflowWorkspaceInstaller[];
  /**
   * What this host installs so a workflow document may prompt an Agent.
   *
   * Supplied by the runtime entrypoint, because the profile it installs names
   * one agent client and this package names none. Absent installs nothing, and a
   * document that writes `<Agent>` under such a host resolves no component.
   *
   * It is installed here rather than at the entrypoint for the same reason
   * everything else in this function is: a live or partial attachment is the
   * only thing that has a run to keep provider sessions for. A completed replay
   * never reaches this path, so it starts no agent process.
   */
  readonly agent?: WorkflowAgentInstaller;
}

/** What an Agent profile is told about the run it is being attached to. */
export interface WorkflowAgentAttachment {
  readonly runId: string;
  /**
   * The run itself, so a profile can retain what it learns in the run's own
   * transaction. A mapping that could commit while the run did not would
   * describe a session this run never had.
   */
  readonly database: WorkflowRunDatabase;
}

export type WorkflowAgentInstaller = (attachment: WorkflowAgentAttachment) => Operation<void>;

/**
 * What a Workspace attachment is told about the run it is being installed into.
 *
 * The run's database and nothing else. Everything a feature does with it goes
 * through this package's published boundaries — one durable Workspace effect,
 * or one read-only inspection — so an attachment holds no connection, no lease
 * and no journal route by virtue of being installed here.
 */
export interface WorkflowWorkspaceAttachment {
  readonly database: WorkflowRunDatabase;
}

export type WorkflowWorkspaceInstaller = (
  attachment: WorkflowWorkspaceAttachment,
) => Operation<void>;

/** Run `operation` with this run's Workspace attached to the document. */
export function withWorkflowWorkspace<T>(
  database: WorkflowRunDatabase,
  operation: Operation<T>,
  options: WorkflowWorkspaceOptions = {},
): Operation<T> {
  return withWorkspaceEffects(
    database,
    scoped(function* () {
      yield* useLogicalWorkspaceCwd();
      yield* useWorkflowFiles(database);
      // In authored order, so a host that installs two features gets the
      // middleware ordering it asked for rather than one this package chose.
      for (const attach of options.attachments ?? []) {
        yield* attach({ database });
      }
      // After the attachments and inside this attachment: a
      // completed replay never reaches here, so it registers no second `Elicit`
      // and installs no provider for work that is not going to happen.
      yield* useWorkflowElicitation();
      if (options.agent !== undefined) {
        yield* options.agent({ runId: database.record.runId, database });
      }
      return yield* operation;
    }),
  );
}
