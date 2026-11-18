# Revalidate an original joined reply without another provider call

Use this interface when an original implementation reply completed but extraction left its Ticket held without a canonical result. It validates retained evidence and publishes one separate derivative at the original feedback gate. It does not perform feedback or implement missing acceptance work.

## Applies to

The explicit native file entry and direct native REPL component invocation. Select the recovery include before the existing owning workflow include. For #1400, keep the owner at eda5c08a9fbcc4a308537b17f0b9547108fbc748. Do not select current-main's ordinary Ticket loaders in place of that owner. The recovery include supplies the new action; its include composition supplies the unchanged owner.

## Public interface

File entry `examples/adversarial-implementation/reconcile-response.md` has two required props and one optional resumption prop:

- `record: string`: absolute path to an existing confirmed Ticket return. Initially this is the original held return. On a confirmed repeat, supply the actual confirmed successor returned by the prior successful action.
- `proof: string`: absolute path to the proof document below. The first admitted observation is snapshotted. A confirmed repeat hydrates that same recorded proof and evidence; it does not refresh original files.

- `resume: string | null` (default `null`): absolute path to the explicit resumption document below. Omit it for an initial action or a confirmed repeat.

Component `Ticket.ReconcileResponse` has the same optional `resume` prop and two required props:

- `record: object`: the same parsed Ticket envelope, validated by the owning Ticket.Envelope/Load boundary.
- `proof: string`: the absolute proof-document path.

It returns the existing bounded `ticket-return.v1` envelope. On success it returns a confirmed paused feedback successor. On refusal it returns a held envelope retaining the prior confirmed continuation and useful receipt paths in its diagnostic. It accepts no role, model, work, call ID, revision, raw text, candidate, result, next gate, correction bound or permission prop; those facts are derived or validated from retained evidence.

Description: “Revalidate an original joined reply without prompting. Use `<Ticket.ReconcileResponse record={held} proof="/absolute/work/recovery-proof.json" as="recovered" />`, then advance its confirmed return through the owning workflow.”

## Proof document

The exact top-level shape is:

```json
{
  "schema": "joined-response-proof.v1",
  "amendment": {"path": "/absolute/decision.md", "utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"},
  "provenance": {"path": "/absolute/provenance.md", "utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"},
  "join": {"path": "/absolute/architect-join-proof.json", "utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"},
  "handoffInputs": [
    {"path": "/absolute/known-unmet-acceptance.md", "utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"}
  ]
}
```

The displayed sizes/digests are explanatory placeholders, not a ready-made proof. Obtain each descriptor from the exact permitted UTF-8 text before invoking the action. No other top-level members are admitted. Each reference is the existing strict `{path, utf8Bytes, sha256}` descriptor with an absolute path, the owning text bound and current File permission/protection. The three named evidence texts are nonempty. handoffInputs is ordered, distinct and bounded to twelve references, and normal selected-input capacity applies.

For #1400, amendment and provenance are the retained approved decision and provenance files. join is `/private/tmp/xmd-joined-phase-recovery-1396/ticket/attempts/0001/architect-join-proof.json`, not an operator assertion that a turn joined. Read and validate its full referenced original prompt event, exact source membership and outer native completion against the held record. Ignore its summary booleans as proof of those facts. handoffInputs includes the exact supplied `/private/tmp/xmd-pullrequest-1400.4n6d_64v/known-unmet-acceptance.md`; keep its complete A6/A4/A8/A2/A7/unfinished-root qualifications.

The join report’s journal line descriptor names the complete JSONL record, including its newline. Its native completion descriptor names the whole native log; the line selects the completion record only after that log validates. Effective definitions must match the prepared Git source. Retained imports through the original entry must agree, but code after the extraction failure need not have run.

### Public run settlement

A public `executeInstalled` host can supply the alternate report below. It records the actual returned execution result after leaving the execution's owning scope and joining its cleanup. A journal root close alone does not establish that completion.

```json
{
  "schema": "joined-response-run-proof.v1",
  "journal": {"path": "/absolute/original.jsonl", "line": 1, "lineDescriptor": {"utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"}},
  "retainedEvent": "/absolute/original-event.json",
  "publicRunSource": {"path": "/absolute/settlement.json", "utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"}
}
```

