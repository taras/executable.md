# Planner review: section 5 selection and location data at 1d373a61

REQUEST CHANGES at `1d373a61cbb6266e4dd90bf17c8076c278174b0f`, parent
`6e3a7b37de43e66d99c8ff9836e6f7e2fa3dd969`, branch agent/issue-883-pr2.
The SSH signature verifies G for tarasm@gmail.com; the worktree is clean.
One changed specification-check boundary is red. No production selection or
routing defect was found in this increment.

## Changes that satisfy the assignment

The real command adds only the accepted --sidekit-agent spelling, carries its
value through assembleReplProfile and retains the resolved sidekickAgent on the
immutable profile passed to runReplProgram. Explicit Sidekick selection does
not fall back to entry --default-agent. contextualAgent extracts the existing
contextual environment/package-default expression without changing entry or
Plan precedence. ReplProfileFacts extends the existing optional assembler
parameter without changing its existing callers. No second provider stack,
owner acquisition, options inspection or agent-command resolution is added.

The generic empty-next-token refusal is accepted as a correction of the same
valued-option grammar, rather than a new product choice. Inline empty values
already refuse; this makes the separated empty spelling agree for the three
existing/new valued REPL options. Nonempty shared flags and permission
exclusions retain their behavior. No broader CLI policy is assigned.

view/right encode after the existing session member and preserve omissions.
The codec refuses invalid, empty, bare and duplicate new values. Initial state
has neither explicit field. The three typed reduction transitions follow the
accepted selected-reading/right-tab contract. State decoding, immutable route
spreads and printed encoding preserve these fields without creating focus or
provider authority. Nothing is mounted and no R8 completion is claimed.

The reported manually constructed profile and route literals are mechanical
shape adaptations. Exporting useTemporary reuses the existing private fixture
resource. D1's option roster legitimately grows from five to six; existing
shared-option assertions and saved-agent reopen behavior remain intact.

## P1: the example reader mistakes an option value for a location

The independently run repl-boundaries.test.ts fails its existing D1 step
"every command example in the spec is one the parser accepts". The new valid
example is `xmd repl --sidekit-agent claude`. The test computes positional
tokens by removing only tokens beginning with a hyphen. It therefore treats
claude as the optional location and passes it as the location argument to
replGrammarError. Production correctly refuses that fabricated location with
`xmd repl: a REPL location begins with xmd://repl/`; the assertion expected
undefined.

This is an example-reader defect exposed by the assigned valid usage example,
not a production flag defect. The real CLI subprocess already accepts the
separated valued option and reaches its expected non-terminal refusal.
Correct the checker to distinguish option values from a positional location.
Keep the valid example and preserve checks for an actual invalid location,
unknown option and extra positional arguments. Do not remove the example,
skip the step, accept the error or bypass location validation.

The edited command-line specification also still says "one of those five
options" in its refusal-order paragraph after stating the new sixth option.
Correct that stale count in the same focused revision.

## Independent evidence

| Command | Result |
| --- | --- |
| `deno task test packages/cli/tests/cli-help.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts` | exit 0; 2 tests / 30 steps |
| `deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-history.test.ts` | exit 0; 13 / 57 |
| `deno task test packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts` | exit 0; 53 / 111 |
| `deno task test packages/cli/tests/repl-boundaries.test.ts` | exit 1; 3 tests / 25 steps pass; 1 test / 1 step fails |

The three frozen commands pass 68 tests/198 steps. The changed boundary command
is a known affected specification consumer and the Implementor reported it
green; that result is not independently corroborated. Its complete first
failure is preserved at pr2-selection-review-1d373a61-boundaries-first.log.
The other first outputs use the same prefix with cli-selection, route-history
and journey-interface. No rerun, environment workaround, full suite or CI result
is used to dismiss the failure. The code explains the observed failure.

## Continuity

Follow [the finite correction prompt](pr2-selection-example-implementor-correction.md).
Preserve the production changes and passing behavior. Latest accepted head
remains 6e3a7b37; this feedback revision is not yet accepted. Creation-policy
compatibility remains with the Architect. Mounted presentation, owner binding,
R8, remaining R5/R6/R7 integration and the capture packet stay outside this
correction. No production file or fixture was changed during review. No push,
GitHub mutation, CI inspection or memory restructuring occurred.
