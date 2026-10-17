# Planner disposition: the session rename lands as its own increment, ahead of the amendment

**Planner refresh complete, 2026-10-12:** use
[the rename assignment](pr2-session-rename-implementor-handoff.md), followed by
the separate [validation API](pr2-repl-validation-planner-handoff.md),
[required identity recording](pr2-session-recording-planner-handoff.md) and
[configuration](pr2-session-configuration-planner-handoff.md) assignments.
The expanded owned-surface sweep, compiler/JSR proof, two-way search controls
and explicit dynamic/file/render checks are frozen there. No naming hold remains.
The older observations below remain historical and are not implementation
instructions where they conflict with those assignments.

**Architect return resolved:** the [consolidated handoff](pr2-session-vocabulary-architect-handoff.md)
supplies the accepted names, full interfaces, derived helper/file map and two
separate API amendments. It supersedes the unanswered-name and spatial-scope
holds below. Planner refreshes sequencing and evidence before implementation;
the historical disposition below does not override that handoff.

**Scope correction:** the Product Owner subsequently rejects the spatial
exemption. ReplPlacement, AnswersPlacement and StructuralPlacement are included
in the vocabulary review, along with the related spatial helpers and prose.
The accepted term is agent session: “The session is created when it is first
used.” See [the current Architect decision](pr2-session-vocabulary-architect-decision.md).
The delivery order and no-alias decision below stand; the earlier scope edge
and evidence selection need Planner alignment after the remaining names settle.

**Accepted API amendment:** ReplTree exposes validate(descriptions): Result<void>;
apply still validates automatically before mutation. useReplTree no longer
accepts an injected validation predicate. This is a separate behavior/API
increment, not part of the rename-only commit. The current Architect decision
records the contract and the deliberate retirement of the synthetic custom-slot
rejection test. Refresh sequencing and focused evidence accordingly.

**Accepted host API amendment:** the custom session-host integration remains
optional, but requestSession and recordSessionIdentity are both required when
supplied. Rename established to recordSessionIdentity, then deliver removal of
its optionality as behavior/API work outside the rename-only commit. Keep the
provider's existing identity-confirmation timing and refusal cleanup. Ordinary
directory-based sessions gain no new host database. The current Architect
decision carries the complete accepted two-method interface.

The Architect's reply to
[the vocabulary return](pr2-session-configuration-placement-vocabulary-return.md)
settles two of its five items and leaves three open. This records what is now
frozen, what the remaining answers have to supply, and the one consequence of
"no compatibility aliases" the return did not measure.

No production change, specification change, commit, push or GitHub mutation was
made. The implementation worktree is untouched and clean at
`b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2` on `agent/issue-883-pr2`.

## What the Architect settled

> For the session terminology, I recommend a complete rename before the
> configuration amendment: exported types, methods, helpers, files and
> documentation, with no compatibility aliases.

That answers return item 4 — **before**, not with and not after — and return
item 3 — **renamed, not aliased, not both**. It also sets the sweep's depth:
file names and documentation are in, so
`packages/core/tests/agent-session-placement.test.ts` is renamed rather than
left carrying the retired word in its path.

"No compatibility aliases" agrees with standing repository policy rather than
excepting it: these exports have no external consumers, and no users means no
migration affordance. Nothing durable spells the old word, so no stored record
or journal pins it.

The configuration documents now read **active provider configuration**
throughout, and the three affected artifacts carry an implementation hold. That
noun is settled and is not reopened here.

## What is still unanswered, and why it still blocks

Return items 1, 2 and 5 have no answer anywhere in the repository. The three
Terminology rows still register the retired word at `architecture.md:123`,
`:124` and `:125` in the working tree, and no replacement spelling appears in
`architecture.md`, in the accepted amendment, or in the handoff.

A complete rename with no aliases cannot be sequenced without its target names.
The amendment adds members to the interface being renamed, so the names the
amendment writes are the renamed ones; writing the old spellings now and
sweeping them in a following commit is the one ordering the Architect's answer
excludes.

The remaining answers must supply:

1. The replacement for the registered terms *pending session placement* and
   *established session*, and the reworded *session materialization* row —
   including what the capability a fresh `<Session>` produces is then called.
