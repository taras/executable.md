# Implementor correction: exercise the malformed host without a type cast

**Closed: PASS at a66c5d8a**, reviewed in
[pr2-recording-planner-review-a66c5d8a.md](pr2-recording-planner-review-a66c5d8a.md).
The original correction below records the frozen scope.

Continue from signed `8fec6316f090ccbf2c5e7a5197563cfb0fcae6c7`, parent
a49229e9, on agent/issue-883-pr2 in the existing implementation worktree.
Preserve the production required recording member, checkedSessionPolicy,
three confirmation sites, exports and documentation.

The new HR4 fixture in packages/acp/tests/provider.test.ts asserts an incomplete
object is AcpxSessionPolicy with `as unknown as AcpxSessionPolicy`.
Repository AGENTS.md Code Rule 6 says:
“Parse to infer type; Do not type cast with `as`.”
There is no test exemption in that instruction. The deliberate malformed-input
scenario is authorized; the cast is avoidable.

Keep exactly the same runtime malformed host and observations, using a
cast-free fixture. For example, construct a typed complete test host and
remove recordSessionIdentity with Reflect.deleteProperty before supplying it.
The temporary recording method may throw if reached; it is deleted before
installation and does not turn into a no-op production implementation.
Ordinary test mechanics are delegated; no new parser/framework is required.

Keep HR4 asserting AcpxSessionPolicyError naming recordSessionIdentity(),
zero requestSession calls, zero runtime options, zero ensures and zero turns.
Preserve WAP4's absent-host control, both acceptance hosts' recorded-key
assertions, existing confirmation/refusal cleanup and all production behavior.
No new malformed-input permutations or mutation exercise is assigned.

Run only the affected file:

```text
deno task test packages/acp/tests/provider.test.ts
```

The original ACP three-file command independently passed 26 tests/217 steps;
host-conversation plus acceptance independently passed 3 tests/7 steps.
Those unchanged boundaries need no repeat for this fixture-only correction.

The Implementor's workflow command reports 3 tests/21 steps passing.
The Planner's independent attempt failed during embedded-adapter npm
installation: first EPERM on the host npm cache, then ENOTFOUND for
registry.npmjs.org with an invocation-owned cache. Both outputs are preserved
in the review. These are environment limitations, not evidence that the
recording change broke workflow. Do not alter production, dependencies,
shared caches or tests to conceal them. No further workflow repeat is required
for the fixture-only correction.

The SM6 title is non-blocking. It may be reworded to “acceptance followed by a
failed turn preserves the existing session” in this same test-only correction,
with every assertion unchanged; a separate title-only commit is not needed.

Commit promptly after the focused file passes. Return exact signed SHA,
parent/branch/tree status, fixture adaptation and command/result, then stop
for Planner review. No configuration increment, owner acquisition, mounted
section 5, broad check/suite, push, GitHub mutation or CI inspection opens.
