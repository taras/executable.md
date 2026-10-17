# Planner review: session vocabulary rename at 9f15dc51

**PASS.** Increment 1 satisfies RN1–RN5. The mechanical rename is accepted;
the returned-tree validation API is the next assignment.

Reviewed commit: `9f15dc516ab8108efb3d4d19f970e32ffbe60000`.
Parent: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`.
Branch: `agent/issue-883-pr2`. Signature: G, tarasm@gmail.com.
The implementation worktree was clean before and after independent verification.
The commit changes 118 files, including the four assigned path renames.

Authority: [the rename handoff](pr2-session-rename-implementor-handoff.md),
[Architect vocabulary/API handoff](pr2-session-vocabulary-architect-handoff.md)
and [Implementor handback](pr2-session-rename-implementor-handback.md).

## Findings against the frozen rows

- RN1: an independent scan of 1,622 tracked text files found no retired
  phrases or tracked paths. Its only broad token findings were the eight
  documented GitInvocationPlace references in git-api.ts, api.ts and
  api-entrypoint.test.ts. That existing published export is the ordinary noun
  place and the accepted handoff preserves Git exports. The accepted three
  terminology rows are transferred; no compatibility aliases remain.
- RN2: source review and a TypeScript parser comparison found the same syntax
  structure throughout changed production modules. Identifier/literal changes
  match setup/request/details/layout/analysis and the approved in-memory
  new/existing translations. The parser comparison's only changed tree
  structure among changed TypeScript/JavaScript files was the added syntax
  rendering assertions. The stored pending-marker reads, native launch record
  fields, session keys, checkout path/hash inputs and Plan digest are preserved.
  Pinned ACPX/workflow/Freedom snapshot bytes are unchanged.
- RN3: the finish/sessionSetup delivery bridge retains its original receiver
  through Reflect.apply; the separately bundled Core fixture changes with it.
  Compiler, JSR dry run and the real ACP loaded-copy suite independently pass.
- RN4: both renamed Git helper paths are covered by the explicit module and
  integration selection. Syntax catalog SY5d now asserts both Structure
  renderings; it changes no parent/child rule. The existing REPL composition
  callback refusal remains under layoutAllowed.
- RN5: all three configuration-consumer selections pass with the renamed Core
  test path. AgentSessionSetup has no activate member, recordSessionIdentity
  remains optional, and ReplTree has no validate method yet. No later API
  increment was folded into this commit.

The StaleReason spelling checkout-path is a local diagnostic selector, not a
new stored record value. Its owning path checks and failure classification
are unchanged. test-weights.json changes only the three renamed file keys;
an independent JSON comparison after normalizing that path is identical,
including all milliseconds and provenance. This is no new measurement.

The independent two-way token control detects AgentSessionPlacement,
ReplPlacement, createSessionPlacementOwner, placedKeys and Placement, while
detecting none of the supplied replacement/misplaced/placeholder/displaced,
ReplAction or ordinary-place controls. The Implementor's wider scratch-control
counts and heading restoration control are separately reported evidence;
they were not repeated as extra acceptance tests.

## Independent commands

All commands ran at the reviewed head from the implementation worktree.
The exact selections are the seven commands in the rename handoff.

| Command | Result | First output |
| --- | --- | --- |
| deno task check | exit 0 | [compiler](pr2-rename-review-9f15dc51-check-first.log) |
| deno task check:jsr | exit 0; Success Dry run complete | [JSR](pr2-rename-review-9f15dc51-jsr-first.log) |
| Core selection, 6 files | 14 tests, 72 steps, 0 failed | [Core](pr2-rename-review-9f15dc51-core-first.log) |
| ACP selection, 3 files | 11 tests, 94 steps, 0 failed | [ACP](pr2-rename-review-9f15dc51-acp-first.log) |
| CLI Sidekick/history selection, 5 files | 15 tests, 85 steps, 0 failed | [CLI](pr2-rename-review-9f15dc51-cli-first.log) |
| Loaded-copy/syntax/composition selection, 7 files | 42 tests, 229 steps, 0 failed | [bridge and syntax](pr2-rename-review-9f15dc51-bridge-first.log) |
| Git/discovery selection, 6 files | 20 tests, 65 steps, 0 failed | [Git and discovery](pr2-rename-review-9f15dc51-git-first.log) |

Total test evidence: **102 tests, 545 steps, zero failures**, alongside compiler
and JSR success. There was no environment limitation. Additional Implementor
consumer checks and formatting are reported in the handback but were not
required or independently repeated. No full runtime corpus or CI was inspected.

## Continuity and next action

Latest accepted PR 2 head is 9f15dc51. Start
[the validation API increment](pr2-repl-validation-planner-handoff.md)
from that exact SHA. It separately adds returned-tree validate and removes
the callback, with RV1–RV4 and its one focused command.

Required custom-host recording follows validation acceptance. Active provider
configuration follows recording acceptance; its five steps and SC1–SC7
behavior are unchanged. No configuration implementation or R2 completion is
claimed by this PASS. Owner acquisition in program.ts, mounted section 5,
terminal R7/R8 and the 36-frame packet remain separate. No push, GitHub mutation
or CI inspection is authorized.
