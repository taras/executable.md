/**
 * What one XMD artifact holds, detached from every live thing that produced it.
 *
 * These values are the whole surface between the artifact container and the
 * rest of the provider. A caller hands the writer one of them and receives one
 * back from the reader; neither side ever sees a database, a statement, a
 * transaction, a lock, a connection or a host path, because an artifact that
 * carried any of those would be control over a run rather than evidence about
 * one.
 *
 * Every member is a value the live workflow contract already retains, spelled
 * with the type that contract already uses. Restating them here would be a
 * second definition of the same records that could disagree with the first, so
 * the retained shapes are imported and only the two things the live contract
 * has no name for — the artifact frontier and the definition source closure —
 * are declared.
 *
 * ## What is deliberately absent
 *
 * Definition retrieval metadata, provider-owned session directories, checkout
 * host paths, executor and recovery locks, credentials and endpoints. Retrieval
 * is where a definition can be fetched from *now*, which is a fact about the
 * machine that exported rather than about the run — so an artifact carrying it
 * would arrive on a second machine describing the first one's live state.
 */

import type { Json } from "@executablemd/durable-streams";
import type { InheritedEventProvenance } from "../../lifecycle/history.ts";
import type { DocumentExecutionRecord, WorkflowRunRecord } from "../../storage/record.ts";
import type { XmdArtifactFrontier } from "../../lifecycle/export.ts";
import type { AgentSessionRecord } from "../workspace/agent-sessions.ts";
import type { RetainedAnswer } from "../answers.ts";
import type {
  RetainedBlob,
  RetainedManifest,
  RetainedRepository,
  RetainedWorktree,
} from "../fork-source.ts";
import type { StoredWorkspaceRoot } from "../workspace/manifest.ts";
import type {
  GitDefinitionSourceClosureV1,
  GitDefinitionSourceComponentV1,
  GitDefinitionSourceRootV1,
  RetainedDefinitionSources,
} from "../../lifecycle/source.ts";

/** The boundary the lifecycle chose, as the shape every record here is about. */
export type { XmdArtifactFrontier };

/** The lineage of the fork the source run itself was, when it was one. */
export interface XmdArtifactForkLineage {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
  readonly createdAt: string;
}

/**
 * One retained journal row, and what the run knows about where it came from.
 *
 * `record` is the exact retained NDJSON text, never a re-encoding of a parsed
 * event: the journal's security gate already filtered these bytes, and a
 * container that normalized them would be retaining something no gate had seen.
 * The authored source position lives inside those bytes and is validated from
 * them rather than projected beside them.
 */
export interface XmdArtifactJournalRow {
  readonly eventId: string;
  readonly record: string;
  readonly workspaceRootId: string;
  /** Absent on a row the source run wrote itself. */
  readonly inherited?: InheritedEventProvenance;
}

/**
 * What one definition is closed over, spelled where the lifecycle spells it.
 *
 * The source contract belongs to the lifecycle rather than to this encoder: a
 * closure is what a run executes, and an artifact is one place it is written
 * down. These aliases keep the names this directory already used without
 * declaring a second copy of the shapes they name.
 */
export type XmdArtifactDefinitionRoot = GitDefinitionSourceRootV1;
export type XmdArtifactDefinitionComponent = GitDefinitionSourceComponentV1;
export type XmdArtifactDefinitionClosure = GitDefinitionSourceClosureV1;

/**
 * One retained Prompt event, and the provider checkpoint token taken at it.
 *
 * A token is opaque: it is whatever the provider that issued it can later
 * present, and nothing here derives, normalizes or infers one. It is retained
 * evidence rather than a credential — it names a place in a
 * conversation, not permission to reach the host that had it.
 */
export interface XmdArtifactAgentCheckpoint {
  readonly eventId: string;
  readonly tokenKind: string;
  readonly token: string;
}

/**
 * A durable session identity a provider asserted, and what kind of thing it is.
 *
 * Tagged for the same reason the live mapping's assertion is: "an ACP session
 * id" and "a record id in some store" are different claims that happen to be
 * strings.
 */
export interface XmdArtifactProviderSessionIdentity {
  readonly kind: string;
  readonly value: string;
}

/** What every classification of one logical Agent session states. */
export interface XmdArtifactAgentPortabilityBase {
  readonly sessionKey: string;
  readonly sessionIdentity: string;
  readonly provider: string;
  readonly agentCommand: string;
  readonly policy: string;
  /** In journal append order, one row per Prompt a token was taken at. */
  readonly associations: readonly XmdArtifactAgentCheckpoint[];
}

/**
 * A session a fork could continue, and the bundle that would continue it.
 *
 * The bundled identity is retained separately from the source identity because
 * detached bytes may name a transported session rather than the live one they
 * were captured from.
 */
