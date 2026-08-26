/**
 * Exporting one committed frontier as portable evidence.
 *
 * Export is the one lifecycle operation that reads a run in order to write
 * something that is not a run. It takes the source's executor lock so no
 * execution can append or settle while a frontier is being chosen, reads that
 * frontier once, and hands the result to the artifact container — which knows
 * nothing about runs, locks or repositories and receives only values.
 *
 * ## The definition source closure arrives already authenticated
 *
 * A run retains what its definition *is* — an object format, a commit, a path,
 * a blob identity per component — and where that definition could be fetched
 * from now. It does not retain the Markdown. Turning retrieval metadata back
 * into bytes means opening a repository, and repository access belongs to the
 * host that has it rather than to the lifecycle provider that keeps the run.
 *
 * So the caller obtains and authenticates the closure, and passes it in. What
 * this operation guarantees is the other half: that the closure it was given
 * describes the definition the frontier it read actually retains. A caller
 * cannot seal one run's evidence around another run's source.
 *
 * ## Staging is the caller's, and so is publication
 *
 * The request names a path to build at, not the path a user asked for. A
 * finished artifact becomes visible at its destination by being moved there,
 * and a move is atomic only within one filesystem — so whoever knows where the
 * user wants the file is the only one who can choose a staging location that
 * can atomically become it. This operation produces a complete, verified
 * artifact at the path it was given, or produces nothing and says why.
 */

import type { XmdArtifactDefinitionClosure, XmdArtifactFrontier } from "../artifact/types.ts";

/** What one export is asked to seal, and where to build it. */
export interface WorkflowExportRequest {
  /** The run whose committed frontier becomes the artifact. */
  readonly runId: string;
  /**
   * A path this operation may create, on the filesystem the caller will publish
   * from. Must not exist, and names the artifact rather than a directory.
   */
  readonly stagingPath: string;
  /**
   * The root and component Markdown this run's definition names, already read
   * from the retained commit and verified against the identities that
   * definition holds.
   *
   * Checked against the frontier's own definition before anything is sealed, so
   * a closure belonging to another run refuses rather than being written.
   */
  readonly closure: XmdArtifactDefinitionClosure;
}

/** What one successful export produced. */
export interface WorkflowExportResult {
  /** Where the finished artifact was built. The caller publishes it. */
  readonly stagingPath: string;
  /** The committed boundary the artifact records. */
  readonly frontier: XmdArtifactFrontier;
  /** The lowercase SHA-256 the artifact manifest derives. */
  readonly identity: string;
  /**
   * The SHA-256 of the finished file's exact bytes.
   *
   * Reported beside the identity and never instead of it: one names the
   * evidence and survives a re-encoding, the other names the bytes somebody
   * transferred and does not.
   */
  readonly fileSha256: string;
}
