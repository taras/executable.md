# A real Claude session, prepared and then resumed

`xmd run AGENTS.md#Implementor --default-agent claude` is the whole product: it
prepares one Claude session from the repository's own Implementor contract and
hands you Claude's own interactive UI for that exact session. This document runs
that command — the literal one, through the built binary — and asks the two
questions that decide whether the session is real.

**Did the prepared contract govern the first thing you say?** The first turn
asks for the opening sentence of the role contract without ever sending that
sentence. A session that did not receive the prepared layer cannot produce it,
and neither can an agreeable model, because nothing in the question says what
the sentence is.

**Is it still the same conversation next time?** The first turn also plants a
one-time marker. A second, independent invocation of the same command then asks
for that marker without including it. Recovering it is what makes the resumed
session the conversation you were in, rather than a new one wearing its name.

Resuming redraws the conversation that already exists, so the marker is back on
screen before the second turn is even asked — and finding it there would prove
only that a transcript was repainted. So the answer has to carry the marker
behind a prefix that appears in no earlier turn and in nothing Claude draws.
Only an answer can produce that.

The zero-turn question — whether you can leave such a session without saying
anything — lives in `ClaudeZeroTurnExit.test.md`, so that one can be corrected
without ever respending the two model turns this document is authorized to
spend.

## What this costs, and what it touches

Two real model turns against the operator's own Claude credentials: one native
turn that answers from the prepared layer and plants the marker, one after
`--resume` that recalls it. Nothing else is sent, and there is no bootstrap
prompt — the layer is in force before the first thing anyone types.

It is opt-in twice over. Without `XMD_CLAUDE_NATIVE_PROOF=1` the fixture refuses
before starting any Claude process; without a separate
`XMD_CLAUDE_MODEL_TURNS_AUTHORIZED=2` it refuses before spending a turn.

Everything sent besides those two turns is terminal control: a consent menu is
answered at most once with the conservative choice the dialog itself offers, and
the exit is two Ctrl-D bytes. The command also runs with an operator's
environment rather than this process's — anything an enclosing Claude Code
session exported is dropped, because `CLAUDE_CODE_CHILD_SESSION` turns Claude's
transcript saving off, and a proof that inherited it would be asking whether a
session resumes while having quietly stopped it being saved.

The command runs in a fresh temporary directory holding a byte-for-byte copy of
this repository's own `AGENTS.md` and `.agents/implementor.md`, so the literal
production target resolves without creating Claude project state for the
repository. Afterwards that project is removed through Claude's own path-scoped
`project purge`. `CLAUDE_CONFIG_DIR` is left alone — relocating it
de-authenticates Claude Code — and nothing beneath Claude's configuration,
history or transcripts is ever opened.

Run it with:

```sh
XMD_CLAUDE_NATIVE_PROOF=1 XMD_CLAUDE_MODEL_TURNS_AUTHORIZED=2 \
  deno task xmd test packages/acp/src/ClaudeNativeLaunch.test.md --raw
```

## What a verdict may say

