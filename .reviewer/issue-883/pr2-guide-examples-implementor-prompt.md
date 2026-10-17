# Make the shipped Effection and Lifetimes examples work

Completed and accepted at `9a9d2a041e0dfb825c7f51ef0589e83616d5f86c` in the
[Planner review](pr2-guide-planner-review-9a9d2a04.md). The instructions below
record the completed correction. Continue with planner-handoff.md's next action;
do not repeat this correction.

Correct `c8c689e7adc4fc6783df1e30539d8da1bc760d96`, parent
`55e5d4a710a6b3bb79e0fff4a205f145ef73df53`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.
The [Planner review](pr2-guide-planner-review-c8c689e7.md) accepts the asset
placement, loader/index approach and unchanged packaging path. One content
blocker remains in the Effection and Lifetimes examples. Preserve the increment
and the accepted admission stack; no Core or product change is requested.

## Required correction

Read `.agents/agent-writing.md`, the accepted syntax-discovery amendment and the
[probe](pr2-guide-examples-probe-c8c689e7.test.ts) with its
[output](pr2-guide-examples-probe-c8c689e7.log). Core refuses both displayed
responses before any draft fill because each directly contains an executable
fence. The Entries example is the passing control.

Correct `packages/cli/src/documents/sidekick/effection.md` and `lifetimes.md` so
their examples are complete, safe to copy and produce the outcomes they state:

- Distinguish all three fence layers. The documentation displays a complete
  response; that response captures a passive source block; its captured string
  includes the executable fence belonging to the future entry. Use successively
  longer enclosing fences. Do not merely change the executable fence to passive
  and leave the resulting draft as non-executable JavaScript prose.
- Replace `readSomething`, `openSomething` and `useIt` with complete code using
  real supported capabilities. Include the required imports and definitions.
  Keep examples small, safe and free of external-service or provider dependency.
- Make the Lifetimes example actually establish ownership and release of the
  resource it describes. A native handle does not acquire cleanup merely because
  a sentence says it does. Use the existing supported lifecycle mechanism and
  describe the observed result accurately.
- Align the explanation with the exact response, captured draft and entry
  outcome. Preserve the context distinction, literal source, generator/yield*
  teaching and ordinary teardown contract.

No guide catalog redesign, new language feature, permission widening, build
change or new response-owner work belongs in this correction.

## Finite evidence and feedback

Integrate the two corrected asset examples and the Entries control into the
existing guide/control test boundary. Extract the examples from the shipped
files rather than copying them into an expected-text fixture. Adapt extraction
to the actual longer documentation fences without weakening the assertions.

For each corrected example, use the real generated-root evaluator and response
ceiling to prove it fills the draft once with the executable entry source still
literal. Run that exact prepared source through the ordinary entry path to prove
the stated successful result; the Lifetimes case must observe the described
release before entry completion. This closes the existing complete-example
requirement, not a new lifecycle or cancellation matrix. Keep the Entries
positive control and existing index-narrowing row.

Run the focused regression/control, then the same commands as this increment:

```sh
deno task test packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts
deno task test scripts/tests/packaged-document.test.ts
```

Capture first failures. Commit promptly once this focused evidence passes and
return exact SHA/parent, every command/result and the example/outcome mapping.
No full suite, fresh binary/npm build, lint/check, JSR or CI wait is required for
the feedback commit. Packaging can continue using the existing convention.

## Continuity

Base is c8c689e7. This prompt, the linked review and planner-handoff.md govern
the correction. The guide-assets increment remains unaccepted; increment 3 at
55e5d4a7 and R2 cases 1/3/4 remain accepted. Stop for review after the correction,
before continuing section 3 request/read/profile/root wiring. Section 4/R2 cases
2/5/6 and section 5's terminal packet remain incomplete. No push, GitHub write,
CI inspection, memory compaction or unrelated PR work is authorized.
