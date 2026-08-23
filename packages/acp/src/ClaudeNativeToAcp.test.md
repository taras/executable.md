# A native Claude session, continued through an ACP prompt

`xmd run AGENTS.md#Implementor --default-agent claude` hands you Claude's own
interactive UI for a session XMD named. This document asks the question that
makes such a session more than a launch: **can a document join that
conversation afterwards?**

Two production commands, in one private project directory. The first prepares
the session and spends one authorized native turn that plants a random marker in
it. The second is a checked-in, marker-free `<Session name="implementer">` with
a single `<Prompt>` — an ordinary ACP turn, through the same built binary, in
the same directory.

Recovering the marker there is the whole claim. Equal identities are not: two
accounts agreeing about a UUID say nothing about whether the conversation behind
it is the one the native turn happened in. So the marker exists only in the
first native user turn and in the harness's own memory, and the answer has to
carry it behind a prefix that appears in no earlier turn.

The independent half asks the opposite question. A route naming a conversation
nobody ever had must refuse before a turn, rather than quietly starting an empty
one — because a provider that creates history for a missing identity would make
every recovery above unfalsifiable.

## What this costs, and what it touches

Two real model turns against the operator's own Claude credentials: one native
turn that stores the marker, one ACP turn that recalls it. The absent-identity
case spends none.

It is opt-in twice over. Without `XMD_CLAUDE_ATTACHMENT_PROOF=1` the fixture
refuses before starting any Claude process; without a separate
`XMD_CLAUDE_MODEL_TURNS_AUTHORIZED=2` it refuses before spending a turn.

The command runs with an operator's environment rather than this process's —
anything an enclosing Claude Code session exported is dropped, because
`CLAUDE_CODE_CHILD_SESSION` turns Claude's transcript saving off, and a proof
that inherited it would be asking whether a session continues while having
quietly stopped it being saved.

Everything runs in a fresh temporary directory holding a byte-for-byte copy of
this repository's own `AGENTS.md` and `.agents/implementor.md`, so the literal
production target resolves without creating Claude project state for the
repository. Afterwards that project is removed through Claude's own path-scoped
`project purge`, and the exact route, ownership, lease, provider-arrangement and
journal paths this run created are removed by name. `CLAUDE_CONFIG_DIR` is left
alone — relocating it de-authenticates Claude Code — and nothing beneath
Claude's configuration, history or transcripts is ever opened.

Run it with:

```sh
XMD_CLAUDE_ATTACHMENT_PROOF=1 XMD_CLAUDE_MODEL_TURNS_AUTHORIZED=2 \
  deno task xmd test packages/acp/src/ClaudeNativeToAcp.test.md --raw
```

## What a verdict may say

The schema is the disclosure boundary, not a convenience. It accepts versions,
the exact session identity and the filtered build binding, a command shape whose
instruction path reads `<private-file>`, booleans, counts, phase and failure
classes, and cleanup outcomes. The role contract's text, the history marker, raw
terminal output, argument vectors, the environment, the executable path and
private paths have nowhere to go in it, so a fixture that tried to report one
would fail this document.

