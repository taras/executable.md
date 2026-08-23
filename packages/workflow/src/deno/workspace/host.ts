/**
 * What a host installs around one workflow document execution.
 *
 * Five installations, in one place, because they only make sense together: the
 * run's effect coordinator decides how a Workspace effect commits, the Files
 * provider is what turns a document's `<File>` into one of those effects, the
 * Repository composition provider is what turns a `<Repository>` or
 * `<Worktree>` into another, the Git composition provider is what turns a
 * `<Git.Switch>` into a third, and the logical working directory is what every
 * path any of them resolves is relative to. Installing some without the rest
 * would leave a document resolving paths one provider cannot reach.
 *
 * A sixth is optional and belongs here for a different reason: the Agent profile
 * a host installs needs a run to keep provider sessions for, and this is the
 * only path that has one.
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
 * Git: the provider that could is never installed.
 *
 * `withWorkflowWorkspace()` is therefore the whole of what a host may install.
 * The pieces are not published separately: the Files provider alone would
 * resolve a document's paths against whatever working directory the host adapter
 * answers with, and a host path resolved that way is retained in the durable
 * effects a run replays from.
 *
 * Repository, Worktree, Dir and the Git operations are registered here as
 * ordinary defaults rather than as reserved names, so a repository-local
 * component with one of those names is chosen ahead of them exactly as it would
 * be ahead of any other package's default.
 */

import { scoped, type Operation } from "effection";
import { API } from "@executablemd/runtime";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { useCompositionComponents } from "../../composition/installation.ts";
import {
  useGitComposition,
  useRepositoryComposition,
  type CompositionProviderOptions,
} from "../composition/provider.ts";
import { useGitHubIssues, type GitHubIssuesOptions } from "../issue/github.ts";
import type { HelperAssembly } from "../composition/credential-helper.ts";
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
  readonly composition?: CompositionProviderOptions;
  /**
   * What GitHub issue handling this host installs, and what it may reach.
   *
   * Separate from `composition` because `<Issue>` is not Repository
   * composition: it reaches a service that need not own a Git repository, so
   * its middleware, its ceiling and its credentials are configured on their
   * own. Absent installs none, and a document that writes `<Issue>` then
   * reaches `IssueApi`'s own base error.
   */
  readonly gitHubIssues?: GitHubIssuesOptions;
  /**
   * How this host writes and starts its own credential helper.
   *
   * Supplied by the runtime entrypoint, which is the only place that knows
   * whether this is Deno source or a compiled binary and which platform it is
   * standing on.
   */
  readonly helper?: HelperAssembly;
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
      const composition = {
        ...options.composition,
        ...(options.helper === undefined ? {} : { helper: options.helper }),
      };
      yield* useRepositoryComposition(database, composition);
      yield* useGitComposition(database, composition);
      if (options.gitHubIssues !== undefined) {
        yield* useGitHubIssues(options.gitHubIssues);
      }
      yield* useCompositionComponents();
      if (options.agent !== undefined) {
        yield* options.agent({ runId: database.record.runId, database });
      }
      return yield* operation;
    }),
  );
}
