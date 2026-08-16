/**
 * The provider-neutral Repository/Worktree composition Api.
 *
 * Repository and Worktree components ask this Api for work; the installed
 * provider decides how to do it. This package names no subprocess, no host
 * filesystem and no runtime: a workflow host with the authority to touch a Git
 * checkout — the Deno host, for now — installs a concrete provider inside its
 * `withWorkflowWorkspace()` attachment.
 *
 * Each component performs two steps against it, and the split is what makes
 * replay work. **Creation** is the durable half: it clones, resolves, pins and
 * retains, and a completed one restores from the journal without contacting
 * anything. **Attachment** is the ephemeral half: it runs every time, live or
 * replayed, and its job is to rebuild the live facade and check that the
 * retained state the journal selected is still the state that is there. Partial
 * replay therefore reattaches without recreating, and a retained checkout that
 * has gone missing is discovered where it can still stop the run.
 *
 * The default handler throws. There is no in-memory fallback: a Repository that
 * "starts" without a provider would retain nothing while claiming it had.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import { RepositoryCompositionProviderError } from "./errors.ts";
import type {
  RepositoryCreationRequest,
  RepositoryRecord,
  WorktreeCreationRequest,
  WorktreeRecord,
} from "./records.ts";

export interface RepositoryCompositionApi {
  /**
   * Create or restore the named Repository's creation identity.
   *
   * One durable effect. A live first reach authorizes the locator, resolves the
   * base once, pins the commit and retains the checkout; a replayed one returns
   * what was retained without reaching a remote.
   */
  createRepository(request: RepositoryCreationRequest): Operation<RepositoryRecord>;

  /**
   * Rebuild the live facade for a Repository whose creation identity is settled,
   * and verify that the Workspace still holds the state that identity names.
   *
   * Ephemeral: it appends nothing and is performed on every execution.
   */
  attachRepository(record: RepositoryRecord): Operation<void>;

  /** Create or restore the named Worktree's creation identity, as one durable effect. */
  createWorktree(request: WorktreeCreationRequest): Operation<WorktreeRecord>;

  /** Rebuild and verify a settled Worktree's live facade. */
  attachWorktree(record: WorktreeRecord): Operation<void>;
}

export const RepositoryComposition: Api<RepositoryCompositionApi> =
  createApi<RepositoryCompositionApi>("executablemd.workflow.composition.repository", {
    // deno-lint-ignore require-yield
    *createRepository(_request: RepositoryCreationRequest): Operation<RepositoryRecord> {
      throw new RepositoryCompositionProviderError("<Repository>");
    },
    // deno-lint-ignore require-yield
    *attachRepository(_record: RepositoryRecord): Operation<void> {
      throw new RepositoryCompositionProviderError("<Repository>");
    },
    // deno-lint-ignore require-yield
    *createWorktree(_request: WorktreeCreationRequest): Operation<WorktreeRecord> {
      throw new RepositoryCompositionProviderError("<Worktree>");
    },
    // deno-lint-ignore require-yield
    *attachWorktree(_record: WorktreeRecord): Operation<void> {
      throw new RepositoryCompositionProviderError("<Worktree>");
    },
  });
