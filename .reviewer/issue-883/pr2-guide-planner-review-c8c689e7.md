# Planner review: guide assets at c8c689e7

REQUEST CHANGES at `c8c689e7adc4fc6783df1e30539d8da1bc760d96`, parent
`55e5d4a710a6b3bb79e0fff4a205f145ef73df53`, branch `agent/issue-883-pr2`.
HEAD matches, signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. One content blocker remains: the Effection and Lifetimes
worked examples cannot prepare the entries they promise. Admission-gate
increments 1–3, P1/A1 and R2 cases 1/3/4 remain accepted.

## P1 — two safe-to-copy examples are refused before filling the draft

`documents/sidekick/effection.md:32` and `lifetimes.md:31` each show a complete
Sidekick response whose Let body directly contains a `js eval` fence. The outer
four-backtick documentation fence is removed when copying that response; it is
not a passive fence inside the response itself. Core therefore sees an
executable fence in response source and refuses the whole response before
EntryInput runs. Let capture does not exempt that fence from admission.

The prose immediately following each example says the source is passive in the
response and that the draft holds an executable entry. Neither is established.
The required three layers are distinct: the documentation's display fence, the
response's passive capture fence, and the entry's executable fence. The passive
capture must retain the executable fence as part of the draft, rather than
extracting only its JavaScript body.

The examples are also incomplete: `readSomething()`, `openSomething()` and
`useIt()` are neither imported nor defined. The Lifetimes example contains no
resource-owning implementation or cleanup to establish its promised release.
Correct fence nesting alone would not make these complete, executable examples.

This violates the approved agent-writing rule to show complete, safe-to-copy
examples with required bindings and expected results, and the accepted
syntax-discovery requirement for literal source capture and lifecycle teaching.
It is a guide-content correction, not a new product or Core decision.

The [archived probe](pr2-guide-examples-probe-c8c689e7.test.ts) reads the shipped
chapters through the production loader, extracts their displayed response
examples, and evaluates them through a live HostExecution under the actual
Sidekick response ceiling. It uses a recording request fixture solely for the
root's semantic requests. Core performs admission and expansion.

The Guide.Entries example passes as the control and fills the draft once.
Effection and Lifetimes both refuse with zero fills:

> a generated fragment carries an executable code block, which it may not.

That wording is Core's existing error text on this root path. No production
mutation was used. [First output](pr2-guide-examples-probe-c8c689e7.log) is saved.

Command from the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-guide-examples-probe-c8c689e7.test.ts
```

## Accepted implementation and scope

The shipped bootstrap matches the accepted bootstrap text exactly. Six chapter
assets use the approved guide structure. The loader returns the literal files;
the index derives admitted names from the ceiling and purpose text from each
chapter's opening. The omitted-but-readable chapter row discriminates admitted
selection from a hard-coded list. This derivation is within the accepted plan.

No build change or new full compile/npm build is required for this feedback
increment. `scripts/lib/compile.ts` already embeds the entire CLI documents
directory. `scripts/build-npm.ts` recursively selects files under that directory
and copies them into the corresponding emitted tree. The module-relative lookup
uses the existing packaged-document convention. The unchanged packaged-document
test passes. This is source/convention evidence, not a claim that this review
executed a fresh binary or npm package.

The limited increment is acceptable: production SidekickRequests binding and
first-turn delivery remain section 3/4 work. These asset/index rows do not claim
end-to-end guide feedback, initial context delivery, complete R3 or R5. Those
frozen requirements remain in force, including guide context and unfamiliar-agent
teaching assessment. No new cross-runtime or packaging matrix is assigned here.

## Independently rerun evidence

All reported focused commands pass at this SHA:

| Command (`deno task test` with these files) | Result |
| --- | --- |
| packages/cli/tests/repl-journey.test.ts | 39 tests, 71 steps |
| packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts | 46 tests, 176 steps |
| packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts | 13 tests, 64 steps |
| packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts | 19 tests, 54 steps |
| scripts/tests/packaged-document.test.ts | 2 tests, 6 steps |

The four CLI commands total 117 tests/365 steps; packaging adds 2 tests/6 steps:
119 tests/371 steps, zero failures. Logs are beside this review as
`pr2-guide-review-c8c689e7-{journey,entries,storage,layout,packaged}.log`.
The separate example probe has one passing control and two failing cases.
No full suite, fresh package build or CI result informs this verdict.

## Continuity

Preserve c8c689e7. Apply the
[guide-example correction prompt](pr2-guide-examples-implementor-prompt.md)
and return a focused feedback commit before continuing the remaining request
and root wiring. The guide-assets increment is unaccepted until P1 is corrected.
The accepted admission stack stays closed. Section 3 request/read/profile/root
wiring, section 4/R2 cases 2/5/6 and section 5's terminal packet remain incomplete.
No production edit, implementation commit, push, GitHub mutation or memory
compaction was performed by this review.
