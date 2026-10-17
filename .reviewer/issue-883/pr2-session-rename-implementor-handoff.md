# Implementor handoff: rename the accepted session and layout vocabulary

**PASS, 2026-10-13:** implemented at
`9f15dc516ab8108efb3d4d19f970e32ffbe60000`, parent b01bbe6c.
[Planner review](pr2-session-rename-planner-review-9f15dc51.md) independently
confirms all seven commands: compiler/JSR and 102 tests/545 steps pass.
This assignment is closed. The validation API starts separately from that
accepted revision; the original assignment below records its frozen scope.

Rename the current owned surfaces without changing behavior. Start from
`b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, parent
`1d373a61cbb6266e4dd90bf17c8076c278174b0f`, on
`agent/issue-883-pr2` in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
The Planner verified this head is signed G, tarasm@gmail.com, and clean.

## Decisions and delivery

The Product Owner accepted
[the vocabulary/API handoff](pr2-session-vocabulary-architect-handoff.md) and
[its interview](pr2-session-vocabulary-architect-decision.md).
The earlier [Planner disposition](pr2-session-rename-planner-disposition.md)
remains historical; its spatial exemption and unanswered-name holds are
superseded. Read the consolidated Architect handoff in full. Its replacement
tables and complete interfaces are authoritative, including the derived names.

This is increment 1 of four, on the existing branch and PR:

1. This mechanical rename, directly parented on b01bbe6c.
2. [The returned-tree validation API](pr2-repl-validation-planner-handoff.md).
3. [Required custom-host identity recording](pr2-session-recording-planner-handoff.md).
4. [Active provider configuration](pr2-session-configuration-planner-handoff.md).

Return one signed feedback commit and stop after this increment. The next
increment starts only after Planner acceptance supplies its exact base. No
compatibility aliases or legacy exports remain.

## Required sweep

Apply the Architect's semantic and derived tables throughout current source,
exports, tests, diagnostics, specifications, architecture and agent rulebooks.
The sweep includes session requests and setup, ACP host details, workflow/Plan
directory helpers, REPL layout, AnswersState and structural analysis. Spatial
occurrences are included; do not substitute a single noun across domains.

Transfer exactly the accepted agent session, session creation and existing
session registry rows from the main checkout's architecture.md. Do not copy
unrelated main-checkout edits. The interface is AgentSessionSetup, with
finish(session, state), AgentSessionSetupState and new/existing discriminants.
This rename adds no activate member. AcpxSessionPolicy has requestSession and
an OPTIONAL recordSessionIdentity in this increment; do not remove optionality
or add runtime enforcement yet. ReplTree gains no validate method yet and
useReplTree retains its existing predicate, renamed layoutAllowed.

Rename these paths under packages/, updating every consuming reference:

- core/src/agent/session-placement.ts -> session-setup.ts
- core/tests/agent-session-placement.test.ts -> agent-session-setup.test.ts
- git/src/deno/composition/placement.ts -> checkout-paths.ts
- git/src/deno/run-composition/placement.ts -> checkout-layout.ts

Core's literal finish/sessionSetup bridge and acp/tests/loaded-copy.test.ts's
foreign-Core fixture change together. Reflect.apply still uses the original
receiver. Type checking alone cannot prove that bridge.

ReplDescription layout fields and locals use layout, with the same value and
parent-child reach. AnswersState retains parse/parsed/misplaced.
StructuralAnalysis retains violations and regions. The syntax-rendered
Placement heading becomes Structure; parent/child acceptance does not change.
Git path algorithms and exports do not change. SessionDirectoryOptions retains
root/session/explicitSession. Workflow providerSessionKey/providerSessionSuffix
and Plan sessionNameFor/digest keep the exact old key/hash inputs and results.

The provider's in-memory Prepared arm becomes kind: "details" and carries
details. Translate new/existing in-memory values from existing persisted
pending/established values at the owning boundary. Do not rewrite durable
records, provider-store markers, stored path/key/hash spellings, vendor protocol
members or pinned third-party bytes.

Include current repository-owned adapter provenance prose, exclusion reasons
and build/child fixtures. Historical .reviewer evidence and quotations retain
the names of the revision they actually reviewed. Do not rewrite this plan or
the accepted mapping tables to erase their old/new comparison.

## Frozen evidence

| Row | Proof |
| --- | --- |
| RN1 — owned names | The retired names/terms are absent from current owned surfaces and tracked owned paths. No alias remains. The accepted registry rows are copied without unrelated root changes. |
| RN2 — preserved meaning | The diff changes names, paths, in-memory spellings and their prose only. Stored values, path/hash algorithms, parent-child rules and creation/assertion timing are unchanged. Optional recording and the renamed validation callback remain optional/present until their own API increments. |
| RN3 — bridges and exports | The compiler and JSR dry run pass. The real ACP loaded-copy test crosses the renamed literal bridge. Renamed declarations and consumers agree without aliases. |
| RN4 — file/render boundaries | Explicit Git module/integration checks exercise both renamed helper paths, including the run-composition child fixture. Syntax-rendering checks assert Structure while preserving parent/child behavior. REPL composition still exercises the existing callback in this increment. |
| RN5 — configuration consumers | The configuration handoff's three existing focused selections pass with the renamed Core test path. They add no configuration behavior and claim no SC1–SC7 implementation. |

Run a two-way search control over current owned text and file paths:
scan tracked source, tests, specs, architecture, rulebooks, build/adapter prose
and manifests. Include camel/Pascal-case identifiers, literal structural
members, headings and retired session phrases. Filter complete tokens, never
drop a whole line because it also contains replacement.

Report zero retired-term occurrences after explicitly accounting for necessary
external/persisted spellings. List each such occurrence by path/location and
reason; broad package/directory exemptions are not acceptable. Pinned snapshots
and historical evidence are outside the current-owned sweep, but repository-owned
provenance text beside them is inside. External vendor identifiers/protocol
fields and stored markers remain exact. In particular, neither replacement
and its inflections nor AnswersState's accepted misplaced value is retired.

Prove the search itself in both directions against invocation-owned scratch
text: retired examples such as AgentSessionPlacement, ReplPlacement and the old
rendered heading are detected; replacement/replacements and misplaced are not.
Report the commands, scope, exceptions and results. No permanent scanner/test
framework or naming lint rule is assigned.

Run these finite commands after the final edit:

```text
deno task check
deno task check:jsr

