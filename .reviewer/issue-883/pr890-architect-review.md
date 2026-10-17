# PR #890 Architect review — REQUEST CHANGES

Reviewed head: `05d03afb0ff1356707f66f2f1b741a5d8ec6ba95`.
Base and merge base: `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`.
PR: [Evaluate, preview and converse as a trusted host](https://github.com/taras/executable.md/pull/890),
Core PR 1 of 2 for #883. The reviewed worktree is clean; head and base were
rechecked before recording this verdict. The base includes #881 and #889.

One blocking finding remains: generated-root admission refuses the accepted
passive-source capture and draft-fill program. The existing Planner PASS and its
closed cancellation/native-identity findings remain recorded as their evidence;
this architectural review identifies a separate violation of the already
accepted response-to-entry boundary.

## P1 — Core refuses the agreed way to write the draft

The accepted [handoff](planner-handoff.md#discuss-evaluate-feed-back) and
[agent instructions](sidekick-instructions-proposal.md) prescribe this path:

````xmd
<Let as="code" select="code">
```xmd
<Each in={names} let="name">
Hello, {name}!
</Each>
```
</Let>
<REPL.EntryInput>{code}</REPL.EntryInput>
````

The response owns the local `code` binding. `names` and `name` belong to the
passive entry source and do not need to exist in the response. The extracted
string fills the shared draft without being reparsed or executed as a response.
The frozen contract also leaves released generated-fragment behavior unchanged.

At the reviewed commit,
[generated-xmd.ts:1981](https://github.com/taras/executable.md/blob/05d03afb0ff1356707f66f2f1b741a5d8ec6ba95/packages/core/src/generated-xmd.ts#L1981)
rejects every text segment for which `readsBinding()` returns true, in both
fragment and root context. The Let branch walks its children through that same
rule at line 2308. A passive fence is a text segment, so its `{names}` and
`{name}` are rejected. Even a fence containing only `Hello` fails later on the
known local `{code}` inside the paired control. GR17 explicitly enshrines the
blanket root interpolation refusal; it does not test the accepted draft flow.

The [review probe](pr890-passive-draft-probe.test.ts) supplies a valid read table
and a pinned paired mutation named REPL.EntryInput. Its implementation reads
canonical `content()` and records the received draft. It runs under a real
`executeInstalled` execution through a declared host component, with no CLI
parser or substitute evaluator.

| Source | Observed result |
| --- | --- |
| Literal `<REPL.EntryInput>Hello</REPL.EntryInput>` | Success; receives `Hello` once. |
| Passive `Hello` captured by Let, followed by `<REPL.EntryInput>{code}</REPL.EntryInput>` | Admission refusal; receives nothing. |
| The accepted Each/greeting entry above | Same admission refusal; receives nothing. |

Both refusals report: `a generated fragment reads a binding through
interpolation, which it may not.` The host execution itself succeeds, so these
are generated-source admission refusals rather than broken host setup.

**Structural consequence:** the generated-root admission boundary excludes a
supported, approved response program from the pinned draft-writing capability.
The following CLI consumer cannot implement the agreed interface through this
Core seam. A CLI rewrite or second evaluator would violate the accepted ownership
of syntax and admission. Correction belongs in this PR because it supplies that
seam and introduces the distinct root context. This is an existing contract,
not a new product decision or an additional malformed-input permutation.

## Evidence

Reviewer ran at the exact head:

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts packages/acp/tests/host-conversation.test.ts
```

Result: **20 tests, 91 steps passed; zero failures.** These cover the current
C1–C3 cases, including cancellation joining and the real ACP pre-mapping window.
They do not establish the passive-draft contract above.

From the reviewed worktree, reviewer also ran:

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr890-passive-draft-probe.test.ts
```

Result: the literal control passes; both capture cases fail. The complete
behavioral output is retained in [the probe log](pr890-passive-draft-probe.log).
Earlier probe setup attempts encountered a preparation type mismatch and a
duplicate Json admission; both were corrected before the positive control and
behavioral comparison above. They are not evidence against the PR.

No production file was changed. No CI was inspected and no GitHub review or
comment was submitted. The other focused regressions in implementor-handback.md
were reported by the Implementor and were not rerun for this review.

## Next agent prompt

Correct Core PR #890's generated-root admission so it supports the accepted
Sidekick passive-source flow. At `05d03afb`, the reviewer probe in
`.reviewer/issue-883/pr890-passive-draft-probe.test.ts` proves that a literal
REPL.EntryInput body works, but a passive Hello fence captured with Let and
passed as `{code}` refuses. The accepted Each/greeting source fails too, because
the preflight treats braces inside its passive fence as response reads.

This applies to Sidekick response programs; the captured program is ordinary
REPL entry source. Read the accepted example in planner-handoff.md and
sidekick-instructions-proposal.md. Preserve that interface: root evaluation must
pass the extracted literal string to a pinned paired control once, preserving
entry braces and fences, without parsing it as response syntax or executing its
entry components. Response-local binding use must stay within the accepted
generated grammar and lexical environment. It must not gain ambient bindings,
JavaScript, unpinned resolution or executable fences.

Keep syntax interpretation and whole-source admission in canonical Core. Keep
the released fragment evaluator and retained fragment records unchanged, and
preserve root/fragment admission separation. Do not work around the refusal in
CLI code or replace the accepted component interface. Correct the blanket-root
refusal assertion and documentation to match the accepted flow.

Add a Core regression with a pinned paired receiver that checks the exact
captured draft, including the accepted entry-only binding references and passive
nested fences. Keep a literal-fill control and prove no entry component runs
during response evaluation. Retain existing rejection evidence for forbidden
response execution and fragment compatibility. Run the affected Core rows from
the handoff, rerun the conversation/ACP row if that boundary changes, then return
the exact stable feedback SHA, commands and results. CLI PR 2 consumes the
corrected Core revision after review.
