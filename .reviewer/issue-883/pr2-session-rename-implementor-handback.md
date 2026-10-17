# Implementor handback: the session, layout and structure rename

The mechanical rename of increment 1 is complete, every assigned command
passes, and it is committed and signed as
`9f15dc516ab8108efb3d4d19f970e32ffbe60000` on `agent/issue-883-pr2`. That is
the one SHA for review.

## Continuity

- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
- Branch: `agent/issue-883-pr2`
- Commit: `9f15dc516ab8108efb3d4d19f970e32ffbe60000` — signed G,
  tarasm@gmail.com, parent `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, which is
  the assigned base and is itself unmoved.
- 118 files changed, 1230 insertions, 1220 deletions, including four renames.
  Working tree clean; nothing unstaged and nothing untracked.
- Not pushed, per the standing prohibition.

The commit was delayed by the 1Password SSH agent refusing signature requests
(`error: 1Password: failed to fill whole buffer`, with
`ssh-keygen -Y sign` answering `communication with agent failed` while
`ssh-add -l` still listed all three keys). No unsigned commit was produced in
the meantime; once the agent signed again, the identical staged content was
committed unchanged.

## What was renamed

The Architect's semantic and derived tables, applied to current source,
exports, tests, diagnostics, specs, architecture and the agent rulebooks.

**Core.** `AgentSessionSetup` with `finish(session, state)`, and
`AgentSessionSetupState`'s arms `new` / `existing`. No `activate` member was
added. `SessionSetupOwner` / `createSessionSetupOwner()` with `setup(request)`;
`openSessionRequest(identity, name)` returning `SessionRequestIssuance`; the
private class `SessionRequest`; the request-data type `SessionRequestData`;
`consumeSessionRequest()`, `configureSessionRequest()`,
`isSessionRequestShaped()`, `sessionSetupOf()`; the coordinator member
`sessionSetup(request)`. `session-placement.ts` → `session-setup.ts`,
`agent-session-placement.test.ts` → `agent-session-setup.test.ts`.

**ACP.** `AcpxSessionRequest`, `AcpxSessionDetails` (state `new` / `existing`),
`AcpxSessionPolicy.requestSession` and `recordSessionIdentity` — the second
still optional, as this increment requires. Internals: `SessionDetails`,
`resolveSessionDetails`, `prepareSessionDetails`, `issuePendingSession`,
`sessionCreationState`, `detachSessionHandle`, `markExisting`, `openSession`;
the in-memory `Prepared` arm is `kind: "details"` carrying `details`.

**Spatial and structural senses, kept distinct.** `ReplLayout` with the
description field `layout` and the renamed callback `layoutAllowed` (still
present, as this increment requires); `AnswersState` keeping
`parse`/`parsed`/`misplaced`; `StructuralAnalysis` keeping `violations` and
`regions`, with `analyzeStructure`, `analyzeConstruct`, `analyzeRegion`,
`validateOutputStructure` and `structureError`; the rendered syntax heading
`**Structure:**`. Git: `composition/placement.ts` → `checkout-paths.ts`,
`run-composition/placement.ts` → `checkout-layout.ts`, `placedCheckout` →
`checkoutPathAgrees`, and the stale reason `placement` → `checkout-path`. Path
algorithms, exports and `SessionDirectoryOptions`' `root`/`session`/
`explicitSession` are unchanged. Workflow `providerSessionKey` /
`providerSessionSuffix` and Plan `sessionNameFor` / `digest` keep their exact
inputs and results.

**Registry.** The three accepted rows were transferred verbatim from the main
checkout — *agent session*, *session creation*, *existing session* — replacing
the three retired ones. No unrelated main-checkout edit was copied.

## Frozen evidence

| Row | Result |
| --- | --- |
| RN1 — owned names | The two-way control reports **8** remaining occurrences, all `GitInvocationPlace`, accounted for below. No tracked path carries a retired token. No alias or legacy export remains. The registry rows are the accepted three, with no unrelated root change. |
| RN2 — preserved meaning | The diff changes names, paths, in-memory spellings and prose only. ACPX's stored `sessionMaterialization` `pending` marker is read at three sites and never written; `deriveSessionKey`, the Git checkout-path functions, the workflow provider-key digest and the Plan digest keep identical inputs and outputs. `recordSessionIdentity` is still optional and `layoutAllowed` is still present. |
| RN3 — bridges and exports | `deno task check` and `deno task check:jsr` pass, the latter ending `Success Dry run complete`. The real `packages/acp/tests/loaded-copy.test.ts` passes, crossing the renamed literal bridge (`"finish"`, `"setup"`, `"openSessionRequest"`) between two separately bundled Core copies at runtime, which type checking cannot prove. |
| RN4 — file/render boundaries | The Git selection — including `module-partition` (whose module list names both renamed paths) and `run-composition-managed` (the child fixture) — passes. The rendered heading had **no** existing assertion, so one was added to `syntax-catalog.test.ts` SY5d, which already declares a parent construct and its region: it now asserts both rendered `**Structure:**` arms. Break-it control: restoring `**Placement:**` in the renderer fails SY5d, and restoring the rename passes it. REPL composition still exercises the existing `layoutAllowed` callback. |
| RN5 — configuration consumers | The configuration handoff's three focused selections pass with the renamed Core test path. No configuration behavior was added and no SC1–SC7 implementation is claimed. |

## Commands and results

```
deno task check                                    → exit 0
deno task check:jsr                                → exit 0, "Success Dry run complete"
deno task test <core selection, 6 files>           → ok | 14 passed (72 steps) | 0 failed
deno task test <acp selection, 3 files>            → ok | 11 passed (94 steps) | 0 failed
deno task test <cli sidekick selection, 5 files>   → ok | 15 passed (85 steps) | 0 failed
deno task test <bridge + syntax selection, 7 files>→ ok | 42 passed (229 steps) | 0 failed
deno task test <git + discovery selection, 6 files>→ ok | 20 passed (65 steps) | 0 failed
```

No command failed, so there is no first-failure output to preserve.

Supporting control, beyond the assigned commands, over every other file whose
*code* this rename changed and which no assigned selection covers:

```
core function-components/session-launch/answers/document-validation/agent-api/
plugin-api + acp session-key/acceptance + cli agent-session-coordinator
                                                   → ok | 54 passed | 0 failed