The schema is the disclosure boundary, not a convenience. It accepts versions,
the exact session identity and who chose it, filtered command shapes whose
instruction path reads `<private-file>`, booleans, counts, phase and failure
classes, and cleanup outcomes. The role contract's text, the history marker,
raw terminal output, argument vectors, the environment and private paths have
nowhere to go in it, so a fixture that tried to report one would fail this
document.

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
    "firstCommand", "secondCommand",
    "firstInvocationChildren", "secondInvocationChildren",
    "firstXmdExitCode", "secondXmdExitCode",
    "instructionChannel", "privateFileMode", "privateFileRegular",
    "preparedTextInArgv", "preparedTextInEnvironment",
    "modelTurns", "conversationInputByteCount",
    "consentInputBytes", "consentSurfaces", "exitControlBytes",
    "reentryConsentInputBytes", "reentryConsentSurfaces", "reentryExitControlBytes",
    "inheritedAgentMarkersRemoved",
    "openingSentenceExact", "markerRecovered", "answerSurface", "outcome",
    "route", "journal", "cleanup", "privateStateInspected"
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
    "secondCommand": { "type": "array", "items": { "type": "string" } },
    "firstInvocationChildren": { "type": "integer" },
    "secondInvocationChildren": { "type": "integer" },
    "firstXmdExitCode": { "type": "integer" },
    "secondXmdExitCode": { "type": "integer" },
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
    "reentryConsentInputBytes": { "type": "string" },
    "reentryConsentSurfaces": { "type": "array", "items": { "type": "string" } },
    "reentryExitControlBytes": { "type": "string" },
    "inheritedAgentMarkersRemoved": { "type": "integer" },
    "openingSentenceExact": { "type": "boolean" },
    "markerRecovered": { "type": "boolean" },
    "answerSurface": { "type": "string" },
    "outcome": { "enum": ["same-identity", "no-session", "unresolved"] },
    "privateStateInspected": { "type": "boolean" },
    "route": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "provenance", "launcher", "nativeSessionId", "instructionsDigestPresent"],
      "properties": {
        "kind": { "type": "string" },
        "provenance": { "type": "string" },
        "launcher": { "type": "string" },
        "nativeSessionId": { "type": "string" },
        "instructionsDigestPresent": { "type": "boolean" }
      }
    },
    "journal": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "provider", "agent", "launcher", "provenance", "nativeSessionId",
        "sessionState", "instructionsDigestPresent",
        "firstPhases", "secondPhases", "failureClasses"
      ],
      "properties": {
        "provider": { "type": "string" },
        "agent": { "type": "string" },
        "launcher": { "type": "string" },
        "provenance": { "type": "string" },
        "nativeSessionId": { "type": "string" },
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
        "liveChildren", "privateFileRemoved", "privateDirectoryRemoved",
        "journalsRemoved", "routeRecordsRemoved", "projectPurgeOutcome",
        "temporaryRootRemoved"
      ],
      "properties": {
        "liveChildren": { "type": "integer" },
        "privateFileRemoved": { "type": "boolean" },
        "privateDirectoryRemoved": { "type": "boolean" },
        "journalsRemoved": { "type": "boolean" },
        "routeRecordsRemoved": { "type": "boolean" },
        "projectPurgeOutcome": { "enum": ["purged", "nothing-to-purge", "failed"] },
        "temporaryRootRemoved": { "type": "boolean" }
      }
    }
  }
}
```

</Let>
<Test name="A prepared Claude session governs its first turn and resumes itself" timeout="45min">

```sh timeout=40min exec as="run"
deno run --allow-all --frozen packages/acp/tests/fixtures/claude-native-launch-proof.ts two-turn
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
`markerRecovered` are the only things that crossed the fixture boundary.

```json
{run.stdout}
```

## Nothing private was read

True whether or not the proof was opted into.

<AssertFalse expr={proof.privateStateInspected} />

<If condition={proof.ran}>

## Exactly two turns, and no bootstrap

Both were the operator's own: one in the session the launch constructed, one in
the session a second invocation resumed. Nothing was said in between, and
nothing was said before the first.

<AssertEquals actual={proof.modelTurns} expected={2} />
<Assert expr={proof.conversationInputByteCount > 0} />
<AssertEquals actual={proof.exitControlBytes} expected={"0404"} />
<AssertEquals actual={proof.reentryExitControlBytes} expected={"0404"} />

## The prepared contract governed the first native turn

The question named neither the sentence nor any file. The answer carried the
opening sentence of `.agents/implementor.md` exactly, which only the prepared
layer could have supplied.

<AssertEquals actual={proof.claudeVersion} expected={"2.1.241 (Claude Code)"} />
<AssertEquals actual={proof.platform} expected={"darwin"} />
<AssertEquals actual={proof.architecture} expected={"arm64"} />
<Assert expr={proof.openingSentenceExact} />

## The resumed session is the same conversation

