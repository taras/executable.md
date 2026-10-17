# Implementor handoff: validate REPL descriptions without mounting

**PASS, 2026-10-13:** implemented at
`a49229e983f35764ce59f92f43de37c15473e32f`, parent 135063e6.
[Planner review](pr2-validation-planner-review-a49229e9.md) accepts RV1–RV4;
the assigned command independently passes 58 tests/201 steps. The intervening
ACP specification-only correction is accepted there. This assignment is
closed; required host recording starts separately from a49229e9.

Expose the existing description checks on the returned ReplTree. Calling
validate does not change the mounted tree, focus or frame; apply still checks
every desired tree before changing it.

## Starting point and accepted interface

This is increment 2. [The mechanical rename](pr2-session-rename-planner-review-9f15dc51.md)
is PASS at `9f15dc516ab8108efb3d4d19f970e32ffbe60000`, parent
`b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, on agent/issue-883-pr2.
That exact accepted rename revision is this increment's starting SHA.
Verify a clean worktree before starting; keep this API correction in its own
feedback commit.

Worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Authority is [the accepted Architect handoff](pr2-session-vocabulary-architect-handoff.md)
and its [decision](pr2-session-vocabulary-architect-decision.md).

```ts
validate(descriptions: readonly ReplDescription<Action>[]): Result<void>;
apply(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>>;
```

useReplTree receives no validation predicate. Remove layoutAllowed from both
useReplTree and validateDescriptions' walk; there is no replacement callback.
The synchronous validate operation performs the complete current description,
key, focus and modality checks, without creating/updating/removing/drawing
nodes, changing focus or incrementing the frame. A successful validation is
not a reservation. apply always repeats those checks on the values actually
supplied to it.

## Implementation

1. In packages/cli/src/repl/description.ts, remove the callback and its
   synthetic "parent does not accept this layout" refusal. Preserve the actual
   description issuance, duplicate-key, focus and modal checks and their
   Result behavior. Reuse this one validator.
2. In packages/cli/src/repl/reconcile.ts, add validate on ReplTree, remove the
   argument from useReplTree and delegate validate to the existing complete
   validator. Keep apply's pre-mutation validation inside its existing commit
   path; keep serialized commits and joined retirement/cleanup unchanged.
3. Update the one composition fixture that injected a predicate. Deliberately
   retire only its synthetic slot: nowhere rejection and callback argument.
   Preserve duplicate-key and conflicting-focus refusals and no-mutation
   assertions. Keep all other production callers on the existing no-argument
   useReplTree path.
4. Update the current REPL reconciliation/description contracts in architecture.md
   and specs/repl-spec.md to the accepted two methods and callback removal.
   Do not mount Sidekick or add a second layout policy.

## Frozen evidence

| Row | Required observation |
| --- | --- |
| RV1 — validation is read-only | On a nonempty mounted tree with known focus, record node IDs, focus, frame ID/cells and the fixture lifecycle journal. validate of a valid proposed change returns Ok, and validate of duplicate keys and conflicting focus returns Err; all recorded observations remain unchanged and no child is attached, updated, drawn or removed. |
| RV2 — apply protects itself | apply of the invalid duplicate-key/conflicting-focus descriptions refuses without any prior validate call and preserves the mounted tree, focus, frame and lifecycle journal. Preserve the existing modal/issued-description refusal assertions. |
| RV3 — no reservation | validate a valid description array, then change that desired set to an invalid duplicate-key set before apply. apply refuses without mutation. A subsequent valid apply still commits normally. |
| RV4 — accepted retirement | The single synthetic custom-slot/callback case is removed. No second validator or caller-supplied predicate replaces it. Existing composition and presentation behavior remains green. |

Add these observations to packages/cli/tests/repl-composition.test.ts using
its real tree/component fixtures. The paired successful apply prevents passing
by refusing everything. No new terminal matrix or frame capture packet is needed.

Run:

```text
deno task test packages/cli/tests/repl-composition.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-presentation-style.test.ts
```

This covers the complete validator, mounted reconciliation and its known
frame/focus consumers. No full suite, check, check:jsr, lint or CI is required
for this feedback increment. No mutation exercise beyond the observations
above is assigned.

Commit promptly after RV1–RV4 and this command pass; return exact signed SHA,
parent, branch/tree status, command/result and the precisely retired assertion.
Preserve first failure output. Stop for Planner review before required host
recording or configuration work.

Produced artifact: this file. Architecture and names are settled. Actual base:
9f15dc516ab8108efb3d4d19f970e32ffbe60000. Next Implementor action:
implement steps 1–4 and return one API feedback commit. No owner acquisition,
mounted section 5, R7/R8 packet, push, GitHub mutation or CI inspection.
