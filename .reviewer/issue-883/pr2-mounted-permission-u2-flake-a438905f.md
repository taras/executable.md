# Flake evidence: REPL permission U2

Status: reproduced intermittence at unchanged signed
`a438905f8fa98d245bb6444058bd470f1312411b` on 2026-10-14.
The cause is not fixed. This is a local record for a dedicated issue labelled
`flake`; no GitHub issue was created or searched because this review explicitly
excludes GitHub mutation and CI inspection. Check for an existing issue before
filing when GitHub work is authorized. A green rerun does not close it.

## Observation

The REPL permission test answers one pending request and expects a separate
background turn named build to be visible. In the first review run,
`session.agent.turns.some((turn) => turn.prompt === "build")` was false at
packages/cli/tests/repl-agent-interface.test.ts:1524. The same test passed
without a source, fixture, environment or dependency change on its isolated
rerun. The permission result, drawer and focus assertions preceding it passed.

This file has no changes in the correction under review. The prior review at
86debcb9 passed the same selection. The current correction changes handoff and
reply-Submit plumbing, while this row exercises an ordinary permission through
ReplSession and the view. No causal fix is claimed.

## Reproduction evidence

Runtime: Deno 2.9.7 stable, aarch64-apple-darwin; V8
15.0.245.2-rusty; TypeScript 6.0.3. Local macOS execution, no CI run URL.

First command:

```text
deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-forms.test.ts
```

Result: 70 tests / 184 steps passed; one test / one step failed.
[Complete first output](pr2-mounted-review-a438905f-journey-first.log)
contains the assertion and stack. The generic Deno unsafe-proto hint follows
the assertion; it is not the observed failure.

Unchanged isolated rerun:

```text
deno task test packages/cli/tests/repl-agent-interface.test.ts
```

Result: 14 tests / 40 steps passed, zero failures.
[Complete rerun output](pr2-mounted-review-a438905f-agent-interface-rerun.log).

The same full four-file selection also passes unchanged: 71 tests / 185 steps,
zero failures. [Full-selection rerun](pr2-mounted-review-a438905f-journey-rerun.log).
Both full-selection logs are preserved. Investigate the
background turn's readiness before choosing a fix. Do not replace the
assertion with a delay or drop its independent-background-work claim.

This record tracks test intermittence separately from M-P1/M-P2 acceptance.
No production/test change or extra Implementor assignment is made here.

## Recurrence at 57773de0, 2026-10-14

The same assertion failed while reviewing signed clean
`57773de05246578da77c0f8689fbee004cbd84b4`, parent d4f38f6e. The test file is
unchanged by this correction. Runtime remains Deno 2.9.7 stable,
aarch64-apple-darwin; V8 15.0.245.2-rusty; TypeScript 6.0.3. There is no CI URL;
this was a local review with GitHub mutation/inspection excluded.

The first four-file selection again reported 70 tests / 184 steps passed and
one test / one step failed at repl-agent-interface.test.ts:1524. Full output:
[first run](pr2-configuration-review-57773de0-journey-first.log).
The source, fixture, dependencies and environment were left unchanged. The
isolated file then passed 14 / 40:
[isolated rerun](pr2-configuration-review-57773de0-agent-interface-rerun.log).
The whole selection passed 71 / 185:
[selection rerun](pr2-configuration-review-57773de0-journey-rerun.log).

The assertion was not weakened or delayed. The cause remains unfixed; the green
reruns do not close this record. No GitHub issue was created under the existing
no-mutation limit. The deterministic Apply-report finding at this SHA is tracked
separately in the configuration review and is not attributed to U2.
