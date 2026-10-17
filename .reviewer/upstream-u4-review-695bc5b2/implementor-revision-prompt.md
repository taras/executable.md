# U4 remaining retention correction

```text
You are .agents/implementor.md. Continue the existing authorized U4 worktree from signed revision 695bc5b2f15180b5a5096bfa51a20b690cce1cbd. Planner verdict: REQUEST CHANGES; one blocker remains.

Read:
  /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/upstream-u4-review-695bc5b2/planner-review.md
Reproduce:
  /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/upstream-u4-review-695bc5b2/pinned-read-probe.mjs

The original static validation paths, registration's retained copy and independently loaded provider evidence are accepted. Do not redesign those or reopen the frozen contract.

Remaining defect: admitOffered checks definitionGeneratedRefusal, which validates an owned metadata copy but discards it. Direct observation/mutation admission then reads the caller's metadata again. An identity accessor returning the valid owner URL once and not-a-url next still appends a corrupt admitted record before failing as unreadable history. Both public pinned constructors reproduce this.

Capture/retain once, validate the owned definition/metadata and use that same value for the selected forms, URLs, policy and invoked definition. Preserve exact fn identity, shared definition per name, form dispatcher/protected routing and Json composition. A consistent early rejection of accessor-shaped input also meets the defensive-read contract. Do not add a new public protocol, registry, context or API.

Commit a regression in the existing GXC2c/direct-entry tier with the alternating input and stable positive control; verify observation and mutation paths do not append unvalidated data. Retain a reversible control showing check-then-reread makes the regression fail. Restore controls and rerun affected/frozen feedback evidence.

Return a new signed SHA/tree/base, clean status, diff totals, row map and all command/control results. The twelve rows and ten frozen commands are unchanged. No repeated implementation authorization is required.

Do not push, open a PR, inspect CI, modify the immutable preservation copy, perform cleanup, or start U5/#902 work.
```
