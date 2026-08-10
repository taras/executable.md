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
import type { WorkflowDefinition } from "./definition.ts";
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
 */
function sameDefinition(stored: WorkflowDefinition, requested: WorkflowDefinition): boolean {
  return (
    stored.version === requested.version &&
    stored.kind === requested.kind &&
    stored.objectFormat === requested.objectFormat &&
    stored.objectId === requested.objectId &&
    stored.rootDocumentPath === requested.rootDocumentPath &&
    stored.targetPath === requested.targetPath
  );
}
