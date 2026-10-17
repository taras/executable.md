# PR 2 independent structural review

Reviewed commit: `9d8bc463297c39edd8893c8404c1dd674700cb23`, on
`agent/issue-881-pr2`, against integrated base `c7d54769`.

**REQUEST CHANGES.** The invocation terminal accepts an authentic request from
another invocation, and source inspection changes which documents execution
accepts. Published observations are also mutable. These violate the accepted
contract; no architecture amendment or persistence change is needed.

This is an independent code review by the Planner, who did not implement this
slice. It checks the seven settled structural requirements in
`pr2-planner-handoff.md`; it does not adopt the Implementor's self-assessment as
a verdict or introduce a new architecture decision.

## Required corrections

### R1: reject a foreign request before executing any body

`packages/core/src/component-expansion.ts:132` checks the private brand and
whether a request was consumed. It does not establish that the request belongs
to the terminal receiving it. `expandThroughTerminal` in
`packages/core/src/component-api.ts:466` passes the delegated request to the
current invocation's continuation without comparing it with that invocation's
issued request.

The review probe starts two genuine canonical invocations, A and B. Middleware
holds B's request and delegates it through A's `next`. A's body executes, then A
fails with “returned without delegating the expansion.” Refusing after the body
has run is too late: an effect can already have happened, and B's private claim
has been consumed by the wrong invocation.

Bind each terminal to its exact issued request. Reject a different request
before claiming it or entering work. Extend the existing C1 regression with an
authentic, unconsumed request from another invocation; a fabricated object or
copied request does not exercise this defect. The foreign body and current body
must both remain unexecuted by the invalid delegation, and the foreign request
must remain usable by its own terminal.

This is frozen checklist item 1 and the accepted invocation contract's explicit
foreign-request rule.

### R2: preserve the existing document envelope

`packages/core/src/source-inspection.ts:83` computes a different body boundary
from the installed extractor. The new assertion in
`packages/core/src/definition.ts:50` turns this disagreement into an execution
failure.

A normal BOM-prefixed document with no frontmatter, `\uFEFF<Hello />\n`, has
existing body offset 1. The new lexical helper returns 0, and `parseSource`
throws “frontmatter boundary disagrees with the lexical envelope (0 vs 1).”
The probe also records disagreement for an unterminated header and a closing
delimiter followed by text, both accepted by the installed extractor.

Make lexical extraction agree with the existing extractor while evaluating no
header values. Preserve execution's accepted inputs and exact body suffix.
Cover the BOM-without-header case in the existing C5 envelope-equivalence
regression and keep the executable-header sentinel inert. Removing the
assertion alone leaves the two readings inconsistent.

This is frozen checklist item 4 and C5's explicit BOM/envelope/execution
equivalence requirement.

### R3: freeze published observation data

`packages/core/src/component-expansion.ts:57` puts the same mutable phase object
into every queue and retains it as `latest`. Freezing the request does not
freeze that object. A reader can change a terminal phase's `phase` to `active`;
a late reader then receives `active` from an already closed publication.

The Effection Result is already frozen. The detached reporting Error is frozen
too, but an AggregateError's `errors` array remains mutable. Readers can change
the explanatory observation shared with other readers, even though Core's
canonical Error remains detached.

Freeze each phase before publication and make the published explanatory cause
data immutable, including aggregate member arrays. Extend the existing C3/C4
checks to attempt these mutations and confirm another reader still receives
the original terminal observation and explanation. Independent subscriptions
can share immutable values; no new persistence or public API is required.

This is the accepted invocation contract's “Published phases and Result data
are immutable observations” requirement and C3/C4's reporting and independent
reader boundary.

## Evidence

The exact frozen Core and CLI commands and the supplemental lifecycle command
pass at the reviewed commit: Core 53 tests / 411 steps; CLI 94 / 313;
supplemental 14 / 52. Logs are in `pr2-planner-evidence/core.log`, `cli.log` and
`lifecycle.log`. No full runtime corpus or CI was used for this feedback review.

`pr2-planner-evidence/contract-probe.ts` reproduces R1–R3 without editing
production code. Its decisive output is `contract-probe-final.log`. The two
earlier probe logs preserve corrections to the review harness: the first used
the wrong WithResolvers member; the second incorrectly treated WithResolvers
as an operation. Neither is a product failure or an intermittent test result.

Run the final probe from the repository root:

```sh
deno run --allow-all --config .claude/worktrees/issue-881-pr2/deno.json --node-modules-dir=manual --cached-only --frozen .reviewer/issue-881/pr2-planner-evidence/contract-probe.ts
```

The remaining checklist items are recorded with the Planner journey findings
in `pr2-planner-review.md`. They cannot override the failed canonical and
immutable-observation requirements above.

## Handback correction

The self-assessment's renderer note is inaccurate at this commit.
`packages/cli/src/repl/renderer.ts:217` already copies measured bounds into a
new Map and freezes each bounds object before returning `ReplMeasured`.
Correct the handback rather than opening a renderer architecture decision.

## Next action

Implement R1–R3 under the existing contracts, add the discriminating assertions
to their existing focused suites, run the frozen commands and supplemental
lifecycle command, then promptly return an exact feedback SHA and refreshed
evidence. Keep PR 1's accepted record and PR 3's scope unchanged.
