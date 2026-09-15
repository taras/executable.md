# Leaving a prepared Codex session without saying anything

A prepared session you never speak in should still be there tomorrow. For Claude
that costs nothing, and `ClaudeZeroTurnExit.test.md` proves it: the session the
launch constructs is openable the moment it exists.

Codex is not like that. Codex CLI 0.153.2 does not write a conversation anywhere
`codex resume` can find it until a turn has completed in it, so a launch that
handed you the native UI without one would hand you a name Codex disowns. XMD
therefore spends exactly one model turn of its own — `codex-materialization.v1`,
whose only job is to make the conversation openable — and then gets out of the
way.

That turn is the whole subject of this document, and it asks the two questions
that decide whether it was worth spending.

**Did one turn actually make the conversation openable?** The launch opens the
native UI, and the operator leaves without typing anything at all. Reaching
Codex's own composer rather than `No saved session found with ID` is the answer.

**Is it still openable without buying another one?** A second, independent
invocation of the same command re-enters. If it materialized again, the reader
paid twice for something already done, so the durable accounts must retain
exactly one materialization across both invocations.

Whether the prepared contract governs what you say once you are in there is a
different question, and it lives in `CodexNativeLaunch.test.md` so that this one
can be corrected without ever respending its turns.

## What this costs, and what it touches

One real model turn against the operator's own Codex credentials: XMD's own
materialization turn, in the session the first launch constructed. Nothing is
typed into either native UI. The exact bytes of that turn are fixed by the
product, are shown to the operator before they are spent, and carry no path,
identity, environment or authored content.

It is opt-in twice over. Without `XMD_CODEX_NATIVE_PROOF=1` the fixture refuses
before starting any Codex process; without a separate
`XMD_CODEX_MODEL_TURNS_AUTHORIZED=1` it refuses before spending the turn. It
also refuses on a machine outside the frozen compatibility tuple below, because
the finding this feature rests on is a fact about one Codex build.

Everything sent besides that turn is terminal control: Codex's own directory
trust dialog is answered at most once with the choice it pre-selects, and the
exit is two Ctrl-C bytes. The command runs with an operator's environment rather
than this process's, so anything an enclosing agent session exported is dropped.

The command runs in a fresh temporary directory holding a byte-for-byte copy of
this repository's own `AGENTS.md` and `.agents/implementor.md`. Afterwards both
conversations are removed through Codex's own `codex delete --force <id>`, each
named by the exact identity this run created. `CODEX_HOME`
is left alone — relocating it de-authenticates Codex — and nothing beneath
Codex's configuration, history or rollout files is ever opened.

Run it with:

```sh
XMD_CODEX_NATIVE_PROOF=1 XMD_CODEX_MODEL_TURNS_AUTHORIZED=1 \
  deno task xmd test packages/acp/src/CodexZeroNativeTurnExit.test.md --raw
```

## What a verdict may say

The schema is the disclosure boundary, not a convenience. It accepts versions
and digests of public executables, the session identity and who chose it,
booleans, counts, phase and failure classes, usage field *names*, and cleanup
outcomes. The role contract's text, the materialization turn's reply, raw
terminal output, argument vectors, the environment and private paths have
nowhere to go in it, so a fixture that tried to report one would fail this
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
<Test name="One materialization turn makes a Codex session openable, and re-entry buys no second one" timeout="45min">

```sh timeout=40min exec as="run"
deno run --allow-all --frozen packages/acp/tests/fixtures/codex-native-launch-proof.ts zero-native-turn
```

The fixture returns a structured verdict even when the product fails one of the
two questions, so a nonzero exit means the harness broke rather than a question
being answered.

<AssertEquals actual={run.exitCode} expected={0} />

<Parse schema={verdictSchema} as="proof">
{run.stdout}
</Parse>

The whole result is shown before anything is judged. It carries no contract
text, no transcript content and no reply — `promptExact` and `responsePresent`
are the only things about the turn that crossed the fixture boundary.

```json
{run.stdout}
```

## Nothing private was read

