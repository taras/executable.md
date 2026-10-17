# Planner review: required identity recording at 8fec6316

**REQUEST CHANGES.** The production boundary satisfies HR1–HR4, but the new
malformed-host fixture uses an avoidable type cast prohibited by repository
Code Rule 6. [The correction prompt](pr2-recording-implementor-correction-8fec6316.md)
assigns that test-only fix.

Reviewed SHA: `8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7`.
Parent: `a49229e983f35764ce59f92f43de37c15473e32f`.
Branch: agent/issue-883-pr2. Signature: G, tarasm@gmail.com.
Worktree is clean; 6 changed files, 143 insertions and 5 deletions.

Authority: [the recording handoff](pr2-session-recording-planner-handoff.md)
and [Implementor handback](pr2-session-recording-implementor-handback.md).

## Required correction

packages/acp/tests/provider.test.ts's new HR4 fixture uses
`as unknown as AcpxSessionPolicy`. AGENTS.md Code Rule 6 states:
“Parse to infer type; Do not type cast with `as`.”
The rule has no test exemption. Simulating an untyped malformed host does not
require this assertion: a typed test host can have its recording method removed
at runtime before installation, preserving the same runtime input and claims.

Remove the cast without weakening HR4. This is the sole requested correction.
No production defect or additional architecture decision is identified.

## Production and evidence assessment

recordSessionIdentity is required while dependencies.sessions remains optional.
checkedSessionPolicy validates both methods when supplied, before requesting,
reattaching or creating a session. Absence keeps the ordinary directory path.
The three existing confirmation sites now test host presence, retaining their
additional guards, identity-confirmation order and refusal cleanup unchanged.
The production workflow host already implements recording and needs no change.

The gate-only restoration is not independently discriminating once every
compliant host has the method. That is acceptable: requiredness, HR4, the
changed acceptance hosts and source review establish the assigned contract.
No extra mutation is required solely to distinguish equivalent conditions
under the new input contract.

Existing HR1–HR3 assertions remain unchanged. The two acceptance fixtures
explicitly record the confirmed keys and preserve their prior identity-routing
claims. HR4 observes the named refusal and no host/runtime/ensure/turn effects,
with WAP4 retaining the ordinary absent-host control. Documentation and the
error export describe this existing boundary without adding a database or
configuration mechanism.

## Commands actually run

```text
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/native-launch.test.ts packages/acp/tests/loaded-copy.test.ts
```

**26 passed, 217 steps, 0 failed**.
[First output](pr2-recording-review-8fec6316-acp-first.log).

```text
deno task test packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
```

Independent run failed: **0 passed, 17 passing steps, 3 failed**.
Embedded-adapter npm installation could not create temporary cache files under
/Users/tarasmankovski/.npm (EPERM).
[First output](pr2-recording-review-8fec6316-workflow-first.log).

A retry used an invocation-owned NPM_CONFIG_CACHE under /private/tmp, with
fetch retries disabled and a bounded fetch timeout. It failed before the
affected workflow behavior on npm registry DNS resolution (ENOTFOUND).
[Private-cache output](pr2-recording-review-8fec6316-workflow-private-cache.log).
No shared cache permissions, dependency state or source was changed.

The Implementor reports 3 tests/21 steps passing for this command. That report
is recorded separately; this review cannot claim independent workflow success.
The environmental failures do not establish a recording regression and do not
assign an npm/cache/dependency repair. No flake claim is made.

The changed custom-host fixtures justify one further explicit selection:

```text
deno task test packages/acp/tests/host-conversation.test.ts packages/acp/tests/acceptance.test.ts
```

**3 passed, 7 steps, 0 failed**.
[First output](pr2-recording-review-8fec6316-hosts-first.log).

No compiler, JSR, broad corpus or CI prerequisite was added.

## Non-blocking observation and continuity

The SM6 test title's “leaves the session established” is a wording observation,
not a new failure of the accepted rename. It may be aligned in the same
test-only correction; no separate commit, issue or broader sweep is assigned.

Latest accepted head remains a49229e9. Increment 3 awaits the cast-free HR4
feedback commit and its focused test result. The configuration increment stays
closed until acceptance, with SC1–SC7 unchanged. Owner acquisition, mounted
section 5, terminal R7/R8 and the 36-frame packet remain separate.
No push, GitHub mutation or CI inspection is authorized.
