# Revalidate an original joined reply without another provider call

Use this interface when an original implementation reply completed but extraction left its Ticket held without a canonical result. It validates retained evidence and publishes one separate derivative at the original feedback gate. It does not perform feedback or implement missing acceptance work.

## Applies to

The explicit native file entry and direct native REPL component invocation. Select the recovery include before the existing owning workflow include. For #1400, keep the owner at eda5c08a9fbcc4a308537b17f0b9547108fbc748. Do not select current-main's ordinary Ticket loaders in place of that owner. The repaired CLI supplies the new action; its include composition supplies the unchanged owner.

## Public interface

File entry `examples/adversarial-implementation/reconcile-response.md` has exactly two required props, with no other props:

- `record: string`: absolute path to an existing confirmed Ticket return. Initially this is the original held return. On a confirmed repeat, supply the actual confirmed successor returned by the prior successful action.
- `proof: string`: absolute path to the proof document below. The first admitted observation is snapshotted. A confirmed repeat hydrates that same recorded proof and evidence; it does not refresh original files.

Component `Ticket.ReconcileResponse` has exactly two required props:

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

For a confirmed repeat, invoke reconcile-response with the retained confirmed successor as record and the same proof reference. It returns exactly that envelope with no writes, prompts, source checks or successor dispatch. A different proof identity refuses. Reusing the old held input after reservation is held: supply the actual successful returned successor if it exists, or obtain operator disposition if completion was lost. A result or confirmation file alone cannot replace that returned acknowledgment.

## Refusals and next action

The held diagnostic names the missing/mismatched proof class and retained path. Missing or changed frozen guide/input/session/source, unjoined provider work, wrong model/routing, substantive schema conflict, competing results or another failure class remain held. Use existing evidence to resolve the stated fact; this action never selects another result or asks another provider.

A reserved partial or uncertain action remains held, including uncertainty in its confirmation write. Preserve it and its first failure for the owner. This repair introduces no automatic operator-disposition path. A completed refusal is retained, not overwritten by a later corrected proof. Independent response-only repair continues through its existing original-owner contract and allowance; it is not added to this action.

## Read next

Read the [workflow guide](../README.md#run-a-separate-phase-or-continue-a-saved-ticket) for ordinary continuation and the [recorded decision](../../../specs/decisions.md) for the approved amendment. A recovered parse supplies no PASS, completed acceptance row or delivery readiness.
