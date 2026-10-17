# Pre-commit correction: use Effection Result for provider configuration parsing

Keep the staged increment on agent/issue-883-pr2, based on
`a66c5d8a5391d43cf8328435bba622a79cc7076b`, in the existing implementation
worktree. There is no configuration feedback commit yet. Preserve all current
staged work; do not reset, discard, disable signing or create an unsigned
feedback commit.

In packages/core/src/agent/provider-configuration.ts, ParsedProviderConfiguration
declares a local `{ok:true,value:JsonObject} | {ok:false,reason:string}` union.
AGENTS.md Code Rule 13 requires Effection Result<T>, with failure data on an
Error, and forbids declaring a local ok:true/false union.

The Planner reproduced the violation with:

```text
./node_modules/.bin/oxlint -c .oxlintrc.json packages/core/src/agent/provider-configuration.ts
```

Exit 1, local/prefer-effection-result at line 62.
[First output](pr2-configuration-staged-result-lint-first.log).
The two sort warnings in that output are not additional acceptance blockers.

Return Result<JsonObject> from parseProviderConfiguration, using Ok/Err and
Error values for its failures. Update the conversation consumer to read the
error's message while preserving the existing AgentConversationError diagnostic
and classification. Remove the redundant union rather than changing its
discriminant to evade the rule. Do not replace a narrowed failure by rebuilding
Err(result.error).

Preserve all four required fields, their actual values, parse/copy/freeze
semantics, comparison, journal bytes and order, activation lifetime and SC1–SC7.
The current parser sharing and input-snapshot choices need no redesign for
this correction. No additional malformed-input matrix or mutation is assigned.

After the final source edit, run the original three commands in
[the configuration handoff](pr2-session-configuration-planner-handoff.md) and
repeat the targeted lint check above to close its demonstrated failure.
The comparison control remains applicable if sameJson and comparison behavior
are unchanged; no repeat is required solely for the Result representation.

Restage the corrected files with the existing staged increment. Update the
handback's results and diff counts. Once the 1Password signing agent works,
create the signed feedback commit using the saved message, return its exact
SHA/parent/branch/tree status, then stop for the formal Planner review.

The user must handle the 1Password approval/unlock/restart. Do not alter signing
configuration, keys or unrelated caches. No push, GitHub mutation, CI inspection
or mounted section 5 work opens.
