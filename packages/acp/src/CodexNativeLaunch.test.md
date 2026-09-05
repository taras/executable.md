# A real Codex session, prepared, materialized and then rejoined

`xmd run AGENTS.md#Implementor --default-agent codex` is the whole product for
Codex: it prepares one Codex conversation from this repository's own Implementor
contract and hands you Codex's own interactive UI for that exact conversation.
This document runs that command — the literal one, through the built binary —
and asks the two questions that decide whether the conversation is real.

**Did the prepared contract govern the first thing you say?** The first native
turn asks for the opening sentence of the role contract without ever sending
that sentence. A conversation that did not receive the prepared layer cannot
produce it, and neither can an agreeable model, because nothing in the question
says what the sentence is.

**Is what you said natively part of the same conversation?** That first native
turn also plants a one-time marker. A second, independent invocation then
rejoins the same conversation over ACP — from an authored document that has
never seen the marker — and asks for it. Recovering it is what makes the native
UI and the ACP session one conversation rather than two wearing the same name.

Getting there costs one turn nobody asked for. Codex CLI 0.153.2 does not write
a conversation anywhere `codex resume` can find it until a turn has completed in
it, so XMD spends exactly one of its own first: `codex-materialization.v1`,
whose only job is to make the conversation openable. That the operator can then
leave without ever speaking — and come back without buying a second one — is the
subject of `CodexZeroNativeTurnExit.test.md`, so that question can be corrected
without respending the three turns this document is authorized to spend.

## What this costs, and what it touches

Three real model turns against the operator's own Codex credentials: XMD's own
materialization turn, one native turn that answers from the prepared layer and
plants the marker, and one ACP turn that rejoins and recalls it. Nothing else is
sent. The materialization turn's bytes are fixed by the product, are shown to
the operator before they are spent, and carry no path, identity, environment or
authored content.

It is opt-in twice over. Without `XMD_CODEX_NATIVE_PROOF=1` the fixture refuses
before starting any Codex process; without a separate
`XMD_CODEX_MODEL_TURNS_AUTHORIZED=3` it refuses before spending a turn. It also
refuses on a machine outside the frozen compatibility tuple below, because the
finding this feature rests on is a fact about one Codex build.

Everything sent besides those three turns is terminal control: Codex's own
directory trust dialog is answered at most once with the choice it pre-selects,
and the exit is two Ctrl-C bytes. The command runs with an operator's
environment rather than this process's, so anything an enclosing agent session
exported is dropped.

The command runs in a fresh temporary directory holding a byte-for-byte copy of
this repository's own `AGENTS.md` and `.agents/implementor.md`, so the literal
production target resolves without creating Codex state for the repository.
Afterwards the conversation is removed through Codex's own
`codex delete --force <id>`, naming the exact identity this run created.
`CODEX_HOME` is left alone — relocating it de-authenticates Codex — and nothing
beneath Codex's configuration, history or rollout files is ever opened.

Run it with:

```sh
XMD_CODEX_NATIVE_PROOF=1 XMD_CODEX_MODEL_TURNS_AUTHORIZED=3 \
  deno task xmd test packages/acp/src/CodexNativeLaunch.test.md --raw
```

## What a verdict may say

The schema is the disclosure boundary, not a convenience. It accepts versions
and digests of public executables, the session identity and who chose it,
booleans, counts, phase and failure classes, usage field *names*, and cleanup
outcomes. The role contract's text, the history marker, the materialization
reply, raw terminal output, argument vectors, the environment and private paths
have nowhere to go in it, so a fixture that tried to report one would fail this
document.

