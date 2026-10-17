# Implementor handback: required custom-host identity recording

Increment 3 is complete. The required recording member landed as
`8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7` and the requested fixture
correction as `a66c5d8a5391d43cf8328435bba622a79cc7076b`, which is the head to
review. HR1–HR4 are satisfied.

## Continuity

- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`
- Branch: `agent/issue-883-pr2`, working tree clean, nothing untracked
- Head: `a66c5d8a5391d43cf8328435bba622a79cc7076b` — signed G, tarasm@gmail.com,
  parent `8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7`
- Behavior commit: `8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7` — signed G,
  parent `a49229e983f35764ce59f92f43de37c15473e32f`, the assigned base
- Not pushed, per the standing prohibition.

`8fec6316` changed 6 files, 143 insertions, 5 deletions. `a66c5d8a` changes
`packages/acp/tests/provider.test.ts` alone, 21 insertions, 7 deletions.

### The correction, `a66c5d8a`

Code rule 6 has no test exemption, so HR4's `as unknown as AcpxSessionPolicy`
is gone. The fixture now declares a whole `AcpxSessionPolicy` and removes the
recording member with `Reflect.deleteProperty` before the provider is built,
which produces exactly the runtime value the cast described: a host the type
could never have produced, arriving from somewhere the type never reached. The
removal is asserted both ways — the delete answers `true`, and `Reflect.has`
then answers `false`.

The temporary method throws rather than doing nothing. A fixture that failed to
remove it would then fail this test, instead of quietly passing as a host that
records nothing — and nothing about it reaches production, since it is gone
before the provider exists.

Every HR4 observation is unchanged: `AcpxSessionPolicyError` naming
`recordSessionIdentity()`, `asked` zero, and `createdOptions`, `ensureCalls`
and `turns` all empty. Searching the whole `a49229e9..HEAD` diff for an added
`as` cast now finds none.

SM6's title is reworded to the one you supplied, with every assertion
untouched. That closes the observation this handback previously raised.

## What changed

`packages/acp/src/provider.ts`

- `AcpxSessionPolicy.recordSessionIdentity` is required. Its doc comment states
  why: the integration is optional, but a host answering `requestSession`
  decides where every session lives, and one that retains nothing about what
  stands there is indistinguishable at every later site from no host at all.
- `checkedSessionPolicy()` reads both members off the supplied value and
  refuses with the new `AcpxSessionPolicyError` if either is not a function.
  It runs where `dependencies.sessions` is read in `useAcpxProviderState`, so a
  half host is refused as it is supplied rather than where it would first have
  been needed. Read off the value rather than trusted from the type, because
  the type already requires both and this is the untyped embedder the type
  cannot reach.
- The three confirmation sites gate on `sessions` instead of
  `sessions?.recordSessionIdentity`:
  - reattachment, after the ensure that validated it, still also gated on
    `intent.deferEstablished !== true`;
  - ACP construction, after the backend accepted the first turn;
  - native materialization, still also gated on `resolved.kind === "details"`.
  Order, call timing and every refusal body are byte-identical otherwise:
  `abandonHandle` / `releaseHandle`, the `detachSessionHandle` follow-up where
  it was, the rethrow or `stopped(...)`, and no write to the Session or the
  store on refusal.

`packages/acp/mod.ts` — `AcpxSessionPolicyError` exported beside
`AcpxPartitionError`. No roster pins the package's export list: the only two
files naming `AcpxPartitionError` were `mod.ts` and `provider.ts`, and
`scripts/tests/jsr-consumer-documentation.test.ts`'s `MEMBERS` lists packages,
not export names.

`packages/cli/src/workflow-agent.ts` — **unchanged.** The production host
already implements both methods, and the rename increment preserved its
recording body, so requiredness costs it nothing.

## Host fixtures, and what each preserved

| Fixture | Before | Now |
| --- | --- | --- |
| `packages/acp/tests/provider.test.ts` `installStrictProvider` | both methods, with `refuseFirstRetention` | unchanged |
| `packages/acp/tests/host-conversation.test.ts` `host()` | both methods, with `refuseNextRetention()` | unchanged |
| `packages/acp/tests/native-launch.test.ts` CA13 | both methods | unchanged |
| `packages/acp/tests/acceptance.test.ts`, two hosts | `requestSession` only | both; each records the session keys it is asked to retain, and the test asserts them |

The two acceptance hosts are the routing-only ones the decision's caller audit
named. Their existing assertions are untouched — the middleware rewrite
reaching the provider, two distinct identities for two same-named elements, the
rewritten name never appearing as an identity, two distinct ensure keys, and
WAP7's `already resolved its session` refusal with its single request. Each
gained one assertion: the keys retained, in order.

## Frozen evidence

| Row | Observation |
| --- | --- |
| HR1 | SM4 (`acceptance promotes before the host mapping, and a turn is never remapped`) and SM9 give the host the exact details and the confirmed identity after acceptance; `host-conversation.test.ts` covers close-and-reopen against one surviving provider state, and `workflow-agent-sessions.test.ts` WSR1/WSR3 cover reattachment across a restart with fixed logical identities. All pass unchanged. The new acceptance assertions add the ordering directly: `recorded` equals the requested keys in request order. |
| HR2 | SM5 (`a first turn nobody accepted retains nothing, and stays pending`) still asserts `log.recorded` is empty — no confirmation, no recording — and SM6 keeps the accepted-then-failed case retaining the confirmed identity. Both pass unchanged. |
| HR3 | SM9 (`a mapping that failed after the promotion leaves one canonical assertion`) and native-launch CA13 (`a host that cannot retain the session gives the handle back to its creator`) both pass unchanged: one close through the runtime that made it, no turns, the provider's assertion standing. CA13 is the native site exercising the same required method. |
| HR4 | New: `HR4: a host that cannot record an identity is refused rather than read as absent`, in `provider.test.ts` beside WAP4. A declared `AcpxSessionPolicy` whose recording member is removed with `Reflect.deleteProperty` before installation — no type cast — makes the install throw `AcpxSessionPolicyError` naming `recordSessionIdentity()`; `requestSession` was never called, and no runtime, ensure or turn exists. WAP4 is the paired ordinary control and still creates and continues a directory-based session with no host database. |

## Commands

```text
deno task test packages/acp/tests/provider.test.ts \
  packages/acp/tests/native-launch.test.ts packages/acp/tests/loaded-copy.test.ts
