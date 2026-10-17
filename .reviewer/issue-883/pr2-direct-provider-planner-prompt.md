# Planner prompt: resume #883 PR 2 with direct provider calls

You are the Planner for #883 Sidekick PR 2. Prepare the replacement Implementor
assignment for P1. The Architect has completed the design in:

`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-direct-provider-architect-handoff.md`

When a Sidekick chat opens, Core reads its provider object from Context once
and calls that object's methods directly. Ordinary Agent middleware cannot
change which session receives this chat's prompt. Core keeps its existing
configuration checks and canonical history. The concrete four-method interface,
installation/lifetime contract, ACP integration, private completion evidence,
shared prompt runner and permission-audit requirements are specified in that
handoff. No capture() method or per-call inspection exchange is assigned.

## Base and review records

Implementation worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`

Branch: `agent/issue-883-pr2`.
Exact base: `08c95ca28fdf71a9a3a32b08fdd0f9abe8ed40cd`.
Parent: `ef68c71ca26d24856e6a4a1e9d24943bd37876d1`.
The worktree was clean at this base when the handoff was prepared. Verify it;
if it has advanced, reconcile the actual delta before assigning a new base.
Do not reset, amend or discard work.

Records are in the main checkout:
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/`.

Read the new Architect handoff first, then these records for their evidence and
the configuration behavior that stays settled:

- `pr2-configuration-result-architect-review-08c95ca2.md`
- `pr2-configuration-request-routing-architect-return.md`
- `pr2-session-configuration-planner-handoff.md`
- `pr2-session-configuration-implementor-handback.md`

Read main `.agents/architecture-rules.md` rules 23–25 and `AGENTS.md` Code Rule
15; the implementation checkout's older instructions do not yet contain that
approved amendment. Read the affected implementation and specifications at the
assigned base. Do not overwrite unrelated main-checkout changes when carrying
the exact approved instructions into the branch.

P2 is closed. P1, increment 4 and R2 remain unaccepted. The historical session
inspection protocol, prompt inspection proposal and capture() proposal are
superseded; they must not become requirements in the new assignment.

## Produce the bounded assignment

1. Trace the source locations named in the Architect handoff. Define one
   coherent correction increment; do not split at a point where the chat has
   switched paths but its checks or audit are missing.
2. Specify affected files, ordered work and documentation changes. Keep the
   four-method public interface and ownership fixed; leave local helpers and
   factoring to the Implementor.
3. Freeze a finite evidence matrix from the handoff's five consequences.
   Preserve SC1–SC7. Select the permanent real-ACP routing regression, the
   prompt-substitution check, a genuine-completion refusal, direct audit/
   checkpoint coverage and the minimum readiness case. Reuse current fixtures
   and suites rather than inventing a permutation matrix.
4. Keep the original probes and first logs unchanged. The real-ACP
   missing-configuration regression must still refuse for missing configuration,
   rather than accidentally pass because no direct provider was installed.
   Middleware-only conversation stubs must be migrated to the new service;
   ordinary Agent middleware tests remain ordinary.
5. Name every focused command required for the feedback commit. Begin with the
   three selections and the known `agent-function-components.test.ts` consumer
   in the Architect handoff; add only further known affected checkpoint or
   integration consumers. Separate feedback evidence from delivery
   checks. Preserve first failure output.
6. Give the Implementor a self-contained prompt explicitly replacing the old
   routing hold with this assignment. Preserve the exclusions: no settings UI,
   live configuration updates, wider coordinator, permission Context flag,
   global ordinary-session restriction, other API refactor, mounted section 5,
   terminal packet, push, GitHub mutation or CI inspection.

Write the revised plan/evidence and Implementor prompt in the main checkout as:

- `.reviewer/issue-883/pr2-direct-provider-planner-handoff.md`
- `.reviewer/issue-883/pr2-direct-provider-implementor-prompt.md`

Link them from the packet README and return the exact starting SHA plus the
ready-to-send Implementor prompt. The Implementor commits promptly after the
assigned focused evidence passes and hands back the signed feedback SHA,
parent, branch, tree status and commands/results. Do not declare P1 or R2
accepted merely because the assignment is ready. Do not implement production
code as the Planner.