cli repl-forms + workflow agent-checkpoints/agent-sessions +
scripts scope-bound-event-registration             → ok | 15 passed | 0 failed
acp native-launch + acpx-materialization           → ok | 17 passed | 0 failed
```

`oxfmt --check packages scripts` reports all files correctly formatted.
No full suite, CI inspection, dependency mutation or vendor rebuild was run.

## The two-way search control

A scratch script, not added to the repository: it tokenizes every tracked file,
reports each token containing `plac` that is not a kept word, and separately
reports the three retired phrases. Kept words are `replace*`, `misplaced*`,
`placeholder*`, `displace*`, `ReplAction*`, the `in place` idiom and the bare
English verb `place`/`places`/`placed`/`placing`. Vendored ACPX generated and
upstream trees are excluded as pinned third-party bytes; the repository-owned
provenance prose beside them is included and was swept.

Proven in both directions against invocation-owned scratch text:

- a retired probe (`AgentSessionPlacement`, `ReplPlacement`,
  `createSessionPlacementOwner`, `placedKeys`, `**Placement:**`,
  "pending session placement", "session materialization",
  "established session", …) → **20 detections**;
- a kept probe (`replacement`, `replacements`, `CommitReplacement`,
  `beforeReplace`, `UPGRADE_REPLACE_RETURNS`, `misplaced`,
  `misplacedReturnMessage`, `isPlaceholder`, `DOCUMENT_PLACEHOLDER`,
  `displaced`, `ReplActionSlot`, `renamesInPlace`, and prose "the ledger is
  placed where the stream is consumed") → **0 detections**.

### Accounted occurrences

Every remaining occurrence, by path and reason:

| Path and lines | Token | Why it stays |
| --- | --- | --- |
| `packages/git/src/composition/git-api.ts:37,43,48,52,58` | `GitInvocationPlace` | A published Git export naming *where an invocation acts*, in neither the semantic nor the derived table, and the handoff states Git exports do not change. It is the ordinary noun "place", not the retired "placement". |
| `packages/git/api.ts:79`, `packages/git/tests/api-entrypoint.test.ts:55,315` | `GitInvocationPlace` | The same export, re-exported and imported. |

Preserved wire and stored spellings, each verified unchanged:

- `record.sessionMaterialization?.state === "pending"` — ACPX's own stored
  marker, read at `packages/acp/src/session-key.ts:121` and
  `packages/acp/src/provider.ts:1472,3061`. Both sites translate it into the
  in-memory `new` / `existing` value; neither writes it.
- `packages/acp/vendor/acpx/**` protocol members and generated bytes, and
  `packages/workflow/vendor/**`, are untouched pinned snapshots.
- Session keys, checkout paths and the Plan digest: same inputs, same results.

## Reported mechanical changes

Assertions that moved with a renamed name, with no behavioral expectation
changed: two refusal-message expectations (`"not a live session request"`,
`"already resolved its session"`) tracking the renamed error text; renamed
`describe`/`it` titles in the Core setup, ACP SM/WAP, document-validation and
REPL tiers; the `StrictHarness` log fields `requests` / `recorded`; the
`Trace.setups` field in the conversation stub; test-local fake keys
(`session:…`, `/sessions`, `tm-new`, `provider-key`); and the one *added*
assertion in SY5d described under RN4.

`test-weights.json` carries the renamed Core test path at its three
measurements with every weight value unchanged — the file names the test it
measured, and leaving it would have named a file that no longer exists.

## Limits honoured

No API behavior change, no `activate` implementation, no settings UI, no owner
acquisition in `program.ts`, no mounted section 5, no terminal R7/R8, no
36-frame packet, no push, no GitHub mutation and no CI inspection. Increment 2
does not open until the Planner accepts this one and supplies its exact base.
R2 implementation remains pending.