→ ok | 26 passed (217 steps) | 0 failed (2s)

deno task test packages/cli/tests/workflow-agent.test.ts \
  packages/cli/tests/workflow-agent-sessions.test.ts
→ ok | 3 passed (21 steps) | 0 failed (14s)
```

For the fixture correction, the one assigned file:

```text
deno task test packages/acp/tests/provider.test.ts
→ ok | 9 passed (82 steps) | 0 failed

oxfmt --check packages/acp/tests/provider.test.ts
→ All matched files use the correct format.
```

No first-failure output to preserve: nothing failed.

Supporting control, beyond the assignment — the two custom-host suites no
assigned command covers, which the requiredness change reaches:

```text
deno task test packages/acp/tests/host-conversation.test.ts \
  packages/acp/tests/acceptance.test.ts
→ ok | 3 passed (7 steps) | 0 failed

oxfmt --check (the four changed TypeScript files)
→ All matched files use the correct format.
```

A repository-wide search confirms those four files plus `workflow-agent.ts` are
every `AcpxSessionPolicy` implementor, so no caller was left uncompiled.

### Break-it controls

| Injected fault | Result |
| --- | --- |
| `checkedSessionPolicy` checks only `requestSession` | HR4 FAILED |
| both acceptance hosts keep the method but retain nothing | both WAP7 rows FAILED |
| the corrected fixture's `Reflect.deleteProperty` is not performed | HR4 FAILED |

The first shows HR4 is live rather than passing on an unrelated throw; the
second shows the new acceptance assertions actually observe recording; the
third shows the corrected fixture is malformed because of the removal rather
than for some other reason. Each was injected into a byte copy of the restored
file, reverted, and the affected command re-run against the restored source.

**One honest limit.** The gate change itself — host presence rather than method
presence — is not separately observable by a test, because every compliant host
now has the method, so reverting the gate changes no behavior. What stands for
it is the required member in the type, the install-time refusal (HR4), and the
two acceptance hosts that previously omitted the method and now record: before
this increment the old gate skipped them silently, and their new assertions
fail if recording does not happen.

## Documentation

`specs/acp-client-spec.md` — a new bullet after host-owned dependencies: the
host is both of its methods, absence stays the ordinary walk, the provider
records wherever a host is present rather than wherever the method is, a
supplied host missing it is refused as it is supplied, and the three sites'
refusal cleanup is unchanged.

`architecture.md` — the workflow Agent-session section, after the ordering
paragraph: a host that places sessions records them, the requiredness and its
reason, where the refusal happens, and that it is never read as no host.

No rulebook or module roster carries this contract. Searching `specs/`,
`architecture.md`, `.agents/` and `AGENTS.md` for `AcpxSessionPolicy`,
`requestSession` and `recordSessionIdentity` found exactly one existing mention,
the spec line above; `.agents/component-descriptions.md` and
`specs/workflow-workspace-spec.md` §8.2–8.3 describe the workflow profile and
its permissions and say nothing about the host's method set.

## The SM6 observation, now closed

SM6 read `acceptance followed by a failed turn leaves the session established`,
which was the retired state sense rather than the ordinary verb. `a66c5d8a`
rewords it to `acceptance followed by a failed turn preserves the existing
session`, with every assertion unchanged.

The other three remaining `a session established` phrases — native-launch NL15,
`native-launch.ts` and `provider.ts` — are the ordinary verb and are correct as
they stand.

## The workflow command, and your environment

My run of the assigned workflow command passed: `3 passed (21 steps) | 0 failed`.
Your independent attempt failed inside embedded-adapter npm installation — EPERM
on the host npm cache, then ENOTFOUND for `registry.npmjs.org` under an
invocation-owned cache. Nothing was changed in production, dependencies, shared
caches or tests on account of it, and the correction commit touches one test
file only. Per your instruction the command was not repeated for this
fixture-only correction.

## Limits honoured

No configuration work, no owner acquisition in `program.ts`, no mounted
section 5, no terminal R7/R8, no 36-frame packet, no push, no GitHub mutation,
no CI inspection. No no-op production recording, default host database or
conversation reconstruction path was introduced to satisfy the type. No
`check`, `check:jsr`, lint or full suite was run, none being assigned.

Stopping for Planner review of `8fec6316` before the configuration increment.
