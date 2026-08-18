/**
 * Whether a request addresses the run that is already stored.
 *
 * Reuse of a run id is the mechanism a caller has for saying "the same run
 * again", so the question is not whether two requests are byte-identical but
 * whether they describe one run. Identity is the run id, the whole definition
 * descriptor including its version, the base, and the normalized props. Values
 * are compared canonically, so props that differ only in key order are the same
 * props.
 *
 * Everything a run accumulates is excluded: status, stop reason, retrieval
 * metadata, timestamps, document executions and journal records all change
 * while the run stays the run it was. A completed run that is asked for again
 * is found, not refused.
 */

import type { CreateWorkflowRunRequest } from "./api.ts";
import {
  definitionComponents,
  type WorkflowComponentEntry,
  type WorkflowDefinition,
} from "./definition.ts";
import { canonicalJson, type WorkflowRunRecord } from "./record.ts";

/**
 * The immutable fields in which a stored run and a request disagree.
 *
 * Empty means the request addresses the stored run. Field names are reported,
 * never the values behind them: props are retained history, and a conflict is
 * not a reason to print them.
 */
export function conflictingFields(
  stored: WorkflowRunRecord,
  request: CreateWorkflowRunRequest,
): string[] {
  const fields: string[] = [];

  if (stored.runId !== request.runId) {
    fields.push("run id");
  }
  if (!sameDefinition(stored.definition, request.definition)) {
    fields.push("definition");
  }
  if (stored.base !== request.base) {
    fields.push("base");
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
 * equal only to absent, which is what makes whole-document and targeted
 * definitions incompatible rather than merely unequal.
 *
 * The component bundle is compared on the same terms, and the version is
 * compared first: a run closed over a bundle is never the same run as one
 * closed over none.
 */
function sameDefinition(stored: WorkflowDefinition, requested: WorkflowDefinition): boolean {
  return (
    stored.version === requested.version &&
    stored.kind === requested.kind &&
    stored.objectFormat === requested.objectFormat &&
    stored.objectId === requested.objectId &&
    stored.rootDocumentPath === requested.rootDocumentPath &&
    stored.targetPath === requested.targetPath &&
    sameComponents(definitionComponents(stored), definitionComponents(requested))
  );
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
