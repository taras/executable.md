# Implementor correction: read the valued option in the specification example

Continue from signed `1d373a61cbb6266e4dd90bf17c8076c278174b0f`, parent
6e3a7b37, on agent/issue-883-pr2. Preserve the production independent
--sidekit-agent selection, immutable profile data, view/right codec and typed
state transitions. The Planner found no production defect in those changes;
all three frozen commands pass independently.

Fix the existing D1 example reader in packages/cli/tests/repl-boundaries.test.ts.
The newly shipped valid example `xmd repl --sidekit-agent claude` fails because
the reader removes option tokens but leaves their values among positionals,
then passes claude as the location to replGrammarError. The exact first failure
is pr2-selection-review-1d373a61-boundaries-first.log. The review is
pr2-selection-planner-review-1d373a61.md.

Read the example's actual option/value ownership before identifying its optional
location. Reuse the production grammar/parser where appropriate; ordinary
test-helper structure is delegated. No general shell parser or new public
cross-package interface is needed. Keep the separated-value usage example.
Preserve the checker’s invalid-location, unknown-option and extra-location
claims; do not guess that only tokens beginning with xmd:// can be positional,
skip validation by always passing an absent location, or weaken assertions.
Keep the existing negative controls. This assigns no new permutation matrix.

Correct the stale phrase "one of those five options" in specs/repl-spec.md's
command-line refusal paragraph: the command now has six. Do not alter
production parsing or remove the new flag example to make the checker pass.
The empty-next-token correction and contextualAgent extraction are accepted
within the current implementation scope and need no separate product decision.

For this test-reader/prose-only correction, run this finite command from the
implementation worktree:

```text
deno task test packages/cli/tests/repl-boundaries.test.ts packages/cli/tests/cli-help.test.ts
```

The three previously frozen selections need not be repeated for unchanged
production. If production selection or routing changes become necessary,
return the concrete reason rather than widening this correction silently.
No full suite, check, lint, CI or additional mutation exercise is required.

Commit promptly after the focused command passes. Return exact signed SHA,
parent, branch, tree status, command/result and the checker adaptation.
Preserve the first failure and stop for Planner review. This correction does
not authorize the mounted section 5 surface, owner acquisition, another recovery
change, push, GitHub mutation or CI inspection. Creation-policy compatibility
remains separately with the Architect; R2 is not complete.
