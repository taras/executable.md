# Zero-turn exit from a launched Claude session

Gate 1 established that a session XMD allocates and native Claude creates can be
reattached through ACP, provided both owners run one validated executable. This
document asks the smaller remaining question: can a person leave such a session
**without saying anything**, and can XMD then re-enter it under the same
identity — or does Claude at least refuse explicitly rather than silently
landing somewhere new?

Silently landing somewhere else is the failure this is looking for. A picker, a
replacement identity, or a fresh session wearing the old name would all mean XMD
could hand someone back a conversation that is not theirs.

## What this may send, and what it may not

Nothing here spends a model turn. The probe sends exactly two kinds of input, on
separate channels, and reports them separately:

- **Terminal control.** Claude asks whether it may work in a directory it has
  not seen. That dialog is a directory acknowledgement — it reaches no model and
  creates no user turn — so the probe may answer it once per process, and never
  after a conversation surface has appeared.
- **Exit control.** On this build the conversation prompt announces itself only
  in answer to a Ctrl-D, so the probe sends one as a readiness question and
  accepts only Claude's exact *"Press Ctrl-D again to exit"* as proof the prompt
  received it — then sends the second Ctrl-D that actually leaves. Two control
  bytes, and no text, newline, slash command or prompt at any point.

It lives in its own document so that correcting it never respends Gate 1's two
authorized model turns.

Run it with:

```sh
XMD_CLAUDE_DIRECT_PROOF=1 deno task xmd test packages/acp/src/ClaudeZeroTurnExit.test.md --raw
```

<Test name="Leaving a launched session without speaking is well defined" timeout="10min">

```sh timeout=8min exec as="zeroTurn"
deno run --allow-all --frozen packages/acp/tests/fixtures/claude-direct-launch-probe.ts zero-turn-exit
```

The fixture returns a structured verdict even when it cannot settle the gate, so
a nonzero exit means the harness broke rather than the gate being answered.

<AssertEquals actual={zeroTurn.exitCode} expected={0} />

<Parse schema={{ type: "object", required: ["probe", "verdict", "identitySource", "nativeSessionId", "conversationInputBytes", "trustInputBytes", "initialExitControlBytes", "reentryTrustInputBytes", "reentryExitControlBytes", "initialTrustAnswered", "reentryTrustAnswered", "modelTurnCount", "outcome", "substitutedIdentity", "privateStateInspected", "claudeExecutable", "nativeClaudeVersion", "adapterClaudeVersion", "executableAligned", "cleanup", "detail"], properties: { probe: { type: "string" }, verdict: { type: "string" }, identitySource: { type: "string" }, nativeSessionId: { type: "string" }, conversationInputBytes: { type: "string" }, trustInputBytes: { type: "string" }, initialExitControlBytes: { type: "string" }, reentryTrustInputBytes: { type: "string" }, reentryExitControlBytes: { type: "string" }, initialTrustAnswered: { type: "boolean" }, reentryTrustAnswered: { type: "boolean" }, modelTurnCount: { type: "number" }, outcome: { type: "string" }, substitutedIdentity: { type: "boolean" }, privateStateInspected: { type: "boolean" }, claudeExecutable: { type: "string" }, nativeClaudeVersion: { type: "string" }, adapterClaudeExecutable: { type: "string" }, adapterClaudeVersion: { type: "string" }, executableAligned: { type: "boolean" }, detail: { type: "string" }, versions: { type: "object" }, cleanup: { type: "object", required: ["instructionFileRemoved", "projectPurgeOutcome", "temporaryRootRemoved", "liveChildren"], properties: { instructionFileRemoved: { type: "boolean" }, acpxStateRemoved: { type: "boolean" }, projectPurgeDryRunExitCode: { type: "number" }, projectPurgeExitCode: { type: ["number", "null"] }, projectPurgeOutcome: { type: "string" }, temporaryRootRemoved: { type: "boolean" }, liveChildren: { type: "number" } } } } }} as="gate2">
{zeroTurn.stdout}
</Parse>

The whole result is shown before anything is judged, so a gate that cannot be
settled still says why on the way past. It carries no transcript content.

```json
{zeroTurn.stdout}
```

## The identity is XMD's own, and both entries ran one validated executable

<AssertEquals actual={gate2.identitySource} expected={"client-allocated"} />
<AssertEquals actual={gate2.nativeClaudeVersion} expected={"2.1.235 (Claude Code)"} />
<AssertEquals actual={gate2.adapterClaudeVersion} expected={"2.1.235 (Claude Code)"} />
<Assert expr={gate2.executableAligned} />
<AssertFalse expr={gate2.substitutedIdentity} />

## Nothing was said, and nothing was read

Three channels, kept apart. The conversation channel is never written to at all.
Trust is one directory acknowledgement. Exit control is the two Ctrl-D bytes —
the first to ask the prompt whether it is there, the second to leave.

<AssertEquals actual={gate2.conversationInputBytes} expected={""} />
<AssertEquals actual={gate2.modelTurnCount} expected={0} />
<AssertEquals actual={gate2.trustInputBytes} expected={"790a"} />
<AssertEquals actual={gate2.initialExitControlBytes} expected={"0404"} />
<AssertFalse expr={gate2.privateStateInspected} />

## Nothing was left behind

<Assert expr={gate2.cleanup.instructionFileRemoved} />
<Assert expr={gate2.cleanup.temporaryRootRemoved} />
<AssertEquals actual={gate2.cleanup.liveChildren} expected={0} />
<AssertNotEquals actual={gate2.cleanup.projectPurgeOutcome} expected={"failed"} />

## The gate

Re-entry reached the identity it was given, or was refused for that exact
identity. Anything else is unresolved.

<Assert expr={gate2.outcome === "same-identity" || gate2.outcome === "no-session"} />
<AssertEquals actual={gate2.verdict} expected={"PASS"} />

</Test>