These four members are exact. The report cannot mix `nativeFinishedSource` or Submit entry metadata with this form. Its settlement descriptor binds the whole JSON receipt before fields are interpreted. That receipt has exactly `schema: "joined-response-run-settlement.v1"`, `root` and `journal` absolute UTF-8 descriptors, and `outcome: {kind: "settled", result: {ok: true, value: <actual held Ticket envelope>}}`.

The root descriptor binds the retained authored source. The journal descriptor binds the entire newline-framed journal at the report's path. Every event must parse, with one root import and one settled root close, matching source bytes and a successful retained document result equal to both the actual returned envelope and the confirmed input. Failed document results, ambiguous root membership, unfinished suffixes, missing settlement, failed or suspended outer results and changed descriptors refuse. Original prompt/source-owner, session identity, model, request and reply checks apply to both forms. The receipt, root source and full journal are snapshotted alongside the other original evidence.

The historical Submit form remains supported with its original byte framing, full native-log descriptor and entry/execution membership. Neither form turns the failed inner phase into a successful phase or grants an acceptance verdict.

Approval/provenance document the actual authority already granted. Descriptors verify evidence correspondence and grant no permission. This format creates neither authority tokens nor a model-selection or historical-migration interface.

## Invoke the native entry

Use the following path pattern with the owner's saved return and measured proof file:

```bash
deno task xmd run --allow-absolute \
  /absolute/repaired/examples/adversarial-implementation/reconcile-response.md \
  --props-record /private/tmp/xmd-pullrequest-1400.4n6d_64v/implementation-return.json \
  --props-proof /absolute/owner/recovery-proof.json \
  --include /absolute/repaired/examples/adversarial-implementation/recovery/components \
  --include /absolute/owning-pin/examples/adversarial-implementation/components \
  --raw
```

Retain the successful joined native return under a new path. It is the confirmed envelope used for continuation or a confirmed repeat. Never redirect over the input return, any historical attempt or any original receipt. If the native call fails or publication is uncertain, preserve its first output and held return, and inspect the reserved reconciliation. Matching files do not authorize another publication.

A direct REPL entry uses the same composition and returns the component value. It must bind the already read/validated held envelope and proof path; the action does not read arbitrary conversation bindings or change native cwd.

## What success publishes

The existing Ticket state shape is preserved. New files live under `ticket/reconciliations/<original-hold-digest>/`: request/proof receipts, a separate result.json derivative, source observation, explicit disposition and confirmation. The checkpoint's existing document/feedback fields link these records to the failed original call. The old call remains failed_without_result with its original result link absent, and its execution remains failed. No original file is rewritten.

The successor is paused and eligible for the original policy-selected feedback. Reconciliation dispatches nothing. Advance it in a separate ordinary owning-pin `continue.md` invocation with steps=1 and no model-selection props. It retains original allocation, conversations, input accounting and all correction allowances.

For a confirmed repeat, invoke reconcile-response with the retained confirmed successor as record and the same proof reference. It returns exactly that envelope with no writes, prompts, source checks or successor dispatch. A different proof identity refuses. Reusing the old held input after reservation is held: supply the actual successful returned successor if it exists, or preserve the uncertain action if completion was lost. The explicit resumption below covers only a proven request-only failure. A result or confirmation file alone cannot replace that returned acknowledgment.

## Resume a proven unpublished reservation

Use `resume` only after the original native invocation has joined with exit 1,
zero provider prompts, unchanged originals and no returned successor. Its saved
native observer receipt must establish those facts and identify the original
hold. Preserve the first output, error, journal and receipt. A journal ending
before a root close cannot itself establish native completion.

The approved request-only operation adds an admission receipt under
`reconciliations/<hold-digest>/resume/request.json`, then runs the ordinary full
source, owner, guide, prompt, reply and publication checks. It never rewrites the
first `request.json` or relabels the failed invocation. Supply this exact shape,
with descriptors measured from the retained UTF-8 files:

