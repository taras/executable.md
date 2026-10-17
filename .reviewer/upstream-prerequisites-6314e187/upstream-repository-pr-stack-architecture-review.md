# Smaller deliveries for REPL repository support

## Current prerequisite amendment

The later [reusable-interface review](upstream-repository-reusable-interface-prerequisite.md) governs the prerequisite to the preserved #902 consumer and supersedes older next-action text below. Its interface and product-verification interviews are complete. Accepted changes include execution-owned initialization, shared contextual Files/Fetch routes, scope Permissions, contextual Syntax, generated declaration metadata and URL identities, Component.generated host selection and provider answer publication. File/File.Delete/Dir become non-replaceable, Dir moves into core, and existing Workflow/Git journal-read contributions remain with their owners. No new historyChecks or restoration API is added.

The Product Owner accepted five independently useful upstream increments before refactoring #902: fixed filesystem components; scoped permissions/shared I/O; execution initialization/Syntax; generated metadata/URL identity; contextual generated host selection and remaining evaluation-input removal. Their scope, dependencies, reuse/removal assessment, focused evidence and uncertain review-size ranges are in the linked record. A [new Planner handoff](upstream-repository-prerequisite-stack-planner-handoff.md) assigns these prerequisites to a different Planner. The previous Planner retains the consumer and later repository work; existing plans/handoffs have not been rewritten, and #902 remains held at its preserved revision. All later feature PRs retain their separate review and explicit merge gates; no implementation, publication or merge is approved by this amendment.

Assessment: revise the proposed stack before preparing implementation handoffs. Deliver entry-owned File/Dir recording in an existing checkout before enabling managed Repository/Worktree selection. Split Push from pull requests and evidence reads, and include public CLI assembly and leave/reopen proof with each feature. Use the existing journal to associate local results with execution. Remove the File-specific identity protocol and routing machinery under accepted decision 2. Preserve existing journal composition and verify the new integration against it.

This is an architecture and scope assessment. Decisions 1 and 2 are accepted. The Product Owner delegates delivery ordering to the Architect; the File/Dir-first order below is settled for planning. This approves no implementation revision, full stack scope, publication or merge. Continuation metadata is rejected. Local association stays in the journal; entry ownership, generated-file permissions and external reconciliation remain intact.

## Reviewed sources and repository state

