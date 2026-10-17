# PR 2 architecture review — fatal-precedence correction

**PASS** on `ecca5c459b77bed653bcdeab5efd4f9ab656bb2e`.
The fatal-precedence blocker is resolved. No architecture blockers remain for
the PR 2 implementation at this exact commit.

## Reviewed boundary

Reviewed local feedback on 2026-10-10. Parent:
`a85c36cb2edc184055b9aa3e270ba1d70b20670f`. Main base:
`160e354e47f6fbeb1c792e6799c1fe26b2f155fc`.

This is the unpublished correction handed over in
[pr2-fatal-precedence-implementation-handback.md](pr2-fatal-precedence-implementation-handback.md),
on `agent/issue-881-pr2-fatal`. It changes only
`packages/core/src/component-expansion.ts` and its focused test file.
The preceding [architecture re-review](pr2-published-architecture-rereview.md)
remains the historical verdict on `a85c36cb`; this PASS applies to `ecca5c45`.

The seven frozen checks in [pr2-planner-handoff.md](pr2-planner-handoff.md)
remain the review boundary. The preceding complete review found only failure
selection blocking. This review examines the complete correction, checks it
against established reconciliation and reruns the discriminating evidence.

## Blocker resolved

`selectedFailure` examines both canonical and middleware failures after the
complete dispatch unwinds. It uses the existing cause-graph searches and
established ordering: durability first, Files fatal second, then canonical
ordinary failure. Canonical preference within a fatal kind is preserved.
`chainFailed` retains the distinction between no middleware failure and a
middleware operation that raised `undefined`.

The raised branch selects once. That same selected failure supplies the
authoritative throw and the detached terminal report. The existing reporting
boundary preserves diagnostic name, message and explanatory causes without
exposing canonical failure identity or fatal branding.

The previously failing public-middleware reproducer now passes for both the
successful-body control and the ordinary-body/fatal-teardown competition.
The four new production-suite regressions pass for persistence precedence,
Files precedence, canonical ordinary-failure precedence and failure after a
successful body. Their terminal-report assertions verify the selected outcome
and reporting detachment.

The success and refusal paths, once-only delegation, publication, cleanup and
cancellation ownership are unchanged. The correction adds no execution
capability, public API, persistent state, resource owner or session consumer.
Source inspection, generated capability narrowing, prefix isolation and the
measured presentation boundary retain the previously reviewed implementation.
No new architecture decision or amendment is needed.

## Independent focused evidence

Ran these checks in the already prepared, clean implementation worktree
`.claude/worktrees/pr2-fatal`, verified at the exact feedback SHA before and
after execution:

```sh
deno task test packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
# exit 0 — 53 tests / 418 steps
deno task test packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts
# exit 0 — 14 tests / 52 steps
git diff --check 160e354e ecca5c45
# exit 0
```

Saved outputs: [Core](evidence/pr886-ecca5c45-core.log) and
[lifecycle/Agent execution](evidence/pr886-ecca5c45-lifecycle.log).
Total: 67 tests / 470 steps, all passing.

Adapted only the exact-worktree import paths in the original independent
[reproducer](evidence/pr886-ecca5c45-fatal-precedence.test.ts). Ran from the
repository containing this record:

```sh
deno test --allow-all --node-modules-dir=manual --cached-only --frozen --config .claude/worktrees/pr2-fatal/deno.json .reviewer/issue-881/evidence/pr886-ecca5c45-fatal-precedence.test.ts
# exit 0 — 1 test / 2 steps
```

Its [output](evidence/pr886-ecca5c45-fatal-precedence.log) confirms the prior
failure is corrected independently of the implementation's new tests.
The source digest is
`2aed06e7108ea104ffd6d8ea87b6c258a8e83ee6a1a89e7d325051f1d1b313bb`, matching
the handback's restored implementation. The implementation worktree remains
clean.

The handback's mutation control is reported evidence; this review did not
repeat the mutation or modify production code. Existing CLI visual evidence
belongs to its recorded revisions and was not recaptured here. No CI was
inspected and no GitHub review was posted.

## Continuity

PR 2 architecture review is complete at `ecca5c45`. The reviewed correction
remains local; nothing was pushed or applied to the published stack by this
review. PRs #887 and #889 retain their separate contracts and reviews. This
verdict does not close the complete #881 parity Story.
