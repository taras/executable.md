---
description: Read exact correction instructions. Use <Guide.ExactCorrection /> before offering a patch.
---

# Close an exact reviewed correction

Read this when a sole selected medium reviewer knows the complete remaining correction and can independently inspect its exact patch.

## Applies to

Reviewer responses, implementation handoffs and Ticket REPL entries.

## Instructions

Return `changes_required` with `exactCorrection` only after inspecting the entire proposed patch. The offer conditionally accepts its resulting Git tree; it does not report PASS on an unseen commit. Omit the offer when judgment, evidence, another reviewer or high effort is still required. Repository permissions and role boundaries apply to authoring the patch.

Save one UTF-8 Git patch under the reviewer artifact directory and include that path in artifacts. Bind its bytes with `git hash-object --no-filters`, name the inspected signed base and resulting tree, and list focused checks as literal argv arrays. Determine the resulting tree with an invocation-owned temporary index or scratch checkout. Leave the assigned checkout unchanged. The patch may include file modes, additions and deletions: the tree commits to the whole tracked result.

The original implementer applies the patch and makes one signed child commit. Ticket settlement verifies the base, patch bytes, predicted tree, actual tree, parent, clean checkout and signature, then executes the listed checks itself. A failed check is preserved and holds the ticket without an automatic rerun. Source or parent differences return to ordinary review without executing the conditional checks. An altered patch, signature failure or source mutation during a check holds for reconciliation.

Conditional acceptance has its own receipt and reviewer provenance. Delivery requires that receipt on the actual feedback commit. The original changes_required result and prior review SHAs remain unchanged. Other delivery checks and publication authority remain in force. New execution snapshots use this behavior; saved executions keep their original workflow.

## Example

A reviewer result includes this object alongside its normal assessment, handoff, evidence and artifact fields. Replace every path and hash with inspected values; use the actual focused test command.

```json
{
  "exactCorrection": {
    "schema": "exact-correction.v1",
    "baseRevision": "1111111111111111111111111111111111111111",
    "targetTree": "2222222222222222222222222222222222222222",
    "patch": "/absolute/review/fix.diff",
    "patchBlob": "3333333333333333333333333333333333333333",
    "checks": [{"name": "focused regression", "argv": ["deno", "task", "test", "packages/cli/tests/affected.test.ts"]}]
  }
}
```

The workflow keeps the normal reviewer call, correction bound and implementer call. It omits the final reviewer conversation only when the implementer's exact signed result satisfies the recorded offer and its checks. Standalone phase orchestrators must explicitly use ExactCorrection.Prepare and ExactCorrection.Verify and preserve the reviewer and implementation call provenance; merely adding the JSON field does not close any gate.

## Common mistake

A passing implementer-reported command is not the conditional check receipt. Let settlement run the reviewer-selected argv on the exact signed commit. Any additional source edit needs ordinary review.

## Read next

Use `<ExactCorrection.Prepare assignment={assignment} result={result} role="planner" resultPath={resultPath} as="approval" />` to retain a validated offer and `<ExactCorrection.Verify repository={repository} approval={approval} revision={revision} as="receipt" />` after the signed correction. Use `<Ticket.Reviewed record={ticket} as="reviewed" />` before delivery.
