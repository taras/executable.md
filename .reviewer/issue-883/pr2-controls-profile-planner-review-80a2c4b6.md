# Names correction and Core Syntax integration

Reviewed `80a2c4b604e039cdacec663efdef60b063484b74`, parent
`dc87c5fdf0358f40933dd66bd388c041194296de`.

PASS for the names-array correction. REQUEST CHANGES remains for the controls
and profile slice until canonical response-context Syntax works.

Canonical Syntax admission and dispatch are supplied at `66d330dd`; the
[next review](pr2-core-syntax-planner-review-66d330dd.md) closes the original
refusal and records the remaining named-documentation gap.

## Resolved finding

REPL.Syntax now accepts the canonical optional non-empty, unique string array
and passes it unchanged to the semantic request. R3f exercises the approved
`names={["Elicit"]}` spelling. R3b correctly separates designation from
admission. The unchanged Planner probe's names-array step and bare-read control
both pass.

## Confirmed Core omission

The Implementor's diagnosis is correct. `evaluateGeneratedXmdRoot()` calls
`evaluateGenerated()` with both the protected component route and syntax
reference absent. Its generic admission table also does not contain canonical
Syntax. The protected fragment path carries those inputs internally; the host
root path does not provide an equivalent. The prior review's instruction to
resolve this entirely from the CLI through an existing admission entry was
incomplete. Deriving a reference alone is not the entire correction: canonical
protected admission and dispatch must also reach that reference.

The accepted architecture already requires self-closing canonical Syntax in
the response read class, describing that response's vocabulary and preserving
ordinary render/capture without automatic operation feedback. This is a missing
implementation of that contract, not an unresolved product decision.

## Delivery decision and Implementor prompt

Make the Core correction now, as a separate Core-focused commit on the current
PR 2 branch. Keep the two-PR delivery split. Do not defer this required response
capability to a later follow-up or rewrite the accepted PR 1 feedback history.

Use the existing GeneratedXmdRequest shape. Core owns the syntax reference,
canonical protected implementation and its dispatch. Derive the reference from
the vocabulary this generated root actually admits, using the canonical symbol
and documentation machinery. Preserve the read class, selected permissions,
pinned identities and retained admission comparisons. Keep ordinary Syntax
render/capture and retained text semantics, and include its admission in the
CLI's compact response description. It is not a designated Sidekick control
result. A CLI stand-in, ambient host executable vocabulary, new generic evaluator
or new request field does not satisfy this correction.

Retain the released fragment path and its reference behavior. Update the
affected architecture/specification text to describe the implemented root
reference. Remove the temporary source commentary describing this omission once
the correction is complete.

Provide a focused Core root regression for canonical Syntax describing the
actual response context and retaining ordinary capture. These are existing
contract requirements. Run that regression, the unchanged Planner probe and
the focused commands below. Commit promptly when this evidence passes and hand
back the exact SHA/parent and commands/results. This correction does not wait
for guide assets, the root gate or the conversation owner.

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts
deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-controls-dc87c5fd.probe.ts
```

## Evidence at this revision

Working directory:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.

The four CLI Sidekick tiers above pass: 13 tests, 69 steps.

The unchanged Planner probe reports two passed steps and one failed step.
Canonical Syntax remains refused as an unadmitted component. Its first output
at this revision is preserved in
[pr2-controls-80a2c4b6.probe.log](pr2-controls-80a2c4b6.probe.log).

No production files were changed by the Planner. The reviewed implementation
worktree is clean. No CI or GitHub state was inspected or changed.

## Continuity

The handoff records this correction in section 3. PR 2 remains incomplete;
previously accepted storage, projection, recovery and output evidence remains
accepted. Next action is the Core Syntax correction above, followed by the
planned root gate, separate revisions, reservation and R2 cases 3/4. No new
product choice, third PR or GitHub-write authorization is introduced.
