/**
 * Whether a request addresses the run that is already stored.
 *
 * Reuse of a run id is the mechanism a caller has for saying "the same run
 * again", so the question is not whether two requests are byte-identical but
 * whether they describe one run. Identity is the run id, the whole definition
 * descriptor including its version, the base a Git run started from, and the
 * normalized props. Values are compared canonically, so props that differ only
 * in key order are the same props.
 *
 * Everything a run accumulates is excluded: status, stop reason, retrieval
 * metadata, timestamps, document executions and journal records all change
 * while the run stays the run it was. A completed run that is asked for again
 * is found, not refused.
 *
 * ## Each version is compared by its own identity
 *
 * A Git run is its object, its path, its target and its declared bundle. A
 * source-bundle run is its entrypoint, the complete canonical source manifest,
 * its component mapping and its target. Neither comparison is the other's with
 * a member missing, and two descriptors of different versions are never one
 * run — so a cross-version request disagrees as `definition` and is not then
 * asked about a base one of them does not have.
 */

import {
  definitionComponents,
  type GitWorkflowDefinitionV1,
  type WorkflowComponentEntry,
  type WorkflowDefinition,
} from "./definition.ts";
import type { JsonObject } from "./members.ts";
import { canonicalJson, isGitWorkflowRunRecord, type WorkflowRunRecord } from "./record.ts";
import type {
  SourceBundleComponentV2,
  SourceBundleEntryV2,
  SourceBundleWorkflowDefinitionV2,
} from "./source-bundle.ts";

/** What one reuse of a Git run id is compared against. */
export interface GitWorkflowRunComparisonV1 {
  readonly runId: string;
  readonly definition: GitWorkflowDefinitionV1;
  readonly base: string;
  readonly props: JsonObject;
}

/** What one reuse of a source-bundle run id is compared against. */
export interface SourceBundleWorkflowRunComparisonV2 {
  readonly runId: string;
  readonly definition: SourceBundleWorkflowDefinitionV2;
  readonly props: JsonObject;
}

/** The immutable terms one request offers for the run id it names. */
export type WorkflowRunComparison =
  | GitWorkflowRunComparisonV1
  | SourceBundleWorkflowRunComparisonV2;

/**
 * The immutable fields in which a stored run and a request disagree.
 *
 * Empty means the request addresses the stored run. Field names are reported,
 * never the values behind them: props are retained history, and a conflict is
 * not a reason to print them.
 */
export function conflictingFields(
  stored: WorkflowRunRecord,
  request: WorkflowRunComparison,
): string[] {
  const fields: string[] = [];

  if (stored.runId !== request.runId) {
    fields.push("run id");
  }
  if (!sameDefinition(stored.definition, request.definition)) {
    fields.push("definition");
  }
  // Only when both sides are Git runs. A source bundle has no base at all, and
  // two descriptors of different versions have already disagreed as definitions
  // — reporting a second field about a member one of them never had would name
  // a disagreement the caller cannot act on.
  if (isGitWorkflowRunRecord(stored) && isGitComparison(request)) {
    if (stored.base !== request.base) {
      fields.push("base");
    }
  }
  if (canonicalJson(stored.props) !== canonicalJson(request.props)) {
    fields.push("props");
  }

  return fields;
}

function isGitComparison(request: WorkflowRunComparison): request is GitWorkflowRunComparisonV1 {
  return request.definition.kind === "git";
}

/**
 * Compared member by member rather than canonically.
 *
 * The descriptor is a closed shape both sides have already parsed, so there is
 * nothing a canonical spelling would reconcile — and comparing the members
 * keeps a later variant from being admitted because it happened to serialize
 * the same way.
 *
 * The exact target is one of those members in both versions. A run of one
 * section and a run of the whole document are different runs, and so are runs
 * of two different sections: they execute different content, so reusing one run
 * id for the other would let a resumed run continue something it never started.
 * Absent compares equal only to absent.
 */
function sameDefinition(stored: WorkflowDefinition, requested: WorkflowDefinition): boolean {
  if (stored.kind === "git") {
    return requested.kind === "git" && sameGitDefinition(stored, requested);
  }
  return requested.kind === "source-bundle" && sameSourceBundle(stored, requested);
}

function sameGitDefinition(
  stored: GitWorkflowDefinitionV1,
  requested: GitWorkflowDefinitionV1,
): boolean {
  return (
    stored.version === requested.version &&
    stored.objectFormat === requested.objectFormat &&
    stored.objectId === requested.objectId &&
    stored.rootDocumentPath === requested.rootDocumentPath &&
    stored.targetPath === requested.targetPath &&
    sameComponents(definitionComponents(stored), definitionComponents(requested))
  );
}

/**
 * The whole bundle, not the hash that commits to it.
 *
 * The bundle hash already names this manifest, and it is compared too — but a
 * hash is not a reason to admit a retained structure that disagrees with
 * itself, and a stored descriptor whose manifest no longer matches its hash
 * must not be reused merely because a candidate carried the same hash.
 */
function sameSourceBundle(
  stored: SourceBundleWorkflowDefinitionV2,
  requested: SourceBundleWorkflowDefinitionV2,
): boolean {
  return (
    stored.version === requested.version &&
    stored.hashAlgorithm === requested.hashAlgorithm &&
    stored.bundleHash === requested.bundleHash &&
    stored.entrypoint === requested.entrypoint &&
    stored.targetPath === requested.targetPath &&
    sameSources(stored.sources, requested.sources) &&
    sameMapping(stored.components ?? [], requested.components ?? []) &&
    (stored.components === undefined) === (requested.components === undefined)
  );
}

function sameSources(
  stored: readonly SourceBundleEntryV2[],
  requested: readonly SourceBundleEntryV2[],
): boolean {
  if (stored.length !== requested.length) {
    return false;
  }
  return stored.every((source, index) => {
    const other = requested[index];
    return (
      other !== undefined &&
      source.path === other.path &&
      source.sourceHash === other.sourceHash &&
      source.byteLength === other.byteLength
    );
  });
}

function sameMapping(
  stored: readonly SourceBundleComponentV2[],
  requested: readonly SourceBundleComponentV2[],
): boolean {
  if (stored.length !== requested.length) {
    return false;
  }
  return stored.every((component, index) => {
    const other = requested[index];
    return other !== undefined && component.name === other.name && component.path === other.path;
  });
}

/**
 * The bundle is compared whole, entry by entry, in the canonical order both
 * descriptors were parsed in.
 *
 * A component the run no longer declares, a name pointed at a different file,
 * and a file whose contents changed are all the same fact: this request asks
 * for code the stored run is not a run of. Reusing the run id would resume a
 * procedure under components it never executed.
 */
function sameComponents(
  stored: readonly WorkflowComponentEntry[],
  requested: readonly WorkflowComponentEntry[],
): boolean {
  if (stored.length !== requested.length) {
    return false;
  }
  return stored.every((component, index) => {
    const other = requested[index];
    return (
      other !== undefined &&
      component.name === other.name &&
      component.path === other.path &&
      component.sourceHash === other.sourceHash
    );
  });
}