2. The replacement interface name, the replacement for `complete()`, and
   whether `activate()` as accepted keeps its signature under that name.
3. Where the boundary sits between the retired session sense and the retained
   output/structure/layout sense — `ReplPlacement`, `AnswersPlacement`,
   `StructuralPlacement`, `validateOutputPlacement`, `placementsAllowed` and
   the `layout.ts` Terminology row are the second sense and stay.

Item 3 is the sweep's edge, not its size: without a stated edge a mechanical
sweep either stops short or renames the layout vocabulary with it.

## One consequence the return did not measure

The rename changes a **runtime structural contract**, not only source
identifiers. `packages/core/src/agent/provider-api.ts:214` reaches a delivered
placement by string property name:

```ts
const complete = Reflect.get(value, "complete");
const sessionIdentity = Reflect.get(value, "sessionIdentity");
```

`packages/acp/tests/loaded-copy.test.ts:309` is the foreign-core stand-in that
exists to prove a differently-loaded copy of Core still bridges, and it supplies
that property under the same literal name. With no aliases, the two sides must
be renamed in lockstep — in this repository they are both in-tree, so the
rename is contained, but the member names are a parsed wire contract between
copies rather than an internal spelling. This is a fact the Architect's naming
answer should be made with, not a reason to keep an alias.

That file is not in the amendment's three focused commands and is affected by
the rename, so the rename increment carries it.

## The frozen delivery shape

**One rename-only commit on `agent/issue-883-pr2`, parented on
`b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, ahead of the configuration
increment.** Not a separate PR: PR 2 is already in flight with accepted
increments, and a pure rename holds no invariant of its own to split a PR at.
It changes no behavior, so it is reviewable as a mechanical commit and the
amendment's commit stays readable as behavior.

In scope: the ~15 session-sense identifiers, the four published type names in
`packages/core/mod.ts`, `packages/acp/mod.ts` and `packages/core/host.ts`, the
test file name and its tier comment, the three Terminology rows, and the prose
in `architecture.md`, `specs/acp-client-spec.md`, `specs/executable-mdx-spec.md`
and `specs/repl-spec.md`. The `kind: "placement"` discriminant of the
provider-internal `Prepared` union is in scope as an identifier and carries no
durable consequence.

Out of scope: the output/structure/layout sense above, `replacement` and its
inflections, and every member the configuration amendment adds. The amendment's
behavior, its four-field `ProviderSessionConfiguration`, its single-attempt
lifetime, its construct/reattach ordering and its SC1–SC7 evidence are
unchanged by this increment and are not re-litigated by it.

**Evidence for a rename increment is compiler evidence, not journey evidence.**
A rename's correctness is exactly the question a type checker answers, so for
this one increment `deno task check` is the proof rather than an optional gate,
and `check:jsr` is required because published export names change with no
aliases behind them. Add a grep control in both directions: zero session-sense
occurrences of the retired word remain, and the output/layout sense still
measures its recorded count. The amendment's three focused commands must pass
unchanged — a rename that moved behavior would show there.

A renamed test asserts no new behavior, so no new test is assigned. The
absence of a deleted name needs no test.

## What reopens, and in what order

1. The Architect answers items 1–3 above and amends `architecture.md`'s
   Terminology section, which is the registry the names come from.
2. The Planner re-freezes the five steps, the accepted signatures and the three
   focused commands of
   [the handoff](pr2-session-configuration-planner-handoff.md) in the settled
   spellings. Only paths, signatures and command arguments change; no step and
   no acceptance row changes.
3. The rename increment is implemented and returned for review.
4. The configuration amendment is implemented on top of it and returned as its
   own signed feedback commit.

R2 remains incomplete. Mounted section 5, terminal R7/R8 and the 36-frame
comparison packet remain separate and are not opened by any of this.

## Continuity

Base: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, clean, `git status` reports
nothing. Produced artifact:
`.reviewer/issue-883/pr2-session-rename-planner-disposition.md`. Settled here:
delivery order (rename first), delivery shape (one mechanical commit on the
existing branch), scope and edge, and the evidence a rename increment owes.
Still blocking: the replacement spellings and the stated sense boundary. No
implementation was started, so there is no feedback commit and no SHA to
review.
