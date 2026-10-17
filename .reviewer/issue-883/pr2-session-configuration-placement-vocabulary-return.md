# Planner return: "placement" must be retired before this amendment is written

The Sidekick session-configuration amendment cannot be implemented as frozen.
The Product Owner has decided that "placement" leaves the vocabulary. Every
step of the frozen handoff writes that word into new source, new specifications
and `architecture.md`, so implementing now would add the word the decision
removes. Retiring it withdraws registered terms and renames published types,
which is the Architect's to settle.

No production change, specification change, commit, push or GitHub mutation was
made. The implementation worktree is untouched and still clean at the reviewed
base.

## Applies to

Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`

Branch: `agent/issue-883-pr2`

Reviewed clean head: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2` (unchanged;
`git status` reports nothing)

Assignment returned:
[the Planner handoff](pr2-session-configuration-planner-handoff.md), which
implements
[the Architect decision](pr2-recovery-creation-policy-architect-decision.md).

## What the Product Owner settled, 2026-10-12

Two naming questions were asked before any prose was written, because the
Terminology section of `architecture.md` is the registry and the amendment's own
nouns are not in it.

1. **The thing this feature saves is the "active provider configuration".**
   Not an "account", which is what the Architect decision and the Planner
   handoff call it throughout, and not a "retained" anything. This answer stands
   and does not need asking again.

2. **"Placement" is to go.** The settled interface `AgentSessionPlacement`, its
   `complete()` method and the registered terms built on it were understood to
   have been replaced by `activate`. They were not: the Architect decision adds
   `activate()` to that same interface beside the existing `complete()`, and
   withdraws only `AgentSessionPolicy`/`checkPolicy`, `retainConfiguration` and
   the interim `acceptConfiguration`.

The second answer is what stops the work.

## Why this blocks every step rather than only the prose

The frozen handoff's five steps are each written in terms of the word:

- Step 1 adds a member to `AgentSessionPlacement` in
  `packages/core/src/agent/session-placement.ts`, through
  `createSessionPlacementOwner()`, and extends the issuance
  `sessionPlacement()` opens in `packages/core/src/agent/session-request.ts`.
- Step 2 binds that issuance from `conversationTurn()` in
  `packages/core/src/agent/conversation.ts`.
- Step 3 activates inside `resolveSession()` in
  `packages/acp/src/provider.ts`, whose own `Prepared` union already
  discriminates on `kind: "placement"`.
- Step 4 reaches all of it through
  `launchCoordinator.sessionPlacement(request)`.
- Step 5 updates the affected provider-factory and placement sections of
  `specs/acp-client-spec.md`, the Core interface roster in
  `specs/executable-mdx-spec.md`, and `architecture.md`.

There is no part of the amendment that can be delivered without writing the
word, so there is nothing to implement under the answer as given.

## What retiring it actually costs, measured at the reviewed base

**Three registered Terminology rows are defined by it.** `architecture.md:120`
registers *pending session placement*; `:121` defines *session materialization*
as "the transition that makes a placement's chosen route and its backend history
resumable"; `:122` defines *established session* as "a placement whose immutable
construction route and durable provider or native identity both already exist".
Two of the three would be renamed and the third reworded. (`:6075`, the
`layout.ts` row, uses the word in the unrelated sense below.)

**Four published type names carry it.** `AgentSessionPlacement` and
`AgentSessionPlacementState` are exported from `packages/core/mod.ts`;
`AcpxSessionPlacement` from `packages/acp/mod.ts`; `AnswersPlacement` from
`packages/core/host.ts`. These are the JSR and npm surfaces, so the rename is a
public compatibility decision rather than an internal sweep.

**The identifier sweep is about fifteen names, not one.** In the session sense:
`sessionPlacement` (55 occurrences), `createSessionPlacementOwner` (28),
`AgentSessionPlacement` (14), `AcpxSessionPlacement` (11),
`resolveSessionPlacement` (7), `configurePlacement` (7), `readPlacement` (6),
`assertsAtPlacement` (6), `SessionPlacement` (5), `SessionPlacementOwner` (4),
`placementOf` (4), `AgentSessionPlacementState` (4), `ReadPlacementUse` (3),
`placementState` (3), `PlacementLog` (3), plus the bare `placement` parameter
and local in every file that handles one — 127 occurrences in
`packages/acp/src/provider.ts` alone, and 69 in
`packages/core/tests/agent-session-placement.test.ts`, whose filename and tier
comment also carry it.

**Prose: 64 occurrences in `architecture.md`, 44 in
`specs/acp-client-spec.md`, 71 in `specs/executable-mdx-spec.md`, 1 in
`specs/repl-spec.md`.**

**The word has unrelated senses that a sweep must not touch.** `ReplPlacement`,
`AnswersPlacement`, `StructuralPlacement`, `validateOutputPlacement`,
`placementsAllowed` and the `layout.ts` Terminology row are about where output
and structure are placed, not about sessions. So this is a scoped rename with a
boundary to draw, not a global replace. `replacement`/`replacements` (238
occurrences) share the substring and are a different word entirely.

**Nothing durable spells it.** `kind: "placement"` in
`packages/acp/src/provider.ts` is the discriminant of the provider-internal
`Prepared` union, not a journaled or stored value, so replay and stored records
do not pin the spelling. That is the one cost this rename does *not* carry.

## What the Architect has to settle

1. Whether *pending session placement* and *established session* leave the
   registry, and what replaces them — including what the capability a fresh
   `<Session>` produces is then called.
2. The replacement name for the `AgentSessionPlacement` interface and for
   `complete()`, and whether `activate()` as accepted keeps its signature under
   that name.
3. Whether the published `AgentSessionPlacement`,
   `AgentSessionPlacementState` and `AcpxSessionPlacement` exports are renamed,
   aliased or both, and what that means for consumers.
4. Whether the rename lands before this amendment, with it, or after it — and
   if after, what the amendment's new prose and new members are allowed to be
   called in the meantime.
5. Where the boundary sits between the session sense and the
   output/structure/layout sense, so the sweep has a stated edge.

Only item 4 has to be answered for this PR to proceed. Items 1–3 and 5 decide
how large the resulting work is.

## What is not affected

The rest of the amendment is unchanged and still settled: the four-field
`ProviderSessionConfiguration` with its initial Sidekick values, Core ownership
of saving and comparing, the single-attempt lifetime, the ordering in which the
provider may construct or reattach, the compatible/incompatible reopening
journey, and the frozen SC1–SC7 evidence with its three focused commands. None
of it was changed here, and the "active provider configuration" answer above
settles the one noun those documents were missing.

## Continuity

Base: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, clean. Produced artifact:
`.reviewer/issue-883/pr2-session-configuration-placement-vocabulary-return.md`.
Settled: the saved thing is the **active provider configuration**; "account" and
"retained" are not its name. Unresolved blocker: "placement" is to be retired,
which withdraws registered terms and renames published types. No implementation
was started, so there is no feedback commit and no SHA to review. Next action:
the Architect settles items 1–5 above, after which the Planner re-freezes the
handoff's steps and evidence in the settled vocabulary and the implementation
assignment reopens. R2 remains incomplete. No mounted section 5 work opens.
