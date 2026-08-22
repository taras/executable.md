# Issue #519 direct-launch probe evidence

**Gate 1 `PASS`. Gate 2 `PASS`. P1–P8 all pass.**

Native-created Claude history reattaches through ACP when both sides of the
handoff run one validated Claude executable, and a person can leave such a
session without saying anything and be returned to the same identity. Neither
result needed an upstream change.

## Boundary

- Worktree `/private/tmp/xmd-native-launch`, branch
  `agent/native-session-launch-519-probes`, HEAD
  `28974f6d69e8178db072575fee55ddf990a7ccbf` — unchanged, nothing committed.
- No production code modified.
- Frozen point confirmed: Claude Code `2.1.235`, ACPX `0.12.0`, adapter
  `@agentclientprotocol/claude-agent-acp@0.70.0` by explicit override, macOS
  arm64, `CLAUDE_CONFIG_DIR` unset.

## The workaround under test

Both owners bound to one absolute, canonical, version-qualified executable:

- native launch spawns `/Users/tarasmankovski/.local/share/claude/versions/2.1.235`
  directly; and
- the ACP adapter receives `CLAUDE_CODE_EXECUTABLE` set to that same path, which
  its `claudeCliPath()` consults first.

Without that binding the adapter resolves the native binary shipped with the
Claude Agent SDK it pins — `2.1.232` — so `2.1.235` created the session and
`2.1.232` was asked to resume it.

## Gate 1 — PASS

```json
{
  "probe": "native-to-acp",
  "claudeExecutable": "/Users/tarasmankovski/.local/share/claude/versions/2.1.235",
  "nativeClaudeVersion": "2.1.235 (Claude Code)",
  "adapterClaudeExecutable": "/Users/tarasmankovski/.local/share/claude/versions/2.1.235",
  "adapterClaudeVersion": "2.1.235 (Claude Code)",
  "executableAligned": true,
  "verdict": "PASS",
  "identitySource": "client-allocated",
  "nativeSessionId": "99db08bf-212c-40e4-a221-84940a4c1901",
  "resumeSessionId": "99db08bf-212c-40e4-a221-84940a4c1901",
  "nativeTurnCount": 1,
  "acpTurnCount": 1,
  "nativeAcknowledged": true,
  "acpTurnCompleted": true,
  "markerRecovered": true,
  "substitutedIdentity": false,
  "claudeConfigDirOverridden": false,
  "privateStateInspected": false,
  "preparedTextInArgv": false,
  "preparedTextInEnvironment": false,
  "cleanup": {
    "instructionFileRemoved": true,
    "acpxStateRemoved": true,
    "projectPurgeDryRunExitCode": 0,
    "projectPurgeExitCode": 0,
    "projectPurgeOutcome": "purged",
    "temporaryRootRemoved": true,
    "liveChildren": 0
  },
  "detail": "native-created history continued through ACPX under the supplied identity"
}
```

Reproduced twice with different allocated UUIDs — `f88707bc-…` and
`99db08bf-…` — both recovering the marker.

## Gate 2 — PASS

In its own `packages/acp/src/ClaudeZeroTurnExit.test.md`, run independently.
Gate 1 was not rerun. **Zero model turns**, across this and every earlier
attempt.

```json
{
  "probe": "zero-turn-exit",
  "verdict": "PASS",
  "claudeExecutable": "/Users/tarasmankovski/.local/share/claude/versions/2.1.235",
  "nativeClaudeVersion": "2.1.235 (Claude Code)",
  "adapterClaudeVersion": "2.1.235 (Claude Code)",
  "executableAligned": true,
  "identitySource": "client-allocated",
  "nativeSessionId": "4c84f8dd-4ddf-4c09-bee6-0f05580ffbc5",
  "conversationInputBytes": "",
  "trustInputBytes": "790a",
  "initialExitControlBytes": "0404",
  "reentryTrustInputBytes": "790a",
  "reentryExitControlBytes": "0404",
  "initialTrustAnswered": true,
  "reentryTrustAnswered": true,
  "modelTurnCount": 0,
  "outcome": "same-identity",
  "substitutedIdentity": false,
  "privateStateInspected": false,
  "cleanup": {
    "instructionFileRemoved": true,
    "acpxStateRemoved": true,
    "projectPurgeDryRunExitCode": 1,
    "projectPurgeExitCode": null,
    "projectPurgeOutcome": "nothing-to-purge",
    "temporaryRootRemoved": true,
    "liveChildren": 0
  },
  "detail": "re-entry reached its conversation surface under the exact supplied identity"
}
```

### Three channels, kept apart

The conversation channel was never written to. Everything sent was terminal
control, on its own recorded channels:

| Channel | Bytes | What it is |
| --- | --- | --- |
| conversation | `""` | nothing, on either entry |
| trust | `790a` | one `y` + Enter per process, acknowledging a directory |
| exit control | `0404` | one Ctrl-D to ask whether the prompt is there, one to leave |

`modelTurnCount: 0`, and re-entry returned the same client-allocated UUID with
no substitution.

### What the earlier attempts established

Three of them, all at zero cost, each repaired from evidence:

1. **EOF only** — blocked at the workspace-trust dialog, which EOF does not
   dismiss. This motivated the first amendment.
2. **Trust answered, whole-buffer classification** — the answer was sent, then
   the harness read its own un-cleared dialog echo as a second trust request.
   Repaired by classifying only output arriving since the last handled surface.
