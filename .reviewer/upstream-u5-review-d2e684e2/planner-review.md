# U5 Planner review — REQUEST CHANGES

The exact feedback revision `d2e684e2264092373c2f42a2070541ea4303d818` does not yet satisfy the frozen handoff. Three reproduced defects violate existing criteria. This verdict does not add acceptance scope or request an architecture redesign.

## Revision and authority

- Feedback SHA: `d2e684e2264092373c2f42a2070541ea4303d818`.
- Tree: `49031af37a3b54e30d4de032fd75576512159b71`.
- Parent/base: `3a1fade9246db937e11da6cdadc4751ec924be97`.
- Signature: Git reports `G`.
- Branch/worktree: `agent/upstream-u5-generated-selection`, `.claude/worktrees/u5-generated-selection`; clean before and after review.
- Diff: 63 files, +4107/-4892, including new files.
- Authority: [frozen U5 handoff](../upstream-u5-handoff-3a1fade9/upstream-repository-prerequisite-u5-implementor-handoff.md), twelve rows and twelve commands, under its accepted Current contract and U5 stack boundary.

No production source, branch or worktree was changed during review. Review artifacts are outside the implementation checkout and immutable preservation archive. No CI was inspected; publication remains unassigned.

## R1 — authored imports bypass the accepted options

Priority P1. Frozen U5-2 and Instructions §3 require preserving supported public execution-policy changes and canonical request settlement while retaining generated selection before policy.

At `core/src/execute.ts:2420`, assembly takes the original `options.includes` reference. `executeDocument()` then takes `includes` from that assembly at line 2601, instead of from the detached options returned by `issued.settle()`. This makes a pre-policy search-path reference control ordinary authored imports after policy.

The existing EP26 regression demonstrates the consequence without a new test premise. Its terminal accepts and detaches the caller's options; after delegation the policy empties the caller's original `includes` array. At this revision the authored `<Accepted />` import fails with:

```text
DocumentationError: Failed to import component Accepted: Cannot resolve component: Accepted (searched: )
```

Command: `deno task test packages/core/tests/execution-protocol.test.ts`. Result: 1 passed/66 steps, 1 failed/1 step; EP26 is the failed step. [First output](execution-protocol.log) is retained.

The same source path also ignores a search-path replacement legitimately delegated through `request.withOptions()`. Fix ordinary authored resolution to use the settled detached options. Retain the pre-policy generated selection and definitions separately; do not move generated capture after policy or assemble identities twice. Preserve the established descriptive fallback where the accepted authored paths affect it.

Required evidence: restore EP26 unchanged, add a focused positive assertion that an includes replacement before delegation controls authored imports, and keep the existing generated no-widening assertion. These prove the two responsibilities can coexist under U5-2.

## R2 — Workflow header comparison authorizes a different transmitted value

Priority P1. Frozen U5-7 and Instructions §6 require comparison of the complete actual transformed request immediately before transport, retaining U2's full-header bound.

`workflow/src/deno/workspace/evaluate.ts:192–199` lowercases header names into a Map with unconditional `set`. Differently cased occurrences overwrite each other. `permits()` at lines 168–185 then compares that collapsed map, while the real transport receives the original headers and combines their values.

The retained [probe](probes.ts) installs the production `useWorkflowGenerated` helper, runs public Evaluate with canonical generated Fetch, and uses the real runtime Fetch terminal against a loopback server. The host allows exactly `x-bound: admitted`. Middleware changes the outgoing object to:

```ts
{ "X-Bound": "EXTRA", "x-bound": "admitted" }
```

The policy accepts it. The server receives a header the host never allowed:

```text
HEADERS {"transformed":false,"accepted":["admitted"]}
HEADERS {"transformed":true,"accepted":["EXTRA, admitted"]}
```

[Integration output](integration-probes.log) preserves the positive control and defective request. The earlier direct runtime probe reached the same result. The first sandboxed loopback attempt was blocked by OS permissions before running either case; the successful loopback runs used the approved execution boundary. This is not a product test failure attributed to the sandbox.

Refuse ambiguous case-colliding names on both host-bound capture and outgoing comparison, or otherwise compare a normalization that exactly preserves the complete request sent. U2 used a fail-closed rule; do not silently take the last value. Keep this check at live runtime and retain the removal of generic inventories/preflight authorization.