deno task test packages/core/tests/agent-session-setup.test.ts packages/core/tests/agent-session-use.test.ts packages/core/tests/agent-session-use-loaded-copy.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-components.test.ts packages/core/tests/root-provider.test.ts

deno task test packages/acp/tests/provider.test.ts packages/acp/tests/permission-bridge.test.ts packages/acp/tests/host-conversation.test.ts

deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-history.test.ts

deno task test packages/acp/tests/loaded-copy.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/syntax-component.test.ts packages/core/tests/syntax-catalog.test.ts packages/cli/tests/syntax-cli.test.ts packages/cli/tests/document-suites/syntax/syntax-markdown.test.ts packages/cli/tests/repl-composition.test.ts

deno task test packages/git/tests/module-partition.test.ts packages/git/tests/repository-replay.test.ts packages/git/tests/worktree-replay.test.ts packages/git/tests/run-composition-managed.test.ts scripts/tests/runtime-exclusions.test.ts scripts/tests/test-file-discovery.test.ts
```

For this increment check and check:jsr ARE assigned evidence: the compiler
checks the repository-wide rename, and JSR checks renamed published exports.
This is an explicit exception to their usual non-prerequisite status, not a
new delivery rule. A dry run must end with Success Dry run complete.

The real loaded-copy and Git child/integration selections are the explicit
bundle/build-fixture checks; no npm packaging build or exhaustive runtime corpus
is assigned. Do not change discovery or runtime eligibility to satisfy them.
No full suite, CI, dependency mutation or generated-vendor rebuild is assigned.

## Feedback and limits

Commit promptly when RN1–RN5 and these commands pass. Return the exact signed
SHA, parent, branch, clean/dirty status, every focused command and result,
the two-way search report and preserved wire/vendor exceptions. Preserve a
failed command's first output before rerunning. Report mechanical assertion
changes for renamed fields/headings; do not change behavioral expectations.

No API behavior change, activate implementation, settings UI, owner acquisition
in program.ts, mounted section 5, terminal R7/R8, 36-frame packet, push, GitHub
mutation or CI inspection is authorized. Stop for Planner review.

Base is b01bbe6c; the produced artifact is this file. Names and delivery are
settled, with no vocabulary question left for the Implementor. R2 implementation
remains pending. Next action: implement this rename alone, then hand back its
feedback commit.
