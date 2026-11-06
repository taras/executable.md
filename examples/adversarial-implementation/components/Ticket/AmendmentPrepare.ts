import { z } from "zod";
import { envelope, state } from "./control.ts";
import { describe, read, textLimit } from "./text-storage.ts";
import {
  acquisition,
  authorization,
  json,
  launch,
  observeProgram,
  optional,
  programEntry,
  request,
  verified,
  workflowRoot,
} from "./admission.ts";
import { assembledWeights } from "./measured-weights.ts";
import { RUNTIMES } from "../../../../scripts/runtime-test-exclusions.ts";

export const props = {
  type: "object",
  properties: {
    record: { type: "object" },
    saved: { type: "object" },
    grant: { type: "string" },
    checkout: { type: "object" },
    workflowRevision: { type: ["string", "null"] },
    occupied: { type: "boolean" },
  },
  required: ["record", "saved", "grant", "checkout", "workflowRevision", "occupied"],
  additionalProperties: false,
};
const input = z
  .object({
    record: envelope,
    saved: state,
    grant: z.string().startsWith("/"),
    checkout: z.object({ head: z.string(), clean: z.boolean() }).strict(),
    workflowRevision: z.string().nullable(),
    occupied: z.boolean(),
  })
  .strict();
const receipt = z.object({ workflow: z.object({ revision: z.string() }) });
const originalFeedback = z
  .object({ status: z.literal("feedback_ready"), revision: z.string() })
  .strict();

