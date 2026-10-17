# In-progress correction: a cancelled waiter must not release the active writer

**Waiter correction verified, 2026-10-14.** The preserved probe passes
unchanged: 1 test / 2 steps, cancelled waiter and ordinary control both green.
The current source uses Effection resolver operations and a scoped append,
with distinct cancellation of a queued caller versus release of ownership.
No Promise/async/await appears in history.ts. The promoted R1v pair uses the
storage harness's real file and compares acknowledgement with parsed disk order.
The probe output is retained in
`pr2-configuration-writer-cancel-waiter-corrected.log`.

Verified history.ts SHA-256:
`7743a43a84b8acc0a3e3d8c325b4cd88e5a56fb73c221bb8e1b7e50ec60f83a9`.
The Implementor may continue the existing assignment. This closes only the
waiter/Promise findings on the inspected uncommitted source. CFG9's physical
append shutdown join remains required; the queue probe does not test it. No
feedback SHA or whole-slice acceptance exists yet. The request below is history.

Correct the uncommitted SidekickWriter foundation before continuing the mounted
Configure/Retry work. This is an existing CFG8/CFG9 requirement, not a new
architecture or product decision. The rest of the bounded assignment remains
authorized; no intermediate feedback commit is requested.

## Inspected state

Branch agent/issue-883-pr2 remains at signed accepted
`bb60ca35661c2988ef647cc7a456470482d06e2e`. Four files are modified:
sidekick/history.ts, sidekick/owner.ts, sidekick/model.ts and
repl-sidekick-configuration.test.ts. No production file was changed by the
Planner. This is not acceptance of the uncommitted work or a review of a new SHA.

Inspected history.ts SHA-256:
`8918627ed00fb799e7885d0507d9ece5382557a70d659d0173fe339e68ddf92b`.

## Findings

1. `SidekickWriter.append()` unconditionally resolves its own promise in finally,
   including cancellation while waiting for its predecessor. With A held in a
   physical host append, B waiting for A and C waiting for B, cancelling B
   releases C while A remains held. The host is entered concurrently and
   acknowledgement order becomes C then A. Removing B from the wait must not
   remove A's ownership of the writer.
2. `private writing: Promise<void>`, Promise.resolve() and new Promise() implement
   application-owned synchronization with Promises. AGENTS.md Code Rule 1
   requires Effection generators/operations and says not to use Promises.
   Wrapping the promise with until() does not turn this into an adaptation of an
   external promise API; this synchronization is authored here.

The simple successful two-caller ordering and the reported focused suites do
not establish cancellation safety. No full suite, CI or delivery check is needed
to correct these findings.

## Preserved reproducer

Run from the implementation checkout:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configuration-writer-cancel-waiter-probe-bb60ca35.test.ts
```

The first output is retained in
`pr2-configuration-writer-cancel-waiter-first.log`. The regression fails; the
ordinary-ordering control passes. Observations:

```text
cancel middle:
  third entered host while first held: true
  host entry:       first, third
  acknowledged:    third, first

ordinary ordering:
  third entered host while first held: false
  host entry:       first, middle, third
  acknowledged:    first, middle, third
```

The host hold establishes the writer's predecessor is still active. The short
timeout only bounds waiting for the forbidden host entry. This probe tests the
writer's operation ordering through the real ReplHost boundary; it does not
claim filesystem publication or mounted evidence.

## Required correction and continuation

- Replace the authored promise chain with Effection-native synchronization.
  Internal helpers/factoring remain delegated; introduce no public API, second
  writer or durable queue.
- A cancelled waiter appends nothing and cannot release a successor past an
  active predecessor. Preserve ordering for the remaining live callers and
  release genuine ownership on success/failure without wedging the writer.
- Keep the assigned physical-append requirement: after host write starts, join
  its completion and local publication/failure before releasing the writer.
  An unconditional finally release by itself does not prove this. The remaining
  CFG9 work still supplies the shutdown evidence; do not claim it complete now.
- Pass the preserved probe unchanged. Promote this cancellation regression and
  its ordinary control into CFG8's existing storage destination, using the
  storage harness's real filesystem/host gates. It supplies the already frozen
  cancelled-waiter/order observation; do not add a broader permutation matrix.
- Rerun affected storage/recovery/configuration evidence after the correction.
  Then continue the existing mounted assignment, complete CFG1–CFG9 and its
  three controls, and run all six commands after the final edit before the one
  signed feedback commit. Keep the first failure log; do not replace it with a
  passing rerun. Report this correction in the handback.

The model/owner/R7 work is not rolled back or accepted by this notice. Leave it
in place while correcting the writer. Keep bb60ca35 reachable, signing enabled,
and the existing no-push/GitHub/CI/capture limits. No permission or new ruling is
needed to restore the assigned ordering and repository code rule.
