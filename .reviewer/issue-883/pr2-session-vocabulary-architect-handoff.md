# PR 2: session vocabulary and validation API handoff

Read this before refreshing the #883 PR 2 plan. The Product Owner has accepted
the replacement vocabulary and two API corrections. Update the implementation
assignment in these terms, keeping the rename separate from behavior changes.

## Applies to

- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
- Branch: `agent/issue-883-pr2`
- Reviewed HEAD: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`
- Parent: `1d373a61cbb6266e4dd90bf17c8076c278174b0f`
- The implementation tree is clean at that HEAD. This handoff changes no source,
  implementation specification, commit, push or GitHub state.

This supplements the [configuration decision](pr2-recovery-creation-policy-architect-decision.md)
and supersedes the scope/target-name hold in the [Planner disposition](pr2-session-rename-planner-disposition.md).
The [interview record](pr2-session-vocabulary-architect-decision.md) holds the
accepted decisions. This is not an implementation verdict or completion of R2.

## Accepted vocabulary

| Old term | Accepted replacement | Definition |
| --- | --- | --- |
| pending session placement | agent session | The session is created when it is first used. |
| session materialization | session creation | Creating the provider session so it can be reopened. |
| established session | existing session | An agent session that has already been created. |

The main checkout's Terminology registry records these three definitions.
Transfer them to the implementation worktree with the rename. Preserve the
detailed creation, continuation and identity checks in their owning sections.
Issuing a Session value still creates no native session. ACP creation still
requires the backend's acceptance of the first turn; native creation keeps its
existing assertion timing. No name change moves either boundary.

The saved values are the **active provider configuration**. Use save/read for
persistence. Do not introduce account or retained configuration as their name.

| Current surface | Accepted replacement |
| --- | --- |
| AgentSessionPlacement | AgentSessionSetup |
| complete(session, state) on that handle | finish(session, state) |
| AgentSessionPlacementState | AgentSessionSetupState |
| Its fresh / established discriminants | new / existing |
| AcpxSessionPlacement | AcpxSessionDetails |
| AcpxSessionContext | AcpxSessionRequest |
| AcpxSessionPolicy.place | requestSession |
| AcpxSessionPolicy.established | recordSessionIdentity |
| AcpxSessionDetails pending / established state values | new / existing |
| ReplPlacement | ReplLayout |
| AnswersPlacement | AnswersState |
| StructuralPlacement | StructuralAnalysis |
| structuralPlacement | analyzeStructure |
| validateOutputPlacement | validateOutputStructure |

ReplLayout is layout data a parent gives its child. AnswersState retains its
parse/parsed/misplaced values. StructuralAnalysis retains violations and regions.
finish retains its Operation<Session> result, exact Session handling, single
attempt and model/effort application or deferral. activate keeps its previously
accepted signature and timing; it is added only in the configuration increment.

## Complete accepted interfaces

The configuration amendment produces this Core handle:

```ts
export interface AgentSessionSetup {
  readonly sessionIdentity?: string;
  activate(
    provider: string,
    agentCommand: string,
    configuration?: ProviderSessionConfiguration,
  ): Operation<Result<void>>;
  finish(session: Session, state: AgentSessionSetupState): Operation<Session>;
}

export type AgentSessionSetupState =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly configure: ConfigureAgentSession };
```

Keep sessionIdentity's existing absence semantics. Core still owns this handle,
its issuance and installation lifetime. The existing configure operation's
contract is unchanged. The rename-only increment has no activate member.

The accepted ACP host boundary is:

```ts
export interface AcpxSessionRequest {
  readonly agentName: string;
  readonly agentCommand: string;
  readonly session: string | undefined;
  readonly sessionIdentity?: string;
}

export interface AcpxSessionDetails {
  readonly sessionKey: string;
  readonly cwd: string;
  readonly state: "new" | "existing";
}