The new regression must exercise the production Workflow helper and actual Fetch terminal, with unchanged-header success and transformed-header refusal with zero server requests. The hand-written `boundTo()` policy in the core permissions tests cannot establish correctness of a different production comparator.

Also correct existing WGX9's evidence for U5-7. It edits `bound` only after the first run's scope has ended, then starts a new run with a different literal bound. Neither run observes the edit, even if capture kept the caller's object. Move the mutation and subsequent request into the same still-live installed policy so the existing immutable-bound assertion tests what it states. This restores a frozen assertion; it is not a new permission feature.

## R3 — the REPL ordinary default hides a defined host selection

Priority P1. Frozen U5-4 and Instructions §5 require ordinary middleware to delegate first, default only on undefined, preserve defined custom values and let defined empty values refuse setup, including each REPL entry.

`repl-profile.ts:131` always supplies the ordinary map. `repl/session.ts:951–952` installs that value as an unconditional answer in every entry. It shadows a selection installed by the plugin/host's captured installation callback instead of composing the ordinary fallback.

The retained probe submits a real entry through `submitReplEntry()`, with an installation callback offering `{}`. With no session default the callback is read and core refuses the empty selection. With the ordinary map supplied exactly as the command supplies it, the callback is never read and the entry succeeds:

```text
REPL {"ordinaryDefault":false,"customReads":1,"joined":{"ok":false,"failure":"a host offered generated evaluation and selected no component. A host that offers evaluation states what a fragment may write; one that offers none states no selection."}}
REPL {"ordinaryDefault":true,"customReads":0,"joined":{"ok":true,"value":"# REPL custom selection\n"},"terminal":{"status":"ok","output":"# REPL custom selection\n"}}
```

Install the ordinary default through delegate-first, undefined-only middleware in the live entry scope. Preserve an explicit host answer rather than replacing it. Use the existing property/helper and owner; do not restore an evaluation installation field or add another collector.

Required evidence: a real REPL entry retains a defined custom selection and a defined empty answer refuses before the entry body. Keep the existing fresh-entry/lifetime behavior and ordinary no-custom control. A direct helper-only test cannot establish composition inside the session.

## Judgments accepted

1. Canonical name ordering is suitable for a single record-valued selection. Keep composition first and the established class/form ordering; sort component names within the derived effect tables. The old host-array slot constraint does not require retaining an array that this slice removes. This is a bounded Planner clarification of representation, not a new effect allowance.
2. Canonical publication belongs at the innermost producer of the answer. Keeping it there preserves the pre-middleware baseline and avoids rebaselining a mutated final answer.
3. Moving the existing safe generated-request refusal classification into the capture guard is necessary to preserve Plan recovery. It does not introduce a new transport or scope owner.

The EL5/EL7 premise changes follow the already accepted actual-resolution rule. They are not review blockers.

## Evidence and limits

Independently rerun at the exact feedback commit:

| Command | Result |
| --- | --- |
| Frozen command 1: generated-selection, execution-init, evaluation-profile, generated-owner-metadata, component-registration, answer-identity | 26 passed, 158 steps, 0 failed; [log](command-1.log). |
| Frozen command 2: evaluate-component, evaluate-provider-lifetime, generated-xmd, generated-composition | 34 passed, 287 steps, 0 failed; [log](command-2.log). |
| Existing execution-protocol suite, selected because the assembly move changes the supported policy boundary | EP26 fails; first output retained above. |
| Canonical generated Fetch and real REPL probes | Both additional defects reproduced, with positive controls; [source](probes.ts), [output](integration-probes.log). |

The Implementor reports all twelve frozen commands green, including Node 256/256 and Bun 256/256, dead-code, docs, build and seven compiled/npm-bin tests, plus lint/check. Those receipts are reported evidence; this review independently reran commands 1 and 2 and the targeted protocol/probe checks. Green commands 1 and 2 do not override the reproduced violations of their settled criteria. No exhaustive runtime suite or CI verdict is needed to establish these defects.

## Continuity and next action

Verdict: **REQUEST CHANGES** at the exact SHA above. Three blockers remain, with the WGX9 evidence correction folded into R2. Use the [ready revision prompt](implementor-revision-prompt.md) in the existing authorized U5 Implementor session/worktree. Preserve pre-policy capture and all accepted removals while correcting these boundaries, then return a new signed feedback revision with the focused evidence. Architect/Product Owner review, delivery, publication and merge remain separate. U5 has not landed; #902 remains held.
