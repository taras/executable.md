# Leaving a launched Claude session without saying anything

`xmd run AGENTS.md#Implementor --default-agent claude` prepares one Claude
session and hands you Claude's own interactive UI for it. This document asks the
smallest question about that session's identity: if you leave without saying
anything, does running the same command again put you back in *that*
conversation — or does Claude at least refuse that exact session out loud?

Silently landing somewhere else is the failure this is looking for. A session
picker, a replacement identity, or a fresh conversation wearing the old name
would each mean XMD could hand you back a conversation that is not yours.

It lives in its own document, and never runs the two-turn proof, so correcting
it can never respend that proof's authorized model turns.

## What this may send, and what it may not

Nothing here spends a model turn. Two kinds of input are sent, on separate
channels, and each is reported separately:

- **Consent.** Claude may put a menu in front of a new session — whether it may
  work in a directory it has not seen, whether it may drive your browser. Each
  asks the person at the terminal for a standing permission, reaches no model
  and creates no user turn, so each is answered at most once with the
  conservative choice the dialog itself offers. Which menus appear belongs to
  the machine, so they are reported by name.
- **Exit control.** Once no menu is left, a Ctrl-D is sent as a readiness
  question, and only Claude's own *"Press Ctrl-D again to exit"* or its session
  banner is accepted as proof the prompt is there. The second Ctrl-D leaves.

The conversation channel is never written to at all.

The command also runs with an operator's environment rather than this process's.
Anything an enclosing Claude Code session exported is dropped, because
`CLAUDE_CODE_CHILD_SESSION` turns Claude's transcript saving off — and a proof
that inherited it would be asking whether a session resumes while having quietly
stopped it being saved.

## What it touches

The command runs in a fresh temporary directory holding a byte-for-byte copy of
this repository's own `AGENTS.md` and `.agents/implementor.md`, so the literal
production target resolves without creating Claude project state for the
repository. Afterwards that project is removed through Claude's own path-scoped
`project purge`. `CLAUDE_CONFIG_DIR` is left alone — relocating it
de-authenticates Claude Code — and nothing beneath Claude's configuration,
history or transcripts is ever opened.

Run it with:

```sh
XMD_CLAUDE_NATIVE_PROOF=1 deno task xmd test packages/acp/src/ClaudeZeroTurnExit.test.md --raw
```

Without that variable the fixture refuses before it starts any Claude process,
and the test below proves that refusal rather than skipping.

## What a verdict may say

The schema is the disclosure boundary, not a convenience. It accepts versions,
the exact session identity and who chose it, filtered command shapes whose
instruction path reads `<private-file>`, booleans, counts, phase and failure
classes, and cleanup outcomes. Raw terminal output, argument vectors, the
environment, prepared instruction text and private paths have nowhere to go in
it, so a fixture that tried to report one would fail this document.

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

<Test name="Leaving a launched session without speaking is well defined" timeout="30min">

```sh timeout=25min exec as="run"
deno run --allow-all --frozen packages/acp/tests/fixtures/claude-native-launch-proof.ts zero-turn
```

The fixture returns a structured verdict even when it cannot settle the
question, so a nonzero exit means the harness broke rather than the question
being answered.

<AssertEquals actual={run.exitCode} expected={0} />

<Parse schema={verdictSchema} as="proof">
{run.stdout}
</Parse>

The whole result is shown before anything is judged, so a run that cannot be
settled still says why on the way past.

```json
{run.stdout}
```

## Nothing was said, and nothing private was read

True whether or not the proof was opted into. The conversation channel is empty
on both entries, which is the whole premise: this journey costs nothing.

<AssertEquals actual={proof.conversationInputByteCount} expected={0} />
<AssertEquals actual={proof.modelTurns} expected={0} />
<AssertFalse expr={proof.privateStateInspected} />
<AssertFalse expr={proof.openingSentenceExact} />
<AssertFalse expr={proof.markerRecovered} />

<If condition={proof.ran}>