export interface AcpxSessionPolicy {
  requestSession(request: AcpxSessionRequest): Operation<AcpxSessionDetails>;
  recordSessionIdentity(
    details: AcpxSessionDetails,
    identity: AcpxSessionIdentity,
  ): Operation<void>;
}
```

AcpxProviderDependencies.sessions remains optional. Both methods are required
when that integration is supplied. AcpxSessionIdentity keeps its existing
fields. The type AcpxSessionPolicy keeps its existing name; this boundary is
distinct from the withdrawn configuration-policy proposal.

requestSession chooses the key/directory and checks whether the session exists;
the host may prepare its directory. recordSessionIdentity saves the host's
association with the provider-confirmed identity, validating an existing
association instead of overwriting it. The provider stores conversation history.
Ordinary directory-based sessions gain no new host database.

The returned REPL tree exposes:

```ts
validate(descriptions: readonly ReplDescription<Action>[]): Result<void>;
apply(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>>;
```

validate performs the complete existing checks without mutating the mounted
tree, focus or frame. apply performs those checks every time before mutation.
A successful validate call is no reservation and bypasses no later check.
useReplTree receives no validation callback. Reuse the existing validator.

## Derived mechanical names and sweep

Architecture rule 2 delegates local helpers and implementation structure.
Derive the following names from the accepted concepts; they introduce no new
capability, ownership or persistence mechanism.

| Existing identifier and role | Derived name |
| --- | --- |
| SessionPlacementOwner / createSessionPlacementOwner | SessionSetupOwner / createSessionSetupOwner |
| Owner placement(request) method | setup(request) |
| Coordinator sessionPlacement(request) method | sessionSetup(request) |
| sessionPlacement(identity, name) request factory | openSessionRequest(identity, name) |
| SessionPlacementIssuance | SessionRequestIssuance |
| Core SessionPlacement private class | SessionRequest |
| Core Placement private request-data type | SessionRequestData |
| readPlacement, which consumes the issuance once | consumeSessionRequest |
| configurePlacement | configureSessionRequest |
| placementOf delivery parser | sessionSetupOf |
| isPlacementShaped structural predicate | isSessionRequestShaped |
| ACP session-key.ts SessionPlacement | SessionDetails |
| resolveSessionPlacement | resolveSessionDetails |
| placedPrepared | prepareSessionDetails |
| placePending | issuePendingSession |
| placementState | sessionCreationState |
| detachPlacement, which drops closed handle/runtime data | detachSessionHandle |
| Workflow placementKey / placementSuffix | providerSessionKey / providerSessionSuffix |
| PlanWriterPlacement directory inputs | SessionDirectoryOptions |
| Plan placementFor / hash local | sessionNameFor / digest |
| Structural constructPlacement / regionPlacement | analyzeConstruct / analyzeRegion |
| Body placementError local | structureError |
| loaded-copy ReadPlacementUse / PlacementLog | ReadSessionUse / SessionSetupLog |
| Test assertsAtPlacement | assertsAtSetup |
| REPL placement fields/locals | layout |
| Existing placementsAllowed parameter during rename | layoutAllowed; removed in validation API increment |

Bare placement/placed/placements locals become request/setup/details/layout or
session names according to their actual value. Keep these domains distinct;
do not globally replace them with one noun. The provider's Prepared arm becomes
kind: "details" with a details member. Preserve its existing other arms and
control flow. In-memory new/existing names are translated from existing durable
record formats; do not rewrite stored pending markers or vendor protocol fields.

Rename these paths and every import, fixture/build input and documentation
reference that consumes them:

- core/src/agent/session-placement.ts -> session-setup.ts
- core/tests/agent-session-placement.test.ts -> agent-session-setup.test.ts
- git/src/deno/composition/placement.ts -> checkout-paths.ts
- git/src/deno/run-composition/placement.ts -> checkout-layout.ts

Paths above are relative to packages/. The Git helpers keep their path
algorithms and exports unchanged. SessionDirectoryOptions keeps root, session
and explicitSession unchanged. Rename syntax reference's Placement heading to
Structure and update expectations without changing its parent/child rules.

The sweep covers current source, exports, tests, diagnostics, specs, architecture
and agent rulebooks, including spatial uses, Git checkout paths and Plan writer
directory inputs. Include repository-owned adapter provenance prose, exclusion
reasons and build fixtures referencing the renamed modules. Preserve pinned
third-party snapshot bytes and stored paths/keys/hashes. Historical review
evidence still identifies its reviewed revision; do not rewrite its quotations
to pretend that revision used the new names.

replacement and its inflections are different words and stay. The accepted
AnswersState value misplaced also stays. No compatibility aliases or legacy
exports remain. Core's literal finish/sessionSetup bridge and the separately
loaded Core fixture change together, with their original receivers preserved.

## Delivery and evidence

Keep the existing PR and branch. Deliver the mechanical rename first, parented
on b01bbe6c, before the configuration increment. Its changes include names,
file paths, enum spellings and prose; it adds no configuration behavior.

Deliver the REPL validation correction and required host recording method as
separate API work after the rename. Planner selects their smallest coherent
increments before the configuration increment. In the rename-only commit,
recordSessionIdentity remains optional under its new name; the API increment
makes it required. Likewise, the existing renamed layoutAllowed argument is
removed in the validation increment. These are staging descriptions, not final
API alternatives or aliases.

For the rename, preserve the Planner's compiler and JSR proof plus two-way
search control. Replace the obsolete assertion that spatial occurrences remain
unchanged with zero retired-term occurrences in current owned surfaces, with
explicit controls for replacement and the accepted misplaced value. Include
the real loaded-copy test because type checking cannot prove its dynamic bridge.
Select explicit Git integration/build-fixture and syntax-rendering checks where
renamed paths or rendered headings cross boundaries import selection cannot see.
Do not change test discovery or runtime eligibility.

For validation, deliberately retire the synthetic custom-slot rejection that
tests the removed callback. Preserve duplicate-key/conflicting-focus refusal
without mutation. Verify validate reports invalid descriptions without changing
tree/focus/frame, and apply still refuses without a prior validate call.

For required host recording, update all host/test implementations. Exercise
recording after confirmed creation and reattachment, preserve refusal cleanup
and the no-confirmation/no-record path, and retain the ordinary no-custom-host
path. A supplied malformed host missing recording must not silently continue.
Planner owns the smallest discriminating checks, not an exhaustive new matrix.

Refresh the configuration handoff's five steps and existing focused commands in
these names. Keep its four configuration fields, initial values, one-attempt
activation, compatibility checks, creation/reattachment order and SC1–SC7
behavior/evidence unchanged. Review the API increments separately from that
frozen configuration evidence. No full suite, CI inspection or implementation
PASS is claimed here.

## Next action

Planner re-freezes the delivery steps and affected evidence using this handoff.
The vocabulary questions are resolved. R2 implementation is pending. Mounted
section 5, terminal R7/R8 and the 36-frame packet remain separate.