```json
{
  "schema": "joined-response-resume.v1",
  "request": {"path": "/absolute/ticket/reconciliations/<hold-digest>/request.json", "utf8Bytes": 6495, "sha256": "64 lowercase hexadecimal characters"},
  "authority": {"path": "/absolute/approved-resumption.json", "utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"},
  "failure": {"path": "/absolute/first-native-receipt.json", "utf8Bytes": 1, "sha256": "64 lowercase hexadecimal characters"}
}
```

The three references and the resumption document must have distinct absolute
paths. Each text is nonempty and bounded to 1 MiB, with current read permission
and protection checks. Authority records the actual explicit approval; hashing
it grants no permission. The failure reference binds the original native
observer receipt, whose required fields are `holdDigest`, `recoveryExitCode: 1`,
`recoveryProviderPrompts: 0`, `allOriginalsUnchanged: true`,
`returnedConfirmedSuccessor: false`, `nextWorkflowStepStarted: false`,
`outcome: "RECOVERY_BLOCKED_BEFORE_PUBLICATION"` and
`reservationFiles: ["request.json"]`. Other native receipt diagnostics remain
intact. These facts must come from the joined observer; do not construct them
from matching files or an incomplete journal.

The action checks the request's exact bytes and complete correspondence to the
confirmed hold, proof and owner. The reservation must contain only its regular
`request.json`. Any derivative, disposition, confirmation, previous `resume`
claim or unexpected entry refuses. Existing publication always writes a
derivative before publishing, so request-only absence together with the joined
failure establishes this bounded prepublication case. This relies on the
repository's retained-history contract: deleted or rewritten publication
history cannot be certified by this action. If history or native completion is
uncertain, remain held.

The admission is exclusive and one-use. An interrupted or refused resumption
stays reserved; another `resume` call cannot overwrite it. Accepted and refused
dispositions link the admission receipt. Success snapshots its authority and
failure inputs and returns the actual confirmed feedback successor. Ordinary
confirmed repeats still use that returned successor without `resume`.

For the original #1400 pilot, start in the **consumer checkout**, use runtime5151's
absolute CLI and configuration, and select the new recovery overlay before the
original EDA owner. An absolute `Dir` does not change the ambient Repository
provider. The consumer owner supplies the measured resumption document and
fresh output paths:

```bash
cd /absolute/consumer4c-checkout
deno run --allow-all --node-modules-dir=manual --frozen --cached-only \
  --config /absolute/runtime5151/deno.json \
  /absolute/runtime5151/packages/cli/src/deno.ts run --allow-absolute \
  /absolute/repaired/examples/adversarial-implementation/reconcile-response.md \
  --props-record /private/tmp/xmd-pullrequest-1400.4n6d_64v/implementation-return.json \
  --props-proof /private/tmp/xmd-1415-pilot-1400-t47h58yq/proof.json \
  --props-resume /absolute/owner/measured-resumption.json \
  --include /absolute/repaired/examples/adversarial-implementation/recovery/components \
  --include /absolute/eda-owner/examples/adversarial-implementation/components \
  --raw
```

Retain stdout, stderr, journal and terminal status under new paths. Only the
consumer owner invokes this historical recovery and its later feedback. This
operation changes no original session, source record, acceptance qualification
or allowance.

## Refusals and next action

The held diagnostic names the missing/mismatched proof class and retained path. Missing or changed frozen guide/input/session/source, unjoined provider work, wrong model/routing, substantive schema conflict, competing results or another failure class remain held. Use existing evidence to resolve the stated fact; this action never selects another result or asks another provider.

A reserved partial or uncertain action remains held, including uncertainty in its confirmation write. Preserve it and its first failure for the owner. There is no automatic retry. The explicit request-only resumption below cannot resolve uncertain publication. A completed refusal is retained, not overwritten by a later corrected proof. Independent response-only repair continues through its existing original-owner contract and allowance; it is not added to this action.

## Read next

Read the [workflow guide](../README.md#run-a-separate-phase-or-continue-a-saved-ticket) for ordinary continuation and the [recorded decision](../../../specs/decisions.md) for the approved amendment. A recovered parse supplies no PASS, completed acceptance row or delivery readiness.
