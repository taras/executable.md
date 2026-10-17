# Session vocabulary: Architect decision and interview

Retire “placement” terminology before implementing the active provider
configuration amendment. Rename source identifiers, runtime structural members,
files, tests, exports and current architecture/specification prose together,
without compatibility aliases. The semantic names and two API amendments are
accepted. Use the consolidated Planner handoff for implementation preparation.

Reviewed clean base: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`, parent
`1d373a61cbb6266e4dd90bf17c8076c278174b0f`, branch `agent/issue-883-pr2`.
No production change, specification edit, commit or CI inspection is made here.

This answers the remaining scope question in
[the Planner disposition](pr2-session-rename-planner-disposition.md) and starts
the replacement-name interview. It supplements the accepted
[configuration behavior](pr2-recovery-creation-policy-architect-decision.md).

## Settled delivery and scope

The rename is one mechanical commit on the existing PR 2 branch, immediately
after the reviewed base and before the configuration increment. No configuration
behavior is implemented in that rename. The Planner owns the focused evidence
and carries the affected loaded-copy test identified in its disposition.

The sweep covers session requests, provider resolution, their issued handles,
pending/established session definitions, helper and module names, diagnostics,
and current documentation describing that session lifecycle. It includes the
provider-internal Prepared discriminant and literal property names parsed by
provider-api.ts. Both ends of the structural bridge, including the foreign-Core
fixture in acp/tests/loaded-copy.test.ts, change together. No stored journal or
provider record spelling is changed by this rename.

The Product Owner rejects the proposed spatial exemption. ReplPlacement,
AnswersPlacement, StructuralPlacement, validateOutputPlacement, placementsAllowed
and the corresponding prose are also in scope. Their different meanings require
appropriate replacement names, not preservation of the old word. The earlier
session-only scope and three-export count are superseded. AnswersPlacement is
again included, so the four-export inventory stands. Words such as replacement
remain distinct words; do not apply a substring replacement.

Source inspection finds no technical need to preserve these names:

- ReplPlacement is layout data passed from a parent to its child.
- AnswersPlacement reports the scanner state of an Answers declaration:
  parse, parsed or misplaced. It is not screen geometry.
- StructuralPlacement contains structural violations and accepted child regions.
  It is the result of checking how a construct is written.

The Planner must refresh the mechanical sweep and affected evidence for this
expanded scope. The configuration behavior and SC1–SC7 remain unchanged.

The saved values are called **active provider configuration**. Persistence is
described with ordinary verbs such as save and read; it does not create another
named configuration object. That naming decision does not remove unrelated
journal or workflow concepts across the repository.

## Name interview inventory

Review the semantic names before deriving mechanical helper spellings:

1. The Session capability before native construction.
2. The established Session and the transition that establishes it.
3. The provider-facing Core handle and its existing completion operation.
4. The ACP session-location result and the remaining identifier/path mapping.

The configuration amendment's activate operation keeps its accepted timing,
single-attempt lifetime and Result contract. It is not added by the rename
commit. Its configuration check precedes provider construction/reattachment;
the existing completion operation receives the exact Session afterwards.
These responsibilities remain distinct even though both names are reviewed.

### 1. Agent session — accepted

The Product Owner supplies the simpler name **agent session** and explains that
the session is created when first consumed. Use ordinary reader-facing wording:

> The session is created when it is first used.

This replaces the proposed pending session term and its long definition.
The main checkout's architecture.md registry records this accepted wording.
The implementation worktree remains unchanged; its registry and consumers
change together in the rename increment. Detailed creation and native identity
rules remain in their existing sections, outside this short definition.

### Spatial names — accepted

The inspected type definitions support renaming all three; no compatibility
alias or separate technical constraint requires their current names.

**ReplPlacement → ReplLayout — accepted.**

> Layout data a parent gives its child.

**AnswersPlacement → AnswersState — accepted.**

This is the scanner's state for an Answers declaration. The rename preserves
the existing values: `parse`, `parsed` and `misplaced`. There is no existing
AnswersState type in the reviewed implementation.

**StructuralPlacement → StructuralAnalysis — accepted.**

> Structural problems and accepted child regions found in a component.

The existing fields, `violations` and `regions`, keep their types and behavior.
StructuralValidation already names a CLI validation function; StructuralAnalysis
names this Core result without giving two different contracts the same name.

**structuralPlacement → analyzeStructure — accepted.**

This function checks a component against its declared parent/child rules and
returns StructuralAnalysis. Its arguments and behavior remain unchanged.

**validateOutputPlacement → validateOutputStructure — accepted.**

This function checks that Output declarations are direct children of the body.
It reports nested declarations even in branches that do not run. Its arguments,
aggregate error result and behavior remain unchanged.

### Layout validation API — accepted

The proposed callback rename to acceptsLayout is not accepted. The Product
Owner questions the callback shape and asks for an object with a method that
can be called directly. The Product Owner accepts validation on the returned
ReplTree object and removal of the injected predicate.

At the reviewed base, useReplTree receives an optional boolean predicate and
passes it to validateDescriptions. That function walks the whole desired tree
and invokes the predicate for each child's layout and its parent's key path.
False becomes a ReplDescriptionError; the omitted predicate accepts all layout
data. The other checks (issued descriptions, keys, focus and modality) still
run. Both production call sites omit the predicate. One composition test
supplies it to reject a synthetic slot named nowhere.

Accepted members:

1. ReplTree.validate(descriptions): Result<void>, available on the
   returned tree object for validation without mounting.
2. Existing ReplTree.apply(descriptions), which still validates the complete
   desired tree before any mutation.

```ts
interface ReplTree<Action> {
  validate(descriptions: readonly ReplDescription<Action>[]): Result<void>;
  apply(descriptions: readonly ReplDescription<Action>[]): Operation<Result<void>>;
  // Other existing members remain unchanged.
}
```

validate performs the existing complete description checks without mounting,
updating, removing or drawing nodes, changing focus or advancing the tree frame.
apply performs the same validation on every call before mutation; a prior
successful validate call is not required and does not bypass that check.
useReplTree receives no validation callback. Reuse the existing validation logic;
do not introduce another rules object or a callback hidden behind a new name.

This preserves existing production validation but removes custom predicate
injection. It is a separate behavior/API increment, outside the mechanical
rename commit. The Planner must align delivery with the rename and configuration
increments rather than mixing this API change into a rename-only commit.

The custom-layout rejection in repl-composition.test.ts:317–341 exercises the
removed extension point and is deliberately retired. Preserve the remaining
refused-set evidence (duplicate keys and conflicting focus leave the mounted
tree unchanged). Verify the new validate method reports existing invalid
descriptions without changing the tree, and apply still refuses them without
requiring an explicit validate call. Planner owns the smallest evidence selection.

### 2. Session creation — accepted

Replace the registered term session materialization with session creation:

> Creating the provider session so it can be reopened.

The detailed rules for when creation is established remain unchanged: the ACP
backend's acceptance of the first turn or the existing native construction
path. This short definition replaces the glossary's implementation-heavy text;
it does not move the creation boundary to issuing the initial Session value.
The main checkout's architecture.md registry records the accepted definition.

### 3. Existing session — accepted

Replace the registered term established session with existing session:

> An agent session that has already been created.

Creation retains its accepted meaning above. Continuation still checks the
saved identity and history before reopening; missing or mismatched history
still refuses continuation. This vocabulary change does not relax those checks.
The main checkout's architecture.md registry records the accepted definition.

### 4. AgentSessionSetup — accepted

Rename AgentSessionPlacement to AgentSessionSetup:

> Used by the provider to prepare a requested session and return it to Core.

The current handle exposes sessionIdentity and complete(session, state).
The accepted configuration amendment later adds activate(provider, agentCommand,
configuration). Setup describes their shared purpose without implying that
issuing this handle creates a native session. Its owner, one-use lifetime,
cross-copy structural bridge and completion behavior remain unchanged.

The accepted state type and derived helper/module names appear in the
consolidated handoff. The separate
workflow AgentSessionResolution already exists and describes another result;
do not reuse that name for this handle.

### 5. AgentSessionSetup.finish — accepted

Rename complete(session, state) to finish(session, state):

> Finish setup with the session the provider resolved.

The provider supplies its exact Session. Core applies and verifies requested
model/effort settings for an existing session, or carries them to first use for
a new one, and returns the Session the caller uses. Without requested settings,
it returns the supplied Session unchanged. The one-attempt lifetime and existing
failure behavior remain unchanged. finish does not construct a new native
session; the first consumer still chooses construction.

The rename changes the method's literal name in the cross-copy structural
bridge and foreign-Core fixture together. Its Operation<Session> signature
remains unchanged; the state type's new name is reviewed separately.

### 6. AgentSessionSetupState — accepted

Rename AgentSessionPlacementState to AgentSessionSetupState. Use new and existing
for its discriminants, matching the accepted session vocabulary:

```ts
export type AgentSessionSetupState =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly configure: ConfigureAgentSession };
```

This tells finish whether creation is deferred until first use or the provider
has resolved an existing session. The existing branch supplies the operation
that applies and verifies model/effort settings. That operation's contract is
unchanged by this name proposal. Change the old fresh/established discriminants
only on this in-memory setup contract and its callers/fixtures; do not change
durable record values or unrelated state types by substring replacement.

### 7. AcpxSessionDetails — accepted

The Product Owner rejects AcpxSessionLocation and supplies AcpxSessionDetails.
Rename AcpxSessionPlacement to AcpxSessionDetails:

> An agent session's key, working directory and creation state.

This is data returned by the host's session lookup (or the ordinary directory
walk), then used by ACP to resolve that session. Its sessionKey, cwd and state
fields retain their behavior. It carries no operation for finishing setup.
Related host method names and state spellings remain to be aligned explicitly,
without changing durable record formats.

### 8. Host session request method — accepted

The Product Owner rejects place and is unsure about resolve, asking what
AcpxSessionContext contains. Resolve is not accepted. Review the input and the
host's responsibility together before settling the method name.

The Product Owner identifies the input as session options or a session request.
AcpxSessionContext → AcpxSessionRequest is accepted: these fields
identify the agent and requested session. Options would suggest configurable
settings. No existing AcpxSessionRequest or AcpxSessionOptions type appears in
the reviewed implementation. Its four fields and their absence semantics remain
unchanged. The Product Owner supplies requestSession as the method name;
requestSession is accepted. The earlier getSessionDetails proposal is superseded.

Current input fields:

- agentName: the selected agent's registered name.
- agentCommand: the command resolved for that registered agent.
- session: the authored Session name, or undefined when unnamed.
- sessionIdentity: Core's generated identity for the Session occurrence, when
  supplied through its coordinator; the workflow host requires this identity.

The provider constructs this input. The workflow host uses its agent and
generated session identity to derive a session key, checks saved session data
and provider assertions, and chooses the working directory. It may also prepare
that directory, so this operation is not promised to be a side-effect-free read.
Its output is AcpxSessionDetails; it does not create a provider-native session.

Rename AcpxSessionPolicy.place to requestSession.

```ts
requestSession(request: AcpxSessionRequest): Operation<AcpxSessionDetails>;
```

The host chooses the session's key and working directory and reports whether
it has been created. This lookup does not create a provider session. The
provider still resolves the actual Session value and performs creation only
through the existing consuming operation. The host's ownership, refusal timing
and returned data are unchanged.

### 9. Host identity-recording method — accepted

Rename AcpxSessionPolicy.established to recordSessionIdentity. The custom-host
integration remains optional; both methods are required when it is supplied.
persistSession is withdrawn because the host saves an identity mapping while
the provider owns conversation/history storage.

```ts
/** Save the provider-confirmed identity for this session. */
recordSessionIdentity(
  details: AcpxSessionDetails,
  identity: AcpxSessionIdentity,
): Operation<void>;
```

The host saves the association between its logical session and the provider's
confirmed session identity. The workflow host validates an existing association
instead of overwriting it. The provider owns its conversation history; this
method saves the host's record for reopening that same conversation.

Concretely, the workflow host commits an agent_sessions database row containing
the logical identity, provider/agent compatibility facts, the provider's asserted
session identity and creation metadata. Conversation/history persistence stays
with the provider. The proposed method name describes the identity record.

Caller audit distinguishes two absences. Ordinary CLI provider assembly supplies
no custom AcpxSessionPolicy at all; directory/agent/name lookup finds the
provider's own session record. That path does not need a second host mapping.
The production custom host in workflow-agent.ts supplies both methods and saves
the mapping. The only inspected custom hosts omitting the recording method are
acceptance-test fixtures proving request identity routing. No production case in
the repository demonstrates a custom session host that needs requestSession
but cannot or should not record the confirmed identity.

The accepted boundary is:

```ts
export interface AcpxSessionPolicy {
  requestSession(request: AcpxSessionRequest): Operation<AcpxSessionDetails>;
  recordSessionIdentity(
    details: AcpxSessionDetails,
    identity: AcpxSessionIdentity,
  ): Operation<void>;
}
```

AcpxProviderDependencies.sessions remains optional. The required recording
method changes interface requiredness and belongs in an explicit API increment,
outside the rename-only commit. Ordinary directory-based sessions gain no new
host database. The provider calls the recording method whenever a custom host
is present at its existing confirmation sites; it no longer skips a missing
method. Missing behavior must not silently permit continued use.

Call timing remains unchanged: after the canonical provider identity is
confirmed on creation or reattachment. A first ACP turn that never receives
creation acceptance does not call this method. Native creation keeps its
existing assertion timing. A host refusal still releases the provider handle
and prevents further use through the refused association. Rename the three
provider call sites and host/test implementations together.

### 10. AcpxSessionDetails.state — accepted

Rename the in-memory values pending and established to new and existing:

```ts
export interface AcpxSessionDetails {
  readonly sessionKey: string;
  readonly cwd: string;
  readonly state: "new" | "existing";
}
```

These values match the accepted AgentSessionSetupState vocabulary. A new session
is created on first use; an existing session is checked before continuation.
Keep durable record formats and values unchanged, translating at the reader
boundary. This change affects spelling, not creation or continuation behavior.

## Continuity

Delivery order and no-alias behavior are settled. Agent session and its short
definition, ReplLayout, AnswersState, StructuralAnalysis, analyzeStructure and
validateOutputStructure, session creation, existing session, AgentSessionSetup,
finish, AgentSessionSetupState, AcpxSessionDetails, AcpxSessionRequest and
requestSession and recordSessionIdentity are accepted. Both custom-host methods
are required when the optional integration is supplied. persistSession is
withdrawn.
AcpxSessionDetails.state uses new and existing. The layout validation and
required host identity-recording changes are separate API amendments. The
spatial exemption is withdrawn; those names are in scope too. The naming
interview is complete. The [consolidated Planner handoff](pr2-session-vocabulary-architect-handoff.md)
derives helper/file names and separates the mechanical rename from behavior.
SC1–SC7 behavior remains unchanged. Mounted section 5, terminal R7/R8 and the
36-frame packet remain separate. Next: Planner updates the delivery steps and
focused evidence. No production implementation or commit is made here.
