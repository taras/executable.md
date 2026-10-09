/**
 * Whether a request addresses the run that is already stored.
 *
 * Reuse of a run id is the mechanism a caller has for saying "the same run
 * again", so the question is not whether two requests are byte-identical but
 * whether they describe one run. Identity is the run id, the whole definition
 * descriptor, and the normalized props. Values are compared canonically, so
 * props that differ only in key order are the same props.
 *
 * Everything a run accumulates is excluded: status, stop reason, retrieval
 * metadata, timestamps, document executions and journal records all change
 * while the run stays the run it was. A completed run that is asked for again
 * is found, not refused.
 *
 * A run is its entrypoint, the complete canonical source manifest, its
 * component mapping and its target. There is one definition shape, so there is
 * one comparison rather than a per-version one, and no member a descriptor
 * might not have.
 */

import type { JsonObject } from "./members.ts";
import { canonicalJson, type WorkflowRunRecord } from "./record.ts";
import type {
  SourceBundleComponent,
  SourceBundleEntry,
  WorkflowDefinition,
} from "./source-bundle.ts";

/** The immutable terms one request offers for the run id it names. */
export interface WorkflowRunComparison {
  readonly runId: string;
  readonly definition: WorkflowDefinition;
  readonly props: JsonObject;
}

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
  if (canonicalJson(stored.props) !== canonicalJson(request.props)) {
    fields.push("props");
  }

  return fields;
}

/**
 * Compared member by member rather than canonically.
 *
 * The descriptor is a closed shape both sides have already parsed, so there is
 * nothing a canonical spelling would reconcile — and comparing the members
 * keeps a later variant from being admitted because it happened to serialize
 * the same way.
 *
 * The exact target is one of those members. A run of one section and a run of
 * the whole document are different runs, and so are runs of two different
 * sections: they execute different content, so reusing one run id for the other
 * would let a resumed run continue something it never started. Absent compares
 * equal only to absent.
 *
 * The whole bundle is compared, not just the hash that commits to it. The
 * bundle hash already names this manifest, and it is compared too — but a hash
 * is not a reason to admit a retained structure that disagrees with itself, and
 * a stored descriptor whose manifest no longer matches its hash must not be
 * reused merely because a candidate carried the same hash.
 */
function sameDefinition(stored: WorkflowDefinition, requested: WorkflowDefinition): boolean {
  return (
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
  stored: readonly SourceBundleEntry[],
  requested: readonly SourceBundleEntry[],
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

/**
 * The mapping is compared whole, entry by entry, in the canonical order both
 * descriptors were parsed in.
 *
 * A component the run no longer declares and a name pointed at a different
 * retained source are the same fact: this request asks for code the stored run
 * is not a run of. Reusing the run id would resume a procedure under components
 * it never executed.
 */
function sameMapping(
  stored: readonly SourceBundleComponent[],
  requested: readonly SourceBundleComponent[],
): boolean {
  if (stored.length !== requested.length) {
    return false;
  }
  return stored.every((component, index) => {
    const other = requested[index];
    return other !== undefined && component.name === other.name && component.path === other.path;
  });
}
