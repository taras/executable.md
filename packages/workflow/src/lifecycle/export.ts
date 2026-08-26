/**
 * Exporting one committed frontier as portable evidence.
 *
 * Export is the one lifecycle operation that reads a run in order to write
 * something that is not a run. It takes the source's executor lock so no
 * execution can append or settle while a frontier is being chosen, reads that
 * frontier once, and hands the result to the artifact container — which knows
 * nothing about runs, locks or repositories and receives only values.
 *
 * ## The source is fetched, never supplied
 *
 * A run retains what its definition *is* — an object format, a commit, a path,
 * a blob identity per component — and where that definition could be fetched
 * from now. It does not retain the Markdown. Turning retrieval metadata back
 * into bytes means opening a repository, and repository access belongs to the
 * host that has it rather than to the lifecycle provider that keeps the run.
 *
 * So the host installs a reader into the provider, and the provider calls it
 * with the definition the frontier it just read actually retains. Nothing about
 * the source travels on this request. A request is a value anything holding the
 * contextual lifecycle name can construct, and source arriving that way would
 * make an artifact evidence about its caller's bytes rather than about a run.
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

/**
 * The exact committed boundary one export chose.
 *
 * Declared here rather than beside the container's other record shapes, and the
 * container imports it. Which run, which final committed event and which
 * Workspace root is what the *lifecycle* decided under the executor lock; the
 * artifact records that decision. Every member is a string, so this stays where
 * the provider-neutral surface can name it — the retained shapes an artifact
 * also carries are DOFS and SQLite records that belong to the adapter holding
 * them.
 *
 * The final committed event is absent for a run whose journal is empty, which
 * is a run that was created and never appended to. The current Workspace root
 * is the run's own current-root pointer at that boundary and is recorded once,
 * here: writing it a second time beside the roots would make one fact into two
 * records that a tampered file could set against each other.
 */
export interface XmdArtifactFrontier {
  readonly sourceRunId: string;
  readonly finalEventId?: string;
  readonly currentWorkspaceRootId: string;
}

/** What one export is asked to seal, and where to build it. */
export interface WorkflowExportRequest {
  /** The run whose committed frontier becomes the artifact. */
  readonly runId: string;
  /**
   * A path this operation may create, on the filesystem the caller will publish
   * from. Must not exist, and names the artifact rather than a directory.
   */
  readonly stagingPath: string;
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