- Remote main, verified through the GitHub commits API: `f79f6730784a7ecba7253dcd35e6e5567293876c`, the merge of revert PR #900.
- Revert commit: `3159095cdc48e96914f69740b3940972fb0ce6bd`, reverting PR #899's merge `afe8a5f237e6b23a222327834be8fa7c92241471`.
- Both the revert and current main have tree `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`, exactly the tree of pre-delivery main `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`. This establishes the source baseline without checking out or fetching over any working tree. [Current main](https://github.com/taras/executable.md/commit/f79f6730784a7ecba7253dcd35e6e5567293876c), [revert](https://github.com/taras/executable.md/commit/3159095cdc48e96914f69740b3940972fb0ce6bd).
- The root workspace remains on local main `e61d6ce…`, with existing user changes. The historical worktree is clean at `559f446dbba97b33042e512fd3c018b9a0f64a47`, branch `agent/retained-repl-repositories`.
- Historical implementation inspected: `/private/tmp/xmd-retained-repl-repositories`. Its [REPL execution model](/private/tmp/xmd-retained-repl-repositories/architecture.md:5464) and [entry-host amendment](/private/tmp/xmd-retained-repl-repositories/architecture.md:6113) supply the accepted product direction. Mechanisms described alongside that direction remain subject to this review.
- The open-PR title/branch inventory returned #779, a view-only REPL proof of concept based on `agent/issue-755-codex-native-launch`. It is not a dependency of this stack. This was an overlap inventory, not a review of that PR or an exhaustive search of unlabelled work.

Read the repository instructions, Architect/interface/architecture/verification rulebooks, relevant specifications, changed architecture sections and the Files, entry-host, selection, local-operation and external-worker paths. The unchanged architecture baseline was read in the preceding architecture work; this assessment additionally reads the historical amendment and its changes against the restored baseline. The mandatory [Effection contract](https://github.com/thefrontside/effection/blob/v4/AGENTS.md) informs lifetime assessment.

The initial stack assessment ran no tests, builds or performance measurements. Its evidence is source/data-flow inspection and read-only repository/API queries. The subsequent L1 assessment adds one isolated native-lock probe, recorded below; no repository suite or CI was run. The initial assessment wrote only this report. The subsequent Product Owner instruction also records the approved no-mutation rule for `next` in the architecture rulebook. Existing plans, prompts, code and evidence remain untouched.

## Contract that survives the revert

The REPL is foreground experimentation with user or agent attention. Completed local operations consume recorded results without repeating effects or checking that the environment still matches. New local operations use the live environment. A local effect with no acknowledged result may be attempted again. There is no local start-record fence, whole-checkout inventory, predicted transition, automatic restoration or exactly-once local promise.

Selections also replay their recorded routing data. A deleted or changed checkout is not grounds to rerun a completed selector; new work needing that checkout reports its ordinary failure. Journal integrity, permissions, entry isolation, native resource ownership and external reconciliation still apply. The revised local identity proposal below changes the historical mechanism, not these product requirements.

External requests whose inputs resolve from live Git facts retain those resolved inputs. Existing GitHost and Issue workers govern external outcomes and interruption reconciliation. A local operation result cannot become a publication receipt. Ordinary-run and workflow behavior and retained encodings remain intact.

Some temporary planning files still describe the rejected stop-on-local-start proposal or whole-checkout rules. They do not supersede the accepted historical `architecture.md` or the Product Owner direction in this review request. Accepted architecture and Planner PASS did not constitute an Architect implementation review or explicit Product Owner merge approval.

## What the Files mechanisms actually do

The historical authored path is:

`canonical File body → invocation-specific Files descriptor → public Files middleware → next-first host provider → private descriptor terminal → trusted file handler → inspect → recorded local operation → captured native Files handler → answer → private settled result`.

On replay, the public Files chain is reached before the local durable operation consumes its result. Generated writes take another route: the captured generated body calls the trusted handler directly, bypassing the public Files chain. Dir has a separate invocation-specific descriptor in Git.

These are concrete integration choices, not consequences of the foreground replay contract.

| Mechanism | What it accomplishes in the historical code | Necessity and recommended disposition |
| --- | --- | --- |
| Invocation-specific Files descriptor | Reuses the stable Files API name so ambient middleware runs, but replaces the API default with this invocation's private terminal. It binds the eventual native request to a canonical occurrence. | Ordinary replay already has coroutine/position association. Use existing entry middleware and captured provider composition; remove the descriptor under accepted decision 2. |
| Private `inspect` / `answer` continuation | `inspect` supplies the occurrence once; `answer` submits the one accepted Result. The handler returns `Operation<void>`, and the caller reads private settlement rather than its return value. Object identity, ordering and revocation protect this private protocol. | It adds an identity channel and exclusive completion ownership. Decision 1 rejects the completion restriction. Existing positional matching removes the stated two-write justification for the identity channel. Recommend removing both messages rather than replacing them with another metadata-bearing callback. |
| Entry pass-through Files middleware | Forwards write, delete and ensure requests unchanged toward the private terminal. It records nothing and owns no result. | It provides no independent recording or identity function. It also cannot, by itself, bypass an answering host provider. Remove it with the private-terminal routing rather than preserve a forwarding layer as a feature. |
| Host provider's next-first fallback | Calls `next(input)` before the native handler, catches a structurally recognized `provider-unavailable` throw, then performs the ordinary host operation. This makes the invocation's private default reachable past the host that formerly answered directly. | Required by that routing topology, not by replay. It changes shared runtime ordering and absence handling for three operations. Prefer keeping the host's original terminal behavior, with recording outside the chain. Remove this fallback if the wrapper design is accepted. |
| Ignoring ordinary middleware answers | Authored write/delete routers and the Git Dir router ignore the chain's returned Result. An ordinary middleware that answers without delegating cannot complete these operations. | This is a material behavior change. It prevents ordinary stubs/custom Files implementations from answering under a retained host. The Product Owner accepted preserving ordinary answer/delegate/refuse semantics in decision 1. Use existing provider interfaces for the replacement integration. |

The source distinction is explicit. Baseline `useHostFiles()` directly answers mutations. Baseline deletion test FD6 installs middleware that returns a permission failure without delegating and expects ordinary printed refusal. Historical core test FM6 instead requires a direct success answer to fail under the new seam. The same router also disregards a direct ordinary failure answer. This is a changed result boundary, not merely extra journal metadata.

References: [core routers and handler types](/private/tmp/xmd-retained-repl-repositories/packages/core/src/file-mutations.ts:45), [authored write router](/private/tmp/xmd-retained-repl-repositories/packages/core/src/file-mutations.ts:400), [entry forwarding layer](/private/tmp/xmd-retained-repl-repositories/packages/git/src/deno/retained-repository/provider.ts:419), [host fallback](/private/tmp/xmd-retained-repl-repositories/packages/runtime/host-files.ts:797), [Dir router](/private/tmp/xmd-retained-repl-repositories/packages/git/src/deno/retained-repository/terminal.ts:41), [FM6](/private/tmp/xmd-retained-repl-repositories/packages/core/tests/file-component.test.ts:1816). Baseline behavior is in the restored tree, including [FD6](/Users/tarasmankovski/Repositories/taras/executable.md/packages/core/tests/file-delete-component.test.ts:499).

### Smaller candidate Files boundary

Record the result of the composed Files operation, rather than reserve completion for a private native terminal. On completed replay return the saved Result before entering the live Files chain. On a new operation invoke that chain, normalize its ordinary Result, and acknowledge the outcome before later work advances. Middleware may answer, transform and delegate, or refuse under its existing contract. The journal describes the composed operation's outcome; it does not independently prove the disk matches it.

Use existing entry-installed Files middleware for authored operations, and an entry-owned Files wrapper captured through the existing evaluation-profile access for generated operations. The inspected `@effectionx/context-api` implementation orders ancestor `max` middleware before descendant `max` middleware and terminal `min` middleware. Thus an entry recorder can surround document-installed Files middleware without changing the host terminal or making a descriptor per invocation. This is normal composition, not protection against arbitrary in-process tampering.

Generated operations retain their captured Files access and effective fragment directory, their existing permission ceiling, and their independence from ambient Files/Env replacement. Their live callback uses captured access; authored operations use the ordinary composed chain. Both use the same result-recording policy. The evaluation-profile Files access is a provider value that already exists; supplying an entry wrapper there does not require canonical File adoption or a new public Files input.

Local record association uses the entry's journal segment, coroutine and ordered position. Keep operation kind and authored request information in the record; use type/name matching with an input fingerprint or an explicit input check where needed, because extra description fields alone are not compared by the journal. Keep entry owner verification in the feature's history admission. Two identical requests at different positions are valid distinct operations. No source line, separate local site, new invocation channel or metadata on `next` is proposed.

This removes the justification for next-first runtime fallback, entry forwarding and new core File identity hooks. Existing core form dispatch and generated permission protections stay intact. Existing external owner/site delivery remains intact. Reuse existing journal composition rather than add an outer effect that changes the order of already journaled work.

### Journal trace: reuse existing association and composition

The source trace establishes these points:

| Path | Existing behavior and consequence |
| --- | --- |
| Two identical writes in sequence | `checkReplay()` selects the next yield of the current coroutine before checking type/name. Equal names at different positions do not make the results interchangeable. |
| Loop iterations | Repeated effects advance the same coroutine's position. A repeated local request does not require a source occurrence to separate its results. |
| Concurrent XMD branches | Core uses `durableAll`; the combinator allocates child IDs in input order before starting their work. Each child has its own replay history. Native completion order does not identify a branch. |
| Generated operations | Existing captured methods can invoke the same entry result recorder. Generated source admission and captured access remain the existing security boundary; local result matching needs no additional component identity. |
| Missing acknowledgement | A plain local durable effect has no result to consume and takes its live path again. Native work may have happened before interruption. No local start record or environment repair is added. |
| Nested XMD work | Existing expansion offers child effects inline in their execution sequence; structured concurrent children have separate histories. Preserve that composition when adding recording. |

Existing nesting is not a demonstrated journal defect or an unresolved product decision. The concern arose from the Architect's proposed outer wrapper: `createDurableOperation()` checks replay before entering its callback and publishes after that callback returns. Putting already journaled work in that callback could save `inner → outer` but try to replay `outer` first. That is evidence against blindly adding that wrapper, not evidence for another journal capability.

Keep ordinary inline composition and durable child behavior. The implementation must place recording at the operation boundary without swallowing or reordering existing journaled work. Focused evidence checks nesting and interruption as integration obligations. No new grouping protocol, durable-child cancellation policy or journal prerequisite PR is recommended. Reopen architecture only if an actual supported path demonstrates a structural gap that existing mechanisms cannot satisfy.

Also move completed-result matching ahead of live path canonicalization/discovery. Historical Git `files.ts` calls `targetOf()` and then selection discovery before its durable operation; `targetOf()` calls `realpath(cwd)`. Copying that ordering would still read live filesystem state on replay. Rebuild routing from retained selections; live containment/admission belongs to new work. Keep symlink/path admission in the ordinary provider, rather than use diagnostics as authority.

References: [replay matching](/Users/tarasmankovski/Repositories/taras/executable.md/packages/durable-streams/effect.ts:113), [event descriptions](/Users/tarasmankovski/Repositories/taras/executable.md/packages/durable-streams/types.ts:37), [position semantics](/Users/tarasmankovski/Repositories/taras/executable.md/packages/durable-streams/position.ts:1), [child replay and cancellation](/Users/tarasmankovski/Repositories/taras/executable.md/packages/durable-streams/combinators.ts:56), [child allocation](/Users/tarasmankovski/Repositories/taras/executable.md/packages/durable-streams/combinators.ts:244), [core captured Files](/Users/tarasmankovski/Repositories/taras/executable.md/packages/core/src/fragment-capabilities.ts:210), [historical pre-record canonicalization](/private/tmp/xmd-retained-repl-repositories/packages/git/src/deno/retained-repository/files.ts:235).

## Recommended delivery order and dependencies

Recommend six feature PRs and, only if useful, one small preparatory PTY extraction. Each feature includes its own runtime wiring, source/compiled public path and accurate documentation. There is no final assembly-only delivery.

The proposal's selection-first order needs revision. Once a Repository body executes ordinary File/Dir operations in its checkout, those operations are already reachable. Delivering selection without recording them would repeat completed work during continuation. Documenting the omission does not satisfy the accepted local replay contract. Put entry-owned File/Dir recording and ambient checkout ownership first, then enable managed selection against that working recorder. This avoids a temporary refusal layer or an all-capability fallback. The Product Owner delegated ordering to the Architect, and this is the selected order for planning.

| PR | Useful outcome and dependency | Approximate changed lines, including tests/docs |
| --- | --- | --- |
| Optional T | Existing REPL exit tests share a reusable PTY fixture; no new capability. Independent of all feature code. | 700–1,200; much is movement/deletion. |
| 1 | Record authored/generated File mutations and authored Dir ensures in an existing checkout; owns the executing entry, ambient selection and its lease. Depends on restored main; can use T. | 1,600–2,800; replacement integration has the greatest sizing uncertainty. |
| 2 | Select managed Repository/Worktree and replay its placement result; File/Dir inside it already records correctly. Depends on 1. | 1,000–2,000 |
| 3 | Stage, switch and commit live, then replay their recorded results. Depends on 1 for ambient checkout support and 2 for managed selection support. | 800–1,500 |
| 4 | Publish with Push under the entry identity and reconcile interruptions. Depends on 1–2; public journey uses 3. | 1,000–1,900 |
| 5 | Open/update PRs against the entry's publication and read retained review evidence. Depends on 4. | 1,200–2,300 |
| 6 | Read/upsert Issues with stable entry identity and existing reconciliation. Depends on 1's entry identity/lifetime only; can be delivered earlier. | 700–1,400 |

These ranges are rough review estimates, not measured future diffs, targets or allowances. A 5k-line change is not acceptable merely because an earlier PR was that size. The eventual patch, its concepts and its evidence determine whether it needs another split. Files and PR/evidence estimates are least certain. No journal prerequisite is added on the strength of the hypothetical wrapper problem. Do not split a working boundary into incompatible halves just to satisfy a count.

For scale, the historical diff against restored main is 71 files, 14,313 additions and 703 deletions. Of that, tests/fixtures account for 7,480 additions and 541 deletions; core production for 1,085 additions; Git production for 4,913; CLI production for 327; architecture/specs for 395. These are `git diff --numstat` totals, not independent complexity estimates. The 580-line PTY fixture largely replaces a 518-line block in an existing test; the 932-line repository journey fixture and 1,347-line CLI integration test should grow with the features that need them, not arrive wholesale in PR 1.

### Optional T: share existing terminal fixture behavior

Include only the reusable PTY allocation/input/output/close functionality needed by existing `repl-exit-pty` tests. Exclude repository worlds, forge fixtures, checkpoint programs and all production wiring. The affected boundary is test support and its cancellation/close lifetime. Focused evidence is the unchanged public exit test, including leaving during a pending read and joined terminal cleanup. Reuse `packages/cli/tests/fixtures/pty.ts` selectively; do not mechanically copy every helper.

Skip this PR if a small fixture can be introduced with the first consumer without obscuring its review. Test extraction is not a mandatory architectural prerequisite.

### PR 1: entry-owned File and Dir results in an existing checkout

Include the runtime-supplied factory, per-executing-entry construction, stable owner, exact owning journal segment, lazy ambient checkout selection with its small recorded result, common-directory exclusion and joined teardown. Keep history/frozen views passive and live-head continuation idempotent. This gives the entry a useful supported environment without enabling managed Repository/Worktree yet.

Include entry Files middleware, an entry wrapper supplied through existing captured Files access, authored write/delete and Dir ensure recording in that ambient checkout, captured generated writes/deletes, fragment-relative target parity, ordinary Result/refusal serialization and replay, and fatal persistence failure before subsequent work. Preserve existing journal nesting and interruption behavior. Generated Dir remains outside the ordinary REPL profile's admitted write table. Outside-checkout files and Node/Bun ordinary files retain existing behavior.

Exclude managed destination creation, Repository/Worktree component support, local Git, external workers, read recording, a new permission ceiling and all rejected File-specific identity/routing machinery. No all-capability provider, feature flags or placeholder future handlers are installed. Lease infrastructure may use the established lock location; it does not enable or create a managed checkout. Acquire it only for the entry that actually needs the ambient repository.

Affected boundaries: CLI entry factory and installation lifetime; ambient selection/private routing; common-directory ownership; entry Files recording and journal admission; existing generated capability capture; Git-owned Dir. Return the installation and captured Files access because both have immediate consumers in this PR. Do not expose diagnostic owner/history/selection accessors through the package result. Add later record variants/configuration only with consumers. No new core File identity/adoption interface is justified.

Focused evidence: source and compiled public authored/generated File and Dir checkpoints in an existing checkout; write `A`, externally change to `B`, leave/reopen and observe `B`; completed writes/deletes/ensures replay without live path canonicalization/discovery; an unacknowledged operation takes the live path again. Verify direct middleware success/refusal and transform/delegate behavior; repeated equal requests, loops and concurrent branches; existing nested journal order and continuation after interruption; captured generated access resisting ambient Files/Env replacement. Verify two entries' private state stays separate, passive history acquires nothing, and leases release before a successor. Run affected ordinary Files/Dir, workflow and evaluation-ceiling regressions. Node/Bun still starts and retains ordinary File/Dir behavior without importing the Deno repository graph.

Run one bounded paired ordinary-run/REPL File/Dir cost check with equal fixtures, payloads and unrelated content on both sides, and separate completed replay. Record added calls/journal size and elapsed time without inventing a numeric budget. The historical local cost test is a useful structural seed, but its ordinary comparison does not populate the same unrelated files; it cannot establish a fair performance comparison as written. Avoid a broader benchmark project. Specifications describe the ambient-checkout capability and keep managed repository operations explicitly unavailable.

### PR 2: managed Repository and Worktree selection

Include the canonical managed root, ordinary managed Repository/Worktree selectors, small selection result records, private routing reconstructed from results, placement/common-directory leases, joined native creation and teardown. Reuse PR 1's recorder for authored/generated File and Dir effects in those selections. The historical `RetainedSelectionHost.files` dependency should become minimal entry selection/owner data; selection itself does not need a Files effect protocol.

Exclude local Git, external workers and changes to ordinary-run selection policy. Keep record admission positional for local operations; a repeated equal selection request at a different journal position is not a duplicate by name. No inventory, checkout restoration or creation prediction is added.

Affected boundaries: managed selection/provider and slot ownership, saved placement data and entry-selected routing. Focused evidence: public source/compiled Repository and Worktree plus File/Dir leave/reopen; the ordinary selector is not called again after recorded placement is changed/removed; completed effects replay, while new work reports an ordinary missing-placement failure; nested placements, concurrent exclusion, interrupted creation and lease teardown. Run existing ordinary managed selection/nesting regressions. Specifications enable managed selection and its already-working File/Dir behavior together.

### PR 3: local Git recorded results

Include Add/Switch/Commit wrappers around existing ordinary performers; small operation result/refusal records; lazily captured ordinary commit identity. A new Commit uses the current index, clock and identity, and its returned OID is retained. Completed local Git operations perform no Git mutation or checkout comparison.

Exclude Push, PRs, Issues, new native implementations and commit prediction. A no-result interruption may retry against live state. Retention must not imply that a previously committed OID is today's HEAD.

Affected boundaries: ordinary performer reuse, local result codecs and entry-selected checkout routing; preserve existing component/form dispatch without adding a new Files identity protocol. Focused evidence: public write/Add/Commit leave/reopen with native mutation counters; Switch ordinary refusal and live-state behavior; distinct positions in loops and concurrent branches; recorded ordinary refusal replay; persistence failure blocks later document work. Run the affected ordinary Git/commit/selection regressions and module partition tests. Add this capability's source/compiled checkpoint to the existing public harness now.

### PR 4: Push reconciliation

Include the owner-specified GitHost worker entrypoint with unchanged workflow entrypoint behavior, a saved resolved Push request, existing observe/adopt/perform/refuse policy, isolated transport/object-source lifetime and lazy credentials. Push is useful by itself. Its own saved request and definitive worker outcome provide the data PR 5 later pairs.

Exclude PR upsert/read adapters, publication-admission UI/API and Issue workers. Do not build an unused publication subsystem merely for the next PR. Preserve transport isolation that the existing Push protocol actually needs; it is not local transition prediction.

Affected boundaries: GitHost owner/request delivery, unchanged definitive outcome encoding, Deno transport and entry resources. Focused evidence: public source/compiled Push and reopen; saved branch/commit used after live HEAD moves; completed zero-service/credential replay; interrupted absence performs and compatible remote completion adopts; conflict/unavailability preserve existing behavior; ordinary/workflow GitHost encodings and fork rules remain intact.

### PR 5: pull requests and evidence reads

Include exact same-entry saved Push request/receipt association, private publication evidence restoration, complete saved PR request, existing PR reconciliation, and retained reviews/comments/checks through admitted read adapters. Retain the owner check needed because existing read names omit the owner for workflow compatibility.

Exclude Issue operations and changes to existing external record formats/policy. A new PR uses live branch/head and requires this entry's matching publication; an already saved PR uses its saved head/base/body. A copied local binding or middleware reply is not a successful Push receipt.

Affected boundaries: private publication admission, owner-specified worker, evidence-read occurrence delivery beneath adapter admission. Replace the historical entry-wide mutable `reading` slot with binding scoped to the individual read, using existing scoped middleware composition. Keep adapter admission before durable service-read recording.

Focused evidence: public Push → leave/reopen → PR; advance HEAD and refuse a new PR until an owning Push; replay an existing saved PR without changing its head; pending service result adoption; completed evidence read makes no request while a later authored read sees updated data; denied targets retain no service question. Run existing workflow PR/read/fork regressions unchanged. Source/compiled journeys cover this increment rather than wait for PR 6.

### PR 6: Issues under entry ownership

Include stable entry/site identity around the existing Issue read/upsert worker and adapter. Reuse already complete authored Issue inputs and the existing idempotency/reconciliation protocol. This feature needs no selected checkout, Push result or File seam, even when its element happens to appear inside a Repository.

Remove the historical selected-checkout-only `freezeIssueRequest` duplication and its Files-host/enclosing dependency. Do not preserve a lane-dependent request barrier after the lane's purpose has disappeared. A separate saved request would need evidence that the existing Issue protocol lacks necessary inputs; authored inputs alone do not justify duplicating them.

Affected boundaries: owned Issue entrypoint and entry lifetime; unchanged workflow borrowing/keys; tracker/provider admission. Focused evidence: public read/upsert leave/reopen outside a checkout and inside one; same-entry completed replay and interrupted reconciliation; identical text in another entry/site gets a different identity; no Git/managed-root acquisition for standalone Issue work; unchanged ordinary/workflow Issue regressions. Extend source/compiled proof with the Issue checkpoint.

## Historical code disposition

Reusable means a source candidate with the final patch still subject to review; it does not mean copy or cherry-pick approval.

| Disposition | Historical material | Reason and destination |
| --- | --- | --- |
| Reuse selectively | CLI `repl-repositories.ts`, factory threading, session task construction, `resume()` guards and passive frozen-view handling | Useful entry lifetime/absence design. PR 1 extracts only its supported installation; later access members arrive with consumers. |
| Reuse selectively | `deno/run-composition` selectors, native local performers, metadata, root canonicalization, leases and scoped lazy acquisition | Established live behavior. PR 1 takes ambient discovery and lease ownership; PR 2 takes managed selectors/root handling; PR 3 takes local Git performers. Retain ordinary defaults and review common-directory exclusion. |
| Reuse with simplification | `retained-repository/local.ts`, `records.ts`, `admission.ts`, selection result parsing | Ordinary durable results and input integrity fit. Under revised decision 2, remove local site dependency and duplicate-by-name rejection: repeated equal requests at different journal positions are valid. Preserve external identity rules separately. Remove stale frontier names/comments, unused selection arguments, broad all-feature unions and diagnostic accessors without consumers. No local start/completion-pair protocol returns. |
| Replace with existing provider composition | Git `files.ts` and `terminal.ts`; entry captured Files assembly | Use ordinary middleware and the existing captured provider interface. Match completed results before live path canonicalization/discovery. Preserve existing nested journal order and continuation. |
| Discard File-specific additions | `core/src/file-mutations.ts`, `components/file-mutation-components.ts`, associated File adoption/generated identity additions | Accepted decision 2 removes the separate local occurrence channel. Existing core form dispatch and generated access capture remain. A broad core hook should not be retained to solve an ordering problem created by a new wrapper. |
| Remove through the smaller recording design | Entry pass-through layer, invocation-specific Files defaults, private inspect/answer settlement state machine, host next-first fallback and exported `FILES_API` solely for rebuilding descriptors | These support the rejected completion restriction and additional local identity routing. Remove their dedicated tests with those contracts; retain entry ownership, permission, ordinary middleware and lifetime evidence. |
| Reuse external protocol, review entry adaptation | `git-host/effect.ts`, `issue/effect.ts`, Push transport hooks, owned PR read adapter | Existing workers remain sole external outcome owners. PRs 4–6 review only their entry-owner adaptation without rewriting workflow rules. |
| Split and simplify | `retained-repository/external.ts`, `publication.ts`, `observations.ts` | Push, PR/evidence and Issues are separate useful consumers. Issue does not depend on a checkout/File host. Publication pairing remains with PR admission. |
| Reuse evidence patterns; divide fixtures | Native local/external/lifecycle/record tests, CLI repository tests, PTY and compiled fixtures | Keep representative counters, real public paths and cancellation barriers. Avoid importing thousands of lines of unused future-slice fixture branches. |
| Rewrite affected assertions/prose | Historical architecture/spec additions and core FM protocol tests | Preserve product direction, remove obsolete mechanism commitments. `specs/workflow-workspace-spec.md` §2.3 and §9 still describe frozen local transitions/frontiers in the historical head; do not copy those contradictory clauses. |
| Leave absent | Earlier `frontier.ts`, local scratch/creation/commit prediction and their evidence | They are already absent at the historical final head. No stack slice revives them, or the earlier stop-on-local-start proposal. |

No generic framework for partial providers, feature flags, recovery, history migration or PR-stack management is proposed. Feature-specific code and exports enter with their first real consumer. Old experimental snapshot journals remain passive evidence; they are not silently reinterpreted. Keep ordinary/workflow history unchanged. The review request assigns no new requirement to resume journals written by the reverted implementation. Preserve that evidence; an actual compatibility need would require an explicit scope decision. Do not add a migration subsystem or remove an existing compatibility guarantee on that assumption.

## Completed boundary assessment

The remaining inventory was traced through construction and consumption. Reuse below follows architecture rules 2 and 3; it does not introduce a new product contract or approve an exact replacement implementation.

### Captured generated access: seven existing members

`FragmentFileAccess` already has `checkFilePath`, `readTextFile`, `globFiles`, `writeTextFile`, `deleteFile`, `ensureDirectory` and `workingDirectory`. The existing capability capture binds these operations and revokes access when its executing owner ends. Each generated fragment resolves its working directory through the captured operation; the fragment cursor is saved and restored by existing fragment entry handling. The REPL's write-admission table remains unchanged, including its exclusion of generated Dir.

The historical CLI's `withEntryFileAccess` replaces only the Files access in installations that already carry it. Evaluation handlers and the permission ceiling stay intact. PR 1 can reuse this binding for its entry-owned recorder. It needs no new core capability identity, adoption protocol or ambient-context lookup. Missing access for an admitted generated capability remains the existing setup refusal; a runtime without an entry factory retains ordinary Files behavior. Authored middleware and generated captured access retain their respective existing composition rules.

### Entry factory: three request members and two consumed result members

The historical CLI request carries `executionId`, `entryKey` and `source`; the consumed result carries `installation` and `files`. `runEntry` constructs the factory inside the executing entry task, once, then installs its result around that entry's exact journal segment and captured generated access. Passive history rendering does not construct it. Exit halts and joins the task before another entry can acquire its resources. Deno and compiled entrypoints provide the factory; Node/Bun omit it and do not import the native repository graph. This is consistent with the accepted entry-host amendment and existing runtime-adapter boundary.

Keep identity derived from the trusted execution and entry key. Include `source` only where a real consumer needs it; removing File-specific occurrence delivery removes its local justification. Preserve required installation/access results when both are consumed, rather than inventing optional future capabilities. The historical Git provider's nine request members combine identity, cwd, managed root, native host, Files and optional Issue/PR configuration. Each increment takes only the subset its consumers need. Ordinary defaults and test injection stay in the Deno assembly.

The Git result's `owner`, `history()` and `selections()` have no CLI consumers. Keep those values private instead of exporting diagnostics as an entry contract. Export the native assembly entrypoint and types only where the CLI uses them. Acquisition stays lazy in the entry owner's scope, using existing `lazily(entry, ...)`: cancelling a borrower does not transfer resource ownership, and entry teardown joins the owning work. PR 1 needs ambient discovery/leases; managed root/selection arrives in PR 2. No all-feature installation is necessary.

### External adaptation: existing outcomes, narrower binding

The owned GitHost input has three members (`owner`, `site`, `request`), as does the owned Issue input. Both adapt entry identity into the existing workers. GitHost calls the same reconciliation implementation as workflow; Issue read/upsert uses the same durable read and upsert implementation. Workflow borrowing, fork rules, request encodings and definitive outcomes remain unchanged. These worker entrypoints are internal module exports; do not promote them into public package APIs without a consumer.

External `site` remains the canonical occurrence used by existing reconciliation, supplied internally. This does not restore a site argument to authored File APIs. Preserve that distinction in record types: removing local occurrence delivery must not discard the owner/occurrence pairing between a resolved Push request and its successful GitHost receipt. `publication.ts` directly compares both identities and the complete Git inputs before admitting publication. Preserve that useful pairing in PR 5, independent of local Files machinery. Issue needs neither a Files host nor a selected checkout.

The historical evidence-read input has two members: `owner` and `site(): string | undefined`. Its getter reads one mutable `reading` variable shared by the entry. `externalHost.reading` sets the variable for a read and clears it during teardown; the installed read handler obtains it later. The shape therefore does not express the read's own lifetime. This assessment does not report a reproduced concurrency failure. It recommends using the established operation-scoped middleware pattern to bind immutable owner/occurrence values during the individual read. Keep that binding beneath destination admission so denied reads create no service record. Do not change workflow read names or reconciliation to solve an entry adapter's composition problem.

The five boundary review items are now assessed: two material Files decisions were accepted; generated access, entry lifetime and existing external workers are conforming reuse with the bounded reductions above. Delivery order is settled under Product Owner delegation. Exact replacement cross-package signatures still receive review with their feature; this inventory does not preapprove them.

## System-boundary interview and unresolved decisions

The interview was triggered because the candidate changed Files completion ownership and API reachability/absence across core, runtime and Git, and affected captured generated access and entry lifetimes. There are five review items. Items 1 and 2 are accepted; continuation metadata is rejected. Items 3–5 were traced and assessed above as established reuse with bounded reductions. Interview any actual new or changed contract when its exact feature interface is proposed; do not reopen the accepted behavior.

1. Accepted: preserve ordinary Files middleware answers and record the composed operation's result.
2. Accepted: journal-owned local association, with request/outcome in the record; remove the File-specific identity protocol and routing machinery, with no authored site parameter or metadata attached to `next`.
3. Generated access: the captured Files/working-directory binding and its requiredness, lifetime and absence semantics under the unchanged ceiling.
4. Entry factory: installation/access members, operation availability per increment, passive construction and joined resource ownership.
5. External owner adaptation: exact GitHost/Issue/read bridge members, their visibility and lifetime, while preserving external encodings and reconciliation.

A separate product review confirms the staged supported surfaces and their public checkpoints before the Planner freezes acceptance. Approving a boundary does not approve all later signatures or every proposed PR. Architecture rules delegate conforming reuse/local helper choices; they do not settle a change to middleware completion semantics.

### Decision 1: may ordinary Files middleware answer?

Feature: let users and agents test or replace filesystem behavior through the existing middleware contract while recorded replay preserves the result they observed. The boundary has three mutation members: `writeTextFile`, `deleteFile` and `ensureDirectory`. Start with `writeTextFile`; the shared completion rule is the first material decision, not approval of every member or of a replacement recording interface.

Example: a test middleware answers a File write successfully without touching disk. A new entry observes that ordinary success; continuation returns the saved success without calling middleware or disk again. Likewise, a middleware-returned ordinary permission refusal is saved and replayed as that refusal. No success here authorizes external publication.

Current ordinary operation signatures are:

```ts
writeTextFile(input: FileWriteInput): Operation<Result<FileWriteSuccess>>;
deleteFile(input: FilePathInput): Operation<Result<void>>;
ensureDirectory(input: FilePathInput): Operation<Result<void>>;
```

Ordinary middleware may answer a valid Result or delegate. The historical retained path instead uses `FileMutationHandler(args, next): Operation<void>` and reads only private `next({ intent: "answer", ... })` settlement; returning a Result through the public chain cannot finish it.

The ordinary `writeTextFile` member has no member JSDoc. Its Files module contract describes semantic operations returning ordinary filesystem failures as Results, infrastructure/provider failures as throws, and cancellation as neither. The historical handler documentation instead says: “Handle one request; completion is submitted through next.”

Contract: the composed Files operation owns the live Result; middleware may supply it or delegate to the host. Core owns the canonical invocation and the entry host owns recording. A call lasts until its operation returns or unwinds; cancellation does not acknowledge a Result. `writeTextFile` is required on a Files provider. An absent provider throws rather than silently using another host. The entry recording hook may be absent outside this feature; ordinary Files still works there. A saved local success describes the result returned to the document, not proof of current disk contents or authority to publish externally.

Assessment: the existing Result-returning type already expresses operation completion. The historical void-returning handler changes ownership by giving its private continuation exclusive authority to finish. Accepted decision 2 removes the additional local occurrence-delivery requirement.

Proposed: preserve the ordinary signature and answer/delegate/refuse semantics. The contract for the first member is:

```ts
/** Return the composed write's outcome; middleware may answer or delegate. */
writeTextFile(input: FileWriteInput): Operation<Result<FileWriteSuccess>>;
```

Preserve the composed operation's Result through existing entry middleware and captured provider composition. Core still owns form dispatch, permissions remain in force, and generated access stays captured. This is contract wording, not an authorized source edit. No replacement `FileMutationNext` interface is required.

The alternative is to keep exclusive private-terminal completion. That makes a recorded local result evidence that the chosen privileged terminal accepted it, but changes how existing middleware/stubs work and retains the descriptor/fallback/settlement machinery. No accepted foreground requirement currently requires that stronger local meaning.

Accepted by the Product Owner after the concrete test-middleware explanation: a Files middleware may answer directly, including a test replacement returning success. The first execution records the composed operation's valid result; replay returns that result without invoking middleware or the filesystem. New operations invoke the configured operation. A private native terminal is not required to authorize local completion. This settles the shared completion behavior, not the complete recording-hook interface or stack.

### Decision 2: journal-owned local association

The Product Owner rejects attaching identity metadata to `next` and directs that this design never be proposed again. The approved reusable rule is recorded in `.agents/architecture-rules.md`: “Never mutate `next` or attach metadata to it; keep the continuation callable unchanged.” No member of the proposed metadata-bearing callback is accepted.

The explanation wrongly presented two writes to the same path as evidence that another occurrence-delivery interface is necessary. Existing replay already selects the next retained yield in the current coroutine and checks its description's `type` and `name`. Two writes in sequence occupy two positions, including identical writes. Concurrent durable children have separate coroutine histories. A source line number is not required for that distinction.

Verified existing boundaries:

- `packages/durable-streams/effect.ts` consumes the next retained yield from the current coroutine, checks type/name, and returns the stored result before executing the live callback.
- `packages/durable-streams/types.ts` defines a yield with coroutine ID, operation description and result. The description permits additional JSON input/diagnostic fields; only type/name participate in ordinary description matching.
- `packages/durable-streams/position.ts` derives an execution coordinate from coroutine ID and settled-yield count. The coordinate is observation, not authority, and a new interface need not duplicate it.
- Core's expansion snapshot already describes the current component. It is not automatically copied into every durable operation description, and its replaceable contextual value is not an authorization boundary.
- Historical `retained-repository/local.ts` adds a source/occurrence value to its request fingerprint and result payload before invoking the existing positional durable operation. That added identity policy must be justified separately from ordinary result replay; the two-write example does not justify it.

Revised assessment: start with existing journal matching and put the local operation's request/result information in its record. Determine the minimum recording boundary that covers authored and captured generated operations. Trace nested operations and concurrent children before concluding that the current wiring needs no adjustment. Do not infer a new public or cross-package occurrence member from the rejected proposal, or use replaceable component context as authority for entry ownership or external publication.

The follow-up trace finds no supported local result-replay requirement that needs a separate canonical occurrence channel. Two writes, loop iterations and concurrent durable branches are already distinguished by the journal. Historical admission's duplicate-by-name check is a consequence of the added identity policy, not a journal limitation: local equality of type/name/request at different positions must be accepted. Existing journal composition also handles nested work; adding an incorrectly placed outer effect would be an integration error.

The local record contract is:

- The entry host supplies the owner and exact owning stream segment.
- The journal supplies the coroutine and ordered position.
- The operation description supplies kind and a stable request name/fingerprint; input fields carry the request the recorder received.
- The stored result carries the ordinary success/refusal needed to return the same answer.
- The reader parses the record, checks owner/request consistency and uses the existing journal matcher. It does not inspect the checkout.

Component/source details may be retained as diagnostic metadata where available. They are not another local matching coordinate or permission credential. The existing descriptor format already permits JSON input/diagnostic fields, so adding useful request information does not require a new public API. Existing external GitHost/Issue owner/site identities, receipts and reconciliation remain unchanged; existing core form dispatch and evaluation permissions remain unchanged.

Accepted architecture decision: local repository result replay uses the owning journal's execution order and operation description; it does not require a separate component-occurrence delivery interface. The Product Owner agrees to remove the File-specific identity protocol and routing machinery while preserving entry ownership, generated-file permissions and external reconciliation. Record sufficient request/outcome data at the existing boundary and keep `next` unchanged.

The Product Owner also questions treating nested replay as missing journal behavior. The assessment is corrected: existing journal composition remains the mechanism; no new product decision or durable capability follows from the hypothetical outer-wrapper problem. Verify that the new integration preserves it. No implementation or new tests were written.

The historical amendment's affected local identity clauses need reconciliation before a finalized implementation handoff. This report records the acceptance; it does not edit historical architecture, replace the existing plan or approve the stack.

## L1: common-directory lease resolution

Status: L1 is resolved. Ownership and placement use established reuse; the Product Owner accepted the contention outcome below. This is a bounded amendment to PR 1 planning, not implementation authorization. The Planner records this resolution in its artifacts before releasing their L1 hold.

### Ownership: reuse one native lock

Use the existing `useAdvisoryLock(path)` from `@executablemd/workflow/deno`, behind a private helper in Git's Deno REPL repository adapter. A suitable internal signature is:

```ts
/** Hold the canonical common directory for the calling scope, or refuse immediately. */
function useCommonDirectoryLease(commonDirectory: string): Operation<void>;
```

Its sole input is the canonical common Git directory discovered by trusted native selection. It derives the existing hashed sidecar path at `tmpdir()/xmd-common-lanes/<digest>.lock`. Leave the sidecar in place. The helper owns acquisition/release in its calling scope; the entry calls it through the existing lazy single-flight acquisition in the entry owner's scope. Same-entry borrowers reuse that acquisition. Each independent live entry opens its own native handle. No durable owner string acts as a live acquisition token, and no handle escapes to authored middleware or journal data.

Do not add the proposed process-global holder registry, shared namespaced state, opaque-token API or replaceable Context map. The kernel lock already supplies exclusion between independently opened handles in one process as well as between cooperating processes. Its native descriptor is the live resource. This removes the need to design another trusted registry. There is no new cross-package contextual API or `/api` export: Git consumes the already exported native Workflow helper and keeps its common-directory helper internal. Ordinary managed-slot policy remains unchanged.

Evidence correcting the historical comment:

- The release configuration pins Deno 2.9.5. Its [native implementation](https://github.com/denoland/deno/blob/v2.9.5/ext/io/lib.rs#L1136) delegates exclusive nonblocking acquisition to Rust `File::try_lock`. Deno 2.9.7 uses the same primitive.
- Rust's [Unix implementation](https://github.com/rust-lang/rust/blob/1.95.0/library/std/src/sys/fs/unix.rs#L1435) uses nonblocking `flock` on Linux and Apple targets. The [Linux manual source](https://github.com/mkerrisk/man-pages/blob/master/man2/flock.2) explicitly distinguishes independently opened descriptors from duplicates: independently opened descriptors can conflict even within one process. These are not the per-process record-lock semantics asserted by historical `local.ts`.
- Rust's [Windows implementation](https://github.com/rust-lang/rust/blob/1.95.0/library/std/src/sys/fs/windows.rs#L431) uses exclusive, immediate `LockFileEx`. [Microsoft's contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex) describes exclusion through another independently opened handle, including in the locking process.
- An isolated probe on this host, Deno 2.9.7 / Darwin, opened one scratch sidecar twice. Results: first acquisition `true`; second while held `false`; second after release `true`. Cleanup closed both handles and removed the scratch directory. No dependency installation or production source change occurred. Linux, Windows and compiled execution were not run in this assessment; E8 remains the feature-level evidence requirement.
- Existing workflow test WLA1 already checks same-host exclusion and reacquisition after owner scope exit. It is useful regression reuse, not a test result reported by this assessment.

This resolves the proposed same-process boundary using an existing mechanism. It does not strengthen exclusion against arbitrary Git tools, users editing the checkout, hostile replacement of native adapters, or processes that do not participate in this sidecar protocol.

### Cleanup correction: included, bounded

Current `packages/workflow/src/deno/advisory-lock.ts` opens and acquires before yielding cleanup registration. Its waiting sibling registers cleanup before opening. Correct the nonwaiting helper to that same established ownership order before reuse: establish cleanup, open the descriptor, attempt the nonblocking lock, then provide the outcome. A refused descriptor closes promptly; a held descriptor unlocks and closes on scope exit; cleanup handles partial acquisition without double close. Keep its existing signature, immediate-refusal behavior and workflow semantics.

This correction is directly required by PR 1's native resource reuse and repository rule 16. It needs focused cancellation/acquisition evidence plus existing workflow lifecycle evidence, not a Workflow redesign. The Planner may refine the directly affected E8 case; the remaining frozen matrix stays intact.

### Contention outcome: accepted

Current behavior: ordinary managed-slot contention throws printable `ManagedCheckoutError`. Ordinary Files refusals return a Result and are saved. A new REPL lease failure crosses neither boundary cleanly by default: core `invokeFiles` normalizes an unrelated throw to a generic provider invariant, while saving contention as a File refusal would replay that refusal after the lock becomes free.

Intent: tell the person another participating entry/process is using the checkout before the new mutation runs, and let a later attempt use the environment then available. Completed File replay still acquires no lease.

Accepted behavior: stop the executing entry at lease acquisition, without acknowledging a File operation result. Preserve previously completed records; do not persist contention as the File's completed refusal. The message is: “Another XMD entry or process holds this checkout. End that work before trying again.” No automatic waiting or retry is introduced, and this wording does not promise that every failed entry is resumable.

Keep the failure feature-specific inside Git and use the existing fatal propagation path. The existing `StaleInputError` subclass pattern is the narrow available transport through core Files normalization; no new core or runtime failure API is needed. Acquire outside the result-recording callback, after completed replay has been excluded, so a thrown acquisition failure does not itself become a durable File error. Preserve ordinary middleware Result/refusal semantics after acquisition. Do not label lock contention as corrupt history in the user-facing message.

The Product Owner accepted this behavior in response to the focused L1 question. Keeping acquisition failure outside the File outcome prevents temporary contention from becoming a saved refusal after the lock is free.

## Next actor and review gates

Decisions 1 and 2 are recorded as accepted. Continuation metadata is rejected. Existing journal composition settles nesting behavior without another product decision. The remaining boundary assessment is complete at this scope-review level. Conforming reuse stays delegated; exact changed interfaces receive review with their feature.

Ordering decision: the Product Owner responded, "whatever order you think work", delegating the choice to the Architect. Select File/Dir recording in an existing checkout first, managed Repository/Worktree selection second, then local Git, Push and PR/evidence. Issues depend only on the first increment and may proceed independently afterward. Each feature carries its source/compiled public checkpoint. No further Product Owner answer is required to begin bounded planning.

The Planner has prepared the stack plan and PR 1 handoff against main `f79f6730784a7ecba7253dcd35e6e5567293876c`, and returned L1. L1 is now resolved above. The next action is a bounded planning amendment: replace the proposed shared registry/opaque-token boundary with the existing native lock, include the helper cleanup correction and accepted contention outcome, refine directly affected E8 evidence, and remove the L1 hold. Preserve the remaining frozen scope and evidence. Scope details and size estimates remain review guidance; ordering delegation does not accept every future interface or patch. This report does not replace the existing plan or handoffs. Existing handoff authorization and delivery-status fields remain superseded by this review request.

Each eventual PR requires an Architect implementation review against its exact stable revision and focused evidence, Product Owner review, and explicit Product Owner merge approval. Planner PASS, architecture amendment acceptance, outline acceptance, green checks or completion of an earlier PR cannot substitute for any of those gates. No authorization to implement, commit, publish or merge follows from this report.