function refuse(reason: string): never {
  throw new Error(
    reason + " No reservation was made, no source slot was spent and no role was dispatched.",
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function* AmendmentPrepare(value: unknown) {
  const selected = input.parse(value);
  const saved = selected.saved;
  const checkpoint = saved.checkpoint;
  const delivery = saved.manifest.delivery?.directory;
  if (typeof delivery !== "string") {
    refuse("A delivery amendment requires the ticket's recorded delivery directory.");
  }
  if (
    checkpoint.status !== "feedback_ready" ||
    checkpoint.dispatchable ||
    checkpoint.gate !== "feedback-ready" ||
    checkpoint.hold !== null ||
    checkpoint.amendment !== undefined ||
    checkpoint.revision === null
  ) {
    refuse("Only unchanged terminal feedback_ready state at its original feedback admits one amendment.");
  }
  if (selected.occupied) {
    refuse("The next call slot already has retained work; reconcile that execution first.");
  }
  const base = checkpoint.revision;
  const grantText = yield* optional(selected.grant, textLimit);
  if (grantText === undefined) {
    refuse("The authorization record is missing: " + selected.grant + ".");
  }
  const authorized = authorization.safeParse(json(grantText, "The authorization record"));
  if (!authorized.success) {
    refuse("The authorization record is incomplete or unsupported: " + authorized.error.message);
  }
  const granted = authorized.data;
  if (
    granted.work !== saved.manifest.work ||
    granted.repository !== saved.manifest.assignment.repository ||
    granted.revision !== base
  ) {
    refuse("The authorization names another work item, repository or feedback revision.");
  }
  if (selected.checkout.head !== base || !selected.checkout.clean) {
    refuse(
      "Source must be clean at the original feedback revision " +
        base +
        "; observed " +
        selected.checkout.head +
        (selected.checkout.clean ? "." : " with tracked changes."),
    );
  }
  if (!same(granted.predecessor, selected.record.continuation)) {
    refuse("The authorization names another predecessor continuation than the supplied record.");
  }
  if (granted.feedback.path !== delivery + "/feedback.json") {
    refuse("The authorization names another original delivery feedback record.");
  }
  const feedback = originalFeedback.parse(
    json(yield* verified(granted.feedback, "Original delivery feedback"), "Original delivery feedback"),
  );
  if (feedback.revision !== base) {
    refuse("The original delivery feedback describes another revision.");
  }
  yield* verified(granted.authority.document, "The authorization source");
  const measured = granted.measurement;
  if (measured.run.commit !== base) {
    refuse("The measurement must be taken at the original feedback revision " + base + ".");
  }
  const acquired = acquisition.parse(
    json(yield* verified(measured.acquisition, "Artifact acquisition evidence"), "Artifact acquisition evidence"),
  );
  if (!same(acquired.run, measured.run)) {
    refuse("Artifact acquisition evidence names another hosted run or attempt.");
  }
  for (const runtime of RUNTIMES) {
    if (
      acquired.records[runtime].name !==
        "test-weights-" + runtime + "-attempt-" + measured.run.attempt ||
      acquired.records[runtime].sha256 !== measured.records[runtime].sha256
    ) {
      refuse("Artifact acquisition evidence does not name the retained " + runtime + " record.");
    }
  }
  const artifact = yield* verified(measured.artifact, "The retained weights artifact");
  if (acquired.weights.sha256 !== measured.artifact.sha256) {
    refuse("The retained weights artifact differs from the acquired test-weights artifact.");
  }
  const assembled = yield* assembledWeights(saved.manifest.assignment.repository, measured);
  if (assembled !== artifact) {
    refuse("The retained runtime records do not assemble into the retained weights artifact.");
  }
  const launched = launch.parse(
    json(
      yield* verified(granted.workflow.old, "Original workflow launch evidence"),
      "Original workflow launch evidence",
    ),
  );
  if (launched.work !== saved.manifest.work || launched.directory !== saved.manifest.directory) {
    refuse("The original workflow launch evidence belongs to another ticket.");
  }
  const receipts = saved.calls.flatMap((call) =>
    call.preparation === undefined ? [] : [call.preparation],
  );
  if (receipts.length === 0) {
    refuse("The ticket retains no preparation receipt that ties a workflow revision to its execution.");
  }
  for (const path of receipts) {
    const recorded = receipt.parse(json(yield* read("/", path), "Preparation receipt " + path));
    if (recorded.workflow.revision !== launched.revision) {
      refuse("The original workflow launch evidence differs from the ticket's recorded execution.");
    }
  }
  const observed = {
    root: workflowRoot,
    entry: programEntry,
    revision: selected.workflowRevision,
    files: yield* observeProgram(),
  };
  if (!same(granted.workflow.new, observed)) {
    refuse("The selected new workflow sources differ from the program now running.");
  }
  const round = { before: checkpoint.round, after: checkpoint.round + 1, max: saved.manifest.maxCorrections };
  if (round.after > round.max) {
    refuse("The ticket's source-correction allowance is exhausted (" + round.max + ").");
  }
  const reservation = delivery + "/amendment";
  const weights = describe("test-weights.json", artifact);
  const grantRecord = describe(selected.grant, grantText);
  const recorded = request.parse({
    schema: "delivery-amendment-request.v1",
    work: saved.manifest.work,
    repository: saved.manifest.assignment.repository,
    base,
    grant: grantRecord,
    authority: granted.authority,
    predecessor: granted.predecessor,
    feedback: granted.feedback,
    measurement: measured,
    weights,
    workflow: { old: granted.workflow.old, launch: launched.selection, new: observed },
    round,
  });
  const requestDescriptor = describe(reservation + "/request.json", JSON.stringify(recorded));
  const amendment = {
    schema: "delivery-amendment.v1",
    reservation,
    request: requestDescriptor,
    disposition: reservation + "/disposition.json",
    base,
    calls: saved.calls.length,
    predecessor: granted.predecessor,
    feedback: granted.feedback,
    weights,
    measurement: measured,
    workflow: observed,
  };
  const instructions = [
    "Delivery amendment: import the measured test-weights.json for this completed ticket.",
    "Copy the retained artifact verbatim to test-weights.json at the repository root and create one signed commit whose only parent is " +
      base +
      ". Change no other path, remeasure nothing and leave CI shard counts unchanged; count changes need separate qualification work.",
    "Artifact: " +
      measured.artifact.path +
      " (sha256 " +
      measured.artifact.sha256 +
      ", " +
      measured.artifact.utf8Bytes +
      " UTF-8 bytes)",
    "Grant: " + selected.grant,
  ].join("\n");
  const successor = state.parse({
    ...saved,
    checkpoint: {
      ...checkpoint,
      status: "running",
      dispatchable: true,
      round: round.after,
      gate: "implementation",
      revision: base,
      reviews: {},
      hold: null,
      exactApproval: null,
      exactReview: null,
      assignment: {
        ...saved.manifest.assignment,
        phase: "implementation",
        revision: base,
        priorRevision: saved.manifest.assignment.revision,
        request: instructions,
        assessment: checkpoint.assignment.assessment,
        reviewKind: checkpoint.assignment.reviewKind ?? "feature",
        changedPaths: [],
        artifacts: [selected.grant, measured.artifact.path],
        evidence: [],
        findings: [],
        handoffInputs: [],
        contract: checkpoint.assignment.contract ?? null,
      },
      amendment,
    },
  });
  return { request: recorded, requestDescriptor, successor };
}