export interface XmdArtifactPortableAgentSession extends XmdArtifactAgentPortabilityBase {
  readonly availability: "portable";
  readonly bundleKind: string;
  readonly compatibilityId: string;
  readonly sourceProviderSession: XmdArtifactProviderSessionIdentity;
  readonly bundledProviderSession: XmdArtifactProviderSessionIdentity;
  readonly identityAllocationMode: "provider-allocated" | "caller-allocated";
  readonly bundleLength: number;
  readonly bundleSha256: string;
}

/**
 * A session no bundle was sealed for, and which of the two reasons applies.
 *
 * `checkpoint-token-unavailable` is intrinsic: the run's own retained evidence
 * is incomplete, and no other host's capability can repair it.
 * `provider-capability-unavailable` is the export decision — every Prompt was
 * completed and covered, and nothing declared a way to capture the session.
 */
export interface XmdArtifactUnavailableAgentSession extends XmdArtifactAgentPortabilityBase {
  readonly availability: "unavailable";
  readonly reason: "checkpoint-token-unavailable" | "provider-capability-unavailable";
}

/** How one Prompt-contributing Agent session is classified. */
export type XmdArtifactAgentPortability =
  | XmdArtifactPortableAgentSession
  | XmdArtifactUnavailableAgentSession;

/**
 * The opaque bytes one portable session was captured as.
 *
 * Confidential and never inspected: a bundle holds whatever the provider put in
 * it, which can include transcript text, tool state, secrets a conversation
 * repeated and the original host's own paths. Nothing scans or scrubs them.
 */
export interface XmdArtifactAgentBundle {
  readonly sessionKey: string;
  readonly bytes: Uint8Array;
}

/**
 * Every Agent portability record and bundle one artifact carries.
 *
 * An in-memory grouping rather than a stored profile marker. The encoder emits
 * only the two declared content kinds, and the decoder constructs this member
 * only when at least one of them is present — so a legacy artifact and a
 * finalized one holding no Prompt are, deliberately, the same file.
 */
export interface XmdArtifactAgentEvidence {
  readonly portability: readonly XmdArtifactAgentPortability[];
  readonly bundles: readonly XmdArtifactAgentBundle[];
}

/** The complete XMD-owned state one artifact seals. */
export interface XmdArtifactContents {
  readonly frontier: XmdArtifactFrontier;
  readonly run: WorkflowRunRecord;
  readonly executions: readonly DocumentExecutionRecord[];
  /** Absent unless the source run was itself a fork. */
  readonly lineage?: XmdArtifactForkLineage;
  readonly journal: readonly XmdArtifactJournalRow[];
  readonly roots: readonly StoredWorkspaceRoot[];
  readonly manifests: readonly RetainedManifest[];
  readonly blobs: readonly RetainedBlob[];
  readonly repositories: readonly RetainedRepository[];
  readonly worktrees: readonly RetainedWorktree[];
  readonly answers: readonly RetainedAnswer[];
  readonly agentSessions: readonly AgentSessionRecord[];
  /** Absent unless the artifact classifies its Prompt-contributing sessions. */
  readonly agentEvidence?: XmdArtifactAgentEvidence;
  /**
   * The source this run executes, in the form its own version retains.
   *
   * A format-1 artifact carries the Git closure and only that; a format-2
   * artifact carries the source bundle and only that. The union is closed here
   * so the writer selects a format from what it was handed rather than from a
   * superset both versions could be read out of.
   */
  readonly definition: RetainedDefinitionSources;
}

/**
 * A complete snapshot a caller has already detached from its source run.
 *
 * The writer copies every byte array and structured value out of it before it
 * validates anything, so a caller that keeps mutating its own arrays after the
 * call changes nothing that was sealed.
 */
export type DetachedXmdArtifact = XmdArtifactContents;

/**
 * The same state, read back and completely verified.
 *
 * Returned only after every gate has passed, and deep-frozen: an immutable
 * value is the whole reason this type exists, because the alternative is
 * handing a caller evidence it can edit.
 */
export interface VerifiedXmdArtifact extends XmdArtifactContents {
  /** The lowercase SHA-256 the artifact manifest derives. */
  readonly identity: string;
}

/** What sealing one artifact produced. */
export interface XmdArtifactWriteResult {
  /** The semantic identity, stable across permitted physical encodings. */
  readonly identity: string;
  /**
   * The SHA-256 of the finished file's exact bytes.
   *
   * A transport digest, not part of identity: it answers "are these the bytes
   * that were published", which the semantic identity deliberately cannot,
   * because two containers holding the same evidence are the same artifact.
   */
  readonly fileSha256: string;
  readonly artifact: VerifiedXmdArtifact;
}