## The identity is XMD's own, allocated once

One session identity was chosen by the adapter before any process existed. The
first command created that conversation; the second resumed it. Nothing
translated an ACP or ACPX value into it, and no second candidate was allocated.

<AssertEquals actual={proof.claudeVersion} expected={"2.1.241 (Claude Code)"} />
<AssertEquals actual={proof.platform} expected={"darwin"} />
<AssertEquals actual={proof.architecture} expected={"arm64"} />
<AssertEquals actual={proof.identityProvenance} expected={"client-allocated"} />
<AssertEquals actual={proof.identityAllocations} expected={1} />
<AssertFalse expr={proof.substitutedIdentity} />
<AssertFalse expr={proof.freshFallback} />

## The production target ran, and its siblings did not

The command was the literal one an operator types, against a byte-for-byte copy
of the checked-in role document. Its rendered output carries the Implementor
section and no other role's.

<AssertEquals actual={proof.target} expected={"AGENTS.md#Implementor"} />
<Assert expr={proof.projectCopyVerified} />
<Assert expr={proof.implementorMarkerRendered} />
<AssertEquals actual={proof.siblingMarkersRendered} expected={0} />
<AssertEquals actual={proof.firstInvocationChildren} expected={1} />
<AssertEquals actual={proof.secondInvocationChildren} expected={1} />

## Every key sent was terminal control

A consent menu is answered at most once per process, and the exit is the two
Ctrl-D bytes: one to ask the prompt whether it is there, one to leave.

<AssertEquals actual={proof.exitControlBytes} expected={"0404"} />
<Assert
  expr={proof.reentryExitControlBytes === "0404" || proof.outcome === "no-session"}
/>

## The two commands are the documented ones

Creation names the session and hands over a private instruction file. Re-entry
resumes that same name and hands over nothing — a `--session-id` there would be
a second conversation, not a continuation.

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

## Route and journal agree, and neither converted

<AssertEquals actual={proof.route.kind} expected={"client-native"} />
<AssertEquals actual={proof.route.provenance} expected={"client-allocated"} />
<AssertEquals actual={proof.route.launcher} expected={"claude"} />
<AssertEquals actual={proof.route.nativeSessionId} expected={proof.nativeSessionId} />
<Assert expr={proof.route.instructionsDigestPresent} />
<AssertFalse expr={proof.routeConverted} />
<AssertEquals actual={proof.journal.provider} expected={"acpx"} />
<AssertEquals actual={proof.journal.agent} expected={"claude"} />
<AssertEquals actual={proof.journal.launcher} expected={"claude"} />
<AssertEquals actual={proof.journal.provenance} expected={"client-allocated"} />
<AssertEquals actual={proof.journal.nativeSessionId} expected={proof.nativeSessionId} />
<Assert expr={proof.journal.instructionsDigestPresent} />
<AssertEquals actual={proof.journal.sessionState} expected={["created", "resumed"]} />
<AssertEquals actual={proof.journal.firstPhases} expected={["prepared", "detached", "exited"]} />

## Only two answers are accepted

Re-entry reached the identity it was given, or Claude refused that exact
identity and XMD failed closed. A picker, a replacement identity or a fresh
conversation is none of those.

<Assert expr={proof.outcome === "same-identity" || proof.outcome === "no-session"} />

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

## Without the opt-in, nothing started

The refusal happens before any Claude process, so an unopted run costs nothing
and observes nothing. This is the branch that runs on an ordinary machine.

<AssertEquals actual={proof.verdict} expected={"REFUSED"} />
<Assert
  expr={proof.refusal === "opt-in-absent" || proof.refusal === "claude-config-dir-set"}
/>
<AssertEquals actual={proof.firstInvocationChildren} expected={0} />
<AssertEquals actual={proof.secondInvocationChildren} expected={0} />
<AssertEquals actual={proof.nativeSessionId} expected={""} />
<AssertEquals actual={proof.firstCommand} expected={[]} />

</Else>
</If>

</Test>
