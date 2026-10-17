# Name interview: retainedRequests

The Product Owner requested this interview after review of
`68547603f280636ea4fce0a1de2ba8b76b3b3636`. The
[implementation review](pr2-recovery-planner-review-68547603.md) is PASS for the
assigned correlation and unresolved-acceptance correction. The Product Owner
accepted requestsFromHistory(records). The interview is complete and authorizes
the name change below without changing the accepted behavior.

## Current

`retainedRequests(records)` in packages/cli/src/repl/sidekick/model.ts returns
the requests represented in the supplied saved history. It is consumed by
projectSidekick and the owner's turnForRequest lookup. It performs no I/O and
retains no new data.

## Intent

Read where each request begins and which saved turn belongs to it. For example,
the interrupted first message has no known turn; the second message has turn 1.
The projection and live owner use the same answer.

## Assessment

The word retained describes the input data, but can make the function sound as
though it saves requests. The function derives an answer from history. This is
an ordinary helper-name review within an accepted boundary, not a new shared
concept or an architecture change.

## Proposed

`requestsFromHistory(records)` — the requests found in these saved records,
with the turn recorded for each where known. Preserve the existing return type,
request boundaries, refusals and consumers. This proposal is accepted.

## Feedback

Does requestsFromHistory describe what you expect this function to do?

The Product Owner answered yes.

## Implementor follow-up

From signed 68547603, rename retainedRequests to requestsFromHistory in
packages/cli/src/repl/sidekick/model.ts and update its import and use in
packages/cli/src/repl/sidekick/owner.ts. Update any direct references to this
helper in affected comments or tests. This is a mechanical rename: preserve
the return type, request boundaries, association, refusals and all assertions.
No new terminology entry, schema change or test scenario is needed.

Run the existing integration tests for both consumers:

```text
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-journey.test.ts
```

Once they pass, commit promptly and return the signed SHA, parent, branch, tree
status and command result. No full suite, check, lint, CI or GitHub prerequisite
is added. The behavior reviewed at 68547603 remains PASS; this follow-up does
not reopen it or declare R2 complete.

Exact implementation head remains 68547603, signed G and clean. No production
edit, commit, push, GitHub mutation or CI inspection occurs in this interview.
Creation-policy compatibility remains separately with the Architect.

## Follow-up closed

The mechanical rename is PASS at 6e3a7b37, parent 68547603. The two assigned
integration files independently pass 6 tests/39 steps. See
[the rename review](pr2-name-planner-review-6e3a7b37.md). The exact implementation
head is now 6e3a7b37, signed G and clean; creation-policy compatibility remains
separate. The earlier base statements above describe the interview's starting
revision.
