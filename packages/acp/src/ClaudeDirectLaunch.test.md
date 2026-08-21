# Direct Claude launch probes

XMD wants to prepare a Claude session and then hand the person Claude's own
interactive UI for that exact session. One structural question decides whether
that is possible without waiting on an upstream change, and this document
settles it against a single frozen compatibility point.

The question is this: if XMD allocates the session identity and native Claude
creates the conversation, can XMD's later Agent work reattach to *that*
conversation through ACP? If it cannot, XMD's stateful continuity would split
into two unrelated sessions — one the person talked to, one the document talks
to — and the architecture falls back to the upstream SDK and adapter.

The second question — whether leaving a launched session without saying
anything is well defined — lives in its own document,
`ClaudeZeroTurnExit.test.md`, so this gate's two authorized model turns are
never respent while that one is being corrected.

## What this costs, and what it touches

This is opt-in because it spends two real model turns against the operator's
own Claude credentials — one native turn that plants a marker, one ACP turn
that recalls it. The fixture refuses before starting any provider process
unless `XMD_CLAUDE_DIRECT_PROOF=1`.

It runs against the operator's normal Claude configuration, because relocating
`CLAUDE_CONFIG_DIR` de-authenticates this Claude release. Isolation is by
project instead: each probe works in a fresh directory nothing else has used,
and afterwards removes that project through Claude's own path-scoped
`project purge`. The fixture refuses if `CLAUDE_CONFIG_DIR` is set at all.

Run it with:

```sh
XMD_CLAUDE_DIRECT_PROOF=1 deno task xmd test packages/acp/src/ClaudeDirectLaunch.test.md --raw
```

<Test name="Native-created Claude history reattaches through ACP" timeout="15min">

## Gate 1 — native-created history reattaches through ACP

The fixture allocates one UUID, gives it to native Claude as `--session-id`, and
lets Claude create the conversation. It plants a one-time marker in that native
user turn only — never in the instruction file, the ACP prompt, the argument
vector, the environment, or the session key.

It then asks ACPX to load that same identity with `resumeSessionId`, and sends a
prompt that does not contain the marker. Recovering the marker is the whole
gate: an ACPX session that created something unrelated cannot produce it, and
neither can an agreeable model, because it was never told what the marker was.

```sh timeout=10min exec as="reattachment"
deno run --allow-all --frozen packages/acp/tests/fixtures/claude-direct-launch-probe.ts native-to-acp
```

The fixture returns a structured verdict even when the provider fails the gate,
so a nonzero exit means the harness itself broke rather than the gate failing.

<AssertEquals actual={reattachment.exitCode} expected={0} />

<Parse schema={{ type: "object", required: ["probe", "verdict", "identitySource", "nativeSessionId", "resumeSessionId", "nativeTurnCount", "acpTurnCount", "markerRecovered", "substitutedIdentity", "claudeConfigDirOverridden", "privateStateInspected", "preparedTextInArgv", "preparedTextInEnvironment", "claudeExecutable", "nativeClaudeVersion", "adapterClaudeExecutable", "adapterClaudeVersion", "executableAligned", "cleanup", "detail"], properties: { probe: { type: "string" }, verdict: { type: "string" }, identitySource: { type: "string" }, nativeSessionId: { type: "string" }, resumeSessionId: { type: "string" }, nativeTurnCount: { type: "number" }, acpTurnCount: { type: "number" }, nativeAcknowledged: { type: "boolean" }, acpTurnCompleted: { type: "boolean" }, markerRecovered: { type: "boolean" }, substitutedIdentity: { type: "boolean" }, claudeConfigDirOverridden: { type: "boolean" }, privateStateInspected: { type: "boolean" }, preparedTextInArgv: { type: "boolean" }, preparedTextInEnvironment: { type: "boolean" }, claudeExecutable: { type: "string" }, nativeClaudeVersion: { type: "string" }, adapterClaudeExecutable: { type: "string" }, adapterClaudeVersion: { type: "string" }, executableAligned: { type: "boolean" }, detail: { type: "string" }, versions: { type: "object" }, cleanup: { type: "object", required: ["instructionFileRemoved", "acpxStateRemoved", "projectPurgeDryRunExitCode", "projectPurgeOutcome", "temporaryRootRemoved", "liveChildren"], properties: { instructionFileRemoved: { type: "boolean" }, acpxStateRemoved: { type: "boolean" }, projectPurgeDryRunExitCode: { type: "number" }, projectPurgeExitCode: { type: ["number", "null"] }, projectPurgeOutcome: { type: "string" }, temporaryRootRemoved: { type: "boolean" }, liveChildren: { type: "number" } } } } }} as="gate1">
{reattachment.stdout}
</Parse>

The whole structured result is shown before anything is judged. A gate that
fails should say why on the way past, rather than leaving the reader with a bare
comparison. It carries no marker, instruction text or transcript content —
`markerRecovered` is the only thing that crossed the fixture boundary.

```json
{reattachment.stdout}
```

### The identity is XMD's own, and it never moved

One UUID was allocated before any process started, and the same value was given
to Claude and to ACPX. Nothing translated an ACP or ACPX value into it.

<AssertEquals actual={gate1.identitySource} expected={"client-allocated"} />
<AssertEquals actual={gate1.resumeSessionId} expected={gate1.nativeSessionId} />
<AssertFalse expr={gate1.substitutedIdentity} />

### Both sides of the handoff are one validated executable

The adapter otherwise runs the native binary shipped with the Claude Agent SDK
it pins, which is a different build from the one on the operator's PATH. This
variant binds native launch and ACP reattachment to the same absolute
executable and requires both to report the frozen version, so a resume failure
cannot be blamed on two Claude builds disagreeing.

<AssertEquals actual={gate1.claudeExecutable} expected={gate1.adapterClaudeExecutable} />
<AssertEquals actual={gate1.nativeClaudeVersion} expected={"2.1.235 (Claude Code)"} />
<AssertEquals actual={gate1.adapterClaudeVersion} expected={"2.1.235 (Claude Code)"} />
<Assert expr={gate1.executableAligned} />

### The probe stayed inside its authorization

Two model turns, exactly as authorized: one native, one through ACP.

<AssertEquals actual={gate1.nativeTurnCount} expected={1} />
<AssertEquals actual={gate1.acpTurnCount} expected={1} />

Claude ran under its own configuration, and no provider-private state was read
to decide any of this.

<AssertFalse expr={gate1.claudeConfigDirOverridden} />
<AssertFalse expr={gate1.privateStateInspected} />

The prepared instructions travelled by restrictive file, so neither surface
another process could read them from ever held the text.

<AssertFalse expr={gate1.preparedTextInArgv} />
<AssertFalse expr={gate1.preparedTextInEnvironment} />

### The probe left nothing behind

Its own files are gone, the project it created was purged through Claude's own
path-scoped command, and no child outlived it.

<Assert expr={gate1.cleanup.instructionFileRemoved} />
<Assert expr={gate1.cleanup.acpxStateRemoved} />
<Assert expr={gate1.cleanup.temporaryRootRemoved} />
<AssertEquals actual={gate1.cleanup.liveChildren} expected={0} />

The purge either removed the project or found nothing to remove. Both mean
nothing was left behind; only an unrecognized purge failure would not.

<AssertNotEquals actual={gate1.cleanup.projectPurgeOutcome} expected={"failed"} />

### The gate

The marker crossed from the native conversation into the ACP answer. Nothing
else in this document proves the design is viable, and nothing else needs to.

<Assert expr={gate1.markerRecovered} />
<AssertEquals actual={gate1.verdict} expected={"PASS"} />

</Test>