<Let as="verdictSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "mode", "verdict", "authorized", "ran", "refusal", "detail",
    "claudeVersion", "platform", "architecture",
    "target", "projectCopyVerified", "implementorMarkerRendered", "siblingMarkersRendered",
    "nativeSessionId", "identityProvenance", "identityAllocations",
    "substitutedIdentity", "routeConverted", "freshFallback",
    "firstCommand", "firstInvocationChildren", "firstXmdExitCode",
    "acpXmdExitCode", "acpDocument", "acpDocumentCarriesMarker", "acpInvocationChildren",
    "instructionChannel", "privateFileMode", "privateFileRegular",
    "preparedTextInArgv", "preparedTextInEnvironment",
    "modelTurns", "conversationInputByteCount",
    "consentInputBytes", "consentSurfaces", "exitControlBytes",
    "adapterCommand", "inheritedAgentMarkersRemoved",
    "markerStored", "markerRecovered", "markerInReportedEvidence",
    "answerSurface", "outcome",
    "route", "journal", "arrangement", "observed", "absent",
    "cleanup", "privateStateInspected"
  ],
  "properties": {
    "mode": { "type": "string" },
    "verdict": { "enum": ["PASS", "REFUSED", "ENVIRONMENT_BLOCKED", "PRODUCT_FAILED", "HARNESS_FAILED"] },
    "authorized": { "type": "boolean" },
    "ran": { "type": "boolean" },
    "refusal": { "type": "string" },
    "detail": { "type": "string" },
    "claudeVersion": { "type": "string" },
    "platform": { "type": "string" },
    "architecture": { "type": "string" },
    "target": { "type": "string" },
    "projectCopyVerified": { "type": "boolean" },
    "implementorMarkerRendered": { "type": "boolean" },
    "siblingMarkersRendered": { "type": "integer" },
    "nativeSessionId": { "type": "string" },
    "identityProvenance": { "type": "string" },
    "identityAllocations": { "type": "integer" },
    "substitutedIdentity": { "type": "boolean" },
    "routeConverted": { "type": "boolean" },
    "freshFallback": { "type": "boolean" },
    "firstCommand": { "type": "array", "items": { "type": "string" } },
    "firstInvocationChildren": { "type": "integer" },
    "firstXmdExitCode": { "type": "integer" },
    "acpXmdExitCode": { "type": "integer" },
    "acpDocument": { "type": "string" },
    "acpDocumentCarriesMarker": { "type": "boolean" },
    "acpInvocationChildren": { "type": "integer" },
    "instructionChannel": { "type": "string" },
    "privateFileMode": { "type": "string" },
    "privateFileRegular": { "type": "boolean" },
    "preparedTextInArgv": { "type": "boolean" },
    "preparedTextInEnvironment": { "type": "boolean" },
    "modelTurns": { "type": "integer" },
    "conversationInputByteCount": { "type": "integer" },
    "consentInputBytes": { "type": "string" },
    "consentSurfaces": { "type": "array", "items": { "type": "string" } },
    "exitControlBytes": { "type": "string" },
    "adapterCommand": { "type": "string" },
    "inheritedAgentMarkersRemoved": { "type": "integer" },
    "markerStored": { "type": "boolean" },
    "markerRecovered": { "type": "boolean" },
    "markerInReportedEvidence": { "type": "boolean" },
    "answerSurface": { "type": "string" },
    "outcome": { "type": "string" },
    "route": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schema", "kind", "provenance", "launcher", "nativeSessionId",
        "instructionsDigestPresent", "buildVersion", "buildDigestPresent"
      ],
      "properties": {
        "schema": { "type": "string" },
        "kind": { "type": "string" },
        "provenance": { "type": "string" },
        "launcher": { "type": "string" },
        "nativeSessionId": { "type": "string" },
        "instructionsDigestPresent": { "type": "boolean" },
        "buildVersion": { "type": "string" },
        "buildDigestPresent": { "type": "boolean" }
      }
    },
    "journal": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "provider", "agent", "launcher", "provenance", "nativeSessionId",
        "sessionState", "instructionsDigestPresent", "buildVersion",
        "firstPhases", "failureClasses"
      ],
      "properties": {
        "provider": { "type": "string" },
        "agent": { "type": "string" },
        "launcher": { "type": "string" },
        "provenance": { "type": "string" },
        "nativeSessionId": { "type": "string" },
        "sessionState": { "type": "array", "items": { "type": "string" } },
        "instructionsDigestPresent": { "type": "boolean" },
        "buildVersion": { "type": "string" },
        "firstPhases": { "type": "array", "items": { "type": "string" } },
        "failureClasses": { "type": "array", "items": { "type": "string" } }
      }
    },
    "arrangement": {
      "type": "object",
      "additionalProperties": false,
      "required": ["present", "agentSessionId"],
      "properties": {
        "present": { "type": "boolean" },
        "agentSessionId": { "type": "string" }
      }
    },
    "observed": {
      "type": "object",
      "additionalProperties": false,
      "required": ["version", "digestPresent", "matchesRoute"],
      "properties": {
        "version": { "type": "string" },
        "digestPresent": { "type": "boolean" },
        "matchesRoute": { "type": "boolean" }
      }
    },
    "absent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ran", "xmdExitCode", "failureClass", "modelTurns", "nativeChildren", "answered"],
      "properties": {
        "ran": { "type": "boolean" },
        "xmdExitCode": { "type": "integer" },
        "failureClass": { "type": "string" },
        "modelTurns": { "type": "integer" },
        "nativeChildren": { "type": "integer" },
        "answered": { "type": "boolean" }
      }
    },
    "cleanup": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "liveChildren", "privateFileRemoved", "privateDirectoryRemoved",
        "journalsRemoved", "routeRecordsRemoved", "providerArrangementRemoved",
        "projectPurgeOutcome", "temporaryRootRemoved"
      ],
      "properties": {
        "liveChildren": { "type": "integer" },
        "privateFileRemoved": { "type": "boolean" },
        "privateDirectoryRemoved": { "type": "boolean" },
        "journalsRemoved": { "type": "boolean" },
        "routeRecordsRemoved": { "type": "boolean" },
        "providerArrangementRemoved": { "type": "boolean" },
        "projectPurgeOutcome": { "enum": ["purged", "nothing-to-purge", "failed"] },
        "temporaryRootRemoved": { "type": "boolean" }
      }
    },
    "privateStateInspected": { "type": "boolean" }
  }
}
```

</Let>
<Test name="An ACP prompt continues the conversation a native launch constructed" timeout="45min">

```sh timeout=40min exec as="run"
deno run --allow-all --frozen packages/acp/tests/fixtures/claude-native-to-acp-proof.ts
```

The fixture returns a structured verdict even when the product fails one of the
two questions, so a nonzero exit means the harness broke rather than a question
being answered.

<AssertEquals actual={run.exitCode} expected={0} />

<Parse schema={verdictSchema} as="proof">
{run.stdout}
</Parse>

The whole result is shown before anything is judged. It carries no contract
text, no marker, no executable path and no transcript content.

```json
{run.stdout}
```

## Nothing private was read, and the marker stayed private

True whether or not the proof was opted into.

<AssertFalse expr={proof.privateStateInspected} />
<AssertFalse expr={proof.markerInReportedEvidence} />

<If condition={proof.ran}>

## Exactly two turns

One native turn in the session the launch constructed, and one ACP turn in the
same conversation. The absent-identity case spent none.

<AssertEquals actual={proof.modelTurns} expected={2} />
<Assert expr={proof.conversationInputByteCount > 0} />
<AssertEquals actual={proof.exitControlBytes} expected={"0404"} />

## The ACP prompt recovered the native turn's history

The marker existed only in the first native user turn and in the fixture's own
memory — never in the instruction file, the argument vector, the environment, the
session key, or the document the ACP turn ran. The answer produced it behind a
prefix that appears in no earlier turn.

<AssertEquals actual={proof.claudeVersion} expected={"2.1.241 (Claude Code)"} />
<AssertEquals actual={proof.platform} expected={"darwin"} />
<AssertEquals actual={proof.architecture} expected={"arm64"} />
<Assert expr={proof.markerStored} />
<AssertFalse expr={proof.acpDocumentCarriesMarker} />
<Assert expr={proof.markerRecovered} />
<AssertEquals actual={proof.outcome} expected={"same-conversation"} />
<AssertEquals actual={proof.acpXmdExitCode} expected={0} />

## It attached, and did not launch

The ACP invocation started no Claude of its own. One identity was allocated, by
the launch, and nothing after it named a second.

<AssertEquals actual={proof.firstInvocationChildren} expected={1} />
<AssertEquals actual={proof.acpInvocationChildren} expected={0} />
<AssertEquals actual={proof.identityProvenance} expected={"client-allocated"} />
<AssertEquals actual={proof.identityAllocations} expected={1} />
<AssertFalse expr={proof.substitutedIdentity} />
<AssertFalse expr={proof.freshFallback} />
<AssertFalse expr={proof.routeConverted} />

## One conversation, one build, four accounts

The route, the journal, the ACP client's own arrangement and the identity the
launch reported all name the same conversation — and the build this run would
use is the build the route retained.

<AssertEquals actual={proof.route.schema} expected={"session-route.v2"} />
<AssertEquals actual={proof.route.kind} expected={"client-native"} />
<AssertEquals actual={proof.route.provenance} expected={"client-allocated"} />
<AssertEquals actual={proof.route.launcher} expected={"claude"} />
<AssertEquals actual={proof.route.nativeSessionId} expected={proof.nativeSessionId} />
<Assert expr={proof.route.instructionsDigestPresent} />
<Assert expr={proof.route.buildDigestPresent} />
<AssertEquals actual={proof.route.buildVersion} expected={proof.claudeVersion} />
<AssertEquals actual={proof.journal.provider} expected={"acpx"} />
<AssertEquals actual={proof.journal.agent} expected={"claude"} />
<AssertEquals actual={proof.journal.launcher} expected={"claude"} />
<AssertEquals actual={proof.journal.provenance} expected={"client-allocated"} />
<AssertEquals actual={proof.journal.nativeSessionId} expected={proof.nativeSessionId} />
<AssertEquals actual={proof.journal.buildVersion} expected={proof.route.buildVersion} />
<AssertEquals actual={proof.journal.firstPhases} expected={["prepared", "detached", "exited"]} />
<AssertEquals actual={proof.journal.failureClasses} expected={[]} />
<Assert expr={proof.arrangement.present} />
<AssertEquals actual={proof.arrangement.agentSessionId} expected={proof.nativeSessionId} />
<Assert expr={proof.observed.digestPresent} />
<Assert expr={proof.observed.matchesRoute} />

## The adapter the attachment was proven against

ACPX resolves adapters through a semver range of its own. A capability that
depends on how an adapter handles resume identity cannot be left to that range,
so this binding names one — and the name is live, reaching no durable record.

<AssertEquals
  actual={proof.adapterCommand}
  expected={"npx -y @agentclientprotocol/claude-agent-acp@0.70.0"}
/>

## An identity nobody ever had is refused before a turn

The independent case. A bound route naming a fresh random conversation, in a
directory of its own, with no provider arrangement beside it: the prompt refuses
rather than starting an empty conversation and answering from it.

<Assert expr={proof.absent.ran} />
<AssertEquals actual={proof.absent.failureClass} expected={"identity-unavailable"} />
<AssertEquals actual={proof.absent.modelTurns} expected={0} />
<AssertEquals actual={proof.absent.nativeChildren} expected={0} />
<AssertFalse expr={proof.absent.answered} />
<AssertNotEquals actual={proof.absent.xmdExitCode} expected={0} />

## The production target ran, and its siblings did not

<AssertEquals actual={proof.target} expected={"AGENTS.md#Implementor"} />
<Assert expr={proof.projectCopyVerified} />
<Assert expr={proof.implementorMarkerRendered} />
<AssertEquals actual={proof.siblingMarkersRendered} expected={0} />

## The instruction layer travelled privately

<AssertEquals actual={proof.instructionChannel} expected={"claude.systemPromptFile"} />
<AssertEquals actual={proof.privateFileMode} expected={"0600"} />
<Assert expr={proof.privateFileRegular} />
<AssertFalse expr={proof.preparedTextInArgv} />
<AssertFalse expr={proof.preparedTextInEnvironment} />

## Nothing was left behind

<AssertEquals actual={proof.cleanup.liveChildren} expected={0} />
<Assert expr={proof.cleanup.privateFileRemoved} />
<Assert expr={proof.cleanup.privateDirectoryRemoved} />
<Assert expr={proof.cleanup.journalsRemoved} />
<Assert expr={proof.cleanup.routeRecordsRemoved} />
<Assert expr={proof.cleanup.providerArrangementRemoved} />
<Assert expr={proof.cleanup.temporaryRootRemoved} />
<AssertNotEquals actual={proof.cleanup.projectPurgeOutcome} expected={"failed"} />

<AssertEquals actual={proof.verdict} expected={"PASS"} />

<Else>

## Without the authorization, nothing started

The refusal happens before any Claude process, so an unauthorized run spends no
turn and observes nothing. This is the branch that runs on an ordinary machine.

<AssertEquals actual={proof.verdict} expected={"REFUSED"} />
<Assert
  expr={proof.refusal === "opt-in-absent" ||
    proof.refusal === "turns-not-authorized" ||
    proof.refusal === "claude-config-dir-set"}
/>
<AssertEquals actual={proof.modelTurns} expected={0} />
<AssertEquals actual={proof.conversationInputByteCount} expected={0} />
<AssertEquals actual={proof.firstInvocationChildren} expected={0} />
<AssertEquals actual={proof.acpInvocationChildren} expected={0} />
<AssertEquals actual={proof.nativeSessionId} expected={""} />
<AssertEquals actual={proof.firstCommand} expected={[]} />
<AssertFalse expr={proof.absent.ran} />

</Else>
</If>

</Test>