True whether or not the proof was opted into. Codex's rollout files are the one
place that could answer this document cheaply, and they are exactly what a proof
of the public contract may not open.

<AssertFalse expr={proof.privateStateInspected} />

<If condition={proof.ran}>

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

## Exactly one model turn, and it was XMD's

The authorized budget is one, and one is what the durable accounts retain across
both invocations. Nothing was typed into either native UI, so every byte the
conversation received was the product's own.

<AssertEquals actual={proof.authorizedTurnBudget} expected={1} />
<AssertEquals actual={proof.modelTurns} expected={1} />
<AssertEquals actual={proof.materializationTurns} expected={1} />
<AssertEquals actual={proof.nativeUserTurns} expected={0} />
<AssertEquals actual={proof.acpReattachTurns} expected={0} />
<AssertEquals actual={proof.conversationInputByteCount} expected={0} />
<AssertEquals actual={proof.exitControlBytes} expected={"0303"} />
<AssertEquals actual={proof.reentryExitControlBytes} expected={"0303"} />

Nothing was typed, so nothing was watched for. The harness reconstructs a
terminal only for an invocation that submits a turn and waits for its answer,
and neither of these two invocations does.

<AssertEquals actual={proof.answerObserverInvocations} expected={0} />

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
about Codex, not about this document, so both lists are shown and only their
sum is fixed: every field is either reported or explicitly unreported, and none
is quietly inferred to be zero.

<Assert
  expr={proof.materialization.reportedUsageFields.length +
    proof.materialization.unreportedUsageFields.length === 8}
/>

## The session was openable, and stayed openable

The first launch left Codex's own composer rather than its refusal. The second
invocation reached the same conversation, under the same identity, without a
second materialization — which the count above already settled.

<AssertEquals actual={proof.outcome} expected={"same-identity"} />
<AssertEquals actual={proof.reentryNativeSessionId} expected={proof.nativeSessionId} />
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

The phases are the whole story. The first invocation materializes; the second,
finding a conversation that is already openable, does not.

<AssertEquals actual={proof.journal.sessionState} expected={["created", "resumed"]} />
<AssertEquals
  actual={proof.journal.firstPhases}
  expected={["prepared", "materialized", "detached", "exited"]}
/>
<AssertEquals actual={proof.journal.secondPhases} expected={["prepared", "detached", "exited"]} />
<AssertEquals actual={proof.journal.failureClasses} expected={[]} />

## Nothing was left behind

<AssertEquals actual={proof.cleanup.liveChildren} expected={0} />
<Assert expr={proof.cleanup.journalsRemoved} />
<Assert expr={proof.cleanup.routeRecordsRemoved} />
<Assert expr={proof.cleanup.temporaryRootRemoved} />
<AssertNotEquals actual={proof.cleanup.sessionDeleteOutcome} expected={"failed"} />

<AssertEquals actual={proof.verdict} expected={"PASS"} />

<Else>

## Without the authorization, or the build, nothing started

The refusal happens before any Codex conversation exists, so an unauthorized run
spends no turn and observes nothing. This is the branch that runs on an ordinary
machine, and the branch that runs on a machine outside the frozen tuple.

<Assert expr={proof.verdict === "REFUSED" || proof.verdict === "ENVIRONMENT_BLOCKED"} />
<Assert
  expr={proof.verdict === "ENVIRONMENT_BLOCKED" ||
    proof.refusal === "opt-in-absent" ||
    proof.refusal === "turns-not-authorized" ||
    proof.refusal === "codex-home-set"}
/>
<AssertEquals actual={proof.modelTurns} expected={0} />
<AssertEquals actual={proof.materializationTurns} expected={0} />
<AssertEquals actual={proof.answerObserverInvocations} expected={0} />
<AssertEquals actual={proof.conversationInputByteCount} expected={0} />
<AssertEquals actual={proof.nativeSessionId} expected={""} />
<AssertEquals actual={proof.outcome} expected={"unresolved"} />

</Else>
</If>

</Test>