The marker existed only in the first native user turn — never in the instruction
file, the argument vector, the environment or the session key — and the second
invocation, which never mentioned it, produced it behind a prefix that was never
on screen.

<Assert expr={proof.markerRecovered} />
<AssertEquals actual={proof.outcome} expected={"same-identity"} />

## The identity is XMD's own, allocated once

<AssertEquals actual={proof.identityProvenance} expected={"client-allocated"} />
<AssertEquals actual={proof.identityAllocations} expected={1} />
<AssertFalse expr={proof.substitutedIdentity} />
<AssertFalse expr={proof.freshFallback} />
<AssertFalse expr={proof.routeConverted} />

## The production target ran, and its siblings did not

<AssertEquals actual={proof.target} expected={"AGENTS.md#Implementor"} />
<Assert expr={proof.projectCopyVerified} />
<Assert expr={proof.implementorMarkerRendered} />
<AssertEquals actual={proof.siblingMarkersRendered} expected={0} />
<AssertEquals actual={proof.firstInvocationChildren} expected={1} />
<AssertEquals actual={proof.secondInvocationChildren} expected={1} />

## The two commands are the documented ones

Creation names the session and hands over a private instruction file. Resuming
hands over nothing — a `--session-id` there would be a second conversation, not
a continuation.

<AssertEquals
  actual={proof.firstCommand}
  expected={["claude", "--session-id", proof.nativeSessionId, "--system-prompt-file", "<private-file>"]}
/>
<AssertEquals actual={proof.secondCommand} expected={["claude", "--resume", proof.nativeSessionId]} />

## The instruction layer travelled privately

A file only that launch could read, and neither of the two surfaces another
process on the machine can read from.

<AssertEquals actual={proof.instructionChannel} expected={"claude.systemPromptFile"} />
<AssertEquals actual={proof.privateFileMode} expected={"0600"} />
<Assert expr={proof.privateFileRegular} />
<AssertFalse expr={proof.preparedTextInArgv} />
<AssertFalse expr={proof.preparedTextInEnvironment} />

## Route and journal agree

<AssertEquals actual={proof.route.kind} expected={"client-native"} />
<AssertEquals actual={proof.route.provenance} expected={"client-allocated"} />
<AssertEquals actual={proof.route.launcher} expected={"claude"} />
<AssertEquals actual={proof.route.nativeSessionId} expected={proof.nativeSessionId} />
<Assert expr={proof.route.instructionsDigestPresent} />
<AssertEquals actual={proof.journal.provider} expected={"acpx"} />
<AssertEquals actual={proof.journal.agent} expected={"claude"} />
<AssertEquals actual={proof.journal.launcher} expected={"claude"} />
<AssertEquals actual={proof.journal.provenance} expected={"client-allocated"} />
<AssertEquals actual={proof.journal.nativeSessionId} expected={proof.nativeSessionId} />
<Assert expr={proof.journal.instructionsDigestPresent} />
<AssertEquals actual={proof.journal.sessionState} expected={["created", "resumed"]} />
<AssertEquals actual={proof.journal.firstPhases} expected={["prepared", "detached", "exited"]} />
<AssertEquals actual={proof.journal.secondPhases} expected={["prepared", "detached", "exited"]} />
<AssertEquals actual={proof.journal.failureClasses} expected={[]} />

## Nothing was left behind

<AssertEquals actual={proof.cleanup.liveChildren} expected={0} />
<Assert expr={proof.cleanup.privateFileRemoved} />
<Assert expr={proof.cleanup.privateDirectoryRemoved} />
<Assert expr={proof.cleanup.journalsRemoved} />
<Assert expr={proof.cleanup.routeRecordsRemoved} />
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
<AssertEquals actual={proof.secondInvocationChildren} expected={0} />
<AssertEquals actual={proof.nativeSessionId} expected={""} />
<AssertEquals actual={proof.firstCommand} expected={[]} />

</Else>
</If>

</Test>