<Let as="verdictSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "mode", "verdict", "authorized", "turnsAuthorized", "authorizedTurnBudget",
    "ran", "refusal", "detail",
    "codexVersion", "codexDigest", "platform", "architecture",
    "adapterPackage", "adapterVersion", "adapterDigest", "compatibilityTupleFrozen",
    "target", "projectCopyVerified", "implementorMarkerRendered", "siblingMarkersRendered",
    "nativeSessionId", "identityProvenance", "reentryNativeSessionId",
    "substitutedIdentity", "routeConverted",
    "firstXmdExitCode", "secondXmdExitCode", "instructionChannel",
    "modelTurns", "materializationTurns", "nativeUserTurns", "acpReattachTurns",
    "answerObserverInvocations", "conversationInputByteCount",
    "consentInputBytes", "consentSurfaces", "exitControlBytes",
    "reentryConsentInputBytes", "reentryConsentSurfaces", "reentryExitControlBytes",
    "inheritedAgentMarkersRemoved",
    "noticedBeforeSpending", "noticedAfterSpending",
    "openingSentenceExact", "markerRecovered", "acpDocumentCarriesMarker",
    "answerSurface", "outcome",
    "materialization", "route", "journal", "cleanup", "privateStateInspected"
  ],
  "properties": {
    "mode": { "type": "string" },
    "verdict": { "enum": ["PASS", "REFUSED", "ENVIRONMENT_BLOCKED", "PRODUCT_FAILED", "HARNESS_FAILED"] },
    "authorized": { "type": "boolean" },
    "turnsAuthorized": { "type": "boolean" },
    "authorizedTurnBudget": { "type": "integer" },
    "ran": { "type": "boolean" },
    "refusal": { "type": "string" },
    "detail": { "type": "string" },
    "codexVersion": { "type": "string" },
    "codexDigest": { "type": "string" },
    "platform": { "type": "string" },
    "architecture": { "type": "string" },
    "adapterPackage": { "type": "string" },
    "adapterVersion": { "type": "string" },
    "adapterDigest": { "type": "string" },
    "compatibilityTupleFrozen": { "type": "boolean" },
    "target": { "type": "string" },
    "projectCopyVerified": { "type": "boolean" },
    "implementorMarkerRendered": { "type": "boolean" },
    "siblingMarkersRendered": { "type": "integer" },
    "nativeSessionId": { "type": "string" },
    "identityProvenance": { "type": "string" },
    "reentryNativeSessionId": { "type": "string" },
    "substitutedIdentity": { "type": "boolean" },
    "routeConverted": { "type": "boolean" },
    "firstXmdExitCode": { "type": "integer" },
    "secondXmdExitCode": { "type": "integer" },
    "instructionChannel": { "type": "string" },
    "modelTurns": { "type": "integer" },
    "materializationTurns": { "type": "integer" },
    "nativeUserTurns": { "type": "integer" },
    "acpReattachTurns": { "type": "integer" },
    "answerObserverInvocations": { "type": "integer" },
    "conversationInputByteCount": { "type": "integer" },
    "consentInputBytes": { "type": "string" },
    "consentSurfaces": { "type": "array", "items": { "type": "string" } },
    "exitControlBytes": { "type": "string" },
    "reentryConsentInputBytes": { "type": "string" },
    "reentryConsentSurfaces": { "type": "array", "items": { "type": "string" } },
    "reentryExitControlBytes": { "type": "string" },
    "inheritedAgentMarkersRemoved": { "type": "integer" },
    "noticedBeforeSpending": { "type": "boolean" },
    "noticedAfterSpending": { "type": "boolean" },
    "openingSentenceExact": { "type": "boolean" },
    "markerRecovered": { "type": "boolean" },
    "acpDocumentCarriesMarker": { "type": "boolean" },
    "answerSurface": { "type": "string" },
    "outcome": { "enum": ["same-identity", "no-session", "unresolved"] },
    "privateStateInspected": { "type": "boolean" },
    "materialization": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "promptVersion", "requestIdStable", "promptExact", "turnNamed", "turnProvider",
        "durationReported", "responsePresent", "stopReason",
        "reportedUsageFields", "unreportedUsageFields", "failureClasses"
      ],
      "properties": {
        "promptVersion": { "type": "string" },
        "requestIdStable": { "type": "boolean" },
        "promptExact": { "type": "boolean" },
        "turnNamed": { "type": "boolean" },
        "turnProvider": { "type": "string" },
        "durationReported": { "type": "boolean" },
        "responsePresent": { "type": "boolean" },
        "stopReason": { "type": "string" },
        "reportedUsageFields": { "type": "array", "items": { "type": "string" } },
        "unreportedUsageFields": { "type": "array", "items": { "type": "string" } },
        "failureClasses": { "type": "array", "items": { "type": "string" } }
      }
    },
    "route": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "provider", "buildVersion", "buildDigest"],
      "properties": {
        "kind": { "type": "string" },
        "provider": { "type": "string" },
        "buildVersion": { "type": "string" },
        "buildDigest": { "type": "string" }
      }
    },
    "journal": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "provider", "agent", "launcher", "provenance", "nativeSessionId", "cwdIsProject",
        "sessionState", "instructionsDigestPresent",
        "firstPhases", "secondPhases", "failureClasses"
      ],
      "properties": {
        "provider": { "type": "string" },
        "agent": { "type": "string" },
        "launcher": { "type": "string" },
        "provenance": { "type": "string" },
        "nativeSessionId": { "type": "string" },
        "cwdIsProject": { "type": "boolean" },
        "sessionState": { "type": "array", "items": { "type": "string" } },
        "instructionsDigestPresent": { "type": "boolean" },
        "firstPhases": { "type": "array", "items": { "type": "string" } },
        "secondPhases": { "type": "array", "items": { "type": "string" } },
        "failureClasses": { "type": "array", "items": { "type": "string" } }
      }
    },
    "cleanup": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "liveChildren", "journalsRemoved", "routeRecordsRemoved",
        "sessionDeleteOutcome", "temporaryRootRemoved"
      ],
      "properties": {
        "liveChildren": { "type": "integer" },
        "journalsRemoved": { "type": "boolean" },
        "routeRecordsRemoved": { "type": "boolean" },
        "sessionDeleteOutcome": { "enum": ["deleted", "nothing-to-delete", "failed"] },
        "temporaryRootRemoved": { "type": "boolean" }
      }
    }
  }
}
```

</Let>
<Test name="A prepared Codex session governs its first native turn, and ACP rejoins it" timeout="45min">

```sh timeout=40min exec as="run"
deno run --allow-all --frozen packages/acp/tests/fixtures/codex-native-launch-proof.ts native-launch
```

The fixture returns a structured verdict even when the product fails one of the
two questions, so a nonzero exit means the harness broke rather than a question
being answered.

<AssertEquals actual={run.exitCode} expected={0} />

<Parse schema={verdictSchema} as="proof">
{run.stdout}
</Parse>

The whole result is shown before anything is judged. It carries no contract
text, no marker and no transcript content — `openingSentenceExact` and
`markerRecovered` are the only things about the conversation that crossed the
fixture boundary.

```json
{run.stdout}
```

## Nothing private was read

True whether or not the proof was opted into. Codex's rollout files are the one
place that could answer this document cheaply, and they are exactly what a proof
of the public contract may not open.

<AssertFalse expr={proof.privateStateInspected} />

## What the verdict decides

The fixture classifies its own outcome, and that classification — not this
document's arithmetic — chooses what is worth asserting. A run its environment
blocked may have reached the first question and even spent the turn that asks
it, but it establishes neither answer, so demanding both would convict the
product of the environment's failure. Each branch below asserts only what its
verdict makes true, and every authorized verdict other than `PASS` ends by
stopping the document with the fixture's own reason, so a proof that did not
pass says why in one sentence instead of failing on an accounting mismatch that
was never the point. The one outcome that passes without proving anything is the
unarmed refusal: with the opt-ins absent nothing is spent and nothing is
observed, and that zero-turn skip is how this document runs on an ordinary
machine and in CI.

<Switch value={proof.verdict}>
<Case value="PASS">

A pass is a claim about a journey that happened, so the first thing it owes is
that one did.

<Assert expr={proof.ran} />

## The frozen compatibility point

The materialization turn exists because of a fact about one Codex build. This
records which one, so a later build that stopped needing it — or started needing
something else — cannot pass as this one.

<AssertEquals actual={proof.platform} expected={"darwin"} />
<AssertEquals actual={proof.architecture} expected={"arm64"} />
<AssertEquals actual={proof.codexVersion} expected={"codex-cli 0.153.2"} />
<AssertEquals
  actual={proof.codexDigest}
  expected={"195ace4100a634a9df39147f493e730e666b5bd87795f3c9f3251d8542400424"}
/>
<AssertEquals actual={proof.adapterPackage} expected={"@agentclientprotocol/codex-acp"} />
<AssertEquals actual={proof.adapterVersion} expected={"1.6.2"} />
<AssertEquals
  actual={proof.adapterDigest}
  expected={"3ee22bc6b1649d02fcef80b352516f395fe774e63b459193195a41c42930dd8b"}
/>
<Assert expr={proof.compatibilityTupleFrozen} />

## Three turns, and only one of them was XMD's

The authorized budget is three, and the accounts name each one: one
materialization the product spent, one native turn the operator typed, one ACP
turn the second invocation asked. There is no fourth, and there is no second
materialization.

<AssertEquals actual={proof.authorizedTurnBudget} expected={3} />
<AssertEquals actual={proof.modelTurns} expected={3} />
<AssertEquals actual={proof.materializationTurns} expected={1} />
<AssertEquals actual={proof.nativeUserTurns} expected={1} />
<AssertEquals actual={proof.acpReattachTurns} expected={1} />
<Assert expr={proof.conversationInputByteCount > 0} />
<AssertEquals actual={proof.exitControlBytes} expected={"0303"} />

Reading an answer off a terminal is something the harness does, and it does it
for the one invocation that submits that native turn and for no other. The
invocations that type nothing reconstruct nothing, so the paths this document
does not test are the paths they already were.

<AssertEquals actual={proof.answerObserverInvocations} expected={1} />

## The operator was told before it was spent

A billable turn nobody was warned about is a bill, not a feature. The notice
appears on the terminal that acquired the launch before the turn starts, and the
completion summary appears before the native UI opens.

<Assert expr={proof.noticedBeforeSpending} />
<Assert expr={proof.noticedAfterSpending} />

## The turn was the exact one the contract names

Its version, its bytes and its request identity are fixed by the product, not
composed at the call site, and the retained preparation named the same request
the retained turn later reported against.

<AssertEquals actual={proof.materialization.promptVersion} expected={"codex-materialization.v1"} />
<Assert expr={proof.materialization.promptExact} />
<Assert expr={proof.materialization.requestIdStable} />
<Assert expr={proof.materialization.turnNamed} />
<AssertEquals actual={proof.materialization.turnProvider} expected={"codex"} />
<Assert expr={proof.materialization.durationReported} />
<Assert expr={proof.materialization.responsePresent} />
<AssertNotEquals actual={proof.materialization.stopReason} expected={""} />
<AssertEquals actual={proof.materialization.failureClasses} expected={[]} />

Usage is recorded as the provider reported it. Which fields arrived is a fact
about Codex, not about this document, so both lists are shown and only their sum
is fixed: every field is either reported or explicitly unreported, and none is
quietly inferred to be zero.

<Assert
  expr={proof.materialization.reportedUsageFields.length +
    proof.materialization.unreportedUsageFields.length === 8}
/>

## The prepared contract governed the first native turn

The question named neither the sentence nor any file, and the materialization
turn before it said nothing about either. The answer carried the opening
sentence of `.agents/implementor.md` exactly, which only the prepared layer
could have supplied — which also settles that materialization did not consume
the layer on its way past.

<Assert expr={proof.openingSentenceExact} />

## ACP rejoined the conversation the native UI was in

The marker existed only in that first native turn — never in the instruction
layer, the argument vector, the environment or the session key — and the
document that asked for it does not contain it. It came back behind a prefix
that appeared in no earlier turn, so only an answer could have produced it.

<AssertFalse expr={proof.acpDocumentCarriesMarker} />
<Assert expr={proof.markerRecovered} />
<AssertEquals actual={proof.outcome} expected={"same-identity"} />
<AssertFalse expr={proof.substitutedIdentity} />
<AssertFalse expr={proof.routeConverted} />
<AssertEquals actual={proof.firstXmdExitCode} expected={0} />
<AssertEquals actual={proof.secondXmdExitCode} expected={0} />

## The identity is the one Codex named

Codex chose it and told the adapter through its own metadata. XMD never parsed
it out of anything, and never substituted a fresh one when the first was
inconvenient.

<AssertEquals actual={proof.identityProvenance} expected={"provider-returned"} />
<AssertNotEquals actual={proof.nativeSessionId} expected={""} />

## The production target ran, and its siblings did not

<AssertEquals actual={proof.target} expected={"AGENTS.md#Implementor"} />
<Assert expr={proof.projectCopyVerified} />
<Assert expr={proof.implementorMarkerRendered} />
<AssertEquals actual={proof.siblingMarkersRendered} expected={0} />

## Route and journal agree

The route names the construction and the Codex build the tuple above froze, and
nothing else: an ACP-first route deliberately records no conversation identity,
launcher or instruction layer, so those are read from the journal instead. A
route that had converted to anything but `acp-first` would mean the launch
stopped being the one this document describes.

<AssertEquals actual={proof.route.kind} expected={"acp-first"} />
<AssertEquals actual={proof.route.provider} expected={"acpx"} />
<AssertEquals actual={proof.route.buildVersion} expected={proof.codexVersion} />
<AssertEquals actual={proof.route.buildDigest} expected={proof.codexDigest} />
<AssertEquals actual={proof.journal.provider} expected={"acpx"} />
<AssertEquals actual={proof.journal.agent} expected={"codex"} />
<AssertEquals actual={proof.journal.launcher} expected={"codex"} />
<AssertEquals actual={proof.journal.provenance} expected={"provider-returned"} />
<AssertEquals actual={proof.journal.nativeSessionId} expected={proof.nativeSessionId} />
<Assert expr={proof.journal.cwdIsProject} />
<Assert expr={proof.journal.instructionsDigestPresent} />
<AssertEquals actual={proof.instructionChannel} expected={"acp.session.systemPrompt"} />

One launch, one materialization, one detachment, one exit. The ACP reattachment
is not a launch, so it adds no phases of its own.

<AssertEquals actual={proof.journal.sessionState} expected={["created"]} />
<AssertEquals
  actual={proof.journal.firstPhases}
  expected={["prepared", "materialized", "detached", "exited"]}
/>
<AssertEquals actual={proof.journal.secondPhases} expected={[]} />
<AssertEquals actual={proof.journal.failureClasses} expected={[]} />

## Nothing was left behind

<AssertEquals actual={proof.cleanup.liveChildren} expected={0} />
<Assert expr={proof.cleanup.journalsRemoved} />
<Assert expr={proof.cleanup.routeRecordsRemoved} />
<Assert expr={proof.cleanup.temporaryRootRemoved} />
<AssertNotEquals actual={proof.cleanup.sessionDeleteOutcome} expected={"failed"} />

</Case>
<Case value="ENVIRONMENT_BLOCKED">

## The environment stopped it

Something outside the product prevented an answer. Whether that happened before
the journey started or partway through it decides what may still be believed, so
the two are judged apart rather than together.

<Switch value={proof.ran}>
<Case value={false}>

Nothing was launched. No conversation exists, no turn was bought, and the
accounts are all still zero — which is the only thing worth checking about a run
that never began.

<AssertEquals actual={proof.modelTurns} expected={0} />
<AssertEquals actual={proof.materializationTurns} expected={0} />
<AssertEquals actual={proof.nativeUserTurns} expected={0} />
<AssertEquals actual={proof.acpReattachTurns} expected={0} />
<AssertEquals actual={proof.answerObserverInvocations} expected={0} />
<AssertEquals actual={proof.conversationInputByteCount} expected={0} />
<AssertEquals actual={proof.nativeSessionId} expected={""} />

<Fail
  message={`The environment stopped this proof before it started: ${proof.detail}. ` +
    `No turn was spent and no conversation exists, so nothing here is evidence ` +
    `about the product.`}
/>

</Case>
<Case default>

The journey began and turns were spent, so what the accounts say about them has
to hold even though the questions went unanswered. Every turn is attributable to
one of the three the budget names, and no more were bought than were authorized.
What this branch may not do is demand the three the budget allows, the second
invocation, or either answer: a bound reached is the harness giving up, and
reading that as a product result would convict the product of the environment's
failure.

<Assert
  expr={proof.modelTurns ===
    proof.materializationTurns + proof.nativeUserTurns + proof.acpReattachTurns}
/>
<Assert expr={proof.modelTurns <= proof.authorizedTurnBudget} />

A conversation was created, so it still has to be cleaned up. This is the part
of a blocked run that costs money if it is wrong.

<AssertEquals actual={proof.cleanup.liveChildren} expected={0} />
<Assert expr={proof.cleanup.journalsRemoved} />
<Assert expr={proof.cleanup.routeRecordsRemoved} />
<Assert expr={proof.cleanup.temporaryRootRemoved} />
<AssertNotEquals actual={proof.cleanup.sessionDeleteOutcome} expected={"failed"} />

<Fail
  message={`Blocked after spending ${proof.modelTurns} of ${proof.authorizedTurnBudget} ` +
    `authorized turns: ${proof.detail}. Neither question was answered, so this is ` +
    `not a result about the product; re-run the document once a turn can complete.`}
/>

</Case>
</Switch>

</Case>
<Case value="PRODUCT_FAILED">

## The product answered, and the answer was wrong

The journey ran and the fixture reached a finding, so the accounts and the
cleanup are the two things that decide whether the finding can be trusted. They
are checked and nothing else is: the finding itself is the fixture's to state.

<Assert
  expr={proof.modelTurns ===
    proof.materializationTurns + proof.nativeUserTurns + proof.acpReattachTurns}
/>
<Assert expr={proof.modelTurns <= proof.authorizedTurnBudget} />
<AssertEquals actual={proof.cleanup.liveChildren} expected={0} />
<Assert expr={proof.cleanup.journalsRemoved} />
<Assert expr={proof.cleanup.routeRecordsRemoved} />
<Assert expr={proof.cleanup.temporaryRootRemoved} />
<AssertNotEquals actual={proof.cleanup.sessionDeleteOutcome} expected={"failed"} />

<Fail
  message={`The product failed this proof: ${proof.detail}. The turns are accounted for ` +
    `and the conversation was cleaned up, so this is a finding about the product.`}
/>

</Case>
<Case value="HARNESS_FAILED">

## The harness broke before the product could be judged

Nothing is asserted here on purpose. A harness that stopped may have left its
own accounts half-written, and an assertion about them would fail first and
report the wrong thing — burying the sentence that says what actually broke.

<Fail
  message={`The harness stopped before the product could be judged: ${proof.detail}. ` +
    `Nothing in this run is evidence about the product.`}
/>

</Case>
<Case value="REFUSED">

## It refused before any conversation existed

The refusal happens before any Codex conversation exists, so a refused run
spends no turn and observes nothing.

<Assert
  expr={proof.refusal === "opt-in-absent" ||
    proof.refusal === "turns-not-authorized" ||
    proof.refusal === "codex-home-set"}
/>
<AssertEquals actual={proof.modelTurns} expected={0} />
<AssertEquals actual={proof.materializationTurns} expected={0} />
<AssertEquals actual={proof.nativeUserTurns} expected={0} />
<AssertEquals actual={proof.acpReattachTurns} expected={0} />
<AssertEquals actual={proof.answerObserverInvocations} expected={0} />
<AssertEquals actual={proof.conversationInputByteCount} expected={0} />
<AssertEquals actual={proof.nativeSessionId} expected={""} />
<AssertFalse expr={proof.openingSentenceExact} />
<AssertFalse expr={proof.markerRecovered} />

<Switch value={proof.authorized && proof.turnsAuthorized}>
<Case value={true}>

Both opt-ins were given, so this run asked to spend turns and was turned away
anyway. That is a refusal the operator has to resolve, not a suite that may go
green around it.

<Fail
  message={`This run was armed to spend ${proof.authorizedTurnBudget} turns and was ` +
    `refused anyway: ${proof.detail}`}
/>

</Case>
<Case default>

Without both opt-ins this is the ordinary way the document runs: on a developer
machine and in CI, where it must cost nothing and still be read. Reaching here
is the pass.

</Case>
</Switch>

</Case>
<Case default>

<Fail
  message={`The fixture returned a verdict this document does not judge: ` +
    `${proof.verdict}. Add the branch that decides what it makes true before ` +
    `trusting a run that reports it.`}
/>

</Case>
</Switch>

</Test>
