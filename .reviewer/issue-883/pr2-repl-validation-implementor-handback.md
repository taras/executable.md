# Implementor handback: validate REPL descriptions without mounting

Increment 2 is complete and committed as
`a49229e983f35764ce59f92f43de37c15473e32f`. The assigned command and RV1–RV4
pass.

## Continuity

- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
- Branch: `agent/issue-883-pr2`, working tree clean, nothing untracked
- Commit: `a49229e983f35764ce59f92f43de37c15473e32f` — signed G, tarasm@gmail.com
- Parent: `135063e67ff4b39be0bba8ddbace08439969aeb8`
- Not pushed, per the standing prohibition.

**The parent is not the assigned base, and deliberately so.** The non-blocking
ACP specification correction you asked for is its own commit,
`135063e6`, whose parent is the accepted `9f15dc51`. So the lineage is
`b01bbe6c → 9f15dc51` (accepted rename) `→ 135063e6` (spec example) `→ a49229e9`
(this increment), and `9f15dc51` is an ancestor of this commit. The two
commits touch disjoint files, so either can be read on its own.

### The specification correction, `135063e6`

`specs/acp-client-spec.md`'s provider-factory example still declared
`complete()` and the `fresh`/`established` arms while the paragraph directly
below it already said `finish()` — the rename swept this file's prose and
missed its one code fence. The fence now matches what core declares.

Two pieces of prose that fence untrued went with it: the registration owner
"settles" a setup rather than "completing" one, and a per-turn request "names a
new session" / "names an existing session" rather than being fresh or
established. A control over `specs/`, `architecture.md`, `.agents/` and
`AGENTS.md` for code-shaped retired spellings now reports nothing.

Left alone: "a history established for another `id`", "an established history",
"opens one fresh" and similar. Those are the ordinary verb and adjective about
a history or a directory, not the retired session state.

## What changed

`packages/cli/src/repl/description.ts`

- `validateDescriptions(descriptions)` loses the `layoutAllowed` parameter, and
  `walk` loses it too.
- The synthetic refusal is gone: ``${at(here)} carries a layout ${at(path)}
  does not accept.`` **That is the precisely retired assertion.** Nothing
  replaces it — no second validator, no caller-supplied predicate.
- The issuance, missing-key, duplicate-key, focus-count, modal-ordering and
  focus-inside-the-innermost-modal checks and their `Result` behavior are
  untouched.

`packages/cli/src/repl/reconcile.ts`

- `ReplTree.validate(descriptions): Result<void>`, published ahead of `apply`
  and synchronous.
- `useReplTree<Action>()` takes nothing.
- `validate` delegates to `validateDescriptions`; the commit path's own
  pre-mutation call is unchanged and still inside `commit`, ahead of `prepare`
  and the frame increment. Serialized commits (`take`/`release`) and the joined
  retirement are untouched.

`packages/cli/tests/repl-composition.test.ts`

- "C1: a refused set changes nothing at all" drops the injected predicate and
  the one `"does not accept"` expectation. Its duplicate-key and
  conflicting-focus refusals and its mounted/frame/journal no-mutation
  assertions stay exactly as they were.
- RV1–RV4 added, on the existing `panel`/`control` component fixtures and the
  real Freedom tree.

`architecture.md` — the composition-kernel section now states the two methods,
that `apply` re-judges what it is given, that an accepted judgment is not a
reservation, and that a layout is the parent's own with no caller-supplied
policy over it and no second validator.

`specs/repl-spec.md` — **not changed, because it carries no reconciliation or
description API contract to correct.** It describes focus, input and
presentation ownership in product terms and never mentions `apply`, `validate`,
a described child set, a judgment or the predicate. Searching it for
`apply|validate|layout`, `judg`, `child set`, `describ.*child` and `duplicate`
returns only line 383, about a schema answer the compiler judges, which is
unrelated. Writing a composition-API paragraph into it would be new contract
rather than a correction, so it is left for you to decide.

## Frozen evidence

| Row | Observation |
| --- | --- |
| RV1 | On a tree of two panels with a focused `control` child, node IDs, focus, frame id, cells and the journal are recorded. `validate` of a valid added sibling returns Ok; `validate` of duplicate keys, of two focus claims and of two disjoint modal roots each return Err with the matching message. Afterwards `mounted()`, `focused()`, `frame().id` and `cells()` are identical and the journal is empty — nothing attached, updated, drawn or removed. |
| RV2 | With no prior `validate` call at all, `apply` of the duplicate-key set and of the conflicting-focus set each refuse, and `mounted()`, `focused()`, `frame().id`, `cells()` and the empty journal are preserved. |
| RV3 | `validate` of a valid two-child set returns Ok; the desired set is then changed to a duplicate-key set and `apply`'d — it refuses, with tree, frame, cells and journal unchanged. The valid set is then applied and commits: cells become `["[a]", "[b]"]`, `mount:two` appears and no `unmount:` entry does. |
| RV4 | A description carrying `layout: { slot: "nowhere" }` — exactly what the retired case refused — now validates Ok and mounts, drawing `["[x]"]` under key `a`. This is the retirement observed as behavior rather than as an absent name. |

RV3's journal assertion names `mount:two` and the absence of any `unmount:`
rather than an exact list: `running:two` is the child's own lifetime scope and
arrives whenever that scope is scheduled, so asserting it would be asserting an
order nothing guarantees.

## Commands

```text
deno task test packages/cli/tests/repl-composition.test.ts \
  packages/cli/tests/repl-entries.test.ts \
  packages/cli/tests/repl-agent-interface.test.ts \
  packages/cli/tests/repl-presentation-style.test.ts
→ ok | 58 passed (201 steps) | 0 failed (31s)
```

No first-failure output to preserve: nothing failed.

Supporting controls, beyond the assignment:

```text
deno task test packages/cli/tests/repl-forms.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts \
  packages/cli/tests/repl-terminal.test.ts
→ ok | 27 passed (133 steps) | 0 failed

oxfmt --check (the three changed TypeScript files)
→ All matched files use the correct format.
```

Those three are the remaining direct `useReplTree` callers, so together with
the assigned four every caller of the changed signature is exercised. The
fourth caller, `packages/cli/tests/fixtures/repl/presentation.ts`, is the
fixture the presentation selection drives.

### Break-it control for RV1

RV1's read-only claim would be worth nothing if it could not fail, so it was
broken twice, each in isolation from the restored file:

| Injected fault | Result |
| --- | --- |
| `validate` increments `frameId` before judging | RV1 FAILED, RV3 FAILED |
| `validate` returns `Ok(undefined)` unconditionally | RV1 FAILED, RV2/RV3/RV4 pass |

The first shows RV1's frame assertion is live; the second shows its refusal
assertions are. The file was restored from a byte copy taken before the first
fault, and the assigned command was re-run against the restored source.

## Limits honoured

No owner acquisition, no mounted section 5 work, no R7/R8 packet, no Sidekick
mount, no second layout policy, no push, no GitHub mutation, no CI inspection.
No `check`, `check:jsr`, lint or full suite was run, none being assigned.

Stopping for Planner review of `a49229e9` before the required host identity
recording increment.
