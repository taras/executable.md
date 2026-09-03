/**
 * What a runner proposes when a transaction changed the Workspace.
 *
 * A transaction that only appended to the journal proposes nothing here: the
 * run's Workspace is where it was, and saying otherwise would invent a mutation
 * to make the shape uniform. When the Workspace did change, exactly one of
 * these describes the whole change — the root that was started from, the
 * canonical root now proposed, the content that root closes over, and the
 * retained mappings the same operation produced.
 *
 * Everything here is semantic. There is no command, no correlation id, no
 * base64, no staged row, no SQL, no socket and no path on the runner. The
 * adapter beneath translates this into whatever its owner speaks; a neutral
 * value that carried transport vocabulary would make every other host implement
 * this one's transport.
 *
 * The inventory is exact rather than advisory. It names every manifest and blob
 * the proposed root closes over, once each, in canonical order — not the pieces
 * that happen to be new. The owner resolves each identity from content it
 * already holds or from what this acquisition staged, and an inventory that
 * named more or fewer would be a root whose content nobody agreed on.
 */

import type { RepositoryRecord, WorktreeRecord } from "../composition/records.ts";
import type { AgentSessionRecord } from "../storage/agent-session.ts";

/** One content identity a proposed root closes over. */
export interface ProposedContent {
  readonly kind: "manifest" | "blob";
  readonly digest: string;
  readonly size: number;
}

/**
 * One complete Workspace change, as the owner will receive it.
 *
 * `proposedWorkspaceRootId` is not taken on trust: it is what the runner
 * computed, and the owner recomputes it from the manifest before anything is
 * adopted. Carrying it makes the disagreement detectable rather than making the
 * owner guess what the runner thought it was proposing.
 */
export interface WorkspacePublication {
  readonly proposedWorkspaceRootId: string;
  /** The canonical root manifest, exactly as it was encoded and hashed. */
  readonly proposedManifest: string;
  readonly content: readonly ProposedContent[];
}

/**
 * One retained mapping the same operation produced.
 *
 * A Repository or Worktree row and the Workspace bytes that make its checkout
 * true are one proposal: a mapping naming a checkout that does not exist, or a
 * checkout no mapping accounts for, is a Workspace that only half happened.
 *
 * An Agent-session mapping carries the provider's canonical assertion and the
 * derived key, and nothing of the conversation itself. The owner retains what
 * the run established; it never contacts or impersonates an Agent provider.
 */
export type RetainedMapping =
  | { readonly kind: "repository"; readonly record: RepositoryRecord }
  | { readonly kind: "worktree"; readonly record: WorktreeRecord }
  | { readonly kind: "agent-session"; readonly record: AgentSessionRecord };