/**
 * The closed set of content an artifact may hold.
 *
 * Closed rather than extensible on purpose. An unknown kind inside a container
 * that declares version 1 is a record this build cannot verify, and admitting
 * it for forward compatibility would mean returning a snapshot whose inventory
 * nobody checked. A later version declares its own set.
 */
export type XmdArtifactContentKind =
  | "artifact-frontier"
  | "workflow-run"
  | "document-execution"
  | "fork-lineage"
  | "journal-event"
  | "journal-record"
  | "workspace-root"
  | "workspace-root-manifest"
  | "dofs-manifest"
  | "dofs-manifest-bytes"
  | "dofs-blob"
  | "dofs-blob-bytes"
  | "workspace-repository"
  | "workspace-worktree"
  | "suspension-answer"
  | "agent-session"
  | "agent-session-portability"
  | "agent-session-bundle-bytes"
  | "definition-source-root"
  | "definition-source-root-content"
  | "definition-source-component"
  | "definition-source-component-content";

/**
 * The closed set of content a format-2 artifact may hold.
 *
 * The same records as format 1 up to the definition, and then a source bundle
 * instead of a Git closure. It admits no format-1 definition kind: one version's
 * closure is never read as the other's, and a shared superset would be an
 * inventory neither version's verifier could complete.
 */
export type XmdArtifactContentKindV2 =
  | "artifact-frontier"
  | "workflow-run"
  | "document-execution"
  | "fork-lineage"
  | "journal-event"
  | "journal-record"
  | "workspace-root"
  | "workspace-root-manifest"
  | "dofs-manifest"
  | "dofs-manifest-bytes"
  | "dofs-blob"
  | "dofs-blob-bytes"
  | "workspace-repository"
  | "workspace-worktree"
  | "suspension-answer"
  | "agent-session"
  | "agent-session-portability"
  | "agent-session-bundle-bytes"
  | "definition-source-entry"
  | "definition-source-content";

/** Every declared kind, for recognition and for exhaustiveness. */
export const XMD_ARTIFACT_CONTENT_KINDS: readonly XmdArtifactContentKind[] = Object.freeze([
  "agent-session",
  "agent-session-bundle-bytes",
  "agent-session-portability",
  "artifact-frontier",
  "definition-source-component",
  "definition-source-component-content",
  "definition-source-root",
  "definition-source-root-content",
  "document-execution",
  "dofs-blob",
  "dofs-blob-bytes",
  "dofs-manifest",
  "dofs-manifest-bytes",
  "fork-lineage",
  "journal-event",
  "journal-record",
  "suspension-answer",
  "workflow-run",
  "workspace-repository",
  "workspace-root",
  "workspace-root-manifest",
  "workspace-worktree",
]);

/**
 * How one entry's bytes are to be read.
 *
 * `canonical-json` is a structured record this build produced and can produce
 * again; `utf8` is text some other contract already fixed, such as a filtered
 * journal record or authored Markdown; `bytes` is content with no text meaning
 * at all. The distinction is what stops a reader from re-encoding evidence it
 * is supposed to be preserving.
 */
export type XmdArtifactEncoding = "canonical-json" | "utf8" | "bytes";

/** One inventory entry, exactly as the canonical manifest states it. */
export interface XmdArtifactManifestEntryV1 {
  readonly kind: string;
  /** The kind's complete logical natural key. `null` for a singleton. */
  readonly identity: Json;
  readonly encoding: XmdArtifactEncoding;
  readonly length: number;
  readonly sha256: string;
}

/**
 * The canonical versioned inventory of one artifact.
 *
 * The version is the semantic format's, and the entry rows are the same shape
 * in both: a manifest states what the artifact holds, and what those records
 * mean is the format's question rather than the row's.
 */
export interface XmdArtifactManifestV1 {
  readonly version: 1 | 2;
  readonly entries: readonly XmdArtifactManifestEntryV1[];
}

/** One accepted entry, with the bytes its manifest row describes. */
export interface XmdArtifactContentEntry {
  readonly kind: string;
  readonly identity: Json;
  readonly encoding: XmdArtifactEncoding;
  readonly content: Uint8Array;
}

/** Every kind format 2 declares, for recognition and for exhaustiveness. */
export const XMD_ARTIFACT_CONTENT_KINDS_V2: readonly XmdArtifactContentKindV2[] = Object.freeze([
  "agent-session",
  "agent-session-bundle-bytes",
  "agent-session-portability",
  "artifact-frontier",
  "definition-source-content",
  "definition-source-entry",
  "document-execution",
  "dofs-blob",
  "dofs-blob-bytes",
  "dofs-manifest",
  "dofs-manifest-bytes",
  "fork-lineage",
  "journal-event",
  "journal-record",
  "suspension-answer",
  "workflow-run",
  "workspace-repository",
  "workspace-root",
  "workspace-root-manifest",
  "workspace-worktree",
]);