3. **Trust answered, windowed classification** — no recognizable conversation
   surface appeared, because on this build the prompt announces itself only in
   answer to a Ctrl-D. Classified `HARNESS_FAILED`, not `GATE_2_UNRESOLVED`:
   the harness could not drive the surface, which says nothing about Claude.

The second amendment resolved that ordering conflict by making the first Ctrl-D
a readiness question and accepting Claude's exact affordance as the answer.

## P1–P8

| ID | Criterion | Result |
| --- | --- | --- |
| P1 | Identity has accepted provenance | **PASS.** One UUID allocated before any spawn, `client-allocated`, supplied unchanged to `--session-id`, `--resume` and ACPX `resumeSessionId`. |
| P2 | Native-created history reattaches through ACP | **PASS.** Marker present only in the native user turn returned from a marker-free ACP prompt, twice. |
| P3 | Reattachment does not substitute identity | **PASS.** `substitutedIdentity: false`; ACPX received the allocated UUID and no ACP/ACPX id became native identity. |
| P4 | Zero-turn exit is defined | **PASS.** EOF-only exit control on both entries, `modelTurnCount: 0`, `outcome: same-identity`, no substitution. |
| P5 | Prepared text uses the private channel | **PASS.** Mode-`0600` file under a mode-`0700` root; `preparedTextInArgv` and `preparedTextInEnvironment` false. |
| P6 | Provider project state is isolated and removed | **PASS.** Unique cwd per probe; Gate 1 purged (`0`/`0`), Gate 2 `nothing-to-purge`; roots removed; `liveChildren: 0`; no `xmd-519` project or probe root remains. |
| P7 | Provider-private state remains private | **PASS.** Nothing beneath Claude's config or history opened or parsed; decisions from supplied values, process outcomes, terminal output, ACP results and purge exit codes. |
| P8 | Acceptance remains Markdown-first | **PASS.** Two colocated `*.test.md` documents, independently executable, own flow, parsing, assertions and rendered evidence; TypeScript stayed at the wire/PTY/process boundary. |

All eight pass.

## Commands and results

| Command | Result |
| --- | --- |
| preflight (`git rev-parse HEAD`, `git branch --show-current`, `claude --version`, acpx version, `claude --help`, `claude project purge --help`, `uname -m`) | frozen point confirmed |
| fixture without `XMD_CLAUDE_DIRECT_PROOF` | exit 1, empty stdout, refusal before any provider |
| fixture with `CLAUDE_CONFIG_DIR` set | exit 1, refusal |
| `XMD_CLAUDE_DIRECT_PROOF=1 deno task xmd test packages/acp/src/ClaudeDirectLaunch.test.md --raw` (aligned, Gate 1 only) | Gate 1 `PASS`, 2 model turns |
| same command after Gate 2 was added | Gate 1 `PASS` again (2 further turns — see *Turn accounting*); Gate 2 exec exited 1 with no structured output |
| `XMD_CLAUDE_DIRECT_PROOF=1 deno run … zero-turn-exit` (direct, three repairs) | exit 0 each time; EOF-only → blocked at trust; then trust answered; final `HARNESS_FAILED`. **0 model turns** |
| `XMD_CLAUDE_DIRECT_PROOF=1 deno task xmd test packages/acp/src/ClaudeZeroTurnExit.test.md --raw` | exit 0, `PASS`, **0 model turns**, Gate 1 not rerun |
| `deno check packages/acp/tests/fixtures/claude-direct-launch-probe.ts` | exit 0 |
| `git diff --check` | exit 0 |

## Turn accounting

Six model turns total, of which **two were spent without authorization**.

The authorized run was one aligned Gate 1 — two turns. Adding Gate 2 and running
the document re-ran Gate 1, because the document contains both gates, spending
two more against an instruction that said to run only the zero-turn probe. The
zero-turn probe itself is free; running it through the document was not. The
repaired Gate 2 was therefore verified by invoking the fixture mode directly, at
zero cost, and no further document run was made.

The earlier unaligned Gate 1 spent the first two.

## Harness defects found and repaired

Both were found without spending turns, and neither is a product defect:

1. **`claude project purge` exits 1 when a path has no project state.** Treating
   that as a cleanup failure would have masked the real cause of any early exit,
   so purge outcomes are classified `purged` / `nothing-to-purge` / `failed`.
   Gate 2 relies on this: it legitimately has nothing to purge.
2. **A timed-out PTY phase threw instead of producing a verdict**, so Gate 2's
   first document run exited 1 with no structured output. Terminal output is now
   accumulated as it arrives and survives the timeout, which is what lets the
   probe name the workspace-trust surface rather than report an opaque hang.

## Correction carried forward

`issue-519-gate1-root-cause.md` is marked **INVALID, DO NOT PUBLISH** and is
excluded from any commit. Its central claim — that the adapter never passes the
resume identity to the SDK — is false: `createSession` spreads `...creationOpts`
into the SDK options (`dist/acp-agent.js:4975`; source
`src/acp-agent.ts#L6494-L6517`). The claim rested on a grep that could not match
an object spread, and its silence was read as absence. The correct trace is
upstream issue #1019.

The one finding from it that survives is measured rather than grepped, and it is
what this workaround acts on: the `2.1.235` / `2.1.232` divergence.

## Next action

Planner. One decision remains: whether #519 is rescoped to "XMD binds and
validates one Claude executable", with the requirement in
`issue-519-executable-alignment-workaround-handoff.md`, and #520 unblocked
behind it.

Both gates now pass at the frozen compatibility point with no upstream change.
The upstream defect in #1019 is real and still open, but the stack no longer
waits on it.
